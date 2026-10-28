# Hosting LynkBay on Railway with PostgreSQL

This guide explains how to deploy and host the **LynkBay Cashew Billing App** on [Railway](https://railway.com/) with a managed **PostgreSQL** database for cloud persistence.

---

## Architecture Overview

```
                      ┌────────────────────────────────────────┐
                      │             Railway Cloud              │
                      │                                        │
  Browser / Mobile    │  ┌──────────────────┐                  │
 ───────────────────> │  │   LynkBay Node   │                  │
   (HTTPS Web App)    │  │   Web Server     │                  │
                      │  └─────────┬────────┘                  │
                      │            │ (DATABASE_URL)            │
                      │            ▼                           │
                      │  ┌──────────────────┐                  │
                      │  │    PostgreSQL    │                  │
                      │  │  Managed Service │                  │
                      │  └──────────────────┘                  │
                      │     • lynkbay_state (Atomic JSONB)     │
                      │     • lynkbay_products                 │
                      │     • lynkbay_customers                │
                      │     • lynkbay_bills                    │
                      │     • lynkbay_expenses                 │
                      └────────────────────────────────────────┘
```

- **Ephemeral-Proof Storage:** Containers on Railway are stateless. PostgreSQL stores all business data (`products`, `customers`, `bills`, `expenses`, `auditLogs`, and configuration) persistently across deployments and restarts.
- **Relational Tables for Direct SQL:** In addition to the primary state snapshot in `lynkbay_state`, live relational tables are automatically mirrored for SQL queries and reports in Railway's Data Explorer.
- **Zero-Friction Fallback:** If `DATABASE_URL` is omitted (e.g. running locally offline), the app automatically falls back to local file storage (`data/lynkbay-db.json`).

---

## Step-by-Step Deployment Guide

### Step 1: Sign in to Railway
1. Open [railway.com](https://railway.com/) and log in (or sign up with your GitHub account).
2. Click **"+ New Project"**.

### Step 2: Deploy from GitHub Repo
1. Select **"Deploy from GitHub repo"**.
2. Choose your repository: **`K3SARA/lucky_cashew`**.
3. Click **"Deploy Now"**.

### Step 3: Add a PostgreSQL Database Service
1. In your Railway project dashboard, click **"+ Create"** or **"+ New"** (top right).
2. Select **"Database"** ➔ **"Add PostgreSQL"**.
3. Railway will provision a new PostgreSQL instance in seconds.

### Step 4: Link Database to the Web Service
Railway connects services within the same project automatically, but verify the variable:
1. Click on your **lucky_cashew** service in the Railway canvas.
2. Go to the **"Variables"** tab.
3. Click **"New Variable"** ➔ **"Add Reference"** (or check if `DATABASE_URL` is already present).
4. If not automatically referenced, select:
   - Variable Name: `DATABASE_URL`
   - Value: `${{Postgres.DATABASE_URL}}` (or `${{PostgreSQL.DATABASE_URL}}`)
5. *(Optional but recommended)* Set an API secret to protect backend calls:
   - Variable Name: `LYNKBAY_API_SECRET`
   - Value: `<choose-a-strong-random-key>` *(e.g. `lucky-cashew-sec-2026`)*

### Step 5: Expose Public Domain & Port
1. Click on your **lucky_cashew** service.
2. Go to the **"Settings"** tab.
3. Scroll down to **"Networking"** ➔ **"Public Networking"**.
4. Click **"Generate Domain"** (e.g., `lucky-cashew-production.up.railway.app`).
5. Railway assigns port routing automatically (`PORT` environment variable is already handled by `server.cjs`).

### Step 6: Verify Deployment
1. Open your generated public URL in your browser (e.g., `https://lucky-cashew-production.up.railway.app`).
2. Verify the health status endpoint by visiting:
   ```
   https://<your-domain>.up.railway.app/api/health
   ```
   You should receive:
   ```json
   {
     "ok": true,
     "storage": "postgres",
     "timestamp": "2026-10-28T..."
   }
   ```
3. When `storage: "postgres"` is returned, your app is fully connected and persisting all transactions to PostgreSQL!

---

## Inspecting Database & Running SQL Queries

Railway includes a built-in table viewer and query tool:
1. In the Railway dashboard, click on the **PostgreSQL** card.
2. Click the **"Data"** tab.
3. You will see the auto-migrated tables:
   - `lynkbay_state`: Master atomic snapshot with incremental revision tracking.
   - `lynkbay_products`: Product catalog, pricing, and current stock.
   - `lynkbay_customers`: Customer directory, contacts, and addresses.
   - `lynkbay_bills`: Bill records, payment status, totals, and balances.
   - `lynkbay_expenses`: Logged business expenses.
   - `lynkbay_config`: Persistent configuration and API secret credentials.

### Example SQL Queries:

```sql
-- View all products and current stock
SELECT name, stock, billing_price, invoice_price FROM lynkbay_products ORDER BY name;

-- View outstanding bills
SELECT bill_number, customer_name, total, paid, balance, status 
FROM lynkbay_bills 
WHERE balance > 0 
ORDER BY bill_date DESC;

-- Total sales summary
SELECT 
  count(*) AS total_bills,
  sum(total) AS gross_sales,
  sum(paid) AS total_collected,
  sum(balance) AS total_receivable
FROM lynkbay_bills;
```

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | **Yes (for Postgres)** | Automatically injected by Railway when adding PostgreSQL. |
| `PORT` | Auto | Injected by Railway (defaults to 3000 locally). |
| `LYNKBAY_API_SECRET` | Optional | Shared API authentication secret. If omitted, automatically generated and saved in `lynkbay_config` table. |
| `LYNKBAY_ALLOWED_ORIGINS` | Optional | Comma-separated CORS allowed origins (e.g. `https://mycustomdomain.com`). |

---

## Local Development vs. Cloud

- **Local:** Run `npm start` without setting `DATABASE_URL`. The app uses `data/lynkbay-db.json` locally.
- **Local with Docker Postgres:** Run `set DATABASE_URL=postgresql://postgres:password@localhost:5432/mydb && npm start`.
- **Railway Cloud:** Connect Railway PostgreSQL to the service; no code or config changes needed!
