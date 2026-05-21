'use strict';
/**
 * flows/inventoryToShopify.js
 * DATA FLOW: BusinessWorks → Shopify
 *
 * 1. Reads all active inventory items from BW via ODBC.
 * 2. Builds a SKU → quantity map.
 * 3. Fetches all Shopify product variants.
 * 4. For each variant whose SKU matches a BW item, updates the
 *    Shopify inventory level at the primary location.
 *
 * Only updates variants whose quantity has actually changed to
 * minimise Shopify API calls.
 */

const shopify    = require('../services/shopify');
const bw         = require('../services/businessworks');
const logger     = require('../utils/logger').forModule('InventoryToShopify');
const StateStore = require('../utils/stateStore');

const state = new StateStore('inventory-to-shopify');

async function run() {
  logger.info('▶ Starting flow: BusinessWorks Inventory → Shopify');

  // ── 1. Read BW inventory ────────────────────────────────────────────────────
  let bwItems;
  try {
    bwItems = await bw.getInventoryLevels();
  } catch (err) {
    logger.error(`ODBC inventory read failed: ${err.message}`);
    return { success: false, error: err.message };
  }

  const bwQtyBySku = {};
  for (const item of bwItems) {
    if (item.itemCode) {
      bwQtyBySku[item.itemCode.trim().toUpperCase()] = Math.max(0, Math.floor(item.qtyOnHand || 0));
    }
  }
  logger.info(`Loaded ${Object.keys(bwQtyBySku).length} SKUs from BusinessWorks`);

  // ── 2. Get Shopify locations (use primary active location) ─────────────────
  let locations;
  try {
    locations = await shopify.getLocations();
  } catch (err) {
    logger.error(`Failed to fetch Shopify locations: ${err.message}`);
    return { success: false, error: err.message };
  }
  if (locations.length === 0) {
    logger.error('No active Shopify locations found');
    return { success: false, error: 'No active locations' };
  }
  const locationId = locations[0].id;
  logger.info(`Using Shopify location: ${locations[0].name} (${locationId})`);

  // ── 3. Paginate through all Shopify product variants ──────────────────────
  const allVariants = [];
  let cursor = null;
  do {
    const page = await shopify.getProductVariants(cursor);
    allVariants.push(...page.edges.map(e => e.node));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  logger.info(`Fetched ${allVariants.length} Shopify variants`);

  // ── 4. Load last-known quantities to detect changes ───────────────────────
  const lastQty = state.get('lastKnownQty') || {};

  // ── 5. Update inventory for matching SKUs ─────────────────────────────────
  let updated = 0;
  let skipped = 0;
  let noMatch = 0;

  for (const variant of allVariants) {
    const sku = (variant.sku || '').trim().toUpperCase();
    if (!sku) { noMatch++; continue; }

    const bwQty = bwQtyBySku[sku];
    if (bwQty === undefined) { noMatch++; continue; }

    // Skip if quantity hasn't changed since last sync
    const lastKey = `${variant.inventoryItem.id}`;
    if (lastQty[lastKey] === bwQty) { skipped++; continue; }

    try {
      await shopify.setInventoryLevel(variant.inventoryItem.id, locationId, bwQty);
      logger.debug(`✓ Updated SKU ${sku}: ${lastQty[lastKey] ?? '?'} → ${bwQty}`);
      lastQty[lastKey] = bwQty;
      updated++;
    } catch (err) {
      logger.error(`✗ Failed to update inventory for SKU ${sku}: ${err.message}`);
    }
  }

  state.set('lastKnownQty', lastQty);
  state.set('lastRunAt', new Date().toISOString());

  logger.info(`◀ Completed: ${updated} updated, ${skipped} unchanged, ${noMatch} no BW match`);
  return { success: true, updated, skipped, noMatch };
}

module.exports = { run };
