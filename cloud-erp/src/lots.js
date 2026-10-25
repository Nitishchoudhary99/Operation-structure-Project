/* Where the stock sits (bins: racks and shelves) and which batch it is (batch number, expiry date). Both are detail
   under a godown's quantity in `stock`, which stays the only figure the books, the stock value and every report use:
   - bin_stock: quantity per item per bin. Whatever is in the godown but not in a bin is "not put away"
     (godown quantity - the bins), so a business that never makes bins sees no change.
   - batches: quantity per item, godown and batch number, with expiry. Stock bought before an item tracked batches,
     or bought without a batch number, is "no batch" (godown quantity - the batches).
   Goods coming in go to the item's default bin in that godown (items.location, when such a bin exists) and to the
   batch on the line. Goods going out are taken first from what is not put away, then from the bins (the default bin
   first), and from the batch on the line, else the batch that expires first (FEFO), then "no batch".
   Every batch movement is kept in batch_moves, so cancelling a bill puts goods back into the very same batches.
   Serial numbers (IMEI) work the same way, one row per unit in `serials` with its history in serial_moves: in stock
   in a godown, sold (to whom, when: the warranty check), or void when the purchase that brought it is cancelled. */
import { bad, notFound, str, roundQty, nowIso, today, addDays, loadByIds } from './lib.js';
import { requireCan } from './auth.js';

const R = (p) => Math.round(p) / 100;

/* The bins of one godown, and the bin and batch detail of the given items there. items: item rows (id, location, track_batch). */
export async function lotState(db, orgId, warehouseId, items, { hasBins = null, have: known = null, incoming = [] } = {}) {
  const ids = [...new Set(items.filter((i) => i && !i.is_service).map((i) => i.id))];
  const S = { wh: warehouseId, bins: new Map(), binsOf: new Map(), free: new Map(), batchesOf: new Map(), loose: new Map(), item: new Map(),
    serialsOf: new Map(), inStock: new Set() };
  for (const i of items) if (i) S.item.set(i.id, i);
  if (!ids.length) return S;
  const tracked = ids.filter((id) => S.item.get(id).track_batch), serialItems = ids.filter((id) => S.item.get(id).track_serial);
  // serials in stock here (oldest first); serials coming in that are already in stock anywhere are refused
  if (serialItems.length) {
    const rows = await loadByIds(db, `SELECT item_id, serial FROM serials WHERE org_id = ? AND warehouse_id = ? AND status = 'in' AND item_id IN (?ids) ORDER BY in_date, id`,
      [orgId, warehouseId], serialItems);
    for (const id of serialItems) S.serialsOf.set(id, rows.filter((r) => r.item_id === id).map((r) => r.serial));
    if (incoming.length) {
      const dup = await loadByIds(db, `SELECT item_id, serial FROM serials WHERE org_id = ? AND status = 'in' AND serial IN (?ids)`, [orgId], incoming);
      for (const r of dup) S.inStock.add(r.item_id + '|' + r.serial);
    }
  }
  // a godown without bins and items without batches need nothing more (hasBins: the caller already knows)
  const bins = hasBins === false ? [] : (await db.prepare(`SELECT id, code FROM bins WHERE org_id = ? AND warehouse_id = ?`).bind(orgId, warehouseId).all()).results;
  if (!bins.length && !tracked.length) return S;
  for (const b of bins) S.bins.set(b.code, b);
  const missing = known ? ids.filter((id) => !known.has(id)) : ids;
  const stock = missing.length ? await loadByIds(db, `SELECT item_id, qty FROM stock WHERE org_id = ? AND warehouse_id = ? AND item_id IN (?ids)`, [orgId, warehouseId], missing) : [];
  const have = new Map([...(known ? [...known] : []), ...stock.map((r) => [r.item_id, r.qty])]);
  const [binRows, batchRows] = await Promise.all([
    bins.length ? loadByIds(db, `SELECT bs.item_id, bs.bin_id, bs.qty, b.code FROM bin_stock bs JOIN bins b ON b.id = bs.bin_id
        WHERE bs.org_id = ? AND bs.warehouse_id = ? AND bs.item_id IN (?ids)`, [orgId, warehouseId], ids) : [],
    tracked.length ? loadByIds(db, `SELECT item_id, batch_no, expiry, mfg, qty FROM batches WHERE org_id = ? AND warehouse_id = ? AND item_id IN (?ids)`,
      [orgId, warehouseId], tracked) : [],
  ]);
  for (const id of ids) {
    const loc = S.item.get(id).location || '';
    const mine = binRows.filter((r) => r.item_id === id).map((r) => ({ bin_id: r.bin_id, code: r.code, qty: r.qty }))
      .sort((a, b) => (b.code === loc) - (a.code === loc) || a.code.localeCompare(b.code, undefined, { numeric: true }));
    S.binsOf.set(id, mine);
    S.free.set(id, roundQty((have.get(id) || 0) - mine.reduce((s, r) => s + r.qty, 0)));
    const bt = batchRows.filter((r) => r.item_id === id).map((r) => ({ no: r.batch_no, expiry: r.expiry || '', mfg: r.mfg || '', qty: r.qty }));
    S.batchesOf.set(id, bt);
    S.loose.set(id, roundQty((have.get(id) || 0) - bt.reduce((s, r) => s + r.qty, 0)));
  }
  return S;
}

