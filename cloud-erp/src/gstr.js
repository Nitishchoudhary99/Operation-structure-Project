/* GST returns from the books. Nothing is sent anywhere on its own: the GSTR-1 file is downloaded and uploaded on the GST
   portal (Returns → GSTR-1 → Prepare offline → Upload), and the GSTR-2B file the user downloads from the portal is
   matched here against the purchase bills. Read only: nothing in this file writes to the database.

   The GSTR-1 file uses the portal's own keys and grouping (the ones the GST offline tool writes): b2b by buyer GSTIN,
   b2cl by place of supply, b2cs one row per place of supply and rate, credit notes in cdnr / cdnur, 0% sales in nil,
   the HSN summary split into B2B and B2C (from May 2025), and the serial number ranges in doc_issue. Amounts in rupees
   with two decimals, dates as DD-MM-YYYY, places of supply as the two-digit state code. */
import { bad, today, addDays, str } from './lib.js';
import { stateCode, uqc } from './gst.js';

const R = (p) => Math.round(p) / 100;                   // paise -> rupees
const REG = /^\d{2}[A-Z0-9]{13}$/;
const up = (s) => String(s || '').toUpperCase().replace(/\s/g, '');
const dmy = (d) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
const q2 = (n) => Math.round(n * 100) / 100;
const rs = (p) => '₹' + R(p).toLocaleString('en-IN', { maximumFractionDigits: 2 });
/* inter-state sales to an unregistered buyer go invoice by invoice (B2C large) above ₹2.5 lakh, above ₹1 lakh from August 2024 */
const b2clLimit = (d) => (String(d || '') <= '2024-07-31' ? 250000 : 100000) * 100;

