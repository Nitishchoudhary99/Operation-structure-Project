/* Posting engine: trading documents, stock and the double-entry ledger.
   Every write for one business action (document + lines + stock + journal + links) goes into ONE
   D1 batch, which runs as a single transaction: it all happens or none of it does.
   Rows created inside a batch are found again through their unique `txk` key. */
import {
  HttpError, bad, notFound, str, reqStr, num, date, addDays, nowIso, uid, lineCalc, toPaise, roundQty, today,
  counterStatements, counterValueSql, own,
} from './lib.js';
import { requireCan, can } from './auth.js';
import { stateCode } from './gst.js';
import { checkInvoiceLimit, invoiceCap, invoiceCapError, hasFeature, planOf, upgradeError } from './saas.js';
import { cleanVaada, risk, riskStatements, riskInput } from './vaada.js';
import { numberSpec, fieldsOf, cleanExtra } from './custom.js';

export const DOC_TYPES = {
  QUOTE: { side: 'sales', prefix: 'QT', label: 'Quotation', from: [] },
  SO: { side: 'sales', prefix: 'SO', label: 'Sales Order', from: ['QUOTE'] },
  DN: { side: 'sales', prefix: 'DN', label: 'Delivery Note', from: ['SO'], stock: 'out' },
  INV: { side: 'sales', prefix: 'INV', label: 'Sales Invoice', from: ['SO', 'DN', 'QUOTE'], stock: 'out', money: true },
  SRET: { side: 'sales', prefix: 'CN', label: 'Sales Return (Credit Note)', from: ['INV'], needsRef: true, stock: 'in', money: true },
  PO: { side: 'purchase', prefix: 'PO', label: 'Purchase Order', from: [] },
  GRN: { side: 'purchase', prefix: 'GRN', label: 'Goods Receipt (GRN)', from: ['PO'], stock: 'in' },
  BILL: { side: 'purchase', prefix: 'BILL', label: 'Purchase Bill', from: ['PO', 'GRN'], stock: 'in', money: true },
  PRET: { side: 'purchase', prefix: 'DBN', label: 'Purchase Return (Debit Note)', from: ['BILL'], needsRef: true, stock: 'out', money: true },
  // value notes: rate difference, discount, short/damage claims, with no goods moving
  CNOTE: { side: 'sales', prefix: 'CRN', label: 'Credit Note (rate difference)', from: ['INV'], money: true, note: true },
  DNOTE: { side: 'purchase', prefix: 'DRN', label: 'Debit Note (rate difference)', from: ['BILL'], money: true, note: true },
};
/* Documents that reduce what the party owes / what we owe, and settle the original invoice or bill. */
export const NOTE_TYPES = ['SRET', 'PRET', 'CNOTE', 'DNOTE'];

/* ---------------------------------------------------------------- context */
export const SYS_SQL = `SELECT id, sys FROM accounts WHERE org_id = ? AND sys IS NOT NULL`;
export const sysMap = (rows) => Object.fromEntries(rows.map((r) => [r.sys, r.id]));

export async function cashAccount(db, orgId, id) {
  const a = await db.prepare(`SELECT id, name FROM accounts WHERE id = ? AND org_id = ? AND is_cash = 1`).bind(id, orgId).first();
  if (!a) throw bad('Choose a cash, bank or UPI account to pay from / into.');
  return a;
}

/* ---------------------------------------------------------------- journal */
/* lines: [{ account, party, amount }]  amount > 0 = debit, < 0 = credit. Must balance to zero. */
export function journalStatements(db, ctx, { date: d, narration, refType, refId, refTxk, refTable, lines }) {
  const clean = lines.filter((l) => l.amount && Math.round(l.amount) !== 0).map((l) => ({ ...l, amount: Math.round(l.amount) }));
  const sum = clean.reduce((s, l) => s + l.amount, 0);
  if (sum !== 0) throw new Error(`Unbalanced journal (${sum} paise): ${narration}`);
  if (!clean.length) return [];
  for (const l of clean) if (!l.account) throw new Error('Journal line without an account: ' + narration);
  const txk = uid();
  const refExpr = refTxk ? `(SELECT id FROM ${refTable} WHERE txk = ?)` : '?';
  const out = [db.prepare(`INSERT INTO journals (org_id, date, narration, ref_type, ref_id, created_by, created_at, txk)
                           VALUES (?, ?, ?, ?, ${refExpr}, ?, ?, ?)`)
    .bind(ctx.org.id, d, narration.slice(0, 300), refType, refTxk || refId || null, ctx.user.id, nowIso(), txk)];
  for (const l of clean) {
    // the account and party are looked up again inside this business: an id from another business becomes NULL (no party) or fails the whole batch (no account)
    out.push(db.prepare(`INSERT INTO journal_lines (journal_id, org_id, account_id, party_id, debit, credit, date)
                         VALUES ((SELECT id FROM journals WHERE txk = ?1), ?2, (SELECT id FROM accounts WHERE id = ?3 AND org_id = ?2), (SELECT id FROM parties WHERE id = ?4 AND org_id = ?2), ?5, ?6, ?7)`)
      .bind(txk, ctx.org.id, l.account, l.party || null, l.amount > 0 ? l.amount : 0, l.amount < 0 ? -l.amount : 0, d));
  }
  return out;
}

/* ---------------------------------------------------------------- stock */
/* qty > 0 adds stock (value = total cost in paise), qty < 0 removes it (value = cost taken out, positive). */
export function stockStatements(db, ctx, { item, warehouse, qty, value, date: d, refType, refId, refTxk, refTable, note = '' }) {
  const refExpr = refTxk ? `(SELECT id FROM ${refTable} WHERE txk = ?)` : '?';
  const out = [];
  if (qty > 0) {
    out.push(db.prepare(`UPDATE items SET
        avg_cost = CASE WHEN MAX(qty_on_hand, 0) + ? > 0 THEN (MAX(qty_on_hand, 0) * avg_cost + ?) / (MAX(qty_on_hand, 0) + ?) ELSE avg_cost END,
        qty_on_hand = ROUND(qty_on_hand + ?, 3) WHERE id = ? AND org_id = ?`).bind(qty, value, qty, qty, item, ctx.org.id));
  } else {
    const q = -qty;
    out.push(db.prepare(`UPDATE items SET
        avg_cost = CASE WHEN qty_on_hand - ? > 0.0005 THEN MAX(0, (qty_on_hand * avg_cost - ?) / (qty_on_hand - ?)) ELSE avg_cost END,
        qty_on_hand = ROUND(qty_on_hand - ?, 3) WHERE id = ? AND org_id = ?`).bind(q, value, q, q, item, ctx.org.id));
  }
  out.push(db.prepare(`INSERT INTO stock (org_id, item_id, warehouse_id, qty) VALUES (?, ?, ?, ?)
                       ON CONFLICT(item_id, warehouse_id) DO UPDATE SET qty = ROUND(qty + excluded.qty, 3)`)
    .bind(ctx.org.id, item, warehouse, qty));
  out.push(db.prepare(`INSERT INTO stock_moves (org_id, date, item_id, warehouse_id, qty, unit_cost, value, ref_type, ref_id, note)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${refExpr}, ?)`)
    .bind(ctx.org.id, d, item, warehouse, qty, Math.abs(value / qty), qty > 0 ? value : -value, refType, refTxk || refId || null, note));
  return out;
}

