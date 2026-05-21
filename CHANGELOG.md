# Changelog

All notable changes to the Shopify ↔ Sage BusinessWorks Middleware Agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [1.0.0] — 2026-05-21

### Added
- **Windows Service support** via `node-windows` — install, start, stop, and uninstall
  the agent through Windows Service Manager (`services.msc`) or `sc` commands
- **Automatic restart policy** — service recovers from failures with configurable
  retry count, wait intervals, and exponential back-off
- **Graceful shutdown** — SIGTERM/SIGINT handlers wait for all in-progress sync
  flows to complete before the process exits
- **Shopify GraphQL Admin API client** (`src/services/shopify.js`)
  - Order fetching with full line item, address, and customer detail
  - Fulfillment creation with tracking number and carrier
  - Inventory level updates (absolute quantity set)
  - Product variant price updates
  - Customer upsert (create or update by email)
  - Built-in rate-limit back-off and retry with `Retry-After` header support
- **Sage BusinessWorks data client** (`src/services/businessworks.js`)
  - ODBC connection pool for read queries (32-bit DSN)
  - Inventory levels from `IC_ITEM`
  - Shipped orders from `OE_ORDER_HEADER`
  - Customer records from `AR_CUSTOMER`
  - Item pricing from `IC_ITEM` and `IC_PRICE_LEVEL`
  - BWGACCESS subprocess invoker for import and export operations
- **Shopify webhook HTTP server** (`src/services/webhookServer.js`)
  - Express listener on configurable port (default 3456)
  - HMAC-SHA256 signature verification
  - Immediate 200 acknowledgement with async flow processing
  - Health check endpoint at `GET /health`
- **Five bidirectional sync flows**
  - `ordersToBusinessWorks` — Shopify unfulfilled orders → BW Order Entry via BWGACCESS
  - `fulfillmentsToShopify` — BW shipped orders → Shopify fulfillment with tracking
  - `inventoryToShopify` — BW inventory levels → Shopify stock (change-detection)
  - `customersToShopify` — BW AR customers → Shopify customers (upsert)
  - `pricingToShopify` — BW item pricing → Shopify variant prices (change-detection)
- **Cron scheduler** with fully configurable intervals per flow via `.env`
- **Duplicate-run protection** — a flow already executing skips its next scheduled trigger
- **Persistent state store** (`src/utils/stateStore.js`) — JSON files survive service
  restarts, tracking last-run timestamps and processed record IDs
- **Structured rotating logger** (`src/utils/logger.js`) — daily log rotation,
  configurable retention, separate error log file, Winston-based
- **Configuration validation** on startup — missing required `.env` values throw
  immediately with a clear error message rather than failing silently at runtime
- **Task queue** (`p-queue`) with configurable concurrency for parallel flow execution
- `scripts/install-service.js` — registers the Windows Service as Administrator
- `scripts/uninstall-service.js` — stops and removes the Windows Service
- `.env.example` — fully documented configuration template
- `README.md` — installation, configuration, ODBC setup, service management,
  webhook registration, troubleshooting, and project structure guide

---

[Unreleased]: https://github.com/4thandBailey/shopify-bw-agent/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/4thandBailey/shopify-bw-agent/releases/tag/v1.0.0
