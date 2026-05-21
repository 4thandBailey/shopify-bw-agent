'use strict';
/**
 * services/shopify.js
 * Shopify GraphQL Admin API and REST client.
 * Handles authentication, retries, and rate-limit back-off.
 */

const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger').forModule('ShopifyService');

const BASE_URL    = `${config.shopify.storeUrl}/admin/api/${config.shopify.apiVersion}`;
const GRAPHQL_URL = `${BASE_URL}/graphql.json`;

// ── HTTP client ────────────────────────────────────────────────────────────────
const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    'X-Shopify-Access-Token': config.shopify.accessToken,
    'Content-Type':           'application/json',
  },
  timeout: 30_000,
});

// ── Rate-limit helper ──────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(fn, retries = 3, delayMs = config.agent.shopifyApiDelay) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await sleep(delayMs);
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 || status === 503) {
        const waitMs = parseInt(err.response.headers['retry-after'] || '2', 10) * 1000;
        logger.warn(`Rate limited by Shopify. Waiting ${waitMs}ms before retry ${attempt}/${retries}`);
        await sleep(waitMs);
      } else if (attempt === retries) {
        throw err;
      } else {
        logger.warn(`Shopify API error (attempt ${attempt}/${retries}): ${err.message}`);
        await sleep(delayMs * attempt);
      }
    }
  }
}

// ── GraphQL query helper ───────────────────────────────────────────────────────
async function graphql(query, variables = {}) {
  return withRetry(async () => {
    const response = await client.post(GRAPHQL_URL, { query, variables });
    if (response.data.errors) {
      const msg = response.data.errors.map(e => e.message).join('; ');
      throw new Error(`GraphQL errors: ${msg}`);
    }
    return response.data.data;
  });
}

