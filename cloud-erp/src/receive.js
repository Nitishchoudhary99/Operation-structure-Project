/* Receiving goods at the godown: what is expected, codes learnt while scanning, and bins chosen for what came.
   - Expected: purchase bills booked before the goods came ("in transit", docs.transit = 1), open purchase orders, and
     gate entries not received yet. The Receive screen makes a GRN from one of them (src/engine.js createDoc).
   - Codes: a scanned code the business has never seen is attached to the item it belongs to, once, and works from then
     on (here, in POS, everywhere). A carton code carries how many pieces it holds (item_codes.pack_qty).
   - Bins: each item goes to its default bin, else a bin already holding it, else the first empty bin no item calls home,
     else (when asked) a new bin next to the last one made. An item without a default bin gets the bin it was given.
   - Write-offs: goods of a bill-first bill damaged or lost on the way (write_offs). Our loss (Transit Loss & Damage) or a
     claim on the transporter / insurer (Transit & Insurance Claims). GST input cannot be kept on goods lost or destroyed
     (CGST Act s.17(5)(h)), so it is reversed: Dr loss or claim (value + GST) / Cr Goods in Transit, Cr GST Input. */
import { bad, notFound, forbidden, str, nowIso, roundQty, loadByIds, date, today, oneOf, uid, counterStatements, counterValueSql } from './lib.js';
import { can, requireCan, requireCancel, checkBackdate } from './auth.js';
import { auditStatement, journalStatements, creditedOf, partOf, TRANSIT_SQL } from './engine.js';

const R = (p) => Math.round(p) / 100;

export async function receivePending(c) {
  requireCan(c.user, 'purchase');
  const open = `JOIN items i ON i.id = l.item_id WHERE l.doc_id = d.id AND i.is_service = 0`;
  const [bills, pos, gates] = await c.db.batch([
    c.db.prepare(`SELECT d.id, d.number, d.date, d.party_ref, d.total, d.warehouse_id, d.party_id, p.name AS party,
        (SELECT COUNT(*) FROM doc_lines l ${open} AND l.recv_qty + l.short_qty < l.qty - 0.0005) AS lines,
        (SELECT COALESCE(SUM(l.qty - l.recv_qty - l.short_qty), 0) FROM doc_lines l ${open}) AS qty
      FROM docs d JOIN parties p ON p.id = d.party_id WHERE d.org_id = ? AND d.type = 'BILL' AND d.transit = 1 AND d.status != 'cancelled'
      ORDER BY d.date, d.id LIMIT 200`).bind(c.org.id),
    c.db.prepare(`SELECT d.id, d.number, d.date, d.total, d.warehouse_id, d.party_id, p.name AS party,
        (SELECT COUNT(*) FROM doc_lines l ${open} AND l.done_qty < l.qty - 0.0005) AS lines,
        (SELECT COALESCE(SUM(l.qty - l.done_qty), 0) FROM doc_lines l ${open}) AS qty
      FROM docs d JOIN parties p ON p.id = d.party_id WHERE d.org_id = ? AND d.type = 'PO' AND d.status IN ('open', 'partial')
      ORDER BY d.date, d.id LIMIT 200`).bind(c.org.id),
    c.db.prepare(`SELECT g.id, g.number, g.date, g.time_in, g.vehicle_no, g.challan_no, g.packages, g.value, g.party_id, g.ref_doc_id, g.bill_id,
        p.name AS party, r.number AS ref_number, b.number AS bill_number
      FROM gate_entries g LEFT JOIN parties p ON p.id = g.party_id LEFT JOIN docs r ON r.id = g.ref_doc_id LEFT JOIN docs b ON b.id = g.bill_id AND b.org_id = g.org_id
      WHERE g.org_id = ? AND g.kind = 'in' AND g.status = 'open' ORDER BY g.date DESC, g.id DESC LIMIT 100`).bind(c.org.id),
  ]);
  const out = (r) => ({ ...r, total: R(r.total), qty: roundQty(r.qty) });
  return { bills: bills.results.filter((r) => r.lines).map(out), orders: pos.results.filter((r) => r.lines).map(out),
    gates: gates.results.map((g) => ({ ...g, value: R(g.value) })) };
}

/* The transit bill a gate entry is for: same supplier and the supplier's bill number, else the one bill of that value */
export async function matchBill(db, orgId, partyId, ref, value) {
  if (!partyId) return null;
  if (ref) {
    const b = await db.prepare(`SELECT id FROM docs WHERE org_id = ? AND type = 'BILL' AND transit = 1 AND status != 'cancelled' AND party_id = ?
        AND UPPER(REPLACE(party_ref, ' ', '')) = UPPER(REPLACE(?, ' ', '')) LIMIT 1`).bind(orgId, partyId, ref).first();
    if (b) return b.id;
  }
  if (value > 0) {
    const { results } = await db.prepare(`SELECT id FROM docs WHERE org_id = ? AND type = 'BILL' AND transit = 1 AND status != 'cancelled' AND party_id = ?
        AND ABS(total - ?) <= 100 LIMIT 2`).bind(orgId, partyId, value).all();
    if (results.length === 1) return results[0].id;
  }
  return null;
}

