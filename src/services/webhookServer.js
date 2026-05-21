'use strict';
/**
 * services/webhookServer.js
 * Lightweight Express server that receives Shopify webhook POST requests.
 * Triggers the appropriate sync flow immediately rather than waiting
 * for the next scheduled poll.
 *
 * Register these webhooks in your Shopify Partner dashboard or via API:
 *   POST /webhooks/orders/create  → topic: orders/create
 *   POST /webhooks/orders/updated → topic: orders/updated
 */

const express = require('express');
const crypto  = require('crypto');
const config  = require('../config');
const logger  = require('../utils/logger').forModule('WebhookServer');

let ordersFlow = null; // Injected after startup to avoid circular deps

function verifyHmac(rawBody, hmacHeader) {
  if (!config.shopify.webhookSecret || !config.webhook.verifyHmac) return true;
  try {
    const digest = crypto
      .createHmac('sha256', config.shopify.webhookSecret)
      .update(rawBody, 'utf8')
      .digest('base64');
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader || ''));
  } catch {
    return false;
  }
}

function createServer(flowsMap) {
  ordersFlow = flowsMap;

  const app = express();

  // Parse raw body for HMAC verification before JSON parsing
  app.use((req, res, next) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      req.rawBody = raw;
      try { req.body = JSON.parse(raw); } catch { req.body = {}; }
      next();
    });
  });

  // ── Health check ────────────────────────────────────────────────────────────
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', agent: 'shopify-bw-middleware', ts: new Date().toISOString() });
  });

  // ── Webhook receiver ────────────────────────────────────────────────────────
  app.post('/webhooks/:topic(*)', async (req, res) => {
    const topic = req.params.topic;
    const hmac  = req.headers['x-shopify-hmac-sha256'];

    if (!verifyHmac(req.rawBody, hmac)) {
      logger.warn(`Webhook HMAC verification failed for topic: ${topic}`);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Acknowledge immediately — Shopify expects a fast 200
    res.status(200).json({ received: true });

    // Process async
    setImmediate(async () => {
      logger.info(`Webhook received: ${topic}`);
      try {
        switch (topic) {
          case 'orders/create':
          case 'orders/updated': {
            logger.info(`Triggering order sync due to webhook: ${topic}`);
            if (flowsMap.ordersToBusinessWorks) {
              await flowsMap.ordersToBusinessWorks.run();
            }
            break;
          }
          case 'inventory_levels/update': {
            logger.info('Inventory level update webhook received (Shopify→BW path not needed; BW is source of truth)');
            break;
          }
          default:
            logger.debug(`Unhandled webhook topic: ${topic}`);
        }
      } catch (err) {
        logger.error(`Error processing webhook ${topic}: ${err.message}`);
      }
    });
  });

  return app;
}

function start(flowsMap) {
  const app    = createServer(flowsMap);
  const port   = config.webhook.port;
  const server = app.listen(port, '127.0.0.1', () => {
    logger.info(`Webhook server listening on http://127.0.0.1:${port}`);
  });

  server.on('error', err => {
    logger.error(`Webhook server error: ${err.message}`);
  });

  return server;
}

module.exports = { start };
