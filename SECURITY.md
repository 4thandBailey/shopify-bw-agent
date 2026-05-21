# Security Policy

This document describes the security model, credential handling practices, and
vulnerability disclosure process for the Shopify ↔ Sage BusinessWorks Middleware Agent.

---

## Supported Versions

| Version | Supported |
|---|---|
| 1.0.x | ✅ Active |

Security fixes are backported to the current major version only. We strongly recommend
always running the latest release.

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub Issues.**

To report a vulnerability, email us directly at the address listed in the repository's
GitHub profile. Include:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (if safe to share)
- The version(s) affected
- Any suggested mitigations you are aware of

You can expect an acknowledgement within **48 hours** and a status update within
**7 days**. We will credit reporters in the release notes unless you prefer to
remain anonymous.

---

## Credential and Secret Handling

### Environment Variables
All sensitive credentials are loaded exclusively from a `.env` file at runtime.
**The `.env` file is listed in `.gitignore` and must never be committed to version control.**
Only the `.env.example` template (containing no real values) is committed to the repository.

Credentials managed via `.env`:

| Variable | Description | Risk if exposed |
|---|---|---|
| `SHOPIFY_ACCESS_TOKEN` | Shopify Admin API token | Full store read/write access |
| `SHOPIFY_WEBHOOK_SECRET` | HMAC key for webhook verification | Webhook spoofing |
| `BW_ODBC_PASSWORD` | BusinessWorks ODBC password | Database read access |

### Shopify Access Token
- Use a **Custom App** access token scoped to only the permissions this agent requires
- Required scopes: `read_orders`, `write_fulfillments`, `read_products`,
  `write_inventory`, `read_customers`, `write_customers`
- Do not use a token with broader scopes than necessary
- Rotate the token immediately if you suspect it has been compromised
  (Shopify Partner Dashboard → Apps → your app → Rotate credentials)

### ODBC Credentials
- Create a dedicated, read-only ODBC user in BusinessWorks for the agent if possible
- The agent only requires write access to `OE_ORDER_HEADER` (via BWGACCESS, not raw ODBC)
- Raw ODBC credentials in `.env` are used for read queries only

### BWGACCESS
- BWGACCESS is invoked as a subprocess; it reads and writes BW data files directly
- Restrict filesystem permissions on `BWGACCESS_IMPORT_DIR` and `BWGACCESS_EXPORT_DIR`
  so only the Windows Service account and BW administrators can access them
- Staging CSV files are deleted immediately after BWGACCESS completes

---

## Webhook Security

### HMAC Verification
Shopify signs every webhook request with an HMAC-SHA256 digest using your
`SHOPIFY_WEBHOOK_SECRET`. The agent verifies this signature on every incoming
webhook before processing it. Set `WEBHOOK_VERIFY_HMAC=true` in `.env` (the default).

Do not set `WEBHOOK_VERIFY_HMAC=false` in production under any circumstances.

### Network Exposure
The webhook HTTP server binds to `127.0.0.1` (localhost) by default. If you need
Shopify to reach it from the internet:

- Place a **reverse proxy** (nginx, IIS, Caddy) in front of the agent
- Enforce **HTTPS/TLS** at the reverse proxy — Shopify requires HTTPS for webhooks
- Consider restricting inbound connections to [Shopify's IP ranges](https://shopify.dev/docs/apps/build/webhooks/security) at the firewall level
- Do **not** expose the webhook port directly to the internet without TLS

---

## Data in Transit

- All communication with the Shopify API uses **HTTPS/TLS 1.2+** enforced by the
  `axios` HTTP client
- Webhook payloads are received over HTTPS (via reverse proxy)
- ODBC connections are local (loopback or LAN); no financial data leaves the
  local network via ODBC
- BWGACCESS operates entirely on the local filesystem; no network transmission

## Data at Rest

- Log files written to `LOG_DIR` may contain order numbers, customer emails,
  SKUs, and sync summaries — **but never payment card data, passwords, or API tokens**
- State files in `LOG_DIR/state/` contain timestamps and processed order ID lists only
- Restrict filesystem permissions on `LOG_DIR` to the service account and administrators
- Log files rotate daily and are deleted after `LOG_RETENTION_DAYS` (default: 30 days)

---

## Windows Service Account

The agent runs as a Windows Service. By default, `node-windows` installs it under
the **Local Service** account. For production environments, consider:

- Creating a **dedicated service account** with the minimum permissions required:
  - Read/write access to the project directory and log directory
  - Read/write access to BWGACCESS import/export staging directories
  - Execute permission for `BWGACCESS.exe`
  - Network access to reach the Shopify API (outbound HTTPS on port 443)
- Do **not** run the service as a Domain Admin or Local Administrator

---

## Dependency Security

Dependencies are managed via `npm`. To audit for known vulnerabilities:

```cmd
npm audit
```

To apply non-breaking security fixes automatically:

```cmd
npm audit fix
```

Review and update dependencies regularly. Pin to specific versions in `package.json`
for production deployments to prevent unexpected updates.

---

## What This Agent Does NOT Do

To be explicit about the security boundary:

- ❌ Does not store or transmit payment card data (PCI DSS not in scope)
- ❌ Does not store Shopify access tokens in the database or log files
- ❌ Does not expose any BusinessWorks data publicly
- ❌ Does not accept inbound connections from the internet (only outbound to Shopify)
  unless a reverse proxy is explicitly configured for webhooks
- ❌ Does not modify Shopify financial records (no refunds, no payment capture)
- ❌ Does not delete data in either system