const prevMonth = () => { const t = today(); return new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 2, 1)).toISOString().slice(0, 7); };
/* The return period: a month (YYYY-MM), or the quarter ending in it for quarterly filers (QRMP) */
export function returnPeriod(q) {
  const month = str(q.get('month'), 7) || prevMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('Pick the month of the return.');
  const y = +month.slice(0, 4), m = +month.slice(5, 7), quarterly = q.get('quarterly') === '1';
  if (quarterly && m % 3) throw bad('A quarter ends in June, September, December or March: pick that month.');
  return { month, quarterly, from: new Date(Date.UTC(y, m - 1 - (quarterly ? 2 : 0), 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), fp: month.slice(5, 7) + month.slice(0, 4) };
}

/* ---------------------------------------------------------------- GSTR-1 */
export async function gstr1(db, org, q) {
  const p = returnPeriod(q), gstin = up(org.gstin), own = stateCode(org.state, gstin);
  const W = `d.org_id = ? AND d.type IN ('INV','SRET','CNOTE') AND d.date >= ? AND d.date <= ?`;
  const [docs, lines, inward, wo] = await db.batch([
    db.prepare(`SELECT d.id, d.type, d.number, d.date, d.status, d.place_of_supply, d.inter_state, d.total, p.name AS party, p.gstin,
        o.total AS ref_total, o.inter_state AS ref_inter, o.date AS ref_date
      FROM docs d LEFT JOIN parties p ON p.id = d.party_id LEFT JOIN docs o ON o.id = d.ref_id AND o.org_id = d.org_id
      WHERE ${W} ORDER BY d.date, d.id`).bind(org.id, p.from, p.to),
    db.prepare(`SELECT l.doc_id, l.qty, l.gst_rate, l.taxable, l.cgst, l.sgst, l.igst, l.description, i.hsn, i.unit, i.is_service, i.name AS item
      FROM doc_lines l JOIN docs d ON d.id = l.doc_id LEFT JOIN items i ON i.id = l.item_id
      WHERE ${W} AND d.status != 'cancelled'`).bind(org.id, p.from, p.to),
    // for the GSTR-3B figures: input tax on purchase bills, less returns and debit notes
    db.prepare(`SELECT d.type, SUM(d.taxable) AS taxable, SUM(d.cgst) AS cgst, SUM(d.sgst) AS sgst, SUM(d.igst) AS igst FROM docs d
      WHERE d.org_id = ? AND d.type IN ('BILL','PRET','DNOTE') AND d.status != 'cancelled' AND d.date >= ? AND d.date <= ? GROUP BY d.type`).bind(org.id, p.from, p.to),
    db.prepare(`SELECT COALESCE(SUM(cgst), 0) AS cgst, COALESCE(SUM(sgst), 0) AS sgst, COALESCE(SUM(igst), 0) AS igst
      FROM write_offs WHERE org_id = ? AND status = 'done' AND date >= ? AND date <= ?`).bind(org.id, p.from, p.to),
  ]);
  const byDoc = new Map();
  for (const l of lines.results) { if (!byDoc.has(l.doc_id)) byDoc.set(l.doc_id, []); byDoc.get(l.doc_id).push(l); }

  const b2b = new Map(), b2cl = new Map(), b2cs = new Map(), cdnr = new Map(), cdnur = [], nil = new Map(), hsn = { b2b: new Map(), b2c: new Map() };
  const noHsn = new Map(), shortHsn = new Set(), badGstin = new Set(), noPos = [], longNo = [];
  const add = (a, l, s) => { a.txval += s * l.taxable; a.iamt += s * l.igst; a.camt += s * l.cgst; a.samt += s * l.sgst; };
  const zero = () => ({ txval: 0, iamt: 0, camt: 0, samt: 0 });
  const det = (r, igstOnly) => (igstOnly ? { txval: R(r.txval), rt: r.rt, iamt: R(r.iamt), csamt: 0 }
    : { txval: R(r.txval), rt: r.rt, iamt: R(r.iamt), camt: R(r.camt), samt: R(r.samt), csamt: 0 });
  const itms = (rates, igstOnly) => rates.map((r, i) => ({ num: i + 1, itm_det: det(r, igstOnly) }));

  for (const d of docs.results) {
    if (d.status === 'cancelled') continue;
    const note = d.type !== 'INV', s = note ? -1 : 1, ctin = up(d.gstin), reg = REG.test(ctin), inter = !!d.inter_state;
    if (ctin && !reg) badGstin.add(d.party || '');
    const pos = inter ? stateCode(d.place_of_supply) || (reg ? ctin.slice(0, 2) : '') : own;
    if (!pos) noPos.push(d.number);
    if (!/^[A-Za-z0-9/-]{1,16}$/.test(d.number)) longNo.push(d.number);
    const rates = new Map();
    let nilAmt = 0;
    for (const l of byDoc.get(d.id) || []) {
      if (l.gst_rate) {
        if (!rates.has(l.gst_rate)) rates.set(l.gst_rate, { rt: l.gst_rate, ...zero() });
        add(rates.get(l.gst_rate), l, 1);
      } else nilAmt += l.taxable;
      // HSN summary (table 12): every line, returns and credit notes taken off; a rate-only credit note moves no quantity
      const code = String(l.hsn || '').replace(/\s/g, ''), svc = !!l.is_service || code.startsWith('99');
      if (!code) { const k = l.item || l.description || '(no name)'; noHsn.set(k, (noHsn.get(k) || 0) + 1); continue; }
      if (!/^\d{4,8}$/.test(code)) shortHsn.add(code);
      const uq = svc ? 'NA' : uqc(l.unit || ''), sec = hsn[reg ? 'b2b' : 'b2c'], k = `${code}|${uq}|${l.gst_rate}`;
      if (!sec.has(k)) sec.set(k, { hsn_sc: code, uqc: uq, rt: l.gst_rate, qty: 0, ...zero() });
      const h = sec.get(k);
      if (!svc && d.type !== 'CNOTE') h.qty += s * l.qty;
      add(h, l, s);
    }
    // 0% lines: nil-rated supplies (table 8), by inter / intra-state and registered or not
    if (nilAmt) { const k = (inter ? 'INTR' : 'INTRA') + (reg ? 'B2B' : 'B2C'); nil.set(k, (nil.get(k) || 0) + s * nilAmt); }
    if (!rates.size) continue;
    const list = [...rates.values()].sort((a, b) => a.rt - b.rt);
    const toB2cs = () => {
      for (const r of list) {
        const k = `${pos}|${r.rt}`;
        if (!b2cs.has(k)) b2cs.set(k, { sply_ty: pos === own ? 'INTRA' : 'INTER', pos, typ: 'OE', rt: r.rt, ...zero() });
        const a = b2cs.get(k);
        a.txval += s * r.txval; a.iamt += s * r.iamt; a.camt += s * r.camt; a.samt += s * r.samt;
      }
    };
    if (!note) {
      if (reg) {
        if (!b2b.has(ctin)) b2b.set(ctin, { ctin, inv: [] });
        b2b.get(ctin).inv.push({ inum: d.number, idt: dmy(d.date), val: R(d.total), pos, rchrg: 'N', inv_typ: 'R', itms: itms(list) });
      } else if (inter && d.total > b2clLimit(d.date)) {
        if (!b2cl.has(pos)) b2cl.set(pos, { pos, inv: [] });
        b2cl.get(pos).inv.push({ inum: d.number, idt: dmy(d.date), val: R(d.total), itms: itms(list, true) });
      } else toB2cs();
    } else if (reg) {
      if (!cdnr.has(ctin)) cdnr.set(ctin, { ctin, nt: [] });
      cdnr.get(ctin).nt.push({ ntty: 'C', nt_num: d.number, nt_dt: dmy(d.date), val: R(d.total), pos, rchrg: 'N', inv_typ: 'R', itms: itms(list) });
    } else if (inter && d.ref_inter && d.ref_total > b2clLimit(d.ref_date)) {
      // a credit note on a B2C large invoice is reported note by note; on a small one it nets off the B2C small rows
      cdnur.push({ typ: 'B2CL', ntty: 'C', nt_num: d.number, nt_dt: dmy(d.date), val: R(d.total), pos, itms: itms(list, true) });
    } else toB2cs();
  }

  // serial number ranges (table 13): invoices are kind 1, credit notes kind 5; cancelled ones count as issued and cancelled
  const ranges = new Map();
  for (const d of docs.results) {
    const nature = d.type === 'INV' ? 1 : 5, m = String(d.number).match(/^(.*?)(\d+)$/), k = `${nature}|${m ? m[1] : d.number}`;
    if (!ranges.has(k)) ranges.set(k, { nature, docs: [] });
    ranges.get(k).docs.push({ number: d.number, n: m ? +m[2] : 0, cancelled: d.status === 'cancelled' });
  }
  const docDet = [];
  for (const nature of [1, 5]) {
    const sets = [...ranges.values()].filter((r) => r.nature === nature);
    if (!sets.length) continue;
    docDet.push({ doc_num: nature, docs: sets.map((r, i) => {
      const s = r.docs.sort((a, b) => a.n - b.n), cancel = s.filter((x) => x.cancelled).length;
      return { num: i + 1, from: s[0].number, to: s[s.length - 1].number, totnum: s.length, cancel, net_issue: s.length - cancel };
    }) });
  }

  const money = (a) => ({ ...a, txval: R(a.txval), iamt: R(a.iamt), camt: R(a.camt), samt: R(a.samt) });
  const hsnRows = (m) => [...m.values()].filter((h) => h.txval || h.qty).sort((a, b) => a.hsn_sc.localeCompare(b.hsn_sc) || a.rt - b.rt)
    .map((h, i) => ({ num: i + 1, hsn_sc: h.hsn_sc, uqc: h.uqc, qty: q2(h.qty), rt: h.rt, txval: R(h.txval), iamt: R(h.iamt), camt: R(h.camt), samt: R(h.samt), csamt: 0 }));
  const json = { gstin, fp: p.fp };
  if (b2b.size) json.b2b = [...b2b.values()];
  if (b2cl.size) json.b2cl = [...b2cl.values()];
  const cs = [...b2cs.values()].filter((a) => a.txval || a.iamt || a.camt || a.samt).sort((a, b) => a.pos.localeCompare(b.pos) || a.rt - b.rt).map(money);
  if (cs.length) json.b2cs = cs.map((a) => ({ ...a, csamt: 0 }));
  if (cdnr.size) json.cdnr = [...cdnr.values()];
  if (cdnur.length) json.cdnur = cdnur;
  const nilRows = ['INTRB2B', 'INTRAB2B', 'INTRB2C', 'INTRAB2C'].filter((k) => nil.get(k)).map((k) => ({ sply_ty: k, nil_amt: R(nil.get(k)), expt_amt: 0, ngsup_amt: 0 }));
  if (nilRows.length) json.nil = { inv: nilRows };
  const hb = hsnRows(hsn.b2b), hc = hsnRows(hsn.b2c);
  if (hb.length || hc.length) json.hsn = { hsn_b2b: hb, hsn_b2c: hc };
  if (docDet.length) json.doc_issue = { doc_det: docDet };

  // what each table holds, for the screen; and the GSTR-3B figures from the same books
  const sum = (rows) => rows.reduce((t, r) => { for (const l of r.itms) { const x = l.itm_det; t.txval += x.txval; t.tax += x.iamt + (x.camt || 0) + (x.samt || 0); } t.val += r.val; t.n++; return t; },
    { n: 0, val: 0, txval: 0, tax: 0 });
  const tidy = (t) => ({ n: t.n, val: q2(t.val), txval: q2(t.txval), tax: q2(t.tax) });
  const tables = {
    b2b: tidy(sum((json.b2b || []).flatMap((g) => g.inv))), b2cl: tidy(sum((json.b2cl || []).flatMap((g) => g.inv))),
    b2cs: tidy(cs.reduce((t, a) => ({ n: t.n + 1, val: 0, txval: t.txval + a.txval, tax: t.tax + a.iamt + a.camt + a.samt }), { n: 0, val: 0, txval: 0, tax: 0 })),
    cdnr: tidy(sum((json.cdnr || []).flatMap((g) => g.nt))), cdnur: tidy(sum(cdnur)),
    nil: q2(nilRows.reduce((t, r) => t + r.nil_amt, 0)), hsn: hb.length + hc.length,
    docs: { issued: docs.results.length, cancelled: docs.results.filter((d) => d.status === 'cancelled').length },
  };
  const outTax = { txval: 0, iamt: 0, camt: 0, samt: 0 };
  for (const t of [...(json.b2b || []).flatMap((g) => g.inv), ...(json.b2cl || []).flatMap((g) => g.inv)]) for (const l of t.itms) for (const k of Object.keys(outTax)) outTax[k] += l.itm_det[k] || 0;
  for (const t of [...(json.cdnr || []).flatMap((g) => g.nt), ...cdnur]) for (const l of t.itms) for (const k of Object.keys(outTax)) outTax[k] -= l.itm_det[k] || 0;
  for (const a of cs) for (const k of Object.keys(outTax)) outTax[k] += a[k];
  const inp = { igst: 0, cgst: 0, sgst: 0 };
  for (const r of inward.results) for (const k of Object.keys(inp)) inp[k] += (r.type === 'BILL' ? 1 : -1) * (r[k] || 0);
  const rev = wo.results[0] || { igst: 0, cgst: 0, sgst: 0 };
  const unreg = new Map();
  for (const a of cs.filter((x) => x.sply_ty === 'INTER')) unreg.set(a.pos, (unreg.get(a.pos) || 0) + a.txval);
  for (const g of json.b2cl || []) for (const t of g.inv) for (const l of t.itms) unreg.set(g.pos, (unreg.get(g.pos) || 0) + l.itm_det.txval);
  for (const t of cdnur) for (const l of t.itms) unreg.set(t.pos, (unreg.get(t.pos) || 0) - l.itm_det.txval);
  const b3 = {
    outward: { txval: q2(outTax.txval), igst: q2(outTax.iamt), cgst: q2(outTax.camt), sgst: q2(outTax.samt) }, nil: tables.nil,
    unregistered_inter: [...unreg].filter(([, v]) => Math.abs(v) >= 0.005).map(([pos, txval]) => ({ pos, txval: q2(txval) })),
    itc: { igst: R(inp.igst), cgst: R(inp.cgst), sgst: R(inp.sgst) }, reversed: { igst: R(rev.igst), cgst: R(rev.cgst), sgst: R(rev.sgst) },
  };
  b3.payable = q2(b3.outward.igst + b3.outward.cgst + b3.outward.sgst - (b3.itc.igst + b3.itc.cgst + b3.itc.sgst) + b3.reversed.igst + b3.reversed.cgst + b3.reversed.sgst);

  const problems = [];
  if (!REG.test(gstin)) problems.push({ stop: true, text: 'Your GSTIN is missing or wrong (Settings → Business). The file needs it.' });
  if (noHsn.size) problems.push({ text: `${[...noHsn.values()].reduce((a, b) => a + b, 0)} bill line(s) have no HSN code, so they are left out of the HSN summary: `
    + [...noHsn.keys()].slice(0, 8).join(', ') + (noHsn.size > 8 ? '…' : '') + '. Add the HSN on the item and download again.' });
  if (shortHsn.size) problems.push({ text: `HSN codes need 4 to 8 digits (6 when your turnover is above ₹5 crore): ${[...shortHsn].slice(0, 8).join(', ')}.` });
  if (badGstin.size) problems.push({ text: `These customers have a GSTIN in the wrong format, so their bills went in as B2C: ${[...badGstin].slice(0, 8).join(', ')}.` });
  if (noPos.length) problems.push({ text: `No state on these inter-state bills (add the customer's state): ${noPos.slice(0, 8).join(', ')}.` });
  if (longNo.length) problems.push({ text: `The portal takes bill numbers of up to 16 letters, digits, / and -: ${longNo.slice(0, 8).join(', ')}.` });
  return { ...p, gstin, json, tables, b3, problems };
}

/* The same return as a readable workbook for the accountant */
export function gstr1Sheets(g) {
  const M = (h, w) => ({ h, money: 1, w }), T = (h, w) => ({ h, w });
  const inv = (rows, igstOnly) => rows.flatMap((x) => x.itms.map((l) => [l.itm_det.rt, l.itm_det.txval, l.itm_det.iamt, ...(igstOnly ? [] : [l.itm_det.camt, l.itm_det.samt])]));
  const j = g.json, taxCols = [{ h: 'Rate %', num: 1, w: 8 }, M('Taxable value'), M('IGST'), M('CGST'), M('SGST')];
  const hsnSheet = (name, rows) => ({ name, cols: [T('HSN', 12), T('UQC', 8), { h: 'Quantity', num: 1, w: 10 }, { h: 'Rate %', num: 1, w: 8 }, M('Taxable value'), M('IGST'), M('CGST'), M('SGST')],
    rows: rows.map((h) => [h.hsn_sc, h.uqc, h.qty, h.rt, h.txval, h.iamt, h.camt, h.samt]) });
  return [
    { name: 'B2B', cols: [T('Buyer GSTIN', 18), T('Invoice no.', 16), T('Date', 12), M('Invoice value'), T('Place of supply', 8), ...taxCols],
      rows: (j.b2b || []).flatMap((b) => b.inv.flatMap((t) => inv([t]).map((l) => [b.ctin, t.inum, t.idt, t.val, t.pos, ...l]))) },
    { name: 'B2C large', cols: [T('Invoice no.', 16), T('Date', 12), M('Invoice value'), T('Place of supply', 8), { h: 'Rate %', num: 1, w: 8 }, M('Taxable value'), M('IGST')],
      rows: (j.b2cl || []).flatMap((b) => b.inv.flatMap((t) => inv([t], true).map((l) => [t.inum, t.idt, t.val, b.pos, ...l]))) },
    { name: 'B2C small', cols: [T('Supply', 8), T('Place of supply', 8), ...taxCols], rows: (j.b2cs || []).map((a) => [a.sply_ty, a.pos, a.rt, a.txval, a.iamt, a.camt, a.samt]) },
    { name: 'Credit notes', cols: [T('Buyer GSTIN', 18), T('Note no.', 16), T('Date', 12), M('Note value'), T('Place of supply', 8), ...taxCols],
      rows: [...(j.cdnr || []).flatMap((b) => b.nt.flatMap((t) => inv([t]).map((l) => [b.ctin, t.nt_num, t.nt_dt, t.val, t.pos, ...l]))),
        ...(j.cdnur || []).flatMap((t) => inv([t], true).map((l) => ['Unregistered (B2C large)', t.nt_num, t.nt_dt, t.val, t.pos, ...l]))] },
    { name: 'Nil rated', cols: [T('Supply', 12), M('Nil rated')], rows: ((j.nil || {}).inv || []).map((r) => [r.sply_ty, r.nil_amt]) },
    hsnSheet('HSN B2B', (j.hsn || {}).hsn_b2b || []), hsnSheet('HSN B2C', (j.hsn || {}).hsn_b2c || []),
    { name: 'Documents', cols: [T('Kind', 16), T('From', 16), T('To', 16), { h: 'Total', num: 1, w: 8 }, { h: 'Cancelled', num: 1, w: 10 }, { h: 'Net issued', num: 1, w: 10 }],
      rows: ((j.doc_issue || {}).doc_det || []).flatMap((k) => k.docs.map((x) => [k.doc_num === 1 ? 'Invoices' : 'Credit notes', x.from, x.to, x.totnum, x.cancel, x.net_issue])) },
    { name: 'GSTR-3B', cols: [T('Table', 34), M('Taxable value'), M('IGST'), M('CGST'), M('SGST')], rows: [
      ['3.1(a) Outward taxable supplies', g.b3.outward.txval, g.b3.outward.igst, g.b3.outward.cgst, g.b3.outward.sgst],
      ['3.1(c) Nil rated', g.b3.nil, '', '', ''],
      ...g.b3.unregistered_inter.map((u) => [`3.2 To unregistered, state ${u.pos}`, u.txval, '', '', '']),
      ['4(A)(5) Input tax credit (purchase bills)', '', g.b3.itc.igst, g.b3.itc.cgst, g.b3.itc.sgst],
      ['4(B)(2) Credit reversed (goods lost)', '', g.b3.reversed.igst, g.b3.reversed.cgst, g.b3.reversed.sgst]] },
  ];
}

/* ---------------------------------------------------------------- GSTR-2B against the purchase bills */
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const P = (v) => Math.round(num(v) * 100);
/* a bill number in one spelling: capitals and digits only, no leading zeros in a run of digits ("inv/0012" = "INV12") */
const key = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/\d+/g, (m) => m.replace(/^0+(?=\d)/, ''));
const tail = (s) => { const m = String(s || '').match(/(\d+)\D*$/); return m ? m[1].replace(/^0+(?=\d)/, '') : ''; };
const days = (a, b) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) / 864e5 : 999);

