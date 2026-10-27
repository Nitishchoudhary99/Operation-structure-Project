/* Orders from Amazon, Flipkart, Meesho or any online store, imported from the order report (CSV) the seller already
   downloads, or Amazon's monthly tax report (MTR): every order becomes a normal sales invoice (stock goes out, GST and
   the books as usual), so online and shop sales sit in one place. Columns are found by their usual names, items by
   SKU, barcode or name. Each order is billed to one party per channel and buyer state, e.g. "Amazon (Maharashtra)",
   so GST is CGST+SGST or IGST correctly. An order id is imported once only (channel_orders).
   Refunds, returns and cancellations in the same files, for orders billed here, become sales returns against their
   invoice (stock back in, GST reversed), each one once only (channel_returns).
   Amazon's settlement (payout) report closes the loop: per order what was paid, what Amazon kept as fees, GST TCS and
   income-tax TDS (194-O), matched to the invoices; posting it marks those invoices paid and books the fees, TCS and
   TDS, so the bank deposit, the fee expense and the tax credits to claim are right (mkt_settlements, once per payout).
   The stock file goes the other way: SKU and quantity in hand, for the marketplace's inventory upload. */
import { HttpError, bad, str, roundQty, nowIso, today, loadByIds } from './lib.js';
import { requireCan, checkBackdate } from './auth.js';
import { createDoc, paymentStatements, journalStatements, auditStatement, cashAccount, ensureSysAccounts, TDS_ACCOUNTS } from './engine.js';
import { STATES } from './gst.js';

export const CHANNELS = { amazon: 'Amazon', flipkart: 'Flipkart', meesho: 'Meesho', other: 'Online' };

const COLS = {
  order: ['amazon-order-id', 'order-id', 'order id', 'order_id', 'sub order no', 'sub order id', 'suborder id', 'order item id', 'order no', 'order number', 'order'],
  invoice: ['invoice number', 'invoice no', 'invoice-number', 'invoice id'],
  note: ['credit note no', 'credit note number', 'credit note id'],
  sku: ['sku', 'seller-sku', 'seller sku', 'sku id', 'sku code', 'product sku', 'item sku', 'seller sku id'],
  qty: ['quantity-purchased', 'quantity', 'qty', 'item quantity', 'quantity purchased', 'units'],
  amount: ['item-price', 'invoice amount', 'final invoice amount', 'order total', 'total amount', 'sale amount', 'total', 'amount', 'item total'],
  unit: ['selling price per item', 'price per item', 'unit price', 'selling price', 'price', 'supplier discounted price (incl gst and commision)',
    'supplier listed price (incl. gst + commission)', 'product price'],
  state: ['ship-state', 'ship state', 'ship to state', 'shipping state', 'customer state', 'buyer state', 'delivery state', 'end customer state new', 'state'],
  date: ['invoice date', 'purchase-date', 'order-date', 'order date', 'ordered on', 'order placed date', 'date', 'order created date'],
  name: ['product-name', 'product name', 'product title', 'item name', 'item description', 'title', 'product', 'description'],
  status: ['transaction type', 'order-status', 'order status', 'order state', 'order item status', 'sub order status', 'item status', 'shipment status', 'status', 'reason for credit entry'],
};

/* RFC 4180 CSV (and tab-separated text), quotes and all */
export function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const first = s.split(/\r?\n/, 1)[0] || '';
  const sep = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const norm = (h) => String(h).toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
