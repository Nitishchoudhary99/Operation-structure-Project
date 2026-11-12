/* Restaurant tables and KOT (kitchen order tickets).
   A table's order stays open while people eat. Each "Send KOT" puts the new items on the order under one numbered
   ticket for the kitchen (no prices); an item taken off after the kitchen has it prints a CANCEL ticket. "Bill" makes
   one ordinary invoice of everything still on the order (createDoc: stock, GST, books, loyalty points as for any sale)
   and frees the table. KOT numbers start again at 1 each day. */
import { bad, notFound, str, num, nowIso, today, roundQty, uid } from './lib.js';
import { requireCan, requireCancel, randomHex, rateLimit } from './auth.js';
import { createDoc, auditStatement } from './engine.js';

const R = (p) => Math.round(p) / 100;
/* what the guest pays for a line, with GST (a menu price may already have it) */
const PAY_SQL = `l.qty * CASE WHEN l.incl = 1 THEN l.rate ELSE l.rate * (100 + l.gst_rate) / 100.0 END`;
const payOf = (l) => l.qty * (l.incl ? l.rate : l.rate * (100 + (l.gst_rate || 0)) / 100);

/* Each table's state on the floor, most urgent first: a payment to check, the bill asked for, help asked for, food
   ready to take out, food being cooked, guests eating, a guest order waiting to be accepted, or free. */
const floorState = (t) => {
  const a = t.askKinds || {}, k = t.kitchen || {};
  if (a.pay) return 'pay';
  if (a.bill) return 'bill';
  if (a.help) return 'help';
  if (k.ready) return 'ready';
  if (k.new || k.cooking) return 'cooking';
  if (t.order) return 'eating';
  if (a.order) return 'asked';
  return 'free';
};
export async function dineBoard(c) {
  const o = c.org.id;
  const [tables, orders, asks, kit, kinds] = await c.db.batch([
    c.db.prepare(`SELECT id, name, area, seats FROM dine_tables WHERE org_id = ? AND active = 1 ORDER BY area, sort, id`).bind(o),
    c.db.prepare(`SELECT d.id, d.table_id, d.opened_at, d.guests, COUNT(l.id) AS items, COALESCE(SUM(${PAY_SQL}), 0) AS amount, MAX(l.created_at) AS last_kot
        FROM dine_orders d LEFT JOIN dine_lines l ON l.order_id = d.id AND l.status = 'ok'
        WHERE d.org_id = ? AND d.status = 'open' GROUP BY d.id`).bind(o),
    c.db.prepare(`SELECT table_id, COUNT(*) AS n FROM dine_requests WHERE org_id = ? AND status = 'new' GROUP BY table_id`).bind(o),
    c.db.prepare(`SELECT d.table_id, k.kstatus, COUNT(*) AS n, MIN(k.created_at) AS oldest FROM kots k JOIN dine_orders d ON d.id = k.order_id
        WHERE d.org_id = ? AND d.status = 'open' AND k.kind = 'kot' GROUP BY d.table_id, k.kstatus`).bind(o),
    c.db.prepare(`SELECT table_id, CASE WHEN kind = 'help' AND what = 'bill' THEN 'bill' ELSE kind END AS k, COUNT(*) AS n
        FROM dine_requests WHERE org_id = ? AND status = 'new' GROUP BY table_id, k`).bind(o),
  ]);
  const kitchenOf = new Map(), kindOf = new Map();
  kit.results.forEach((x) => { const m = kitchenOf.get(x.table_id) || {}; m[x.kstatus] = x.n; if (x.kstatus !== 'served') m.oldest = m.oldest && m.oldest < x.oldest ? m.oldest : x.oldest; kitchenOf.set(x.table_id, m); });
  kinds.results.forEach((x) => { const m = kindOf.get(x.table_id) || {}; m[x.k] = x.n; kindOf.set(x.table_id, m); });
  const open = new Map(orders.results.map((x) => [x.table_id, x])), ask = new Map(asks.results.map((x) => [x.table_id, x.n]));
  return { tables: tables.results.map((t) => { const x = open.get(t.id);
      const row = { ...t, asks: ask.get(t.id) || 0, order: x ? { ...x, amount: R(x.amount) } : null, kitchen: kitchenOf.get(t.id) || {}, askKinds: kindOf.get(t.id) || {} };
      return { ...row, state: floorState(row) }; }),
    asks: asks.results.reduce((n, x) => n + x.n, 0) };
}

export async function addTables(c, body) {
  requireCan(c.user, 'settings');
  const names = String(body.names || '').split(/[\n,]+/).map((x) => x.trim().slice(0, 20)).filter(Boolean);
  const count = Math.round(num(body.count, 'Number of tables', { min: 0, max: 200, def: 0 }));
  const prefix = str(body.prefix, 10) || 'T';
  if (!names.length && count) {
    const have = await c.db.prepare(`SELECT COUNT(*) AS n FROM dine_tables WHERE org_id = ?`).bind(c.org.id).first();
    for (let i = 1; i <= count; i++) names.push(prefix + (have.n + i));
  }
  if (!names.length) throw bad('Type the table names, or how many tables to add.');
  if (names.length > 200) throw bad('At most 200 tables at a time.');
  const area = str(body.area, 30), seats = Math.round(num(body.seats, 'Seats', { min: 0, max: 100, def: 4 }));
  await c.db.batch([...names.map((n, i) => c.db.prepare(`INSERT INTO dine_tables (org_id, name, area, seats, sort, active) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT (org_id, name) DO UPDATE SET active = 1, area = excluded.area, seats = excluded.seats`).bind(c.org.id, n, area, seats, i)),
    auditStatement(c, 'tables', `${names.length} added`)]);
  return dineBoard(c);
}