export async function available(db, orgId, itemId, warehouseId) {
  const r = await db.prepare(`SELECT qty FROM stock WHERE org_id = ? AND item_id = ? AND warehouse_id = ?`).bind(orgId, itemId, warehouseId).first();
  return r ? r.qty : 0;
}

/* Several rows by id in as few queries as possible (D1 allows 100 bound values per query; the free plan
   allows 50 queries per request, so per-line lookups would break on long documents). */
export async function loadByIds(db, sql, fixed, ids) {
  const out = [], uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 90) {
    const part = uniq.slice(i, i + 90);
    const { results } = await db.prepare(sql.replace('(?ids)', `(${part.map(() => '?').join(',')})`)).bind(...fixed, ...part).all();
    out.push(...results);
  }
  return out;
}
async function stockIn(db, orgId, warehouseId, itemIds) {
  const rows = await loadByIds(db, `SELECT item_id, qty FROM stock WHERE org_id = ? AND warehouse_id = ? AND item_id IN (?ids)`, [orgId, warehouseId], itemIds);
  return new Map(rows.map((r) => [r.item_id, r.qty]));
}

async function warehouseOf(ctx, id) {
  const { db, org } = ctx, orgId = org.id;
  // pos = how many older godowns the business has; a godown past the plan's limit (after a plan lapses) takes no new stock
  const pos = `(SELECT COUNT(*) FROM warehouses x WHERE x.org_id = w.org_id AND x.id < w.id) AS pos`;
  let w;
  if (id) {
    w = await db.prepare(`SELECT w.id, w.name, ${pos} FROM warehouses w WHERE w.id = ? AND w.org_id = ?`).bind(id, orgId).first();
    if (!w) throw bad('Unknown warehouse.');
  } else {
    w = await db.prepare(`SELECT w.id, w.name, ${pos} FROM warehouses w WHERE w.org_id = ? ORDER BY w.id LIMIT 1`).bind(orgId).first();
    if (!w) throw bad('Create a warehouse first.');
  }
  if (w.pos >= planOf(org).warehouses) throw upgradeError(`${w.name} is over the godown limit of your plan, so it cannot take new stock.`);
  return { id: w.id, name: w.name };
}

/* Signed amount: positive -> debit, negative -> credit. */
const D = (account, amount, party) => ({ account, amount, party });
const C = (account, amount, party) => ({ account, amount: -amount, party });

export function moneyStatus(total, paid) { return paid <= 0 ? 'unpaid' : paid >= total ? 'paid' : 'partial'; }

