/* Restore a SmartTrader backup (the .json file, from a download or from Google Drive) into this business.
   Like restoring WhatsApp on a new phone: it works only while the business is still empty, so nothing is ever
   merged into existing records.

   Every record gets a new id in this database and every link (bill -> party, line -> item, payment -> bill,
   journal -> account ...) is rewritten through those new ids; an id that does not belong to the backup becomes
   empty, so a file can never point at another business's rows. Only columns this database has are written, plan
   and payment history are not restored (a file cannot buy a plan), staff logins are not restored (no passwords
   are in a backup), and recurring bills come back paused. Everything is written in one D1 batch: the restore
   happens completely or not at all. The ledger, party balances and monthly totals are rebuilt by the database's
   own triggers as the rows go in. */
import { bad, nowIso, uid } from './lib.js';
import { randomHex } from './auth.js';
import { auditStatement } from './engine.js';

const ID_TABLES = ['accounts', 'warehouses', 'roles', 'parties', 'items', 'docs', 'doc_lines', 'payments', 'journals', 'journal_lines', 'khata',
  'stock_moves', 'gate_entries', 'vaade', 'vaada_kisht', 'recurring', 'reminder_log', 'confirmations'];
const OTHER_TABLES = ['payment_allocs', 'stock', 'counters', 'org_files'];
const ORG_FIELDS = ['name', 'gstin', 'state', 'address', 'phone', 'upi_id', 'fy_start', 'city', 'pincode', 'email', 'mode', 'print', 'series', 'fields', 'vaada', 'msg_lang', 'udyam'];
const JSON_FIELDS = ['print', 'series', 'fields', 'vaada'];
const PAY_REFS = ['payment', 'receipt', 'payment-X', 'receipt-X'];
const MAX_ROWS = 300000, MAX_SQL = 90000;

/* SQL literal for one value; anything that is not a plain value becomes NULL */
const lit = (v) => v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL')
  : typeof v === 'boolean' ? (v ? '1' : '0')
  : typeof v === 'string' ? `'${v.replace(/\u0000/g, '').replace(/'/g, "''")}'`
  : 'NULL';

/* Empty = nothing but what sign-up makes (the chart of accounts, one godown and the "Walk-in Customer") */
export async function isEmptyOrg(db, orgId) {
  const r = await db.prepare(`SELECT (SELECT COUNT(*) FROM docs WHERE org_id = ?1) + (SELECT COUNT(*) FROM parties WHERE org_id = ?1 AND name != 'Walk-in Customer')
      + (SELECT COUNT(*) FROM items WHERE org_id = ?1) + (SELECT COUNT(*) FROM payments WHERE org_id = ?1)
      + (SELECT COUNT(*) FROM khata WHERE org_id = ?1) + (SELECT COUNT(*) FROM journals WHERE org_id = ?1) AS n`).bind(orgId).first();
  return !r.n;
}

