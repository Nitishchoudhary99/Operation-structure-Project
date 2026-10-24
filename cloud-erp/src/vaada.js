/* Vaada Pakka (payment promises) and Kal ka Cash (4-week cash outlook).
   The customer picks a pay date or an instalment plan on their own khata/invoice link; every instalment is marked
   kept or broken from the receipts (never by hand), and the shop is warned before giving more udhaar.
   Everything here is deterministic: integer paise, 'YYYY-MM-DD' date strings (IST from lib.today()), no clock,
   no randomness. It imports only lib.js so test/run.mjs can import it directly. The *Statements helpers only
   build D1 statements from the db handle they are given. */
import { bad, addDays } from './lib.js';

export const VAADA_DEFAULTS = { on: true, max_days: 15, part: true, min_part_pct: 25, plans: ['4w'], min_kisht: 500,
  grace: 1, credit_check: 'warn', overdue_days: 30, broken_max: 2 };
export const PLAN_TYPES = { '2f': { n: 2, every: 15, label: '2 kisht · har 15 din' }, '4w': { n: 4, every: 7, label: '4 kisht · har hafte' },
  '3m': { n: 3, every: 30, label: '3 kisht · har mahine' }, '6w': { n: 6, every: 7, label: '6 kisht · har hafte' },
  '6m': { n: 6, every: 30, label: '6 kisht · har mahine' } };
/* a party's khata balance (sent entries only), for `FROM khata k` */
export const KHATA_BAL = `COALESCE(SUM(CASE WHEN k.status = 'sent' THEN (CASE WHEN k.kind = 'gave' THEN k.amount ELSE -k.amount END) ELSE 0 END), 0)`;
export const FREE_OPEN_MAX = 10;

export const inrW = (p) => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const inr0 = (p) => '₹' + Math.round(p / 100).toLocaleString('en-IN');
export const fd = (d) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');
export const days = (d) => Math.round(Date.parse(d + 'T00:00:00Z') / 864e5);
const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/* orgs.vaada JSON -> settings with every key present and in range; unknown keys dropped */
export function cleanVaada(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v || '{}'); } catch (e) { v = {}; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) v = {};
  const D = VAADA_DEFAULTS;
  const n = (x, lo, hi, d) => { if (x === undefined || x === null || x === '') return d; const k = Math.round(Number(x)); return Number.isFinite(k) ? Math.min(hi, Math.max(lo, k)) : d; };
  const b = (x, d) => (x === undefined || x === null ? d : x === true || x === 1 || x === '1' || x === 'true' || x === 'on');
  return {
    on: b(v.on, D.on), max_days: n(v.max_days, 1, 60, D.max_days), part: b(v.part, D.part), min_part_pct: n(v.min_part_pct, 10, 100, D.min_part_pct),
    plans: Array.isArray(v.plans) ? [...new Set(v.plans.filter((k) => Object.prototype.hasOwnProperty.call(PLAN_TYPES, k)))] : D.plans.slice(),
    min_kisht: n(v.min_kisht, 1, 1e7, D.min_kisht), grace: n(v.grace, 0, 3, D.grace),
    credit_check: ['off', 'warn', 'stop'].includes(v.credit_check) ? v.credit_check : D.credit_check,
    overdue_days: n(v.overdue_days, 0, 180, D.overdue_days), broken_max: n(v.broken_max, 1, 10, D.broken_max),
  };
}

/* smallest part-payment promise (paise): min_part_pct of the due in whole rupees, at least ₹100, never above the due */
export const minPart = (due, s) => Math.min(due, Math.max(10000, Math.ceil(due * s.min_part_pct / 10000) * 100));

/* §6.1 instalments in whole rupees; the last one absorbs the remainder so the sum is exact */
export function splitPlan(amountPaise, planKey, today, minKishtRs) {
  const P = Object.prototype.hasOwnProperty.call(PLAN_TYPES, planKey) ? PLAN_TYPES[planKey] : null;
  if (!P) throw bad('Plan sahi nahi hai.');
  const unit = Math.floor(amountPaise / (P.n * 100)) * 100;
  if (unit < minKishtRs * 100 || unit <= 0) throw bad(`Har kisht kam se kam ₹${minKishtRs} honi chahiye.`);
  const out = [];
  for (let i = 1; i <= P.n; i++) out.push({ n: i, d: addDays(today, P.every * i), a: i < P.n ? unit : amountPaise - unit * (P.n - 1) });
  return out;
}

