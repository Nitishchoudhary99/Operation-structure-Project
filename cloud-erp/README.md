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
| **Control** | Multi-user with roles (owner, admin, accountant, store, sales, and custom roles with see / change switches per area, a gate-only guard among them), **every role made to measure** (rights, limits such as no cancelling / no udhaar / a discount cap / today's date only, and its menu), **each user's own menu** (a job, or screens ticked one by one, and the screen the app opens on), audit trail, cancel-with-reversal (never silent edits), one database holding many businesses with strict separation. |
| **Gate entry & gate pass** | Inward gate register (vehicle, driver, challan, packages, weight, against a PO), filled from the **QR on the supplier's e-invoice** (supplier by GSTIN, bill number, date, value, IRN; one entry per IRN) and matched to the purchase bill; goods received against it on the Receive Goods screen; reject at gate; outward gate pass against a delivery note/invoice with exit time. |
| **Credit / debit notes** | Return notes (goods come back) and value notes for rate difference, discount or claims (no goods), made from the invoice/bill line by line or standalone, settled against the original, in GST summary, e-invoice (CRN) and Tally. |
| **Warehouse tools** | Bin/rack location per item, printable pick list sorted by bin, stock count (cycle count) that posts all differences at once, one-click reorder PO for items below reorder level, pending orders/receipts/gate report. |
| **Collections** | Payment Reminders screen: every customer with invoice or khata dues, one-tap WhatsApp/SMS reminder listing the bills, total and UPI. |
| **POS & barcodes** | Quick-bill screen for counters: USB/Bluetooth scanner or phone camera, cash / UPI (with a QR for the exact amount) / card / credit, change due, 80 mm thermal receipt, F9 to finish. Barcode labels (Code 128) printed from any item. |
| **GST portals** | E-invoice JSON (NIC schema 1.1) for B2B invoices and credit notes, and e-way bill bulk-upload JSON with transport details. Save the IRN, Ack and e-way bill numbers back on the document, and they print on the invoice. |
| **Tally export** | One XML file with ledgers and every voucher for a period, which imports into Tally Prime / ERP 9 with a matching trial balance. |
| **Plans (SaaS)** | Free / Starter ₹999 / Growth ₹2,499 / Business ₹4,499 a year, with invoice, user and godown limits and feature gates. 14-day Growth trial on signup. One-time activation codes and an admin panel (`#/admin`) to manage every business. |
| **Installable app (PWA)** | "Install app" on Android/desktop, "Add to Home Screen" on iPhone. Opens full-screen with shortcuts to POS, New invoice and Khata. The app shell opens offline; business data always comes live. |
| **Dashboard** | **Aaj ke kaam (Today)**: one card with everything that needs doing (overdue bills, promises due, POs to approve, bills to pay, expiring batches, low stock, orders to deliver or receive, stock not put away), one tap each. Then sales, profit, receivables, payables, stock value, GST due, 12-month chart, overdue invoices, low stock. |
| **Documents** | Printable GST tax invoice with the amount in words, UPI ID and signature block (Print → Save as PDF). WhatsApp invoice sharing. CSV export of every list and report. |

### Vaada Pakka (payment promises) and Kal ka Cash
- Every khata link (`/k/`) and invoice link (`/i/`) asks the customer **"Kab tak denge?"**: pick a pay date (full or part) or, on Starter and above, an instalment plan the shop allows. The shop can also write down a promise made on the phone.
- Each instalment is marked **kept** or **broken** from the receipts (invoice receipts, or sent khata "got" entries) whenever a screen is opened. Voids and back-dated receipts correct it within 30 days. No interest or late fee is ever charged.
- `#/vaade` lists today's, upcoming and broken promises; the dashboard shows **Aaj ke Vaade**; reminders change their tone with the promise.
- **Udhaar check** at billing (Starter and above): old dues, credit limit and broken promises give a warning, or a stop that only owner/admin can override (audited).
- **Kal ka Cash** (`#/cash`, Growth and above): a deterministic 4-week cash view and whom to remind today.
- Privacy: payment promises a customer makes on a shop's link are visible only to that shop. Only the date, the amount and an optional name are stored (no IP or device id). It is never shared across businesses and never called a score.

### Vasooli (collections), without a paid WhatsApp API
- **Every message in the customer's language.** Before a bill, reminder, khata entry, receipt or balance statement goes, the shop picks English, हिंदी or Hinglish. The choice is remembered per contact (`parties.lang`); the business default is in Settings (`orgs.msg_lang`). The link carries it (`?l=en` / `?l=hi`), so the customer's page and WhatsApp's link preview poster (`public/og-*-{en,hi}.png`, made by `tools/gen-og.mjs`) are in the same language.
- **Bills go as a real PDF.** The invoice is laid out in a hidden 794 px frame (desktop layout even on a phone), turned into an image by `public/vendor/html-to-image.js`, cut into A4 pages between table rows and wrapped in a small PDF. On a phone the share sheet sends the PDF and the message to WhatsApp together; elsewhere the PDF is saved and WhatsApp opens with the message. The customer's `/i/` page downloads the same PDF.
- **`#/reminders` (Vasooli):** who to remind today on a schedule (3 days before the due date, on it, then 7 / 15 / 30 / 45 days late, weekly after that). The wording gets firmer with age; **VIP** customers only get gentle wording; a customer's own promise date pauses them. Every reminder sent is logged (`reminder_log`) as evidence.
- **Monthly balance statement:** the customer gets a private `/c/<token>` link with every open bill and answers **Correct** or **Something is wrong** (which bill, what). The answer is kept with its time (`confirmations`).
- **Receipts on WhatsApp** at once, naming who collected the money; the built-in *sales* role may record customer receipts. The owner sees **who collected what** (7 days, cash, month) and the **week** (received, promised, 45+ days late, days to get paid), and can share it.
- **Recovery file** (`#/recovery/<party>`, finance roles): MSMED Act interest (3 × RBI Bank Rate, monthly rests, from the agreed due date or the 46th day) for a business with a Udyam number, the evidence (statements, promises, reminders, receipts), a demand-notice draft and what MSME Samadhaan asks for. The notice is a draft for an advocate to check.

### Stock: bins, batches with expiry, stock ageing
- **Bins & Racks** (`#/bins`): make racks and shelves once (A-01-1 = rack A, shelf 1, level 1), print bin labels with barcodes, put away stock that is in no bin yet, and move stock between bins. Each item has a default bin; goods coming in go there, goods going out are taken from what is not put away first, then from the bins. The pick list shows the bins (with quantities) and the batch to pick.
- **Batch & Expiry** (`#/expiry`): an item can track batches. Purchase bills, GRNs and opening stock take a batch number and expiry month; sales take the chosen batch, or the one that expires first (FEFO). The batch and expiry print on the bill; returns go back to their batch; cancelling a bill puts goods back into the very same batches; transfers take the batch along. The expiry screen lists expired and soon-expiring stock with its value.
- **Stock Ageing** (`#/stock-ageing`): the stock on hand by age (0-30, 31-60, 61-90, 91-180, 181-365, 366+ days, first in first out), dead and slow-moving stock from the last sale, and an ABC class from the last 12 months of sales.
- **Serial / IMEI** (`#/serials`): an item can track serial numbers, with a warranty in months. Serials are scanned or typed on the purchase bill, opening stock or production (one per line; the quantity follows the count). On a sale the shop taps the IMEIs in stock, or the oldest goes. They print on the bill (S/N). Scanning a serial shows where it is, who bought it on which bill, and whether it is still under warranty. Returns and cancellations bring it back; a cancelled purchase makes it void; a serial can never be in stock twice.
- Bins, batches and serials are detail under each godown's quantity (`stock`), which stays the only figure the books and stock value use (`src/lots.js`).

### Recurring bills (rent, AMC, tuition, maintenance, monthly supply)
- **Make it once, choose Repeat** (`#/recurring`, `src/recurring.js`): the invoice / bill editor has *Repeat this invoice: every week / month / 3 months / year*; an invoice's More menu does the same. The schedule keeps **its own customer and lines**, so they can be changed (Edit) without touching the invoice it came from, and **+ Customers** puts the same bill on a whole class, building or AMC list at once (each gets their own schedule).
- **Each new bill says what it is for** ("For November 2026 (monthly bill)") and is dated its day; **Skip next** leaves out one bill (a closed month, a free month); **a yearly rise** (e.g. 5% rent escalation) is applied from its day and stays; an end date stops it by itself.
- **The customer gets it**: with Automatic WhatsApp on, every new invoice goes to the customer on WhatsApp by itself with its bill link and UPI (free text inside the 24-hour window, else the approved template: `WHATSAPP_BILL_TEMPLATE`, or the reminder template, same four parameters). Otherwise it waits under **To send** (and on Today) for one tap. Purchase bills are never sent.
- The page shows the monthly income from repeat bills, what the next round brings in, and the next three dates of each schedule; phones get cards.

### Bank reconciliation, fixed assets, TDS
- **Bank Reconciliation** (`#/bankrec`, `src/bankrec.js`): pick the statement from net banking (Excel or CSV; SBI, HDFC, ICICI, Axis, Kotak column names are recognised, the bank's heading rows skipped, Excel date numbers and dd/mm/yy dates read). Each line is matched to an entry in the books of that account by amount and direction within a week, a cheque / UTR number or the party's name winning a tie; **Confirm** marks them cleared with the bank's date (`bank_clear`), so they never come up again. Lines the books do not have are added in one tap (expense with the bank charges head, receipt, payment, other income) and match at once. The **Bank Reconciliation Statement** on the statement's last day: books, less deposits not yet credited, plus cheques not yet presented, against the statement's closing balance.
- **Fixed Assets** (`#/assets`, `src/assets.js`): an asset bought from cash / bank, owed to a supplier, or already owned (with the depreciation charged before). Depreciation per year in one tap, booked on the year's last day (Depreciation against Accumulated Depreciation), once per year, with **Undo**: **WDV** at the income-tax rate on what is left, half the rate if used under 180 days in its first year, none in the year of sale; **SLM** (Companies Act) (cost − residual) / life, by days. **Sell / scrap** takes it out at book value, the gain to other income or the loss to *Loss on Sale of Assets*. The accounts are made on first use.
- **TDS** (`#/tds`, `src/tds.js`): **Pay supplier → More details → TDS section** (194C, 194J, 194I, 194H, 194Q, 194A with their usual rates, changeable): the bill is settled in full, the supplier gets the rest, the TDS goes to *TDS Payable*. A receipt can carry the TDS a customer deducted (*TDS Receivable*, claimed in the ITR). The TDS screen lists deductions by section with the supplier's PAN (from the GSTIN) for the 26Q return, records challans, and Today reminds while TDS is owed (due by the 7th; March by 30 April).

### Manufacturing, approvals, online orders
- **Production (BOM)** (`#/production`, `src/mfg.js`): an item can have a recipe (which parts, how much, for how many made). The item page shows the cost of parts, the margin and how many can be made from stock now. **Make** takes the parts out (FEFO batches, bins, serials as any goods out) and brings the finished item in at their cost, so the stock value does not change and no journal is needed. A run can be cancelled while its goods are unused; a run may also record what was actually used.
- **Purchase order approval**: Settings → Approvals sets an amount. A purchase order above it made by staff waits (`pending`) until the owner or an admin approves it; nothing can be received or billed against it before that. The owner's and admins' own orders go straight through. Waiting orders show on the Today card.
- **Online orders** (`#/channels`, `src/channels.js`): pick the order report from Amazon, Flipkart, Meesho or any store (CSV, TXT or Excel; Excel is read in the browser). Columns are found by their usual names, items by SKU, barcode or name; cancelled and returned rows are left out. Every order becomes a GST invoice billed to one party per channel and buyer state ("Amazon (Maharashtra)", due in 7 days), so IGST or CGST + SGST is right, with the price including GST split back. An order id is billed once only. **Stock file**: SKU and quantity in hand, for the marketplace's inventory upload.
- **Amazon's tax report (MTR B2C / B2B)** is read as it comes (Transaction Type, Ship To State, Invoice Amount, Amazon's own invoice number, which goes on the bill). **Refunds, returns and cancellations** of orders billed here become **sales returns against their invoice** (stock back in, GST reversed), each credit note once only (`channel_returns`); a free replacement is no sale.
- **Amazon payouts** (Online orders → *Amazon payouts*, finance users): pick the settlement report (Payments → All Statements → flat file V2). Each order shows what the customer paid, Amazon's fees, GST TCS and TDS 194-O and what you really got, matched to its invoice; orders paid but never billed here are flagged. **Post this payout** (once per settlement, `mkt_settlements`) makes one receipt per Amazon party through *Marketplace Payouts Receivable* that marks those invoices paid, and one journal: the bank gets the deposit, fees and ads go to *Marketplace Fees & Commission*, TCS to *GST TCS Receivable* (claim in GSTR-3B), TDS to *TDS Receivable* (claim in the ITR), refunds taken back come off the party. These four accounts are made the first time they are needed.

### Staff, offline, bill scanning, automatic reminders, web store orders, warehouse picking
- **Staff & Salary** (`#/staff`, `src/payroll.js`, finance roles only): staff on a monthly salary or a daily wage. Today's attendance is one tap per person (P, A, ½, L, O), or a month calendar per person. Monthly staff earn salary × payable days ÷ days in the month (a day nobody marked counts as present, so most shops mark only absences); daily staff earn the wage for days marked present. Overtime hours at a rate per hour. **Advances** (Dr Staff Advances / Cr cash) are cut from a salary in part or in full; **Pay salary** posts Dr Salaries & Wages / Cr Staff Advances / Cr cash, once per person per month, and opens a **payslip** to print or send on WhatsApp. Cancelling reverses the books. The Today card says when today's attendance or last month's salaries are not done.
- **Works without internet**: the business, customers, items, godowns and accounts are kept on the device the last time it was online (IndexedDB). With no internet, new invoices, POS bills, purchase bills, receipts and expenses are saved in an **Outbox** (`#/outbox`, a badge in the top bar) and sent by themselves when the device is back online. Every such write carries an `Idempotency-Key`; the server keeps the first answer for a week (`idem_keys`), so a bill sent twice (a lost answer, a second sync) is saved once. A bill gets its number, and its stock is checked, when it reaches the server. Signing out clears the device copy.
- **Scan a supplier's bill** (purchase bill / GRN / PO editor → *Scan supplier bill*, `public/billocr.js`): read **on the phone itself**, free and private (the picture never leaves the device, no API key). A PDF with text (most e-invoices) is read exactly with pdf.js; a photo or a scanned PDF page is straightened, evened out (shadows), cleared of table rules and read with Tesseract OCR (both self-hosted in `public/vendor/`; about 7 MB on first use, then cached for offline use). Rules for Indian GST bills then find the supplier's GSTIN (OCR slips corrected and the GSTIN check digit verified), bill number, date, the item rows (quantity × rate = amount), GST rates and the total. The supplier is matched by GSTIN or name and each row to an item (name, SKU, HSN, and letter-pair likeness for OCR-mangled names); a review sheet shows the guesses and offers **+ New item / + New supplier**; **Fill the bill** opens the purchase bill filled in, with a warning when the rows do not add up to the bill's total. Nothing is saved until the user saves.
- **Automatic WhatsApp reminders** (Settings, Growth and Business plans, `src/autowa.js`): every day between 10 am and 1 pm the customers that the Vasooli schedule says are due get the approved reminder template from SmartTrader's WhatsApp Business number, with their name, the business, the amount due and their bill link with UPI. Logged in `reminder_log` (via `auto`), so nobody gets two a day and the schedule moves on. **Send today's now** runs it at once. Needs the WhatsApp secrets (below). A customer who wrote to the number in the last 24 hours gets the reminder as plain text, which costs nothing; one who answered **STOP** gets none.
- **WhatsApp bot** (Settings → *WhatsApp bot*, `src/wabot.js`, on WhatsApp's official Cloud API): customers write to SmartTrader's WhatsApp number and are answered at once, in Hinglish, Hindi or English: **1 / hisab** (each open bill with its own bill + UPI link, the khata, the total), **2 / bill** (the last bills), **3 / pay** (the UPI link), **4 / vaada** (pick a pay date), **5 / shop** (the message goes to the shop), **STOP / START** (automatic reminders off / on). The shop is found by the code in its link or QR (*HISAB #A1B2C3*, printable poster at `#/wa-poster`), else the shop this number was last talking to, else the shop that has this mobile on a customer (two shops: the customer picks). Only Indian (+91) WhatsApp numbers are matched to customers, so a foreign number with the same last 10 digits sees nothing. What the bot cannot answer waits in the **WhatsApp Inbox** (`#/wa-inbox`, a Today card) and the shop replies there under its own name; WhatsApp allows free text only within 24 hours of the customer's last message, so the reply box shows only then. Meta's webhook is checked with the app secret (`X-Hub-Signature-256`), a message Meta sends twice is answered once, and a number that floods gets no answers for the hour. Chats are kept 6 months.
- **Live web store orders** (Online orders → *Connect a store*, `src/hooks.js`): Shopify (paste the signing key from Settings → Notifications → Webhooks, event *Order payment*), WooCommerce (a secret is made here, topic *Order updated*), or any website (HMAC-SHA256 header `X-Signature`). Each store has a private address; a paid order is checked against the secret and becomes a GST invoice at once (party per store and buyer state, items by SKU, never twice). An order that cannot be billed (unknown SKU) is answered 200 and the reason shows on the connection.
- **Guided put-away** (`#/putaway`): each item waiting in no bin with the bin it should go to (its default bin, a bin that already holds it, else an empty bin that is nobody's default); scan the bin label and the row is done. **Wave pick list** (`#/wave`, advanced mode): choose many open sales orders / delivery notes of one godown and get one list walked bin by bin, FEFO batches, and how much goes to each order.

### Bill first, goods later, and receiving by scan
- **A purchase bill before its goods**: tick *Goods not received yet (on the way)* on the bill. It owes the supplier at once, but the goods sit in **Goods in Transit** (asset 1210), not in stock. The supplier's own bill number is kept on the bill (*Supplier bill no.*, `docs.party_ref`) and the same number of the same supplier cannot be entered twice.
- **Receive Goods** (`#/receive`, `src/receive.js`, shown in Simple mode too): what is expected (trucks at the gate, bills waiting for their goods, open purchase orders) and **goods without a bill or order**. Pick one and scan each piece like the POS, with a USB scanner or the phone camera: the count goes up, a beep says right or wrong, an item not on the bill or more than billed is refused. A serial-tracked item takes its IMEIs as the next scans. A code never seen before is **taught once** (which item, how many pieces in the pack: a carton code counts 12 at once) and works from then on everywhere, POS included (`item_codes`). **Put into bins**: each item goes to its default bin, a bin that already holds it, the first empty bin nobody calls home, or a **new bin made on the spot** next to the last one (A-01 → A-02); an item without a default bin gets the one it was given. Saving makes one GRN (from the bill: out of Goods in Transit at the bill's value, the last part taking the paise left; from a PO: at the PO rate, as before), closes the gate entry and shows what went where, with labels to print.
- **Shortage**: goods that will never come are closed with **Close short** on the bill, a debit note at the bill's price (Dr Creditors / Cr Goods in Transit, Cr GST Input). A return from such a bill is only of goods that came. Cancelling a receipt or a shortage note puts the goods back on the waiting list.
- **Damaged or lost on the way** (bill → More → *Write off*, or the *Damaged / missing* count on the Receive screen; `write_offs`, src/receive.js): the supplier is still owed the bill, and the pieces become **our loss** (Transit Loss & Damage, 5110) or a **claim on the transporter / insurer** (Transit & Insurance Claims, 1410; settle it with a journal when the money comes). The GST paid on them is reversed (no input credit on goods lost or destroyed, CGST Act s.17(5)(h)): Dr loss or claim (value + GST) / Cr Goods in Transit, Cr GST Input. The GST summary shows the reversal (GSTR-3B 4(B)(2)) and adds it to the GST payable. A write-off can be cancelled (the goods are to come again). On the Receive screen the broken pieces can also go to the supplier as a shortage note.
- **Transit Claims** (`#/claims`, `src/claims.js`): every claim on a transporter or insurer, followed up to the end. Whom it is against and their LR / claim number, the next follow-up date and a note; **Money received** (in parts: Dr cash / bank / UPI, Cr Claims) and **Close the rest as loss** when they reject it or pay less (Dr Transit Loss & Damage, Cr Claims). Open, partly paid, settled or closed as loss at a glance, with what is still to get and how old each claim is; each entry can be cancelled. The Today card lists claims not paid yet whose follow-up date has come. Seeing claims and keeping their details needs Purchase or Money rights; recording money needs Money.
- **Each user's own menu** (Settings → Users → Menu): a job (owner, billing counter, godown / store keeper, gate guard, accountant, salesman), or screens ticked one by one, and the screen the app opens on. By default the role decides (store → godown screens opening on Receive Goods, accountant → money and reports). A **gate guard** is a custom role with only *Gate register*: the gate screens, nothing else to see or change. Only the menu follows the job; what a user may do still comes from the role, checked on the server.
- **Every role made to measure** (Settings → Roles, `role_rules`): the four built-in roles and your own roles alike. **Rights**: what the role may see and change, area by area (a built-in role can be given more, or less; *Back to standard* undoes it). **Limits**, enforced on the server for everyone in the role (never the owner): cannot cancel bills, payments or entries; no udhaar (a sale must be paid in full); cannot see purchase rates, cost or profit; the biggest discount (rate cuts and discounts together, below the item's sale price); how many days back a bill, payment or expense may be dated (0 = today only). **Menu**: a job or ticked screens and the start screen for the whole role (a user's own menu still wins). New roles start from a gate guard, billing counter, godown or field salesman, or a copy of a built-in role. Only the owner changes the admin role.

### Speed
- The worker runs with **Smart Placement** (`[placement] mode = "smart"` in wrangler.toml): Cloudflare moves it next to the D1 database, so the several database calls of a screen stay local and only one round trip crosses to the phone.
- A screen opened again within 20 seconds is drawn from memory at once (`pageCache` in app.js); any save empties it.
- The phone menu slides on its own GPU layer with a dimmed backdrop (no large shadow repainted while scrolling), does not drag the page behind it, and closes the moment an entry is tapped.

### How each document hits the books

| Document | Stock | Ledger |
|---|---|---|
| GRN | + stock at PO rate | Dr Inventory / Cr Goods Received Not Billed |
| Purchase Bill (goods on the way) | — | Dr Goods in Transit, Dr GST Input / Cr Creditors |
| GRN (from such a bill) | + stock at the bill's value | Dr Inventory / Cr Goods in Transit |
| Shortage note (debit note, short) | — | Dr Creditors / Cr Goods in Transit, Cr GST Input |
| Write-off (damaged / lost on the way) | — | Dr Transit Loss (or Claims) / Cr Goods in Transit, Cr GST Input |
| Claim money received / rest closed | — | Dr Cash/Bank/UPI (or Transit Loss) / Cr Transit & Insurance Claims |
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

Forgot password: the sign-in page e-mails a one-time reset link (valid 30 minutes) through docbrisk.com's e-mail account: the ERP asks the docbrisk-api worker over the private `PAYHUB_API` link, signed with `PAYHUB_SECRET` (the same secret as DocBrisk Pay), so no extra key is needed. Setting `RESEND_API_KEY` here instead sends directly. Owners can always set a staff member's password in Settings → Users → Set password.

Prices are in `src/saas.js` (`PLANS`, per year before GST); the buyer pays the price plus 18% GST.

## Run locally

```bash
cd cloud-erp
npm install
npx wrangler dev            # http://localhost:8787, with a local D1 database in .wrangler/
node test/run.mjs           # in another terminal: end-to-end business and security test
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
  src/auth.js          PBKDF2 passwords, signed session cookies, revocation, roles, rate limits, login throttle
  src/headers.js       Content-Security-Policy and the other security headers (public/_headers repeats them)
  src/lib.js           validation, GST maths, numbering, router
  src/gst.js           state codes, units, e-invoice and e-way bill JSON
  src/tally.js         Tally XML export
  src/saas.js          plans, limits, activation codes
  src/vasooli.js       collections: reminder schedule, balance statements, receipts, weekly summary, recovery file
  src/msg.js           every customer message and link preview in English, Hindi and Hinglish
  src/lots.js          bins (racks / shelves), batches with expiry and serial / IMEI numbers under each godown's stock
  src/mfg.js           recipes (bill of materials) and production runs
  src/channels.js      marketplace order import (Amazon, Flipkart, Meesho, any CSV) and the stock file
  src/hooks.js         live orders from web stores (Shopify, WooCommerce, any site) by signed webhook
  src/payroll.js       staff, attendance, advances, salary and payslips
  src/autowa.js        automatic payment reminders on the WhatsApp Cloud API (daily, opt-in)
  src/wabot.js         WhatsApp bot: Meta's webhook, which shop, the answers, the shop's inbox and replies
  src/receive.js       receiving: what is expected (bills in transit, orders, gate), codes learnt while scanning, bins chosen or made
  src/claims.js        transit claims on transporters / insurers: details, money received, the rest closed as a loss
  tools/gen-og.mjs     makes the link-preview posters (public/og-*.png) in the three languages
  tools/gen-seo-pages.py  the public pages for search engines: product, business-type, feature and Hindi pages, the visitors'
                       home page inside public/index.html, public/404.html and both sitemaps (edit the text there, then run it)
  public/              the web app (plain HTML/CSS/JS, no build step), PWA manifest + service worker, csv.js (export), _headers
  public/billocr.js    reads a supplier's bill photo / PDF on the phone (Tesseract OCR and pdf.js in public/vendor/)
  test/run.mjs         end-to-end test against a running worker
  test/perf.mjs        speed budgets per screen, next to a second, busy business
  docs/COMPETITORS.md  market and competitor research
```

## Security notes

- Every page and file is sent with a strict policy: scripts only from this site (and Razorpay Checkout), no inline script or
  `onclick=` (`script-src-attr 'none'`), no framing, HSTS for two years (preload-ready), and JSON that other sites may not embed.
  `/.well-known/security.txt` says where to report a problem; renew its `Expires` date (src/worker.js) before October 2027.
- Unknown addresses answer a real 404 (`public/404.html`); the app itself routes by `#/…`, so it needs no fallback.
- Passwords are hashed with PBKDF2-SHA256 and a per-user salt. Sessions are HMAC-signed, HttpOnly, SameSite=Lax cookies
  (Secure on https) that carry a session id. **Sign out** puts that id on a revoked list, so a copied cookie stops working at once;
  changing a password, a password set by the owner, switching a user off and **Sign out everywhere** (Settings) end every token of that user.
- Every write needs a custom request header and a same-origin check, which protects against CSRF.
- Login is throttled by address, by account + address and by account, counting only failed attempts (a good login writes nothing to the
  database). Signup, reset, forgot, public links and admin have their own limits. Old counters are cleaned up automatically.
- Sign-up: when e-mail works (`RESEND_API_KEY`, or the hub link) the business is created only after the owner opens the e-mailed link,
  and the answer is the same whether or not the address already has an account. Set `SIGNUP_VERIFY=off` to turn this off. If the mail
  cannot be sent, sign-up falls back to creating the account at once rather than locking people out.
- Every query is scoped to the signed-in user's business, and roles are checked on the server for every write. Ids that come from a
  request (party, account, item, godown, document) are looked up inside the business before use, and the journal insert re-checks the
  account and party itself. Reads for custom roles go through one table (`READ_AREAS` in `src/worker.js`): anything not listed is refused.
- Tables keyed by something a user can type (reports, plans, document types, states, units, numbering, custom fields) are read with
  own-key lookups only (`own()` in `src/lib.js`), so names like `constructor` or `__proto__` never resolve.
- No value is ever written into SQL text. Custom-field filters bind the JSON path too, and a custom-field definition whose key is not
  lower-case letters, digits and `_` is dropped whenever settings are read (`fieldsOf` in `src/custom.js`). A restored backup's settings
  go through the same checks as the settings screens (fields, numbering series, print images), so a hand-made file cannot plant SQL or
  printf codes, and every link token in it is replaced.
- Passwords: 8 to 200 characters; common Indian choices (`cricket`, `india`, names of gods and cities ...) with digits or symbols around
  them, all-digit and one-character passwords are refused.
- The request context keeps `env` (the secrets) non-enumerable, so a handler that serialises the context cannot dump it. Error answers
  carry a fixed message only; details go to the Worker log.
- Security headers on the app, the API and the `/k/` and `/i/` pages: a strict Content-Security-Policy (no inline or eval scripts, no
  framing), X-Frame-Options, HSTS, Referrer-Policy, Permissions-Policy, nosniff. They live in `src/headers.js` and in `public/_headers`
  (for the static files); `test/run.mjs` checks the two agree. The app has no inline scripts or handlers; use `data-act` buttons.
- Customer links (`/i/<token>`, `/k/<token>`) are created only by roles that may sell (invoices) or write the khata, and can be turned off
  one by one (invoice page, khata page) or all at once (Settings → Customer links). A cancelled invoice's link stops working.
- CSV exports prefix cells that start with `= + - @` with an apostrophe, so a formula typed into a name cannot run in Excel (`public/csv.js`).
- Plan limits hold when a plan lapses: staff beyond the user limit are paused (the owner and the oldest staff keep working), godowns beyond
  the limit take no new stock, and the monthly invoice cap counts by the time an invoice was created (cancelled ones included) with the check
  inside the insert, so parallel requests cannot slip past it.
- Never put secrets in `wrangler.toml`; this repository is public. Use `wrangler secret put` or the dashboard.

### Tests

```bash
npx wrangler dev --port 8799 --persist-to /tmp/erp-test      # fresh folder each time (signup is limited per address)
node test/run.mjs http://localhost:8799                       # whole suite, including the security checks
# sign-up by e-mailed link: start the worker with a mail sink, then run only those checks
npx wrangler dev --port 8799 --persist-to /tmp/erp-mail --var RESEND_API_KEY:test-key --var RESEND_URL:http://127.0.0.1:8798/send
ERP_MAIL_SINK=8798 node test/run.mjs http://localhost:8799
# Google Drive backup against a stand-in Google: start the worker with these, then run the whole suite with ERP_GDRIVE_MOCK
npx wrangler dev --port 8799 --persist-to /tmp/erp-test --var GDRIVE_CLIENT_ID:test-client --var GDRIVE_CLIENT_SECRET:test-secret \
  --var GDRIVE_TOKEN_URL:http://127.0.0.1:8797/token --var GDRIVE_REVOKE_URL:http://127.0.0.1:8797/revoke --var GDRIVE_API:http://127.0.0.1:8797
ERP_GDRIVE_MOCK=8797 node test/run.mjs http://localhost:8799
# automatic WhatsApp and the WhatsApp bot against a stand-in WhatsApp Cloud API (port 8796 here)
npx wrangler dev --port 8799 --persist-to /tmp/erp-test \
  --var WHATSAPP_TOKEN:test-wa --var WHATSAPP_PHONE_ID:555 --var WHATSAPP_API:http://127.0.0.1:8796/wa --var APP_URL:http://localhost:8799 \
  --var WHATSAPP_APP_SECRET:test-app-secret --var WHATSAPP_VERIFY_TOKEN:test-verify --var WHATSAPP_NUMBER:919000000000
ERP_AI_MOCK=8796 node test/run.mjs http://localhost:8799
```

### Automatic WhatsApp reminders (one-time setup by the SmartTrader operator)

1. Meta Business → WhatsApp → set up the Cloud API with SmartTrader's business number; note the **Phone number ID**
   and make a **permanent access token** (System user with `whatsapp_business_messaging`).
2. Message templates → create a **Utility** template named `payment_reminder` in English (`en`) and Hindi (`hi`),
   body with four parameters, for example:
   `Namaste {{1}}, {{2}} ki taraf se yaad dilaana: aapka {{3}} baaki hai. Bill dekhein aur UPI se bharein: {{4}}`
   (1 = customer, 2 = business, 3 = amount, 4 = bill link). Wait until it is approved.
3. Cloudflare → the ERP worker → Variables and Secrets: **WHATSAPP_TOKEN** (Secret) and **WHATSAPP_PHONE_ID**.
   Optional: `WHATSAPP_TEMPLATE` (another template name), `WHATSAPP_BILL_TEMPLATE` (for new recurring bills, same four
   parameters; without it the reminder template is used), `WHATSAPP_LANG_EN` / `WHATSAPP_LANG_HI` / `WHATSAPP_LANG_HL`
   (template language codes; Hinglish customers get the English template unless `WHATSAPP_LANG_HL` is set).
   `APP_URL` (in wrangler.toml) is the address used in the links. Meta bills each message to the operator's account.

### WhatsApp bot (one-time setup by the SmartTrader operator, after the reminders above)

Uses the same WhatsApp number and token as the reminders. Answers to a customer who wrote first are free on the
Cloud API (the 24-hour customer service window), so the bot itself costs nothing per message.

1. Make a long random **verify token** yourself (any text, e.g. 32 letters and digits). Do not paste it in a chat.
2. Cloudflare → the ERP worker → Variables and Secrets, type **Secret**: **WHATSAPP_VERIFY_TOKEN** (that token) and
   **WHATSAPP_APP_SECRET** (Meta app → App settings → Basic → *App secret*). As a plain variable: **WHATSAPP_NUMBER**,
   the WhatsApp number customers write to, with country code and no + (e.g. `919876543210`). Deploy.
   The Meta app's **Privacy Policy URL** (App settings → Basic, needed to switch the app to Live) is
   `https://erp.docbrisk.com/privacy/` (made by `tools/gen-seo-pages.py`).
3. Meta app → WhatsApp → Configuration → Webhook → *Edit*: Callback URL `https://erp.docbrisk.com/api/wa/webhook`,
   Verify token = the same token → *Verify and save*. Then under Webhook fields subscribe to **messages**.
4. Each shop turns it on in Settings → *WhatsApp bot* and prints its QR poster. Customers already on the shop's list
   with their mobile number can simply write "hisab" to the number.

Never put these values in `wrangler.toml` or in code; the bot stays off (Settings does not show it) until
`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` and `WHATSAPP_APP_SECRET` are all set.

### Google Drive auto-backup (one-time setup by the SmartTrader operator)

Customers connect their own Google Drive in **Settings → Backup**; a full backup then goes to a
"SmartTrader Backup" folder in their Drive every day (or week), with a readable **Excel copy** next to it (a tick
box turns that off), and the newest 30 of each are kept. Google's MD5 of every stored file is compared with the
app's own: a match shows "✓ checked", a mismatch removes the file and reports the backup as failed. Settings links
straight to the folder and to the latest Excel (on a phone, they open in the Drive app). The app asks only for
`drive.file`, so it sees just the files it made. To switch it on for everyone:

1. Google Cloud Console → create a project → **APIs & Services → Library** → enable **Google Drive API**.
2. **Google Auth Platform (OAuth consent screen)**: External, app name SmartTrader ERP, your support e-mail, one scope:
   `drive.file` (the account e-mail is read from Drive itself). Then **Audience → Publish app** so the status is
   **In production**: while it says *Testing*, only the listed test users can connect and everyone else sees
   "Access blocked". `drive.file` is a non-sensitive scope, so publishing needs no security review.
3. **Credentials → Create credentials → OAuth client ID** → Web application. Authorised redirect URI:
   `https://erp.docbrisk.com/api/gdrive/callback`.
4. Cloudflare → the ERP worker → Settings → Variables and Secrets → add **GDRIVE_CLIENT_ID** and **GDRIVE_CLIENT_SECRET**
   (type Secret). The hourly cron in wrangler.toml does the backups.

If a customer comes back from Google to Settings with a note, it says what happened (permission not given, signed out
while Google was open, link too old) and what to do. Keep `SESSION_SECRET` fixed: the stored Google tokens are encrypted with a key made from it, so changing it means
every business has to connect Drive again.

### Backup to a folder on a computer, and backup reminders

- **Settings → Backup → Backup to a folder on this computer** (Chrome or Edge on a computer; File System Access API,
  `folderBackup` in `public/app.js`): the owner picks a folder once; the device remembers it (IndexedDB), and while
  SmartTrader is open there a backup is written once a day or week (`smarttrader-backup-<date_time>.json` and
  `smarttrader-excel-<date_time>.xlsx`), the newest 30 of each kept. Only files with those names are ever removed. A
  folder inside Google Drive for desktop, OneDrive or a pen drive carries the copies on. After a browser restart
  Chrome asks again before writing (unless "Allow on every visit" was chosen), so a small note offers "Save backup"
  in one tap. Two open tabs: one writes (Web Locks). On a phone the box says to use Google Drive or Download.
- **Today** tells the owner when the data is not safe anywhere: Google Drive backup failing for 2 days, no backup
  at all after the first 3 days, or none for 7 days (a download, a folder backup or Google Drive all count;
  `backupHealth` in `src/lib.js`, from `orgs.backup_at` and `drive_links`, so the check reads 1 row). Staff never see it.

## Not built yet (next steps)

- Each shop's own WhatsApp number for the bot and reminders (Meta's Embedded Signup as a Tech Provider); today they
  come from SmartTrader's one number under the shop's name.
- Direct IRN / e-way bill generation through an API. This needs a GSP account; today the JSON files
  are uploaded on the government portals.
- Live sync with the Amazon / Flipkart seller APIs (today: their order and tax reports, Amazon's settlement report,
  a stock file, and live orders from Shopify / WooCommerce / own sites). Amazon SP-API and Flipkart's API need
  SmartTrader to be registered as a developer with each marketplace first. Flipkart's payout report is not read yet.
- Handheld (HHT) app with put-away rules per zone; statutory payroll (PF / ESI / TDS) on salaries.
- Checking the e-invoice QR's signature against NIC's public key (today the QR is read, not verified; the IRN is kept,
  and one IRN can come in at the gate only once).
