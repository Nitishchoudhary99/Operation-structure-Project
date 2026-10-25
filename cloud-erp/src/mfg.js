/* Manufacturing, kept simple: a bill of materials (recipe) per finished item says what goes into it, and a production
   run turns those components into the finished item in one godown. Components go out at their average cost (FEFO
   batches, bins and serials as for any goods out), the finished item comes in at their total value, so the stock
   value of the business does not change and no journal is needed (inventory to inventory). Cancelling a run puts
   every component back and takes the finished goods out again, as long as they have not been used. */
import { bad, notFound, str, num, roundQty, nowIso, today, date, uid, loadByIds, counterStatements, counterValueSql } from './lib.js';
import { requireCan, seesCosts } from './auth.js';
import { stockStatements, warehouseOf, auditStatement, reverseStock } from './engine.js';
import { lotState, takeOut, putIn, cleanBatch, cleanSerials } from './lots.js';

const R = (p) => Math.round(p) / 100;

/* the recipe of one item, with how many can be made from the stock in a godown */
export async function getBom(c, itemId, warehouseId = 0) {
  const it = await c.db.prepare(`SELECT id, name, unit, is_service FROM items WHERE id = ? AND org_id = ?`).bind(itemId, c.org.id).first();
  if (!it) throw notFound('Item not found.');
  const bom = await c.db.prepare(`SELECT * FROM boms WHERE org_id = ? AND item_id = ?`).bind(c.org.id, itemId).first();
  if (!bom) return { item: it, out_qty: 1, notes: '', lines: [], can_make: null };
  const wh = warehouseId ? warehouseId : (await c.db.prepare(`SELECT id FROM warehouses WHERE org_id = ? ORDER BY id LIMIT 1`).bind(c.org.id).first() || {}).id || 0;
  const { results } = await c.db.prepare(`SELECT l.item_id, l.qty, i.name, i.unit, i.avg_cost, COALESCE(s.qty, 0) AS have FROM bom_lines l
      JOIN items i ON i.id = l.item_id LEFT JOIN stock s ON s.item_id = l.item_id AND s.warehouse_id = ? WHERE l.bom_id = ? ORDER BY l.id`).bind(wh, bom.id).all();
  const costs = seesCosts(c.user);
  let canMake = Infinity, cost = 0;
  const lines = results.map((l) => {
    canMake = Math.min(canMake, Math.floor((l.have / l.qty) * bom.out_qty + 1e-6));
    cost += l.qty * l.avg_cost;
    const o = { item_id: l.item_id, name: l.name, unit: l.unit, qty: l.qty, have: roundQty(l.have) };
    if (costs) o.cost = R(l.qty * l.avg_cost);
    return o;
  });
  const out = { item: it, out_qty: bom.out_qty, notes: bom.notes, lines, can_make: lines.length ? Math.max(0, canMake) : null, warehouse_id: wh };
  if (costs) out.unit_cost = R(cost / bom.out_qty);
  return out;
}

