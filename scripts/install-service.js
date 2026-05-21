'use strict';
/**
 * scripts/install-service.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Registers the middleware agent as a Windows Service so it:
 *   • Starts automatically when Windows boots
 *   • Can be started/stopped from the Windows Service Manager (services.msc)
 *     or via: sc start ShopifyBWAgent / sc stop ShopifyBWAgent
 *   • Automatically restarts on failure
 *   • Runs under the LOCAL SERVICE account (or configure a domain account below)
 *
 * Usage (run as Administrator):
 *   node scripts/install-service.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path    = require('path');
const Service = require('node-windows').Service;

const agentScript = path.resolve(__dirname, '../src/agent.js');

const svc = new Service({
  // ── Service identity ────────────────────────────────────────────────────
  name:        'ShopifyBWAgent',
  description: 'Shopify ↔ Sage BusinessWorks Middleware Sync Agent',
  script:      agentScript,

  // ── Node.js arguments ───────────────────────────────────────────────────
  // (none needed; --dev flag NOT passed so it runs in production mode)
  scriptOptions: '',

  // ── Environment ─────────────────────────────────────────────────────────
  // The service reads .env from the project root; ensure the file exists.
  workingDirectory: path.resolve(__dirname, '..'),

  // ── Restart policy ──────────────────────────────────────────────────────
  // Restart up to 3 times within a 60-second window, then wait 2 minutes
  maxRestarts:    3,
  maxRetries:     3,
  wait:           2,     // seconds between restarts
  grow:           0.25,  // multiply wait by this factor each successive restart
  abortOnError:   false, // keep trying to restart on error

  // ── Logging ─────────────────────────────────────────────────────────────
  // node-windows writes its own wrapper logs alongside the service;
  // the agent writes its own rotating logs to LOG_DIR in .env
  logpath: path.resolve(__dirname, '../logs'),
});

svc.on('install', () => {
  console.log('✓ Service installed successfully.');
  console.log('  Starting service now...');
  svc.start();
});

svc.on('start', () => {
  console.log('✓ ShopifyBWAgent service started.');
  console.log('\nUseful commands:');
  console.log('  sc query ShopifyBWAgent    — check status');
  console.log('  sc stop  ShopifyBWAgent    — stop service');
  console.log('  sc start ShopifyBWAgent    — start service');
  console.log('  services.msc               — open Service Manager GUI\n');
});

svc.on('alreadyinstalled', () => {
  console.log('⚠  Service is already installed.');
  console.log('   To reinstall: node scripts/uninstall-service.js, then re-run this script.');
});

svc.on('error', err => {
  console.error('✗ Service install error:', err);
});

console.log('Installing ShopifyBWAgent Windows Service...');
console.log(`  Script: ${agentScript}`);
svc.install();