const fefo = (a, b) => (a.expiry || '9999') .localeCompare(b.expiry || '9999') || (a.mfg || '').localeCompare(b.mfg || '') || a.no.localeCompare(b.no, undefined, { numeric: true });

/* Goods leaving: which bins and which batches they come from. wantBatch = the batch typed on the line, if any. */
export function takeOut(S, item, qty, wantBatch = '', soft = false, serials = [], softSerials = soft) {
  const plan = { bins: [], batches: [], serials: [] };
  if (!item || item.is_service) return plan;
  if (item.track_serial) {
    // the serials typed or scanned on the line; none (or, from a source line, ones no longer here): the oldest in stock
    const list = S.serialsOf.get(item.id) || [];
    const want = serials && serials.length && !(softSerials && serials.some((x) => !list.includes(x))) ? serials : null;
    if (want) for (const x of want) if (!list.includes(x)) throw bad(`Serial ${x} of ${item.name} is not in stock here.`);
    const pick = want || list.slice(0, Math.max(0, Math.floor(qty + 0.0005)));
    S.serialsOf.set(item.id, list.filter((x) => !pick.includes(x)));
    plan.serials = pick.map((x) => ({ serial: x, dir: -1 }));
  }
  // bins: what is not put away goes first, then the bins
  let need = qty;
  const free = Math.max(0, S.free.get(item.id) || 0), fromFree = Math.min(free, need);
  S.free.set(item.id, roundQty((S.free.get(item.id) || 0) - fromFree)); need = roundQty(need - fromFree);
  for (const b of S.binsOf.get(item.id) || []) {
    if (need <= 0.0005) break;
    const t = Math.min(Math.max(0, b.qty), need);
    if (t > 0.0005) { b.qty = roundQty(b.qty - t); need = roundQty(need - t); plan.bins.push({ bin_id: b.bin_id, code: b.code, qty: -roundQty(t) }); }
  }
  if (!item.track_batch) return plan;
  // batches: the one on the line, else first to expire, then stock that has no batch
  let left = qty;
  const list = S.batchesOf.get(item.id) || [];
  const want = wantBatch && list.find((x) => x.no === wantBatch);
  if (wantBatch && !(soft && (!want || want.qty + 0.0005 < qty))) {     // soft: carried from the source line, so FEFO when it no longer fits
    const b = want;
    if (!b || b.qty + 0.0005 < qty) throw bad(`Batch ${wantBatch} of ${item.name} has only ${b ? roundQty(Math.max(0, b.qty)) : 0} ${item.unit} here.`);
    b.qty = roundQty(b.qty - qty);
    plan.batches.push({ no: b.no, expiry: b.expiry, mfg: b.mfg, qty: -qty });
    return plan;
  }
  for (const b of list.filter((x) => x.qty > 0.0005).sort(fefo)) {
    if (left <= 0.0005) break;
    const t = Math.min(b.qty, left);
    b.qty = roundQty(b.qty - t); left = roundQty(left - t);
    plan.batches.push({ no: b.no, expiry: b.expiry, mfg: b.mfg, qty: -roundQty(t) });
  }
  if (left > 0.0005) S.loose.set(item.id, roundQty((S.loose.get(item.id) || 0) - left));   // the rest had no batch
  return plan;
}