function findCols(header) {
  const H = header.map(norm), at = {};
  for (const [k, names] of Object.entries(COLS)) {
    for (const n of names) { const i = H.indexOf(n); if (i >= 0) { at[k] = i; break; } }
  }
  return at;
}
const money = (v) => { const x = parseFloat(String(v || '').replace(/[₹,\s]|rs\.?|inr/gi, '')); return Number.isFinite(x) ? x : NaN; };
function cleanDate(v) {
  const t = String(v || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);                       // dd/mm/yyyy (India)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = t.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-,]+(\d{4})/);            // 12 Oct 2026, 12-Oct-2026
  if (m && MON.includes(m[2].toLowerCase())) return `${m[3]}-${String(MON.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}
const STATE_BY = new Map(STATES.flatMap(([code, name]) => [[name.toLowerCase(), name], [code, name]]));
const ISO = { an: 'Andaman and Nicobar Islands', ap: 'Andhra Pradesh', ar: 'Arunachal Pradesh', as: 'Assam', br: 'Bihar', ch: 'Chandigarh', ct: 'Chhattisgarh', cg: 'Chhattisgarh',
  dn: 'Dadra and Nagar Haveli and Daman and Diu', dh: 'Dadra and Nagar Haveli and Daman and Diu', dd: 'Dadra and Nagar Haveli and Daman and Diu', dl: 'Delhi', ga: 'Goa', gj: 'Gujarat',
  hr: 'Haryana', hp: 'Himachal Pradesh', jk: 'Jammu and Kashmir', jh: 'Jharkhand', ka: 'Karnataka', kl: 'Kerala', la: 'Ladakh', ld: 'Lakshadweep', mp: 'Madhya Pradesh',
  mh: 'Maharashtra', mn: 'Manipur', ml: 'Meghalaya', mz: 'Mizoram', nl: 'Nagaland', or: 'Odisha', od: 'Odisha', py: 'Puducherry', pb: 'Punjab', rj: 'Rajasthan', sk: 'Sikkim',
  tn: 'Tamil Nadu', ts: 'Telangana', tg: 'Telangana', tr: 'Tripura', up: 'Uttar Pradesh', ut: 'Uttarakhand', uk: 'Uttarakhand', wb: 'West Bengal' };
const ALIAS = { 'orissa': 'Odisha', 'pondicherry': 'Puducherry', 'new delhi': 'Delhi', 'nct of delhi': 'Delhi', 'jammu & kashmir': 'Jammu and Kashmir',
  'andaman & nicobar islands': 'Andaman and Nicobar Islands', 'dadra & nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu', 'uttaranchal': 'Uttarakhand' };
export function cleanState(v) {
  const t = String(v || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/^in-/, '');
  if (!t) return '';
  const hit = STATE_BY.get(t) || STATE_BY.get(ALIAS[t] ? ALIAS[t].toLowerCase() : '') || ALIAS[t] || (t.length === 2 ? ISO[t] : '');
  return hit || t.replace(/\b\w/g, (x) => x.toUpperCase()).slice(0, 60);
}

/* the orders in a file, grouped, with their items matched and anything that stops an order from being billed */
export async function readOrders(c, body) {
  const channel = Object.hasOwn(CHANNELS, body.channel) ? body.channel : 'other';
  const label = channel === 'other' ? str(body.store, 30) || CHANNELS.other : CHANNELS[channel];
  const rows = parseCsv(body.csv);
  if (rows.length < 2) throw bad('The file has no orders. Download the order report from your seller panel as CSV and choose it here.');
  if (rows.length > 5001) throw bad('At most 5000 rows at a time.');
  const at = findCols(rows[0]);
  const missing = ['order', 'qty'].filter((k) => at[k] === undefined).concat(at.sku === undefined && at.name === undefined ? ['sku'] : [])
    .concat(at.amount === undefined && at.unit === undefined ? ['amount'] : []);
  if (missing.length) throw bad(`Could not find these columns: ${missing.map((k) => ({ order: 'Order ID', qty: 'Quantity', sku: 'SKU', amount: 'Price / Amount' })[k]).join(', ')}. Found: ${rows[0].slice(0, 12).join(', ')}.`);
  const get = (r, k) => (at[k] === undefined ? '' : String(r[at[k]] ?? '').trim());
  const orders = new Map(), back = new Map();
  for (const r of rows.slice(1)) {
    const id = str(get(r, 'order'), 60);
    if (!id) continue;
    const status = get(r, 'status').toLowerCase();
    if (/replacement/.test(status)) continue;                     // a free replacement is no sale
    const qty = roundQty(Math.abs(parseFloat(get(r, 'qty')) || 0));
    if (/cancel|return|refund|rto/.test(status)) {
      // one return per credit note (MTR) or per order, item and day: the same file read twice returns nothing twice
      const d = cleanDate(get(r, 'date')) || today(), sku = get(r, 'sku'), key = str(get(r, 'note') || `${id}|${sku || get(r, 'name')}|${d}`, 120);
      if (!back.has(key)) back.set(key, { key, order_id: id, date: d, why: /cancel/.test(status) ? 'cancelled' : 'returned', lines: [] });
      back.get(key).lines.push({ sku, name: get(r, 'name'), qty });
      continue;
    }
    if (!orders.has(id)) orders.set(id, { order_id: id, date: cleanDate(get(r, 'date')) || today(), state: cleanState(get(r, 'state')), invoice: str(get(r, 'invoice'), 40), lines: [] });
    const amt = money(get(r, 'amount')), unit = money(get(r, 'unit'));
    orders.get(id).lines.push({ sku: get(r, 'sku'), name: get(r, 'name'), qty, gross: Number.isFinite(amt) && amt > 0 ? amt : Number.isFinite(unit) ? unit * qty : NaN });
  }
  const R = await matchOrders(c, channel, label, [...orders.values()]);
  const returns = await matchReturns(c, channel, [...back.values()]);
  // a refund of an order that this very file is about to bill: bill it first, then the refund can be booked
  const inFile = new Set(R.orders.filter((o) => !o.done).map((o) => o.order_id));
  for (const x of returns) if (!x.doc_id && inFile.has(x.order_id)) x.problems = ['its invoice is in this file: make the invoices first, then check again'];
  return { ...R, returns, columns: Object.fromEntries(Object.entries(at).map(([k, i]) => [k, rows[0][i]])) };
}

/* returns / refunds / cancellations of orders billed here: each line matched to its invoice line, up to what is still
   not returned on it */
export async function matchReturns(c, channel, raw) {
  if (!raw.length) return [];
  const billed = new Map((await loadByIds(c.db, `SELECT o.order_id, d.id, d.number, d.party_id, d.status FROM channel_orders o JOIN docs d ON d.id = o.doc_id
      WHERE o.org_id = ? AND o.channel = ? AND o.order_id IN (?ids)`, [c.org.id, channel], [...new Set(raw.map((r) => r.order_id))])).map((x) => [x.order_id, x]));
  const done = new Set((await loadByIds(c.db, `SELECT ret_key FROM channel_returns WHERE org_id = ? AND channel = ? AND ret_key IN (?ids)`, [c.org.id, channel], raw.map((r) => r.key)))
    .map((x) => x.ret_key));
  const docIds = [...new Set([...billed.values()].map((b) => b.id))];
  const lines = docIds.length ? await loadByIds(c.db, `SELECT l.id, l.doc_id, l.item_id, l.qty, l.done_qty, l.rate, l.discount_pct, l.gst_rate, i.name, i.sku, i.barcode
      FROM doc_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.doc_id IN (?ids)`, [], docIds) : [];
  return raw.map((r) => {
    const inv = billed.get(r.order_id), o = { key: r.key, order_id: r.order_id, date: r.date, why: r.why, done: done.has(r.key), lines: [], problems: [] };
    if (!inv) { o.problems.push('this order was not billed here'); return o; }
    o.invoice = inv.number; o.doc_id = inv.id; o.party_id = inv.party_id;
    if (inv.status === 'cancelled') { o.problems.push(`${inv.number} is cancelled`); return o; }
    const left = new Map(lines.filter((l) => l.doc_id === inv.id).map((l) => [l.id, l.qty - l.done_qty]));
    for (const x of r.lines) {
      const want = (x.sku || '').toLowerCase(), byName = (x.name || '').toLowerCase();
      const cand = lines.filter((l) => l.doc_id === inv.id && (left.get(l.id) || 0) > 0.0005
        && ((want && [l.sku, l.barcode].some((s) => s && s.toLowerCase() === want)) || (!want && byName && (l.name || '').toLowerCase() === byName)));
      // no quantity in the report (some cancellations): the whole line
      let q = x.qty || (cand[0] ? left.get(cand[0].id) : 0);
      for (const l of cand) {
        if (q <= 0.0005) break;
        const take = roundQty(Math.min(q, left.get(l.id)));
        o.lines.push({ src_line_id: l.id, item_id: l.item_id, item: l.name, qty: take, rate: l.rate / 100, discount_pct: l.discount_pct || 0, gst_rate: l.gst_rate });
        left.set(l.id, left.get(l.id) - take); q -= take;
      }
      if (q > 0.0005) o.problems.push(`${x.sku || x.name || 'an item'}: ${cand.length ? 'more than is left to return' : `not on ${inv.number} or already returned`}`);
    }
    if (!o.lines.length && !o.problems.length) o.problems.push('nothing to return');
    o.total = Math.round(o.lines.reduce((s, l) => s + l.qty * l.rate * (1 - l.discount_pct / 100) * (1 + l.gst_rate / 100), 0) * 100) / 100;
    return o;
  });
}

/* orders from any source [{ order_id, date, state, lines: [{ sku, name, qty, gross (price incl. GST for the line) }] }]:
   items matched by SKU, barcode or name, the GST rate of the item split back out of the price, and the ones billed before marked */
export async function matchOrders(c, channel, label, raw) {
  const { results: items } = await c.db.prepare(`SELECT id, name, sku, barcode, gst_rate, is_service, unit FROM items WHERE org_id = ?`).bind(c.org.id).all();
  const bySku = new Map(), byName = new Map();
  for (const i of items) {
    if (i.sku) bySku.set(i.sku.toLowerCase(), i);
    if (i.barcode) bySku.set(i.barcode.toLowerCase(), i);
    byName.set(i.name.toLowerCase(), i);
  }
  const list = raw.map((r) => {
    const o = { order_id: str(r.order_id, 60), date: r.date || today(), state: r.state || '', invoice: str(r.invoice, 40), lines: [], problems: [] };
    for (const l of r.lines) {
      const sku = str(l.sku, 60), name = str(l.name, 120), qty = roundQty(+l.qty || 0), gross = +l.gross;
      const it = (sku && bySku.get(sku.toLowerCase())) || (name && byName.get(name.toLowerCase())) || null;
      if (!it) { o.problems.push(`SKU ${sku || name || '?'} is not in your items`); continue; }
      if (it.is_service) { o.problems.push(`${it.name} is a service`); continue; }
      if (!(qty > 0)) { o.problems.push(`no quantity for ${it.name}`); continue; }
      if (!(gross >= 0)) { o.problems.push(`no price for ${it.name}`); continue; }
      o.lines.push({ item_id: it.id, item: it.name, unit: it.unit, qty, gst_rate: it.gst_rate, gross: Math.round(gross * 100) / 100,
        rate: Math.round((gross / (1 + it.gst_rate / 100) / qty) * 100) / 100 });
    }
    return o;
  });
  const done = new Set((await loadByIds(c.db, `SELECT order_id FROM channel_orders WHERE org_id = ? AND channel = ? AND order_id IN (?ids)`, [c.org.id, channel],
    list.map((o) => o.order_id))).map((r) => r.order_id));
  for (const o of list) {
    o.done = done.has(o.order_id);
    o.party = `${label}${o.state ? ` (${o.state})` : ''}`;
    o.total = Math.round(o.lines.reduce((s, l) => s + l.gross, 0) * 100) / 100;
    if (!o.lines.length && !o.problems.length) o.problems.push('no lines');
  }
  return { channel, label, orders: list,
    ready: list.filter((o) => !o.done && !o.problems.length).length, already: done.size, problems: list.filter((o) => o.problems.length).length };
}

/* bill the listed orders of the file (a few per request: each one is a full invoice) */
export async function importOrders(c, body) {
  requireCan(c.user, 'sales');
  const only = (Array.isArray(body.only) ? body.only : []).map((x) => str(x, 60)).filter(Boolean);
  const rets = (Array.isArray(body.only_returns) ? body.only_returns : []).map((x) => str(x, 120)).filter(Boolean);
  if (!only.length && !rets.length) return readOrders(c, body);
  if (only.length + rets.length > 2) throw bad('Import at most 2 orders per request.');
  const R = await readOrders(c, body);
  const out = [];
  for (const key of rets) {
    const o = R.returns.find((x) => x.key === key);
    if (!o) { out.push({ key, error: 'not in the file' }); continue; }
    if (o.done) { out.push({ key, skipped: 'already returned' }); continue; }
    if (o.problems.length) { out.push({ key, error: o.problems.join('; ') }); continue; }
    try {
      const doc = await createDoc(c, { type: 'SRET', party_id: o.party_id, ref_id: o.doc_id, date: o.date, warehouse_id: +body.warehouse_id || 0,
        notes: `${R.label} order ${o.order_id} ${o.why}`, lines: o.lines.map((l) => ({ item_id: l.item_id, qty: l.qty, rate: l.rate, discount_pct: l.discount_pct, gst_rate: l.gst_rate, src_line_id: l.src_line_id })) });
      await c.db.prepare(`INSERT INTO channel_returns (org_id, channel, ret_key, order_id, doc_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
        .bind(c.org.id, R.channel, key, o.order_id, doc.id, nowIso()).run();
      out.push({ key, order_id: o.order_id, doc_id: doc.id, number: doc.number });
    } catch (e) {
      const known = e instanceof HttpError && e.status < 500;
      out.push({ key, order_id: o.order_id, error: known ? e.message : 'could not be returned' });
      if (!known) console.error('channel return', e);
    }
  }
  for (const id of only) {
    const o = R.orders.find((x) => x.order_id === id);
    if (!o) { out.push({ order_id: id, error: 'not in the file' }); continue; }
    if (o.done) { out.push({ order_id: id, skipped: 'already imported' }); continue; }
    if (o.problems.length) { out.push({ order_id: id, error: o.problems.join('; ') }); continue; }
    try {
      const doc = await billOrder(c, R, o, +body.warehouse_id || 0);
      out.push({ order_id: id, doc_id: doc.id, number: doc.number });
    } catch (e) {
      const known = e instanceof HttpError && e.status < 500;
      out.push({ order_id: id, error: known ? e.message : 'could not be billed' });
      if (!known) console.error('channel import', e);
    }
  }
  return { results: out };
}

