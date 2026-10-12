/* SmartTrader Cloud ERP - database schema (Cloudflare D1 / SQLite).
   Money is stored as INTEGER paise (Rs 1 = 100). Quantities are REAL rounded to 3 decimals.
   Every business table carries org_id: one database serves many businesses (multi-tenant).
   migrate() runs on the first request after each deploy, so no manual migration step is needed. */

export const SCHEMA_VERSION = 4;

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
  ['5000', 'Cost of Goods Sold', 'expense', 'cogs', 0],
  ['5100', 'Stock Adjustments (Loss / Gain)', 'expense', 'stock_adj', 0],
  ['5200', 'Round Off', 'expense', 'round_off', 0],
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
};

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
    for (const sql of MIGRATIONS[v] || []) {
      try { await db.prepare(sql).run(); } catch (e) {
        if (!/duplicate column/i.test(String(e && e.message))) throw e;   // another request got there first
      }
    }
    await db.prepare(`INSERT INTO meta (k, v) VALUES ('schema_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(String(v)).run();
  }
  return true;
}