function clean2b(r) {
  const d = String(r.date || '');
  return { kind: r.kind === 'cn' || r.kind === 'dn' ? r.kind : 'inv', gstin: up(r.gstin).slice(0, 15), name: str(r.name, 120), num: str(r.num, 40),
    date: /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '', val: P(r.val), txval: P(r.txval), igst: P(r.igst), cgst: P(r.cgst), sgst: P(r.sgst), cess: P(r.cess),
    itc: r.itc !== false, rcm: r.rcm === true, rsn: str(r.rsn, 120) };
}

/* body: { month: 'YYYY-MM' (the 2B's period), rows: the 2B as the app read it from the portal's file, amounts in rupees } */
export async function match2b(db, org, body) {
  const p = returnPeriod(new URLSearchParams({ month: String(body.month || '') }));
  const raw = Array.isArray(body.rows) ? body.rows : [];
  if (!raw.length) throw bad('No supplier bills found in this file. Pick the GSTR-2B file (JSON or Excel) from the GST portal.');
  if (raw.length > 20000) throw bad('At most 20,000 documents at a time.');
  const b2 = raw.map(clean2b).filter((r) => REG.test(r.gstin));
  // the bills of the year before as well: a supplier may file a bill of an earlier month late
  const [bills, parties] = await db.batch([
    db.prepare(`SELECT d.id, d.type, d.number, d.party_ref, d.date, d.taxable, d.cgst, d.sgst, d.igst, d.total, p.id AS party_id, p.name AS party, p.gstin, p.phone
      FROM docs d JOIN parties p ON p.id = d.party_id
      WHERE d.org_id = ? AND d.type IN ('BILL','PRET','DNOTE') AND d.status != 'cancelled' AND d.date >= ? AND d.date <= ? ORDER BY d.date, d.id`)
      .bind(org.id, addDays(p.from, -400), addDays(p.to, 62)),
    db.prepare(`SELECT id, name, phone, gstin FROM parties WHERE org_id = ? AND gstin != ''`).bind(org.id),
  ]);
  const byGstin = new Map(parties.results.map((x) => [up(x.gstin), x]));
  const books = bills.results.filter((b) => REG.test(up(b.gstin))).map((b) => ({ ...b, gstin: up(b.gstin), side: b.type === 'BILL' ? 'inv' : 'cn',
    k: key(b.party_ref), t: tail(b.party_ref), tax: b.cgst + b.sgst + b.igst, used: false }));
  const pool = new Map();
  for (const b of books) { const g = `${b.gstin}|${b.side}`; if (!pool.has(g)) pool.set(g, []); pool.get(g).push(b); }
  const close = (a, b) => Math.abs(a - b) <= 100;          // within a rupee
  const tax2b = (r) => r.igst + r.cgst + r.sgst;
  const pairs = [], left = [];
  // a supplier's debit note adds to a bill, so it is looked for among the bills; its credit note among your returns and debit notes
  for (const r of b2) {
    const list = (pool.get(`${r.gstin}|${r.kind === 'cn' ? 'cn' : 'inv'}`) || []).filter((b) => !b.used);
    const k = key(r.num), t = tail(r.num);
    let hit = k && list.find((b) => b.k === k), how = 'number';
    if (!hit && t) { const c = list.filter((b) => b.t === t && days(b.date, r.date) <= 60); if (c.length === 1) [hit] = c; }
    if (!hit) { hit = list.find((b) => close(b.taxable, r.txval) && close(b.tax, tax2b(r)) && days(b.date, r.date) <= 10); how = 'amount'; }
    if (hit) { hit.used = true; pairs.push({ r, b: hit, how }); } else left.push(r);
  }
  const side2b = (r) => ({ num: r.num, date: r.date, val: R(r.val), taxable: R(r.txval), igst: R(r.igst), cgst: R(r.cgst), sgst: R(r.sgst), cess: R(r.cess),
    tax: R(tax2b(r) + r.cess), itc: r.itc, rcm: r.rcm, rsn: r.rsn, kind: r.kind });
  const sideBook = (b) => ({ id: b.id, type: b.type, number: b.number, party_ref: b.party_ref || '', date: b.date, total: R(b.total), taxable: R(b.taxable),
    igst: R(b.igst), cgst: R(b.cgst), sgst: R(b.sgst), tax: R(b.tax) });
  const who = (gstin, name) => { const x = byGstin.get(gstin); return { supplier: (x && x.name) || name || gstin, party_id: x ? x.id : null, phone: x ? x.phone || '' : '' }; };
  const rows = [];
  for (const { r, b, how } of pairs) {
    const diffs = [];
    if (!close(b.taxable, r.txval)) diffs.push(`taxable value ${rs(r.txval)} in 2B, ${rs(b.taxable)} in your bill`);
    if ((r.igst > 0) !== (b.igst > 0) && tax2b(r) && b.tax) diffs.push(r.igst ? 'IGST in 2B, CGST + SGST in your bill' : 'CGST + SGST in 2B, IGST in your bill');
    else if (!close(b.tax, tax2b(r))) diffs.push(`tax ${rs(tax2b(r))} in 2B, ${rs(b.tax)} in your bill`);
    const status = diffs.length ? 'diff' : how === 'amount' && key(b.party_ref) !== key(r.num) ? 'number' : 'ok';
    rows.push({ status, gstin: r.gstin, ...who(r.gstin, r.name), b2b: side2b(r), book: sideBook(b),
      note: diffs.length ? diffs.join('; ') : status === 'number' ? (b.party_ref ? `Supplier's number is ${r.num}; your bill says ${b.party_ref}.` : `Put the supplier's bill number ${r.num} on your bill.`) : '' });
  }
  for (const r of left) rows.push({ status: 'missing_books', gstin: r.gstin, ...who(r.gstin, r.name), b2b: side2b(r), book: null,
    note: byGstin.has(r.gstin) ? 'Not in your purchase bills: enter it, or ask the supplier if it is not yours.' : 'A supplier you do not have yet: add them and enter the bill, or ask about it.' });
  for (const b of books.filter((x) => !x.used && x.date >= p.from && x.date <= p.to && x.tax)) {
    rows.push({ status: 'missing_2b', gstin: b.gstin, supplier: b.party, party_id: b.party_id, phone: b.phone || '', b2b: null, book: sideBook(b),
      note: 'Not in your GSTR-2B: the supplier has not filed it yet, so you cannot take this credit. Remind them.' });
  }
  const ORDER = { diff: 0, missing_books: 1, missing_2b: 2, number: 3, ok: 4 };
  rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.supplier.localeCompare(b.supplier));
  const sgn = (r) => (r.b2b ? (r.b2b.kind === 'cn' ? -1 : 1) : r.book && r.book.type !== 'BILL' ? -1 : 1);
  const tot = (st, side) => { const xs = rows.filter((r) => st.includes(r.status) && r[side]); return { n: xs.length, tax: q2(xs.reduce((t, r) => t + sgn(r) * r[side].tax, 0)) }; };
  const inPeriod = books.filter((b) => b.date >= p.from && b.date <= p.to);
  return { ...p, rows, summary: {
    in_2b: { n: b2.length, tax: q2(b2.reduce((t, r) => t + (r.itc ? (r.kind === 'cn' ? -1 : 1) * R(tax2b(r) + r.cess) : 0), 0)) },
    books: { n: inPeriod.length, tax: q2(inPeriod.reduce((t, b) => t + (b.side === 'cn' ? -1 : 1) * R(b.tax), 0)) },
    ok: tot(['ok', 'number'], 'b2b'), diff: tot(['diff'], 'b2b'), missing_books: tot(['missing_books'], 'b2b'), missing_2b: tot(['missing_2b'], 'book'),
    no_itc: { n: b2.filter((r) => !r.itc).length }, skipped: raw.length - b2.length,
  } };
}
