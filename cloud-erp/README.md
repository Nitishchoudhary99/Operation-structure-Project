# SmartTrader Cloud ERP

A complete, multi-business cloud ERP for Indian traders and distributors. It runs entirely on
**Cloudflare** (Workers + D1 database + static assets) and deploys straight from **GitHub**.
There are no servers to manage, it is fast all over India thanks to Cloudflare's edge, and it runs within Cloudflare's free tier until you have real traffic.

Market research and pricing advice: see [docs/COMPETITORS.md](docs/COMPETITORS.md).

## What's inside

| Module | What it does |
|---|---|
| **Procurement** | Purchase Order → Goods Receipt (GRN, partial deliveries) → Purchase Bill → Payment. Debit notes (purchase returns). Goods-received-not-billed clearing and purchase price variance. |
| **Sales** | Quotation → Sales Order → Delivery Note → GST Invoice → Receipt. Direct invoices with cash/UPI received on the spot. Credit notes (sales returns) that settle the original invoice. |
| **Inventory / SCM** | Items and services, HSN, units, any number of godowns, stock transfers, adjustments (damage, physical count), opening stock, moving-average cost, reorder levels with suggested order quantities, full item movement history. Stock can never go negative. |
| **GST** | CGST + SGST or IGST chosen automatically from the two states. Per-line tax split with no lost paisa, invoice totals rounded to the rupee and posted to a round-off account. GST summary by rate and B2B/B2C (outward, inward, net payable). Sales and purchase registers. |
| **Finance** | True double-entry ledger. Every document posts balanced journals automatically. Chart of accounts, expenses with input GST, journal vouchers, party opening balances, day book, account and party ledgers, Trial Balance, Profit & Loss, Balance Sheet, receivable/payable ageing. |
| **Khata Book** | Khatabook-style "you gave / you got" credit book per contact, with running balance and one-tap **WhatsApp / SMS reminders that include a UPI payment link**. Works well on phones. |
| **Payments** | Receipts and payments into cash, bank or UPI accounts. Applied to the oldest open invoices or bills first, or to a chosen document. Voiding reverses everything. |
| **Control** | Multi-user with roles (owner, admin, accountant, store, sales), audit trail, cancel-with-reversal (never silent edits), one database holding many businesses with strict separation. |
| **Gate entry & gate pass** | Inward gate register (vehicle, driver, challan, packages, weight, against a PO), Goods Receipt made from the gate entry, reject at gate; outward gate pass against a delivery note/invoice with exit time. |
| **Credit / debit notes** | Return notes (goods come back) and value notes for rate difference, discount or claims (no goods), made from the invoice/bill line by line or standalone, settled against the original, in GST summary, e-invoice (CRN) and Tally. |
| **Warehouse tools** | Bin/rack location per item, printable pick list sorted by bin, stock count (cycle count) that posts all differences at once, one-click reorder PO for items below reorder level, pending orders/receipts/gate report. |
| **Collections** | Payment Reminders screen: every customer with invoice or khata dues, one-tap WhatsApp/SMS reminder listing the bills, total and UPI. |
| **POS & barcodes** | Quick-bill screen for counters: USB/Bluetooth scanner or phone camera, cash / UPI (with a QR for the exact amount) / card / credit, change due, 80 mm thermal receipt, F9 to finish. Barcode labels (Code 128) printed from any item. |
| **GST portals** | E-invoice JSON (NIC schema 1.1) for B2B invoices and credit notes, and e-way bill bulk-upload JSON with transport details. Save the IRN, Ack and e-way bill numbers back on the document, and they print on the invoice. |
| **Tally export** | One XML file with ledgers and every voucher for a period, which imports into Tally Prime / ERP 9 with a matching trial balance. |
| **Plans (SaaS)** | Free / Starter ₹999 / Growth ₹2,499 / Business ₹4,499 a year, with invoice, user and godown limits and feature gates. 14-day Growth trial on signup. One-time activation codes and an admin panel (`#/admin`) to manage every business. |
| **Installable app (PWA)** | "Install app" on Android/desktop, "Add to Home Screen" on iPhone. Opens full-screen with shortcuts to POS, New invoice and Khata. The app shell opens offline; business data always comes live. |
| **Dashboard** | Sales, profit, receivables, payables, stock value, GST due, 12-month chart, overdue invoices, low stock. |
| **Documents** | Printable GST tax invoice with the amount in words, UPI ID and signature block (Print → Save as PDF). WhatsApp invoice sharing. CSV export of every list and report. |