/* Instalment options a customer may pick for this due (only plans that split cleanly) */
export function planOptions(due, s, today) {
  const out = [];
  for (const key of s.plans) {
    try {
      const k = splitPlan(due, key, today, s.min_kisht);
      out.push({ key, label: PLAN_TYPES[key].label, amounts: k.map((x) => x.a / 100), first: k[0].d, last: k[k.length - 1].d });
    } catch (e) { /* too small for this plan */ }
  }
  return out;
}

/* §6.2 kept / broken for each instalment, from the receipts of this party in this book.
   receipts: [{ date, amount }] with made_on <= date <= today, sorted by (date, id). invDueNow: open INV balance (book inv) or null.
   Money pays the earliest instalment first; a pure function of (plan, receipts, today), so re-running gives the same answer. */
export function evaluate(promise, kisht, receipts, today, grace = 1, invDueNow = null) {
  let need = 0, i = 0, cum = 0;
  const res = [], total = receipts.reduce((s, r) => s + r.amount, 0);
  for (const k of kisht) {
    need += k.amount;
    while (i < receipts.length && cum < need) cum += receipts[i++].amount;
    let reached = cum >= need && i > 0 ? receipts[i - 1].date : null;      // first date the running total covered this instalment
    if (reached === null && invDueNow !== null && invDueNow <= 0) reached = k.outcome === 'kept' && k.settled_on ? k.settled_on : today;   // nothing left to pay (credit note / return)
    const deadline = addDays(k.due, grace);
    const outcome = reached && reached <= deadline ? 'kept' : today > deadline ? 'broken' : null;
    res.push({ id: k.id, n: k.n, due: k.due, amount: k.amount, outcome, settled_on: outcome === 'kept' ? reached : outcome === 'broken' ? deadline : null,
      state: outcome || (today >= k.due ? 'due' : 'upcoming') });
  }
  const lastDeadline = kisht.length ? addDays(kisht[kisht.length - 1].due, grace) : today;
  // after the last deadline every outcome is final; a promise paid in full is done at once
  const done = promise.status === 'open' && (today > lastDeadline || (res.length > 0 && res.every((r) => r.outcome === 'kept')));
  return { res, done, paid_since: Math.min(total, promise.amount) };
}

/* §6.3 credit check before more udhaar. input: { party: { name, credit_limit }, due, oldest, khata, n, pendingBroken: [{ due }],
   kept, broken, newCredit, today } (paise). Thresholds come from the settings. */
