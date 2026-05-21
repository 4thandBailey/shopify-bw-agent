'use strict';
/**
 * scripts/uninstall-service.js
 * Removes the ShopifyBWAgent Windows Service.
 *
 * Usage (run as Administrator):
 *   node scripts/uninstall-service.js
 */

const path    = require('path');
const Service = require('node-windows').Service;

const svc = new Service({
  name:   'ShopifyBWAgent',
  script: path.resolve(__dirname, '../src/agent.js'),
});

svc.on('uninstall', () => {
  console.log('✓ ShopifyBWAgent service uninstalled successfully.');
});

svc.on('stop', () => {
  console.log('  Service stopped. Uninstalling...');
  svc.uninstall();
});

svc.on('error', err => {
  console.error('✗ Uninstall error:', err);
});

console.log('Stopping and uninstalling ShopifyBWAgent...');
// Stop first, then uninstall fires via the 'stop' event
try {
  svc.stop();
} catch {
  // If not running, just uninstall directly
  svc.uninstall();
}
