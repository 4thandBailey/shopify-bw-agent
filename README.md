# Shopify ↔ Sage BusinessWorks Middleware Agent

A Windows background service that automatically synchronises data between your Shopify store and Sage BusinessWorks accounting software.

---

## Architecture Overview

```
┌─────────────────────┐         ┌─────────────────────────────┐        ┌──────────────────────┐
│    Shopify Store    │◄───────►│  Middleware Agent (Windows) │◄──────►│  Sage BusinessWorks  │
│                     │Webhooks │  Node.js Windows Service    │BWGACCESS│  (Local / Network)  │
│  GraphQL Admin API  │+ Polling│  Runs on BW server          │  +ODBC  │  Database Files      │
└─────────────────────┘         └─────────────────────────────┘        └──────────────────────┘
```

### Data Flows

| Direction            | Data                    | Trigger          | Method         |
|----------------------|-------------------------|------------------|----------------|
| Shopify → BW         | New / updated orders    | Webhook + 5-min  | BWGACCESS CSV  |
| BW → Shopify         | Shipped order tracking  | 5-min poll       | ODBC + GraphQL |
| BW → Shopify         | Inventory levels        | 10-min poll      | ODBC + GraphQL |
| BW → Shopify         | Customer records        | Hourly poll      | ODBC + GraphQL |
| BW → Shopify         | Product pricing         | 30-min poll      | ODBC + GraphQL |

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Windows Server 2016+** or Windows 10/11 | Must be on same machine or network as BusinessWorks |
| **Node.js 18+** (64-bit) | Download from nodejs.org |
| **Sage BusinessWorks** | Any recent version |
| **BWGACCESS** | Obtained from Sage — email `[email protected]` |
| **ODBC DSN (32-bit)** | Configured in Windows ODBC Data Source Administrator (32-bit) |
| **Shopify Custom App** | With `read_orders`, `write_fulfillments`, `read_products`, `write_inventory`, `read_customers`, `write_customers` scopes |

---

## Installation

### 1. Clone / Copy Files

Place the project folder on the Windows machine that runs Sage BusinessWorks:
```
C:\ShopifyBWAgent\
```

### 2. Install Node Dependencies

Open a Command Prompt (as Administrator) in the project folder:
```cmd
cd C:\ShopifyBWAgent
npm install
```

### 3. Configure the Agent

Copy `.env.example` to `.env` and fill in all values:
```cmd
copy .env.example .env
notepad .env
```

Key settings to configure:

```env
# Your Shopify store
SHOPIFY_STORE_URL=https://your-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_...

# ODBC DSN name (set up in Windows ODBC Administrator 32-bit)
BW_ODBC_DSN=SageBusinessWorks

# BWGACCESS paths (adjust to your installation)
BWGACCESS_EXE_PATH=C:\SageBusinessWorks\BWGACCESS\BWGACCESS.exe
BWGACCESS_IMPORT_DIR=C:\SageBusinessWorks\imports
BWGACCESS_EXPORT_DIR=C:\SageBusinessWorks\exports
BWGACCESS_COMPANY_DIR=C:\SageBusinessWorks\Company
```

### 4. Configure the ODBC DSN

1. Open **ODBC Data Source Administrator (32-bit)**
   - `C:\Windows\SysWOW64\odbcad32.exe`
2. Add a **System DSN** for Sage BusinessWorks
3. Note the DSN name — it must match `BW_ODBC_DSN` in your `.env`

### 5. Customize the BW Table Names

Sage BusinessWorks table names vary slightly by version. Open `src/services/businessworks.js` and verify the SQL queries match your ODBC schema. Key tables:

| Table | Module | Notes |
|---|---|---|
| `IC_ITEM` | Inventory Control | Item master with qty on hand |
| `OE_ORDER_HEADER` | Order Entry | Order headers |
| `AR_CUSTOMER` | Accounts Receivable | Customer master |
| `IC_PRICE_LEVEL` | Inventory Control | Price levels per item |

To discover your table names, use Excel's ODBC connection or Microsoft Access linked tables.

### 6. Add SHOPIFY_ORDER Field to BW

