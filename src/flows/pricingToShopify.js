'use strict';
/**
 * flows/pricingToShopify.js
 * DATA FLOW: BusinessWorks → Shopify
 *
 * 1. Reads current item pricing from BW Inventory Control via ODBC.
 * 2. Fetches Shopify product variants.
 * 3. Updates the Shopify variant price for any SKU whose price has changed.
 *
 * Only updates when the price actually differs to avoid noisy audit logs
 * and unnecessary Shopify API calls.
 */

const shopify    = require('../services/shopify');
const bw         = require('../services/businessworks');
const logger     = require('../utils/logger').forModule('PricingToShopify');
const StateStore = require('../utils/stateStore');

const state = new StateStore('pricing-to-shopify');

async function run() {
  logger.info('▶ Starting flow: BusinessWorks Pricing → Shopify');

  // ── 1. Read BW pricing ─────────────────────────────────────────────────────
  let bwPricing;
  try {
    bwPricing = await bw.getItemPricing();
  } catch (err) {
    logger.error(`ODBC pricing read failed: ${err.message}`);
    return { success: false, error: err.message };
  }

  // Build SKU → unitPrice map (use price level 1 as default; fall back to unitPrice)
  const bwPriceBySku = {};
  for (const row of bwPricing) {
    const sku = (row.itemCode || '').trim().toUpperCase();
    if (!sku) continue;
    // Prefer Price Level 1 for Shopify "retail" price
    if (!bwPriceBySku[sku] || row.priceLevel === '1') {
      bwPriceBySku[sku] = parseFloat(row.levelPrice || row.unitPrice || 0).toFixed(2);
    }
  }
  logger.info(`Loaded prices for ${Object.keys(bwPriceBySku).length} SKUs from BusinessWorks`);

  // ── 2. Paginate Shopify variants ───────────────────────────────────────────
  const allVariants = [];
  let cursor = null;
  do {
    const page = await shopify.getProductVariants(cursor);
    allVariants.push(...page.edges.map(e => e.node));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  logger.info(`Fetched ${allVariants.length} Shopify variants`);

  // ── 3. Update prices where changed ────────────────────────────────────────
  const lastPrice = state.get('lastKnownPrice') || {};
  let updated = 0;
  let skipped = 0;
  let noMatch = 0;

  for (const variant of allVariants) {
    const sku = (variant.sku || '').trim().toUpperCase();
    if (!sku) { noMatch++; continue; }

    const bwPrice = bwPriceBySku[sku];
    if (bwPrice === undefined) { noMatch++; continue; }

    const currentShopifyPrice = parseFloat(variant.price).toFixed(2);
    if (lastPrice[sku] === bwPrice && currentShopifyPrice === bwPrice) {
      skipped++;
      continue;
    }

    try {
      await shopify.updateVariantPrice(variant.id, bwPrice);
      logger.debug(`✓ Updated price for SKU ${sku}: $${currentShopifyPrice} → $${bwPrice}`);
      lastPrice[sku] = bwPrice;
      updated++;
    } catch (err) {
      logger.error(`✗ Failed to update price for SKU ${sku}: ${err.message}`);
    }
  }

  state.set('lastKnownPrice', lastPrice);
  state.set('lastRunAt', new Date().toISOString());

  logger.info(`◀ Completed: ${updated} prices updated, ${skipped} unchanged, ${noMatch} no BW match`);
  return { success: true, updated, skipped, noMatch };
}

module.exports = { run };