/* Goods coming in: into the item's default bin here (if that bin exists) and into the batch on the line. */
export function putIn(S, item, qty, batch = null, binCode = '', serials = []) {
  const plan = { bins: [], batches: [], serials: [] };
  if (!item || item.is_service) return plan;
  if (item.track_serial && serials && serials.length) {
    const here = S.serialsOf.get(item.id) || [];
    for (const x of serials) if (here.includes(x) || S.inStock.has(item.id + '|' + x)) throw bad(`Serial ${x} of ${item.name} is already in stock.`);
    S.serialsOf.set(item.id, [...here, ...serials]);
    plan.serials = serials.map((x) => ({ serial: x, dir: 1 }));
  }
  const bin = S.bins.get(binCode || item.location || '');
  if (bin) {
    plan.bins.push({ bin_id: bin.id, code: bin.code, qty });
    const row = (S.binsOf.get(item.id) || []).find((b) => b.bin_id === bin.id);
    if (row) row.qty = roundQty(row.qty + qty); else { if (!S.binsOf.has(item.id)) S.binsOf.set(item.id, []); S.binsOf.get(item.id).push({ bin_id: bin.id, code: bin.code, qty }); }
  } else S.free.set(item.id, roundQty((S.free.get(item.id) || 0) + qty));
  if (item.track_batch && batch && batch.no) {
    plan.batches.push({ no: batch.no, expiry: batch.expiry || '', mfg: batch.mfg || '', qty });
    const list = S.batchesOf.get(item.id) || [];
    const b = list.find((x) => x.no === batch.no);
    if (b) b.qty = roundQty(b.qty + qty); else { list.push({ no: batch.no, expiry: batch.expiry || '', mfg: batch.mfg || '', qty }); S.batchesOf.set(item.id, list); }
  } else if (item.track_batch) S.loose.set(item.id, roundQty((S.loose.get(item.id) || 0) + qty));
  return plan;
}

/* D1 statements for a plan (bins and batches); ref like stock_moves: the document's txk, or a plain id */
export function lotStatements(db, orgId, { item, warehouse, plan, date: d, refType, refId, refTxk, refTable, party = null }) {
  const out = [];
  if (!plan) return out;
  for (const b of plan.bins) {
    out.push(db.prepare(`INSERT INTO bin_stock (org_id, item_id, bin_id, warehouse_id, qty) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(item_id, bin_id) DO UPDATE SET qty = ROUND(qty + excluded.qty, 3)`).bind(orgId, item, b.bin_id, warehouse, b.qty));
  }
  const refExpr = refTxk ? `(SELECT id FROM ${refTable} WHERE txk = ?)` : '?';
  for (const b of plan.batches) {
    out.push(db.prepare(`INSERT INTO batches (org_id, item_id, warehouse_id, batch_no, mfg, expiry, qty, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(org_id, item_id, warehouse_id, batch_no) DO UPDATE SET qty = ROUND(qty + excluded.qty, 3),
          expiry = CASE WHEN excluded.expiry != '' THEN excluded.expiry ELSE expiry END, mfg = CASE WHEN excluded.mfg != '' THEN excluded.mfg ELSE mfg END`)
      .bind(orgId, item, warehouse, b.no, b.qty > 0 ? b.mfg || '' : '', b.qty > 0 ? b.expiry || '' : '', b.qty, nowIso()));
    out.push(db.prepare(`INSERT INTO batch_moves (org_id, batch_id, item_id, warehouse_id, date, qty, ref_type, ref_id)
        VALUES (?, (SELECT id FROM batches WHERE org_id = ? AND item_id = ? AND warehouse_id = ? AND batch_no = ?), ?, ?, ?, ?, ?, ${refExpr})`)
      .bind(orgId, orgId, item, warehouse, b.no, item, warehouse, d, b.qty, refType, refTxk || refId || null));
  }
  for (const x of plan.serials || []) {
    if (x.dir > 0) {
      out.push(db.prepare(`INSERT INTO serials (org_id, item_id, serial, warehouse_id, status, in_date, created_at) VALUES (?, ?, ?, ?, 'in', ?, ?)
          ON CONFLICT(org_id, serial, item_id) DO UPDATE SET status = 'in', warehouse_id = excluded.warehouse_id, in_date = excluded.in_date, out_date = NULL, party_id = NULL`)
        .bind(orgId, item, x.serial, warehouse, d, nowIso()));
    } else {
      out.push(db.prepare(`UPDATE serials SET status = ?, out_date = ?, party_id = ? WHERE org_id = ? AND item_id = ? AND serial = ?`)
        .bind(x.void ? 'void' : 'out', d, x.void ? null : party, orgId, item, x.serial));
    }
    out.push(db.prepare(`INSERT INTO serial_moves (org_id, serial_id, item_id, warehouse_id, date, dir, ref_type, ref_id, party_id)
        VALUES (?, (SELECT id FROM serials WHERE org_id = ? AND item_id = ? AND serial = ?), ?, ?, ?, ?, ?, ${refExpr}, ?)`)
      .bind(orgId, orgId, item, x.serial, item, warehouse, d, x.dir, refType, refTxk || refId || null, party));
  }
  return out;
}

