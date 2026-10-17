/* Reports. Financial statements come only from the ledger (journal_lines), so they always agree;
   stock reports come from the stock tables; GST from the documents. Amounts returned in rupees. */
import { addDays, today, date as vDate, bad } from './lib.js';

const R = (p) => Math.round(p) / 100;

export function fyStart(org, asOf = today()) {
  const [mm, dd] = (org.fy_start || '04-01').split('-');
  let y = +asOf.slice(0, 4);
  const start = `${y}-${mm}-${dd}`;
  return asOf >= start ? start : `${y - 1}-${mm}-${dd}`;
}
export function period(org, q) {
  const to = q.get('to') ? vDate(q.get('to'), 'To date') : today();
  const from = q.get('from') ? vDate(q.get('from'), 'From date') : fyStart(org, to);
  if (from > to) throw bad('"From" must be on or before "to".');
  return { from, to };
}

/* Debit/credit totals per account between two dates, from summaries kept by triggers: whole months from
   acct_month, the part-months at either end from acct_day. The journal itself is never scanned here. */
const ymd = (d) => d.toISOString().slice(0, 10);
function monthSpan(from, to) {
  let start = from.slice(8, 10) === '01' ? from : null;
  if (!start) { const d = new Date(from.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); start = ymd(d); }
  const next = new Date(to + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
  let end = next.getUTCDate() === 1 ? to : null;           // `to` is the last day of its month
  if (!end) { const d = new Date(to.slice(0, 7) + '-01T00:00:00Z'); d.setUTCDate(0); end = ymd(d); }
  return start <= end ? { start, end } : null;
}
const dayShift = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return ymd(x); };
const ACCOUNTS_SQL = `SELECT id, code, name, type, sys, is_cash FROM accounts WHERE org_id = ? ORDER BY code`;
// the statements that total each account between two dates (run them in a batch, then add them up with sumBalances)
function balanceStatements(db, orgId, from, to) {
  if (from < '0001-01-01') from = '0001-01-01';
  if (to > '9998-12-31') to = '9998-12-31';           // keep date maths inside 4-digit years
  const st = [];
  const raw = (a, b) => { if (a <= b) st.push(db.prepare(`SELECT account_id, SUM(dr) AS dr, SUM(cr) AS cr FROM acct_day WHERE org_id = ? AND d >= ? AND d <= ? GROUP BY account_id`).bind(orgId, a, b)); };
  const span = monthSpan(from, to);
  if (!span) raw(from, to);
  else {
    st.push(db.prepare(`SELECT account_id, SUM(dr) AS dr, SUM(cr) AS cr FROM acct_month WHERE org_id = ? AND ym >= ? AND ym <= ? GROUP BY account_id`)
      .bind(orgId, span.start.slice(0, 7), span.end.slice(0, 7)));
    raw(from, dayShift(span.start, -1));
    raw(dayShift(span.end, 1), to);
  }
  return st;
}
function sumBalances(accts, results) {
  const tot = new Map(accts.map((a) => [a.id, { ...a, dr: 0, cr: 0 }]));
  for (const res of results) for (const r of res.results) { const t = tot.get(r.account_id); if (t) { t.dr += r.dr; t.cr += r.cr; } }
  return [...tot.values()];
}
export async function accountBalances(db, orgId, from, to) {
  const [accts, ...rest] = await db.batch([db.prepare(ACCOUNTS_SQL).bind(orgId), ...balanceStatements(db, orgId, from, to)]);
  return sumBalances(accts.results, rest);
}

export async function trialBalance(db, org, q) {
  const to = q.get('to') ? vDate(q.get('to')) : today();
  const rows = (await accountBalances(db, org.id, '0000-01-01', to)).filter((r) => r.dr || r.cr);
  const out = rows.map((r) => {
    const net = r.dr - r.cr;
    return { code: r.code, name: r.name, type: r.type, debit: net > 0 ? R(net) : 0, credit: net < 0 ? R(-net) : 0 };
  });
  const totDr = rows.reduce((s, r) => s + Math.max(0, r.dr - r.cr), 0), totCr = rows.reduce((s, r) => s + Math.max(0, r.cr - r.dr), 0);
  return { to, rows: out, total_debit: R(totDr), total_credit: R(totCr), balanced: totDr === totCr };
}