export async function saveBom(c, itemId, body) {
  requireCan(c.user, 'items');
  const it = await c.db.prepare(`SELECT id, name, is_service FROM items WHERE id = ? AND org_id = ?`).bind(itemId, c.org.id).first();
  if (!it) throw notFound('Item not found.');
  if (it.is_service) throw bad('A service cannot be manufactured.');
  const raw = (Array.isArray(body.lines) ? body.lines : []).filter((l) => l && +l.item_id && +l.qty);
  if (raw.length > 100) throw bad('At most 100 components in a recipe.');
  const outQty = roundQty(num(body.out_qty, 'Quantity made', { min: 0.001, max: 1e6, def: 1 }));
  const items = new Map((await loadByIds(c.db, `SELECT id, name, is_service FROM items WHERE org_id = ? AND id IN (?ids)`, [c.org.id], raw.map((l) => +l.item_id))).map((i) => [i.id, i]));
  const lines = new Map();
  for (const l of raw) {
    const comp = items.get(+l.item_id);
    if (!comp) throw bad('Unknown component.');
    if (comp.id === it.id) throw bad(`${it.name} cannot be a component of itself.`);
    if (comp.is_service) throw bad(`${comp.name} is a service; only stocked items can be components.`);
    lines.set(comp.id, roundQty((lines.get(comp.id) || 0) + num(l.qty, `${comp.name} quantity`, { min: 0.001, max: 1e9 })));
  }
  const st = [c.db.prepare(`DELETE FROM bom_lines WHERE bom_id IN (SELECT id FROM boms WHERE org_id = ? AND item_id = ?)`).bind(c.org.id, it.id)];
  if (!lines.size) st.push(c.db.prepare(`DELETE FROM boms WHERE org_id = ? AND item_id = ?`).bind(c.org.id, it.id));
  else {
    st.push(c.db.prepare(`INSERT INTO boms (org_id, item_id, out_qty, notes, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(org_id, item_id) DO UPDATE SET out_qty = excluded.out_qty, notes = excluded.notes, updated_at = excluded.updated_at`)
      .bind(c.org.id, it.id, outQty, str(body.notes, 300), nowIso()));
    for (const [id, q] of lines) {
      st.push(c.db.prepare(`INSERT INTO bom_lines (bom_id, item_id, qty) VALUES ((SELECT id FROM boms WHERE org_id = ? AND item_id = ?), ?, ?)`).bind(c.org.id, it.id, id, q));
    }
  }
  st.push(auditStatement(c, 'save recipe', `${it.name}: ${lines.size} component(s)`));
  await c.db.batch(st);
  return getBom(c, it.id);
}

export async function listProductions(c) {
  const { results } = await c.db.prepare(`SELECT p.id, p.number, p.date, p.qty, p.value, p.status, p.batch_no, p.notes, i.name AS item, i.unit, w.name AS warehouse
      FROM productions p JOIN items i ON i.id = p.item_id LEFT JOIN warehouses w ON w.id = p.warehouse_id WHERE p.org_id = ? ORDER BY p.id DESC LIMIT 300`).bind(c.org.id).all();
  const { results: recipes } = await c.db.prepare(`SELECT b.item_id, i.name, i.unit, i.track_batch, i.track_serial, b.out_qty FROM boms b JOIN items i ON i.id = b.item_id
      WHERE b.org_id = ? ORDER BY i.name`).bind(c.org.id).all();
  const costs = seesCosts(c.user);
  return { rows: results.map((r) => { const o = { ...r, value: R(r.value) }; if (!costs) delete o.value; return o; }), recipes };
}

/* make qty of the finished item: body { item_id, qty, warehouse_id, date, batch_no, expiry, serials, notes, lines? }.
   lines (optional) are the components actually used, for when a run used more or less than the recipe says. */