export async function removeTable(c, id) {
  requireCan(c.user, 'settings');
  const busy = await c.db.prepare(`SELECT 1 FROM dine_orders WHERE table_id = ? AND org_id = ? AND status = 'open'`).bind(id, c.org.id).first();
  if (busy) throw bad('This table has an open order. Bill it or move it first.');
  const r = await c.db.prepare(`UPDATE dine_tables SET active = 0 WHERE id = ? AND org_id = ?`).bind(id, c.org.id).run();
  if (!r.meta.changes) throw notFound('Table not found.');      // another business's table, or none: never a quiet "ok"
  return dineBoard(c);
}

async function tableOf(c, id) {
  const t = await c.db.prepare(`SELECT * FROM dine_tables WHERE id = ? AND org_id = ? AND active = 1`).bind(id, c.org.id).first();
  if (!t) throw notFound('Table not found.');
  return t;
}
const openOrder = (c, tableId) => c.db.prepare(`SELECT * FROM dine_orders WHERE table_id = ? AND org_id = ? AND status = 'open'`).bind(tableId, c.org.id).first();

export async function tableDetail(c, tableId) {
  const t = await tableOf(c, tableId);
  const d = await openOrder(c, t.id);
  if (!d) return { table: t, order: null, lines: [], kots: [] };
  const [lines, kots] = await c.db.batch([
    c.db.prepare(`SELECT l.*, k.number AS kot_no FROM dine_lines l LEFT JOIN kots k ON k.id = l.kot_id WHERE l.order_id = ? ORDER BY l.id`).bind(d.id),
    c.db.prepare(`SELECT id, number, created_at, kind FROM kots WHERE order_id = ? ORDER BY id`).bind(d.id),
  ]);
  const ok = lines.results.filter((l) => l.status === 'ok');
  return { table: t, order: { ...d, amount: R(ok.reduce((s, l) => s + payOf(l), 0)) },
    lines: lines.results.map((l) => ({ ...l, rate: R(l.rate), amount: R(payOf(l)) })), kots: kots.results };
}

/* the next KOT number of the day, taken inside the same batch as the ticket */
const kotInsert = (c, orderId, kind, key, day) => c.db.prepare(`INSERT INTO kots (org_id, order_id, number, day, kind, created_at, created_by, txk)
    VALUES (?1, ?2, (SELECT COALESCE(MAX(number), 0) + 1 FROM kots WHERE org_id = ?1 AND day = ?3), ?3, ?4, ?5, ?6, ?7)`)
  .bind(c.org.id, orderId, day, kind, nowIso(), c.user.id, key);

