/* Loyalty points (opt-in, Settings → Loyalty points).
   A named customer earns points on every invoice and can pay part of a later invoice with them. The walk-in customer
   never earns (it is everyone). Points live in their own ledger, loyalty_points, one row per change:
     earn      +  on an invoice, on what was paid other than with points
     redeem    -  points used on an invoice
     unredeem  +  that use given back (its receipt voided)
     return    -  part of the points of an invoice taken back by a sales return
     cancel    ±  everything a cancelled document did, undone
     adjust    ±  the owner's own change (opening balance from another system, a gift)
   The rupee value of points used is booked like a receipt into "Loyalty Points Redeemed" (an expense), so the invoice
   shows as paid, the customer's ledger is right and the books balance. GST is on the full bill: points are a way to pay. */
import { bad, str, num, nowIso, today } from './lib.js';

export const LOYALTY_ACCOUNTS = [['loyalty', ['6095', '6096', '6097'], 'Loyalty Points Redeemed', 'expense']];
export const WALK_IN = 'Walk-in Customer';

/* the business's rules, with safe defaults: 1 point per ₹100, 1 point = ₹1, at most half a bill paid with points */
export function loyaltyOf(org) {
  let s = {};
  try { s = JSON.parse((org && org.loyalty) || '{}') || {}; } catch (e) { s = {}; }
  const n = (v, def, min, max) => (Number.isFinite(+v) && +v >= min && +v <= max ? +v : def);
  return { on: s.on === true, earn_per: n(s.earn_per, 100, 1, 1e6), point_value: n(s.point_value, 1, 0.01, 1e4), max_pct: n(s.max_pct, 50, 1, 100),
    min_points: Math.round(n(s.min_points, 0, 0, 1e7)) };
}
export function cleanLoyalty(body) {
  const s = {
    on: body.on === true,
    earn_per: num(body.earn_per, 'Rupees spent for 1 point', { min: 1, max: 1e6, def: 100 }),
    point_value: Math.round(num(body.point_value, 'Value of 1 point', { min: 0.01, max: 1e4, def: 1 }) * 100) / 100,
    max_pct: Math.round(num(body.max_pct, 'Most of a bill paid with points', { min: 1, max: 100, def: 50 })),
    min_points: Math.round(num(body.min_points, 'Fewest points to use', { min: 0, max: 1e7, def: 0 })),
  };
  return s;
}
export const earns = (party) => !!party && party.kind !== 'supplier' && party.name !== WALK_IN;
const pointsFor = (s, paise) => Math.floor(paise / Math.round(s.earn_per * 100));

export async function balanceOf(db, orgId, partyId) {
  const r = await db.prepare(`SELECT COALESCE(SUM(points), 0) AS b FROM loyalty_points WHERE org_id = ? AND party_id = ?`).bind(orgId, partyId).first();
  return r ? r.b : 0;
}

/* An invoice's points: how many it uses (and what they are worth, in paise) and how many it earns. null when loyalty is off. */
export async function invoicePoints(ctx, party, total, body) {
  const s = loyaltyOf(ctx.org);
  const want = Math.round(+body.redeem_points || 0);
  if (body.points === false && !(want > 0)) return null;      // marketplace orders: the buyer is the marketplace's, not the shop's
  if (!s.on) { if (want > 0) throw bad('Loyalty points are off. Turn them on in Settings → Loyalty points.'); return null; }
  if (!earns(party)) { if (want > 0) throw bad('Choose the customer by name to use their points; the walk-in customer has none.'); return null; }
  let use = 0, value = 0;
  if (want > 0) {
    const have = await balanceOf(ctx.db, ctx.org.id, party.id);
    if (want > have) throw bad(`${party.name} has ${have} point${have === 1 ? '' : 's'}; ${want} cannot be used.`);
    if (have < s.min_points) throw bad(`Points can be used from ${s.min_points} points up; ${party.name} has ${have}.`);
    const most = Math.floor(total * s.max_pct / 100);
    const pv = Math.round(s.point_value * 100);
    use = Math.min(want, Math.floor(most / pv));
    if (use < want) throw bad(`At most ${use} points (₹${(use * pv / 100).toFixed(2)}, ${s.max_pct}% of this bill) can be used on this bill.`);
    value = use * pv;
  }
  return { use, value, earn: pointsFor(s, total - value) };
}

/* rows for a new invoice; the use is checked again inside the batch (two counters billing the same customer at once):
   a NULL there fails the whole batch, see createDoc */
export function invoicePointStatements(ctx, party, txk, d, pts) {
  const { db } = ctx, o = ctx.org.id, at = nowIso();
  const st = [];
  if (pts.use > 0) {
    st.push(db.prepare(`INSERT INTO loyalty_points (org_id, party_id, doc_id, date, points, kind, note, created_by, created_at)
        VALUES (?1, ?2, (SELECT id FROM docs WHERE txk = ?3), ?4,
          CASE WHEN (SELECT COALESCE(SUM(points), 0) FROM loyalty_points WHERE org_id = ?1 AND party_id = ?2) >= ?5 THEN -?5 ELSE NULL END, 'redeem', '', ?6, ?7)`)
      .bind(o, party.id, txk, d, pts.use, ctx.user.id, at));
  }
  if (pts.earn > 0) {
    st.push(db.prepare(`INSERT INTO loyalty_points (org_id, party_id, doc_id, date, points, kind, note, created_by, created_at)
        VALUES (?, ?, (SELECT id FROM docs WHERE txk = ?), ?, ?, 'earn', '', ?, ?)`).bind(o, party.id, txk, d, pts.earn, ctx.user.id, at));
  }
  return st;
}
export const POINTS_RACE = /NOT NULL constraint failed: loyalty_points\.points/;

