'use strict';
/**
 * services/businessworks.js
 * Sage BusinessWorks data access via ODBC (read) and BWGACCESS (write/import).
 *
 * NOTE: ODBC via the `odbc` npm package uses the system 32-bit ODBC DSN
 *       configured in the Windows ODBC Data Source Administrator (32-bit).
 *       BWGACCESS is invoked as a child process via the Windows executable.
 */

const odbc   = require('odbc');
const { exec } = require('child_process');
const fs     = require('fs');
const path   = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const logger = require('../utils/logger').forModule('BusinessWorksService');

// ── ODBC Connection Pool ───────────────────────────────────────────────────────
let pool = null;

async function getPool() {
  if (!pool) {
    logger.info('Initialising ODBC connection pool to Sage BusinessWorks...');
    pool = await odbc.pool({
      connectionString: config.odbc.connectionString,
      initialSize:      2,
      incrementSize:    2,
      maxSize:          5,
      shrink:           true,
    });
    logger.info('ODBC pool ready.');
  }
  return pool;
}

async function query(sql, params = []) {
  const p    = await getPool();
  const conn = await p.connect();
  try {
    logger.debug(`ODBC query: ${sql.slice(0, 120)}`);
    const result = await conn.query(sql, params);
    return result;
  } finally {
    await conn.close();
  }
}