### Vaada Pakka (payment promises) and Kal ka Cash
- Every khata link (`/k/`) and invoice link (`/i/`) asks the customer **"Kab tak denge?"**: pick a pay date (full or part) or, on Starter and above, an instalment plan the shop allows. The shop can also write down a promise made on the phone.
- Each instalment is marked **kept** or **broken** from the receipts (invoice receipts, or sent khata "got" entries) whenever a screen is opened. Voids and back-dated receipts correct it within 30 days. No interest or late fee is ever charged.
- `#/vaade` lists today's, upcoming and broken promises; the dashboard shows **Aaj ke Vaade**; reminders change their tone with the promise.
- **Udhaar check** at billing (Starter and above): old dues, credit limit and broken promises give a warning, or a stop that only owner/admin can override (audited).
- **Kal ka Cash** (`#/cash`, Growth and above): a deterministic 4-week cash view and whom to remind today.
- Privacy: payment promises a customer makes on a shop's link are visible only to that shop. Only the date, the amount and an optional name are stored (no IP or device id). It is never shared across businesses and never called a score.

### How each document hits the books

| Document | Stock | Ledger |
|---|---|---|
| GRN | + stock at PO rate | Dr Inventory / Cr Goods Received Not Billed |
| Purchase Bill (from GRN) | — | Dr GRNI (+ price variance), Dr GST Input / Cr Creditors |
| Purchase Bill (direct) | + stock | Dr Inventory, Dr GST Input / Cr Creditors |
| Purchase Return | − stock at billed rate | Dr Creditors / Cr Inventory, Cr GST Input |
| Delivery Note | − stock at average cost | Dr Cost of Goods Sold / Cr Inventory |
| Sales Invoice | − stock (unless delivered by a DN) | Dr Debtors / Cr Sales, Cr GST Output (+ COGS) |
| Sales Return | + stock at original cost | Dr Sales, Dr GST Output / Cr Debtors (+ COGS reversal) |
| Receipt / Payment | — | Dr Cash/Bank/UPI / Cr Debtors, and the reverse for payments |

Each business action is written in **one D1 batch, which is a single transaction**: the document, its lines,
the stock movements and the journal are either all saved or none are. Money is stored as whole paise,
so there are no floating-point errors. The test suite checks after a full business cycle that the Trial
Balance and Balance Sheet balance and that the stock valuation equals the inventory ledger.

## Deploy (about 10 minutes)

You need a free Cloudflare account and this GitHub repository.

### Option A: Cloudflare dashboard (no command line)

1. In Cloudflare, open **Storage & Databases → D1 → Create**, name it `smarttrader-erp`, and copy its **Database ID**.
2. In GitHub, edit `cloud-erp/wrangler.toml`: replace `database_id = "000…"` with that ID and commit.
   The ID is not a secret.
3. In Cloudflare, open **Workers & Pages → Create → Import a repository** and pick this repository. Then:
   - **Root directory:** `cloud-erp`
   - **Build command:** *(leave empty)*
   - **Deploy command:** `npx wrangler deploy`
4. Deploy. Open the `*.workers.dev` URL and click **Create a free account**. The tables are created
   automatically on the first visit.
5. Recommended: in the worker's **Settings → Variables and Secrets**, add a secret `SESSION_SECRET`
   (any long random text). Without it, a secret is generated and kept in the database.
6. Optional: under **Settings → Domains & Routes**, add your own domain, e.g. `erp.docbrisk.com`.

Every push to the branch now redeploys automatically.

### Option B: command line

```bash
cd cloud-erp
npm install
npx wrangler login
npx wrangler d1 create smarttrader-erp          # paste the printed database_id into wrangler.toml
npx wrangler secret put SESSION_SECRET          # any long random string
npx wrangler deploy
```

### Option C: GitHub Actions

`.github/workflows/cloud-erp.yml` runs the end-to-end test on every push. On `main` it also deploys,
once you add the repository secrets `CLOUDFLARE_API_TOKEN` (a token from the "Edit Cloudflare Workers"
template with D1 edit permission) and `CLOUDFLARE_ACCOUNT_ID`.

## Selling it: plans, online payment and the admin panel