/* ---------------------------------------------------------------- documents */
export async function createDoc(ctx, body) {
  const { db } = ctx;
  const type = str(body.type, 10).toUpperCase();
  const T = own(DOC_TYPES, type);
  if (!T) throw bad('Unknown document type.');
  requireCan(ctx.user, T.side === 'sales' ? 'sales' : 'purchase');
  const cap = type === 'INV' ? invoiceCap(ctx.org) : null;
  if (cap) await checkInvoiceLimit(db, ctx.org);
  const orgId = ctx.org.id;
  const d = date(body.date);

  const party = await db.prepare(`SELECT * FROM parties WHERE id = ? AND org_id = ?`).bind(+body.party_id || 0, orgId).first();
  if (!party) throw bad(T.side === 'sales' ? 'Choose a customer.' : 'Choose a supplier.');
  if (T.side === 'sales' && party.kind === 'supplier') throw bad(`${party.name} is a supplier, not a customer.`);
  if (T.side === 'purchase' && party.kind === 'customer') throw bad(`${party.name} is a customer, not a supplier.`);

  // source document (Quote -> SO -> DN -> INV, PO -> GRN -> BILL, INV -> SRET, BILL -> PRET)
  let src = null, srcLines = new Map();
  if (body.ref_id) {
    src = await db.prepare(`SELECT * FROM docs WHERE id = ? AND org_id = ?`).bind(+body.ref_id, orgId).first();
    if (!src) throw bad('Source document not found.');
    if (!T.from.includes(src.type)) throw bad(`A ${T.label} cannot be made from a ${(own(DOC_TYPES, src.type) || {}).label || 'document of that kind'}.`);
    if (src.status === 'cancelled') throw bad('The source document is cancelled.');
    if (src.party_id !== party.id) throw bad('The source document belongs to another party.');
    const { results } = await db.prepare(`SELECT * FROM doc_lines WHERE doc_id = ?`).bind(src.id).all();
    for (const l of results) srcLines.set(l.id, l);
  } else if (T.needsRef) {
    throw bad(`A ${T.label} must be made from the original ${type === 'SRET' ? 'invoice' : 'bill'}.`);
  }

  const wh = await warehouseOf(ctx, +body.warehouse_id || (src && src.warehouse_id) || 0);
  // inter-state when the two GST state codes differ (from GSTIN, else state name); falls back to comparing names
  const sc = stateCode(party.state, party.gstin), oc = stateCode(ctx.org.state, ctx.org.gstin);
  const inter = sc && oc ? sc !== oc : !!(party.state && ctx.org.state && party.state.toLowerCase() !== ctx.org.state.toLowerCase());
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw bad('Add at least one line.');
  if (lines.length > 200) throw bad('At most 200 lines per document.');

  // stock movement happens here unless an earlier document already moved the goods
  const moves = T.stock && !(type === 'INV' && src && src.type === 'DN') && !(type === 'BILL' && src && src.type === 'GRN');
  // every item on the document in one query
  const itemCache = new Map((await loadByIds(db, `SELECT * FROM items WHERE org_id = ? AND id IN (?ids)`, [orgId], lines.map((l) => +l.item_id || 0))).map((i) => [i.id, i]));
  const getItem = (id) => itemCache.get(id);

  const L = [];
  const need = new Map();   // item -> qty leaving the warehouse
  for (const [i, raw] of lines.entries()) {
    const n = i + 1;
    const item = raw.item_id ? await getItem(+raw.item_id) : null;
    if (raw.item_id && !item) throw bad(`Line ${n}: unknown item.`);
    const qty = roundQty(num(raw.qty, `Line ${n} quantity`, { min: 0.001, max: 1e9 }));
    const fallbackRate = item && !T.note ? (T.side === 'sales' ? item.sale_price : item.purchase_price) : 0;   // notes: the user types the difference
    const rate = raw.rate === undefined || raw.rate === '' || raw.rate === null ? fallbackRate : toPaise(num(raw.rate, `Line ${n} rate`, { min: 0 }));
    const disc = num(raw.discount_pct, `Line ${n} discount`, { min: 0, max: 100, def: 0 });
    const gst = num(raw.gst_rate, `Line ${n} GST rate`, { min: 0, max: 100, def: item ? item.gst_rate : 0 });
    const desc = str(raw.description, 300) || (item ? item.name : '');
    if (!item && !desc) throw bad(`Line ${n}: choose an item or type a description.`);
    let srcLine = null;
    if (raw.src_line_id) {
      srcLine = srcLines.get(+raw.src_line_id);
      if (!srcLine) throw bad(`Line ${n} does not belong to the source document.`);
      const left = roundQty(srcLine.qty - srcLine.done_qty);
      if (qty > left + 0.0005) throw bad(`Line ${n}: only ${left} left to ${['SRET', 'PRET'].includes(type) ? 'return' : 'process'} on ${src.number}.`);
      if (srcLine.item_id !== (item ? item.id : null)) throw bad(`Line ${n}: the item differs from the source line.`);
    } else if (src && ['SRET', 'PRET'].includes(type)) {
      throw bad(`Line ${n}: returns must refer to a line of ${src.number}.`);
    }
    const calc = lineCalc({ qty, rate, discount_pct: disc, gst_rate: gst }, inter);
    const stocked = item && !item.is_service;
    L.push({ item, qty, rate, disc, gst, desc, srcLine, calc, stocked });
    if (moves && stocked && T.stock === 'out') need.set(item.id, (need.get(item.id) || 0) + qty);
  }

  if (T.note && !L.some((l) => l.calc.taxable > 0)) throw bad('Enter the rate difference (amount per unit) on at least one line.');

  // stock must be available for anything leaving the warehouse
  const onHand = await stockIn(db, orgId, wh.id, [...need.keys()]);
  for (const [itemId, q] of need) {
    const have = onHand.get(itemId) || 0;
    if (have + 0.0005 < q) {
      const it = itemCache.get(itemId);
      throw bad(`Not enough stock of ${it.name} in ${wh.name}: ${roundQty(have)} ${it.unit} available, ${roundQty(q)} needed.`);
    }
  }

  // totals with rounding to the rupee for invoices, bills and notes
  const taxable = L.reduce((s, l) => s + l.calc.taxable, 0);
  const cgst = L.reduce((s, l) => s + l.calc.cgst, 0), sgst = L.reduce((s, l) => s + l.calc.sgst, 0), igst = L.reduce((s, l) => s + l.calc.igst, 0);
  const exact = taxable + cgst + sgst + igst;
  const roundOff = T.money && body.round_off !== false ? Math.round(exact / 100) * 100 - exact : 0;
  const total = exact + roundOff;
  const tax = cgst + sgst + igst;

  const sys = ctx.sys;
  const txk = uid();
  const st = [];
  const ref = { refType: type, refTxk: txk, refTable: 'docs' };
  const dueDate = T.money ? (body.due_date ? date(body.due_date, 'Due date') : addDays(d, party.credit_days || 0)) : (body.due_date ? date(body.due_date, 'Due date') : null);
  const initialStatus = T.money && ['INV', 'BILL'].includes(type) ? 'unpaid' : 'open';

  const nspec = numberSpec(ctx.org, type, T.prefix, d);
  const extra = cleanExtra(fieldsOf(ctx.org), 'doc', body.extra, T.side);
  st.push(counterStatements(db, orgId, nspec.key));
  // on a capped plan the insert itself checks the monthly count, so parallel requests cannot all slip under the limit
  const docCols = `org_id, type, number, party_id, date, due_date, warehouse_id, ref_id, status, place_of_supply,
        inter_state, taxable, cgst, sgst, igst, round_off, total, paid, notes, created_by, created_at, txk, extra`;
  const docVals = `?, ?, ${counterValueSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?`;
  const docArgs = [orgId, type, nspec.fmt, orgId, nspec.key, party.id, d, dueDate, wh.id, src ? src.id : null, initialStatus,
    party.state || ctx.org.state || '', inter ? 1 : 0, taxable, cgst, sgst, igst, roundOff, total,
    str(body.notes, 1000), ctx.user.id, nowIso(), txk, extra];
  st.push(cap
    ? db.prepare(`INSERT INTO docs (${docCols}) SELECT ${docVals} WHERE (SELECT COUNT(*) FROM docs WHERE org_id = ? AND type = 'INV' AND created_at >= ?) < ?`)
      .bind(...docArgs, orgId, cap.since, cap.max)
    : db.prepare(`INSERT INTO docs (${docCols}) VALUES (${docVals})`).bind(...docArgs));

  // lines + stock + per-line cost
  let costOut = 0, costIn = 0, grniClear = 0, variance = 0, serviceCost = 0;
  for (const l of L) {
    let cost = 0;
    if (l.stocked) {
      if (moves && T.stock === 'out') {
        if (type === 'PRET') cost = l.calc.taxable;                     // goods go back at the billed rate
        else cost = Math.round(l.qty * l.item.avg_cost);
        st.push(...stockStatements(db, ctx, { item: l.item.id, warehouse: wh.id, qty: -l.qty, value: cost, date: d, ...ref, note: l.desc }));
        costOut += cost;
      } else if (moves && T.stock === 'in') {
        if (type === 'SRET') cost = Math.round(l.srcLine.cost * l.qty / l.srcLine.qty);   // back at the cost it left at
        else cost = l.calc.taxable;
        st.push(...stockStatements(db, ctx, { item: l.item.id, warehouse: wh.id, qty: l.qty, value: cost, date: d, ...ref, note: l.desc }));
        costIn += cost;
      } else if (type === 'INV' && src && src.type === 'DN') {
        cost = Math.round(l.srcLine.cost * l.qty / l.srcLine.qty);       // COGS was booked by the delivery note
      } else if (type === 'BILL' && src && src.type === 'GRN') {
        const grnValue = Math.round(l.srcLine.cost * l.qty / l.srcLine.qty);
        grniClear += grnValue;
        variance += l.calc.taxable - grnValue;
        cost = l.calc.taxable;
      }
    } else if (l.item && l.item.is_service && T.side === 'purchase' && ['BILL', 'PRET'].includes(type)) {
      serviceCost += l.calc.taxable * (type === 'PRET' ? -1 : 1);
    } else if (!l.item && ['BILL', 'PRET'].includes(type)) {
      serviceCost += l.calc.taxable * (type === 'PRET' ? -1 : 1);   // free-text purchase lines are expenses
    }
    st.push(db.prepare(`INSERT INTO doc_lines (doc_id, item_id, description, qty, rate, discount_pct, gst_rate, taxable, cgst, sgst, igst, total, src_line_id, cost)
                        VALUES ((SELECT id FROM docs WHERE txk = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(txk, l.item ? l.item.id : null, l.desc, l.qty, l.rate, l.disc, l.gst, l.calc.taxable, l.calc.cgst, l.calc.sgst, l.calc.igst, l.calc.total,
        l.srcLine ? l.srcLine.id : null, cost));
    if (l.srcLine) st.push(db.prepare(`UPDATE doc_lines SET done_qty = ROUND(done_qty + ?, 3) WHERE id = ?`).bind(l.qty, l.srcLine.id));
  }

  // purchase price variance: GRN valued stock at the PO rate, the bill may differ
  let varianceAccount = sys.inventory;
  if (variance && L.some((l) => l.stocked)) {
    const it = L.find((l) => l.stocked).item;
    if (it.qty_on_hand > 0.0005) {
      for (const l of L.filter((x) => x.stocked)) {
        const grnValue = Math.round(l.srcLine.cost * l.qty / l.srcLine.qty);
        const v = l.calc.taxable - grnValue;
        if (v) st.push(db.prepare(`UPDATE items SET avg_cost = avg_cost + ? / qty_on_hand WHERE id = ? AND qty_on_hand > 0.0005`).bind(v, l.item.id));
      }
    } else varianceAccount = sys.cogs;
  }

  // ledger postings
  const P = party.id, narr = `${T.label} ${party.name}`;
  let jl = [];
  switch (type) {
    case 'DN': jl = [D(sys.cogs, costOut), C(sys.inventory, costOut)]; break;
    case 'INV':
      jl = [D(sys.ar, total, P), C(sys.sales, taxable), C(sys.gst_output, tax), C(sys.round_off, roundOff)];
      if (moves) jl.push(D(sys.cogs, costOut), C(sys.inventory, costOut));
      break;
    case 'SRET':
      jl = [D(sys.sales, taxable), D(sys.gst_output, tax), D(sys.round_off, roundOff), C(sys.ar, total, P), D(sys.inventory, costIn), C(sys.cogs, costIn)];
      break;
    case 'GRN': jl = [D(sys.inventory, costIn), C(sys.grni, costIn)]; break;
    case 'BILL':
      jl = [D(sys.inventory, costIn), D(sys.grni, grniClear), D(varianceAccount, variance), D(sys.misc_exp || sys.cogs, serviceCost),
        D(sys.gst_input, tax), D(sys.round_off, roundOff), C(sys.ap, total, P)];
      break;
    case 'CNOTE':     // reduce the sale: Dr Sales discounts, Dr GST output / Cr Debtors
      jl = [D(sys.sales_adj || sys.sales, taxable), D(sys.gst_output, tax), D(sys.round_off, roundOff), C(sys.ar, total, P)];
      break;
    case 'DNOTE':     // reduce the purchase: Dr Creditors / Cr Purchase rate difference, Cr GST input
      jl = [D(sys.ap, total, P), C(sys.pur_adj || sys.cogs, taxable), C(sys.gst_input, tax), C(sys.round_off, roundOff)];
      break;
    case 'PRET':
      jl = [D(sys.ap, total, P), C(sys.inventory, costOut), C(sys.misc_exp || sys.cogs, -serviceCost), C(sys.gst_input, tax), C(sys.round_off, roundOff)];
      break;
  }
  if (jl.length) st.push(...journalStatements(db, ctx, { date: d, narration: narr, ...ref, lines: jl }));

  // goods receipt made at the gate: link the gate entry and close it
  if (type === 'GRN' && body.gate_entry_id) {
    const ge = await db.prepare(`SELECT * FROM gate_entries WHERE id = ? AND org_id = ? AND kind = 'in'`).bind(+body.gate_entry_id, orgId).first();
    if (!ge) throw bad('Gate entry not found.');
    if (ge.status !== 'open') throw bad(`Gate entry ${ge.number} is already ${ge.status === 'grn_done' ? 'received' : ge.status}.`);
    if (ge.party_id && ge.party_id !== party.id) throw bad(`Gate entry ${ge.number} is for another supplier.`);
    st.push(db.prepare(`UPDATE docs SET gate_entry_id = ? WHERE txk = ?`).bind(ge.id, txk));
    st.push(db.prepare(`UPDATE gate_entries SET status = 'grn_done', grn_id = (SELECT id FROM docs WHERE txk = ?) WHERE id = ? AND status = 'open'`).bind(txk, ge.id));
  }

  // source document progress
  if (src) {
    if (['SO', 'PO', 'DN', 'GRN'].includes(src.type)) {
      st.push(db.prepare(`UPDATE docs SET status = CASE
          WHEN (SELECT COUNT(*) FROM doc_lines WHERE doc_id = ? AND done_qty < qty - 0.0005) = 0 THEN 'closed'
          ELSE 'partial' END WHERE id = ?`).bind(src.id, src.id));
    } else if (src.type === 'QUOTE') {
      st.push(db.prepare(`UPDATE docs SET status = 'converted' WHERE id = ?`).bind(src.id));
    }
  }

  // a credit/debit note settles the original invoice/bill first; anything left is an advance to the party
  if (NOTE_TYPES.includes(type)) {
    const outstanding = src ? Math.max(0, src.total - src.paid) : 0;
    const apply = Math.min(outstanding, total);
    if (apply > 0) {
      st.push(db.prepare(`INSERT INTO payment_allocs (payment_id, doc_id, amount, note_id) VALUES (0, ?, ?, (SELECT id FROM docs WHERE txk = ?))`).bind(src.id, apply, txk));
      st.push(db.prepare(`UPDATE docs SET paid = paid + ?, status = CASE WHEN paid + ? >= total THEN 'paid' ELSE 'partial' END WHERE id = ?`).bind(apply, apply, src.id));
    }
    st.push(db.prepare(`UPDATE docs SET status = 'closed', paid = ? WHERE txk = ?`).bind(total, txk));
  }

  // cash sale / cash purchase: settle immediately
  let paidNow = 0;
  if (['INV', 'BILL'].includes(type) && body.payment && +body.payment.amount > 0) {
    const acct = await cashAccount(db, orgId, +body.payment.account_id);
    const amt = Math.min(toPaise(body.payment.amount), total);
    paidNow = amt;
    st.push(...paymentStatements(ctx, {
      kind: type === 'INV' ? 'receipt' : 'payment', party, account: acct.id, date: d, amount: amt,
      reference: str(body.payment.reference, 80), allocs: [{ txk, amount: amt, total }],
    }));
  }

  if (type === 'INV') await creditGate(ctx, party, total - paidNow, body, st);
  st.push(auditStatement(ctx, `create ${type}`, `${party.name} ${total / 100}`));
  try { await db.batch(st); } catch (e) {
    const msg = String(e && e.message);
    if (/UNIQUE constraint failed: docs\.org_id, docs\.type, docs\.number/.test(msg)) throw bad('This document number is already used. Change the next number in Settings > Numbering.');
    if (cap && /NOT NULL constraint failed: doc_lines\.doc_id/.test(msg)) throw invoiceCapError(cap);   // the guarded insert added no row: the cap was reached
    throw e;
  }
  return db.prepare(`SELECT * FROM docs WHERE txk = ?`).bind(txk).first();
}

/* Udhaar check before a credit sale (Vaada Pakka §5.3): old dues, credit limit and broken promises.
   'warn' mode is advisory, so it applies to clients that ask for it (the app sends credit_ok: false first);
   API clients and older app versions that do not know about it keep working as before. 'stop' mode is always
   enforced: only owner/admin may give udhaar then. An allowed override is audited in the invoice's own batch. */
export const CREDIT_STOP_TEXT = 'Is grahak ka udhaar abhi band hai. Owner ya admin se approve karayein.';
async function creditGate(ctx, party, unpaid, body, st) {
  if (unpaid <= 0) return;
  const s = cleanVaada(ctx.org.vaada);
  if (s.credit_check === 'off' || !hasFeature(ctx.org, 'vaada')) return;
  if (s.credit_check === 'warn' && !Object.prototype.hasOwnProperty.call(body, 'credit_ok')) return;
  const t = today();
  const r = risk(riskInput(await ctx.db.batch(riskStatements(ctx.db, ctx.org.id, party.id, t, s.grace)), party, unpaid, t), s);
  if (!r.risky) return;
  const canOverride = s.credit_check === 'warn' || can(ctx.user, 'settings');
  const cw = { name: party.name, text: r.text, reasons: r.reasons, mode: s.credit_check, can_override: canOverride, kept_pct: r.kept_pct };
  if (body.credit_ok !== true) throw new HttpError(409, r.text, { credit_warning: cw });
  if (!canOverride) throw new HttpError(409, CREDIT_STOP_TEXT, { credit_warning: { ...cw, text: CREDIT_STOP_TEXT } });
  st.push(auditStatement(ctx, 'credit override', `${party.name} ₹${unpaid / 100}: ${r.reasons.join(', ')}`));
}

export const auditStatement = (ctx, action, detail = '') =>
  ctx.db.prepare(`INSERT INTO audit (org_id, user_id, at, action, detail) VALUES (?, ?, ?, ?, ?)`)
    .bind(ctx.org.id, ctx.user.id, nowIso(), action, String(detail).slice(0, 300));

/* ---------------------------------------------------------------- payments */
/* allocs: [{ doc_id | txk, amount, total }]  */
export function paymentStatements(ctx, { kind, party, account, date: d, amount, reference = '', notes = '', allocs = [] }) {
  const { db } = ctx, sys = ctx.sys;
  const ptxk = uid();
  const nspec = numberSpec(ctx.org, kind, kind === 'receipt' ? 'RCT' : 'PAY', d);
  const st = [counterStatements(db, ctx.org.id, nspec.key),
    db.prepare(`INSERT INTO payments (org_id, number, kind, party_id, account_id, date, amount, reference, notes, created_by, created_at, txk)
                VALUES (?, ${counterValueSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(ctx.org.id, nspec.fmt, ctx.org.id, nspec.key, kind, party.id, account, d, amount, reference, notes, ctx.user.id, nowIso(), ptxk)];
  for (const a of allocs) {
    if (!a.amount) continue;
    const docExpr = a.txk ? '(SELECT id FROM docs WHERE txk = ?)' : '?';
    st.push(db.prepare(`INSERT INTO payment_allocs (payment_id, doc_id, amount) VALUES ((SELECT id FROM payments WHERE txk = ?), ${docExpr}, ?)`)
      .bind(ptxk, a.txk || a.doc_id, a.amount));
    st.push(db.prepare(`UPDATE docs SET paid = paid + ?, status = CASE WHEN paid + ? >= total THEN 'paid' WHEN paid + ? > 0 THEN 'partial' ELSE status END
                        WHERE ${a.txk ? 'txk' : 'id'} = ?`).bind(a.amount, a.amount, a.amount, a.txk || a.doc_id));
  }
  const lines = kind === 'receipt'
    ? [D(account, amount), C(sys.ar, amount, party.id)]
    : [D(sys.ap, amount, party.id), C(account, amount)];
  st.push(...journalStatements(db, ctx, { date: d, narration: `${kind === 'receipt' ? 'Receipt from' : 'Payment to'} ${party.name}`,
    refType: kind, refTxk: ptxk, refTable: 'payments', lines }));
  return st;
}

export async function createPayment(ctx, body) {
  const { db } = ctx;
  const kind = body.kind === 'payment' ? 'payment' : 'receipt';
  requireCan(ctx.user, 'finance');
  const party = await db.prepare(`SELECT * FROM parties WHERE id = ? AND org_id = ?`).bind(+body.party_id || 0, ctx.org.id).first();
  if (!party) throw bad('Choose a party.');
  const acct = await cashAccount(db, ctx.org.id, +body.account_id);
  const amount = toPaise(num(body.amount, 'Amount', { min: 0.01 }));
  const d = date(body.date);
  const docType = kind === 'receipt' ? 'INV' : 'BILL';
  const { results: open } = await db.prepare(`SELECT id, number, total, paid, due_date FROM docs
      WHERE org_id = ? AND party_id = ? AND type = ? AND status IN ('unpaid', 'partial') ORDER BY due_date, id`).bind(ctx.org.id, party.id, docType).all();
  let allocs = [];
  if (Array.isArray(body.allocations) && body.allocations.length) {
    let sum = 0;
    for (const a of body.allocations) {
      const doc = open.find((o) => o.id === +a.doc_id);
      if (!doc) throw bad('An allocation points to a document that is not open for this party.');
      const amt = toPaise(num(a.amount, 'Allocation', { min: 0 }));
      if (amt > doc.total - doc.paid) throw bad(`Allocation to ${doc.number} is more than its balance.`);
      sum += amt;
      allocs.push({ doc_id: doc.id, amount: amt });
    }
    if (sum > amount) throw bad('Allocations add up to more than the amount.');
  } else {
    let left = amount;                      // oldest due first
    for (const o of open) {
      if (left <= 0) break;
      const a = Math.min(left, o.total - o.paid);
      if (a > 0) { allocs.push({ doc_id: o.id, amount: a }); left -= a; }
    }
  }
  const st = paymentStatements(ctx, { kind, party, account: acct.id, date: d, amount, reference: str(body.reference, 80), notes: str(body.notes, 300), allocs });
  st.push(auditStatement(ctx, `create ${kind}`, `${party.name} ${amount / 100}`));
  await db.batch(st);
  return db.prepare(`SELECT * FROM payments WHERE org_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`).bind(ctx.org.id, kind).first();
}

/* ---------------------------------------------------------------- cancellation */
/* Reverses a document's journal and stock exactly, and undoes its effect on the source document. */
export async function cancelDoc(ctx, id) {
  const { db } = ctx;
  const doc = await db.prepare(`SELECT * FROM docs WHERE id = ? AND org_id = ?`).bind(id, ctx.org.id).first();
  if (!doc) throw notFound('Document not found.');
  requireCan(ctx.user, DOC_TYPES[doc.type].side === 'sales' ? 'sales' : 'purchase');
  if (doc.status === 'cancelled') throw bad('Already cancelled.');
  const child = await db.prepare(`SELECT number FROM docs WHERE ref_id = ? AND org_id = ? AND status != 'cancelled' LIMIT 1`).bind(doc.id, ctx.org.id).first();
  if (child) throw bad(`Cancel ${child.number} first: it was made from this document.`);
  const pay = await db.prepare(`SELECT 1 FROM payment_allocs WHERE doc_id = ? AND payment_id > 0 LIMIT 1`).bind(doc.id).first();
  if (pay) throw bad('Void the payments against this document first.');

  const st = [];
  const { results: moves } = await db.prepare(`SELECT * FROM stock_moves WHERE org_id = ? AND ref_type = ? AND ref_id = ?`).bind(ctx.org.id, doc.type, doc.id).all();
  const haveBy = new Map();
  for (const w of new Set(moves.filter((m) => m.qty > 0).map((m) => m.warehouse_id))) {
    for (const [item, q] of await stockIn(db, ctx.org.id, w, moves.filter((m) => m.warehouse_id === w).map((m) => m.item_id))) haveBy.set(w + ':' + item, q);
  }
  for (const m of moves) {
    if (m.qty > 0) {
      const have = haveBy.get(m.warehouse_id + ':' + m.item_id) || 0;
      if (have + 0.0005 < m.qty) throw bad('Cannot cancel: the goods received by this document have already been used.');
    }
    st.push(...stockStatements(db, ctx, { item: m.item_id, warehouse: m.warehouse_id, qty: -m.qty, value: Math.abs(m.value),
      date: doc.date, refType: doc.type + '-X', refId: doc.id, note: 'Cancelled ' + doc.number }));
  }
  const { results: jls } = await db.prepare(`SELECT jl.* FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
      WHERE j.org_id = ? AND j.ref_type = ? AND j.ref_id = ?`).bind(ctx.org.id, doc.type, doc.id).all();
  if (jls.length) {
    st.push(...journalStatements(db, ctx, { date: doc.date, narration: 'Cancelled ' + doc.number, refType: doc.type + '-X', refId: doc.id,
      lines: jls.map((l) => ({ account: l.account_id, party: l.party_id, amount: l.credit - l.debit })) }));
  }
  const { results: lines } = await db.prepare(`SELECT * FROM doc_lines WHERE doc_id = ?`).bind(doc.id).all();
  for (const l of lines) if (l.src_line_id) st.push(db.prepare(`UPDATE doc_lines SET done_qty = MAX(0, ROUND(done_qty - ?, 3)) WHERE id = ?`).bind(l.qty, l.src_line_id));
  if (doc.ref_id) {
    st.push(db.prepare(`UPDATE docs SET status = CASE
        WHEN type IN ('SO','PO','DN','GRN') THEN CASE WHEN (SELECT COALESCE(SUM(done_qty), 0) FROM doc_lines WHERE doc_id = ?) > 0.0005 THEN 'partial' ELSE 'open' END
        WHEN type = 'QUOTE' THEN 'open' ELSE status END WHERE id = ?`).bind(doc.ref_id, doc.ref_id));
  }
  // credit/debit note: take back what it settled on the original invoice/bill
  const { results: na } = await db.prepare(`SELECT * FROM payment_allocs WHERE note_id = ?`).bind(doc.id).all();
  for (const a of na) {
    st.push(db.prepare(`UPDATE docs SET paid = paid - ?, status = CASE WHEN paid - ? <= 0 THEN 'unpaid' WHEN paid - ? < total THEN 'partial' ELSE status END WHERE id = ?`)
      .bind(a.amount, a.amount, a.amount, a.doc_id));
  }
  if (na.length) st.push(db.prepare(`DELETE FROM payment_allocs WHERE note_id = ?`).bind(doc.id));
  if (doc.gate_entry_id) st.push(db.prepare(`UPDATE gate_entries SET status = 'open', grn_id = NULL WHERE id = ? AND grn_id = ?`).bind(doc.gate_entry_id, doc.id));
  st.push(db.prepare(`UPDATE docs SET status = 'cancelled' WHERE id = ?`).bind(doc.id));
  st.push(auditStatement(ctx, `cancel ${doc.type}`, doc.number));
  await db.batch(st);
}

export async function voidPayment(ctx, id) {
  const { db } = ctx;
  requireCan(ctx.user, 'finance');
  const p = await db.prepare(`SELECT * FROM payments WHERE id = ? AND org_id = ?`).bind(id, ctx.org.id).first();
  if (!p) throw notFound('Payment not found.');
  if (p.notes && p.notes.startsWith('[void]')) throw bad('Already void.');
  const st = [];
  const { results: allocs } = await db.prepare(`SELECT * FROM payment_allocs WHERE payment_id = ?`).bind(p.id).all();
  for (const a of allocs) {
    st.push(db.prepare(`UPDATE docs SET paid = paid - ?, status = CASE WHEN paid - ? <= 0 THEN 'unpaid' WHEN paid - ? < total THEN 'partial' ELSE status END WHERE id = ?`)
      .bind(a.amount, a.amount, a.amount, a.doc_id));
  }
  st.push(db.prepare(`DELETE FROM payment_allocs WHERE payment_id = ?`).bind(p.id));
  const { results: jls } = await db.prepare(`SELECT jl.* FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
      WHERE j.org_id = ? AND j.ref_type = ? AND j.ref_id = ?`).bind(ctx.org.id, p.kind, p.id).all();
  st.push(...journalStatements(db, ctx, { date: p.date, narration: 'Void ' + p.number, refType: p.kind + '-X', refId: p.id,
    lines: jls.map((l) => ({ account: l.account_id, party: l.party_id, amount: l.credit - l.debit })) }));
  st.push(db.prepare(`UPDATE payments SET notes = '[void] ' || notes WHERE id = ?`).bind(p.id));
  st.push(auditStatement(ctx, `void ${p.kind}`, p.number));
  await db.batch(st);
}

/* ---------------------------------------------------------------- inventory operations */
export async function stockAdjust(ctx, body) {
  const { db } = ctx;
  requireCan(ctx.user, 'stock');
  const item = await db.prepare(`SELECT * FROM items WHERE id = ? AND org_id = ?`).bind(+body.item_id || 0, ctx.org.id).first();
  if (!item || item.is_service) throw bad('Choose a stocked item.');
  const wh = await warehouseOf(ctx, +body.warehouse_id || 0);
  const qty = roundQty(num(body.qty, 'Quantity', { min: -1e9, max: 1e9 }));
  if (!qty) throw bad('Quantity cannot be zero.');
  const d = date(body.date);
  const opening = body.reason === 'opening';
  const reason = opening ? 'Opening stock' : reqStr(body.reason, 'Reason', 80);
  const st = [];
  let value;
  if (qty > 0) {
    value = body.rate !== undefined && body.rate !== '' ? Math.round(qty * toPaise(num(body.rate, 'Rate', { min: 0 }))) : Math.round(qty * (item.avg_cost || item.purchase_price));
  } else {
    const have = await available(db, ctx.org.id, item.id, wh.id);
    if (have + 0.0005 < -qty) throw bad(`Only ${roundQty(have)} ${item.unit} of ${item.name} in ${wh.name}.`);
    value = Math.round(-qty * item.avg_cost);
  }
  const ref = { refType: opening ? 'OPEN' : 'ADJ', refId: null };
  st.push(...stockStatements(db, ctx, { item: item.id, warehouse: wh.id, qty, value, date: d, ...ref, note: reason }));
  const other = opening ? ctx.sys.opening : ctx.sys.stock_adj;
  st.push(...journalStatements(db, ctx, { date: d, narration: `${reason}: ${item.name} ${qty > 0 ? '+' : ''}${qty} ${item.unit}`, ...ref,
    lines: qty > 0 ? [D(ctx.sys.inventory, value), C(other, value)] : [D(other, value), C(ctx.sys.inventory, value)] }));
  st.push(auditStatement(ctx, 'stock adjust', `${item.name} ${qty}`));
  await db.batch(st);
  return { item_id: item.id, qty, value: value / 100 };
}

/* Physical stock count (cycle count): the counted quantity of many items in one godown, posted as one
   set of adjustments and one journal, so the books follow the shelf. Lines: [{ item_id, counted }]. */
export async function stockCount(ctx, body) {
  const { db } = ctx;
  requireCan(ctx.user, 'stock');
  const wh = await warehouseOf(ctx, +body.warehouse_id || 0);
  const lines = (Array.isArray(body.lines) ? body.lines : []).filter((l) => l && l.counted !== '' && l.counted !== null && l.counted !== undefined);
  if (!lines.length) throw bad('Enter the counted quantity for at least one item.');
  if (lines.length > 300) throw bad('Count at most 300 items at a time.');
  const d = date(body.date);
  const items = new Map((await loadByIds(db, `SELECT * FROM items WHERE org_id = ? AND is_service = 0 AND id IN (?ids)`, [ctx.org.id], lines.map((l) => +l.item_id))).map((i) => [i.id, i]));
  const have = await stockIn(db, ctx.org.id, wh.id, [...items.keys()]);
  const st = [], diffs = [];
  let gain = 0, loss = 0;
  for (const l of lines) {
    const it = items.get(+l.item_id);
    if (!it) throw bad('Unknown item in the count.');
    const counted = roundQty(num(l.counted, `${it.name} counted quantity`, { min: 0, max: 1e9 }));
    const diff = roundQty(counted - (have.get(it.id) || 0));
    if (Math.abs(diff) < 0.0005) continue;
    const value = Math.round(Math.abs(diff) * (it.avg_cost || it.purchase_price));
    st.push(...stockStatements(db, ctx, { item: it.id, warehouse: wh.id, qty: diff, value, date: d, refType: 'COUNT', refId: null, note: `Stock count ${wh.name}` }));
    if (diff > 0) gain += value; else loss += value;
    diffs.push({ item: it.name, system: have.get(it.id) || 0, counted, diff });
  }
  if (!diffs.length) return { ok: true, adjusted: 0, diffs };
  st.push(...journalStatements(db, ctx, { date: d, narration: `Stock count ${wh.name}: ${diffs.length} item(s) adjusted`, refType: 'COUNT', refId: null,
    lines: [D(ctx.sys.inventory, gain - loss), C(ctx.sys.stock_adj, gain - loss)] }));
  st.push(auditStatement(ctx, 'stock count', `${wh.name}: ${diffs.length} items, net ${(gain - loss) / 100}`));
  await db.batch(st);
  return { ok: true, adjusted: diffs.length, gain: gain / 100, loss: loss / 100, diffs };
}

export async function stockTransfer(ctx, body) {
  const { db } = ctx;
  requireCan(ctx.user, 'stock');
  const item = await db.prepare(`SELECT * FROM items WHERE id = ? AND org_id = ?`).bind(+body.item_id || 0, ctx.org.id).first();
  if (!item || item.is_service) throw bad('Choose a stocked item.');
  const from = await warehouseOf(ctx, +body.from_warehouse_id || -1);
  const to = await warehouseOf(ctx, +body.to_warehouse_id || -1);
  if (from.id === to.id) throw bad('Choose two different warehouses.');
  const qty = roundQty(num(body.qty, 'Quantity', { min: 0.001 }));
  const have = await available(db, ctx.org.id, item.id, from.id);
  if (have + 0.0005 < qty) throw bad(`Only ${roundQty(have)} ${item.unit} in ${from.name}.`);
  const d = date(body.date), value = Math.round(qty * item.avg_cost);
  const ref = { refType: 'XFER', refId: null };
  await db.batch([
    ...stockStatements(db, ctx, { item: item.id, warehouse: from.id, qty: -qty, value, date: d, ...ref, note: `To ${to.name}` }),
    ...stockStatements(db, ctx, { item: item.id, warehouse: to.id, qty, value, date: d, ...ref, note: `From ${from.name}` }),
    auditStatement(ctx, 'stock transfer', `${item.name} ${qty} ${from.name}->${to.name}`),
  ]);
  return { ok: true };
}

/* ---------------------------------------------------------------- finance vouchers */
export async function createExpense(ctx, body) {
  const { db } = ctx;
  requireCan(ctx.user, 'finance');
  const exp = await db.prepare(`SELECT * FROM accounts WHERE id = ? AND org_id = ? AND type = 'expense'`).bind(+body.account_id || 0, ctx.org.id).first();
  if (!exp) throw bad('Choose an expense account.');
  const from = await cashAccount(db, ctx.org.id, +body.paid_from);
  const amount = toPaise(num(body.amount, 'Amount', { min: 0.01 }));
  const gst = toPaise(num(body.gst_amount, 'GST', { min: 0, def: 0 }));
  const d = date(body.date);
  const narr = `${exp.name}${body.notes ? ': ' + str(body.notes, 200) : ''}`;
  await db.batch([
    ...journalStatements(db, ctx, { date: d, narration: narr, refType: 'EXP', refId: null,
      lines: [D(exp.id, amount), D(ctx.sys.gst_input, gst), C(from.id, amount + gst)] }),
    auditStatement(ctx, 'expense', narr),
  ]);
  return { ok: true };
}

/* Manual journal / contra / capital / drawings. lines: [{account_id, party_id?, debit, credit}] in rupees. */
export async function createJournal(ctx, body) {
  const { db } = ctx;
  requireCan(ctx.user, 'finance');
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (lines.length < 2) throw bad('A journal needs at least two lines.');
  if (lines.length > 200) throw bad('At most 200 lines per journal.');
  const { results: accts } = await db.prepare(`SELECT id FROM accounts WHERE org_id = ?`).bind(ctx.org.id).all();
  const ok = new Set(accts.map((a) => a.id));
  // a party id is global across businesses: accept only this business's own (never trust the id from the request)
  const askedParties = lines.map((l) => (l && l.party_id !== undefined && l.party_id !== null && l.party_id !== '' && l.party_id !== 0 ? Number(l.party_id) : null));
  const mine = new Set((await loadByIds(db, `SELECT id FROM parties WHERE org_id = ? AND id IN (?ids)`, [ctx.org.id], askedParties.filter((p) => Number.isInteger(p) && p > 0))).map((p) => p.id));
  const out = lines.map((l, i) => {
    if (!l || typeof l !== 'object') throw bad(`Line ${i + 1}: not a valid line.`);
    if (!ok.has(+l.account_id)) throw bad(`Line ${i + 1}: unknown account.`);
    if (askedParties[i] !== null && !mine.has(askedParties[i])) throw bad(`Line ${i + 1}: unknown party.`);
    const dr = toPaise(num(l.debit, 'Debit', { min: 0, def: 0 })), cr = toPaise(num(l.credit, 'Credit', { min: 0, def: 0 }));
    if (dr && cr) throw bad(`Line ${i + 1}: put an amount in debit or credit, not both.`);
    return { account: +l.account_id, party: askedParties[i], amount: dr - cr };
  });
  if (out.reduce((s, l) => s + l.amount, 0) !== 0) throw bad('Debits and credits must be equal.');
  const d = date(body.date);
  await db.batch([...journalStatements(db, ctx, { date: d, narration: reqStr(body.narration, 'Narration', 300), refType: 'JV', refId: null, lines: out }),
    auditStatement(ctx, 'journal', str(body.narration, 100))]);
  return { ok: true };
}

/* Party opening balance: positive = they owe us (receivable), negative = we owe them (payable). */
export async function partyOpening(ctx, partyId, body) {
  const { db } = ctx;
  requireCan(ctx.user, 'finance');
  const p = await db.prepare(`SELECT * FROM parties WHERE id = ? AND org_id = ?`).bind(partyId, ctx.org.id).first();
  if (!p) throw notFound('Party not found.');
  const amt = toPaise(num(body.amount, 'Amount'));
  if (!amt) throw bad('Amount cannot be zero.');
  const d = date(body.date);
  const lines = amt > 0 ? [D(ctx.sys.ar, amt, p.id), C(ctx.sys.opening, amt)] : [D(ctx.sys.opening, -amt), C(ctx.sys.ap, -amt, p.id)];
  await db.batch([...journalStatements(db, ctx, { date: d, narration: `Opening balance ${p.name}`, refType: 'OPEN', refId: null, lines }),
    auditStatement(ctx, 'party opening', `${p.name} ${amt / 100}`)]);
  return { ok: true };
}
