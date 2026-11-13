/* Dashboard widgets and saved dashboards.
   Each widget is one small question about the business ("sales in this period", "who owes the most"), answered from the
   business's own records for the period the dashboard shows, with the period before it for comparison. A widget is only
   answered for a user whose role may see that area (and, for anything that reveals costs or profit, may see costs), so a
   dashboard shared by the owner never shows a salesman more than his role already lets him see.
   Dashboards are saved per user (name, period, widgets in order with their size); the owner or an admin can share one with
   everyone in the business, and each user picks the one that opens first. */
import { bad, notFound, str, nowIso, today, addDays } from './lib.js';
import { canView, seesCosts, can } from './auth.js';
import { accountBalances, fyStart } from './reports.js';

const R = (p) => Math.round(p) / 100;
const fmtD = (iso) => (iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');

/* ---------- the period ---------- */
export const RANGES = { today: 'Today', '7d': 'Last 7 days', month: 'This month', '30d': 'Last 30 days', last_month: 'Last month', quarter: 'This quarter', fy: 'This financial year' };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
export function periodOf(org, key, from, to) {
  const t = today();
  let a = t, b = t;
  if (key === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(from || '') && /^\d{4}-\d{2}-\d{2}$/.test(to || '') && from <= to) { a = from; b = to; }
  else if (key === '7d') a = addDays(t, -6);
  else if (key === '30d') a = addDays(t, -29);
  else if (key === 'last_month') { const d = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 2, 1)); a = d.toISOString().slice(0, 10); b = addDays(t.slice(0, 8) + '01', -1); }
  else if (key === 'quarter') { const m = +t.slice(5, 7), qm = [4, 7, 10, 1].find((s) => m >= s && m < s + 3) || 1; a = `${t.slice(0, 4)}-${String(qm).padStart(2, '0')}-01`; }
  else if (key === 'fy') a = fyStart(org, t);
  else if (key !== 'today') a = t.slice(0, 8) + '01';                    // this month (the default)
  if (days(a, b) > 731) a = addDays(b, -730);
  const n = days(a, b);
  return { key: RANGES[key] || key === 'custom' ? key : 'month', from: a, to: b, days: n, pfrom: addDays(a, -n), pto: addDays(a, -1), monthly: n > 62 };
}
/* the buckets of a chart: each day, or each month for a long period */
function buckets(p, from = p.from, to = p.to) {
  const out = [];
  if (p.monthly) { for (let d = from.slice(0, 7); d <= to.slice(0, 7); d = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 1)).toISOString().slice(0, 7)) out.push(d); }
  else for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
const bucketSql = (p, col = 'date') => (p.monthly ? `substr(${col}, 1, 7)` : col);
const fill = (keys, rows, field = 'v') => { const m = new Map(rows.map((r) => [r.k, r[field] || 0])); return keys.map((k) => R(m.get(k) || 0)); };

/* ---------- the widgets ---------- */
const SALES = `('INV')`, NET_SALES = `CASE WHEN type = 'INV' THEN taxable ELSE -taxable END`;
const one = async (c, sql, ...args) => (await c.db.prepare(sql).bind(...args).first()) || {};
const all = async (c, sql, ...args) => (await c.db.prepare(sql).bind(...args).all()).results;
const salesIn = (c, a, b) => one(c, `SELECT COALESCE(SUM(${NET_SALES}), 0) AS v, SUM(type = 'INV') AS n FROM docs
  WHERE org_id = ? AND type IN ('INV','SRET') AND status != 'cancelled' AND date >= ? AND date <= ?`, c.org.id, a, b);
const seriesOf = async (c, p, types, value, from, to) => {
  const keys = buckets(p, from, to);
  const rows = await all(c, `SELECT ${bucketSql(p)} AS k, SUM(${value}) AS v FROM docs WHERE org_id = ? AND type IN ${types} AND status != 'cancelled'
    AND date >= ? AND date <= ? GROUP BY k`, c.org.id, from, to);
  return fill(keys, rows);
};
const cashAccounts = (c) => accountBalances(c.db, c.org.id, '0000-01-01', today()).then((rows) => rows.filter((r) => r.is_cash));

