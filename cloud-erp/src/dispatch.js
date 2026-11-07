/* Orders & dispatch for a business that takes orders in one place and packs them in another (an Instagram / WhatsApp
   seller with a godown, a wholesaler with a dispatch room). The owner sets it up once in Settings → Orders & dispatch
   (orgs.workflow); the Dispatch Desk then walks every order through:
     confirm (a COD order confirmed with the customer on WhatsApp, when the owner wants that)
     → pack (Pack & check makes the Delivery Note: stock goes out then)
     → shipped (courier and tracking number, sent to the customer)
     → delivered, or returned by the courier (RTO: the Delivery Note is cancelled, so the stock comes back).
   docs.pay_mode: 'cod' | 'prepaid' | '' (not said). docs.ship: on a Sales Order 'confirmed'; on a Delivery Note
   '' (packed), 'shipped', 'delivered' or 'rto'. */
import { bad, notFound, forbidden, str, nowIso, today, oneOf } from './lib.js';
import { can, canView, rulesOf } from './auth.js';
import { auditStatement, cancelDoc } from './engine.js';

export const PAY_MODES = ['', 'cod', 'prepaid'];
export const COURIERS = ['India Post', 'Delhivery', 'DTDC', 'Blue Dart', 'Ekart', 'Xpressbees', 'Shadowfax', 'Shiprocket', 'Own delivery / hand'];
export const MSG_CONFIRM = 'Hi {name}, thank you for your order {order} from {shop}.\n{items}\nAmount: {amount} ({pay}).\nDelivery address: {address}\nPlease reply YES to confirm.';
export const MSG_SHIP = 'Hi {name}, your order {order} from {shop} is on its way via {courier}.\nTracking no.: {awb}\n{link}';

/* the owner's set-up; anything missing or wrong falls back to the default */
export function workflowOf(org) {
  let w = {};
  try { w = JSON.parse((org && org.workflow) || '{}') || {}; } catch (e) { w = {}; }
  return cleanWorkflow(w);
}
export function cleanWorkflow(b) {
  b = b && typeof b === 'object' ? b : {};
  const text = (v, def) => (v === undefined || v === null ? def : String(v).replace(/\r/g, '').slice(0, 600).trim() || def);
  // courier lines: "Name" or "Name | https://tracking.link/{awb}"
  const list = Array.isArray(b.couriers) ? b.couriers : COURIERS.map((name) => ({ name, url: '' }));
  const couriers = list.map((x) => (typeof x === 'string' ? { name: x, url: '' } : x)).filter((x) => x && str(x.name, 40))
    .map((x) => ({ name: str(x.name, 40), url: /^https:\/\/[^\s]+$/.test(str(x.url, 300)) ? str(x.url, 300) : '' })).slice(0, 20);
  return {
    dispatch: b.dispatch === true,                  // the Sales Order → Delivery Note flow and the Dispatch Desk, even in Simple mode
    confirm_cod: b.confirm_cod === true,            // a COD order waits for the customer's confirmation before packing
    default_pay: PAY_MODES.includes(b.default_pay) ? b.default_pay : '',
    /* how orders are picked: 'scan' = on the phone by scanning each piece (no printed pick list, no "picked by / checked by"
       sheet; the scan is the check, and a delivery note from an order is saved only from the scan screen); 'paper' = a
       printed pick list; 'both' = either (the default) */
    pick_mode: ['scan', 'paper', 'both'].includes(b.pick_mode) ? b.pick_mode : 'both',
    // a sales order asking for more than is free (in stock − on open orders): 'warn' (default), 'block', or 'off'
    stock_check: ['warn', 'block', 'off'].includes(b.stock_check) ? b.stock_check : 'warn',
    couriers,
    msg_confirm: text(b.msg_confirm, MSG_CONFIRM),
    msg_ship: text(b.msg_ship, MSG_SHIP),
  };
}