Customers buy a plan in **Plan & Billing**: they tap *Pay by UPI*, pay the exact amount shown (for example ₹5,309.07) from
GPay, PhonePe, Paytm or any UPI app, and the plan switches on by itself. Phones get app buttons; computers get a QR made in
the browser. Payments are confirmed by **DocBrisk Pay**, our own automatic UPI hub in the `docbrisk-api` worker (it reads the
bank's signed credit e-mails). The browser talks only to this worker; this worker talks to the hub with signed requests, and
the plan is switched on only by the hub's signed callback (or a signed status check if the callback is late).

**One-time setup (DocBrisk Pay)**, after the hub itself is live in `docbrisk-api`:

1. Make one long random text (e.g. `openssl rand -hex 32`). On the `docbrisk-api` worker set it as the secret
   `PAYHUB_SECRET` (or `PAYHUB_SECRET_ERP` to give the ERP its own).
2. On this worker (`operation-structure-project`), **Settings → Variables and Secrets**:
   - secret `PAYHUB_SECRET` = the same text;
   - variable `PAYHUB_URL` = the address of the `docbrisk-api` worker (its custom domain, e.g. `https://api.docbrisk.com`).
3. Both workers are on the same Cloudflare account, so a service binding is faster and private, and it is needed if the hub
   only has a `workers.dev` address (Cloudflare blocks worker-to-worker calls to `workers.dev` on one account). Uncomment the
   `PAYHUB_API` lines in `wrangler.toml` here, and the `ERP` service lines in `docbrisk-api/wrangler.toml` for the callbacks.
4. Deploy both. **Admin** (below) then shows "Online payments: on (DocBrisk Pay, automatic UPI)". Buy the cheapest plan once
   with your own phone to see it switch on.

The hub sends its callbacks to the fixed address `https://erp.docbrisk.com/api/billing/upi-callback`; nothing to set for it.
If the hub is busy or not ready, the page offers card / netbanking when Razorpay is set up, or asks to try again in a minute.

**Optional: card and netbanking (Razorpay).** Shown as a second button only when its keys are set. It is the same setup as
docbrisk.com's Pro keys. Every ERP payment carries `notes.product = smarttrader-erp`, so the two sites never take each
other's payments. Choose ONE of the two ways:

| Way | Secrets | Razorpay dashboard |
|---|---|---|
| Webhook (no Key Secret needed) | `RAZORPAY_WEBHOOK_SECRET` = any long random text | Settings → Webhooks → **Add**: URL `https://erp.docbrisk.com/api/billing/webhook`, event **payment.captured**, secret = the same text |
| Order + signature (instant) | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | nothing more (adding the webhook too is a safety net if a buyer closes the browser early) |

Without DocBrisk Pay, Razorpay (if set) is the main way to pay.

Optional: `ADMIN_KEY` (16+ characters) opens `https://erp.docbrisk.com/#/admin` to see every business and payment and to set a
plan by hand (1200 months = lifetime, e.g. for your own business). `SUPPORT_WHATSAPP` (e.g. 919876543210) shows a WhatsApp
button while online payment is not switched on.

Forgot password: set the secret `RESEND_API_KEY` (the same Resend key docbrisk.com uses; optional `MAIL_FROM`, default `SmartTrader ERP <no-reply@docbrisk.com>`) and the sign-in page e-mails a one-time reset link valid for 30 minutes. Without it, owners can still set a staff member's password in Settings → Users → Set password.

Prices are in `src/saas.js` (`PLANS`, per year before GST); the buyer pays the price plus 18% GST.

## Run locally

```bash
cd cloud-erp
npm install
npx wrangler dev            # http://localhost:8787, with a local D1 database in .wrangler/
node test/run.mjs           # in another terminal: 120-check end-to-end business test
                            # (put ADMIN_KEY=local-test-admin-key-0001 and RAZORPAY_WEBHOOK_SECRET=local-test-webhook-secret-0001 in cloud-erp/.dev.vars)
node test/perf.mjs          # D1 calls and rows per screen stay within budget (QUERY_COUNT=1 in .dev.vars)
```

## Project layout

```
cloud-erp/
  wrangler.toml        Worker + D1 + static assets config (no secrets)
  src/worker.js        HTTP API: auth, masters, documents, payments, khata, reports
  src/engine.js        posting engine: documents → stock + double-entry journals (atomic batches)
  src/reports.js       trial balance, P&L, balance sheet, GST, ageing, stock, ledgers, dashboard
  src/schema.js        tables + default chart of accounts; auto-migrates on first request
  src/auth.js          PBKDF2 passwords, signed session cookies, roles, rate limits
  src/lib.js           validation, GST maths, numbering, router
  src/gst.js           state codes, units, e-invoice and e-way bill JSON
  src/tally.js         Tally XML export
  src/saas.js          plans, limits, activation codes
  public/              the web app (plain HTML/CSS/JS, no build step), PWA manifest + service worker
  test/run.mjs         end-to-end test against a running worker
  test/perf.mjs        speed budgets per screen, next to a second, busy business
  docs/COMPETITORS.md  market and competitor research
```

## Security notes

- Passwords are hashed with PBKDF2-SHA256 and a per-user salt. Sessions are HMAC-signed, HttpOnly,
  SameSite cookies, and changing a password logs out other sessions.
- Every write needs a custom request header and a same-origin check, which protects against CSRF.
- Login and signup are rate-limited.
- Every query is scoped to the signed-in user's business, and roles are checked on the server for every write.
- Never put secrets in `wrangler.toml`; this repository is public. Use `wrangler secret put` or the dashboard.

## Not built yet (next steps)

- Direct IRN / e-way bill generation through an API. This needs a GSP account; today the JSON files
  are uploaded on the government portals.
- Batch/expiry and serial numbers, manufacturing (bill of
  materials), and approval workflows.
