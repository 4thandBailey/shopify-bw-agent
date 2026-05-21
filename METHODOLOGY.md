# Methodology

This document explains the technical decisions, architectural tradeoffs, and design
rationale behind the Shopify ↔ Sage BusinessWorks Middleware Agent. It is intended
for developers maintaining or extending this codebase.

---

## The Core Problem

Sage BusinessWorks is a legacy, on-premises Windows desktop accounting application.
Unlike modern cloud ERP systems, it has no REST API, no webhook system, and no
native cloud connectivity. Shopify, by contrast, is a fully cloud-native platform
with a mature GraphQL API and a real-time webhook infrastructure.

Connecting these two systems requires a middleware layer that bridges the gap —
running locally on the same machine (or network) as BusinessWorks while communicating
outward to Shopify over HTTPS.

---

## Integration Pathways Considered

Three integration methods were evaluated before arriving at the current architecture.

### Option 1: BWGACCESS SDK ✅ Chosen for writes
BWGACCESS is a Windows executable provided by Sage that allows third-party developers
to import and export data directly into BusinessWorks data files. It runs silently in
the background, requires no user interaction, and honours all of BusinessWorks' own
business logic and validation rules during import.

**Why chosen for writes:** Writing data into BusinessWorks via BWGACCESS is the only
sanctioned, safe method. It routes data through BW's own import engine, which means
field validation, referential integrity, and audit trails are all preserved. Direct
database writes would bypass this entirely and risk data corruption.

**Limitations:** BWGACCESS must be licensed separately from Sage. It is invoked as a
subprocess, so it adds latency compared to a native API call. It is also Windows-only.

### Option 2: ODBC Direct Database Access ✅ Chosen for reads
Sage BusinessWorks exposes its underlying database via 32-bit ODBC drivers. Any
application that can open a 32-bit ODBC connection can query the BusinessWorks
database tables directly using SQL.

**Why chosen for reads:** ODBC is fast, reliable, and provides full SQL query
flexibility. It is ideal for reading inventory levels, customer records, pricing,
and order status — all of which are read-only operations from the agent's perspective.

**Why not used for writes:** Writing directly to the BW database via ODBC bypasses
all of BusinessWorks' business logic, validation, and audit mechanisms. This is
unsafe for financial records. BWGACCESS is used for all write operations instead.

### Option 3: CSV File-Based Import/Export ⚠️ Fallback only
BusinessWorks supports importing data from comma-separated `.csv` files through its
built-in import wizard. This is the simplest approach and requires no additional
licensing beyond the base product.

**Why not chosen as primary:** The CSV import process typically requires user
interaction (clicking through the BW import wizard), making full automation difficult
without BWGACCESS. It also lacks the programmatic control and error reporting that
BWGACCESS provides. CSV import is used internally by BWGACCESS itself, so this
approach is effectively subsumed by Option 1.

---

## Architecture Decisions

### Why Node.js?
- First-class support for the Shopify Admin API via standard HTTP/GraphQL
- `node-windows` provides a mature, well-documented Windows Service wrapper
- Native async/await makes polling and webhook handling clean to reason about
- The `odbc` npm package provides reliable 32-bit ODBC connectivity on Windows
- Wide availability of developers familiar with JavaScript

### Why a Windows Service?
The agent must run continuously in the background, survive user logoffs, start
automatically after reboots, and be manageable by system administrators without
requiring developer intervention. Windows Services are the standard mechanism for
all of these requirements on Windows Server environments. `node-windows` wraps the
Node.js process in a native Windows Service with automatic restart on failure.

### Why Polling Instead of Pure Event-Driven?
BusinessWorks has no outbound event system — it cannot push notifications when
inventory changes or an order ships. Polling via cron is therefore unavoidable for
the BW → Shopify direction. Polling intervals are tuned per flow based on expected
data velocity:

| Flow | Interval | Rationale |
|---|---|---|
| Orders → BW | 5 minutes | Orders need to reach BW quickly for fulfilment |
| Fulfillments → Shopify | 5 minutes | Customers expect timely shipping notifications |
| Inventory → Shopify | 10 minutes | Stock levels change less frequently than orders |
| Customers → Shopify | 60 minutes | Customer data changes slowly |
| Pricing → Shopify | 30 minutes | Price changes are infrequent but important |