/* new items for the kitchen: opens the table's order if it has none, and returns the ticket to print */
export async function sendKot(c, tableId, body) {
  requireCan(c.user, 'sales');
  const t = await tableOf(c, tableId);
  const raw = Array.isArray(body.lines) ? body.lines : [];
  if (!raw.length) throw bad('Add the items first.');
  if (raw.length > 100) throw bad('At most 100 items on one KOT.');
  const ids = [...new Set(raw.map((l) => +l.item_id || 0))];
  const { results: its } = await c.db.prepare(`SELECT id, name, sale_price, gst_rate, price_incl FROM items WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(c.org.id, ...ids).all();
  const byId = new Map(its.map((i) => [i.id, i]));
  const lines = raw.map((l, n) => {
    const it = byId.get(+l.item_id);
    if (!it) throw bad(`Item ${n + 1}: not found.`);
    const qty = roundQty(num(l.qty, `${it.name} quantity`, { min: 0.001, max: 10000 }));
    // the price the guest pays (with GST for an MRP-style menu item); the bill works out GST from it
    const rate = it.price_incl ? Math.round(it.sale_price * (100 + (it.gst_rate || 0)) / 100) : it.sale_price;
    return { it, qty, rate, incl: it.price_incl ? 1 : 0, note: str(l.note, 80) };
  });
  const day = today(), key = uid(), at = nowIso();
  let d = await openOrder(c, t.id);
  const st = [];
  if (!d) {
    st.push(c.db.prepare(`INSERT INTO dine_orders (org_id, table_id, status, opened_at, opened_by, guests, note) VALUES (?, ?, 'open', ?, ?, ?, ?)`)
      .bind(c.org.id, t.id, at, c.user.id, Math.round(num(body.guests, 'Guests', { min: 0, max: 500, def: 0 })), ''));
  }
  const orderSql = `(SELECT id FROM dine_orders WHERE table_id = ${+t.id} AND org_id = ${+c.org.id} AND status = 'open')`;
  st.push(c.db.prepare(`INSERT INTO kots (org_id, order_id, number, day, kind, created_at, created_by, txk)
      VALUES (?1, ${orderSql}, (SELECT COALESCE(MAX(number), 0) + 1 FROM kots WHERE org_id = ?1 AND day = ?2), ?2, 'kot', ?3, ?4, ?5)`)
    .bind(c.org.id, day, at, c.user.id, key));
  for (const l of lines) {
    st.push(c.db.prepare(`INSERT INTO dine_lines (order_id, item_id, name, qty, rate, incl, gst_rate, note, kot_id, status, created_at, created_by)
        VALUES (${orderSql}, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM kots WHERE txk = ?), 'ok', ?, ?)`)
      .bind(l.it.id, l.it.name, l.qty, l.rate, l.incl, l.it.gst_rate || 0, l.note, key, at, c.user.id));
  }
  try { await c.db.batch(st); } catch (e) {
    if (/UNIQUE constraint failed: dine_orders/.test(String(e && e.message))) throw bad('Someone just opened this table. Open it again and send the KOT.');
    throw e;
  }
  const k = await c.db.prepare(`SELECT id, number, created_at FROM kots WHERE txk = ?`).bind(key).first();
  return { kot: { id: k.id, number: k.number, at: k.created_at, kind: 'kot', table: t.name, user: c.user.name || '', lines: lines.map((l) => ({ name: l.it.name, qty: l.qty, note: l.note })) },
    ...(await tableDetail(c, t.id)) };
}

/* an item taken off: before the bill only; once the kitchen has it, a CANCEL ticket says so (and the role must be allowed to cancel) */
export async function voidLine(c, lineId, body) {
  requireCan(c.user, 'sales');
  const l = await c.db.prepare(`SELECT l.*, d.table_id, d.org_id, d.status AS order_status FROM dine_lines l JOIN dine_orders d ON d.id = l.order_id WHERE l.id = ? AND d.org_id = ?`)
    .bind(lineId, c.org.id).first();
  if (!l) throw notFound('Item not found.');
  if (l.order_status !== 'open') throw bad('This order is already billed.');
  if (l.status !== 'ok') throw bad('Already taken off.');
  requireCancel(c.user);
  const qty = body && body.qty ? roundQty(num(body.qty, 'Quantity to take off', { min: 0.001, max: l.qty })) : l.qty;
  const reason = str(body && body.reason, 80);
  const key = uid(), at = nowIso();
  const st = [kotInsert(c, l.order_id, 'cancel', key, today())];
  if (qty < l.qty - 0.0005) {      // part of it: the rest stays as it was
    st.push(c.db.prepare(`UPDATE dine_lines SET qty = ROUND(qty - ?, 3) WHERE id = ?`).bind(qty, l.id));
    st.push(c.db.prepare(`INSERT INTO dine_lines (order_id, item_id, name, qty, rate, incl, gst_rate, note, kot_id, status, created_at, created_by, void_kot_id, void_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'void', ?, ?, (SELECT id FROM kots WHERE txk = ?), ?)`)
      .bind(l.order_id, l.item_id, l.name, qty, l.rate, l.incl, l.gst_rate, l.note, l.kot_id, at, c.user.id, key, reason));
  } else {
    st.push(c.db.prepare(`UPDATE dine_lines SET status = 'void', void_kot_id = (SELECT id FROM kots WHERE txk = ?), void_reason = ? WHERE id = ?`).bind(key, reason, l.id));
  }
  st.push(auditStatement(c, 'KOT item cancelled', `${l.name} x${qty}${reason ? ' - ' + reason : ''}`));
  await c.db.batch(st);
  const k = await c.db.prepare(`SELECT number, created_at FROM kots WHERE txk = ?`).bind(key).first();
  const t = await tableOf(c, l.table_id);
  return { kot: { number: k.number, at: k.created_at, kind: 'cancel', table: t.name, user: c.user.name || '', lines: [{ name: l.name, qty, note: reason }] }, ...(await tableDetail(c, t.id)) };
}

export async function moveOrder(c, tableId, body) {
  requireCan(c.user, 'sales');
  const from = await tableOf(c, tableId), to = await tableOf(c, +body.to || 0);
  if (from.id === to.id) throw bad('Choose another table.');
  const d = await openOrder(c, from.id);
  if (!d) throw bad(`${from.name} has no open order.`);
  if (await openOrder(c, to.id)) throw bad(`${to.name} already has an order. Bill it first, or move this one to a free table.`);
  await c.db.batch([c.db.prepare(`UPDATE dine_orders SET table_id = ? WHERE id = ? AND status = 'open'`).bind(to.id, d.id), auditStatement(c, 'table moved', `${from.name} to ${to.name}`)]);
  return tableDetail(c, to.id);
}

/* one invoice of everything on the order (same item at the same price on one line), the table freed */
export async function billOrder(c, tableId, body) {
  requireCan(c.user, 'sales');
  const t = await tableOf(c, tableId);
  const d = await openOrder(c, t.id);
  if (!d) throw bad(`${t.name} has no open order.`);
  const { results } = await c.db.prepare(`SELECT item_id, rate, incl, gst_rate, SUM(qty) AS qty FROM dine_lines WHERE order_id = ? AND status = 'ok'
      GROUP BY item_id, rate, incl, gst_rate ORDER BY MIN(id)`).bind(d.id).all();
  if (!results.length) throw bad('Nothing on this order to bill. Cancel the order instead.');
  const disc = num(body.discount_pct, 'Discount', { min: 0, max: 100, def: 0 });
  const kots = await c.db.prepare(`SELECT number FROM kots WHERE order_id = ? AND kind = 'kot' ORDER BY id`).bind(d.id).all();
  const walkIn = +body.party_id ? null : await c.db.prepare(`SELECT id FROM parties WHERE org_id = ? AND name = 'Walk-in Customer'`).bind(c.org.id).first();
  // one bill per order even when two people press Bill together: the order is held while the invoice is made
  const hold = await c.db.prepare(`UPDATE dine_orders SET status = 'billing' WHERE id = ? AND status = 'open'`).bind(d.id).run();
  if (!hold.meta.changes) throw bad('This table is being billed already.');
  let doc;
  try {
    doc = await createDoc(c, {
    type: 'INV', party_id: +body.party_id || (walkIn && walkIn.id) || 0, warehouse_id: +body.warehouse_id || 0, date: today(),
    notes: `Table ${t.name}${d.guests ? ` · ${d.guests} guests` : ''} · KOT ${kots.results.map((k) => k.number).join(', ')}`,
    lines: results.map((l) => ({ item_id: l.item_id, qty: roundQty(l.qty), rate: l.rate / 100, incl: l.incl === 1, gst_rate: l.gst_rate, discount_pct: disc })),
    // "paid in full" pays the bill's own total (rounded to the rupee), whatever the running amount showed
    payment: body.payment ? { ...body.payment, amount: body.payment.full ? 1e9 : body.payment.amount } : undefined,
    redeem_points: body.redeem_points, credit_ok: body.credit_ok, extra: body.extra,
    });
  } catch (e) {
    await c.db.prepare(`UPDATE dine_orders SET status = 'open' WHERE id = ? AND status = 'billing'`).bind(d.id).run();
    throw e;
  }
  await c.db.prepare(`UPDATE dine_orders SET status = 'billed', doc_id = ?, closed_at = ? WHERE id = ?`).bind(doc.id, nowIso(), d.id).run();
  return { doc_id: doc.id, number: doc.number };
}

/* an order nobody pays for (guests left before eating): owner or a role allowed to cancel */
export async function voidOrder(c, tableId, body) {
  requireCan(c.user, 'sales');
  requireCancel(c.user);
  const t = await tableOf(c, tableId);
  const d = await openOrder(c, t.id);
  if (!d) throw bad(`${t.name} has no open order.`);
  const reason = str(body && body.reason, 80);
  await c.db.batch([c.db.prepare(`UPDATE dine_orders SET status = 'void', closed_at = ?, note = ? WHERE id = ?`).bind(nowIso(), reason, d.id),
    auditStatement(c, 'table order cancelled', `${t.name}${reason ? ' - ' + reason : ''}`)]);
  return dineBoard(c);
}

/* the day's KOT log: tickets sent, items cancelled after the kitchen had them, and orders cancelled (owner's check on leaks) */
export async function kotLog(c, day) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : today();
  const [kots, lines] = await c.db.batch([
    c.db.prepare(`SELECT k.id, k.number, k.kind, k.created_at, t.name AS table_name, u.name AS user
        FROM kots k JOIN dine_orders o ON o.id = k.order_id JOIN dine_tables t ON t.id = o.table_id LEFT JOIN users u ON u.id = k.created_by
        WHERE k.org_id = ? AND k.day = ? ORDER BY k.id DESC LIMIT 500`).bind(c.org.id, d),
    c.db.prepare(`SELECT l.id, l.kot_id, l.void_kot_id, l.item_id, l.name, l.qty FROM dine_lines l JOIN kots k ON k.id = l.kot_id WHERE k.org_id = ? AND k.day = ?
      UNION SELECT l.id, l.kot_id, l.void_kot_id, l.item_id, l.name, l.qty FROM dine_lines l JOIN kots k ON k.id = l.void_kot_id WHERE k.org_id = ? AND k.day = ?`)
      .bind(c.org.id, d, c.org.id, d),
  ]);
  // a ticket shows what it sent (a part taken off later is still counted on the ticket that sent it), a CANCEL ticket what it took off
  const sent = new Map(), off = new Map();
  const add = (m, k, l) => { if (!k) return; const x = m.get(k) || new Map(); const key = `${l.item_id}|${l.name}`; x.set(key, { name: l.name, qty: ((x.get(key) || {}).qty || 0) + l.qty }); m.set(k, x); };
  for (const l of lines.results) { add(sent, l.kot_id, l); if (l.void_kot_id) add(off, l.void_kot_id, l); }
  const text = (m) => [...(m ? m.values() : [])].map((x) => `${Math.round(x.qty * 1000) / 1000} x ${x.name}`).join(', ');
  const rows = kots.results.map((k) => ({ ...k, items: text((k.kind === 'cancel' ? off : sent).get(k.id)) }));
  return { day: d, rows, cancels: rows.filter((r) => r.kind === 'cancel').length };
}

/* ======================================================================= QR table ordering
   Each table has its own QR link (/t/<token>). A guest sees the menu (items on sale, prices with GST; never stock, costs or
   anyone else's order), sends an order or asks for help, and follows only what they sent, with the private token each request
   gave back. Nothing a guest sends reaches the kitchen by itself: a staff member accepts it, and that makes an ordinary KOT
   (sendKot, same numbering, printing and billing as any other). The kitchen screen moves each KOT on: new, cooking, ready, served. */
const HELP = { water: 'Water', cutlery: 'Cutlery', tissues: 'Tissues', bill: 'The bill', other: 'Help' };
const KSTATUS = ['new', 'cooking', 'ready', 'served'];
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const same = (a, b) => { a = String(a); b = String(b); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
export const dineSettingsOf = (o) => { let s = {}; try { s = JSON.parse(o.dine || '{}') || {}; } catch (e) { s = {}; } return { qr: !!s.qr, note: String(s.note || '').slice(0, 200), kt: /^[0-9a-f]{24}$/.test(s.kt || '') ? s.kt : '' }; };
const ipOf = (c) => c.request.headers.get('CF-Connecting-IP') || 'local';

/* the table a QR link opens, with its business; null when the link is wrong or the business has QR ordering off */
async function guestTable(c, token) {
  if (!/^[0-9a-f]{24}$/.test(String(token || ''))) return null;
  const t = await c.db.prepare(`SELECT t.id, t.name, t.org_id, o.name AS org, o.city, o.dine FROM dine_tables t JOIN orgs o ON o.id = t.org_id
      WHERE t.qr_token = ? AND t.active = 1`).bind(token).first();
  if (!t || !dineSettingsOf(t).qr) return null;
  return t;
}
const noTable = () => notFound('This table QR is not taking orders right now. Please ask the staff.');

export async function guestMenu(c, token) {
  await rateLimit(c.env, 'dine:' + ipOf(c), 300, 600);
  const t = await guestTable(c, token);
  if (!t) throw noTable();
  const { results } = await c.db.prepare(`SELECT id, name, unit, category, sale_price, gst_rate, price_incl, food, sold_out FROM items
      WHERE org_id = ? AND shop_hide = 0 AND sale_price > 0 AND is_service IN (0, 1) ORDER BY category, name LIMIT 1000`).bind(t.org_id).all();
  const day = today();
  return { shop: { name: t.org, city: t.city || '', note: dineSettingsOf(t).note }, table: t.name, help: Object.keys(HELP),
    items: results.map((i) => ({ id: i.id, name: i.name, unit: i.unit, category: i.category || '', price: R(i.sale_price * (100 + (i.gst_rate || 0)) / 100),
      food: FOOD.includes(i.food) ? i.food : '', sold_out: i.sold_out === day })) };
}

/* the table's running bill as the guest sees it: dishes, quantities and amounts with GST, the total to pay (rounded to
   the rupee, as the bill will be) and the shop's UPI ID when it has one. Nothing about who served or other tables. */
async function tableBill(c, tableId) {
  const d = await c.db.prepare(`SELECT id FROM dine_orders WHERE table_id = ? AND status = 'open'`).bind(tableId).first();
  if (!d) return { lines: [], total: 0, pay: 0 };
  const { results } = await c.db.prepare(`SELECT name, rate, incl, gst_rate, SUM(qty) AS qty FROM dine_lines WHERE order_id = ? AND status = 'ok'
      GROUP BY name, rate, incl, gst_rate ORDER BY MIN(id)`).bind(d.id).all();
  const lines = results.map((l) => ({ name: l.name, qty: Math.round(l.qty * 1000) / 1000, amount: R(payOf(l)) }));
  const total = R(results.reduce((s, l) => s + payOf(l), 0));
  return { lines, total, pay: Math.round(total) };
}
export async function guestBill(c, token) {
  await rateLimit(c.env, 'dine:' + ipOf(c), 300, 600);
  const t = await guestTable(c, token);
  if (!t) throw noTable();
  const o = await c.db.prepare(`SELECT upi_id FROM orgs WHERE id = ?`).bind(t.org_id).first();
  return { table: t.name, shop: t.org, upi: (o && o.upi_id) || '', ...(await tableBill(c, t.id)) };
}

/* a guest's order or call for help: waits for the staff; the reply carries the private token for following it */
export async function guestSend(c, token, body) {
  const ip = ipOf(c);
  await rateLimit(c.env, 'dine-send:' + ip, 20, 600);
  const t = await guestTable(c, token);
  if (!t) throw noTable();
  const kind = body && ['help', 'pay'].includes(body.kind) ? body.kind : 'order';
  const waiting = await c.db.prepare(`SELECT COUNT(*) AS n FROM dine_requests WHERE table_id = ? AND status = 'new'`).bind(t.id).first();
  if (waiting.n >= 8) throw bad('The staff have not seen this table\'s last requests yet. Please wait a moment.');
  let lines = [], what = '', total = 0, amount = 0, ref = '';
  if (kind === 'order') {
    const raw = Array.isArray(body.lines) ? body.lines : [];
    if (!raw.length) throw bad('Add something from the menu first.');
    if (raw.length > 40) throw bad('At most 40 dishes in one order.');
    const ids = [...new Set(raw.map((l) => +l.item_id || 0))];
    const { results } = await c.db.prepare(`SELECT id, name, sale_price, gst_rate, sold_out FROM items WHERE org_id = ? AND shop_hide = 0 AND sale_price > 0
        AND id IN (${ids.map(() => '?').join(',')})`).bind(t.org_id, ...ids).all();
    const byId = new Map(results.map((i) => [i.id, i]));
    lines = raw.map((l) => {
      const it = byId.get(+l.item_id);
      if (!it) throw bad('Something in the order is no longer on the menu. Please refresh the menu.');
      if (it.sold_out === today()) throw bad(`Sorry, ${it.name} is finished for today. Please take it out of the order.`);
      const qty = Math.round(+l.qty);
      if (!(qty >= 1 && qty <= 50)) throw bad(`${it.name}: choose 1 to 50.`);
      const price = R(it.sale_price * (100 + (it.gst_rate || 0)) / 100);
      total += price * qty;
      return { item_id: it.id, name: it.name, qty, price, note: str(l.note, 80) };
    });
  } else if (kind === 'pay') {
    // "I have paid by UPI": for the bill as it is now; the staff check the money came in before the bill is made
    const bill = await tableBill(c, t.id);
    if (!bill.pay) throw bad('There is no bill on this table yet.');
    if (Math.round(+body.amount) !== bill.pay) throw bad('The bill has changed. Please look at it again before paying.');
    amount = bill.pay; what = 'upi'; ref = str(body.ref, 30).replace(/[^0-9A-Za-z]/g, '');
    const dup = await c.db.prepare(`SELECT id FROM dine_requests WHERE table_id = ? AND kind = 'pay' AND status = 'new'`).bind(t.id).first();
    if (dup) throw bad('The staff are already checking a payment for this table.');
  } else {
    what = Object.hasOwn(HELP, body && body.what) ? body.what : 'other';
    // the same call twice is one call
    const dup = await c.db.prepare(`SELECT id FROM dine_requests WHERE table_id = ? AND kind = 'help' AND what = ? AND status = 'new'`).bind(t.id, what).first();
    if (dup) return { id: dup.id, token: null, again: true };
  }
  const secret = randomHex(16);
  const r = await c.db.prepare(`INSERT INTO dine_requests (org_id, table_id, kind, status, lines, what, note, guest, token_hash, created_at, amount)
      VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(t.org_id, t.id, kind, JSON.stringify(lines), what, kind === 'pay' ? ref : str(body && body.note, 200), str(body && body.name, 40), await sha(secret), nowIso(), amount).first();
  return { id: r.id, token: secret, total: Math.round(total * 100) / 100 };
}