/* what a line shows and prints: the batch(es) it took and the earliest expiry */
export const planBatchText = (plan) => {
  const bs = (plan && plan.batches || []).filter((b) => b.no);
  return { batch_no: [...new Set(bs.map((b) => b.no))].join(', ').slice(0, 80), expiry: bs.map((b) => b.expiry).filter(Boolean).sort()[0] || '' };
};
/* serial / IMEI numbers typed or scanned on a line: one per line, or separated by commas or spaces */
export function cleanSerials(raw) {
  const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/)).map((x) => str(x, 40).toUpperCase()).filter(Boolean);
  if (list.length > 1000) throw bad('At most 1000 serial numbers on one line.');
  const seen = new Set();
  for (const x of list) { if (seen.has(x)) throw bad(`Serial ${x} is typed twice.`); seen.add(x); }
  return list;
}

/* one serial / IMEI: where it is, who bought it and when, and whether it is still under warranty */
export async function serialLookup(c, q) {
  const term = str(q, 40).toUpperCase();
  if (term.length < 3) return { rows: [] };
  const { results } = await c.db.prepare(`SELECT s.id, s.serial, s.status, s.in_date, s.out_date, i.id AS item_id, i.name AS item, i.warranty_months, w.name AS warehouse, p.name AS party, p.phone
      FROM serials s JOIN items i ON i.id = s.item_id LEFT JOIN warehouses w ON w.id = s.warehouse_id LEFT JOIN parties p ON p.id = s.party_id
      WHERE s.org_id = ? AND s.serial LIKE ? ORDER BY s.serial = ? DESC, s.serial LIMIT 20`).bind(c.org.id, `%${term.replace(/[%_]/g, '')}%`, term).all();
  const ids = results.slice(0, 5).map((r) => r.id);
  const hist = ids.length ? (await c.db.prepare(`SELECT sm.serial_id, sm.date, sm.dir, sm.ref_type, d.id AS doc_id, d.number, p.name AS party, w.name AS warehouse FROM serial_moves sm
      LEFT JOIN docs d ON d.id = sm.ref_id AND d.org_id = sm.org_id AND sm.ref_type NOT IN ('OPEN','ADJ','COUNT','XFER','MFG','MFG-X')
      LEFT JOIN parties p ON p.id = sm.party_id LEFT JOIN warehouses w ON w.id = sm.warehouse_id
      WHERE sm.org_id = ? AND sm.serial_id IN (${ids.map(() => '?').join(',')}) ORDER BY sm.id`).bind(c.org.id, ...ids).all()).results : [];
  const t = today();
  return { rows: results.map((r) => {
    let until = '';
    if (r.status === 'out' && r.out_date && r.warranty_months) {
      const [y, m, d] = r.out_date.split('-').map(Number), e = new Date(Date.UTC(y, m - 1 + r.warranty_months, d));
      until = e.toISOString().slice(0, 10);
    }
    return { ...r, warranty_until: until, in_warranty: !!until && until >= t, history: hist.filter((h) => h.serial_id === r.id) };
  }) };
}

