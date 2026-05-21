'use strict';
/**
 * flows/ordersToBusinessWorks.js
 * DATA FLOW: Shopify → BusinessWorks
 *
 * 1. Fetches unfulfilled Shopify orders created since last run.
 * 2. Converts each order to the BW Order Entry CSV import format.
 * 3. Pushes each order into BusinessWorks via BWGACCESS.
 *
 * BW Order Entry import format (per Sage BusinessWorks import spec):
 *   Order Header: order_no, cust_no, order_date, ship_to fields...
 *   Order Lines:  item_code, qty, unit_price, description...
 */

const fs     = require('fs');
const path   = require('path');
const shopify = require('../services/shopify');
const bw      = require('../services/businessworks');
const logger  = require('../utils/logger').forModule('OrdersToBusinessWorks');
const StateStore = require('../utils/stateStore');

const state = new StateStore('orders-to-bw');

// ── BW CSV format helpers ──────────────────────────────────────────────────────

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  return str.includes(',') ? `"${str.replace(/"/g, '""')}"` : str;
}

function row(...fields) {
  return fields.map(csvEscape).join(',') + '\r\n';
}

/**
 * Map a Shopify order → BW Order Entry CSV import string.
 * Format follows the Sage BusinessWorks "Importing Quotes and Sales Orders" spec.
 */
function orderToCsv(order) {
  const addr    = order.shippingAddress || order.billingAddress || {};
  const custNo  = order.customer?.id
    ? `SHP-${order.customer.id.replace(/\D/g, '').slice(-8)}`
    : `SHP-GUEST`;

  // Shopify order name is like "#1001" — strip the # for BW
  const orderNo = order.name.replace('#', '');
  const orderDate = order.createdAt.slice(0, 10).replace(/-/g, '');

  let csv = '';

  // ── Header record (record type H) ─────────────────────────────────────────
  csv += row(
    'H',                        // Record Type
    orderNo,                    // Order Number (will be auto-assigned if blank)
    custNo,                     // Customer Number
    orderDate,                  // Order Date (YYYYMMDD)
    addr.firstName || '',       // Ship-to First Name
    addr.lastName  || '',       // Ship-to Last Name
    addr.company   || '',       // Ship-to Company
    addr.address1  || '',       // Ship-to Address 1
    addr.address2  || '',       // Ship-to Address 2
    addr.city      || '',       // Ship-to City
    addr.province  || '',       // Ship-to State
    addr.zip       || '',       // Ship-to Zip
    addr.country   || 'US',    // Ship-to Country
    addr.phone     || '',       // Ship-to Phone
    order.email    || '',       // Customer Email
    order.totalShippingPriceSet?.shopMoney?.amount || '0.00', // Freight
    '',                         // PO Number
    `Shopify ${order.name}`,    // Reference / Comment
    order.id,                   // Shopify Order ID stored in custom field
  );

  // ── Line records (record type L) ──────────────────────────────────────────
  const lines = order.lineItems?.edges || [];
  for (const { node: item } of lines) {
    csv += row(
      'L',                      // Record Type
      item.sku || item.title.slice(0, 20), // Item Code (SKU)
      item.quantity,            // Quantity Ordered
      item.originalUnitPriceSet?.shopMoney?.amount || '0.00', // Unit Price
      item.title.slice(0, 30), // Description
      '',                       // Warehouse
      '',                       // Discount %
    );
  }

  return csv;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SYNC FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

async function run() {
  logger.info('▶ Starting flow: Shopify Orders → BusinessWorks');

  const lastRun = state.get('lastRunAt') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  logger.info(`Fetching unfulfilled orders since ${lastRun}`);

  let orders;
  try {
    orders = await shopify.getUnfulfilledOrders(lastRun);
  } catch (err) {
    logger.error(`Failed to fetch Shopify orders: ${err.message}`);
    return { success: false, error: err.message };
  }

  if (orders.length === 0) {
    logger.info('No new unfulfilled orders found.');
    state.set('lastRunAt', new Date().toISOString());
    return { success: true, processed: 0 };
  }

  logger.info(`Processing ${orders.length} orders into BusinessWorks...`);

  let processed = 0;
  let failed    = 0;
  const failedOrders = [];

  for (const order of orders) {
    try {
      const csv = orderToCsv(order);
      await bw.bwgImport('OE', csv);
      logger.info(`✓ Imported order ${order.name} into BusinessWorks`);
      processed++;
    } catch (err) {
      logger.error(`✗ Failed to import order ${order.name}: ${err.message}`);
      failed++;
      failedOrders.push({ order: order.name, error: err.message });
    }
  }

  state.set('lastRunAt', new Date().toISOString());
  logger.info(`◀ Completed: ${processed} imported, ${failed} failed`);

  if (failedOrders.length > 0) {
    logger.warn('Failed orders:', { failedOrders });
  }

  return { success: true, processed, failed, failedOrders };
}

module.exports = { run };