const R = (p) => Math.round(p) / 100;
/* what the browser may see of a courier booking (src/courier.js): no ids it does not need */
const shipRef = (t) => { let x = {}; try { x = JSON.parse(t || '{}') || {}; } catch (e) { x = {}; } return x.p ? { p: x.p, label_url: x.label_url || '', status: x.status || '', track_url: x.track_url || '', checked_at: x.checked_at || '',
  ndr: x.ndr ? { action: x.ndr.action || '', at: x.ndr.at || '' } : null, ret: x.ret ? { awb: x.ret.awb || '', courier: x.ret.courier || '', at: x.ret.at || '' } : null } : null; };
const mayDispatch = (u) => can(u, 'stock') || can(u, 'sales');
/* may hand parcels to a courier (book, track): selling right, or godown staff the owner did not stop from dispatching */
export const mayShip = (u) => (can(u, 'sales') || (can(u, 'stock') && !rulesOf(u).no_dispatch)) && canView(u, 'sales');
const ageDays = (d, t) => Math.max(0, Math.round((Date.parse(t + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / 86400e3));
const addressOf = (r) => [r.ship_address || r.address, [r.city, r.state, r.pincode].filter(Boolean).join(', ')].filter(Boolean).join(', ');

/* GET /api/dispatch: every order on its way out, by step */
export async function dispatchBoard(c) {
  if (!mayDispatch(c.user) || !canView(c.user, 'sales')) throw forbidden('Your role cannot see orders.');
  const w = workflowOf(c.org), t = today();
  const since = new Date(Date.parse(t + 'T00:00:00Z') - 30 * 86400e3).toISOString().slice(0, 10);
  const PARTY = `p.name AS party, p.phone, p.address, p.city, p.state, p.pincode`;
  const [orders, lines, notes] = await c.db.batch([
    c.db.prepare(`SELECT d.id, d.number, d.date, d.total, d.status, d.pay_mode, d.ship, d.paid, d.party_id, ${PARTY}
        FROM docs d LEFT JOIN parties p ON p.id = d.party_id
        WHERE d.org_id = ? AND d.type = 'SO' AND d.status IN ('open', 'partial') ORDER BY d.date, d.id LIMIT 500`).bind(c.org.id),
    c.db.prepare(`SELECT l.doc_id, i.name AS item, l.qty, l.done_qty, l.picked_qty, i.is_service FROM doc_lines l JOIN docs d ON d.id = l.doc_id LEFT JOIN items i ON i.id = l.item_id
        WHERE d.org_id = ? AND ((d.type = 'SO' AND d.status IN ('open', 'partial'))
          OR (d.type = 'DN' AND ((d.status != 'cancelled' AND d.ship IN ('', 'shipped')) OR (d.ship IN ('delivered', 'rto') AND d.ship_at >= ?))))`).bind(c.org.id, since),
    c.db.prepare(`SELECT d.id, d.number, d.date, d.total, d.status, d.pay_mode, d.ship, d.courier, d.awb, d.ship_at, d.ship_ref, d.ref_id, s.number AS order_no, ${PARTY},
        d.packed_at, (SELECT u.name FROM users u WHERE u.id = d.packed_by AND u.org_id = d.org_id) AS packed_by,
        (SELECT x.number FROM docs x WHERE x.ref_id = d.id AND x.org_id = d.org_id AND x.type = 'INV' AND x.status != 'cancelled' LIMIT 1) AS invoice
        FROM docs d LEFT JOIN parties p ON p.id = d.party_id LEFT JOIN docs s ON s.id = d.ref_id
        WHERE d.org_id = ? AND d.type = 'DN' AND ((d.status != 'cancelled' AND d.ship IN ('', 'shipped')) OR (d.ship IN ('delivered', 'rto') AND d.ship_at >= ?))
        ORDER BY d.date, d.id LIMIT 500`).bind(c.org.id, since),
  ]);
  const byDoc = new Map();
  for (const l of lines.results) { if (!byDoc.has(l.doc_id)) byDoc.set(l.doc_id, []); byDoc.get(l.doc_id).push(l); }
  const summary = (id, left) => (byDoc.get(id) || []).filter((l) => !l.is_service && (left ? l.qty - l.done_qty : l.qty) > 0.0005)
    .map((l) => ({ item: l.item || '', qty: Math.round((left ? l.qty - l.done_qty : l.qty) * 1000) / 1000 }));
  // pieces picked by scan (src/picking.js) of what is still to go out on an order
  const pickedOf = (id) => (byDoc.get(id) || []).filter((l) => !l.is_service).reduce((s, l) => s + Math.min(Math.max(0, l.qty - l.done_qty), Math.max(0, l.picked_qty || 0)), 0);
  const out = (r, left) => {
    const items = summary(r.id, left), pcs = items.reduce((s, x) => s + x.qty, 0);
    return { id: r.id, number: r.number, date: r.date, age: ageDays(r.date, t), total: R(r.total), paid: R(r.paid || 0), pay_mode: r.pay_mode || '',
      ship: r.ship || '', party: r.party || '', phone: r.phone || '', address: addressOf(r), city: r.city || '', items, pcs,
      ...(left ? { picked: Math.round(pickedOf(r.id) * 1000) / 1000 } : {}) };
  };
  const so = orders.results.map((r) => out(r, true));
  const fullyPicked = (r) => r.pcs > 0 && r.picked >= r.pcs - 0.0005;
  // waits for the customer: a COD (or not-said) order with nothing delivered yet that nobody confirmed
  const waits = (r) => w.confirm_cod && r.pay_mode !== 'prepaid' && r.ship !== 'confirmed' && r.status === 'open';
  const dn = notes.results.map((r) => ({ ...out(r, false), status: r.status, courier: r.courier || '', awb: r.awb || '', ship_at: r.ship_at || '',
    order_id: r.ref_id, order_no: r.order_no || '', invoice: r.invoice || '', sr: shipRef(r.ship_ref), packed_at: r.packed_at || '', packed_by: r.packed_by || '' }));
  const board = {
    confirm: so.filter((r, i) => waits(orders.results[i])),
    pack: so.filter((r, i) => !waits(orders.results[i]) && !fullyPicked(r)),
    picked: so.filter((r, i) => !waits(orders.results[i]) && fullyPicked(r)),
    packed: dn.filter((r) => r.status !== 'cancelled' && !r.ship),
    shipped: dn.filter((r) => r.status !== 'cancelled' && r.ship === 'shipped'),
    done: dn.filter((r) => r.ship === 'delivered' || r.ship === 'rto').reverse(),
  };
  // paid in advance (prepaid) and still not handed to a courier: orders not packed yet and packed parcels not shipped
  const paidWaiting = [...board.confirm, ...board.pack, ...board.picked, ...board.packed].filter((r) => r.pay_mode === 'prepaid').length;
  return { ...board, workflow: w, shop: c.org.name, counts: { ...Object.fromEntries(Object.entries(board).map(([k, v]) => [k, v.length])), paid_waiting: paidWaiting } };
}

/* PUT /api/dispatch/:id  { action: confirm | pay_mode | ship | delivered | rto, ... } */
export async function dispatchStep(c, id, b) {
  if (!mayDispatch(c.user) || !canView(c.user, 'sales')) throw forbidden('Your role cannot work on orders.');
  const d = await c.db.prepare(`SELECT * FROM docs WHERE id = ? AND org_id = ?`).bind(id, c.org.id).first();
  if (!d) throw notFound('Order not found.');
  const action = oneOf(String(b.action || ''), ['confirm', 'unconfirm', 'pay_mode', 'ship', 'delivered', 'rto'], 'Action');
  if (d.status === 'cancelled' && action !== 'pay_mode') throw bad(`${d.number} is cancelled.`);
  const save = async (sets, vals, what) => {
    await c.db.batch([c.db.prepare(`UPDATE docs SET ${sets} WHERE id = ? AND org_id = ?`).bind(...vals, d.id, c.org.id), auditStatement(c, 'dispatch', `${d.number}: ${what}`.slice(0, 300))]);
  };
  if (action === 'pay_mode') {
    if (!['SO', 'DN', 'INV'].includes(d.type)) throw bad('Only an order, delivery note or invoice is COD or prepaid.');
    const m = oneOf(String(b.pay_mode ?? ''), PAY_MODES, 'Payment');
    await save('pay_mode = ?', [m], m ? m.toUpperCase() : 'payment not said');
    // the order's delivery notes follow it (they print the label)
    if (d.type === 'SO') await c.db.prepare(`UPDATE docs SET pay_mode = ? WHERE ref_id = ? AND org_id = ? AND type = 'DN'`).bind(m, d.id, c.org.id).run();
    return { ok: true, pay_mode: m };
  }
  if (action === 'confirm' || action === 'unconfirm') {
    if (d.type !== 'SO') throw bad('Only a Sales Order is confirmed.');
    await save('ship = ?', [action === 'confirm' ? 'confirmed' : ''], action === 'confirm' ? 'confirmed by the customer' : 'confirmation taken back');
    return { ok: true, ship: action === 'confirm' ? 'confirmed' : '' };
  }
  if (d.type !== 'DN') throw bad('Shipping steps are on a Delivery Note. Pack the order first.');
  // the owner switched dispatch off for this role (Settings → Roles / Orders & dispatch): no shipping or returns either
  if (!can(c.user, 'sales') && rulesOf(c.user).no_dispatch) throw forbidden('Your role cannot dispatch orders.');
  if (action === 'ship') {
    const courier = str(b.courier, 40), awb = str(b.awb, 40).replace(/\s+/g, '');
    if (!courier) throw bad('Choose the courier.');
    if (!awb && !/own|hand/i.test(courier)) throw bad('Type the tracking (AWB) number.');
    if (d.ship === 'delivered' || d.ship === 'rto') throw bad(`${d.number} is already ${d.ship === 'rto' ? 'returned' : 'delivered'}.`);
    await save(`ship = 'shipped', courier = ?, awb = ?, ship_at = ?`, [courier, awb, nowIso()], `shipped by ${courier} ${awb}`);
    return { ok: true, ship: 'shipped', courier, awb };
  }
  if (action === 'delivered') {
    if (d.ship !== 'shipped') throw bad('Mark it shipped first.');
    await save(`ship = 'delivered', ship_at = ?`, [nowIso()], 'delivered');
    return { ok: true, ship: 'delivered' };
  }
  // RTO: the parcel came back. The delivery note is cancelled (stock back in the godown); the order is closed too unless
  // asked to keep it open (to send again).
  if (d.ship === 'rto') throw bad('Already marked returned.');
  const inv = await c.db.prepare(`SELECT number FROM docs WHERE ref_id = ? AND org_id = ? AND type = 'INV' AND status != 'cancelled' LIMIT 1`).bind(d.id, c.org.id).first();
  if (inv) throw bad(`${d.number} is already invoiced (${inv.number}). Open that invoice and use Return goods, so the bill is reversed too.`);
  await cancelDoc(c, d.id, { dispatch: true });
  await save(`ship = 'rto', ship_at = ?`, [nowIso()], `returned by courier (RTO)${b.note ? ': ' + str(b.note, 120) : ''}`);
  let closed = false;
  if (d.ref_id && b.keep_order !== true) {
    const live = await c.db.prepare(`SELECT COUNT(*) AS n FROM docs WHERE ref_id = ? AND org_id = ? AND status != 'cancelled'`).bind(d.ref_id, c.org.id).first();
    const so = await c.db.prepare(`SELECT status FROM docs WHERE id = ? AND org_id = ? AND type = 'SO'`).bind(d.ref_id, c.org.id).first();
    if (so && so.status !== 'cancelled' && !live.n) { await cancelDoc(c, d.ref_id, { dispatch: true }); closed = true; }
  }
  return { ok: true, ship: 'rto', order_closed: closed };
}