// ── REST helper ────────────────────────────────────────────────────────────────
async function rest(method, path, data = null) {
  return withRetry(async () => {
    const response = await client({ method, url: path, data });
    return response.data;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch unfulfilled orders created since a given date.
 */
async function getUnfulfilledOrders(sinceDate) {
  const query = `
    query getOrders($query: String!) {
      orders(first: 250, query: $query) {
        edges {
          node {
            id
            name
            createdAt
            updatedAt
            email
            phone
            displayFulfillmentStatus
            displayFinancialStatus
            totalPriceSet { shopMoney { amount currencyCode } }
            subtotalPriceSet { shopMoney { amount currencyCode } }
            totalTaxSet { shopMoney { amount currencyCode } }
            totalShippingPriceSet { shopMoney { amount currencyCode } }
            shippingAddress {
              firstName lastName company address1 address2
              city province zip country phone
            }
            billingAddress {
              firstName lastName company address1 address2
              city province zip country phone
            }
            lineItems(first: 50) {
              edges {
                node {
                  id
                  title
                  sku
                  quantity
                  originalUnitPriceSet { shopMoney { amount currencyCode } }
                  discountedUnitPriceSet { shopMoney { amount currencyCode } }
                  vendor
                }
              }
            }
            customer {
              id
              email
              firstName
              lastName
              phone
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const queryStr = `fulfillment_status:unfulfilled created_at:>=${sinceDate}`;
  const data = await graphql(query, { query: queryStr });
  return data.orders.edges.map(e => e.node);
}

/**
 * Mark a Shopify order as fulfilled with a tracking number.
 */
async function fulfillOrder(orderId, lineItemIds, trackingNumber, trackingCompany) {
  // First, get the fulfillment order IDs
  const foQuery = `
    query getFulfillmentOrders($orderId: ID!) {
      order(id: $orderId) {
        fulfillmentOrders(first: 10) {
          edges { node { id status } }
        }
      }
    }
  `;
  const foData = await graphql(foQuery, { orderId });
  const openFOs = foData.order.fulfillmentOrders.edges
    .map(e => e.node)
    .filter(fo => fo.status === 'OPEN');

  if (openFOs.length === 0) {
    logger.warn(`No open fulfillment orders found for order ${orderId}`);
    return null;
  }

  const mutation = `
    mutation fulfillmentCreate($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) {
        fulfillment { id status }
        userErrors { field message }
      }
    }
  `;
  const fulfillmentInput = {
    lineItemsByFulfillmentOrder: openFOs.map(fo => ({
      fulfillmentOrderId: fo.id,
    })),
    trackingInfo: trackingNumber
      ? { number: trackingNumber, company: trackingCompany || 'Unknown' }
      : undefined,
    notifyCustomer: true,
  };

  const result = await graphql(mutation, { fulfillment: fulfillmentInput });
  if (result.fulfillmentCreate.userErrors.length > 0) {
    const errs = result.fulfillmentCreate.userErrors.map(e => e.message).join('; ');
    throw new Error(`Fulfillment errors: ${errs}`);
  }
  return result.fulfillmentCreate.fulfillment;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVENTORY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch all product variants with their inventory item IDs and SKUs.
 */
async function getProductVariants(cursor = null) {
  const query = `
    query getVariants($cursor: String) {
      productVariants(first: 250, after: $cursor) {
        edges {
          node {
            id
            sku
            inventoryItem { id }
            inventoryQuantity
            price
            compareAtPrice
            product {
              id
              title
              status
              vendor
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const data = await graphql(query, { cursor });
  return data.productVariants;
}

/**
 * Get all inventory locations.
 */
async function getLocations() {
  const query = `
    query {
      locations(first: 10) {
        edges {
          node { id name isActive }
        }
      }
    }
  `;
  const data = await graphql(query);
  return data.locations.edges.map(e => e.node).filter(l => l.isActive);
}

/**
 * Set absolute inventory level for an inventory item at a location.
 */
async function setInventoryLevel(inventoryItemId, locationId, quantity) {
  const mutation = `
    mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { id }
        userErrors { field message }
      }
    }
  `;
  const input = {
    name: 'available',
    reason: 'correction',
    quantities: [{
      inventoryItemId,
      locationId,
      quantity: parseInt(quantity, 10),
    }],
  };
  const result = await graphql(mutation, { input });
  if (result.inventorySetQuantities.userErrors.length > 0) {
    const errs = result.inventorySetQuantities.userErrors.map(e => e.message).join('; ');
    throw new Error(`Inventory set errors: ${errs}`);
  }
  return result.inventorySetQuantities;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOMERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Upsert a customer by email — creates if not found, updates if found.
 */
async function upsertCustomer(customerData) {
  // Search by email first
  const searchQuery = `
    query findCustomer($query: String!) {
      customers(first: 1, query: $query) {
        edges { node { id email } }
      }
    }
  `;
  const found = await graphql(searchQuery, { query: `email:${customerData.email}` });
  const existing = found.customers.edges[0]?.node;

  if (existing) {
    const updateMutation = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id email }
          userErrors { field message }
        }
      }
    `;
    const result = await graphql(updateMutation, {
      input: { id: existing.id, ...customerData },
    });
    return result.customerUpdate.customer;
  } else {
    const createMutation = `
      mutation customerCreate($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id email }
          userErrors { field message }
        }
      }
    `;
    const result = await graphql(createMutation, { input: customerData });
    return result.customerCreate.customer;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTS / PRICING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update a variant's price and compareAtPrice.
 */
async function updateVariantPrice(variantId, price, compareAtPrice = null) {
  const mutation = `
    mutation productVariantUpdate($input: ProductVariantInput!) {
      productVariantUpdate(input: $input) {
        productVariant { id price compareAtPrice }
        userErrors { field message }
      }
    }
  `;
  const input = { id: variantId, price: String(price) };
  if (compareAtPrice !== null) input.compareAtPrice = String(compareAtPrice);

  const result = await graphql(mutation, { input });
  if (result.productVariantUpdate.userErrors.length > 0) {
    const errs = result.productVariantUpdate.userErrors.map(e => e.message).join('; ');
    throw new Error(`Price update errors: ${errs}`);
  }
  return result.productVariantUpdate.productVariant;
}

// ── Webhook HMAC verification ─────────────────────────────────────────────────
const crypto = require('crypto');
function verifyWebhookHmac(rawBody, hmacHeader) {
  const digest = crypto
    .createHmac('sha256', config.shopify.webhookSecret)
    .update(rawBody, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

module.exports = {
  graphql,
  rest,
  getUnfulfilledOrders,
  fulfillOrder,
  getProductVariants,
  getLocations,
  setInventoryLevel,
  upsertCustomer,
  updateVariantPrice,
  verifyWebhookHmac,
};
