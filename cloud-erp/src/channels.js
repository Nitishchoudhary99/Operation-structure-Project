/* Orders from Amazon, Flipkart, Meesho or any online store, imported from the order report (CSV) the seller already
   downloads: every order becomes a normal sales invoice (stock goes out, GST and the books as usual), so online and
   shop sales sit in one place. Columns are found by their usual names, items by SKU, barcode or name. Each order is
   billed to one party per channel and buyer state, e.g. "Amazon (Maharashtra)", so GST is CGST+SGST or IGST correctly.
   An order id is imported once only (channel_orders). The stock file goes the other way: SKU and quantity in hand,
   for the marketplace's inventory upload. */
import { HttpError, bad, str, roundQty, nowIso, today, loadByIds } from './lib.js';
import { requireCan } from './auth.js';
import { createDoc } from './engine.js';
import { STATES } from './gst.js';

export const CHANNELS = { amazon: 'Amazon', flipkart: 'Flipkart', meesho: 'Meesho', other: 'Online' };

const COLS = {
  order: ['amazon-order-id', 'order-id', 'order id', 'order_id', 'sub order no', 'sub order id', 'suborder id', 'order item id', 'order no', 'order number', 'order'],
  sku: ['sku', 'seller-sku', 'seller sku', 'sku id', 'sku code', 'product sku', 'item sku', 'seller sku id'],
  qty: ['quantity-purchased', 'quantity', 'qty', 'item quantity', 'quantity purchased', 'units'],
  amount: ['item-price', 'invoice amount', 'final invoice amount', 'order total', 'total amount', 'sale amount', 'total', 'amount', 'item total'],
  unit: ['selling price per item', 'price per item', 'unit price', 'selling price', 'price', 'supplier discounted price (incl gst and commision)',
    'supplier listed price (incl. gst + commission)', 'product price'],
  state: ['ship-state', 'ship state', 'shipping state', 'customer state', 'buyer state', 'delivery state', 'end customer state new', 'state'],
  date: ['purchase-date', 'order-date', 'order date', 'ordered on', 'order placed date', 'date', 'order created date'],
  name: ['product-name', 'product name', 'product title', 'item name', 'title', 'product', 'description'],
  status: ['order-status', 'order status', 'order state', 'order item status', 'sub order status', 'item status', 'shipment status', 'status', 'reason for credit entry'],
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
const ALIAS = { 'orissa': 'Odisha', 'pondicherry': 'Puducherry', 'new delhi': 'Delhi', 'nct of delhi': 'Delhi', 'jammu & kashmir': 'Jammu and Kashmir',
  'andaman & nicobar islands': 'Andaman and Nicobar Islands', 'dadra & nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu', 'uttaranchal': 'Uttarakhand' };
function cleanState(v) {
  const t = String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return '';
  const hit = STATE_BY.get(t) || STATE_BY.get(ALIAS[t] ? ALIAS[t].toLowerCase() : '') || ALIAS[t];
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
  const { results: items } = await c.db.prepare(`SELECT id, name, sku, barcode, gst_rate, is_service, unit FROM items WHERE org_id = ?`).bind(c.org.id).all();
  const bySku = new Map(), byName = new Map();
  for (const i of items) {
    if (i.sku) bySku.set(i.sku.toLowerCase(), i);
    if (i.barcode) bySku.set(i.barcode.toLowerCase(), i);
    byName.set(i.name.toLowerCase(), i);
  }
  const orders = new Map();
  for (const r of rows.slice(1)) {
    const id = str(get(r, 'order'), 60);
    if (!id) continue;
    const status = get(r, 'status').toLowerCase();
    if (/cancel|return|refund|rto/.test(status)) continue;
    if (!orders.has(id)) orders.set(id, { order_id: id, date: cleanDate(get(r, 'date')) || today(), state: cleanState(get(r, 'state')), lines: [], problems: [] });
    const o = orders.get(id);
    const sku = str(get(r, 'sku'), 60), name = str(get(r, 'name'), 120);
    const it = (sku && bySku.get(sku.toLowerCase())) || (name && byName.get(name.toLowerCase())) || null;
    const qty = roundQty(parseFloat(get(r, 'qty')) || 0);
    const amt = money(get(r, 'amount')), unit = money(get(r, 'unit'));
    const gross = Number.isFinite(amt) && amt > 0 ? amt : Number.isFinite(unit) ? unit * qty : NaN;   // price incl. GST for the line
    if (!it) { o.problems.push(`SKU ${sku || name || '?'} is not in your items`); continue; }
    if (it.is_service) { o.problems.push(`${it.name} is a service`); continue; }
    if (!(qty > 0)) { o.problems.push(`no quantity for ${it.name}`); continue; }
    if (!(gross >= 0)) { o.problems.push(`no price for ${it.name}`); continue; }
    o.lines.push({ item_id: it.id, item: it.name, unit: it.unit, qty, gst_rate: it.gst_rate, gross: Math.round(gross * 100) / 100,
      rate: Math.round((gross / (1 + it.gst_rate / 100) / qty) * 100) / 100 });
  }
  const list = [...orders.values()];
  const done = new Set((await loadByIds(c.db, `SELECT order_id FROM channel_orders WHERE org_id = ? AND channel = ? AND order_id IN (?ids)`, [c.org.id, channel],
    list.map((o) => o.order_id))).map((r) => r.order_id));
  for (const o of list) {
    o.done = done.has(o.order_id);
    o.party = `${label}${o.state ? ` (${o.state})` : ''}`;
    o.total = Math.round(o.lines.reduce((s, l) => s + l.gross, 0) * 100) / 100;
    if (!o.lines.length && !o.problems.length) o.problems.push('no lines');
  }
  return { channel, label, columns: Object.fromEntries(Object.entries(at).map(([k, i]) => [k, rows[0][i]])), orders: list,
    ready: list.filter((o) => !o.done && !o.problems.length).length, already: done.size, problems: list.filter((o) => o.problems.length).length };
}

/* bill the listed orders of the file (a few per request: each one is a full invoice) */
export async function importOrders(c, body) {
  requireCan(c.user, 'sales');
  const only = (Array.isArray(body.only) ? body.only : []).map((x) => str(x, 60)).filter(Boolean);
  if (!only.length) return readOrders(c, body);
  if (only.length > 2) throw bad('Import at most 2 orders per request.');
  const R = await readOrders(c, body);
  const out = [];
  for (const id of only) {
    const o = R.orders.find((x) => x.order_id === id);
    if (!o) { out.push({ order_id: id, error: 'not in the file' }); continue; }
    if (o.done) { out.push({ order_id: id, skipped: 'already imported' }); continue; }
    if (o.problems.length) { out.push({ order_id: id, error: o.problems.join('; ') }); continue; }
    try {
      let p = await c.db.prepare(`SELECT id FROM parties WHERE org_id = ? AND name = ?`).bind(c.org.id, o.party).first();
      if (!p) {
        // the marketplace pays out about a week later: that is when these bills fall due
        p = await c.db.prepare(`INSERT INTO parties (org_id, name, kind, state, credit_days, created_at) VALUES (?, ?, 'customer', ?, 7, ?)
            ON CONFLICT(org_id, name) DO UPDATE SET name = excluded.name RETURNING id`).bind(c.org.id, o.party, o.state, nowIso()).first();
      }
      const doc = await createDoc(c, { type: 'INV', party_id: p.id, date: o.date, warehouse_id: +body.warehouse_id || 0, notes: `${R.label} order ${o.order_id}`,
        lines: o.lines.map((l) => ({ item_id: l.item_id, qty: l.qty, rate: l.rate, gst_rate: l.gst_rate })) });
      await c.db.prepare(`INSERT INTO channel_orders (org_id, channel, order_id, doc_id, created_at) VALUES (?, ?, ?, (SELECT id FROM docs WHERE org_id = ? AND id = ?), ?)
          ON CONFLICT DO NOTHING`).bind(c.org.id, R.channel, o.order_id, c.org.id, doc.id, nowIso()).run();
      out.push({ order_id: id, doc_id: doc.id, number: doc.number });
    } catch (e) {
      const known = e instanceof HttpError && e.status < 500;
      out.push({ order_id: id, error: known ? e.message : 'could not be billed' });
      if (!known) console.error('channel import', e);
    }
  }
  return { results: out };
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