export function risk(input, s) {
  const { party, due = 0, oldest = null, khata = 0, n = 0, pendingBroken = [], kept = 0, broken = 0, newCredit = 0, today } = input;
  const reasons = [];
  const overdueDays = oldest && oldest < today ? days(today) - days(oldest) : 0;
  if (party.credit_limit > 0 && due + Math.max(0, khata) + newCredit > party.credit_limit) reasons.push(`limit ${inrW(party.credit_limit)} paar`);
  if (due > 0 && overdueDays >= s.overdue_days) reasons.push(`${inrW(due)} baaki ${overdueDays} din se`);
  const broken90 = n + pendingBroken.length;
  if (broken90 >= s.broken_max) reasons.push(`${broken90} vaade toote`);
  else if (pendingBroken.length) reasons.push(`${fd(pendingBroken[0].due)} ka vaada toota`);
  return { risky: reasons.length > 0, reasons, text: `${party.name}: ${reasons.join(', ')}. Phir bhi udhaar?`,
    kept_pct: kept + broken ? Math.round(100 * kept / (kept + broken)) : null, broken90 };
}
/* the one read batch behind risk(): 5 party-indexed statements */
export function riskStatements(db, orgId, partyId, today, grace) {
  return [
    db.prepare(`SELECT COALESCE(SUM(total - paid), 0) AS due, MIN(due_date) AS oldest FROM docs WHERE org_id = ? AND party_id = ? AND type = 'INV' AND status IN ('unpaid','partial')`).bind(orgId, partyId),
    db.prepare(`SELECT ${KHATA_BAL} AS b FROM khata k WHERE k.org_id = ? AND k.party_id = ?`).bind(orgId, partyId),
    db.prepare(`SELECT COUNT(*) AS n FROM vaada_kisht WHERE org_id = ? AND party_id = ? AND outcome = 'broken' AND due >= ?`).bind(orgId, partyId, addDays(today, -90)),
    db.prepare(`SELECT k.due, k.amount FROM vaada_kisht k JOIN vaade v ON v.id = k.vaada_id WHERE v.org_id = ? AND v.party_id = ? AND v.status = 'open'
        AND k.outcome IS NULL AND k.due < ? ORDER BY k.due`).bind(orgId, partyId, addDays(today, -grace)),
    db.prepare(`SELECT kept, broken FROM vaada_stats WHERE org_id = ? AND party_id = ?`).bind(orgId, partyId),
  ];
}
export function riskInput(rs, party, newCredit, today) {
  const a = rs[0].results[0] || {}, st = rs[4].results[0] || {};
  return { party, due: a.due || 0, oldest: a.oldest || null, khata: (rs[1].results[0] || {}).b || 0, n: (rs[2].results[0] || {}).n || 0,
    pendingBroken: rs[3].results, kept: st.kept || 0, broken: st.broken || 0, newCredit, today };
}

/* ---------- promise sets: the read batch behind the lists, party pages, links and reminders ----------
   W = open promises, plus those done in the last 30 days (their outcomes can still be corrected by a void or a
   back-dated receipt). Older promises are frozen. o: { orgId, today, partyId?, book? } */
function W(a, o) {
  let sql = `${a}org_id = ? AND (${a}status = 'open' OR (${a}status = 'done' AND ${a}closed_on >= ?))`;
  const args = [o.orgId, addDays(o.today, -30)];
  if (o.partyId) { sql += ` AND ${a}party_id = ?`; args.push(o.partyId); }
  if (o.book) { sql += ` AND ${a}book = ?`; args.push(o.book); }
  return [sql, args];
}
export function setStatements(db, o) {
  const [wv, av] = W('v.', o), [w0, a0] = W('', o);
  const party = o.partyId
    ? [db.prepare(`SELECT party_id, SUM(total - paid) AS due FROM docs WHERE org_id = ? AND party_id = ? AND type = 'INV' AND status IN ('unpaid','partial') GROUP BY party_id`).bind(o.orgId, o.partyId),
      db.prepare(`SELECT party_id, kept, broken FROM vaada_stats WHERE org_id = ? AND party_id = ?`).bind(o.orgId, o.partyId)]
    : [db.prepare(`SELECT party_id, SUM(total - paid) AS due FROM docs WHERE org_id = ? AND type = 'INV' AND status IN ('unpaid','partial')
          AND party_id IN (SELECT party_id FROM vaade WHERE ${w0} AND book = 'inv') GROUP BY party_id`).bind(o.orgId, ...a0),
      db.prepare(`SELECT party_id, kept, broken FROM vaada_stats WHERE org_id = ? AND party_id IN (SELECT party_id FROM vaade WHERE ${w0})`).bind(o.orgId, ...a0)];
  return [
    db.prepare(`SELECT v.*, p.name, p.phone FROM vaade v JOIN parties p ON p.id = v.party_id WHERE ${wv} ORDER BY v.id LIMIT 500`).bind(...av),
    db.prepare(`SELECT k.* FROM vaada_kisht k JOIN vaade v ON v.id = k.vaada_id WHERE ${wv} ORDER BY k.vaada_id, k.n`).bind(...av),
    db.prepare(`SELECT party_id, id, date, amount FROM payments WHERE org_id = ? AND kind = 'receipt' AND date <= ? AND substr(COALESCE(notes, ''), 1, 6) != '[void]'
        AND party_id IN (SELECT party_id FROM vaade WHERE ${w0} AND book = 'inv') AND date >= (SELECT MIN(made_on) FROM vaade WHERE ${w0} AND book = 'inv')
        ORDER BY party_id, date, id`).bind(o.orgId, o.today, ...a0, ...a0),
    db.prepare(`SELECT k.party_id, k.id, k.date, k.amount FROM khata k WHERE k.org_id = ? AND k.kind = 'got' AND k.status = 'sent' AND k.date <= ?
        AND NOT EXISTS (SELECT 1 FROM khata r WHERE r.reverses = k.id AND r.status = 'sent')
        AND k.party_id IN (SELECT party_id FROM vaade WHERE ${w0} AND book = 'khata') AND k.date >= (SELECT MIN(made_on) FROM vaade WHERE ${w0} AND book = 'khata')
        ORDER BY k.party_id, k.date, k.id`).bind(o.orgId, o.today, ...a0, ...a0),
    ...party,
  ];
}
/* Runs evaluate() over a set read by setStatements (results rs[0..5]). Returns the promises with their instalments
   evaluated, and the write-back (only rows whose stored value differs, at most 500 per request). */