export async function createProduction(c, body) {
  requireCan(c.user, 'stock');
  const { db } = c, orgId = c.org.id;
  const it = await db.prepare(`SELECT * FROM items WHERE id = ? AND org_id = ?`).bind(+body.item_id || 0, orgId).first();
  if (!it || it.is_service) throw bad('Choose the item to make.');
  const qty = roundQty(num(body.qty, 'Quantity to make', { min: 0.001, max: 1e9 }));
  const wh = await warehouseOf(c, +body.warehouse_id || 0);
  const d = date(body.date || today());
  let use;
  if (Array.isArray(body.lines) && body.lines.length) {
    use = body.lines.filter((l) => l && +l.item_id && +l.qty).map((l) => ({ item_id: +l.item_id, qty: roundQty(num(l.qty, 'Component quantity', { min: 0.001, max: 1e9 })) }));
  } else {
    const bom = await db.prepare(`SELECT * FROM boms WHERE org_id = ? AND item_id = ?`).bind(orgId, it.id).first();
    if (!bom) throw bad(`Set up the recipe (bill of materials) of ${it.name} first.`);
    const { results } = await db.prepare(`SELECT item_id, qty FROM bom_lines WHERE bom_id = ?`).bind(bom.id).all();
    use = results.map((l) => ({ item_id: l.item_id, qty: roundQty(l.qty * qty / bom.out_qty) }));
  }
  const need = new Map();
  for (const l of use) if (l.qty > 0) need.set(l.item_id, roundQty((need.get(l.item_id) || 0) + l.qty));
  if (!need.size) throw bad('No components to use.');
  if (need.has(it.id)) throw bad(`${it.name} cannot be a component of itself.`);
  const comps = new Map((await loadByIds(db, `SELECT * FROM items WHERE org_id = ? AND id IN (?ids)`, [orgId], [...need.keys()])).map((i) => [i.id, i]));
  const have = new Map((await loadByIds(db, `SELECT item_id, qty FROM stock WHERE org_id = ? AND warehouse_id = ? AND item_id IN (?ids)`, [orgId, wh.id], [...need.keys()])).map((r) => [r.item_id, r.qty]));
  const short = [];
  for (const [id, q] of need) {
    const comp = comps.get(id);
    if (!comp || comp.is_service) throw bad('Unknown component.');
    const h = have.get(id) || 0;
    if (h + 0.0005 < q) short.push(`${comp.name}: ${roundQty(h)} ${comp.unit} in ${wh.name}, ${q} needed`);
  }
  if (short.length) throw bad(`Not enough stock to make ${qty} ${it.unit} of ${it.name}. ${short.join('; ')}.`);
  const serials = it.track_serial ? cleanSerials(body.serials) : [];
  if (serials.length && Math.abs(serials.length - qty) > 0.0005) throw bad(`${serials.length} serial number(s) typed for a quantity of ${qty}.`);
  const batch = cleanBatch(body);

  const txk = uid(), st = [], ref = { refType: 'MFG', refTxk: txk, refTable: 'productions' };
  const S = await lotState(db, orgId, wh.id, [it, ...comps.values()], { hasBins: wh.hasBins, incoming: serials });
  const used = [];
  let value = 0;
  for (const [id, q] of need) {
    const comp = comps.get(id), cost = Math.round(q * comp.avg_cost);
    const plan = takeOut(S, comp, q);
    for (const x of plan.serials) x.void = true;               // used up in the product
    used.push({ item_id: id, name: comp.name, unit: comp.unit, qty: q, value: cost });
    value += cost;
    st.push(...stockStatements(db, c, { item: id, warehouse: wh.id, qty: -q, value: cost, date: d, ...ref, note: `Used to make ${it.name}`, lots: plan }));
  }
  st.unshift(counterStatements(db, orgId, 'MFG'),
    db.prepare(`INSERT INTO productions (org_id, number, item_id, qty, warehouse_id, date, value, batch_no, lines, notes, created_by, created_at, txk)
      VALUES (?, ${counterValueSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(orgId, 'MFG-%05d', orgId, 'MFG', it.id, qty, wh.id, d, value, it.track_batch ? batch.no : '', JSON.stringify(used), str(body.notes, 300), c.user.id, nowIso(), txk));
  const plan = putIn(S, it, qty, it.track_batch ? batch : null, '', serials);
  st.push(...stockStatements(db, c, { item: it.id, warehouse: wh.id, qty, value, date: d, ...ref, note: `Made from ${used.length} component(s)`, lots: plan }));
  st.push(auditStatement(c, 'production', `${it.name} ${qty} ${it.unit}`));
  await db.batch(st);
  const row = await db.prepare(`SELECT id, number FROM productions WHERE txk = ?`).bind(txk).first();
  return { ok: true, id: row.id, number: row.number, qty, ...(seesCosts(c.user) ? { value: R(value), unit_cost: R(value / qty) } : {}), used: used.map((u) => ({ name: u.name, unit: u.unit, qty: u.qty })) };
}

export async function cancelProduction(c, id) {
  requireCan(c.user, 'stock');
  const p = await c.db.prepare(`SELECT * FROM productions WHERE id = ? AND org_id = ?`).bind(id, c.org.id).first();
  if (!p) throw notFound('Production not found.');
  if (p.status === 'cancelled') throw bad('Already cancelled.');
  const st = await reverseStock(c, { refType: 'MFG', refId: p.id, date: p.date, label: p.number });
  st.push(c.db.prepare(`UPDATE productions SET status = 'cancelled' WHERE id = ? AND status = 'done'`).bind(p.id));
  st.push(auditStatement(c, 'cancel production', p.number));
  await c.db.batch(st);
  return { ok: true };
}
