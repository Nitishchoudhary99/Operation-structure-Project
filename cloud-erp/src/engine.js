/* Posting engine: trading documents, stock and the double-entry ledger.
   Every write for one business action (document + lines + stock + journal + links) goes into ONE
   D1 batch, which runs as a single transaction: it all happens or none of it does.
   Rows created inside a batch are found again through their unique `txk` key. */
import {
  bad, notFound, str, reqStr, num, date, addDays, nowIso, uid, lineCalc, toPaise, roundQty,
  counterStatements, counterValueSql,
} from './lib.js';
import { requireCan } from './auth.js';

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
};

/* ---------------------------------------------------------------- context */
export async function loadSys(db, orgId) {
  const { results } = await db.prepare(`SELECT id, sys FROM accounts WHERE org_id = ? AND sys IS NOT NULL`).bind(orgId).all();
  const sys = {};
  for (const r of results) sys[r.sys] = r.id;
  return sys;
}

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
    out.push(db.prepare(`INSERT INTO journal_lines (journal_id, org_id, account_id, party_id, debit, credit, date)
                         VALUES ((SELECT id FROM journals WHERE txk = ?), ?, ?, ?, ?, ?, ?)`)
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

async function warehouseOf(db, orgId, id) {
  if (id) {
    const w = await db.prepare(`SELECT id, name FROM warehouses WHERE id = ? AND org_id = ?`).bind(id, orgId).first();
    if (!w) throw bad('Unknown warehouse.');
    return w;
  }
  const w = await db.prepare(`SELECT id, name FROM warehouses WHERE org_id = ? ORDER BY id LIMIT 1`).bind(orgId).first();
  if (!w) throw bad('Create a warehouse first.');
  return w;
}

/* Signed amount: positive -> debit, negative -> credit. */
const D = (account, amount, party) => ({ account, amount, party });
const C = (account, amount, party) => ({ account, amount: -amount, party });

export function moneyStatus(total, paid) { return paid <= 0 ? 'unpaid' : paid >= total ? 'paid' : 'partial'; }

/* ---------------------------------------------------------------- documents */
export async function createDoc(ctx, body) {
  const { db } = ctx;
  const type = str(body.type, 10).toUpperCase();
  const T = DOC_TYPES[type];
  if (!T) throw bad('Unknown document type.');
  requireCan(ctx.user, T.side === 'sales' ? 'sales' : 'purchase');
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
    if (!T.from.includes(src.type)) throw bad(`A ${T.label} cannot be made from a ${DOC_TYPES[src.type].label}.`);
    if (src.status === 'cancelled') throw bad('The source document is cancelled.');
    if (src.party_id !== party.id) throw bad('The source document belongs to another party.');
    const { results } = await db.prepare(`SELECT * FROM doc_lines WHERE doc_id = ?`).bind(src.id).all();
    for (const l of results) srcLines.set(l.id, l);
  } else if (T.needsRef) {
    throw bad(`A ${T.label} must be made from the original ${type === 'SRET' ? 'invoice' : 'bill'}.`);
  }

  const wh = await warehouseOf(db, orgId, +body.warehouse_id || (src && src.warehouse_id) || 0);
  const inter = !!(party.state && ctx.org.state && party.state.toLowerCase() !== ctx.org.state.toLowerCase());
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw bad('Add at least one line.');
  if (lines.length > 200) throw bad('At most 200 lines per document.');

  // stock movement happens here unless an earlier document already moved the goods
  const moves = T.stock && !(type === 'INV' && src && src.type === 'DN') && !(type === 'BILL' && src && src.type === 'GRN');
  const itemCache = new Map();
  const getItem = async (id) => {
    if (!itemCache.has(id)) itemCache.set(id, await db.prepare(`SELECT * FROM items WHERE id = ? AND org_id = ?`).bind(id, orgId).first());
    return itemCache.get(id);
  };

  const L = [];
  const need = new Map();   // item -> qty leaving the warehouse
  for (const [i, raw] of lines.entries()) {
    const n = i + 1;
    const item = raw.item_id ? await getItem(+raw.item_id) : null;
    if (raw.item_id && !item) throw bad(`Line ${n}: unknown item.`);
    const qty = roundQty(num(raw.qty, `Line ${n} quantity`, { min: 0.001, max: 1e9 }));
    const fallbackRate = item ? (T.side === 'sales' ? item.sale_price : item.purchase_price) : 0;
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

  // stock must be available for anything leaving the warehouse
  for (const [itemId, q] of need) {
    const have = await available(db, orgId, itemId, wh.id);
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

  st.push(counterStatements(db, orgId, type));
  st.push(db.prepare(`INSERT INTO docs (org_id, type, number, party_id, date, due_date, warehouse_id, ref_id, status, place_of_supply,
        inter_state, taxable, cgst, sgst, igst, round_off, total, paid, notes, created_by, created_at, txk)
      VALUES (?, ?, ${counterValueSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
    .bind(orgId, type, T.prefix, orgId, type, party.id, d, dueDate, wh.id, src ? src.id : null, initialStatus,
      party.state || ctx.org.state || '', inter ? 1 : 0, taxable, cgst, sgst, igst, roundOff, total,
      str(body.notes, 1000), ctx.user.id, nowIso(), txk));

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
    case 'PRET':
      jl = [D(sys.ap, total, P), C(sys.inventory, costOut), C(sys.misc_exp || sys.cogs, -serviceCost), C(sys.gst_input, tax), C(sys.round_off, roundOff)];
      break;
  }
  if (jl.length) st.push(...journalStatements(db, ctx, { date: d, narration: narr, ...ref, lines: jl }));

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
  if (['SRET', 'PRET'].includes(type)) {
    const outstanding = Math.max(0, src.total - src.paid);
    const apply = Math.min(outstanding, total);
    if (apply > 0) {
      st.push(db.prepare(`INSERT INTO payment_allocs (payment_id, doc_id, amount, note_id) VALUES (0, ?, ?, (SELECT id FROM docs WHERE txk = ?))`).bind(src.id, apply, txk));
      st.push(db.prepare(`UPDATE docs SET paid = paid + ?, status = CASE WHEN paid + ? >= total THEN 'paid' ELSE 'partial' END WHERE id = ?`).bind(apply, apply, src.id));
    }
    st.push(db.prepare(`UPDATE docs SET status = 'closed', paid = ? WHERE txk = ?`).bind(total, txk));
  }

  // cash sale / cash purchase: settle immediately
  if (['INV', 'BILL'].includes(type) && body.payment && +body.payment.amount > 0) {
    const acct = await cashAccount(db, orgId, +body.payment.account_id);
    const amt = Math.min(toPaise(body.payment.amount), total);
    st.push(...paymentStatements(ctx, {
      kind: type === 'INV' ? 'receipt' : 'payment', party, account: acct.id, date: d, amount: amt,
      reference: str(body.payment.reference, 80), allocs: [{ txk, amount: amt, total }],
    }));
  }

  st.push(auditStatement(ctx, `create ${type}`, `${party.name} ${total / 100}`));
  await db.batch(st);
  return db.prepare(`SELECT * FROM docs WHERE txk = ?`).bind(txk).first();
}

export const auditStatement = (ctx, action, detail = '') =>
  ctx.db.prepare(`INSERT INTO audit (org_id, user_id, at, action, detail) VALUES (?, ?, ?, ?, ?)`)
    .bind(ctx.org.id, ctx.user.id, nowIso(), action, String(detail).slice(0, 300));

/* ---------------------------------------------------------------- payments */
/* allocs: [{ doc_id | txk, amount, total }]  */
export function paymentStatements(ctx, { kind, party, account, date: d, amount, reference = '', notes = '', allocs = [] }) {
  const { db } = ctx, sys = ctx.sys;
  const ptxk = uid();
  const st = [counterStatements(db, ctx.org.id, kind),
    db.prepare(`INSERT INTO payments (org_id, number, kind, party_id, account_id, date, amount, reference, notes, created_by, created_at, txk)
                VALUES (?, ${counterValueSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(ctx.org.id, kind === 'receipt' ? 'RCT' : 'PAY', ctx.org.id, kind, kind, party.id, account, d, amount, reference, notes, ctx.user.id, nowIso(), ptxk)];
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
  const child = await db.prepare(`SELECT number FROM docs WHERE ref_id = ? AND status != 'cancelled' LIMIT 1`).bind(doc.id).first();
  if (child) throw bad(`Cancel ${child.number} first: it was made from this document.`);
  const pay = await db.prepare(`SELECT 1 FROM payment_allocs WHERE doc_id = ? AND payment_id > 0 LIMIT 1`).bind(doc.id).first();
  if (pay) throw bad('Void the payments against this document first.');

  const st = [];
  const { results: moves } = await db.prepare(`SELECT * FROM stock_moves WHERE org_id = ? AND ref_type = ? AND ref_id = ?`).bind(ctx.org.id, doc.type, doc.id).all();
  for (const m of moves) {
    if (m.qty > 0) {
      const have = await available(db, ctx.org.id, m.item_id, m.warehouse_id);
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
  const wh = await warehouseOf(db, ctx.org.id, +body.warehouse_id || 0);
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

export async function stockTransfer(ctx, body) {
  const { db } = ctx;
  requireCan(ctx.user, 'stock');
  const item = await db.prepare(`SELECT * FROM items WHERE id = ? AND org_id = ?`).bind(+body.item_id || 0, ctx.org.id).first();
  if (!item || item.is_service) throw bad('Choose a stocked item.');
  const from = await warehouseOf(db, ctx.org.id, +body.from_warehouse_id || -1);
  const to = await warehouseOf(db, ctx.org.id, +body.to_warehouse_id || -1);
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
  const { results: accts } = await db.prepare(`SELECT id FROM accounts WHERE org_id = ?`).bind(ctx.org.id).all();
  const ok = new Set(accts.map((a) => a.id));
  const out = lines.map((l, i) => {
    if (!ok.has(+l.account_id)) throw bad(`Line ${i + 1}: unknown account.`);
    const dr = toPaise(num(l.debit, 'Debit', { min: 0, def: 0 })), cr = toPaise(num(l.credit, 'Credit', { min: 0, def: 0 }));
    if (dr && cr) throw bad(`Line ${i + 1}: put an amount in debit or credit, not both.`);
    return { account: +l.account_id, party: +l.party_id || null, amount: dr - cr };
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