export function evalSet(rs, today, grace) {
  const [P, K, RI, RK, DUE, ST] = rs.map((r) => r.results);
  const kOf = new Map(), rcOf = (rows) => { const m = new Map(); for (const r of rows) (m.get(r.party_id) || m.set(r.party_id, []).get(r.party_id)).push(r); return m; };
  for (const k of K) (kOf.get(k.vaada_id) || kOf.set(k.vaada_id, []).get(k.vaada_id)).push(k);
  const inv = rcOf(RI), kh = rcOf(RK), dueOf = new Map(DUE.map((r) => [r.party_id, r.due])), stats = new Map(ST.map((r) => [r.party_id, r]));
  const diffs = [], doneIds = [], list = [];
  for (const p of P) {
    const ks = kOf.get(p.id) || [];
    if (!ks.length) continue;
    const rc = ((p.book === 'inv' ? inv : kh).get(p.party_id) || []).filter((r) => r.date >= p.made_on && r.date <= today);
    const e = evaluate(p, ks, rc, today, grace, p.book === 'inv' ? (dueOf.get(p.party_id) || 0) : null);
    e.res.forEach((r, i) => {
      const k = ks[i];
      if ((k.outcome || null) !== r.outcome || (k.settled_on || null) !== r.settled_on) diffs.push({ id: k.id, o: r.outcome, s: r.settled_on, from: k.outcome || null, due: k.due, party_id: k.party_id });
    });
    if (e.done) doneIds.push(p.id);
    list.push({ ...p, status: e.done ? 'done' : p.status, kisht: e.res, paid_since: e.paid_since, broken_any: e.res.some((r) => r.outcome === 'broken') });
  }
  // keep the shown counts in step with what the trigger will record
  for (const d of diffs.slice(0, 500)) {
    const pid = d.party_id, s = stats.get(pid) || { party_id: pid, kept: 0, broken: 0 };
    s.kept += (d.o === 'kept') - (d.from === 'kept'); s.broken += (d.o === 'broken') - (d.from === 'broken'); stats.set(pid, s);
  }
  return { list, diffs: diffs.slice(0, 500), doneIds, stats, dueOf };
}
/* write-back as one batch of two statements, whatever the number of rows; the trigger keeps vaada_stats exact */
export function writeBackStatements(db, orgId, today, diffs, doneIds) {
  const st = [];
  if (diffs.length) {
    const j = JSON.stringify(diffs.map((d) => ({ id: d.id, o: d.o, s: d.s })));
    st.push(db.prepare(`UPDATE vaada_kisht SET
        outcome = (SELECT json_extract(j.value, '$.o') FROM json_each(?1) j WHERE json_extract(j.value, '$.id') = vaada_kisht.id),
        settled_on = (SELECT json_extract(j.value, '$.s') FROM json_each(?1) j WHERE json_extract(j.value, '$.id') = vaada_kisht.id)
      WHERE org_id = ?2 AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`).bind(j, orgId));
  }
  if (doneIds.length) {
    st.push(db.prepare(`UPDATE vaade SET status = 'done', closed_on = ?1 WHERE org_id = ?2 AND status = 'open' AND id IN (SELECT value FROM json_each(?3))`)
      .bind(today, orgId, JSON.stringify(doneIds)));
  }
  return st;
}
/* change in a party's 90-day broken count from a write-back (the count was read before it) */
export const broken90Delta = (diffs, today) => { const from = addDays(today, -90); return diffs.filter((d) => d.due >= from).reduce((n, d) => n + (d.o === 'broken') - (d.from === 'broken'), 0); };
/* one promise for the API (rupees) */
export function promiseOut(p) {
  return { id: p.id, book: p.book, kind: p.kind, amount: p.amount / 100, made_on: p.made_on, made_by: p.made_by, status: p.status, doc_id: p.doc_id || null,
    cust_name: p.cust_name || '', note: p.note || '', changes: p.changes || 0, paid_since: (p.paid_since || 0) / 100,
    can_change: p.made_by === 'customer' && !p.changes && !p.broken_any && p.status === 'open',
    kisht: (p.kisht || []).map((k) => ({ n: k.n, due: k.due, amount: k.amount / 100, state: k.state })) };
}
export const pctOf = (s) => (s && s.kept + s.broken ? Math.round(100 * s.kept / (s.kept + s.broken)) : null);