export async function profitLoss(db, org, q) {
  const { from, to } = period(org, q);
  return plFrom(from, to, await accountBalances(db, org.id, from, to));
}
function plFrom(from, to, rows) {
  const income = rows.filter((r) => r.type === 'income').map((r) => ({ code: r.code, name: r.name, sys: r.sys, amount: r.cr - r.dr }));
  const expense = rows.filter((r) => r.type === 'expense').map((r) => ({ code: r.code, name: r.name, sys: r.sys, amount: r.dr - r.cr }));
  const sales = income.filter((r) => r.sys === 'sales').reduce((s, r) => s + r.amount, 0);
  const cogs = expense.filter((r) => r.sys === 'cogs').reduce((s, r) => s + r.amount, 0);
  const totI = income.reduce((s, r) => s + r.amount, 0), totE = expense.reduce((s, r) => s + r.amount, 0);
  const keep = (r) => r.amount !== 0;
  return {
    from, to,
    income: income.filter(keep).map((r) => ({ ...r, amount: R(r.amount) })),
    expense: expense.filter(keep).map((r) => ({ ...r, amount: R(r.amount) })),
    sales: R(sales), cogs: R(cogs), gross_profit: R(sales - cogs),
    gross_margin: sales ? Math.round((sales - cogs) / sales * 1000) / 10 : 0,
    total_income: R(totI), total_expense: R(totE), net_profit: R(totI - totE),
  };
}

export async function balanceSheet(db, org, q) {
  const to = q.get('to') ? vDate(q.get('to')) : today();
  const rows = await accountBalances(db, org.id, '0000-01-01', to);
  const pick = (type, sign) => rows.filter((r) => r.type === type).map((r) => ({ code: r.code, name: r.name, amount: sign * (r.dr - r.cr) })).filter((r) => r.amount);
  const assets = pick('asset', 1), liabilities = pick('liability', -1), equity = pick('equity', -1);
  const profit = rows.filter((r) => r.type === 'income').reduce((s, r) => s + r.cr - r.dr, 0) - rows.filter((r) => r.type === 'expense').reduce((s, r) => s + r.dr - r.cr, 0);
  equity.push({ code: '', name: 'Profit & Loss (retained earnings)', amount: profit });
  const sum = (a) => a.reduce((s, r) => s + r.amount, 0);
  const tA = sum(assets), tL = sum(liabilities), tE = sum(equity);
  const fmt = (a) => a.map((r) => ({ ...r, amount: R(r.amount) }));
  return { to, assets: fmt(assets), liabilities: fmt(liabilities), equity: fmt(equity),
    total_assets: R(tA), total_liabilities: R(tL), total_equity: R(tE), balanced: tA === tL + tE };
}