/* one matched order as a sales invoice, to the party of its channel and buyer state */
export async function billOrder(c, R, o, warehouseId = 0) {
  let p = await c.db.prepare(`SELECT id FROM parties WHERE org_id = ? AND name = ?`).bind(c.org.id, o.party).first();
  if (!p) {
    // the marketplace pays out about a week later: that is when these bills fall due
    p = await c.db.prepare(`INSERT INTO parties (org_id, name, kind, state, credit_days, created_at) VALUES (?, ?, 'customer', ?, 7, ?)
        ON CONFLICT(org_id, name) DO UPDATE SET name = excluded.name RETURNING id`).bind(c.org.id, o.party, o.state, nowIso()).first();
  }
  const doc = await createDoc(c, { type: 'INV', party_id: p.id, date: o.date, warehouse_id: warehouseId, notes: `${R.label} order ${o.order_id}${o.invoice ? ` · ${R.label} invoice ${o.invoice}` : ''}`,
    lines: o.lines.map((l) => ({ item_id: l.item_id, qty: l.qty, rate: l.rate, gst_rate: l.gst_rate })) });
  await c.db.prepare(`INSERT INTO channel_orders (org_id, channel, order_id, doc_id, created_at) VALUES (?, ?, ?, (SELECT id FROM docs WHERE org_id = ? AND id = ?), ?)
      ON CONFLICT DO NOTHING`).bind(c.org.id, R.channel, o.order_id, c.org.id, doc.id, nowIso()).run();
  return doc;
}