/* POST /api/items/:id/codes { code, pack_qty }: a code scanned while receiving belongs to this item */
export async function learnCode(c, itemId, body) {
  if (!can(c.user, 'items') && !can(c.user, 'purchase')) throw forbidden();
  const code = str(body.code, 48).replace(/\s+/g, '');
  if (!code) throw bad('Scan or type the code.');
  const pack = roundQty(+body.pack_qty || 1);
  if (!(pack >= 1 && pack <= 100000)) throw bad('Pieces in one pack: 1 to 100000.');
  const item = await c.db.prepare(`SELECT id, name, barcode, is_service FROM items WHERE id = ? AND org_id = ?`).bind(itemId, c.org.id).first();
  if (!item) throw notFound('Item not found.');
  if (item.is_service) throw bad('A service has no barcode.');
  const [mine, other] = await c.db.batch([
    c.db.prepare(`SELECT name FROM items WHERE org_id = ? AND id != ? AND (barcode = ? OR (sku != '' AND sku = ?)) LIMIT 1`).bind(c.org.id, item.id, code, code),
    c.db.prepare(`SELECT i.name FROM item_codes x JOIN items i ON i.id = x.item_id WHERE x.org_id = ? AND x.code = ? AND x.item_id != ?`).bind(c.org.id, code, item.id),
  ]);
  const hit = mine.results[0] || other.results[0];
  if (hit) throw bad(`Code ${code} already belongs to ${hit.name}.`);
  if (item.barcode === code && pack !== 1) throw bad(`${code} is the barcode of one ${item.name}. Scan the carton's own code.`);
  const st = [];
  if (pack === 1 && !item.barcode) st.push(c.db.prepare(`UPDATE items SET barcode = ? WHERE id = ?`).bind(code, item.id));
  else if (item.barcode !== code) {
    st.push(c.db.prepare(`INSERT INTO item_codes (org_id, code, item_id, pack_qty, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(org_id, code) DO UPDATE SET pack_qty = excluded.pack_qty`).bind(c.org.id, code, item.id, pack, nowIso()));
  }
  st.push(auditStatement(c, 'learn code', `${item.name}: ${code}${pack > 1 ? ' x' + pack : ''}`));
  await c.db.batch(st);
  return { ok: true, item_id: item.id, code, pack_qty: pack };
}

/* next free bin code after the last one made: A-01-3 -> A-01-4; none yet -> A-01 */
export function nextBinCode(codes, taken = new Set(codes)) {
  const last = codes[codes.length - 1] || '';
  const m = last.match(/^(.*?)(\d+)$/);
  const prefix = m ? m[1] : last ? last + '-' : 'A-', width = m ? m[2].length : 2;
  let n = m ? +m[2] : 0, code;
  do { n++; code = prefix + String(n).padStart(width, '0'); } while (taken.has(code));
  return code;
}