export async function restoreBackup(c, backup) {
  const db = c.db, orgId = c.org.id, me = c.user.id;
  if (!backup || typeof backup !== 'object' || backup.format !== 'smarttrader-backup' || !backup.tables || typeof backup.tables !== 'object') {
    throw bad('This is not a SmartTrader backup file.');
  }
  if (+backup.version !== 1) throw bad('This backup was made by a newer version of SmartTrader.');
  if (!(await isEmptyOrg(db, orgId))) throw bad('Restore works only in a new, empty business. Make a new SmartTrader account, then restore the backup there.');
  const rowsOf = (t) => (Array.isArray(backup.tables[t]) ? backup.tables[t] : []).filter((r) => r && typeof r === 'object' && !Array.isArray(r));
  const T = {};
  let total = 0;
  for (const t of [...ID_TABLES, ...OTHER_TABLES]) { T[t] = rowsOf(t); total += T[t].length; }
  if (total > MAX_ROWS) throw bad('This backup is too big to restore here. Please contact support.');

  // the columns this database has (only these are ever written, so a file cannot name a column)
  const info = await db.batch([...ID_TABLES, ...OTHER_TABLES].map((t) => db.prepare(`PRAGMA table_info(${t})`)));
  const cols = {}, required = {};
  [...ID_TABLES, ...OTHER_TABLES].forEach((t, i) => {
    cols[t] = new Set(info[i].results.map((r) => r.name));
    // NOT NULL without a default: a missing "…_at" time gets now; anything else missing fails the restore cleanly
    required[t] = info[i].results.filter((r) => r.notnull && r.dflt_value === null && !r.pk).map((r) => r.name);
  });

  const attempt = async (gap) => {
    const maxes = await db.batch(ID_TABLES.map((t) => db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${t}`)));
    const base = {}, map = {};
    ID_TABLES.forEach((t, i) => { base[t] = maxes[i].results[0].m + gap; map[t] = new Map(); });
    const assign = (t, rows) => {
      let n = 0;
      for (const r of [...rows].sort((a, b) => (+a.id || 0) - (+b.id || 0))) if (Number.isFinite(+r.id) && !map[t].has(+r.id)) map[t].set(+r.id, base[t] + (++n));
    };
    const to = (t, v) => (v === null || v === undefined || !map[t].has(+v) ? null : map[t].get(+v));

    // accounts: the chart this business already has is reused (same system account, else same code); the rest is added
    const have = (await db.prepare(`SELECT id, code, sys FROM accounts WHERE org_id = ?`).bind(orgId).all()).results;
    const bySys = new Map(have.filter((a) => a.sys).map((a) => [a.sys, a.id])), byCode = new Map(have.map((a) => [String(a.code), a.id]));
    const newAccounts = [];
    for (const a of [...T.accounts].sort((x, y) => (+x.id || 0) - (+y.id || 0))) {
      const hit = (a.sys && bySys.get(a.sys)) || byCode.get(String(a.code));
      if (hit) map.accounts.set(+a.id, hit); else newAccounts.push(a);
    }
    assign('accounts', newAccounts);
    // godowns: the first one becomes this business's main godown (renamed), the others are added
    const myWh = (await db.prepare(`SELECT id FROM warehouses WHERE org_id = ? ORDER BY id`).bind(orgId).all()).results;
    const whs = [...T.warehouses].sort((x, y) => (+x.id || 0) - (+y.id || 0));
    const firstWh = myWh.length && whs.length ? whs[0] : null;
    if (firstWh) map.warehouses.set(+firstWh.id, myWh[0].id);
    assign('warehouses', whs.filter((w) => w !== firstWh));
    for (const t of ID_TABLES.filter((x) => !['accounts', 'warehouses'].includes(x))) assign(t, T[t]);

    const docOrPay = (r) => (PAY_REFS.includes(String(r.ref_type)) ? to('payments', r.ref_id) : to('docs', r.ref_id));
    const FIX = {
      accounts: () => ({}),
      warehouses: () => ({}),
      roles: () => ({}),
      parties: () => ({ khata_token: null }),
      items: () => ({}),
      docs: (r) => ({ party_id: to('parties', r.party_id), warehouse_id: to('warehouses', r.warehouse_id), ref_id: to('docs', r.ref_id), created_by: me,
        gate_entry_id: to('gate_entries', r.gate_entry_id), share_token: null }),
      doc_lines: (r) => ({ doc_id: to('docs', r.doc_id), item_id: to('items', r.item_id), src_line_id: to('doc_lines', r.src_line_id) }),
      payments: (r) => ({ party_id: to('parties', r.party_id), account_id: to('accounts', r.account_id), created_by: me }),
      payment_allocs: (r) => ({ payment_id: to('payments', r.payment_id), doc_id: to('docs', r.doc_id), note_id: to('docs', r.note_id) }),
      journals: (r) => ({ ref_id: docOrPay(r), created_by: me }),
      journal_lines: (r) => ({ journal_id: to('journals', r.journal_id), account_id: to('accounts', r.account_id), party_id: to('parties', r.party_id) }),
      khata: (r) => ({ party_id: to('parties', r.party_id), created_by: me, reverses: to('khata', r.reverses) }),
      stock: (r) => ({ item_id: to('items', r.item_id), warehouse_id: to('warehouses', r.warehouse_id) }),
      stock_moves: (r) => ({ item_id: to('items', r.item_id), warehouse_id: to('warehouses', r.warehouse_id), ref_id: docOrPay(r) }),
      gate_entries: (r) => ({ party_id: to('parties', r.party_id), ref_doc_id: to('docs', r.ref_doc_id), grn_id: to('docs', r.grn_id), created_by: me }),
      vaade: (r) => ({ party_id: to('parties', r.party_id), doc_id: to('docs', r.doc_id), user_id: me }),
      vaada_kisht: (r) => ({ vaada_id: to('vaade', r.vaada_id), party_id: to('parties', r.party_id) }),
      recurring: (r) => ({ src_doc_id: to('docs', r.src_doc_id), last_doc_id: to('docs', r.last_doc_id), created_by: me, active: 0,
        last_error: 'Paused after the restore. Tap Resume to start it again.' }),
      reminder_log: (r) => ({ party_id: to('parties', r.party_id), user_id: me }),
      confirmations: (r) => ({ party_id: to('parties', r.party_id), created_by: me, token: randomHex(12) }),   // old links stay dead
      counters: () => ({}),
      org_files: () => ({}),
    };
    // a row whose own record of the link is gone is left out (it could not be shown or posted anyway)
    const NEED = { doc_lines: ['doc_id'], payment_allocs: ['payment_id', 'doc_id'], journal_lines: ['journal_id', 'account_id'], stock: ['item_id', 'warehouse_id'],
      vaada_kisht: ['vaada_id'], recurring: ['src_doc_id'], reminder_log: ['party_id'], confirmations: ['party_id'], stock_moves: ['item_id', 'warehouse_id'], payments: ['party_id', 'account_id'], khata: ['party_id'] };

    const st = [];
    const insert = (t, rows, verb = 'INSERT') => {
      const set = cols[t], out = [];
      for (const r of rows) {
        const fixed = { ...r, ...FIX[t](r) };
        if (set.has('org_id')) fixed.org_id = orgId;
        if (set.has('txk')) fixed.txk = uid();                 // one-time keys are unique across the database
        for (const k of required[t]) if ((fixed[k] === null || fixed[k] === undefined) && /_at$/.test(k)) fixed[k] = nowIso();
        if (ID_TABLES.includes(t)) { const nid = map[t].get(+r.id); if (!nid) continue; fixed.id = nid; }
        if ((NEED[t] || []).some((k) => fixed[k] === null || fixed[k] === undefined)) continue;
        out.push(fixed);
      }
      if (!out.length) return 0;
      const names = [...set].filter((k) => out.some((r) => Object.hasOwn(r, k)) || required[t].includes(k));
      let chunk = [], size = 0;
      const flush = () => { if (chunk.length) st.push(db.prepare(`${verb} INTO ${t} (${names.join(', ')}) VALUES ${chunk.join(', ')}`)); chunk = []; size = 0; };
      for (const r of out) {
        const v = '(' + names.map((k) => lit(r[k])).join(', ') + ')';
        if (size + v.length > MAX_SQL) flush();
        chunk.push(v); size += v.length + 2;
      }
      flush();
      return out.length;
    };

    // the business profile (never the plan)
    const o = backup.org && typeof backup.org === 'object' ? backup.org : {};
    const sets = [], vals = [];
    for (const k of ORG_FIELDS) {
      let v = o[k];
      if (v === undefined || v === null || typeof v === 'object') continue;
      v = String(v);
      if (JSON_FIELDS.includes(k)) { try { JSON.parse(v); } catch (e) { continue; } }
      if (k === 'name' && !v.trim()) continue;
      sets.push(`${k} = ?`); vals.push(k === 'name' ? v.slice(0, 120) : v.slice(0, 20000));
    }
    if (sets.length) st.push(db.prepare(`UPDATE orgs SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, orgId));
    if (firstWh && firstWh.name) st.push(db.prepare(`UPDATE warehouses SET name = ? WHERE id = ? AND org_id = ?`).bind(String(firstWh.name).slice(0, 80), myWh[0].id, orgId));

    // sign-up's own "Walk-in Customer" makes way for the one in the backup (the business is empty, so nothing points at it)
    st.unshift(db.prepare(`DELETE FROM parties WHERE org_id = ? AND name = 'Walk-in Customer'
      AND id NOT IN (SELECT party_id FROM docs WHERE org_id = ? AND party_id IS NOT NULL)`).bind(orgId, orgId));
    const counts = {};
    counts.accounts = insert('accounts', newAccounts);
    counts.warehouses = insert('warehouses', whs.filter((w) => w !== firstWh));
    for (const t of ['roles', 'parties', 'items', 'docs', 'doc_lines', 'payments', 'payment_allocs', 'journals', 'journal_lines', 'khata', 'stock', 'stock_moves',
      'gate_entries', 'vaade', 'vaada_kisht', 'recurring', 'reminder_log', 'confirmations']) counts[t] = insert(t, T[t]);
    counts.counters = insert('counters', T.counters, 'INSERT OR REPLACE');
    counts.org_files = insert('org_files', T.org_files.filter((f) => typeof f.data === 'string' && f.data.length <= 120000 && /^image\//.test(String(f.mime))), 'INSERT OR REPLACE');
    // promise stats are kept by a trigger on changes only, so they are worked out once here
    st.push(db.prepare(`INSERT INTO vaada_stats (org_id, party_id, kept, broken)
      SELECT org_id, party_id, SUM(outcome IS 'kept'), SUM(outcome IS 'broken') FROM vaada_kisht WHERE org_id = ? GROUP BY party_id
      ON CONFLICT (org_id, party_id) DO UPDATE SET kept = excluded.kept, broken = excluded.broken`).bind(orgId));
    const records = Object.values(counts).reduce((n, x) => n + x, 0);
    st.push(auditStatement(c, 'restore', `${records} records from the backup of ${String(backup.exported_at || '').slice(0, 10) || 'an unknown date'}`));
    await db.batch(st);
    return { records, counts, staff_not_restored: rowsOf('users').filter((u) => u.role !== 'owner').length };
  };

  const damaged = (e) => /NOT NULL constraint|CHECK constraint|datatype mismatch|UNIQUE constraint/i.test(String(e && e.message));
  try { return await attempt(50); } catch (e) {
    // another business took an id between our read and the write: try once more with a bigger gap
    if (/UNIQUE constraint failed: \w+\.id\b/i.test(String(e && e.message))) {
      try { return await attempt(5000); } catch (e2) { if (damaged(e2)) throw bad('This backup file is damaged or incomplete, so nothing was restored.'); throw e2; }
    }
    if (damaged(e)) throw bad('This backup file is damaged or incomplete, so nothing was restored.');
    throw e;
  }
}