export async function gstSummary(db, org, q) {
  const { from, to } = period(org, q);
  const { results } = await db.prepare(`
    SELECT d.type, l.gst_rate, CASE WHEN p.gstin != '' THEN 'B2B' ELSE 'B2C' END AS kind,
           SUM(l.taxable) AS taxable, SUM(l.cgst) AS cgst, SUM(l.sgst) AS sgst, SUM(l.igst) AS igst, COUNT(DISTINCT d.id) AS docs
    FROM docs d JOIN doc_lines l ON l.doc_id = d.id LEFT JOIN parties p ON p.id = d.party_id
    WHERE d.org_id = ? AND d.type IN ('INV','SRET','CNOTE','BILL','PRET','DNOTE') AND d.status != 'cancelled' AND d.date >= ? AND d.date <= ?
    GROUP BY d.type, l.gst_rate, kind ORDER BY l.gst_rate`).bind(org.id, from, to).all();
  const acc = (types) => {
    const by = {};
    for (const r of results.filter((x) => types.includes(x.type))) {
      const sign = ['SRET', 'PRET', 'CNOTE', 'DNOTE'].includes(r.type) ? -1 : 1;
      const k = r.gst_rate + '|' + r.kind;
      by[k] = by[k] || { rate: r.gst_rate, kind: r.kind, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      for (const f of ['taxable', 'cgst', 'sgst', 'igst']) by[k][f] += sign * r[f];
    }
    const rows = Object.values(by).sort((a, b) => a.rate - b.rate || a.kind.localeCompare(b.kind));
    const tot = rows.reduce((s, r) => ({ taxable: s.taxable + r.taxable, cgst: s.cgst + r.cgst, sgst: s.sgst + r.sgst, igst: s.igst + r.igst }), { taxable: 0, cgst: 0, sgst: 0, igst: 0 });
    const f = (r) => ({ ...r, taxable: R(r.taxable), cgst: R(r.cgst), sgst: R(r.sgst), igst: R(r.igst), tax: R(r.cgst + r.sgst + r.igst) });
    return { rows: rows.map(f), total: f(tot), _tax: tot.cgst + tot.sgst + tot.igst };
  };
  const out = acc(['INV', 'SRET', 'CNOTE']), inp = acc(['BILL', 'PRET', 'DNOTE']);
  return { from, to, outward: { rows: out.rows, total: out.total }, inward: { rows: inp.rows, total: inp.total }, net_payable: R(out._tax - inp._tax) };
}

export async function ageing(db, org, q) {
  const kind = q.get('kind') === 'payable' ? 'payable' : 'receivable';
  const asOf = q.get('to') ? vDate(q.get('to')) : today();
  const { results } = await db.prepare(`
    SELECT d.id, d.number, d.date, d.due_date, d.total, d.paid, p.id AS party_id, p.name AS party, p.phone
    FROM docs d JOIN parties p ON p.id = d.party_id
    WHERE d.org_id = ? AND d.type = ? AND d.status IN ('unpaid','partial') ORDER BY d.due_date`).bind(org.id, kind === 'receivable' ? 'INV' : 'BILL').all();
  const buckets = ['current', '1-30', '31-60', '61-90', '90+'];
  const parties = {};
  for (const d of results) {
    const due = Math.round((Date.parse(asOf) - Date.parse(d.due_date || d.date)) / 864e5);
    const b = due <= 0 ? 'current' : due <= 30 ? '1-30' : due <= 60 ? '31-60' : due <= 90 ? '61-90' : '90+';
    const p = parties[d.party_id] = parties[d.party_id] || { party_id: d.party_id, party: d.party, phone: d.phone, total: 0, docs: [], ...Object.fromEntries(buckets.map((x) => [x, 0])) };
    const bal = d.total - d.paid;
    p[b] += bal; p.total += bal;
    p.docs.push({ id: d.id, number: d.number, date: d.date, due_date: d.due_date, balance: R(bal), days_overdue: Math.max(0, due) });
  }
  const rows = Object.values(parties).sort((a, b) => b.total - a.total).map((p) => ({ ...p, total: R(p.total), ...Object.fromEntries(buckets.map((x) => [x, R(p[x])])) }));
  const totals = Object.fromEntries(['total', ...buckets].map((k) => [k, Math.round(rows.reduce((s, r) => s + r[k] * 100, 0)) / 100]));
  return { kind, as_of: asOf, buckets, rows, totals };
}

const stockRow = (i) => ({
  id: i.id, sku: i.sku, name: i.name, category: i.category, unit: i.unit, qty: i.qty_on_hand, location: i.location || '',
  avg_cost: R(i.avg_cost), value: R(Math.max(0, i.qty_on_hand) * i.avg_cost), reorder_level: i.reorder_level,
  status: i.qty_on_hand <= 0 ? 'out' : i.qty_on_hand <= i.reorder_level ? 'reorder' : 'ok',
  suggested_order: i.qty_on_hand <= i.reorder_level ? Math.max(0, 2 * i.reorder_level - i.qty_on_hand) : 0,
});
export async function stockReport(db, org) {
  const { results: items } = await db.prepare(`SELECT id, sku, name, category, unit, qty_on_hand, avg_cost, reorder_level, sale_price, gst_rate, location
      FROM items WHERE org_id = ? AND is_service = 0 ORDER BY name`).bind(org.id).all();
  const { results: wh } = await db.prepare(`SELECT s.item_id, w.name AS warehouse, s.qty FROM stock s JOIN warehouses w ON w.id = s.warehouse_id
      WHERE s.org_id = ? AND ABS(s.qty) > 0.0005`).bind(org.id).all();
  const by = {};
  for (const r of wh) (by[r.item_id] = by[r.item_id] || []).push({ warehouse: r.warehouse, qty: r.qty });
  const rows = items.map((i) => ({ ...stockRow(i), warehouses: by[i.id] || [] }));
  return { rows, total_value: Math.round(rows.reduce((s, r) => s + r.value * 100, 0)) / 100,
    reorder_count: rows.filter((r) => r.status !== 'ok').length };
}

export async function itemMoves(db, org, itemId) {
  const { results } = await db.prepare(`SELECT m.date, m.qty, m.unit_cost, m.value, m.ref_type, m.ref_id, m.note, w.name AS warehouse, d.number
      FROM stock_moves m JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN docs d ON d.id = m.ref_id AND m.ref_type = d.type
      WHERE m.org_id = ? AND m.item_id = ? ORDER BY m.date, m.id`).bind(org.id, itemId).all();
  let bal = 0;
  return results.map((m) => ({ ...m, unit_cost: R(m.unit_cost), value: R(m.value), balance: (bal = Math.round((bal + m.qty) * 1000) / 1000) }));
}

export async function partyLedger(db, org, partyId, q) {
  const { from, to } = period(org, q);
  const sysAcc = await db.prepare(`SELECT id FROM accounts WHERE org_id = ? AND sys IN ('ar','ap')`).bind(org.id).all();
  const ids = sysAcc.results.map((r) => r.id);
  const open = await db.prepare(`SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE org_id = ? AND party_id = ? AND account_id IN (?, ?) AND date < ?`)
    .bind(org.id, partyId, ids[0], ids[1], from).first();
  const { results } = await db.prepare(`SELECT jl.date, jl.debit, jl.credit, j.narration, j.ref_type, j.ref_id,
        COALESCE(d.number, p.number) AS number
      FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
      LEFT JOIN docs d ON d.id = j.ref_id AND j.ref_type IN ('INV','SRET','CNOTE','BILL','PRET','DNOTE')
      LEFT JOIN payments p ON p.id = j.ref_id AND j.ref_type IN ('receipt','payment')
      WHERE jl.org_id = ? AND jl.party_id = ? AND jl.account_id IN (?, ?) AND jl.date >= ? AND jl.date <= ?
      ORDER BY jl.date, jl.id`).bind(org.id, partyId, ids[0], ids[1], from, to).all();
  let bal = open.b;
  const rows = results.map((r) => ({ date: r.date, number: r.number || '', narration: r.narration, ref_type: r.ref_type, ref_id: r.ref_id,
    debit: R(r.debit), credit: R(r.credit), balance: R(bal += r.debit - r.credit) }));
  return { from, to, opening: R(open.b), rows, closing: R(bal), note: 'Positive balance: the party owes you. Negative: you owe the party.' };
}

export async function partyBalances(db, orgId) {
  const { results } = await db.prepare(`SELECT party_id, bal FROM party_bal WHERE org_id = ?`).bind(orgId).all();
  return Object.fromEntries(results.map((r) => [r.party_id, r.bal]));
}

export async function dayBook(db, org, q) {
  const { from, to } = period(org, q);
  const { results } = await db.prepare(`SELECT j.id, j.date, j.narration, j.ref_type, a.code, a.name AS account, jl.debit, jl.credit, pt.name AS party
      FROM journals j JOIN journal_lines jl ON jl.journal_id = j.id JOIN accounts a ON a.id = jl.account_id LEFT JOIN parties pt ON pt.id = jl.party_id
      WHERE j.org_id = ? AND j.date >= ? AND j.date <= ? ORDER BY j.date DESC, j.id DESC, jl.id LIMIT 2000`).bind(org.id, from, to).all();
  const by = new Map();
  for (const r of results) {
    if (!by.has(r.id)) by.set(r.id, { id: r.id, date: r.date, narration: r.narration, ref_type: r.ref_type, lines: [] });
    by.get(r.id).lines.push({ account: `${r.code} ${r.account}`, party: r.party || '', debit: R(r.debit), credit: R(r.credit) });
  }
  return { from, to, entries: [...by.values()] };
}

export async function accountLedger(db, org, accountId, q) {
  const { from, to } = period(org, q);
  const a = await db.prepare(`SELECT * FROM accounts WHERE id = ? AND org_id = ?`).bind(accountId, org.id).first();
  if (!a) throw bad('Unknown account.');
  const open = await db.prepare(`SELECT COALESCE(SUM(debit - credit), 0) AS b FROM journal_lines WHERE org_id = ? AND account_id = ? AND date < ?`).bind(org.id, a.id, from).first();
  const { results } = await db.prepare(`SELECT jl.date, jl.debit, jl.credit, j.narration, pt.name AS party FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id LEFT JOIN parties pt ON pt.id = jl.party_id
      WHERE jl.org_id = ? AND jl.account_id = ? AND jl.date >= ? AND jl.date <= ? ORDER BY jl.date, jl.id`).bind(org.id, a.id, from, to).all();
  let bal = open.b;
  return { account: { id: a.id, code: a.code, name: a.name, type: a.type }, from, to, opening: R(open.b),
    rows: results.map((r) => ({ ...r, debit: R(r.debit), credit: R(r.credit), balance: R(bal += r.debit - r.credit) })), closing: R(bal) };
}

/* The dashboard in one D1 call. Sales and purchase totals come from doc_month (month totals kept by triggers);
   only the current month, and a part month at the start of the year, are read from the documents. */
const nextYm = (ym) => { const d = new Date(ym + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); return ymd(d).slice(0, 7); };
const monthEnd = (day) => dayShift(nextYm(day.slice(0, 7)) + '-01', -1);
export async function dashboard(db, org) {
  const t = today(), fy = fyStart(org, t), monthStart = t.slice(0, 8) + '01', curYm = t.slice(0, 7), fyYm = fy.slice(0, 7);
  const months = [];
  for (let i = 11; i >= 0; i--) months.push(new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1 - i, 1)).toISOString().slice(0, 7));
  const st = [], at = {};
  const add = (k, ...list) => { at[k] = [st.length, list.length]; st.push(...list); };
  const docSum = (a, b) => db.prepare(`SELECT type, COUNT(*) AS n, COALESCE(SUM(taxable), 0) AS v FROM docs
      WHERE org_id = ? AND type IN ('INV','BILL','SRET') AND status != 'cancelled' AND date >= ? AND date <= ? GROUP BY type`).bind(org.id, a, b);
  add('accts', db.prepare(ACCOUNTS_SQL).bind(org.id));
  add('bal', ...balanceStatements(db, org.id, '0000-01-01', t));
  add('pl', ...balanceStatements(db, org.id, fy, t));
  add('month', docSum(monthStart, t));
  // the year so far: whole months from doc_month, plus a part month at the start when the year does not start on the 1st
  const fyWhole = fy < monthStart ? (fy.slice(8) === '01' ? fyYm : nextYm(fyYm)) : null;
  if (fy > monthStart) add('fyDocs', docSum(fy, t));
  else if (fy < monthStart && fy.slice(8) !== '01') add('fyDocs', docSum(fy, monthEnd(fy)));
  add('dm', db.prepare(`SELECT type, ym, n, taxable FROM doc_month WHERE org_id = ? AND type IN ('INV','BILL','SRET','CNOTE') AND ym >= ? AND ym <= ?`)
    .bind(org.id, fyYm < months[0] ? fyYm : months[0], curYm));
  add('stock', db.prepare(`SELECT COALESCE(SUM(ROUND(MAX(0, qty_on_hand) * avg_cost)), 0) AS v, COALESCE(SUM(qty_on_hand <= 0 OR qty_on_hand <= reorder_level), 0) AS n
      FROM items WHERE org_id = ? AND is_service = 0`).bind(org.id));
  add('low', db.prepare(`SELECT id, sku, name, category, unit, qty_on_hand, avg_cost, reorder_level, location FROM items
      WHERE org_id = ? AND is_service = 0 AND (qty_on_hand <= 0 OR qty_on_hand <= reorder_level) ORDER BY name LIMIT 10`).bind(org.id));
  add('overdue', db.prepare(`SELECT d.id, d.number, d.due_date, d.total - d.paid AS balance, p.name AS party FROM docs d
      JOIN parties p ON p.id = d.party_id WHERE d.org_id = ? AND d.type = 'INV' AND d.status IN ('unpaid','partial') AND d.due_date < ?
      ORDER BY d.due_date LIMIT 10`).bind(org.id, t));
  add('recent', db.prepare(`SELECT d.id, d.type, d.number, d.date, d.total, d.status, p.name AS party FROM docs d
      LEFT JOIN parties p ON p.id = d.party_id WHERE d.org_id = ? ORDER BY d.id DESC LIMIT 8`).bind(org.id));
  const res = await db.batch(st);
  const all = (k) => res.slice(at[k][0], at[k][0] + at[k][1]);
  const rows = (k) => all(k)[0].results;
  const accts = rows('accts');
  const bal = sumBalances(accts, all('bal'));
  const pl = plFrom(fy, t, sumBalances(accts, all('pl')));
  const bySys = Object.fromEntries(bal.filter((r) => r.sys).map((r) => [r.sys, r.dr - r.cr]));
  const cash = bal.filter((r) => r.is_cash).map((r) => ({ id: r.id, name: r.name, balance: R(r.dr - r.cr) }));
  const dm = rows('dm');
  const sums = (list) => { const o = {}; for (const r of list) { const x = o[r.type] = o[r.type] || { n: 0, v: 0 }; x.n += r.n; x.v += r.v; } return o; };
  const month = sums(rows('month'));
  const year = sums([...(fy <= monthStart ? rows('month') : []), ...(at.fyDocs ? rows('fyDocs') : []),
    ...(fyWhole ? dm.filter((r) => r.ym >= fyWhole && r.ym < curYm).map((r) => ({ type: r.type, n: r.n, v: r.taxable })) : [])]);
  const g = (o, ty, f = 'v') => (o[ty] ? o[ty][f] : 0);
  const sv = (m, ty) => (dm.find((s) => s.ym === m && s.type === ty) || { taxable: 0 }).taxable;
  const stock = rows('stock')[0];
  return {
    today: t, fy_start: fy,
    sales_month: R(g(month, 'INV') - g(month, 'SRET')), sales_fy: R(g(year, 'INV') - g(year, 'SRET')), invoices_fy: g(year, 'INV', 'n'), purchases_fy: R(g(year, 'BILL')),
    gross_profit_fy: pl.gross_profit, net_profit_fy: pl.net_profit, gross_margin: pl.gross_margin,
    receivable: R(bySys.ar || 0), payable: R(-(bySys.ap || 0)), gst_payable: R(-(bySys.gst_output || 0) - (bySys.gst_input || 0)),
    stock_value: R(stock.v), reorder_count: stock.n, cash,
    low_stock: rows('low').map(stockRow),
    overdue: rows('overdue').map((o) => ({ ...o, balance: R(o.balance) })),
    recent: rows('recent').map((r) => ({ ...r, total: R(r.total) })),
    monthly: months.map((m) => ({ month: m, sales: R(sv(m, 'INV') - sv(m, 'SRET') - sv(m, 'CNOTE')), purchases: R(sv(m, 'BILL')) })),
  };
}

export async function register(db, org, q) {
  const { from, to } = period(org, q);
  const type = (q.get('type') || 'INV').toUpperCase();
  const { results } = await db.prepare(`SELECT d.id, d.number, d.date, d.status, p.name AS party, p.gstin, d.taxable, d.cgst, d.sgst, d.igst, d.total, d.paid
      FROM docs d LEFT JOIN parties p ON p.id = d.party_id WHERE d.org_id = ? AND d.type = ? AND d.date >= ? AND d.date <= ? ORDER BY d.date, d.id`)
    .bind(org.id, type, from, to).all();
  return { from, to, type, rows: results.map((r) => ({ ...r, taxable: R(r.taxable), cgst: R(r.cgst), sgst: R(r.sgst), igst: R(r.igst), total: R(r.total), paid: R(r.paid) })) };
}

export { addDays };