/* POST /api/bins/auto { warehouse_id, item_ids, create, skip }: a bin for each item; create makes missing bins and default bins */
export async function autoBins(c, body) {
  const create = !!body.create;
  if (!can(c.user, 'stock') && !can(c.user, 'purchase')) throw forbidden();      // bins are made while receiving, too
  const wh = await c.db.prepare(`SELECT id, name FROM warehouses WHERE id = ? AND org_id = ?`).bind(+body.warehouse_id || 0, c.org.id).first();
  if (!wh) throw notFound('Godown not found.');
  const ids = [...new Set((Array.isArray(body.item_ids) ? body.item_ids : []).map((x) => +x).filter((x) => x > 0))].slice(0, 200);
  if (!ids.length) return { warehouse: wh, rows: [], created: [] };
  const [items, held] = await Promise.all([
    loadByIds(c.db, `SELECT id, name, location, is_service FROM items WHERE org_id = ? AND id IN (?ids)`, [c.org.id], ids),
    loadByIds(c.db, `SELECT item_id, bin_id, qty FROM bin_stock WHERE org_id = ? AND warehouse_id = ? AND qty > 0.0005 AND item_id IN (?ids)`, [c.org.id, wh.id], ids),
  ]);
  const [binsQ, keptQ] = await c.db.batch([
    c.db.prepare(`SELECT b.id, b.code, EXISTS (SELECT 1 FROM bin_stock s WHERE s.bin_id = b.id AND s.qty > 0.0005) AS used FROM bins b
        WHERE b.org_id = ? AND b.warehouse_id = ? ORDER BY b.id`).bind(c.org.id, wh.id),
    c.db.prepare(`SELECT DISTINCT location FROM items WHERE org_id = ? AND location != ''`).bind(c.org.id),
  ]);
  const bins = binsQ.results, byCode = new Map(bins.map((b) => [b.code, b])), byId = new Map(bins.map((b) => [b.id, b]));
  const reserved = new Set(keptQ.results.map((r) => r.location));
  // skip: bins already given to other items of the same receipt
  const skip = new Set((Array.isArray(body.skip) ? body.skip : []).map((x) => str(x, 30).toUpperCase()));
  const empty = bins.filter((b) => !b.used && !reserved.has(b.code) && !skip.has(b.code)).sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  const codes = bins.map((b) => b.code), taken = new Set(codes), created = [], homes = [];
  let next = 0;
  const rows = ids.map((id) => items.find((i) => i.id === id)).filter((i) => i && !i.is_service).map((it) => {
    let code = it.location && byCode.has(it.location) ? it.location : '', why = code ? 'default bin' : '';
    if (!code) {
      const h = held.filter((x) => x.item_id === it.id).sort((a, b) => b.qty - a.qty)[0];
      if (h && byId.has(h.bin_id)) { code = byId.get(h.bin_id).code; why = 'already holds this item'; }
    }
    if (!code && next < empty.length) { code = empty[next++].code; why = 'empty bin'; }
    if (!code && create) {
      code = nextBinCode(codes, taken);
      codes.push(code); taken.add(code); created.push(code); why = 'new bin';
    }
    if (code && create && !it.location) homes.push([it.id, code]);
    return { item_id: it.id, name: it.name, bin: code, why };
  });
  if (create && (created.length || homes.length)) {
    const st = created.map((code) => c.db.prepare(`INSERT OR IGNORE INTO bins (org_id, warehouse_id, code, zone, capacity, created_at) VALUES (?, ?, ?, '', 0, ?)`)
      .bind(c.org.id, wh.id, code, nowIso()));
    for (const [id, code] of homes) st.push(c.db.prepare(`UPDATE items SET location = ? WHERE id = ? AND org_id = ? AND location = ''`).bind(code, id, c.org.id));
    if (created.length) st.push(auditStatement(c, 'auto bins', `${wh.name}: ${created.join(', ')}`.slice(0, 300)));
    await c.db.batch(st);
  }
  return { warehouse: wh, rows, created };
}

/* ---------- goods damaged or lost on the way ---------- */
const D = (account, amount) => ({ account, amount }), C = (account, amount) => ({ account, amount: -amount });
export const writeOffOut = (w) => ({ ...w, value: R(w.value), cgst: R(w.cgst), sgst: R(w.sgst), igst: R(w.igst), gst: R(w.cgst + w.sgst + w.igst),
  total: R(w.value + w.cgst + w.sgst + w.igst) });

/* POST /api/docs/:id/write-off { date, mode: 'loss' | 'claim', reason, lines: [{ line_id, qty }] }: pieces of a bill whose
   goods are on the way that will never be stock. The supplier is still owed the bill; the value leaves Goods in Transit
   at the bill's price (the last part of a line takes what is left of it), and the GST paid on them is reversed. */