/* batch number and expiry typed on a line: expiry as YYYY-MM (the last day of that month) or YYYY-MM-DD */
export function cleanBatch(raw) {
  const no = str(raw && raw.batch_no, 40).replace(/\s+/g, ' ');
  let ex = str(raw && raw.expiry, 10);
  if (/^\d{4}-\d{2}$/.test(ex)) { const [y, m] = ex.split('-').map(Number); ex = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
  if (ex && !/^\d{4}-\d{2}-\d{2}$/.test(ex)) throw bad('Expiry must be a month or a date.');
  let mfg = str(raw && raw.mfg, 10);
  if (/^\d{4}-\d{2}$/.test(mfg)) mfg += '-01';
  if (mfg && !/^\d{4}-\d{2}-\d{2}$/.test(mfg)) mfg = '';
  return { no, expiry: ex, mfg };
}

/* ---------------------------------------------------------------- bins: setup and moving stock between them */
export async function listBins(c, warehouseId) {
  const wh = await c.db.prepare(`SELECT id, name FROM warehouses WHERE id = ? AND org_id = ?`).bind(warehouseId, c.org.id).first();
  if (!wh) throw notFound('Godown not found.');
  const [bins, free] = await c.db.batch([
    c.db.prepare(`SELECT b.id, b.code, b.zone, b.capacity, COUNT(CASE WHEN bs.qty > 0.0005 THEN 1 END) AS items, COALESCE(SUM(CASE WHEN bs.qty > 0 THEN bs.qty END), 0) AS qty
      FROM bins b LEFT JOIN bin_stock bs ON bs.bin_id = b.id WHERE b.org_id = ? AND b.warehouse_id = ? GROUP BY b.id ORDER BY b.code`).bind(c.org.id, wh.id),
    // stock in this godown that is not in any bin yet
    c.db.prepare(`SELECT i.id, i.name, i.unit, i.location, s.qty - COALESCE((SELECT SUM(qty) FROM bin_stock WHERE item_id = s.item_id AND warehouse_id = s.warehouse_id), 0) AS free
      FROM stock s JOIN items i ON i.id = s.item_id WHERE s.org_id = ? AND s.warehouse_id = ? AND i.is_service = 0 AND s.qty > 0.0005
      AND s.qty - COALESCE((SELECT SUM(qty) FROM bin_stock WHERE item_id = s.item_id AND warehouse_id = s.warehouse_id), 0) > 0.0005 ORDER BY i.name LIMIT 500`).bind(c.org.id, wh.id),
  ]);
  return { warehouse: wh, bins: bins.results.map((b) => ({ ...b, qty: roundQty(b.qty) })), not_put_away: free.results.map((r) => ({ ...r, free: roundQty(r.free) })) };
}

/* codes: a list, or a pattern: racks A..D x shelves 1..5 x levels 1..3 -> A-01-1 ... */
export async function addBins(c, body) {
  requireCan(c.user, 'stock');
  const wh = await c.db.prepare(`SELECT id, name FROM warehouses WHERE id = ? AND org_id = ?`).bind(+body.warehouse_id || 0, c.org.id).first();
  if (!wh) throw notFound('Godown not found.');
  let codes = [];
  if (Array.isArray(body.codes)) codes = body.codes;
  else {
    const racks = str(body.racks, 60).split(/[\s,]+/).filter(Boolean).flatMap((r) => {
      const m = r.match(/^([A-Za-z])-([A-Za-z])$/);
      if (!m) return [r];
      const a = m[1].toUpperCase().charCodeAt(0), z = m[2].toUpperCase().charCodeAt(0);
      return Array.from({ length: Math.max(0, z - a + 1) }, (_, k) => String.fromCharCode(a + k));
    });
    const shelves = Math.min(99, Math.max(0, +body.shelves || 0)), levels = Math.min(9, Math.max(0, +body.levels || 0));
    for (const r of racks) {
      if (!shelves) { codes.push(r); continue; }
      for (let s = 1; s <= shelves; s++) {
        if (!levels) codes.push(`${r}-${String(s).padStart(2, '0')}`);
        else for (let l = 1; l <= levels; l++) codes.push(`${r}-${String(s).padStart(2, '0')}-${l}`);
      }
    }
  }
  codes = [...new Set(codes.map((x) => str(x, 30).toUpperCase().replace(/\s+/g, '-')).filter(Boolean))];
  if (!codes.length) throw bad('Give at least one bin, like A-01-1, or racks and shelves.');
  if (codes.length > 500) throw bad('At most 500 bins at a time.');
  const zone = str(body.zone, 30), cap = Math.max(0, +body.capacity || 0);
  const st = [];
  for (let i = 0; i < codes.length; i += 30) {
    const part = codes.slice(i, i + 30);
    st.push(c.db.prepare(`INSERT OR IGNORE INTO bins (org_id, warehouse_id, code, zone, capacity, created_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`)
      .bind(...part.flatMap((code) => [c.org.id, wh.id, code, zone, cap, nowIso()])));
  }
  await c.db.batch(st);
  return { ok: true, added: codes.length, codes: codes.slice(0, 20) };
}

export async function deleteBin(c, id) {
  requireCan(c.user, 'stock');
  const b = await c.db.prepare(`SELECT b.*, (SELECT COALESCE(SUM(qty), 0) FROM bin_stock WHERE bin_id = b.id AND qty > 0.0005) AS qty FROM bins b WHERE b.id = ? AND b.org_id = ?`).bind(id, c.org.id).first();
  if (!b) throw notFound('Bin not found.');
  if (b.qty > 0.0005) throw bad(`Bin ${b.code} still has stock. Move it out first.`);
  await c.db.batch([c.db.prepare(`DELETE FROM bin_stock WHERE bin_id = ?`).bind(id), c.db.prepare(`DELETE FROM bins WHERE id = ?`).bind(id)]);
  return { ok: true };
}

export async function binContents(c, id) {
  const b = await c.db.prepare(`SELECT b.*, w.name AS warehouse FROM bins b JOIN warehouses w ON w.id = b.warehouse_id WHERE b.id = ? AND b.org_id = ?`).bind(id, c.org.id).first();
  if (!b) throw notFound('Bin not found.');
  const { results } = await c.db.prepare(`SELECT i.id, i.name, i.unit, i.sku, i.barcode, bs.qty FROM bin_stock bs JOIN items i ON i.id = bs.item_id
      WHERE bs.bin_id = ? AND bs.qty > 0.0005 ORDER BY i.name`).bind(id).all();
  return { bin: b, items: results.map((r) => ({ ...r, qty: roundQty(r.qty) })) };
}

/* put away / move: from a bin (0 = not put away yet) to a bin (0 = take it out of bins). The godown total does not change. */
export async function moveInBins(c, body) {
  requireCan(c.user, 'stock');
  const item = await c.db.prepare(`SELECT * FROM items WHERE id = ? AND org_id = ?`).bind(+body.item_id || 0, c.org.id).first();
  if (!item || item.is_service) throw bad('Choose a stocked item.');
  const whId = +body.warehouse_id || 0, from = +body.from_bin_id || 0, to = +body.to_bin_id || 0;
  if (from === to) throw bad('Choose a different bin to move to.');
  const qty = roundQty(+body.qty || 0);
  if (!(qty > 0)) throw bad('Quantity must be more than zero.');
  const bins = (await c.db.prepare(`SELECT id, code FROM bins WHERE org_id = ? AND warehouse_id = ? AND id IN (?, ?)`).bind(c.org.id, whId, from, to).all()).results;
  const fb = bins.find((b) => b.id === from), tb = bins.find((b) => b.id === to);
  if ((from && !fb) || (to && !tb)) throw bad('That bin is not in this godown.');
  const S = await lotState(c.db, c.org.id, whId, [item]);
  const avail = from ? ((S.binsOf.get(item.id) || []).find((b) => b.bin_id === from) || { qty: 0 }).qty : S.free.get(item.id) || 0;
  if (avail + 0.0005 < qty) throw bad(`Only ${roundQty(Math.max(0, avail))} ${item.unit} of ${item.name} ${from ? `in bin ${fb.code}` : 'is not put away'}.`);
  const plan = { bins: [], batches: [] };
  if (from) plan.bins.push({ bin_id: from, qty: -qty });
  if (to) plan.bins.push({ bin_id: to, qty });
  await c.db.batch([...lotStatements(c.db, c.org.id, { item: item.id, warehouse: whId, plan }),
    c.db.prepare(`INSERT INTO audit (org_id, user_id, at, action, detail) VALUES (?, ?, ?, 'bin move', ?)`)
      .bind(c.org.id, c.user.id, nowIso(), `${item.name} ${qty} ${fb ? fb.code : 'not put away'} -> ${tb ? tb.code : 'not put away'}`)]);
  return { ok: true };
}

/* one item: its bins and batches in every godown (item page, the batch picker on bills) */
export async function itemLots(c, itemId, warehouseId = 0) {
  const it = await c.db.prepare(`SELECT id, name, unit, location, track_batch, track_serial FROM items WHERE id = ? AND org_id = ?`).bind(itemId, c.org.id).first();
  if (!it) throw notFound('Item not found.');
  const w = warehouseId ? ' AND x.warehouse_id = ?' : '', args = warehouseId ? [c.org.id, itemId, warehouseId] : [c.org.id, itemId];
  const [bins, batches, serials] = await c.db.batch([
    c.db.prepare(`SELECT x.bin_id, b.code, x.warehouse_id, w.name AS warehouse, x.qty FROM bin_stock x JOIN bins b ON b.id = x.bin_id JOIN warehouses w ON w.id = x.warehouse_id
      WHERE x.org_id = ? AND x.item_id = ?${w} AND x.qty > 0.0005 ORDER BY w.name, b.code`).bind(...args),
    c.db.prepare(`SELECT x.batch_no, x.expiry, x.mfg, x.warehouse_id, w.name AS warehouse, x.qty FROM batches x JOIN warehouses w ON w.id = x.warehouse_id
      WHERE x.org_id = ? AND x.item_id = ?${w} AND x.qty > 0.0005 ORDER BY COALESCE(NULLIF(x.expiry, ''), '9999'), x.batch_no`).bind(...args),
    c.db.prepare(`SELECT x.serial, x.warehouse_id, w.name AS warehouse, x.in_date FROM serials x JOIN warehouses w ON w.id = x.warehouse_id
      WHERE x.org_id = ? AND x.item_id = ?${w} AND x.status = 'in' ORDER BY x.in_date, x.id LIMIT 500`).bind(...args),
  ]);
  return { item: it, bins: bins.results.map((r) => ({ ...r, qty: roundQty(r.qty) })), batches: batches.results.map((r) => ({ ...r, qty: roundQty(r.qty) })), serials: serials.results };
}

/* expiry: batches in stock that have expired or expire within `days` days, with their value at average cost */
export async function expiryReport(c, days) {
  const t = today(), until = addDays(t, Math.min(730, Math.max(1, days || 90)));
  const { results } = await c.db.prepare(`SELECT x.batch_no, x.expiry, x.mfg, x.qty, i.id AS item_id, i.name, i.unit, i.avg_cost, w.name AS warehouse
      FROM batches x JOIN items i ON i.id = x.item_id JOIN warehouses w ON w.id = x.warehouse_id
      WHERE x.org_id = ? AND x.qty > 0.0005 AND x.expiry != '' AND x.expiry <= ? ORDER BY x.expiry, i.name LIMIT 1000`).bind(c.org.id, until).all();
  const rows = results.map((r) => ({ batch_no: r.batch_no, expiry: r.expiry, mfg: r.mfg, qty: roundQty(r.qty), item_id: r.item_id, name: r.name, unit: r.unit, warehouse: r.warehouse,
    days_left: Math.round((Date.parse(r.expiry) - Date.parse(t)) / 864e5), value: R(r.qty * r.avg_cost) }));
  const sum = (f) => Math.round(rows.filter(f).reduce((s, r) => s + r.value * 100, 0)) / 100;
  return { today: t, until, rows, expired_value: sum((r) => r.days_left < 0), soon_value: sum((r) => r.days_left >= 0) };
}

/* Guided put-away: for each item waiting in no bin, the bin it should go to, in this order of preference: its default
   bin, a bin that already holds it, then the first empty bin (bins are walked in code order: A-01-1, A-01-2, ...). */
export async function putawayPlan(c, warehouseId) {
  const L = await listBins(c, warehouseId);
  if (!L.not_put_away.length || !L.bins.length) return { ...L, rows: [] };
  const ids = L.not_put_away.map((r) => r.id);
  const held = await loadByIds(c.db, `SELECT bs.item_id, bs.bin_id, bs.qty FROM bin_stock bs WHERE bs.org_id = ? AND bs.warehouse_id = ? AND bs.qty > 0.0005 AND bs.item_id IN (?ids)`,
    [c.org.id, L.warehouse.id], ids);
  const byCode = new Map(L.bins.map((b) => [b.code, b])), byId = new Map(L.bins.map((b) => [b.id, b]));
  // an empty bin that is some item's default bin is kept for that item
  const { results: kept } = await c.db.prepare(`SELECT DISTINCT location FROM items WHERE org_id = ? AND location != ''`).bind(c.org.id).all();
  const reserved = new Set(kept.map((r) => r.location));
  const empty = L.bins.filter((b) => !b.items && !reserved.has(b.code)).sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  let next = 0;
  const rows = L.not_put_away.map((r) => {
    let bin = r.location && byCode.get(r.location), why = 'default bin';
    if (!bin) {
      const h = held.filter((x) => x.item_id === r.id).sort((a, b) => b.qty - a.qty)[0];
      if (h) { bin = byId.get(h.bin_id); why = 'already holds this item'; }
    }
    if (!bin && next < empty.length) { bin = empty[next++]; why = 'empty bin'; }
    return { ...r, suggest: bin ? { bin_id: bin.id, code: bin.code, why } : null };
  });
  return { warehouse: L.warehouse, bins: L.bins.map((b) => ({ id: b.id, code: b.code })), rows };
}

/* Wave picking: one pick list for many open sales orders / delivery notes of one godown, walked bin by bin,
   with how much of each line goes to which order (for packing after the pick). */
export async function wavePick(c, ids) {
  requireCan(c.user, 'stock');
  ids = [...new Set(ids.map(Number).filter(Boolean))].slice(0, 50);
  if (!ids.length) throw bad('Choose the orders to pick.');
  const docs = await loadByIds(c.db, `SELECT d.id, d.type, d.number, d.warehouse_id, d.status, p.name AS party FROM docs d LEFT JOIN parties p ON p.id = d.party_id
      WHERE d.org_id = ? AND d.type IN ('SO','DN') AND d.status NOT IN ('cancelled','pending') AND d.id IN (?ids)`, [c.org.id], ids);
  if (!docs.length) throw bad('None of these orders can be picked.');
  const wh = docs[0].warehouse_id;
  if (docs.some((d) => d.warehouse_id !== wh)) throw bad('Pick orders of one godown at a time.');
  const lines = await loadByIds(c.db, `SELECT l.doc_id, l.item_id, l.qty, l.done_qty, l.batch_no, i.name, i.unit, i.location FROM doc_lines l JOIN items i ON i.id = l.item_id
      WHERE l.doc_id IN (?ids) AND i.is_service = 0`, [], docs.map((d) => d.id));
  const docOf = new Map(docs.map((d) => [d.id, d])), need = new Map();
  for (const l of lines) {
    const d = docOf.get(l.doc_id), q = roundQty(d.type === 'SO' ? l.qty - l.done_qty : l.qty);
    if (q <= 0.0005) continue;
    if (!need.has(l.item_id)) need.set(l.item_id, { item_id: l.item_id, name: l.name, unit: l.unit, location: l.location, qty: 0, orders: [] });
    const n = need.get(l.item_id); n.qty = roundQty(n.qty + q); n.orders.push({ number: d.number, party: d.party, qty: q });
  }
  const itemIds = [...need.keys()];
  const [bins, batches] = itemIds.length ? await Promise.all([
    loadByIds(c.db, `SELECT bs.item_id, b.code, bs.qty FROM bin_stock bs JOIN bins b ON b.id = bs.bin_id WHERE bs.org_id = ? AND bs.warehouse_id = ? AND bs.qty > 0.0005 AND bs.item_id IN (?ids)`, [c.org.id, wh], itemIds),
    loadByIds(c.db, `SELECT item_id, batch_no, expiry, qty FROM batches WHERE org_id = ? AND warehouse_id = ? AND qty > 0.0005 AND item_id IN (?ids)`, [c.org.id, wh], itemIds),
  ]) : [[], []];
  const byNum = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  const rows = [...need.values()].map((n) => {
    // where to take it from: the default bin first, then the other bins in walking order, until the quantity is covered
    const mine = bins.filter((b) => b.item_id === n.item_id).sort((a, b) => (b.code === n.location) - (a.code === n.location) || byNum(a.code, b.code));
    let left = n.qty; const from = [];
    for (const b of mine) { if (left <= 0.0005) break; const q = Math.min(left, b.qty); from.push({ code: b.code, qty: roundQty(q) }); left = roundQty(left - q); }
    const fefo = batches.filter((b) => b.item_id === n.item_id).sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'));
    return { ...n, from, short_of_bins: roundQty(Math.max(0, left)), batches: fefo.slice(0, 3).map((b) => ({ batch_no: b.batch_no, expiry: b.expiry, qty: roundQty(b.qty) })) };
  }).sort((a, b) => byNum((a.from[0] || {}).code || a.location || '~', (b.from[0] || {}).code || b.location || '~') || a.name.localeCompare(b.name));
  const w = await c.db.prepare(`SELECT name FROM warehouses WHERE id = ?`).bind(wh).first();
  return { warehouse: w ? w.name : '', docs: docs.map((d) => ({ id: d.id, number: d.number, party: d.party })), rows };
}
