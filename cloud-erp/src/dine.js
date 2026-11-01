/* Restaurant tables and KOT (kitchen order tickets).
   A table's order stays open while people eat. Each "Send KOT" puts the new items on the order under one numbered
   ticket for the kitchen (no prices); an item taken off after the kitchen has it prints a CANCEL ticket. "Bill" makes
   one ordinary invoice of everything still on the order (createDoc: stock, GST, books, loyalty points as for any sale)
   and frees the table. KOT numbers start again at 1 each day. */
import { bad, notFound, str, num, nowIso, today, roundQty, uid } from './lib.js';
import { requireCan, requireCancel } from './auth.js';
import { createDoc, auditStatement } from './engine.js';

const R = (p) => Math.round(p) / 100;
/* what the guest pays for a line, with GST (a menu price may already have it) */
const PAY_SQL = `l.qty * CASE WHEN l.incl = 1 THEN l.rate ELSE l.rate * (100 + l.gst_rate) / 100.0 END`;
const payOf = (l) => l.qty * (l.incl ? l.rate : l.rate * (100 + (l.gst_rate || 0)) / 100);

export async function dineBoard(c) {
  const o = c.org.id;
  const [tables, orders] = await c.db.batch([
    c.db.prepare(`SELECT id, name, area, seats FROM dine_tables WHERE org_id = ? AND active = 1 ORDER BY area, sort, id`).bind(o),
    c.db.prepare(`SELECT d.id, d.table_id, d.opened_at, d.guests, COUNT(l.id) AS items, COALESCE(SUM(${PAY_SQL}), 0) AS amount, MAX(l.created_at) AS last_kot
        FROM dine_orders d LEFT JOIN dine_lines l ON l.order_id = d.id AND l.status = 'ok'
        WHERE d.org_id = ? AND d.status = 'open' GROUP BY d.id`).bind(o),
  ]);
  const open = new Map(orders.results.map((x) => [x.table_id, x]));
  return { tables: tables.results.map((t) => { const x = open.get(t.id); return { ...t, order: x ? { ...x, amount: R(x.amount) } : null }; }) };
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
  await c.db.prepare(`UPDATE dine_tables SET active = 0 WHERE id = ? AND org_id = ?`).bind(id, c.org.id).run();
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
  const k = await c.db.prepare(`SELECT number, created_at FROM kots WHERE txk = ?`).bind(key).first();
  return { kot: { number: k.number, at: k.created_at, kind: 'kot', table: t.name, user: c.user.name || '', lines: lines.map((l) => ({ name: l.it.name, qty: l.qty, note: l.note })) },
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