/* what became of the guest's own requests: ?r=<id>.<token>,... (up to 20); others' requests are never shown */
export async function guestStatus(c, token, list) {
  await rateLimit(c.env, 'dine:' + ipOf(c), 300, 600);
  const t = await guestTable(c, token);
  if (!t) throw noTable();
  const want = String(list || '').split(',').slice(0, 20).map((x) => x.split('.')).filter(([id, s]) => /^\d+$/.test(id) && /^[0-9a-f]{32}$/.test(s || ''));
  const out = [];
  for (const [id, s] of want) {
    const r = await c.db.prepare(`SELECT r.id, r.kind, r.status, r.what, r.reason, r.lines, r.created_at, r.token_hash, r.amount, k.kstatus, k.number AS kot_no
        FROM dine_requests r LEFT JOIN kots k ON k.id = r.kot_id WHERE r.id = ? AND r.table_id = ?`).bind(+id, t.id).first();
    if (!r || !same(r.token_hash, await sha(s))) continue;
    let lines = []; try { lines = JSON.parse(r.lines); } catch (e) { lines = []; }
    out.push({ id: r.id, kind: r.kind, status: r.status, what: r.what, reason: r.reason, at: r.created_at, kitchen: r.kstatus || null, kot: r.kot_no || null, amount: r.amount || 0,
      lines: lines.map((l) => ({ name: l.name, qty: l.qty })) });
  }
  return { requests: out };
}