For the Shopify → BW direction, Shopify webhooks provide real-time triggers that
supplement the polling schedule, reducing latency for new order imports.

### Why Change Detection for Inventory and Pricing?
Shopify's API has rate limits (typically 2 requests/second on the standard tier).
With potentially hundreds or thousands of SKUs, blindly updating every variant on
every poll cycle would exhaust the rate limit quickly and generate unnecessary API
traffic. The agent maintains a local state file of last-known quantities and prices,
and only calls the Shopify API for records that have actually changed.

### Why a Task Queue with Duplicate-Run Protection?
Cron schedules are fixed intervals. If a sync flow takes longer than its interval
(e.g., a large inventory sync running over 10 minutes), a naive implementation would
start a second instance of the same flow before the first completes. This can cause
race conditions, duplicate records, and conflicting writes. The `p-queue` task queue
with a `runningFlows` Set ensures each flow has at most one active execution at any time.

### Why Persistent State Files Instead of a Database?
A full database (SQLite, SQL Server) would add a significant dependency and operational
burden. The state requirements are minimal — a handful of timestamps and ID lists per
flow. JSON files written to disk satisfy this need with zero infrastructure overhead
and are human-readable for debugging. The `stateStore.js` utility abstracts the
file I/O so the storage mechanism can be swapped out later if needed.

### Why SKU as the Sync Key?
The agent uses product SKU as the shared identifier between Shopify variants and
BusinessWorks inventory items (`ITEM_CODE`). SKU was chosen because:
- It is the standard product identifier in both systems
- It is set and maintained by the business (stable, meaningful)
- Shopify internal IDs (GIDs) have no meaning in BusinessWorks
- BusinessWorks item codes map directly to SKUs in most retail workflows

**Important:** SKU values must be kept in sync between both systems. The Shopify
SKU and the BW `ITEM_CODE` must match exactly (the agent normalises both to
uppercase for comparison).

---

## Data Flow Design

### Shopify → BusinessWorks (Orders)
```
Shopify webhook (orders/create)
        │
        ▼
Webhook server acknowledges (HTTP 200)
        │
        ▼
ordersToBusinessWorks flow enqueued
        │
        ▼
Fetch unfulfilled orders via GraphQL (since last run)
        │
        ▼
Convert each order to BW Order Entry CSV format
  Header record (H): order no, customer, ship-to address, freight, reference
  Line records  (L): item code (SKU), qty, unit price, description
        │
        ▼
Write CSV to BWGACCESS import staging directory
        │
        ▼
Invoke BWGACCESS.exe /IMPORT /MODULE:OE
        │
        ▼
Update lastRunAt state cursor
```

### BusinessWorks → Shopify (Fulfillments)
```
Cron trigger (every 5 minutes)
        │
        ▼
ODBC query: OE_ORDER_HEADER WHERE STATUS='S' AND SHIP_DATE >= lastRunAt
  (Only orders with a SHOPIFY_ORDER field populated)
        │
        ▼
Filter out order nos already in syncedOrderNos state list
        │
        ▼
For each shipped order:
  Resolve Shopify Order GID from stored SHOPIFY_ORDER field
  Call Shopify fulfillmentCreate mutation with tracking info
        │
        ▼
Append synced order nos to state list (capped at 2000)
Update lastRunAt state cursor
```

---

## Known Limitations and Future Considerations

| Limitation | Notes |
|---|---|
| BWGACCESS is Windows-only | The agent must run on a Windows machine co-located with BusinessWorks |
| 32-bit ODBC only | The `odbc` npm package must interface with the 32-bit BW ODBC driver; Node.js itself must also run as 32-bit, or use a bridge process |
| No real-time BW → Shopify | Polling is the only option; minimum practical interval is ~5 minutes |
| SHOPIFY_ORDER field | Requires a custom field on `OE_ORDER_HEADER` to store the Shopify Order ID for fulfillment matching |
| SKU discipline required | Both systems must use identical SKU/item code values |
| Single Shopify location | The current inventory sync targets the first active Shopify location; multi-location support would require extending `inventoryToShopify.js` |
| No conflict resolution | If the same record is modified in both systems between syncs, the last write wins; BW is treated as the source of truth for inventory and pricing |