/* a sales return takes back its share of the points the invoice earned */
export function returnPointStatement(ctx, src, txk, d, total) {
  if (!src || src.type !== 'INV' || !(src.total > 0)) return null;
  return ctx.db.prepare(`INSERT INTO loyalty_points (org_id, party_id, doc_id, date, points, kind, note, created_by, created_at)
      SELECT org_id, party_id, (SELECT id FROM docs WHERE txk = ?), ?, -ROUND(SUM(points) * ? / ?), 'return', ?, ?, ? FROM loyalty_points
      WHERE org_id = ? AND doc_id = ? AND kind = 'earn' GROUP BY party_id HAVING ROUND(SUM(points) * ? / ?) > 0`)
    .bind(txk, d, Math.min(total, src.total), src.total, 'on ' + src.number, ctx.user.id, nowIso(), ctx.org.id, src.id, Math.min(total, src.total), src.total);
}

/* a cancelled document: whatever it did to points, undone (run after any unredeem in the same batch) */
export function cancelPointStatement(ctx, doc) {
  return ctx.db.prepare(`INSERT INTO loyalty_points (org_id, party_id, doc_id, date, points, kind, note, created_by, created_at)
      SELECT org_id, party_id, doc_id, ?, -SUM(points), 'cancel', ?, ?, ? FROM loyalty_points WHERE org_id = ? AND doc_id = ?
      GROUP BY party_id HAVING SUM(points) != 0`).bind(today(), doc.number, ctx.user.id, nowIso(), ctx.org.id, doc.id);
}

/* the points receipt of an invoice voided: the points used come back */
export function unredeemStatements(ctx, allocs) {
  return allocs.map((a) => ctx.db.prepare(`INSERT INTO loyalty_points (org_id, party_id, doc_id, date, points, kind, note, created_by, created_at)
      SELECT org_id, party_id, doc_id, ?, -SUM(points), 'unredeem', '', ?, ? FROM loyalty_points WHERE org_id = ? AND doc_id = ? AND kind IN ('redeem', 'unredeem')
      GROUP BY party_id HAVING SUM(points) != 0`).bind(today(), ctx.user.id, nowIso(), ctx.org.id, a.doc_id));
}

/* ---------- screens ---------- */
const KIND_TEXT = { earn: 'Earned', redeem: 'Used', unredeem: 'Use undone', return: 'Returned goods', cancel: 'Cancelled', adjust: 'Changed by owner' };

export async function partyPoints(c, partyId) {
  const s = loyaltyOf(c.org);
  const p = await c.db.prepare(`SELECT id, name, kind FROM parties WHERE id = ? AND org_id = ?`).bind(partyId, c.org.id).first();
  if (!p) throw bad('Customer not found.');
  const [b, rows] = await Promise.all([balanceOf(c.db, c.org.id, p.id),
    c.db.prepare(`SELECT l.id, l.date, l.points, l.kind, l.note, d.id AS doc_id, d.number FROM loyalty_points l LEFT JOIN docs d ON d.id = l.doc_id
        WHERE l.org_id = ? AND l.party_id = ? ORDER BY l.id DESC LIMIT 50`).bind(c.org.id, p.id).all()]);
  const pv = Math.round(s.point_value * 100);
  return { on: s.on, earns: earns(p), party: { id: p.id, name: p.name }, balance: b, value: Math.max(0, b) * pv / 100,
    can_use: s.on && earns(p) && b > 0 && b >= s.min_points, settings: s,
    rows: rows.results.map((r) => ({ ...r, what: KIND_TEXT[r.kind] || r.kind })) };
}

export async function members(c) {
  const s = loyaltyOf(c.org);
  const { results } = await c.db.prepare(`SELECT p.id, p.name, p.phone, SUM(l.points) AS balance,
        SUM(CASE WHEN l.kind = 'earn' THEN l.points ELSE 0 END) AS earned, -SUM(CASE WHEN l.kind IN ('redeem', 'unredeem') THEN l.points ELSE 0 END) AS used,
        MAX(l.date) AS last FROM loyalty_points l JOIN parties p ON p.id = l.party_id
      WHERE l.org_id = ? GROUP BY l.party_id ORDER BY balance DESC, p.name LIMIT 2000`).bind(c.org.id).all();
  const pv = Math.round(s.point_value * 100);
  const out = results.reduce((t, r) => t + Math.max(0, r.balance), 0);
  return { settings: s, members: results, points_out: out, value_out: out * pv / 100,
    earned: results.reduce((t, r) => t + r.earned, 0), used: results.reduce((t, r) => t + r.used, 0) };
}

export async function adjustPoints(c, body) {
  const p = await c.db.prepare(`SELECT id, name, kind FROM parties WHERE id = ? AND org_id = ?`).bind(+body.party_id || 0, c.org.id).first();
  if (!p || !earns(p)) throw bad('Choose a customer by name.');
  const pts = Math.round(num(body.points, 'Points', { min: -1e7, max: 1e7 }));
  if (!pts) throw bad('Type the points to add (or, with a minus, to take off).');
  const note = str(body.note, 120);
  return { party: p, statement: c.db.prepare(`INSERT INTO loyalty_points (org_id, party_id, doc_id, date, points, kind, note, created_by, created_at)
      VALUES (?, ?, NULL, ?, ?, 'adjust', ?, ?, ?)`).bind(c.org.id, p.id, today(), pts, note, c.user.id, nowIso()), points: pts };
}