/* ---------- Amazon settlement (payout) report ---------- */
const SCOLS = {
  sid: ['settlement-id', 'settlement id'], start: ['settlement-start-date', 'settlement start date'], end: ['settlement-end-date', 'settlement end date'],
  deposit: ['deposit-date', 'deposit date'], total: ['total-amount', 'total amount'], tx: ['transaction-type', 'transaction type'], order: ['order-id', 'order id'],
  atype: ['amount-type', 'amount type'], adesc: ['amount-description', 'amount description'], amount: ['amount'], posted: ['posted-date', 'posted date'],
};
/* what one line of the payout is: the customer's money for the goods (sale), Amazon's fees, GST TCS, income-tax TDS
   (194-O), or anything else (ads, storage, reserve, reimbursements) */
export function payKind(atype, desc) {
  const a = String(atype || '').toLowerCase().replace(/[\s_-]/g, ''), d = String(desc || '').toLowerCase(), t = `${a} ${d}`;
  if (/tcs/.test(t)) return 'tcs';
  if (/\btds\b|194-?o/.test(t)) return 'tds';
  if (/^(itemprice|promotion)/.test(a) || /^(principal|product ?tax|shipping|shipping ?tax|gift ?wrap|gift ?wrap ?tax|tax)$/.test(d.trim())) return 'sale';
  if (/fee|commission|chargeback|closing|weight|pick|pack|storage|advertis|technology|subscription/.test(t)) return 'fee';
  return 'other';
}
const p2 = (x) => Math.round(x * 100) / 100;