/* ---- the staff side ---- */
export async function dineRequests(c) {
  requireCan(c.user, 'sales');
  const { results } = await c.db.prepare(`SELECT r.id, r.table_id, r.kind, r.lines, r.what, r.note, r.guest, r.created_at, r.amount, t.name AS table_name
      FROM dine_requests r JOIN dine_tables t ON t.id = r.table_id WHERE r.org_id = ? AND r.status = 'new' ORDER BY r.id LIMIT 200`).bind(c.org.id).all();
  return { requests: results.map((r) => { let lines = []; try { lines = JSON.parse(r.lines); } catch (e) { lines = []; }
    return { ...r, lines, help: r.kind === 'help' ? HELP[r.what] || 'Help' : r.kind === 'pay' ? 'Paid by UPI' : '', total: r.kind === 'pay' ? r.amount : Math.round(lines.reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100 }; }) };
}

/* accept a guest order: it becomes a KOT now (prices from the menu as it is now, as for any KOT); one staff member wins a race */
export async function acceptRequest(c, id) {
  requireCan(c.user, 'sales');
  const r = await c.db.prepare(`SELECT * FROM dine_requests WHERE id = ? AND org_id = ?`).bind(id, c.org.id).first();
  if (!r) throw notFound('Request not found.');
  if (r.kind !== 'order') throw bad('This is a call for help: mark it done.');
  const hold = await c.db.prepare(`UPDATE dine_requests SET status = 'accepting', handled_by = ?, handled_at = ? WHERE id = ? AND status = 'new'`).bind(c.user.id, nowIso(), r.id).run();
  if (!hold.meta.changes) throw bad('Someone has already answered this order.');
  let res;
  try {
    const lines = JSON.parse(r.lines).map((l) => ({ item_id: l.item_id, qty: l.qty, note: [l.note, r.guest && `for ${r.guest}`].filter(Boolean).join(' · ').slice(0, 80) }));
    res = await sendKot(c, r.table_id, { lines });
  } catch (e) {
    await c.db.prepare(`UPDATE dine_requests SET status = 'new', handled_by = NULL, handled_at = NULL WHERE id = ? AND status = 'accepting'`).bind(r.id).run();
    throw e;
  }
  await c.db.batch([c.db.prepare(`UPDATE dine_requests SET status = 'accepted', kot_id = ? WHERE id = ?`).bind(res.kot.id, r.id),
    auditStatement(c, 'QR order accepted', `table ${res.kot.table}, KOT ${res.kot.number}`)]);
  return { kot: res.kot, ...(await dineRequests(c)) };
}

/* "paid by UPI" checked by the staff (the money is in the shop's UPI app): the table's bill is made, paid in full to
   the UPI account, and the table is free. The bill must still be what the guest paid for. */
export async function settleRequest(c, id) {
  requireCan(c.user, 'sales');
  const r = await c.db.prepare(`SELECT * FROM dine_requests WHERE id = ? AND org_id = ?`).bind(id, c.org.id).first();
  if (!r) throw notFound('Request not found.');
  if (r.kind !== 'pay') throw bad('This is not a payment.');
  const bill = await tableBill(c, r.table_id);
  if (bill.pay !== Math.round(r.amount)) throw bad(`The bill is now ₹${bill.pay}, the guest paid ₹${Math.round(r.amount)}. Settle the difference at the counter and bill the table from its page.`);
  const upi = await c.db.prepare(`SELECT id FROM accounts WHERE org_id = ? AND sys = 'upi'`).bind(c.org.id).first();
  if (!upi) throw bad('There is no UPI account in your books.');
  const hold = await c.db.prepare(`UPDATE dine_requests SET status = 'accepting', handled_by = ?, handled_at = ? WHERE id = ? AND status = 'new'`).bind(c.user.id, nowIso(), r.id).run();
  if (!hold.meta.changes) throw bad('Someone has already answered this payment.');
  let b;
  try { b = await billOrder(c, r.table_id, { payment: { full: true, account_id: upi.id, reference: r.note ? 'UPI ' + r.note : 'UPI at table' } }); } catch (e) {
    await c.db.prepare(`UPDATE dine_requests SET status = 'new', handled_by = NULL, handled_at = NULL WHERE id = ? AND status = 'accepting'`).bind(r.id).run();
    throw e;
  }
  await c.db.batch([c.db.prepare(`UPDATE dine_requests SET status = 'done', doc_id = ? WHERE id = ?`).bind(b.doc_id, r.id),
    auditStatement(c, 'table paid by UPI', `₹${Math.round(r.amount)}${r.note ? ', ref ' + r.note : ''}, ${b.number}`)]);
  return b;
}

export async function answerRequest(c, id, body, status) {
  requireCan(c.user, 'sales');
  const reason = status === 'rejected' ? str(body && body.reason, 120) : '';
  const r = await c.db.prepare(`UPDATE dine_requests SET status = ?, reason = ?, handled_by = ?, handled_at = ? WHERE id = ? AND org_id = ? AND status = 'new'`)
    .bind(status, reason, c.user.id, nowIso(), id, c.org.id).run();
  if (!r.meta.changes) throw bad('Someone has already answered this request.');
  return dineRequests(c);
}

/* the kitchen screen: today's tickets not yet served (and cancellations not yet seen), oldest first, with their items */
export async function kitchen(c) {
  requireCan(c.user, 'kitchen');
  return kitchenOf(c, c.org.id);
}
async function kitchenOf(c, orgId) {
  const day = today();
  const [kots, lines] = await c.db.batch([
    c.db.prepare(`SELECT k.id, k.number, k.kind, k.kstatus, k.created_at, t.name AS table_name FROM kots k JOIN dine_orders o ON o.id = k.order_id
        JOIN dine_tables t ON t.id = o.table_id WHERE k.org_id = ? AND k.day = ? AND k.kstatus != 'served' ORDER BY k.id LIMIT 200`).bind(orgId, day),
    c.db.prepare(`SELECT l.kot_id, l.void_kot_id, l.name, l.qty, l.note FROM dine_lines l JOIN kots k ON k.id = l.kot_id OR k.id = l.void_kot_id
        WHERE k.org_id = ? AND k.day = ? AND k.kstatus != 'served'`).bind(orgId, day),
  ]);
  return { day, kots: kots.results.map((k) => ({ ...k, lines: lines.results.filter((l) => (k.kind === 'cancel' ? l.void_kot_id : l.kot_id) === k.id).map((l) => ({ name: l.name, qty: l.qty, note: l.note })) })) };
}

export async function kotStatus(c, id, body) {
  requireCan(c.user, 'kitchen');
  return setKot(c, c.org.id, id, body);
}
async function setKot(c, orgId, id, body) {
  const st = body && body.status;
  if (!KSTATUS.includes(st)) throw bad('Unknown kitchen status.');
  const now = nowIso();
  const r = await c.db.prepare(`UPDATE kots SET kstatus = ?, kstatus_at = ?, ready_at = CASE WHEN ? = 'ready' THEN COALESCE(ready_at, ?) ELSE ready_at END
      WHERE id = ? AND org_id = ?`).bind(st, now, st, now, id, orgId).run();
  if (!r.meta.changes) throw notFound('KOT not found.');
  return kitchenOf(c, orgId);
}

/* QR set-up: the switch and note, and every table's link (made the first time it is asked for) */
export async function dineQr(c) {
  requireCan(c.user, 'settings');
  const { results } = await c.db.prepare(`SELECT id FROM dine_tables WHERE org_id = ? AND active = 1 AND qr_token IS NULL`).bind(c.org.id).all();
  if (results.length) await c.db.batch(results.map((t) => c.db.prepare(`UPDATE dine_tables SET qr_token = ? WHERE id = ? AND qr_token IS NULL`).bind(randomHex(12), t.id)));
  const t = await c.db.prepare(`SELECT id, name, area, qr_token FROM dine_tables WHERE org_id = ? AND active = 1 ORDER BY area, sort, id`).bind(c.org.id).all();
  const origin = new URL(c.request.url).origin;
  const st = dineSettingsOf(c.org);
  return { qr: st.qr, note: st.note, kitchen_link: st.kt ? `${origin}/kd/${st.kt}` : '', tables: t.results.map((x) => ({ id: x.id, name: x.name, area: x.area, link: `${origin}/t/${x.qr_token}` })) };
}
export async function saveDineSettings(c, body) {
  requireCan(c.user, 'settings');
  const s = { qr: body && body.qr === true, note: str(body && body.note, 200), kt: dineSettingsOf(c.org).kt };
  await c.db.batch([c.db.prepare(`UPDATE orgs SET dine = ? WHERE id = ?`).bind(JSON.stringify(s), c.org.id), auditStatement(c, 'QR table ordering', s.qr ? 'on' : 'off')]);
  c.org.dine = JSON.stringify(s);
  return dineQr(c);
}
/* a new QR for one table: the old one stops working at once (a QR photographed and used from outside) */
export async function newTableQr(c, id) {
  requireCan(c.user, 'settings');
  const r = await c.db.prepare(`UPDATE dine_tables SET qr_token = ? WHERE id = ? AND org_id = ? AND active = 1`).bind(randomHex(12), id, c.org.id).run();
  if (!r.meta.changes) throw notFound('Table not found.');
  await c.db.batch([auditStatement(c, 'table QR', `new link for table ${id}`)]);
  return dineQr(c);
}

/* ======================================================================= the owner's live view of the restaurant today
   Tables busy now, money billed from tables, guest QR orders and how they were answered, how long tables stay and the
   kitchen takes, the dishes selling most, KOTs hour by hour, and money received today by mode. Owner / finance only. */
export async function dineToday(c) {
  requireCan(c.user, 'finance');
  const o = c.org.id, day = today(), from = new Date(Date.parse(day + 'T00:00:00+05:30')).toISOString();
  const [billed, reqs, kitchenTime, dishes, hours, money, board] = await Promise.all([
    c.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(x.total), 0) AS total, AVG((julianday(d.closed_at) - julianday(d.opened_at)) * 1440) AS mins
        FROM dine_orders d JOIN docs x ON x.id = d.doc_id WHERE d.org_id = ? AND d.status = 'billed' AND x.date = ? AND x.status != 'cancelled'`).bind(o, day).first(),
    c.db.prepare(`SELECT kind, status, COUNT(*) AS n FROM dine_requests WHERE org_id = ? AND created_at >= ? GROUP BY kind, status`).bind(o, from).all(),
    c.db.prepare(`SELECT AVG((julianday(ready_at) - julianday(created_at)) * 1440) AS mins, COUNT(*) AS n FROM kots WHERE org_id = ? AND day = ? AND kind = 'kot' AND ready_at IS NOT NULL`).bind(o, day).first(),
    c.db.prepare(`SELECT l.name, SUM(l.qty) AS qty, SUM(${PAY_SQL}) AS amount FROM dine_lines l JOIN kots k ON k.id = l.kot_id
        WHERE k.org_id = ? AND k.day = ? AND l.status = 'ok' GROUP BY l.name ORDER BY qty DESC LIMIT 8`).bind(o, day).all(),
    c.db.prepare(`SELECT CAST(strftime('%H', created_at, '+330 minutes') AS INTEGER) AS h, COUNT(*) AS n FROM kots WHERE org_id = ? AND day = ? AND kind = 'kot' GROUP BY h ORDER BY h`).bind(o, day).all(),
    c.db.prepare(`SELECT a.sys, a.name, SUM(p.amount) AS amount FROM payments p JOIN accounts a ON a.id = p.account_id
        WHERE p.org_id = ? AND p.kind = 'receipt' AND p.date = ? GROUP BY a.id ORDER BY amount DESC`).bind(o, day).all(),
    dineBoard(c),
  ]);
  const q = { order: { new: 0, accepted: 0, rejected: 0 }, help: 0, pay: { new: 0, done: 0, rejected: 0 } };
  reqs.results.forEach((r) => {
    if (r.kind === 'order') q.order[r.status === 'accepting' ? 'new' : r.status] = (q.order[r.status] || 0) + r.n;
    else if (r.kind === 'help') q.help += r.n;
    else if (r.kind === 'pay') q.pay[r.status === 'accepting' ? 'new' : r.status] = (q.pay[r.status] || 0) + r.n;
  });
  const busy = board.tables.filter((t) => t.state !== 'free');
  return {
    day, tables: board.tables.length, busy: busy.length, running: R(board.tables.reduce((s, t) => s + (t.order ? t.order.amount * 100 : 0), 0)),
    states: board.tables.reduce((m, t) => { m[t.state] = (m[t.state] || 0) + 1; return m; }, {}),
    billed: { bills: billed.n, total: R(billed.total), table_mins: billed.mins == null ? null : Math.round(billed.mins) },
    kitchen_mins: kitchenTime.mins == null ? null : Math.round(kitchenTime.mins), kots_ready: kitchenTime.n,
    qr: q, dishes: dishes.results.map((d) => ({ name: d.name, qty: Math.round(d.qty * 1000) / 1000, amount: R(d.amount) })),
    hours: hours.results, money: money.results.map((m) => ({ sys: m.sys || '', name: m.name, amount: R(m.amount) })),
  };
}

/* ======================================================================= the kitchen display link (/kd/<token>)
   For a TV or tablet in the kitchen: the kitchen screen with no login and no ERP seat. It shows today's KOTs (tables,
   dishes, notes; never prices or customers) and moves them on, nothing else. The owner makes it, makes a new one (the
   old one stops at once) or switches it off on the Table QR page. */
async function kitchenOrg(c, token) {
  if (!/^[0-9a-f]{24}$/.test(String(token || ''))) return null;
  const o = await c.db.prepare(`SELECT id, name, dine FROM orgs WHERE kd_token = ?`).bind(token).first();
  return o && dineSettingsOf(o).kt === token ? o : null;
}
export async function kitchenLink(c, on) {
  requireCan(c.user, 'settings');
  const st = dineSettingsOf(c.org);
  const s = { qr: st.qr, note: st.note, kt: on ? randomHex(12) : '' };
  await c.db.batch([c.db.prepare(`UPDATE orgs SET dine = ?, kd_token = ? WHERE id = ?`).bind(JSON.stringify(s), s.kt || null, c.org.id), auditStatement(c, 'kitchen display link', on ? 'new link' : 'off')]);
  c.org.dine = JSON.stringify(s);
  return dineQr(c);
}
export async function kitchenDisplay(c, token) {
  await rateLimit(c.env, 'kd:' + ipOf(c), 600, 600);
  const o = await kitchenOrg(c, token);
  if (!o) throw notFound('This kitchen link is not working. Ask the owner for the new one.');
  return { shop: o.name, ...(await kitchenOf(c, o.id)) };
}
export async function kitchenDisplaySet(c, token, id, body) {
  await rateLimit(c.env, 'kd-set:' + ipOf(c), 300, 600);
  const o = await kitchenOrg(c, token);
  if (!o) throw notFound('This kitchen link is not working. Ask the owner for the new one.');
  return { shop: o.name, ...(await setKot(c, o.id, id, body)) };
}

/* ======================================================================= the menu for today
   Each dish can carry a veg / non-veg / egg mark (the guest's menu shows it) and be "sold out" for the day: the kitchen
   marks it, the guest's menu shows it greyed and cannot order it, and it is back on the menu the next morning by itself. */
const FOOD = ['veg', 'nonveg', 'egg'];
async function menuOf(c, orgId) {
  const { results } = await c.db.prepare(`SELECT id, name, category, food, sold_out FROM items WHERE org_id = ? AND shop_hide = 0 AND sale_price > 0
      ORDER BY category, name LIMIT 1000`).bind(orgId).all();
  const day = today();
  return { menu: results.map((i) => ({ id: i.id, name: i.name, category: i.category || '', food: FOOD.includes(i.food) ? i.food : '', sold_out: i.sold_out === day })) };
}
async function setSoldOut(c, orgId, id, body) {
  const out = !!(body && body.sold_out);
  const r = await c.db.prepare(`UPDATE items SET sold_out = ? WHERE id = ? AND org_id = ?`).bind(out ? today() : '', id, orgId).run();
  if (!r.meta.changes) throw notFound('Dish not found.');
  return menuOf(c, orgId);
}
export async function dineMenu(c) { requireCan(c.user, 'kitchen'); return menuOf(c, c.org.id); }
export async function dineSoldOut(c, id, body) { requireCan(c.user, 'kitchen'); return setSoldOut(c, c.org.id, id, body); }
export async function dineFood(c, id, body) {
  requireCan(c.user, 'items');
  const f = body && FOOD.includes(body.food) ? body.food : '';
  const r = await c.db.prepare(`UPDATE items SET food = ? WHERE id = ? AND org_id = ?`).bind(f, id, c.org.id).run();
  if (!r.meta.changes) throw notFound('Dish not found.');
  return menuOf(c, c.org.id);
}
export async function kitchenMenu(c, token) {
  await rateLimit(c.env, 'kd:' + ipOf(c), 600, 600);
  const o = await kitchenOrg(c, token);
  if (!o) throw notFound('This kitchen link is not working. Ask the owner for the new one.');
  return menuOf(c, o.id);
}
export async function kitchenSoldOut(c, token, id, body) {
  await rateLimit(c.env, 'kd-set:' + ipOf(c), 300, 600);
  const o = await kitchenOrg(c, token);
  if (!o) throw notFound('This kitchen link is not working. Ask the owner for the new one.');
  return setSoldOut(c, o.id, id, body);
}