async function closePool() {
  if (pool) {
    await pool.close();
    pool = null;
    logger.info('ODBC pool closed.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVENTORY  — read from BW Inventory Control via ODBC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns an array of { itemCode, description, qtyOnHand, qtyOnOrder }
 * Table name may vary by BW version; adjust IC_ITEM to match your DSN schema.
 */
async function getInventoryLevels() {
  const sql = `
    SELECT
      ITEM_CODE        AS itemCode,
      DESCRIPTION      AS description,
      QTY_ON_HAND      AS qtyOnHand,
      QTY_ON_ORDER     AS qtyOnOrder,
      UNIT_PRICE       AS unitPrice,
      LAST_UPDATED     AS lastUpdated
    FROM IC_ITEM
    WHERE INACTIVE = 'N'
  `;
  const rows = await query(sql);
  logger.info(`Fetched ${rows.length} inventory items from BusinessWorks`);
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDERS / FULFILLMENTS — read shipped orders from BW Order Entry
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns orders that have been shipped in BW since a given date.
 * Includes tracking info if stored in the order header.
 */
async function getShippedOrdersSince(sinceDate) {
  const sql = `
    SELECT
      oh.ORDER_NO       AS orderNo,
      oh.CUST_NO        AS custNo,
      oh.ORDER_DATE     AS orderDate,
      oh.SHIP_DATE      AS shipDate,
      oh.TRACK_NO       AS trackingNumber,
      oh.SHIP_VIA       AS shippingCarrier,
      oh.SHOPIFY_ORDER  AS shopifyOrderId,
      oh.STATUS         AS status
    FROM OE_ORDER_HEADER oh
    WHERE oh.STATUS = 'S'
      AND oh.SHIP_DATE >= ?
      AND oh.SHOPIFY_ORDER IS NOT NULL
  `;
  const rows = await query(sql, [sinceDate]);
  logger.info(`Found ${rows.length} shipped orders in BusinessWorks since ${sinceDate}`);
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOMERS — read from BW Accounts Receivable
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns AR customers modified since a given date.
 */
async function getCustomersModifiedSince(sinceDate) {
  const sql = `
    SELECT
      CUST_NO        AS custNo,
      CUST_NAME      AS custName,
      ADDR1          AS address1,
      ADDR2          AS address2,
      CITY           AS city,
      STATE          AS state,
      ZIP            AS zip,
      COUNTRY        AS country,
      PHONE          AS phone,
      EMAIL          AS email,
      LAST_UPDATED   AS lastUpdated
    FROM AR_CUSTOMER
    WHERE LAST_UPDATED >= ?
  `;
  const rows = await query(sql, [sinceDate]);
  logger.info(`Fetched ${rows.length} modified customers from BusinessWorks`);
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRICING — read item pricing from BW Price Levels
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns current pricing for all active items.
 */
async function getItemPricing() {
  const sql = `
    SELECT
      i.ITEM_CODE     AS itemCode,
      i.UNIT_PRICE    AS unitPrice,
      p.PRICE_LEVEL   AS priceLevel,
      p.PRICE         AS levelPrice,
      i.LAST_UPDATED  AS lastUpdated
    FROM IC_ITEM i
    LEFT JOIN IC_PRICE_LEVEL p ON p.ITEM_CODE = i.ITEM_CODE
    WHERE i.INACTIVE = 'N'
    ORDER BY i.ITEM_CODE, p.PRICE_LEVEL
  `;
  const rows = await query(sql);
  logger.info(`Fetched pricing for ${rows.length} item/level combinations`);
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BWGACCESS — write/import into BW via the BWGACCESS executable
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Invoke BWGACCESS to import a CSV file into BusinessWorks.
 * @param {string} module  - BW module code (e.g. 'OE' for Order Entry)
 * @param {string} csvData - CSV string content to import
 * @returns {Promise<string>} BWGACCESS stdout output
 */
async function bwgImport(module, csvData) {
  // Write the CSV to the import staging directory
  const filename  = `${module}_import_${uuidv4()}.csv`;
  const filePath  = path.join(config.bwgaccess.importDir, filename);

  fs.mkdirSync(config.bwgaccess.importDir, { recursive: true });
  fs.writeFileSync(filePath, csvData, 'utf8');
  logger.info(`Staged BWGACCESS import file: ${filePath}`);

  return new Promise((resolve, reject) => {
    const cmd = `"${config.bwgaccess.exePath}" /IMPORT /MODULE:${module} /FILE:"${filePath}" /COMPANY:"${config.bwgaccess.companyDir}"`;
    logger.debug(`Running BWGACCESS: ${cmd}`);

    exec(cmd, { timeout: 120_000 }, (err, stdout, stderr) => {
      // Clean up staging file after execution
      try { fs.unlinkSync(filePath); } catch (_) {}

      if (err) {
        logger.error(`BWGACCESS import failed: ${err.message}\nSTDERR: ${stderr}`);
        reject(new Error(`BWGACCESS error: ${err.message}`));
      } else {
        logger.info(`BWGACCESS import complete (module ${module}). Output: ${stdout.trim()}`);
        resolve(stdout);
      }
    });
  });
}

/**
 * Invoke BWGACCESS to export data from BusinessWorks to a CSV file.
 * @param {string} module  - BW module code
 * @param {string} exportType - e.g. 'INVENTORY', 'CUSTOMERS'
 * @returns {Promise<string>} contents of the exported CSV
 */
async function bwgExport(module, exportType) {
  const filename = `${module}_export_${uuidv4()}.csv`;
  const filePath = path.join(config.bwgaccess.exportDir, filename);

  fs.mkdirSync(config.bwgaccess.exportDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const cmd = `"${config.bwgaccess.exePath}" /EXPORT /MODULE:${module} /TYPE:${exportType} /FILE:"${filePath}" /COMPANY:"${config.bwgaccess.companyDir}"`;
    logger.debug(`Running BWGACCESS export: ${cmd}`);

    exec(cmd, { timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
        logger.error(`BWGACCESS export failed: ${err.message}`);
        reject(new Error(`BWGACCESS error: ${err.message}`));
        return;
      }

      try {
        const content = fs.readFileSync(filePath, 'utf8');
        fs.unlinkSync(filePath);
        logger.info(`BWGACCESS export complete (${module}/${exportType}). Lines: ${content.split('\n').length}`);
        resolve(content);
      } catch (readErr) {
        reject(readErr);
      }
    });
  });
}

module.exports = {
  query,
  closePool,
  getInventoryLevels,
  getShippedOrdersSince,
  getCustomersModifiedSince,
  getItemPricing,
  bwgImport,
  bwgExport,
};
