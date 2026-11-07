/* Picking by scan: the godown agent picks one order, or many orders together from one combined list, by scanning each
   piece's QR / barcode. Each scan is checked against the orders (wrong design, colour or size, or more than ordered, is
   refused) and counted on the order line (doc_lines.picked_qty), so the progress is kept on the server: the owner sees
   it from anywhere, and the agent can carry on from another phone. When every piece of an order is picked it shows as
   Picked on the Dispatch Desk; packing it (Pack & check) saves the Delivery Note, which is when stock goes out, and the
   picked count of those lines comes back down (src/engine.js).
   One QR per design + colour + size: the same code on every piece of it. */
import { bad, forbidden, notFound, str, num } from './lib.js';
import { mayShip } from './dispatch.js';
import { auditStatement } from './engine.js';
import { findItem } from './codes.js';

const left = (l) => Math.max(0, Math.round((l.qty - l.done_qty) * 1000) / 1000);
const picked = (l) => Math.min(left(l), Math.max(0, Math.round(l.picked_qty * 1000) / 1000));
const idsOf = (v) => [...new Set(String(Array.isArray(v) ? v.join(',') : v || '').split(',').map((x) => +x).filter((x) => x > 0))].slice(0, 60);

function mayPick(c) {
  if (!mayShip(c.user)) throw forbidden('Your role cannot pick or pack orders.');
}
/* the open sales orders asked for, with their goods lines (other businesses' or closed orders are left out) */
async function ordersOf(c, ids) {
  if (!ids.length) throw bad('Choose the orders to pick.');
  const marks = ids.map(() => '?').join(',');
  const [docs, lines] = await c.db.batch([
    c.db.prepare(`SELECT d.id, d.number, d.date, d.status, d.pay_mode, d.party_id, p.name AS party, p.phone, p.city FROM docs d LEFT JOIN parties p ON p.id = d.party_id
        WHERE d.org_id = ? AND d.type = 'SO' AND d.status IN ('open', 'partial') AND d.id IN (${marks}) ORDER BY d.date, d.id`).bind(c.org.id, ...ids),
    c.db.prepare(`SELECT l.id, l.doc_id, l.item_id, l.qty, l.done_qty, l.picked_qty, i.name, i.sku, i.barcode, i.unit, i.location FROM doc_lines l JOIN docs d ON d.id = l.doc_id
        JOIN items i ON i.id = l.item_id WHERE d.org_id = ? AND d.type = 'SO' AND d.id IN (${marks}) AND i.is_service = 0 ORDER BY l.doc_id, l.id`).bind(c.org.id, ...ids),
  ]);
  if (!docs.results.length) throw notFound('None of these is an open sales order.');
  const open = new Set(docs.results.map((d) => d.id));
  return { docs: docs.results, lines: lines.results.filter((l) => open.has(l.doc_id) && left(l) > 0.0005) };
}
function stateOf(docs, lines) {
  const orders = docs.map((d) => {
    const ls = lines.filter((l) => l.doc_id === d.id);
    const need = ls.reduce((s, l) => s + left(l), 0), got = ls.reduce((s, l) => s + picked(l), 0);
    return { id: d.id, number: d.number, date: d.date, party: d.party || '', phone: d.phone || '', city: d.city || '', pay_mode: d.pay_mode || '',
      need: Math.round(need * 1000) / 1000, picked: Math.round(got * 1000) / 1000, done: need > 0 && got >= need - 0.0005,
      lines: ls.map((l) => ({ line_id: l.id, item_id: l.item_id, name: l.name, code: l.barcode || l.sku || 'ST' + l.item_id, unit: l.unit, want: left(l), picked: picked(l) })) };
  });
  // the same design, colour and size across the orders: one row to walk to, with what goes to each order
  const by = new Map();
  for (const o of orders) for (const l of o.lines) {
    if (!by.has(l.item_id)) by.set(l.item_id, { item_id: l.item_id, name: l.name, code: l.code, unit: l.unit, location: (lines.find((x) => x.item_id === l.item_id) || {}).location || '', want: 0, picked: 0, orders: [] });
    const r = by.get(l.item_id);
    r.want += l.want; r.picked += l.picked; r.orders.push({ id: o.id, number: o.number, party: o.party, want: l.want, picked: l.picked });
  }
  const items = [...by.values()].map((r) => ({ ...r, want: Math.round(r.want * 1000) / 1000, picked: Math.round(r.picked * 1000) / 1000 }))
    .sort((a, b) => (a.location || '~').localeCompare(b.location || '~') || a.name.localeCompare(b.name));
  return { orders, items, need: orders.reduce((s, o) => s + o.need, 0), picked: orders.reduce((s, o) => s + o.picked, 0), done: orders.every((o) => o.done) };
}

