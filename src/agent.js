'use strict';
/**
 * agent.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shopify ↔ Sage BusinessWorks Middleware Agent — Main Entry Point
 *
 * Responsibilities:
 *   • Validates configuration on startup
 *   • Starts the Shopify webhook HTTP listener
 *   • Schedules all sync flows via cron
 *   • Handles graceful shutdown (SIGTERM / SIGINT from Windows Service Manager)
 *   • Serialises concurrent flow execution via a task queue
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Startup banner ─────────────────────────────────────────────────────────────
const PKG = require('../package.json');
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(` Shopify ↔ Sage BusinessWorks Middleware Agent v${PKG.version}`);
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

// ── Load config first (will throw on missing required vars) ───────────────────
let config;
try {
  config = require('./config');
} catch (err) {
  console.error(`[FATAL] Configuration error: ${err.message}`);
  console.error('Copy .env.example to .env and fill in all required values.');
  process.exit(1);
}

const { CronJob }     = require('cron');
const { default: PQueue } = require('p-queue');
const logger          = require('./utils/logger');
const bw              = require('./services/businessworks');
const webhookServer   = require('./services/webhookServer');

// ── Sync flows ────────────────────────────────────────────────────────────────
const flows = {
  ordersToBusinessWorks:  require('./flows/ordersToBusinessWorks'),
  fulfillmentsToShopify:  require('./flows/fulfillmentsToShopify'),
  inventoryToShopify:     require('./flows/inventoryToShopify'),
  customersToShopify:     require('./flows/customersToShopify'),
  pricingToShopify:       require('./flows/pricingToShopify'),
};

// ── Task queue — prevent overlapping runs ─────────────────────────────────────
const queue = new PQueue({ concurrency: config.agent.queueConcurrency });

// ─────────────────────────────────────────────────────────────────────────────
// Enqueue a flow with duplicate-run protection.
// If the same flow is already queued/running, skip this trigger.
// ─────────────────────────────────────────────────────────────────────────────
const runningFlows = new Set();

async function enqueue(flowName) {
  if (runningFlows.has(flowName)) {
    logger.info(`[Queue] ${flowName} already running — skipping this trigger`);
    return;
  }

  queue.add(async () => {
    runningFlows.add(flowName);
    const start = Date.now();
    logger.info(`[Queue] Starting flow: ${flowName}`);
    try {
      const result = await flows[flowName].run();
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      logger.info(`[Queue] Flow ${flowName} completed in ${dur}s`, result);
    } catch (err) {
      logger.error(`[Queue] Flow ${flowName} threw unhandled error: ${err.message}`, { stack: err.stack });
    } finally {
      runningFlows.delete(flowName);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron jobs
// ─────────────────────────────────────────────────────────────────────────────
const jobs = [];

function scheduleFlow(flowName, cronExpression, description) {
  const job = new CronJob(
    cronExpression,
    () => enqueue(flowName),
    null,
    false,  // don't start immediately
    'America/New_York',
  );
  jobs.push(job);
  logger.info(`  Scheduled [${flowName}] — "${description}" (${cronExpression})`);
  return job;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────
let httpServer = null;
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`\n[Agent] Shutdown signal received: ${signal}`);
  logger.info('[Agent] Stopping cron schedulers...');
  jobs.forEach(j => j.stop());

  logger.info('[Agent] Waiting for in-progress flows to complete...');
  await queue.onIdle();

  logger.info('[Agent] Closing ODBC pool...');
  await bw.closePool().catch(() => {});

  if (httpServer) {
    logger.info('[Agent] Stopping webhook server...');
    await new Promise(resolve => httpServer.close(resolve));
  }

  logger.info('[Agent] Clean shutdown complete. Goodbye.\n');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));  // Windows Service Manager stop
process.on('SIGINT',  () => shutdown('SIGINT'));   // Ctrl+C in dev
process.on('uncaughtException', err => {
  logger.error(`[Agent] Uncaught exception: ${err.message}`, { stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error(`[Agent] Unhandled rejection: ${reason}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────────────────────
async function start() {
  logger.info('[Agent] Starting up...');
  logger.info(`[Agent] Mode: ${config.agent.isDev ? 'DEVELOPMENT' : 'PRODUCTION'}`);
  logger.info(`[Agent] Log directory: ${config.agent.logDir}`);

  // ── Start webhook HTTP server ──────────────────────────────────────────────
  logger.info('[Agent] Starting webhook server...');
  httpServer = webhookServer.start(flows);

  // ── Register cron schedules ────────────────────────────────────────────────
  logger.info('[Agent] Registering sync schedules:');

  scheduleFlow(
    'ordersToBusinessWorks',
    config.schedules.fulfillment,       // Reuse the 5-min schedule for order import
    'Shopify unfulfilled orders → BusinessWorks',
  );
  scheduleFlow(
    'fulfillmentsToShopify',
    config.schedules.fulfillment,
    'BusinessWorks shipped orders → Shopify fulfillments',
  );
  scheduleFlow(
    'inventoryToShopify',
    config.schedules.inventory,
    'BusinessWorks inventory levels → Shopify',
  );
  scheduleFlow(
    'customersToShopify',
    config.schedules.customers,
    'BusinessWorks AR customers → Shopify',
  );
  scheduleFlow(
    'pricingToShopify',
    config.schedules.products,
    'BusinessWorks item pricing → Shopify variant prices',
  );

  // ── Start all jobs ─────────────────────────────────────────────────────────
  jobs.forEach(j => j.start());
  logger.info(`[Agent] ${jobs.length} cron jobs active.`);

  // ── Run an initial sync on startup ─────────────────────────────────────────
  if (!config.agent.isDev) {
    logger.info('[Agent] Running initial sync on startup...');
    await enqueue('inventoryToShopify');
    await enqueue('fulfillmentsToShopify');
    await enqueue('ordersToBusinessWorks');
  }

  logger.info('[Agent] ✓ Middleware agent is running. Press Ctrl+C to stop (dev) or use Windows Service Manager.\n');
}

start().catch(err => {
  logger.error(`[Agent] Fatal startup error: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