export async function readSettlement(c, body) {
  requireCan(c.user, 'finance');
  const channel = 'amazon';
  const rows = parseCsv(body.csv);
  if (rows.length < 2) throw bad('The file is empty. Download the settlement report (Payments → All Statements → Download flat file V2) and choose it here.');
  if (rows.length > 60001) throw bad('At most 60000 rows at a time.');
  const H = rows[0].map(norm), at = {};
  for (const [k, names] of Object.entries(SCOLS)) for (const n of names) { const i = H.indexOf(n); if (i >= 0 && at[k] === undefined) at[k] = i; }
  const missing = ['sid', 'amount', 'order'].filter((k) => at[k] === undefined);
  if (missing.length) throw bad(`This is not an Amazon settlement report: no ${missing.map((k) => ({ sid: 'settlement-id', amount: 'amount', order: 'order-id' })[k]).join(', ')} column.`);
  const get = (r, k) => (at[k] === undefined ? '' : String(r[at[k]] ?? '').trim());
  const S = { settlement_id: '', start: '', end: '', deposit: '', total: null };
  const orders = new Map(), loose = { fee: 0, other: 0, tcs: 0, tds: 0, sale: 0 };
  let sum = 0;
  for (const r of rows.slice(1)) {
    const sid = get(r, 'sid');
    if (sid && !S.settlement_id) S.settlement_id = str(sid, 40);
    if (sid && sid !== S.settlement_id) throw bad('The file has more than one settlement. Download one settlement at a time.');
    // the summary line: dates and the deposit, no transaction
    if (!get(r, 'tx') && !get(r, 'atype') && get(r, 'total')) {
      S.start = cleanDate(get(r, 'start')); S.end = cleanDate(get(r, 'end')); S.deposit = cleanDate(get(r, 'deposit')); S.total = money(get(r, 'total'));
      continue;
    }
    const amt = money(get(r, 'amount'));
    if (!Number.isFinite(amt) || !amt) continue;
    sum += amt;
    const kind = payKind(get(r, 'atype'), get(r, 'adesc')), id = str(get(r, 'order'), 60);
    if (!id) { loose[kind] += amt; continue; }
    if (!orders.has(id)) orders.set(id, { order_id: id, sale: 0, fee: 0, tcs: 0, tds: 0, other: 0, refund: false });
    const o = orders.get(id);
    o[kind] += amt;
    if (/refund/i.test(get(r, 'tx'))) o.refund = true;
  }
  if (!S.settlement_id) throw bad('No settlement id in the file.');
  const list = [...orders.values()].map((o) => ({ ...o, sale: p2(o.sale), fee: p2(o.fee), tcs: p2(o.tcs), tds: p2(o.tds), other: p2(o.other), net: p2(o.sale + o.fee + o.tcs + o.tds + o.other) }));
  // the invoices made here for these orders, and what is still open on them
  const billed = new Map((await loadByIds(c.db, `SELECT o.order_id, d.id, d.number, d.party_id, d.total, d.paid, d.status, p.name AS party FROM channel_orders o
      JOIN docs d ON d.id = o.doc_id LEFT JOIN parties p ON p.id = d.party_id WHERE o.org_id = ? AND o.channel = ? AND o.order_id IN (?ids)`, [c.org.id, channel], list.map((o) => o.order_id)))
    .map((x) => [x.order_id, x]));
  for (const o of list) {
    const b = billed.get(o.order_id);
    if (b && b.status !== 'cancelled') Object.assign(o, { doc_id: b.id, invoice: b.number, party_id: b.party_id, party: b.party, open: p2((b.total - b.paid) / 100) });
  }
  const T = (k) => p2(list.reduce((s, o) => s + o[k], 0) + (loose[k] || 0));
  const totals = { sale: T('sale'), fee: T('fee'), tcs: T('tcs'), tds: T('tds'), other: T('other'), deposit: p2(S.total ?? sum) };
  const posted = await c.db.prepare(`SELECT created_at FROM mkt_settlements WHERE org_id = ? AND channel = ? AND settlement_id = ?`).bind(c.org.id, channel, S.settlement_id).first();
  return { channel, ...S, total: totals.deposit, adds_up: S.total === null || Math.abs(sum - S.total) < 0.05, file_sum: p2(sum), totals, loose: Object.fromEntries(Object.entries(loose).map(([k, v]) => [k, p2(v)])),
    orders: list, unbilled: list.filter((o) => !o.doc_id && Math.abs(o.sale) > 0.004).length, posted: posted ? posted.created_at : null };
}

