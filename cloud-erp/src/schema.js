/* SmartTrader Cloud ERP - database schema (Cloudflare D1 / SQLite).
   Money is stored as INTEGER paise (Rs 1 = 100). Quantities are REAL rounded to 3 decimals.
   Every business table carries org_id: one database serves many businesses (multi-tenant).
   migrate() runs on the first request after each deploy, so no manual migration step is needed. */

export const SCHEMA_VERSION = 22;

// document types whose monthly totals doc_month keeps (sales and purchase money documents)
const MONTH_TYPES = `('INV','SRET','CNOTE','BILL','PRET','DNOTE')`;

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orgs (
     id INTEGER PRIMARY KEY, name TEXT NOT NULL, gstin TEXT DEFAULT '', state TEXT DEFAULT '',
     address TEXT DEFAULT '', phone TEXT DEFAULT '', upi_id TEXT DEFAULT '', fy_start TEXT DEFAULT '04-01',
     created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
     role TEXT NOT NULL, pw_hash TEXT NOT NULL, salt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
     pw_changed_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS accounts (
     id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
     sys TEXT DEFAULT NULL, is_cash INTEGER NOT NULL DEFAULT 0, UNIQUE (org_id, code))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_sys ON accounts (org_id, sys) WHERE sys IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS parties (
     id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('customer','supplier','both')),
     phone TEXT DEFAULT '', email TEXT DEFAULT '', gstin TEXT DEFAULT '', state TEXT DEFAULT '', address TEXT DEFAULT '',
     credit_limit INTEGER NOT NULL DEFAULT 0, credit_days INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
     UNIQUE (org_id, name))`,
  `CREATE TABLE IF NOT EXISTS warehouses (
     id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, name TEXT NOT NULL, UNIQUE (org_id, name))`,
  `CREATE TABLE IF NOT EXISTS items (
     id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, sku TEXT DEFAULT '', name TEXT NOT NULL, category TEXT DEFAULT '',
     unit TEXT NOT NULL DEFAULT 'Pcs', hsn TEXT DEFAULT '', gst_rate REAL NOT NULL DEFAULT 0,
     purchase_price INTEGER NOT NULL DEFAULT 0, sale_price INTEGER NOT NULL DEFAULT 0,
     reorder_level REAL NOT NULL DEFAULT 0, is_service INTEGER NOT NULL DEFAULT 0,
     qty_on_hand REAL NOT NULL DEFAULT 0, avg_cost REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
     UNIQUE (org_id, name))`,
  `CREATE TABLE IF NOT EXISTS stock (
     org_id INTEGER NOT NULL, item_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL, qty REAL NOT NULL DEFAULT 0,
     PRIMARY KEY (item_id, warehouse_id))`,
  `CREATE TABLE IF NOT EXISTS stock_moves (
     id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, date TEXT NOT NULL, item_id INTEGER NOT NULL,
     warehouse_id INTEGER NOT NULL, qty REAL NOT NULL, unit_cost REAL NOT NULL, value INTEGER NOT NULL,
     ref_type TEXT NOT NULL, ref_id INTEGER, note TEXT DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS ix_moves_item ON stock_moves (org_id, item_id, date)`,
  /* One table for every trading document: PO, GRN, BILL (purchase invoice), PRET (purchase return),
     SO, DN (delivery note), INV (sales invoice), SRET (sales return), QUOTE. */
  `CREATE TABLE IF NOT EXISTS docs (
     id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, type TEXT NOT NULL, number TEXT NOT NULL,
     party_id INTEGER, date TEXT NOT NULL, due_date TEXT, warehouse_id INTEGER, ref_id INTEGER,
     status TEXT NOT NULL DEFAULT 'open', place_of_supply TEXT DEFAULT '', inter_state INTEGER NOT NULL DEFAULT 0,
     taxable INTEGER NOT NULL DEFAULT 0, cgst INTEGER NOT NULL DEFAULT 0, sgst INTEGER NOT NULL DEFAULT 0,
     igst INTEGER NOT NULL DEFAULT 0, round_off INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
     paid INTEGER NOT NULL DEFAULT 0, notes TEXT DEFAULT '', created_by INTEGER, created_at TEXT NOT NULL,
     txk TEXT UNIQUE, UNIQUE (org_id, type, number))`,
  `CREATE INDEX IF NOT EXISTS ix_docs_type ON docs (org_id, type, date)`,
  `CREATE INDEX IF NOT EXISTS ix_docs_party ON docs (org_id, party_id)`,
  `CREATE TABLE IF NOT EXISTS doc_lines (
     id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL, item_id INTEGER, description TEXT DEFAULT '',
     qty REAL NOT NULL, rate INTEGER NOT NULL, discount_pct REAL NOT NULL DEFAULT 0, gst_rate REAL NOT NULL DEFAULT 0,
     taxable INTEGER NOT NULL, cgst INTEGER NOT NULL, sgst INTEGER NOT NULL, igst INTEGER NOT NULL, total INTEGER NOT NULL,
     done_qty REAL NOT NULL DEFAULT 0, src_line_id INTEGER, cost INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS ix_lines_doc ON doc_lines (doc_id)`,
  `CREATE TABLE IF NOT EXISTS payments (
     id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, number TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('receipt','payment')), party_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
     date TEXT NOT NULL, amount INTEGER NOT NULL, reference TEXT DEFAULT '', notes TEXT DEFAULT '',
     created_by INTEGER, created_at TEXT NOT NULL, txk TEXT UNIQUE, UNIQUE (org_id, kind, number))`,
  /* payment_id > 0: a receipt/payment settled doc_id; payment_id = 0 with note_id: a credit/debit note did. */
  `CREATE TABLE IF NOT EXISTS payment_allocs (
     payment_id INTEGER NOT NULL, doc_id INTEGER NOT NULL, amount INTEGER NOT NULL, note_id INTEGER)`,
  `CREATE INDEX IF NOT EXISTS ix_alloc_doc ON payment_allocs (doc_id)`,
  `CREATE TABLE IF NOT EXISTS journals (
     id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, date TEXT NOT NULL, narration TEXT DEFAULT '',
     ref_type TEXT NOT NULL, ref_id INTEGER, created_by INTEGER, created_at TEXT NOT NULL, txk TEXT UNIQUE)`,
  `CREATE INDEX IF NOT EXISTS ix_journals_ref ON journals (org_id, ref_type, ref_id)`,
  `CREATE TABLE IF NOT EXISTS journal_lines (
     id INTEGER PRIMARY KEY, journal_id INTEGER NOT NULL, org_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
     party_id INTEGER, debit INTEGER NOT NULL DEFAULT 0, credit INTEGER NOT NULL DEFAULT 0, date TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ix_jl_acct ON journal_lines (org_id, account_id, date)`,
  `CREATE INDEX IF NOT EXISTS ix_jl_party ON journal_lines (org_id, party_id)`,
  /* Khata: a simple "you gave / you got" book, like Khatabook, per contact. */
  `CREATE TABLE IF NOT EXISTS khata (
     id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, party_id INTEGER NOT NULL, date TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('gave','got')), amount INTEGER NOT NULL, note TEXT DEFAULT '',
     created_by INTEGER, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ix_khata_party ON khata (org_id, party_id, date)`,
  `CREATE TABLE IF NOT EXISTS counters (org_id INTEGER NOT NULL, key TEXT NOT NULL, next INTEGER NOT NULL,
     PRIMARY KEY (org_id, key))`,
  `CREATE TABLE IF NOT EXISTS audit (
     id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER, at TEXT NOT NULL, action TEXT NOT NULL, detail TEXT DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS rate_limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL)`,
];

/* Chart of accounts seeded for every new business. `sys` marks accounts the posting engine uses. */
export const DEFAULT_ACCOUNTS = [
  ['1000', 'Cash in Hand', 'asset', 'cash', 1],
  ['1010', 'Bank Account', 'asset', 'bank', 1],
  ['1020', 'UPI / Wallet', 'asset', 'upi', 1],
  ['1100', 'Accounts Receivable (Debtors)', 'asset', 'ar', 0],
  ['1200', 'Inventory (Stock in Hand)', 'asset', 'inventory', 0],
  ['1300', 'GST Input Credit', 'asset', 'gst_input', 0],
  ['2000', 'Accounts Payable (Creditors)', 'liability', 'ap', 0],
  ['2100', 'GST Output Payable', 'liability', 'gst_output', 0],
  ['2200', 'Goods Received Not Billed', 'liability', 'grni', 0],
  ['3000', "Owner's Capital", 'equity', 'capital', 0],
  ['3100', 'Opening Balance Equity', 'equity', 'opening', 0],
  ['3200', 'Owner Drawings', 'equity', 'drawings', 0],
  ['4000', 'Sales', 'income', 'sales', 0],
  ['4100', 'Other Income', 'income', 'other_income', 0],
  ['4200', 'Sales Discounts & Rate Difference', 'income', 'sales_adj', 0],
  ['5000', 'Cost of Goods Sold', 'expense', 'cogs', 0],
  ['5100', 'Stock Adjustments (Loss / Gain)', 'expense', 'stock_adj', 0],
  ['5200', 'Round Off', 'expense', 'round_off', 0],
  ['5300', 'Purchase Rate Difference', 'expense', 'pur_adj', 0],
  ['6000', 'Rent', 'expense', null, 0],
  ['6010', 'Salaries & Wages', 'expense', null, 0],
  ['6020', 'Electricity', 'expense', null, 0],
  ['6030', 'Transport & Freight', 'expense', null, 0],
  ['6040', 'Telephone & Internet', 'expense', null, 0],
  ['6050', 'Repairs & Maintenance', 'expense', null, 0],
  ['6060', 'Bank Charges', 'expense', null, 0],
  ['6090', 'Miscellaneous Expenses', 'expense', 'misc_exp', 0],
];

/* Changes after the first release. Each step runs once, in order, on databases that already exist
   (new databases get SCHEMA and then every step, so both end up identical). */
export const MIGRATIONS = {
  2: [
    `ALTER TABLE orgs ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'`,
    `ALTER TABLE orgs ADD COLUMN plan_until TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE orgs ADD COLUMN city TEXT DEFAULT ''`,
    `ALTER TABLE orgs ADD COLUMN pincode TEXT DEFAULT ''`,
    `ALTER TABLE orgs ADD COLUMN email TEXT DEFAULT ''`,
    `ALTER TABLE parties ADD COLUMN city TEXT DEFAULT ''`,
    `ALTER TABLE parties ADD COLUMN pincode TEXT DEFAULT ''`,
    `ALTER TABLE items ADD COLUMN barcode TEXT DEFAULT ''`,
    `ALTER TABLE docs ADD COLUMN irn TEXT DEFAULT ''`,
    `ALTER TABLE docs ADD COLUMN ack_no TEXT DEFAULT ''`,
    `ALTER TABLE docs ADD COLUMN ack_date TEXT DEFAULT ''`,
    `ALTER TABLE docs ADD COLUMN ewb_no TEXT DEFAULT ''`,
    `ALTER TABLE docs ADD COLUMN ewb_date TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS ix_items_barcode ON items (org_id, barcode)`,
    // businesses that signed up before plans existed get a 30-day Growth trial
    `UPDATE orgs SET plan = 'growth', plan_until = date('now', '+30 days') WHERE plan = 'free' AND plan_until = ''`,
  ],
  // khata trust: entries count only after being sent to the customer; customers confirm/dispute via a private link
  3: [
    `ALTER TABLE khata ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'`,
    `ALTER TABLE khata ADD COLUMN sent_at TEXT DEFAULT ''`,
    `ALTER TABLE khata ADD COLUMN sent_via TEXT DEFAULT ''`,
    `ALTER TABLE khata ADD COLUMN ack TEXT DEFAULT ''`,
    `ALTER TABLE khata ADD COLUMN ack_at TEXT DEFAULT ''`,
    `ALTER TABLE khata ADD COLUMN ack_note TEXT DEFAULT ''`,
    `ALTER TABLE khata ADD COLUMN reverses INTEGER`,
    `ALTER TABLE parties ADD COLUMN khata_token TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_parties_khata_token ON parties (khata_token) WHERE khata_token IS NOT NULL`,
  ],
  // customer links for invoices and quotations (view, download, pay)
  4: [
    `ALTER TABLE docs ADD COLUMN share_token TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_docs_share_token ON docs (share_token) WHERE share_token IS NOT NULL`,
  ],
  // gate entry register, value credit/debit notes, bin locations
  5: [
    `CREATE TABLE IF NOT EXISTS gate_entries (
       id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, number TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('in','out')),
       date TEXT NOT NULL, time_in TEXT DEFAULT '', time_out TEXT DEFAULT '', party_id INTEGER, ref_doc_id INTEGER,
       vehicle_no TEXT DEFAULT '', driver_name TEXT DEFAULT '', driver_phone TEXT DEFAULT '', transporter TEXT DEFAULT '', lr_no TEXT DEFAULT '',
       challan_no TEXT DEFAULT '', challan_date TEXT DEFAULT '', packages INTEGER NOT NULL DEFAULT 0, weight_kg REAL NOT NULL DEFAULT 0,
       remarks TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'open', grn_id INTEGER, created_by INTEGER, created_at TEXT NOT NULL,
       UNIQUE (org_id, kind, number))`,
    `CREATE INDEX IF NOT EXISTS ix_gate_org ON gate_entries (org_id, kind, date)`,
    `ALTER TABLE docs ADD COLUMN gate_entry_id INTEGER`,
    `ALTER TABLE items ADD COLUMN location TEXT DEFAULT ''`,
    `INSERT INTO accounts (org_id, code, name, type, sys, is_cash) SELECT o.id, '4200', 'Sales Discounts & Rate Difference', 'income', 'sales_adj', 0 FROM orgs o
       WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND (a.sys = 'sales_adj' OR a.code = '4200'))`,
    `INSERT INTO accounts (org_id, code, name, type, sys, is_cash) SELECT o.id, '5300', 'Purchase Rate Difference', 'expense', 'pur_adj', 0 FROM orgs o
       WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND (a.sys = 'pur_adj' OR a.code = '5300'))`,
  ],
  /* Running totals kept by triggers, so dashboards and reports read a few hundred summary rows instead of
     every journal line ever posted (Cloudflare's free plan allows 5 million rows read per day).
     Journal lines are never updated or deleted (cancellations post reversals), so insert triggers are enough.
     Runs as one transaction: the backfill and the triggers cannot miss a line posted in between. */
  6: [
    `CREATE TABLE IF NOT EXISTS acct_month (org_id INTEGER NOT NULL, account_id INTEGER NOT NULL, ym TEXT NOT NULL,
       dr INTEGER NOT NULL DEFAULT 0, cr INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (org_id, account_id, ym)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS party_bal (org_id INTEGER NOT NULL, party_id INTEGER NOT NULL, bal INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (org_id, party_id)) WITHOUT ROWID`,
    `DELETE FROM acct_month`,
    `DELETE FROM party_bal`,
    `INSERT INTO acct_month (org_id, account_id, ym, dr, cr) SELECT org_id, account_id, substr(date, 1, 7), SUM(debit), SUM(credit)
       FROM journal_lines GROUP BY org_id, account_id, substr(date, 1, 7)`,
    `INSERT INTO party_bal (org_id, party_id, bal) SELECT jl.org_id, jl.party_id, SUM(jl.debit - jl.credit) FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id AND a.sys IN ('ar','ap') WHERE jl.party_id IS NOT NULL GROUP BY jl.org_id, jl.party_id`,
    `CREATE TRIGGER IF NOT EXISTS trg_jl_month AFTER INSERT ON journal_lines BEGIN
       INSERT INTO acct_month (org_id, account_id, ym, dr, cr) VALUES (NEW.org_id, NEW.account_id, substr(NEW.date, 1, 7), NEW.debit, NEW.credit)
       ON CONFLICT (org_id, account_id, ym) DO UPDATE SET dr = dr + excluded.dr, cr = cr + excluded.cr;
     END`,
    `CREATE TRIGGER IF NOT EXISTS trg_jl_party AFTER INSERT ON journal_lines
       WHEN NEW.party_id IS NOT NULL AND EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND sys IN ('ar','ap')) BEGIN
       INSERT INTO party_bal (org_id, party_id, bal) VALUES (NEW.org_id, NEW.party_id, NEW.debit - NEW.credit)
       ON CONFLICT (org_id, party_id) DO UPDATE SET bal = bal + excluded.bal;
     END`,
    // simple mode hides modules most small shops never use (orders, GRN, gate entry, e-invoice...); nothing is deleted
    `ALTER TABLE orgs ADD COLUMN mode TEXT NOT NULL DEFAULT 'simple'`,
  ],
  // day totals for the part-months at the ends of a period (the current month, mostly)
  7: [
    `CREATE TABLE IF NOT EXISTS acct_day (org_id INTEGER NOT NULL, account_id INTEGER NOT NULL, d TEXT NOT NULL,
       dr INTEGER NOT NULL DEFAULT 0, cr INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (org_id, account_id, d)) WITHOUT ROWID`,
    `DELETE FROM acct_day`,
    `INSERT INTO acct_day (org_id, account_id, d, dr, cr) SELECT org_id, account_id, date, SUM(debit), SUM(credit) FROM journal_lines GROUP BY org_id, account_id, date`,
    `CREATE TRIGGER IF NOT EXISTS trg_jl_day AFTER INSERT ON journal_lines BEGIN
       INSERT INTO acct_day (org_id, account_id, d, dr, cr) VALUES (NEW.org_id, NEW.account_id, NEW.date, NEW.debit, NEW.credit)
       ON CONFLICT (org_id, account_id, d) DO UPDATE SET dr = dr + excluded.dr, cr = cr + excluded.cr;
     END`,
  ],
  // online plan payments (DocBrisk Pay UPI or Razorpay); one row per checkout
  8: [
    `CREATE TABLE IF NOT EXISTS billing_orders (
       id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER, ref TEXT NOT NULL UNIQUE, order_id TEXT UNIQUE,
       plan TEXT NOT NULL, months INTEGER NOT NULL, paise INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'created',
       payment_id TEXT, plan_until TEXT, created_at TEXT NOT NULL, paid_at TEXT)`,
    `CREATE INDEX IF NOT EXISTS ix_billing_org ON billing_orders (org_id, id)`,
  ],
  /* speed: indexes for lookups that used to scan every business's rows, and monthly document totals
     (doc_month) so the dashboard reads a few month rows instead of every invoice. A document's date and
     taxable never change after insert; the triggers follow status changes into and out of 'cancelled'. */
  9: [
    `CREATE INDEX IF NOT EXISTS ix_jl_journal ON journal_lines (journal_id)`,
    `CREATE INDEX IF NOT EXISTS ix_journals_date ON journals (org_id, date)`,
    `CREATE INDEX IF NOT EXISTS ix_docs_ref ON docs (ref_id) WHERE ref_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ix_docs_org_id ON docs (org_id, id)`,
    `CREATE INDEX IF NOT EXISTS ix_docs_open ON docs (org_id, type, due_date) WHERE status IN ('unpaid','partial')`,
    `CREATE INDEX IF NOT EXISTS ix_stock_org ON stock (org_id, warehouse_id)`,
    `CREATE INDEX IF NOT EXISTS ix_khata_p ON khata (party_id, date)`,
    `CREATE INDEX IF NOT EXISTS ix_khata_rev ON khata (reverses) WHERE reverses IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ix_audit_org ON audit (org_id, id)`,
    `CREATE INDEX IF NOT EXISTS ix_users_org ON users (org_id)`,
    `CREATE INDEX IF NOT EXISTS ix_alloc_pay ON payment_allocs (payment_id)`,
    `CREATE INDEX IF NOT EXISTS ix_alloc_note ON payment_allocs (note_id) WHERE note_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ix_moves_ref ON stock_moves (org_id, ref_type, ref_id)`,
    `CREATE INDEX IF NOT EXISTS ix_lines_item ON doc_lines (item_id) WHERE item_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS doc_month (org_id INTEGER NOT NULL, type TEXT NOT NULL, ym TEXT NOT NULL,
       n INTEGER NOT NULL DEFAULT 0, taxable INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (org_id, type, ym)) WITHOUT ROWID`,
    `DELETE FROM doc_month`,
    `INSERT INTO doc_month (org_id, type, ym, n, taxable) SELECT org_id, type, substr(date, 1, 7), COUNT(*), SUM(taxable)
       FROM docs WHERE status != 'cancelled' AND type IN ${MONTH_TYPES} GROUP BY 1, 2, 3`,
    `CREATE TRIGGER IF NOT EXISTS trg_doc_month_ins AFTER INSERT ON docs
       WHEN NEW.status != 'cancelled' AND NEW.type IN ${MONTH_TYPES} BEGIN
       INSERT INTO doc_month (org_id, type, ym, n, taxable) VALUES (NEW.org_id, NEW.type, substr(NEW.date, 1, 7), 1, NEW.taxable)
       ON CONFLICT (org_id, type, ym) DO UPDATE SET n = n + 1, taxable = taxable + excluded.taxable;
     END`,
    `CREATE TRIGGER IF NOT EXISTS trg_doc_month_status AFTER UPDATE OF status ON docs
       WHEN (NEW.status = 'cancelled') != (OLD.status = 'cancelled') AND NEW.type IN ${MONTH_TYPES} BEGIN
       INSERT INTO doc_month (org_id, type, ym, n, taxable)
       VALUES (NEW.org_id, NEW.type, substr(NEW.date, 1, 7), CASE WHEN NEW.status = 'cancelled' THEN -1 ELSE 1 END,
               CASE WHEN NEW.status = 'cancelled' THEN -NEW.taxable ELSE NEW.taxable END)
       ON CONFLICT (org_id, type, ym) DO UPDATE SET n = n + excluded.n, taxable = taxable + excluded.taxable;
     END`,
  ],
  // print branding: settings JSON on the business row, logo and signature images in their own table
  10: [
    `ALTER TABLE orgs ADD COLUMN print TEXT NOT NULL DEFAULT '{}'`,
    `CREATE TABLE IF NOT EXISTS org_files (org_id INTEGER NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, data TEXT NOT NULL,
       hash TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (org_id, kind)) WITHOUT ROWID`,
  ],
  // custom document numbering (prefix, digits, yearly reset) per document type
  11: [`ALTER TABLE orgs ADD COLUMN series TEXT NOT NULL DEFAULT '{}'`],
  // custom fields: definitions on the business row, values as JSON on each item, party and document
  12: [
    `ALTER TABLE orgs ADD COLUMN fields TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE items ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE parties ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE docs ADD COLUMN extra TEXT NOT NULL DEFAULT '{}'`,
  ],
  // custom roles: named sets of per-area view / edit switches, given to users through users.role_id
  13: [
    `CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, name TEXT NOT NULL, perms TEXT NOT NULL DEFAULT '{}',
       created_at TEXT NOT NULL, UNIQUE (org_id, name))`,
    `ALTER TABLE users ADD COLUMN role_id INTEGER`,
  ],
  // payment promises (vaade): the customer picks a date or instalments on their link; kept/broken from receipts
  14: [
    `ALTER TABLE orgs ADD COLUMN vaada TEXT NOT NULL DEFAULT '{}'`,
    `CREATE TABLE IF NOT EXISTS vaade (
       id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, party_id INTEGER NOT NULL,
       book TEXT NOT NULL CHECK (book IN ('khata','inv')), doc_id INTEGER,
       kind TEXT NOT NULL CHECK (kind IN ('date','plan')), amount INTEGER NOT NULL CHECK (amount > 0),
       due_at_start INTEGER NOT NULL, made_on TEXT NOT NULL,
       made_by TEXT NOT NULL CHECK (made_by IN ('customer','shop')), user_id INTEGER, cust_name TEXT DEFAULT '',
       note TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','replaced','cancelled')),
       closed_on TEXT, changes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, txk TEXT UNIQUE)`,
    // at most ONE open promise per party per book, enforced by the database even under concurrent requests
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_vaade_open ON vaade (org_id, party_id, book) WHERE status = 'open'`,
    `CREATE INDEX IF NOT EXISTS ix_vaade_org ON vaade (org_id, status, closed_on)`,
    `CREATE INDEX IF NOT EXISTS ix_vaade_party ON vaade (org_id, party_id, id)`,
    `CREATE TABLE IF NOT EXISTS vaada_kisht (
       id INTEGER PRIMARY KEY, vaada_id INTEGER NOT NULL, org_id INTEGER NOT NULL, party_id INTEGER NOT NULL,
       n INTEGER NOT NULL, due TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0),
       outcome TEXT CHECK (outcome IN ('kept','broken')), settled_on TEXT, UNIQUE (vaada_id, n))`,
    `CREATE INDEX IF NOT EXISTS ix_kisht_party ON vaada_kisht (org_id, party_id, due)`,
    `CREATE INDEX IF NOT EXISTS ix_kisht_open ON vaada_kisht (org_id, due) WHERE outcome IS NULL`,
    `CREATE TABLE IF NOT EXISTS vaada_stats (org_id INTEGER NOT NULL, party_id INTEGER NOT NULL,
       kept INTEGER NOT NULL DEFAULT 0, broken INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (org_id, party_id)) WITHOUT ROWID`,
    // counts follow every outcome change (NULL->kept, kept->broken after a void, broken->kept after a back-dated receipt...)
    `CREATE TRIGGER IF NOT EXISTS trg_kisht_outcome AFTER UPDATE OF outcome ON vaada_kisht
       WHEN OLD.outcome IS NOT NEW.outcome BEGIN
       INSERT INTO vaada_stats (org_id, party_id, kept, broken)
       VALUES (NEW.org_id, NEW.party_id, (NEW.outcome IS 'kept') - (OLD.outcome IS 'kept'), (NEW.outcome IS 'broken') - (OLD.outcome IS 'broken'))
       ON CONFLICT (org_id, party_id) DO UPDATE SET kept = kept + excluded.kept, broken = broken + excluded.broken;
     END`,
    // receipts of one party since a date (promise evaluation), and receipts by date (Kal ka Cash late-days history)
    `CREATE INDEX IF NOT EXISTS ix_pay_party ON payments (org_id, party_id, date)`,
    `CREATE INDEX IF NOT EXISTS ix_pay_kind_date ON payments (org_id, kind, date)`,
    // Kal ka Cash: one cached result per business per day
    `CREATE TABLE IF NOT EXISTS vaada_cache (org_id INTEGER PRIMARY KEY, d TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL)`,
  ],
  // DocBrisk Pay (automatic UPI): which way a checkout pays, the hub's order, the exact UPI amount and its expiry
  15: [
    `ALTER TABLE billing_orders ADD COLUMN method TEXT`,
    `ALTER TABLE billing_orders ADD COLUMN hub_id TEXT`,
    `ALTER TABLE billing_orders ADD COLUMN pay_paise INTEGER`,
    `ALTER TABLE billing_orders ADD COLUMN pay_expires_at TEXT`,
    `ALTER TABLE billing_orders ADD COLUMN pay_checked_at INTEGER`,
  ],
  // forgot password: one-time reset links (only a SHA-256 of the token is stored)
  16: [
    `CREATE TABLE IF NOT EXISTS pw_resets (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS pw_resets_user ON pw_resets(user_id)`,
  ],
  /* security hardening: logout puts the session id on a revoked list; e-mail-verified signups wait in `signups`;
     indexes keep the rate-limit clean-up and the monthly invoice count (by creation time) cheap;
     journal lines that point at another business's party (a past hole) lose that link and their party balance rows. */
  17: [
    `CREATE TABLE IF NOT EXISTS revoked_tokens (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS ix_revoked_exp ON revoked_tokens (exp)`,
    `CREATE TABLE IF NOT EXISTS signups (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, data TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ix_signups_email ON signups (email)`,
    `CREATE INDEX IF NOT EXISTS ix_rate_reset ON rate_limits (reset_at)`,
    `CREATE INDEX IF NOT EXISTS ix_docs_created ON docs (org_id, type, created_at)`,
    `UPDATE journal_lines SET party_id = NULL WHERE party_id IS NOT NULL AND party_id NOT IN (SELECT id FROM parties WHERE parties.org_id = journal_lines.org_id)`,
    `DELETE FROM party_bal WHERE party_id NOT IN (SELECT id FROM parties WHERE parties.org_id = party_bal.org_id)`,
  ],
  // recurring invoices and bills (src/recurring.js): one row per schedule, the cron makes the due ones every morning
  18: [
    `CREATE TABLE IF NOT EXISTS recurring (id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, src_doc_id INTEGER NOT NULL, every TEXT NOT NULL,
      anchor_day INTEGER NOT NULL, next_on TEXT NOT NULL, ends_on TEXT, active INTEGER NOT NULL DEFAULT 1, created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL, runs INTEGER NOT NULL DEFAULT 0, last_doc_id INTEGER, last_run_on TEXT, last_error TEXT)`,
    `CREATE INDEX IF NOT EXISTS ix_recurring_due ON recurring (active, next_on)`,
    `CREATE INDEX IF NOT EXISTS ix_recurring_org ON recurring (org_id)`,
  ],
  // per-document print design (NULL = the business's default from Branding & print)
  19: [`ALTER TABLE docs ADD COLUMN design TEXT`],
  // Google Drive backup (src/gdrive.js): one connected Drive per business, the refresh token sealed with AES-GCM
  20: [
    `CREATE TABLE IF NOT EXISTS drive_links (org_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email TEXT, refresh_enc TEXT NOT NULL, folder_id TEXT,
      every TEXT NOT NULL DEFAULT 'day', connected_at TEXT NOT NULL, last_backup_at TEXT, last_try_at TEXT, last_file TEXT, last_size INTEGER, last_error TEXT)`,
  ],
  /* vasooli (src/vasooli.js, src/msg.js): the customer's message language and VIP flag, the business's default language
     and Udyam number (MSMED interest), every reminder sent (evidence, and the schedule's memory), and the monthly
     balance statements customers confirm or dispute on /c/<token> */
  21: [
    `ALTER TABLE parties ADD COLUMN lang TEXT DEFAULT ''`,
    `ALTER TABLE parties ADD COLUMN vip INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE orgs ADD COLUMN msg_lang TEXT NOT NULL DEFAULT 'hl'`,
    `ALTER TABLE orgs ADD COLUMN udyam TEXT DEFAULT ''`,
    `CREATE TABLE IF NOT EXISTS reminder_log (id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, party_id INTEGER NOT NULL, step INTEGER NOT NULL,
       via TEXT NOT NULL, lang TEXT DEFAULT '', user_id INTEGER, sent_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ix_remlog_party ON reminder_log (org_id, party_id, id)`,
    `CREATE INDEX IF NOT EXISTS ix_remlog_sent ON reminder_log (org_id, sent_at)`,
    `CREATE TABLE IF NOT EXISTS confirmations (id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, party_id INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
       as_of TEXT NOT NULL, balance INTEGER NOT NULL, bills TEXT NOT NULL DEFAULT '[]',
       status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','agreed','disputed')), note TEXT DEFAULT '', disputed_bill TEXT DEFAULT '',
       sent_via TEXT, sent_at TEXT, created_by INTEGER, created_at TEXT NOT NULL, answered_at TEXT, answered_ua TEXT)`,
    `CREATE INDEX IF NOT EXISTS ix_conf_party ON confirmations (org_id, party_id, id)`,
  ],
  /* bins (racks / shelves) and batches with expiry (src/lots.js): detail under each godown's quantity in `stock`.
     items.location stays the item's default bin; doc lines carry the batch they moved and its expiry. */
  22: [
    `ALTER TABLE items ADD COLUMN track_batch INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE doc_lines ADD COLUMN batch_no TEXT DEFAULT ''`,
    `ALTER TABLE doc_lines ADD COLUMN expiry TEXT DEFAULT ''`,
    `CREATE TABLE IF NOT EXISTS bins (id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL, code TEXT NOT NULL,
       zone TEXT DEFAULT '', capacity REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (org_id, warehouse_id, code))`,
    `CREATE TABLE IF NOT EXISTS bin_stock (org_id INTEGER NOT NULL, item_id INTEGER NOT NULL, bin_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL,
       qty REAL NOT NULL DEFAULT 0, PRIMARY KEY (item_id, bin_id))`,
    `CREATE INDEX IF NOT EXISTS ix_binstock_wh ON bin_stock (org_id, warehouse_id, item_id)`,
    `CREATE INDEX IF NOT EXISTS ix_binstock_bin ON bin_stock (bin_id)`,
    `CREATE TABLE IF NOT EXISTS batches (id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, item_id INTEGER NOT NULL, warehouse_id INTEGER NOT NULL,
       batch_no TEXT NOT NULL, mfg TEXT DEFAULT '', expiry TEXT DEFAULT '', qty REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
       UNIQUE (org_id, item_id, warehouse_id, batch_no))`,
    `CREATE INDEX IF NOT EXISTS ix_batches_exp ON batches (org_id, expiry)`,
    `CREATE TABLE IF NOT EXISTS batch_moves (id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, batch_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
       warehouse_id INTEGER NOT NULL, date TEXT NOT NULL, qty REAL NOT NULL, ref_type TEXT NOT NULL, ref_id INTEGER)`,
    `CREATE INDEX IF NOT EXISTS ix_bmoves_ref ON batch_moves (org_id, ref_type, ref_id)`,
    `CREATE INDEX IF NOT EXISTS ix_bmoves_batch ON batch_moves (batch_id)`,
  ],
};

const ATOMIC = [6, 7, 9];

export async function migrate(db) {
  let version = 0;
  const row = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`).first();
  if (row) {
    const v = await db.prepare(`SELECT v FROM meta WHERE k='schema_version'`).first();
    version = v ? +v.v : 0;
    if (version >= SCHEMA_VERSION) return false;
  }
  if (version < 1) { await db.batch(SCHEMA.map((sql) => db.prepare(sql))); version = 1; }
  for (let v = version + 1; v <= SCHEMA_VERSION; v++) {
    if (ATOMIC.includes(v)) {
      try { await db.batch((MIGRATIONS[v] || []).map((sql) => db.prepare(sql))); } catch (e) {
        const now = await db.prepare(`SELECT v FROM meta WHERE k='schema_version'`).first();   // another request ran it first?
        if (!now || +now.v < v) throw e;
      }
    } else for (const sql of MIGRATIONS[v] || []) {
      try { await db.prepare(sql).run(); } catch (e) {
        if (!/duplicate column/i.test(String(e && e.message))) throw e;   // another request got there first
      }
    }
    await db.prepare(`INSERT INTO meta (k, v) VALUES ('schema_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(v)).run();
  }
  return true;
}
