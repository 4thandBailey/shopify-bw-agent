'use strict';
/**
 * flows/customersToShopify.js
 * DATA FLOW: BusinessWorks → Shopify
 *
 * 1. Reads AR customers from BW modified since last run.
 * 2. Upserts each customer into Shopify (create if new, update if existing).
 *
 * Splits BW CUST_NAME into firstName/lastName as best it can.
 */

const shopify    = require('../services/shopify');
const bw         = require('../services/businessworks');
const logger     = require('../utils/logger').forModule('CustomersToShopify');
const StateStore = require('../utils/stateStore');

const state = new StateStore('customers-to-shopify');

/**
 * Best-effort split of "COMPANY_NAME" or "First Last" into parts.
 * BW stores one CUST_NAME field; we parse it for Shopify.
 */
function parseName(custName) {
  if (!custName) return { firstName: '', lastName: '' };
  const parts = custName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return {
    firstName: parts[0],
    lastName:  parts.slice(1).join(' '),
  };
}

async function run() {
  logger.info('▶ Starting flow: BusinessWorks Customers → Shopify');

  const lastRun = state.get('lastRunAt') || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  let customers;
  try {
    customers = await bw.getCustomersModifiedSince(lastRun.slice(0, 10));
  } catch (err) {
    logger.error(`ODBC customer read failed: ${err.message}`);
    return { success: false, error: err.message };
  }

  if (customers.length === 0) {
    logger.info('No modified customers found in BusinessWorks.');
    state.set('lastRunAt', new Date().toISOString());
    return { success: true, processed: 0 };
  }

  logger.info(`Processing ${customers.length} customers from BusinessWorks...`);

  let processed = 0;
  let failed    = 0;

  for (const cust of customers) {
    if (!cust.email) {
      logger.debug(`Skipping customer ${cust.custNo} — no email address`);
      continue;
    }

    const { firstName, lastName } = parseName(cust.custName);

    const shopifyCustomer = {
      email:     cust.email.trim().toLowerCase(),
      firstName,
      lastName,
      phone:     cust.phone || undefined,
      addresses: [{
        address1:  cust.address1 || '',
        address2:  cust.address2 || '',
        city:      cust.city     || '',
        province:  cust.state    || '',
        zip:       cust.zip      || '',
        country:   cust.country  || 'US',
        phone:     cust.phone    || '',
      }],
      // Store the BW customer number as a metafield tag for reference
      tags: `bw-cust:${cust.custNo}`,
    };

    try {
      await shopify.upsertCustomer(shopifyCustomer);
      logger.debug(`✓ Upserted customer ${cust.custNo} (${cust.email})`);
      processed++;
    } catch (err) {
      logger.error(`✗ Failed to upsert customer ${cust.custNo}: ${err.message}`);
      failed++;
    }
  }

  state.set('lastRunAt', new Date().toISOString());
  logger.info(`◀ Completed: ${processed} upserted, ${failed} failed`);
  return { success: true, processed, failed };
}

module.exports = { run };