/* the marketplace's accounts, made the first time they are needed (an older business, or one restored from a backup) */
const MKT_ACCOUNTS = [['mkt_clear', ['1120', '1121', '1129'], 'Marketplace Payouts Receivable', 'asset'], ['tcs_recv', ['1310', '1311', '1319'], 'GST TCS Receivable', 'asset'],
  ['mkt_fees', ['6070', '6071', '6079'], 'Marketplace Fees & Commission', 'expense'], ...TDS_ACCOUNTS];
const marketAccounts = (c) => ensureSysAccounts(c, MKT_ACCOUNTS);

/* Post one payout, once: receipts (one per marketplace party) that mark the orders' invoices paid, through
   "Marketplace Payouts Receivable"; then one journal: bank gets the deposit, fees go to expense, TCS and TDS to the
   receivables you claim (GSTR-3B / ITR), refunds taken back come off the party, the rest to fees or other income. */
export async function postSettlement(c, body) {
  requireCan(c.user, 'finance');
  const S = await readSettlement(c, body);
  if (S.posted) throw bad(`Settlement ${S.settlement_id} was already posted.`);
  if (!S.adds_up) throw bad(`The file does not add up to its deposit (${S.file_sum} against ${S.total}). Download it again.`);
  if (S.unbilled && !body.unbilled_ok) throw bad(`${S.unbilled} order(s) in this payout are not billed here. Import their orders first, or tick "Book unbilled orders as other income".`);
  const acct = await cashAccount(c.db, c.org.id, +body.account_id);
  const d = S.deposit || S.end || today();
  checkBackdate(c.user, d, today(), 'a payout');
  const sys = await marketAccounts(c), toP = (x) => Math.round(x * 100);
  const st = [];
  // receipts: per party, each billed order's money against its own invoice (anything over its balance stays as an advance)
  const byParty = new Map();
  for (const o of S.orders.filter((x) => x.doc_id && x.sale > 0.004)) {
    if (!byParty.has(o.party_id)) byParty.set(o.party_id, { amount: 0, allocs: [] });
    const g = byParty.get(o.party_id), amt = toP(o.sale);
    g.amount += amt;
    const a = Math.min(amt, toP(o.open));
    if (a > 0) g.allocs.push({ doc_id: o.doc_id, amount: a });
  }
  const parties = byParty.size ? await loadByIds(c.db, `SELECT * FROM parties WHERE org_id = ? AND id IN (?ids)`, [c.org.id], [...byParty.keys()]) : [];
  let received = 0;
  for (const p of parties) {
    const g = byParty.get(p.id);
    received += g.amount;
    st.push(...paymentStatements(c, { kind: 'receipt', party: p, account: sys.mkt_clear, date: d, amount: g.amount, reference: `Amazon ${S.settlement_id}`.slice(0, 80),
      notes: 'Amazon payout', allocs: g.allocs }));
  }
  const lines = [{ account: acct.id, amount: toP(S.totals.deposit) }];
  const add = (account, amount, party) => { if (amount) lines.push({ account, amount, party: party || null }); };
  add(sys.mkt_fees, -toP(S.totals.fee));
  add(sys.tcs_recv, -toP(S.totals.tcs));
  add(sys.tds_recv, -toP(S.totals.tds));
  for (const o of S.orders.filter((x) => x.doc_id && x.sale < -0.004)) add(sys.ar, -toP(o.sale), o.party_id);       // money for a refund taken back
  const unbilled = toP(S.orders.filter((x) => !x.doc_id).reduce((s, o) => s + o.sale, 0) + S.loose.sale);
  const other = toP(S.totals.other) + unbilled;
  if (other < 0) add(sys.mkt_fees, -other); else add(sys.other_income, -other);
  add(sys.mkt_clear, -received);
  const diff = lines.reduce((s, l) => s + l.amount, 0);
  if (diff) add(sys.round_off, -diff);                                                    // paise left over by rounding
  st.push(...journalStatements(c.db, c, { date: d, narration: `Amazon payout ${S.settlement_id}: deposit, fees, TCS, TDS`, refType: 'MKT', refId: null, lines }));
  st.push(c.db.prepare(`INSERT INTO mkt_settlements (org_id, channel, settlement_id, start_date, end_date, deposit_date, total, sales, fees, tcs, tds, other, orders, account_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(c.org.id, S.channel, S.settlement_id, S.start || null, S.end || null, d, toP(S.totals.deposit), toP(S.totals.sale),
    toP(S.totals.fee), toP(S.totals.tcs), toP(S.totals.tds), other, S.orders.length, acct.id, c.user.id, nowIso()));
  st.push(auditStatement(c, 'amazon payout', `${S.settlement_id}: ${S.totals.deposit}`));
  await c.db.batch(st);
  return { settlement_id: S.settlement_id, deposit: S.totals.deposit, receipts: parties.length, invoices: S.orders.filter((x) => x.doc_id && x.sale > 0.004).length };
}

export async function listSettlements(c) {
  requireCan(c.user, 'finance');
  const { results } = await c.db.prepare(`SELECT settlement_id, start_date, end_date, deposit_date, total, sales, fees, tcs, tds, other, orders, created_at FROM mkt_settlements
    WHERE org_id = ? ORDER BY deposit_date DESC, id DESC LIMIT 100`).bind(c.org.id).all();
  return results.map((r) => ({ ...r, total: r.total / 100, sales: r.sales / 100, fees: r.fees / 100, tcs: r.tcs / 100, tds: r.tds / 100, other: r.other / 100 }));
}

/* SKU and quantity in hand (one godown or all), for the marketplace's stock upload */
export async function stockFile(c, warehouseId = 0) {
  const { results } = warehouseId
    ? await c.db.prepare(`SELECT i.sku, i.barcode, i.name, i.sale_price, COALESCE(s.qty, 0) AS qty FROM items i LEFT JOIN stock s ON s.item_id = i.id AND s.warehouse_id = ?
        WHERE i.org_id = ? AND i.is_service = 0 ORDER BY i.name`).bind(warehouseId, c.org.id).all()
    : await c.db.prepare(`SELECT sku, barcode, name, sale_price, qty_on_hand AS qty FROM items WHERE org_id = ? AND is_service = 0 ORDER BY name`).bind(c.org.id).all();
  const cell = (v) => { const t = String(v ?? ''); return /[",\n\r]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? "'" : '') + t.replace(/"/g, '""')}"` : t; };
  const lines = [['sku', 'quantity', 'price', 'name'].join(',')];
  for (const r of results) {
    const sku = r.sku || r.barcode;
    if (!sku) continue;
    lines.push([sku, Math.max(0, Math.floor(r.qty + 1e-6)), (r.sale_price / 100).toFixed(2), r.name].map(cell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