export async function writeOff(c, billId, body) {
  requireCan(c.user, 'purchase');
  const { db } = c, orgId = c.org.id;
  const mode = oneOf(body.mode || 'loss', ['loss', 'claim'], 'Who bears it');
  const bill = await db.prepare(`SELECT * FROM docs WHERE id = ? AND org_id = ? AND type = 'BILL'`).bind(billId, orgId).first();
  if (!bill) throw notFound('Bill not found.');
  if (bill.status === 'cancelled' || bill.transit !== 1) throw bad(`${bill.number} has no goods on the way to write off.`);
  const d = date(body.date);
  checkBackdate(c.user, d, today(), 'a write-off');
  if (d < bill.date) throw bad(`A write-off cannot be dated before the bill (${bill.date}).`);
  const want = (Array.isArray(body.lines) ? body.lines : []).filter((l) => l && +l.qty > 0);
  if (!want.length) throw bad('Type how many pieces were damaged or lost.');
  if (want.length > 200) throw bad('At most 200 lines.');
  const [{ results: lines }, credited] = await Promise.all([
    db.prepare(`SELECT l.*, i.name, i.is_service FROM doc_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.doc_id = ?`).bind(bill.id).all(),
    creditedOf(db, orgId, bill.id)]);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const out = want.map((w, k) => {
    const l = byId.get(+w.line_id);
    if (!l || !l.item_id || l.is_service) throw bad(`Line ${k + 1}: not a goods line of ${bill.number}.`);
    const qty = roundQty(+w.qty), left = roundQty(l.qty - l.recv_qty - l.short_qty);
    if (qty > left + 0.0005) throw bad(`${l.name}: only ${left} still to come on ${bill.number}.`);
    const value = partOf(l, l.taxable, qty, l.recv_qty + l.short_qty, credited.get(l.id) || 0);
    credited.set(l.id, (credited.get(l.id) || 0) + value);
    l.short_qty = roundQty(l.short_qty + qty);
    const part = (x) => Math.round(x * qty / l.qty);
    return { l, qty, value, cgst: part(l.cgst), sgst: part(l.sgst), igst: part(l.igst) };
  });
  const sum = (k) => out.reduce((s, x) => s + x[k], 0);
  const value = sum('value'), cgst = sum('cgst'), sgst = sum('sgst'), igst = sum('igst'), tax = cgst + sgst + igst;
  const sys = c.sys, txk = uid(), reason = str(body.reason, 200);
  if (!sys.git || !sys.gst_input || !sys[mode === 'claim' ? 'claims' : 'transit_loss']) throw bad('An account for write-offs is missing in the chart of accounts.');
  const st = [counterStatements(db, orgId, 'WO'),
    db.prepare(`INSERT INTO write_offs (org_id, number, bill_id, date, mode, reason, value, cgst, sgst, igst, created_by, created_at, txk)
      VALUES (?, ${counterValueSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(orgId, 'WO-%05d', orgId, 'WO', bill.id, d, mode, reason, value, cgst, sgst, igst, c.user.id, nowIso(), txk)];
  for (const x of out) {
    st.push(db.prepare(`INSERT INTO write_off_lines (write_off_id, line_id, item_id, qty, value, cgst, sgst, igst) VALUES ((SELECT id FROM write_offs WHERE txk = ?), ?, ?, ?, ?, ?, ?, ?)`)
      .bind(txk, x.l.id, x.l.item_id, x.qty, x.value, x.cgst, x.sgst, x.igst));
    st.push(db.prepare(`UPDATE doc_lines SET short_qty = ROUND(short_qty + ?, 3) WHERE id = ?`).bind(x.qty, x.l.id));
  }
  st.push(db.prepare(TRANSIT_SQL).bind(bill.id));
  st.push(...journalStatements(db, c, { date: d, narration: `${mode === 'claim' ? 'Transit claim' : 'Transit loss'} on ${bill.number}${reason ? ': ' + reason : ''}`,
    refType: 'TLOSS', refTxk: txk, refTable: 'write_offs',
    lines: [D(mode === 'claim' ? sys.claims : sys.transit_loss, value + tax), C(sys.git, value), C(sys.gst_input, tax)] }));
  st.push(auditStatement(c, 'write off', `${bill.number}: ${value / 100} + GST ${tax / 100} (${mode})`));
  await db.batch(st);
  return writeOffOut(await db.prepare(`SELECT * FROM write_offs WHERE txk = ?`).bind(txk).first());
}

/* POST /api/write-offs/:id/cancel: the goods are to come again (found, or written off by mistake) */
export async function cancelWriteOff(c, id) {
  requireCan(c.user, 'purchase');
  requireCancel(c.user);
  const { db } = c;
  const w = await db.prepare(`SELECT * FROM write_offs WHERE id = ? AND org_id = ?`).bind(id, c.org.id).first();
  if (!w) throw notFound('Write-off not found.');
  if (w.status === 'cancelled') throw bad('Already cancelled.');
  const [lines, jls] = await db.batch([db.prepare(`SELECT * FROM write_off_lines WHERE write_off_id = ?`).bind(w.id),
    db.prepare(`SELECT jl.* FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id WHERE j.org_id = ? AND j.ref_type = 'TLOSS' AND j.ref_id = ?`).bind(c.org.id, w.id)]);
  const st = [db.prepare(`UPDATE write_offs SET status = 'cancelled' WHERE id = ? AND status = 'done'`).bind(w.id)];
  for (const l of lines.results) st.push(db.prepare(`UPDATE doc_lines SET short_qty = MAX(0, ROUND(short_qty - ?, 3)) WHERE id = ?`).bind(l.qty, l.line_id));
  st.push(db.prepare(TRANSIT_SQL).bind(w.bill_id));
  st.push(...journalStatements(db, c, { date: w.date, narration: 'Cancelled ' + w.number, refType: 'TLOSS-X', refId: w.id,
    lines: jls.results.map((l) => ({ account: l.account_id, party: l.party_id, amount: l.credit - l.debit })) }));
  st.push(auditStatement(c, 'cancel write off', w.number));
  await db.batch(st);
  return { ok: true };
}