/* ---------- §6.4 Kal ka Cash: a deterministic 4-week cash view ----------
   data (paise): { opening, invs: [{ id, party_id, date, due_date, bal, name, phone }], bills: [{ id, number, party, date, due_date, bal }],
   late: [{ party_id, date, due_date }] (receipt date vs invoice due date, last 120 days),
   kisht: [{ party_id, book, due, amount, name, phone }] (unresolved instalments of open promises),
   stats: [{ party_id, kept, broken }], months: [{ account_id, sys, type, ym, dr, cr }] } */
export function forecast(data, t) {
  const end = addDays(t, 27);
  const wk = (d) => Math.min(3, Math.max(0, Math.floor((days(d < t ? t : d) - days(t)) / 7)));
  const weeks = [0, 1, 2, 3].map((i) => ({ from: addDays(t, 7 * i), to: addDays(t, 7 * i + 6), open: 0, in_exp: 0, in_full: 0, out: 0, close_exp: 0, close_full: 0 }));
  const statOf = new Map((data.stats || []).map((r) => [r.party_id, r]));
  const pKept = (pid) => { const s = statOf.get(pid) || {}; const k = s.kept || 0, b = s.broken || 0; return (k + 1) / (k + b + 2); };
  const who = new Map(), expW12 = new Map(), hasDue = new Set(), invParty = new Set();
  const note = (pid, name, phone) => { if (!who.has(pid) && name !== undefined) who.set(pid, { name, phone: phone || '' }); };
  const addIn = (pid, i, exp, full) => { weeks[i].in_exp += exp; weeks[i].in_full += full; if (i < 2) expW12.set(pid, (expW12.get(pid) || 0) + exp); };
  // A. promises: amount x the party's (Laplace-smoothed) record of keeping them
  const promisedInv = new Map();
  for (const k of data.kisht || []) {
    note(k.party_id, k.name, k.phone);
    if (k.book === 'inv') { promisedInv.set(k.party_id, (promisedInv.get(k.party_id) || 0) + k.amount); invParty.add(k.party_id); }
    if (k.due <= t) hasDue.add(k.party_id);
    if (k.due > end) continue;
    addIn(k.party_id, wk(k.due), Math.round(k.amount * pKept(k.party_id)), k.amount);
  }
  // B. invoice dues not covered by a promise: due date + the party's usual delay, 60% expected
  const lateRows = (data.late || []).filter((r) => r.due_date && r.date).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const per = new Map(), all = [];
  for (const r of lateRows) { const dd = days(r.date) - days(r.due_date); all.push(dd); (per.get(r.party_id) || per.set(r.party_id, []).get(r.party_id)).push(dd); }
  const orgLate = all.length ? median(all) : 15;
  const lateOf = (pid) => { const a = per.get(pid); return a && a.length ? median(a.slice(-10)) : orgLate; };
  let stuck = 0;
  const invs = (data.invs || []).slice().sort((a, b) => ((a.due_date || a.date) < (b.due_date || b.date) ? -1 : (a.due_date || a.date) > (b.due_date || b.date) ? 1 : a.id - b.id));
  for (const d of invs) {
    note(d.party_id, d.name, d.phone); invParty.add(d.party_id);
    const due = d.due_date || d.date;
    if (due < t) hasDue.add(d.party_id);
    let bal = d.bal;
    const pr = promisedInv.get(d.party_id) || 0;
    if (pr > 0) { const use = Math.min(pr, bal); bal -= use; promisedInv.set(d.party_id, pr - use); }
    if (bal <= 0) continue;
    if (days(t) - days(due) > 90) { stuck += bal; continue; }
    const eta = addDays(due, Math.round(lateOf(d.party_id)));
    if (eta > end) continue;
    addIn(d.party_id, wk(eta), Math.round(bal * 0.6), bal);
  }
  // C. supplier bills on their due date
  for (const b of data.bills || []) { const due = b.due_date || b.date; if (due <= end) weeks[wk(due)].out += b.bal; }
  // D. GST on the 20th: last month's net output tax, and this month's so far if next month's 20th is in the window
  const months = data.months || [];
  const ym = (d) => d.slice(0, 7), first = t.slice(0, 8) + '01';
  const gstNet = (m) => { let o = 0, i = 0; for (const r of months) if (r.ym === m) { if (r.sys === 'gst_output') o += r.cr - r.dr; else if (r.sys === 'gst_input') i += r.dr - r.cr; } return Math.max(0, o - i); };
  const gst = [];
  if (+t.slice(8, 10) <= 20) gst.push([t.slice(0, 8) + '20', gstNet(ym(addDays(first, -1)))]);
  const next20 = addDays(t.slice(0, 8) + '28', 4).slice(0, 8) + '20';
  if (next20 <= end) gst.push([next20, gstNet(ym(t))]);
  for (const [d, amt] of gst) if (amt > 0) weeks[wk(d)].out += amt;
  // E. regular expenses: median of the last 3 full months, per week
  const m1 = ym(addDays(first, -1)), m2 = ym(addDays(m1 + '-01', -1)), m3 = ym(addDays(m2 + '-01', -1));
  const SKIP = new Set(['cogs', 'stock_adj', 'round_off', 'pur_adj', 'misc_exp']), acc = new Map();
  for (const r of months) {
    if (r.type !== 'expense' || SKIP.has(r.sys)) continue;
    const a = acc.get(r.account_id) || acc.set(r.account_id, {}).get(r.account_id);
    a[r.ym] = (a[r.ym] || 0) + r.dr - r.cr;
  }
  let weekly = 0;
  for (const a of acc.values()) { const m = median([m1, m2, m3].map((k) => a[k] || 0)); if (m > 0) weekly += Math.round(m * 7 / 30.4); }
  // chain the weeks
  let oe = data.opening || 0, of = oe, short = null;
  weeks.forEach((w, i) => {
    w.out += weekly; w.open = oe;
    w.close_exp = oe + w.in_exp - w.out; w.close_full = of + w.in_full - w.out;
    oe = w.close_exp; of = w.close_full;
    if (short === null && w.close_exp < 0) short = i + 1;
  });
  const remind = [...expW12.entries()].filter(([pid, v]) => v > 0 && hasDue.has(pid)).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 5)
    .map(([pid, v]) => ({ party_id: pid, name: (who.get(pid) || {}).name || '', phone: (who.get(pid) || {}).phone || '', amount: v, book: invParty.has(pid) ? 'inv' : 'khata' }));
  const wait = short ? (data.bills || []).filter((b) => { const due = b.due_date || b.date; return due > t && due <= end && wk(due) === short - 1; })
    .sort((a, b) => ((a.due_date || a.date) < (b.due_date || b.date) ? 1 : -1)).map((b) => ({ id: b.id, number: b.number, party: b.party || '', amount: b.bal, due: b.due_date || b.date })) : [];
  return { today: t, opening: data.opening || 0, weeks, short_week: short, short_amount: short ? -weeks[short - 1].close_exp : 0,
    remind, remind_total: remind.reduce((s, r) => s + r.amount, 0), bills_wait: wait, stuck, expense_week: weekly };
}