The fulfillment sync requires the BW `OE_ORDER_HEADER` table to have a `SHOPIFY_ORDER` field to store the Shopify Order ID. Work with your BW consultant to add this custom field, or use the order reference/comment field as a workaround.

---

## Running as a Windows Service

### Install the Service (run as Administrator)

```cmd
cd C:\ShopifyBWAgent
node scripts/install-service.js
```

This:
- Registers **ShopifyBWAgent** in Windows Services
- Sets it to start automatically on boot
- Configures automatic restart on failure (up to 3 times)
- Starts the service immediately

### Managing the Service

**Via Windows Service Manager (GUI):**
1. Press `Win + R`, type `services.msc`, press Enter
2. Find **ShopifyBWAgent** in the list
3. Right-click → Start / Stop / Restart / Properties

**Via Command Line:**
```cmd
sc start  ShopifyBWAgent    # Start the service
sc stop   ShopifyBWAgent    # Stop the service
sc query  ShopifyBWAgent    # Check status
```

### Uninstall the Service

```cmd
node scripts/uninstall-service.js
```

---

## Running in Development Mode

For testing without installing as a service:

```cmd
npm run dev
```

Development mode:
- Skips the initial startup sync
- Logs to console with colour
- Runs the webhook server on localhost

---

## Shopify Webhook Setup

For real-time order triggering (instead of waiting for the 5-minute poll), register these webhooks in your Shopify Partner dashboard or via the Admin API:

| Topic | Endpoint |
|---|---|
| `orders/create` | `http://YOUR-SERVER-IP:3456/webhooks/orders/create` |
| `orders/updated` | `http://YOUR-SERVER-IP:3456/webhooks/orders/updated` |

> **Note:** Shopify webhooks require a publicly accessible HTTPS URL. If your server is behind a firewall, use a reverse proxy (nginx) or a tunnel like ngrok for development.

---

## Log Files

Logs are written to the path configured in `LOG_DIR` (default: `C:\SageBusinessWorks\AgentLogs`):

| File | Contents |
|---|---|
| `shopify-bw-agent-YYYY-MM-DD.log` | All log levels |
| `shopify-bw-agent-error-YYYY-MM-DD.log` | Errors only |
| `state/` | Sync state files (last run timestamps, processed IDs) |

Logs rotate daily and are compressed. Retention is controlled by `LOG_RETENTION_DAYS`.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| ODBC connection fails | Verify DSN name in 32-bit ODBC Admin; check BW is running |
| BWGACCESS fails | Confirm path in `.env`; run manually to check license |
| Shopify 401 errors | Regenerate access token; verify app scopes |
| Orders not importing | Check BW import format; review `OE` module CSV spec |
| Service won't start | Check Windows Event Viewer → Application for errors |
| Inventory not updating | Confirm SKU values match exactly between Shopify and BW `ITEM_CODE` |

---

## Project Structure

```
shopify-bw-agent/
├── src/
│   ├── agent.js                     # Main entry point & scheduler
│   ├── config/
│   │   └── index.js                 # Config loader
│   ├── services/
│   │   ├── shopify.js               # Shopify GraphQL API client
│   │   ├── businessworks.js         # BW ODBC + BWGACCESS client
│   │   └── webhookServer.js         # Express webhook receiver
│   ├── flows/
│   │   ├── ordersToBusinessWorks.js # Shopify → BW orders
│   │   ├── fulfillmentsToShopify.js # BW shipped → Shopify fulfilled
│   │   ├── inventoryToShopify.js    # BW inventory → Shopify stock
│   │   ├── customersToShopify.js    # BW customers → Shopify
│   │   └── pricingToShopify.js      # BW pricing → Shopify prices
│   └── utils/
│       ├── logger.js                # Winston rotating logger
│       └── stateStore.js           # Persistent JSON state files
├── scripts/
│   ├── install-service.js           # Register Windows Service
│   └── uninstall-service.js         # Remove Windows Service
├── logs/                            # Runtime logs (git-ignored)
├── .env.example                     # Configuration template
├── package.json
└── README.md
```