/* GET /api/pick?ids=1,2,3 */
export async function pickState(c, ids) {
  mayPick(c);
  const { docs, lines } = await ordersOf(c, idsOf(ids));
  return stateOf(docs, lines);
}

/* the item a scanned code stands for (src/codes.js): the app's code, a learnt code, or the product written in the QR */
async function itemOfCode(c, code) {
  const f = await findItem(c, code);
  return f.item ? { id: f.item.id, name: f.item.name, pack: f.pack || 1 } : null;
}

/* POST /api/pick/scan { ids, code }: one scan while picking. The piece goes to the oldest order still short of it; the
   count is raised only while it stays within what is ordered (checked inside the write, so two phones scanning the
   same orders cannot pick one piece too many). */
export async function pickScan(c, b) {
  mayPick(c);
  const code = str(b.code, 500).trim();
  if (!code) throw bad('Scan or type a code.');
  const ids = idsOf(b.ids);
  const it = await itemOfCode(c, code);
  if (!it) throw bad(`✗ ${code}: no item has this code.`, { wrong: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const { docs, lines } = await ordersOf(c, ids);
    const mine = lines.filter((l) => l.item_id === it.id);
    if (!mine.length) throw bad(`✗ WRONG ITEM: ${it.name} is not on ${docs.length > 1 ? 'these orders' : docs[0].number}.`, { wrong: true, item: it.name });
    const room = mine.find((l) => picked(l) + it.pack <= left(l) + 0.0005);
    if (!room) {
      const want = mine.reduce((s, l) => s + left(l), 0);
      throw bad(`✗ EXTRA: all ${want} of ${it.name} ${docs.length > 1 ? 'for these orders are' : 'are'} already picked.`, { extra: true, item: it.name });
    }
    const r = await c.db.prepare(`UPDATE doc_lines SET picked_qty = ROUND(MAX(0, picked_qty) + ?, 3) WHERE id = ? AND MAX(0, picked_qty) + ? <= qty - done_qty + 0.0005`)
      .bind(it.pack, room.id, it.pack).run();
    if (!r.meta.changes) continue;                     // another phone took that room a moment ago: look again
    room.picked_qty = Math.max(0, room.picked_qty) + it.pack;
    const s = stateOf(docs, lines), o = s.orders.find((x) => x.id === room.doc_id);
    return { ok: true, item: it.name, qty: it.pack, order: { id: o.id, number: o.number, party: o.party, city: o.city, done: o.done },
      line: { line_id: room.id, want: left(room), picked: picked(room) }, state: s };
  }
  throw bad('The orders changed while scanning. Scan again.');
}

/* POST /api/pick/undo { line_id, ids }: one piece taken back off an order line (put back on the shelf) */
export async function pickUndo(c, b) {
  mayPick(c);
  const line = await c.db.prepare(`SELECT l.id, l.doc_id, l.picked_qty, i.name FROM doc_lines l JOIN docs d ON d.id = l.doc_id LEFT JOIN items i ON i.id = l.item_id
      WHERE l.id = ? AND d.org_id = ? AND d.type = 'SO'`).bind(+b.line_id || 0, c.org.id).first();
  if (!line) throw notFound('Line not found.');
  const n = num(b.qty, 'Quantity', { min: 0.001, max: 1e6, def: 1 });
  await c.db.prepare(`UPDATE doc_lines SET picked_qty = MAX(0, ROUND(picked_qty - ?, 3)) WHERE id = ?`).bind(n, line.id).run();
  const ids = idsOf(b.ids);
  return pickState(c, ids.length ? ids : [line.doc_id]);
}

/* POST /api/pick/reset { ids }: start picking these orders again from nothing */
export async function pickReset(c, b) {
  mayPick(c);
  const ids = idsOf(b.ids);
  const { docs } = await ordersOf(c, ids);
  const marks = docs.map(() => '?').join(',');
  await c.db.batch([c.db.prepare(`UPDATE doc_lines SET picked_qty = 0 WHERE doc_id IN (${marks})`).bind(...docs.map((d) => d.id)),
    auditStatement(c, 'picking reset', docs.map((d) => d.number).join(', ').slice(0, 280))]);
  return pickState(c, docs.map((d) => d.id));
}