export const WIDGETS = {
  // sales
  sales_today: { cat: 'Sales', label: "Today's sales", area: 'sales', size: 1, link: 'reports/register?type=INV', async run(c) {
    const t = today();
    const [now, before, spark] = await Promise.all([salesIn(c, t, t), salesIn(c, addDays(t, -7), addDays(t, -7)),
      seriesOf(c, { monthly: false }, `('INV','SRET')`, NET_SALES, addDays(t, -13), t)]);
    return { kind: 'kpi', value: R(now.v), prev: R(before.v), vs: 'same day last week', sub: `${now.n || 0} invoice${now.n === 1 ? '' : 's'}, before GST`, spark };
  } },
  sales_period: { cat: 'Sales', label: 'Sales', area: 'sales', size: 1, link: 'reports/register?type=INV', async run(c, p) {
    const [now, before, spark] = await Promise.all([salesIn(c, p.from, p.to), salesIn(c, p.pfrom, p.pto), seriesOf(c, p, `('INV','SRET')`, NET_SALES, p.from, p.to)]);
    return { kind: 'kpi', value: R(now.v), prev: R(before.v), vs: 'previous period', sub: `${now.n || 0} invoice${now.n === 1 ? '' : 's'}, before GST, less returns`, spark };
  } },
  sales_trend: { cat: 'Sales', label: 'Sales overview', area: 'sales', size: 2, link: 'reports/register?type=INV', async run(c, p) {
    const [cur, prev] = await Promise.all([seriesOf(c, p, `('INV','SRET')`, NET_SALES, p.from, p.to), seriesOf(c, p, `('INV','SRET')`, NET_SALES, p.pfrom, p.pto)]);
    return { kind: 'series', labels: buckets(p), series: [{ name: 'This period', values: cur }, { name: 'Period before', values: prev.slice(-cur.length), faint: true }], monthly: p.monthly };
  } },
  avg_invoice: { cat: 'Sales', label: 'Average invoice', area: 'sales', size: 1, link: 'sales/INV', async run(c, p) {
    const q = (a, b) => one(c, `SELECT COALESCE(AVG(total), 0) AS v, COUNT(*) AS n FROM docs WHERE org_id = ? AND type = 'INV' AND status != 'cancelled' AND date >= ? AND date <= ?`, c.org.id, a, b);
    const [now, before] = await Promise.all([q(p.from, p.to), q(p.pfrom, p.pto)]);
    return { kind: 'kpi', value: R(now.v), prev: R(before.v), vs: 'previous period', sub: `${now.n} invoice${now.n === 1 ? '' : 's'}, with GST` };
  } },
  sales_returns: { cat: 'Sales', label: 'Sales returns', area: 'sales', size: 1, link: 'sales/SRET', down: true, async run(c, p) {
    const q = (a, b) => one(c, `SELECT COALESCE(SUM(total), 0) AS v, COUNT(*) AS n FROM docs WHERE org_id = ? AND type = 'SRET' AND status != 'cancelled' AND date >= ? AND date <= ?`, c.org.id, a, b);
    const [now, before] = await Promise.all([q(p.from, p.to), q(p.pfrom, p.pto)]);
    return { kind: 'kpi', value: R(now.v), prev: R(before.v), vs: 'previous period', sub: `${now.n} return${now.n === 1 ? '' : 's'}` };
  } },
  product_sales: { cat: 'Sales', label: 'Revenue by product', area: 'sales', size: 2, link: 'items', async run(c, p) {
    const rows = await all(c, `SELECT COALESCE(i.name, l.description) AS name, l.item_id AS id, SUM(l.qty) AS qty, SUM(l.taxable) AS v, i.unit FROM doc_lines l JOIN docs d ON d.id = l.doc_id
      LEFT JOIN items i ON i.id = l.item_id WHERE d.org_id = ? AND d.type = 'INV' AND d.status != 'cancelled' AND d.date >= ? AND d.date <= ?
      GROUP BY COALESCE(l.item_id, l.description) ORDER BY v DESC LIMIT 8`, c.org.id, p.from, p.to);
    return { kind: 'bars', rows: rows.map((r) => ({ label: r.name, value: R(r.v), note: `${Math.round(r.qty * 1000) / 1000} ${r.unit || ''}`.trim(), href: r.id ? `item/${r.id}` : '' })) };
  } },
  customer_sales: { cat: 'Customers', label: 'Top customers', area: 'sales', size: 2, link: 'parties', async run(c, p) {
    const rows = await all(c, `SELECT p.id, p.name, COUNT(*) AS n, SUM(d.taxable) AS v FROM docs d JOIN parties p ON p.id = d.party_id
      WHERE d.org_id = ? AND d.type = 'INV' AND d.status != 'cancelled' AND d.date >= ? AND d.date <= ? AND p.name != 'Walk-in Customer'
      GROUP BY d.party_id ORDER BY v DESC LIMIT 8`, c.org.id, p.from, p.to);
    return { kind: 'bars', rows: rows.map((r) => ({ label: r.name, value: R(r.v), note: `${r.n} bill${r.n === 1 ? '' : 's'}`, href: `party/${r.id}` })) };
  } },
  new_customers: { cat: 'Customers', label: 'New customers', area: 'masters', size: 1, link: 'parties', async run(c, p) {
    const q = (a, b) => one(c, `SELECT COUNT(*) AS v FROM parties WHERE org_id = ? AND kind != 'supplier' AND substr(created_at, 1, 10) >= ? AND substr(created_at, 1, 10) <= ?`, c.org.id, a, b);
    const [now, before] = await Promise.all([q(p.from, p.to), q(p.pfrom, p.pto)]);
    return { kind: 'kpi', unit: 'count', value: now.v, prev: before.v, vs: 'previous period', sub: 'added as customers' };
  } },
  customer_dues: { cat: 'Customers', label: 'Customers who owe the most', area: 'sales', size: 2, link: 'reminders', async run(c) {
    const rows = await all(c, `SELECT p.id, p.name, SUM(d.total - d.paid) AS v, MIN(COALESCE(d.due_date, d.date)) AS due FROM docs d JOIN parties p ON p.id = d.party_id
      WHERE d.org_id = ? AND d.type = 'INV' AND d.status IN ('unpaid','partial') GROUP BY d.party_id ORDER BY v DESC LIMIT 8`, c.org.id);
    const t = today();
    // walk-in bills left unpaid are usually cash sales whose payment was not entered: say so, there is nobody to ask
    return { kind: 'bars', rows: rows.map((r) => ({ label: r.name, value: R(r.v), note: r.name === 'Walk-in Customer' ? 'cash bills not marked paid: check'
      : r.due < t ? `late since ${fmtD(r.due)}` : `due ${fmtD(r.due)}`, warn: r.due < t, href: r.name === 'Walk-in Customer' ? 'sales/INV?status=unpaid' : `party/${r.id}` })) };
  } },
  // purchase
  purchase_period: { cat: 'Purchase', label: 'Purchases', area: 'purchase', size: 1, link: 'purchase/BILL', down: true, async run(c, p) {
    const q = (a, b) => one(c, `SELECT COALESCE(SUM(CASE WHEN type = 'BILL' THEN taxable ELSE -taxable END), 0) AS v, SUM(type = 'BILL') AS n FROM docs
      WHERE org_id = ? AND type IN ('BILL','PRET') AND status != 'cancelled' AND date >= ? AND date <= ?`, c.org.id, a, b);
    const [now, before, spark] = await Promise.all([q(p.from, p.to), q(p.pfrom, p.pto), seriesOf(c, p, `('BILL','PRET')`, `CASE WHEN type = 'BILL' THEN taxable ELSE -taxable END`, p.from, p.to)]);
    return { kind: 'kpi', value: R(now.v), prev: R(before.v), vs: 'previous period', sub: `${now.n || 0} bills, before GST`, spark };
  } },
  purchase_trend: { cat: 'Purchase', label: 'Purchase trend', area: 'purchase', size: 2, link: 'purchase/BILL', async run(c, p) {
    const v = `CASE WHEN type = 'BILL' THEN taxable ELSE -taxable END`;
    const [cur, prev] = await Promise.all([seriesOf(c, p, `('BILL','PRET')`, v, p.from, p.to), seriesOf(c, p, `('BILL','PRET')`, v, p.pfrom, p.pto)]);
    return { kind: 'series', labels: buckets(p), series: [{ name: 'This period', values: cur }, { name: 'Period before', values: prev.slice(-cur.length), faint: true }], monthly: p.monthly };
  } },
  supplier_purchases: { cat: 'Suppliers', label: 'Top suppliers', area: 'purchase', size: 2, link: 'parties', async run(c, p) {
    const rows = await all(c, `SELECT p.id, p.name, COUNT(*) AS n, SUM(d.taxable) AS v FROM docs d JOIN parties p ON p.id = d.party_id
      WHERE d.org_id = ? AND d.type = 'BILL' AND d.status != 'cancelled' AND d.date >= ? AND d.date <= ? GROUP BY d.party_id ORDER BY v DESC LIMIT 8`, c.org.id, p.from, p.to);
    return { kind: 'bars', rows: rows.map((r) => ({ label: r.name, value: R(r.v), note: `${r.n} bill${r.n === 1 ? '' : 's'}`, href: `party/${r.id}` })) };
  } },
  supplier_dues: { cat: 'Suppliers', label: 'Supplier bills to pay', area: 'purchase', size: 2, link: 'reports/ageing?kind=payable', async run(c) {
    const rows = await all(c, `SELECT d.id, d.number, p.name, d.total - d.paid AS v, COALESCE(d.due_date, d.date) AS due FROM docs d LEFT JOIN parties p ON p.id = d.party_id
      WHERE d.org_id = ? AND d.type = 'BILL' AND d.status IN ('unpaid','partial') ORDER BY due LIMIT 8`, c.org.id);
    const t = today();
    return { kind: 'bars', rows: rows.map((r) => ({ label: `${r.name || ''} · ${r.number}`, value: R(r.v), note: r.due < t ? `late since ${fmtD(r.due)}` : `due ${fmtD(r.due)}`, warn: r.due < t, href: `doc/${r.id}` })) };
  } },
  pending_orders: { cat: 'Purchase', label: 'Pending orders', area: 'purchase', also: 'sales', size: 1, link: 'pending', async run(c) {
    const r = await one(c, `SELECT SUM(type = 'SO') AS so, SUM(type = 'PO') AS po FROM docs WHERE org_id = ? AND type IN ('SO','PO') AND status IN ('open','partial')`, c.org.id);
    return { kind: 'kpi', unit: 'count', value: (r.so || 0) + (r.po || 0), sub: `${r.so || 0} to deliver · ${r.po || 0} to receive` };
  } },
  // inventory
  stock_value: { cat: 'Inventory', label: 'Stock value', area: 'items', costs: true, size: 1, link: 'stock', async run(c) {
    const r = await one(c, `SELECT COALESCE(SUM(ROUND(MAX(0, qty_on_hand) * avg_cost)), 0) AS v, SUM(qty_on_hand > 0) AS n FROM items WHERE org_id = ? AND is_service = 0`, c.org.id);
    return { kind: 'kpi', value: R(r.v), sub: `${r.n || 0} items in stock, at cost` };
  } },
  low_stock: { cat: 'Inventory', label: 'Low stock', area: 'items', size: 2, link: 'new/PO?reorder=1', async run(c) {
    const rows = await all(c, `SELECT id, name, unit, qty_on_hand AS q, reorder_level AS r FROM items WHERE org_id = ? AND is_service = 0 AND qty_on_hand > 0
      AND qty_on_hand <= reorder_level ORDER BY qty_on_hand / MAX(reorder_level, 0.001) LIMIT 8`, c.org.id);
    return { kind: 'list', rows: rows.map((x) => ({ label: x.name, value: `${Math.round(x.q * 1000) / 1000} ${x.unit}`, note: `reorder at ${x.r}`, warn: true, href: `item/${x.id}` })) };
  } },
  out_of_stock: { cat: 'Inventory', label: 'Out of stock', area: 'items', size: 1, link: 'stock', down: true, async run(c) {
    const r = await one(c, `SELECT COUNT(*) AS v, GROUP_CONCAT(name, ', ') AS names FROM (SELECT name FROM items WHERE org_id = ? AND is_service = 0 AND qty_on_hand <= 0 ORDER BY name LIMIT 4)`, c.org.id);
    const n = await one(c, `SELECT COUNT(*) AS v FROM items WHERE org_id = ? AND is_service = 0 AND qty_on_hand <= 0`, c.org.id);
    return { kind: 'kpi', unit: 'count', value: n.v, sub: n.v ? `${r.names}${n.v > 4 ? '…' : ''}` : 'every item has stock' };
  } },
  fast_moving: { cat: 'Inventory', label: 'Fast-moving items', area: 'items', size: 2, link: 'stock-ageing', async run(c, p) {
    const rows = await all(c, `SELECT i.id, i.name, i.unit, -SUM(m.qty) AS q FROM stock_moves m JOIN items i ON i.id = m.item_id
      WHERE m.org_id = ? AND m.qty < 0 AND m.ref_type IN ('INV','DN') AND m.date >= ? AND m.date <= ? GROUP BY m.item_id ORDER BY q DESC LIMIT 8`, c.org.id, p.from, p.to);
    return { kind: 'bars', unit: 'qty', rows: rows.map((r) => ({ label: r.name, value: Math.round(r.q * 1000) / 1000, note: r.unit, href: `item/${r.id}` })) };
  } },
  slow_moving: { cat: 'Inventory', label: 'Not sold in this period', area: 'items', size: 2, link: 'stock-ageing', async run(c, p) {
    const costs = seesCosts(c.user);
    const rows = await all(c, `SELECT i.id, i.name, i.unit, i.qty_on_hand AS q, ROUND(i.qty_on_hand * i.avg_cost) AS v FROM items i WHERE i.org_id = ? AND i.is_service = 0 AND i.qty_on_hand > 0
      AND NOT EXISTS (SELECT 1 FROM stock_moves m WHERE m.org_id = i.org_id AND m.item_id = i.id AND m.qty < 0 AND m.ref_type IN ('INV','DN') AND m.date >= ? AND m.date <= ?)
      ORDER BY v DESC LIMIT 8`, c.org.id, p.from, p.to);
    return { kind: 'list', rows: rows.map((r) => ({ label: r.name, value: `${Math.round(r.q * 1000) / 1000} ${r.unit}`, note: costs ? `₹${R(r.v).toLocaleString('en-IN')} at cost` : '', href: `item/${r.id}` })) };
  } },
  godown_stock: { cat: 'Inventory', label: 'Stock by godown', area: 'items', size: 2, link: 'stock', async run(c) {
    const costs = seesCosts(c.user);
    const rows = await all(c, `SELECT w.id, w.name, COUNT(DISTINCT CASE WHEN s.qty > 0 THEN s.item_id END) AS n, COALESCE(SUM(CASE WHEN s.qty > 0 THEN ROUND(s.qty * i.avg_cost) END), 0) AS v
      FROM warehouses w LEFT JOIN stock s ON s.warehouse_id = w.id LEFT JOIN items i ON i.id = s.item_id WHERE w.org_id = ? GROUP BY w.id ORDER BY v DESC LIMIT 12`, c.org.id);
    return costs ? { kind: 'bars', rows: rows.map((r) => ({ label: r.name, value: R(r.v), note: `${r.n} items` })) }
      : { kind: 'list', rows: rows.map((r) => ({ label: r.name, value: `${r.n} items` })) };
  } },
  // finance
  cash_balance: { cat: 'Finance', label: 'Cash in hand', area: 'finance', size: 1, link: 'cash', async run(c) {
    const acc = (await cashAccounts(c)).filter((a) => a.sys === 'cash');
    return { kind: 'kpi', value: R(acc.reduce((s, a) => s + a.dr - a.cr, 0)), sub: acc.map((a) => a.name).join(', ') || 'no cash account' };
  } },
  bank_balance: { cat: 'Finance', label: 'Bank and UPI', area: 'finance', size: 1, link: 'cash', async run(c) {
    const acc = (await cashAccounts(c)).filter((a) => a.sys !== 'cash');
    return { kind: 'kpi', value: R(acc.reduce((s, a) => s + a.dr - a.cr, 0)), sub: `${acc.length} account${acc.length === 1 ? '' : 's'}` };
  } },
  receivables: { cat: 'Finance', label: 'To receive', area: 'reports', alt: 'finance', size: 1, link: 'reports/ageing', async run(c) {
    const r = await one(c, `SELECT COALESCE(SUM(total - paid), 0) AS v, COALESCE(SUM(CASE WHEN COALESCE(due_date, date) < ?2 THEN total - paid END), 0) AS late,
      COUNT(CASE WHEN COALESCE(due_date, date) < ?2 THEN 1 END) AS n FROM docs WHERE org_id = ?1 AND type = 'INV' AND status IN ('unpaid','partial')`, c.org.id, today());
    return { kind: 'kpi', value: R(r.v), sub: r.n ? `₹${R(r.late).toLocaleString('en-IN')} late on ${r.n} bills` : 'nothing late', tone: r.n ? 'warn' : '' };
  } },
  payables: { cat: 'Finance', label: 'To pay', area: 'reports', alt: 'finance', size: 1, link: 'reports/ageing?kind=payable', async run(c) {
    const r = await one(c, `SELECT COALESCE(SUM(total - paid), 0) AS v, COALESCE(SUM(CASE WHEN COALESCE(due_date, date) <= ?2 THEN total - paid END), 0) AS soon
      FROM docs WHERE org_id = ?1 AND type = 'BILL' AND status IN ('unpaid','partial')`, c.org.id, addDays(today(), 7));
    return { kind: 'kpi', value: R(r.v), sub: `₹${R(r.soon).toLocaleString('en-IN')} due within 7 days` };
  } },
  expenses: { cat: 'Finance', label: 'Expenses', area: 'reports', alt: 'finance', size: 1, link: 'expenses', down: true, async run(c, p) {
    const sum = (rows) => rows.filter((r) => r.type === 'expense' && r.sys !== 'cogs').reduce((s, r) => s + r.dr - r.cr, 0);
    const [now, before] = await Promise.all([accountBalances(c.db, c.org.id, p.from, p.to), accountBalances(c.db, c.org.id, p.pfrom, p.pto)]);
    return { kind: 'kpi', value: R(sum(now)), prev: R(sum(before)), vs: 'previous period', sub: 'rent, salary, freight and other costs, not stock' };
  } },
  profit: { cat: 'Finance', label: 'Profit', area: 'reports', costs: true, size: 1, link: 'reports/pnl', async run(c, p) {
    const pl = (rows) => {
      const inc = rows.filter((r) => r.type === 'income'), exp = rows.filter((r) => r.type === 'expense');
      const sales = inc.filter((r) => r.sys === 'sales').reduce((s, r) => s + r.cr - r.dr, 0), cogs = exp.filter((r) => r.sys === 'cogs').reduce((s, r) => s + r.dr - r.cr, 0);
      return { gross: sales - cogs, net: inc.reduce((s, r) => s + r.cr - r.dr, 0) - exp.reduce((s, r) => s + r.dr - r.cr, 0), margin: sales ? Math.round((sales - cogs) / sales * 1000) / 10 : 0 };
    };
    const [now, before] = await Promise.all([accountBalances(c.db, c.org.id, p.from, p.to), accountBalances(c.db, c.org.id, p.pfrom, p.pto)]);
    const a = pl(now), b = pl(before);
    return { kind: 'kpi', value: R(a.net), prev: R(b.net), vs: 'previous period', sub: `gross ₹${R(a.gross).toLocaleString('en-IN')} · margin ${a.margin}%` };
  } },
  cash_flow: { cat: 'Finance', label: 'Cash flow', area: 'finance', size: 2, link: 'cash', async run(c, p) {
    const keys = buckets(p);
    // money moved between the business's own cash, bank and UPI accounts (cash deposited in the bank) is neither in nor out:
    // an entry whose every line is a cash account is left out, or it showed twice, once as in and once as out
    const rows = await all(c, `SELECT ${bucketSql(p, 'jl.date')} AS k, SUM(jl.debit) AS i, SUM(jl.credit) AS o FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      WHERE jl.org_id = ? AND a.is_cash = 1 AND jl.date >= ? AND jl.date <= ?
        AND EXISTS (SELECT 1 FROM journal_lines x JOIN accounts xa ON xa.id = x.account_id WHERE x.journal_id = jl.journal_id AND xa.is_cash = 0)
      GROUP BY k`, c.org.id, p.from, p.to);
    return { kind: 'series', labels: keys, series: [{ name: 'Money in', values: fill(keys, rows, 'i') }, { name: 'Money out', values: fill(keys, rows, 'o'), tone: 'out' }], monthly: p.monthly, bars: true };
  } },
  gst_payable: { cat: 'Finance', label: 'GST for the period', area: 'reports', size: 1, link: 'gstr', async run(c, p) {
    const q = (types, s) => one(c, `SELECT COALESCE(SUM(cgst + sgst + igst), 0) AS v FROM docs WHERE org_id = ? AND type IN ${types} AND status != 'cancelled' AND date >= ? AND date <= ?`, c.org.id, p.from, p.to).then((r) => s * r.v);
    const parts = await Promise.all([q(`('INV')`, 1), q(`('SRET','CNOTE')`, -1), q(`('BILL')`, -1), q(`('PRET','DNOTE')`, 1)]);
    const out = parts[0] + parts[1], inp = -(parts[2] + parts[3]);
    return { kind: 'kpi', value: R(out - inp), sub: `₹${R(out).toLocaleString('en-IN')} on sales less ₹${R(inp).toLocaleString('en-IN')} input credit` };
  } },
  // activity
  recent_invoices: { cat: 'Activity', label: 'Recent invoices', area: 'sales', size: 2, link: 'sales/INV', async run(c) {
    const rows = await all(c, `SELECT d.id, d.number, d.date, d.total, d.status, p.name FROM docs d LEFT JOIN parties p ON p.id = d.party_id
      WHERE d.org_id = ? AND d.type = 'INV' ORDER BY d.date DESC, d.id DESC LIMIT 8`, c.org.id);
    return { kind: 'list', rows: rows.map((r) => ({ label: `${r.number} · ${r.name || ''}`, value: `₹${R(r.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, note: fmtD(r.date), status: r.status, href: `doc/${r.id}` })) };
  } },
  recent_activity: { cat: 'Activity', label: 'Recent transactions', area: 'any', size: 2, link: 'daybook', async run(c) {
    const sides = ['sales', 'purchase'].filter((a) => canView(c.user, a));
    const types = { sales: `'QUOTE','SO','DN','INV','SRET','CNOTE'`, purchase: `'PO','GRN','BILL','PRET','DNOTE'` };
    const docs = sides.length ? await all(c, `SELECT d.id, d.type, d.number, d.date, d.total, d.status, p.name FROM docs d LEFT JOIN parties p ON p.id = d.party_id
      WHERE d.org_id = ? AND d.type IN (${sides.map((s) => types[s]).join(',')}) ORDER BY d.date DESC, d.id DESC LIMIT 8`, c.org.id) : [];
    const pays = canView(c.user, 'finance') ? await all(c, `SELECT y.id, y.kind, y.number, y.date, y.amount, y.notes, p.name FROM payments y LEFT JOIN parties p ON p.id = y.party_id
      WHERE y.org_id = ? ORDER BY y.date DESC, y.id DESC LIMIT 8`, c.org.id) : [];
    const rows = [...docs.map((d) => ({ at: d.id, label: `${d.number} · ${d.name || ''}`, value: `₹${R(d.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, note: `${d.type} · ${fmtD(d.date)}`, status: d.status, href: `doc/${d.id}`, d: d.date })),
      ...pays.map((y) => ({ label: `${y.number} · ${y.name || ''}`, value: `₹${R(y.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, note: `${y.kind === 'receipt' ? 'Money in' : 'Money out'} · ${fmtD(y.date)}`,
        status: String(y.notes || '').startsWith('[void]') ? 'cancelled' : '', href: y.kind === 'receipt' ? 'receipts' : 'payments', d: y.date }))]
      .sort((a, b) => b.d.localeCompare(a.d)).slice(0, 8);
    return { kind: 'list', rows };
  } },
  today_tasks: { cat: 'Activity', label: 'What needs doing today', area: 'any', size: 4, client: 'today' },
};
/* a role may answer a widget when it may see its area (any of them), and costs when the widget shows them */
export function mayAnswer(user, w) {
  if (!w) return false;
  const areas = w.area === 'any' ? [] : [w.area, w.also, w.alt].filter(Boolean);
  if (areas.length && !areas.some((a) => canView(user, a))) return false;
  if (w.costs && !seesCosts(user)) return false;
  return true;
}
export const widgetList = (user) => Object.entries(WIDGETS).filter(([, w]) => mayAnswer(user, w))
  .map(([id, w]) => ({ id, cat: w.cat, label: w.label, size: w.size, link: w.link, down: !!w.down, client: w.client || '' }));

export async function widgetData(c, ids, q) {
  const p = periodOf(c.org, q.get('range') || 'month', q.get('from'), q.get('to'));
  const want = [...new Set(String(ids || '').split(',').filter(Boolean))].slice(0, 40);
  const out = {};
  await Promise.all(want.map(async (id) => {
    const w = Object.hasOwn(WIDGETS, id) ? WIDGETS[id] : null;
    if (!w) return;
    if (!mayAnswer(c.user, w)) { out[id] = { kind: 'denied' }; return; }
    if (!w.run) { out[id] = { kind: w.client }; return; }
    try { out[id] = await w.run(c, p); } catch (e) { out[id] = { kind: 'error', error: 'Could not work this out just now.' }; }
  }));
  return { period: { key: p.key, from: p.from, to: p.to, pfrom: p.pfrom, pto: p.pto, label: RANGES[p.key] || 'Custom' }, widgets: out };
}

/* ---------- saved dashboards ---------- */
const MAX_WIDGETS = 40;
export function cleanLayout(b) {
  const list = Array.isArray(b.widgets) ? b.widgets : [];
  if (list.length > MAX_WIDGETS) throw bad(`At most ${MAX_WIDGETS} widgets on one dashboard.`);
  const widgets = list.filter((x) => x && Object.hasOwn(WIDGETS, x.w)).map((x) => ({ w: x.w, size: Math.min(4, Math.max(1, Math.round(+x.size || WIDGETS[x.w].size))) }));
  const range = Object.hasOwn(RANGES, b.range) ? b.range : 'month';
  return { range, widgets };
}
const out = (r, userId) => ({ id: r.id, name: r.name, layout: JSON.parse(r.layout || '{}'), is_default: !!r.is_default && r.user_id === userId, shared: !!r.shared, mine: r.user_id === userId,
  owner: r.owner || '', updated_at: r.updated_at });
export async function listDashboards(c) {
  const { results } = await c.db.prepare(`SELECT d.*, u.name AS owner FROM dashboards d LEFT JOIN users u ON u.id = d.user_id
      WHERE d.org_id = ? AND (d.user_id = ? OR d.shared = 1) ORDER BY d.user_id != ?, d.id`).bind(c.org.id, c.user.id, c.user.id).all();
  const pick = await c.db.prepare(`SELECT dash_id FROM dash_pick WHERE org_id = ? AND user_id = ?`).bind(c.org.id, c.user.id).first();
  // first-run checklist: has the business added an item, a real customer and an invoice yet?
  const setup = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM items WHERE org_id = ?1) AS items,
      EXISTS (SELECT 1 FROM parties WHERE org_id = ?1 AND kind != 'supplier' AND name != 'Walk-in Customer') AS customers,
      EXISTS (SELECT 1 FROM docs WHERE org_id = ?1 AND type = 'INV') AS invoices`).bind(c.org.id).first();
  return { dashboards: results.map((r) => ({ ...out(r, c.user.id), is_default: pick ? pick.dash_id === r.id : false })), default_id: pick ? pick.dash_id : null,
    widgets: widgetList(c.user), ranges: RANGES, can_share: can(c.user, 'settings'), setup: { items: !!setup.items, customers: !!setup.customers, invoices: !!setup.invoices } };
}
async function mine(c, id) {
  const r = await c.db.prepare(`SELECT * FROM dashboards WHERE id = ? AND org_id = ?`).bind(id, c.org.id).first();
  if (!r || (r.user_id !== c.user.id && !(r.shared && can(c.user, 'settings')))) throw notFound('Dashboard not found.');
  return r;
}
export async function saveDashboard(c, id, b) {
  const name = str(b.name, 60) || 'My dashboard';
  const layout = JSON.stringify(cleanLayout(b.layout || {}));
  const shared = b.shared === true && can(c.user, 'settings') ? 1 : 0;
  if (id) {
    const r = await mine(c, id);
    await c.db.prepare(`UPDATE dashboards SET name = ?, layout = ?, shared = ?, updated_at = ? WHERE id = ?`).bind(name, layout, b.shared === undefined ? r.shared : shared, nowIso(), r.id).run();
  } else {
    const n = await c.db.prepare(`SELECT COUNT(*) AS n FROM dashboards WHERE org_id = ? AND user_id = ?`).bind(c.org.id, c.user.id).first();
    if (n.n >= 20) throw bad('At most 20 dashboards each. Delete one you no longer use.');
    const r = await c.db.prepare(`INSERT INTO dashboards (org_id, user_id, name, layout, shared, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(c.org.id, c.user.id, name, layout, shared, nowIso(), nowIso()).first();
    id = r.id;
  }
  if (b.is_default === true) await pickDefault(c, id);
  return listDashboards(c);
}
export async function pickDefault(c, id) {
  if (id) {
    const r = await c.db.prepare(`SELECT id FROM dashboards WHERE id = ? AND org_id = ? AND (user_id = ? OR shared = 1)`).bind(id, c.org.id, c.user.id).first();
    if (!r) throw notFound('Dashboard not found.');
    await c.db.prepare(`INSERT INTO dash_pick (org_id, user_id, dash_id) VALUES (?, ?, ?) ON CONFLICT (org_id, user_id) DO UPDATE SET dash_id = excluded.dash_id`).bind(c.org.id, c.user.id, id).run();
  } else await c.db.prepare(`DELETE FROM dash_pick WHERE org_id = ? AND user_id = ?`).bind(c.org.id, c.user.id).run();
  return listDashboards(c);
}
export async function deleteDashboard(c, id) {
  const r = await mine(c, id);
  await c.db.batch([c.db.prepare(`DELETE FROM dashboards WHERE id = ?`).bind(r.id), c.db.prepare(`DELETE FROM dash_pick WHERE org_id = ? AND dash_id = ?`).bind(c.org.id, r.id)]);
  return listDashboards(c);
}
