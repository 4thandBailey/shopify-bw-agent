'use strict';
/**
 * flows/fulfillmentsToShopify.js
 * DATA FLOW: BusinessWorks → Shopify
 *
 * 1. Queries BW via ODBC for orders that have been shipped (STATUS = 'S')
 *    and have a Shopify Order ID stored in the SHOPIFY_ORDER field.
 * 2. Calls the Shopify Fulfillment API to mark orders fulfilled with tracking.
 * 3. Tracks which orders have already been synced to avoid duplicates.
 */

const shopify    = require('../services/shopify');
const bw         = require('../services/businessworks');
const logger     = require('../utils/logger').forModule('FulfillmentsToShopify');
const StateStore = require('../utils/stateStore');

const state = new StateStore('fulfillments-to-shopify');

async function run() {
  logger.info('▶ Starting flow: BusinessWorks Fulfillments → Shopify');

  const lastRun  = state.get('lastRunAt') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const syncedIds = state.get('syncedOrderNos') || [];

  let shippedOrders;
  try {
    shippedOrders = await bw.getShippedOrdersSince(lastRun.slice(0, 10));
  } catch (err) {
    logger.error(`Failed to query shipped orders from BusinessWorks: ${err.message}`);
    return { success: false, error: err.message };
  }

  // Filter out orders we've already synced to Shopify
  const toSync = shippedOrders.filter(o => !syncedIds.includes(o.orderNo));

  if (toSync.length === 0) {
    logger.info('No new shipped orders to sync to Shopify.');
    state.set('lastRunAt', new Date().toISOString());
    return { success: true, processed: 0 };
  }

  logger.info(`Syncing ${toSync.length} shipped orders to Shopify...`);

  let processed = 0;
  let failed    = 0;
  const nowSynced = [...syncedIds];

  for (const bwOrder of toSync) {
    if (!bwOrder.shopifyOrderId) {
      logger.warn(`BW order ${bwOrder.orderNo} has no Shopify Order ID; skipping`);
      continue;
    }

    try {
      // Shopify GID format: gid://shopify/Order/{numeric_id}
      const shopifyGid = bwOrder.shopifyOrderId.startsWith('gid://')
        ? bwOrder.shopifyOrderId
        : `gid://shopify/Order/${bwOrder.shopifyOrderId}`;

      await shopify.fulfillOrder(
        shopifyGid,
        [],
        bwOrder.trackingNumber   || null,
        bwOrder.shippingCarrier  || null,
      );

      logger.info(`✓ Fulfilled Shopify order ${bwOrder.shopifyOrderId} (BW: ${bwOrder.orderNo}) — tracking: ${bwOrder.trackingNumber || 'none'}`);
      nowSynced.push(bwOrder.orderNo);
      processed++;
    } catch (err) {
      logger.error(`✗ Failed to fulfill Shopify order ${bwOrder.shopifyOrderId}: ${err.message}`);
      failed++;
    }
  }

  // Keep synced list bounded (last 2000 order nos)
  const trimmed = nowSynced.slice(-2000);
  state.set('syncedOrderNos', trimmed);
  state.set('lastRunAt', new Date().toISOString());

  logger.info(`◀ Completed: ${processed} fulfilled, ${failed} failed`);
  return { success: true, processed, failed };
}

module.exports = { run };
