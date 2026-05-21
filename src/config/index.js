'use strict';
/**
 * config/index.js
 * Loads and validates all environment configuration.
 * Throws on startup if required values are missing.
 */

require('dotenv').config();

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`[Config] Missing required environment variable: ${key}`);
  return val;
}

function optional(key, defaultValue = '') {
  return process.env[key] || defaultValue;
}

const config = {
  // ── Shopify ──────────────────────────────────────────────────────────────
  shopify: {
    storeUrl:      required('SHOPIFY_STORE_URL'),
    accessToken:   required('SHOPIFY_ACCESS_TOKEN'),
    apiVersion:    optional('SHOPIFY_API_VERSION', '2024-04'),
    webhookSecret: optional('SHOPIFY_WEBHOOK_SECRET'),
  },

  // ── Sage BusinessWorks ODBC ───────────────────────────────────────────────
  odbc: {
    dsn:      required('BW_ODBC_DSN'),
    user:     optional('BW_ODBC_USER'),
    password: optional('BW_ODBC_PASSWORD'),
    // Build the ODBC connection string
    get connectionString() {
      let cs = `DSN=${this.dsn}`;
      if (this.user)     cs += `;UID=${this.user}`;
      if (this.password) cs += `;PWD=${this.password}`;
      return cs;
    },
  },

  // ── BWGACCESS ────────────────────────────────────────────────────────────
  bwgaccess: {
    exePath:    required('BWGACCESS_EXE_PATH'),
    importDir:  required('BWGACCESS_IMPORT_DIR'),
    exportDir:  required('BWGACCESS_EXPORT_DIR'),
    companyDir: required('BWGACCESS_COMPANY_DIR'),
  },

  // ── Sync Schedules ────────────────────────────────────────────────────────
  schedules: {
    inventory:   optional('SYNC_INVENTORY_CRON',   '*/10 * * * *'),
    fulfillment: optional('SYNC_FULFILLMENT_CRON',  '*/5 * * * *'),
    customers:   optional('SYNC_CUSTOMERS_CRON',    '0 * * * *'),
    products:    optional('SYNC_PRODUCTS_CRON',     '*/30 * * * *'),
  },

  // ── Webhook Server ────────────────────────────────────────────────────────
  webhook: {
    port:       parseInt(optional('WEBHOOK_PORT', '3456'), 10),
    verifyHmac: optional('WEBHOOK_VERIFY_HMAC', 'true') === 'true',
  },

  // ── Agent ────────────────────────────────────────────────────────────────
  agent: {
    logLevel:         optional('LOG_LEVEL', 'info'),
    logRetentionDays: parseInt(optional('LOG_RETENTION_DAYS', '30'), 10),
    logDir:           optional('LOG_DIR', './logs'),
    queueConcurrency: parseInt(optional('QUEUE_CONCURRENCY', '3'), 10),
    shopifyApiDelay:  parseInt(optional('SHOPIFY_API_DELAY_MS', '500'), 10),
    isDev:            process.argv.includes('--dev'),
  },
};

module.exports = config;
