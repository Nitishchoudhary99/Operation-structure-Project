/* Vasooli: getting paid for credit sales, with no paid WhatsApp API. Every message still goes from the shop's own
   WhatsApp with one tap; what this file adds is the plan around it:
   - a reminder schedule (3 days before the due date, on it, then 7 / 15 / 30 / 45 days late, weekly after that),
     softer for VIP buyers and paused while the buyer's own promise date is still ahead;
   - a log of every reminder sent (who, when, how), kept as evidence;
   - a monthly balance confirmation the buyer answers with one tap ("correct" / "something is wrong");
   - the recovery file: MSMED Act interest (Section 16), a demand-notice draft and the evidence, ready to print;
   - who collected what (receipts per staff member) and the weekly summary for the owner.
   Money is integer paise; dates are 'YYYY-MM-DD' strings in IST (lib.today()). */
import { bad, notFound, str, today, nowIso, addDays } from './lib.js';
import { requireCan, randomHex } from './auth.js';
import { auditStatement } from './engine.js';
import { phrases, cleanLang, withLang, sendLinks, BRAND, inrW, rs, fd } from './msg.js';

export const STEPS = [-3, 0, 7, 15, 30, 45];
const REPEAT_AFTER_LAST = 7;                       // after the 45-day step, one reminder a week
const R = (p) => Math.round(p) / 100;
const dayNo = (d) => Math.round(Date.parse(d + 'T00:00:00Z') / 864e5);
const NOT_VOID = `(y.notes IS NULL OR y.notes NOT LIKE '[void]%')`;

/* the schedule step a bill is at, from how many days late it is (negative = not due yet); null = too early */
export function stepFor(daysLate) {
  let s = null;
  for (const x of STEPS) if (daysLate >= x) s = x;
  return s;
}
/* how firm the message is; a VIP buyer never gets the 30-day / final wording */
export function toneFor(step, vip) {
  if (step === null || step < 0) return 'soon';
  if (step === 0) return 'today';
  if (vip) return 'gentle';
  return step >= 45 ? 'final' : step >= 30 ? 'late30' : 'late';
}

/* MSMED Act 2006: the buyer must pay within the agreed days, at most 45 days from acceptance (Section 15). After that
   "appointed day", interest is compound with monthly rests at three times the RBI bank rate (Section 16).
   Returns paise. The part of a month at the end is counted pro rata. */
export function appointedDay(invDate, dueDate) {
  const cap = addDays(invDate, 45);
  return dueDate && dueDate < cap ? dueDate : cap;
}
export function msmedInterest(principal, fromDay, toDay, bankRatePct) {
  const days = dayNo(toDay) - dayNo(fromDay);
  if (days <= 0 || principal <= 0 || !(bankRatePct > 0)) return 0;
  const m = (3 * bankRatePct) / 100 / 12, months = days / (365 / 12), whole = Math.floor(months);
  const grown = principal * Math.pow(1 + m, whole) * (1 + m * (months - whole));
  return Math.round(grown - principal);
}

/* ---------------------------------------------------------------- the reminder queue */
export async function queue(c) {
  const t = today(), org = c.org.id;
  const [bills, logs, promises] = await c.db.batch([
    c.db.prepare(`SELECT p.id, p.name, p.phone, p.lang, p.vip, COUNT(*) AS bills, SUM(d.total - d.paid) AS due,
        MIN(COALESCE(d.due_date, d.date)) AS oldest_due, SUM(CASE WHEN COALESCE(d.due_date, d.date) < ?2 THEN d.total - d.paid ELSE 0 END) AS overdue
      FROM docs d JOIN parties p ON p.id = d.party_id
      WHERE d.org_id = ?1 AND d.type = 'INV' AND d.status IN ('unpaid','partial') GROUP BY p.id HAVING due > 0`).bind(org, t),
    c.db.prepare(`SELECT party_id, step, via, sent_at FROM reminder_log WHERE org_id = ? AND sent_at >= ? ORDER BY id`).bind(org, addDays(t, -200)),
    c.db.prepare(`SELECT v.party_id, MIN(k.due) AS next_due, SUM(k.amount) AS amount FROM vaade v JOIN vaada_kisht k ON k.vaada_id = v.id AND k.outcome IS NULL
      WHERE v.org_id = ? AND v.status = 'open' AND v.book = 'inv' GROUP BY v.party_id`).bind(org),
  ]);
  const logOf = new Map(), promiseOf = new Map(promises.results.map((p) => [p.party_id, p]));
  for (const l of logs.results) { if (!logOf.has(l.party_id)) logOf.set(l.party_id, []); logOf.get(l.party_id).push(l); }
  const rows = bills.results.map((p) => {
    const late = dayNo(t) - dayNo(p.oldest_due), step = stepFor(late);
    const cycle = addDays(p.oldest_due, -4);       // reminders from before this round of bills do not count
    const sent = (logOf.get(p.id) || []).filter((l) => l.sent_at.slice(0, 10) >= cycle);
    const last = sent[sent.length - 1] || null, sentStep = sent.length ? Math.max(...sent.map((l) => l.step)) : null;
    const pr = promiseOf.get(p.id);
    let status, next = null;
    if (pr && pr.next_due > t) { status = 'promised'; next = pr.next_due; }
    else if (step === null) { status = 'later'; next = addDays(p.oldest_due, -3); }
    else if (sentStep !== null && step <= sentStep) {
      const repeat = step >= 45 ? addDays(last.sent_at.slice(0, 10), REPEAT_AFTER_LAST) : null;
      if (repeat && repeat <= t) status = 'due';
      else { status = 'sent'; const after = STEPS.find((x) => x > sentStep); next = repeat || (after === undefined ? null : addDays(p.oldest_due, after)); }
    } else status = 'due';
    return { party_id: p.id, name: p.name, phone: p.phone, lang: p.lang || '', vip: !!p.vip, bills: p.bills, due: R(p.due), overdue: R(p.overdue),
      oldest_due: p.oldest_due, days_late: late, step, tone: toneFor(step, p.vip), status, next_on: next,
      last_sent: last && { at: last.sent_at, via: last.via, step: last.step }, promise: pr ? { on: pr.next_due, amount: R(pr.amount) } : null };
  });
  const order = { due: 0, promised: 1, sent: 2, later: 3 };
  rows.sort((a, b) => order[a.status] - order[b.status] || b.overdue - a.overdue || b.due - a.due);
  return rows;
}

/* the shop tapped WhatsApp / SMS for a reminder: kept as evidence and moves the schedule on */
export async function logReminder(c, partyId, body) {
  requireCan(c.user, 'sales');
  const p = await c.db.prepare(`SELECT id FROM parties WHERE id = ? AND org_id = ?`).bind(partyId, c.org.id).first();
  if (!p) throw notFound('Party not found.');
  const step = STEPS.includes(+body.step) ? +body.step : 0;
  const via = body.via === 'sms' ? 'sms' : 'whatsapp';
  await c.db.prepare(`INSERT INTO reminder_log (org_id, party_id, step, via, lang, user_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(c.org.id, p.id, step, via, cleanLang(body.lang, ''), c.user.id, nowIso()).run();
  return { ok: true };
}

/* ---------------------------------------------------------------- the weekly summary and who collected what */
export async function summary(c) {
  const t = today(), org = c.org.id, w = addDays(t, -6), m = t.slice(0, 8) + '01';
  const [rec, top, promised, out, paid90, paidPrev, watch, staff] = await c.db.batch([
    c.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS amt, COUNT(DISTINCT party_id) AS n FROM payments y WHERE org_id = ? AND kind = 'receipt' AND date >= ? AND ${NOT_VOID}`).bind(org, w),
    c.db.prepare(`SELECT p.name, SUM(y.amount) AS amt FROM payments y JOIN parties p ON p.id = y.party_id WHERE y.org_id = ? AND y.kind = 'receipt' AND y.date >= ? AND ${NOT_VOID}
      GROUP BY y.party_id ORDER BY amt DESC LIMIT 1`).bind(org, w),
    c.db.prepare(`SELECT COALESCE(SUM(k.amount), 0) AS amt, COUNT(DISTINCT k.party_id) AS n FROM vaada_kisht k JOIN vaade v ON v.id = k.vaada_id
      WHERE k.org_id = ? AND k.outcome IS NULL AND v.status = 'open' AND k.due BETWEEN ? AND ?`).bind(org, t, addDays(t, 6)),
    c.db.prepare(`SELECT COALESCE(SUM(total - paid), 0) AS due, COALESCE(SUM(CASE WHEN COALESCE(due_date, date) < ?2 THEN total - paid ELSE 0 END), 0) AS overdue,
        COALESCE(SUM(CASE WHEN COALESCE(due_date, date) < ?3 THEN total - paid ELSE 0 END), 0) AS late45,
        COUNT(DISTINCT CASE WHEN COALESCE(due_date, date) < ?3 THEN party_id END) AS late45_n
      FROM docs WHERE org_id = ?1 AND type = 'INV' AND status IN ('unpaid','partial')`).bind(org, t, addDays(t, -45)),
    // average days from bill date to the receipt that cleared it: bills cleared in the last 90 days, and the 90 before
    ...[[addDays(t, -89), t], [addDays(t, -179), addDays(t, -90)]].map(([a, b]) => c.db.prepare(`SELECT AVG(days) AS avg, COUNT(*) AS n FROM (
        SELECT julianday(MAX(y.date)) - julianday(d.date) AS days FROM docs d JOIN payment_allocs pa ON pa.doc_id = d.id JOIN payments y ON y.id = pa.payment_id
        WHERE d.org_id = ? AND d.type = 'INV' AND d.status = 'paid' GROUP BY d.id HAVING MAX(y.date) BETWEEN ? AND ?)`).bind(org, a, b)),
    c.db.prepare(`SELECT p.name, COUNT(*) AS n FROM vaada_kisht k JOIN parties p ON p.id = k.party_id WHERE k.org_id = ? AND k.outcome = 'broken' AND k.due >= ?
      GROUP BY k.party_id ORDER BY n DESC LIMIT 1`).bind(org, addDays(t, -90)),
    c.db.prepare(`SELECT y.created_by AS user_id, COALESCE(u.name, 'Unknown') AS name, SUM(y.date >= ?3) AS n_week,
        SUM(CASE WHEN y.date >= ?3 THEN y.amount ELSE 0 END) AS week, SUM(CASE WHEN y.date >= ?3 AND a.sys = 'cash' THEN y.amount ELSE 0 END) AS cash_week,
        SUM(CASE WHEN y.date >= ?2 THEN y.amount ELSE 0 END) AS month
      FROM payments y LEFT JOIN users u ON u.id = y.created_by LEFT JOIN accounts a ON a.id = y.account_id
      WHERE y.org_id = ?1 AND y.kind = 'receipt' AND y.date >= min(?2, ?3) AND ${NOT_VOID} GROUP BY y.created_by ORDER BY week DESC, month DESC`).bind(org, m, w),
  ]);
  const o = out.results[0], avg = (r) => (r.results[0].n ? Math.round(r.results[0].avg) : null);
  return {
    from: w, to: t,
    received: R(rec.results[0].amt), payers: rec.results[0].n, top_payer: top.results[0] ? { name: top.results[0].name, amount: R(top.results[0].amt) } : null,
    promised: R(promised.results[0].amt), promised_n: promised.results[0].n,
    outstanding: R(o.due), overdue: R(o.overdue), late45: R(o.late45), late45_n: o.late45_n,
    avg_days: avg(paid90), avg_days_before: avg(paidPrev),
    watch: watch.results[0] ? { name: watch.results[0].name, broken: watch.results[0].n } : null,
    staff: staff.results.map((s) => ({ ...s, week: R(s.week), month: R(s.month), cash_week: R(s.cash_week) })),
  };
}

/* the summary as a WhatsApp message for the owner (to forward to a partner or keep) */
export function summaryText(org, s, lang) {
  const L = { en: ['Your week in collections', 'Received', 'from', 'buyer(s)', 'Promised this week', 'Unpaid, 45+ days late', 'Average days to get paid', 'Top payer', 'Watch out', 'broke', 'promise(s)'],
    hi: ['इस हफ़्ते की वसूली', 'मिला', 'से', 'ग्राहक', 'इस हफ़्ते वादा', '45+ दिन से बाकी', 'भुगतान में औसत दिन', 'सबसे अच्छा भुगतानकर्ता', 'ध्यान दें', 'ने', 'वादे तोड़े'],
    hl: ['Is hafte ki vasooli', 'Mila', 'se', 'grahak', 'Is hafte vaada', '45+ din se baaki', 'Payment mein average din', 'Top payer', 'Dhyan dein', 'ne', 'vaade tode'] }[cleanLang(lang)];
  const m = (x) => inrW(Math.round(x * 100));
  return [`*${org.name}* · ${L[0]} 📊`, `${fd(s.from)} – ${fd(s.to)}`, '',
    `${L[1]}: *${m(s.received)}* (${s.payers} ${L[3]})`,
    `${L[4]}: ${m(s.promised)}`,
    `${L[5]}: ${m(s.late45)} (${s.late45_n} ${L[3]})`,
    ...(s.avg_days !== null ? [`${L[6]}: ${s.avg_days_before !== null ? `${s.avg_days_before} → ` : ''}*${s.avg_days}*`] : []),
    ...(s.top_payer ? [`${L[7]}: ${s.top_payer.name} ⭐`] : []),
    ...(s.watch ? [`${L[8]}: ${s.watch.name} (${s.watch.broken} ${L[10]})`] : []),
    '', `_${BRAND}_`].join('\n');
}

/* ---------------------------------------------------------------- receipts: the buyer's proof of every rupee paid */
export async function receiptMessage(c, payId, lang) {
  const y = await c.db.prepare(`SELECT y.*, p.name AS party, p.phone, p.lang AS plang, u.name AS by_name, a.name AS account FROM payments y JOIN parties p ON p.id = y.party_id
      LEFT JOIN users u ON u.id = y.created_by LEFT JOIN accounts a ON a.id = y.account_id WHERE y.id = ? AND y.org_id = ? AND y.kind = 'receipt'`).bind(payId, c.org.id).first();
  if (!y) throw notFound('Receipt not found.');
  const bal = (await c.db.prepare(`SELECT COALESCE(SUM(total - paid), 0) AS b FROM docs WHERE org_id = ? AND party_id = ? AND type = 'INV' AND status IN ('unpaid','partial')`)
    .bind(c.org.id, y.party_id).first()).b;
  const L = phrases(lang || y.plang || c.org.msg_lang);
  const balW = bal > 0 ? `${L.rcBal}: *${inrW(bal)}*` : L.rcClear;
  const wa = [`*${c.org.name}*`, L.rcTitle, '', L.hello(y.party), L.rcGot(inrW(y.amount), fd(y.date), y.number), ...(y.by_name ? [`${L.rcBy}: ${y.by_name}`] : []),
    balW, '', L.thanks, '', L.sentVia(BRAND)].join('\n');
  const sms = `${L.smsRc(c.org.name, rs(y.amount), fd(y.date), y.number, bal > 0 ? `${L.rcBal} ${rs(bal)}` : L.rcClear.replace(' ✅', ''))} -${BRAND}`;
  return { party_id: y.party_id, number: y.number, lang: cleanLang(lang || y.plang || c.org.msg_lang), ...sendLinks(y.phone, wa, sms) };
}

/* ---------------------------------------------------------------- monthly balance confirmation */
const openBills = (c, partyId) => c.db.prepare(`SELECT number, date, due_date, total - paid AS bal FROM docs WHERE org_id = ? AND party_id = ? AND type = 'INV'
    AND status IN ('unpaid','partial') ORDER BY date, id LIMIT 200`).bind(c.org.id, partyId).all().then((r) => r.results);

export async function makeConfirmation(c, partyId, lang) {
  requireCan(c.user, 'sales');
  const p = await c.db.prepare(`SELECT id, name, phone, lang FROM parties WHERE id = ? AND org_id = ?`).bind(partyId, c.org.id).first();
  if (!p) throw notFound('Party not found.');
  const bills = await openBills(c, p.id);
  const bal = bills.reduce((s, b) => s + b.bal, 0);
  if (bal <= 0) throw bad(`${p.name} has no unpaid bills to confirm.`);
  const t = today(), snap = JSON.stringify(bills.map((b) => [b.number, b.date, b.due_date || '', b.bal]));
  // the same unanswered statement is sent again rather than making a new one each tap
  let row = await c.db.prepare(`SELECT * FROM confirmations WHERE org_id = ? AND party_id = ? AND status = 'sent' AND as_of = ? AND balance = ? ORDER BY id DESC LIMIT 1`)
    .bind(c.org.id, p.id, t, bal).first();
  if (!row) {
    row = await c.db.prepare(`INSERT INTO confirmations (org_id, party_id, token, as_of, balance, bills, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, ?) RETURNING *`)
      .bind(c.org.id, p.id, randomHex(12), t, bal, snap, c.user.id, nowIso()).first();
    await c.db.batch([auditStatement(c, 'balance confirmation', `${p.name} ${rs(bal)}`)]);
  }
  const L = phrases(lang || p.lang || c.org.msg_lang), useLang = cleanLang(lang || p.lang || c.org.msg_lang);
  const link = withLang(`${c.url.origin}/c/${row.token}`, useLang);
  const wa = [`*${c.org.name}*`, L.cfTitle(fd(t)), '', L.hello(p.name), L.cfBody(inrW(bal), bills.length), '', L.cfAsk, link, '', L.sentVia(BRAND)].join('\n');
  const sms = `${L.smsCf(c.org.name, rs(bal), fd(t), link)} -${BRAND}`;
  return { id: row.id, party_id: p.id, phone: p.phone, lang: useLang, ...sendLinks(p.phone, wa, sms) };
}

export async function listConfirmations(c) {
  const { results } = await c.db.prepare(`SELECT f.id, f.party_id, p.name, f.as_of, f.balance, f.status, f.note, f.disputed_bill, f.created_at, f.answered_at
      FROM confirmations f JOIN parties p ON p.id = f.party_id WHERE f.org_id = ? AND f.id IN (SELECT MAX(id) FROM confirmations WHERE org_id = ? GROUP BY party_id)
      ORDER BY f.id DESC LIMIT 500`).bind(c.org.id, c.org.id).all();
  return results.map((r) => ({ ...r, balance: R(r.balance) }));
}

/* the buyer's page (/c/<token>): no login, read-only except the one answer */
export async function publicConfirmation(c, token) {
  const f = await c.db.prepare(`SELECT f.*, p.name AS party, o.name AS org, o.upi_id, o.phone AS org_phone, o.id AS oid FROM confirmations f JOIN parties p ON p.id = f.party_id
      JOIN orgs o ON o.id = f.org_id WHERE f.token = ?`).bind(token).first();
  if (!f) throw notFound('This link is not valid any more.');
  let bills = [];
  try { bills = JSON.parse(f.bills || '[]').map(([number, date, due_date, bal]) => ({ number, date, due_date, bal: R(bal) })); } catch (e) { bills = []; }
  return { org: { name: f.org, upi_id: f.upi_id, phone: f.org_phone }, party: f.party, as_of: f.as_of, balance: R(f.balance), bills,
    status: f.status, note: f.note, disputed_bill: f.disputed_bill, answered_at: f.answered_at };
}
export async function answerConfirmation(c, token, body) {
  const f = await c.db.prepare(`SELECT f.*, p.name AS party FROM confirmations f JOIN parties p ON p.id = f.party_id WHERE f.token = ?`).bind(token).first();
  if (!f) throw notFound('This link is not valid any more.');
  if (f.status !== 'sent') throw bad('This statement is already answered. Thank you.');
  const agree = body.answer === 'agree';
  if (!agree && body.answer !== 'dispute') throw bad('Choose an answer.');
  const note = str(body.note, 300), bill = str(body.bill, 40);
  if (!agree && !note) throw bad('Please write what is wrong, so the shop can fix it.');
  const ua = str(c.request.headers.get('User-Agent') || '', 200);
  const r = await c.db.prepare(`UPDATE confirmations SET status = ?, note = ?, disputed_bill = ?, answered_at = ?, answered_ua = ? WHERE id = ? AND status = 'sent'`)
    .bind(agree ? 'agreed' : 'disputed', agree ? '' : note, agree ? '' : bill, nowIso(), ua, f.id).run();
  if (!r.meta.changes) throw bad('This statement is already answered. Thank you.');
  await c.db.prepare(`INSERT INTO audit (org_id, user_id, at, action, detail) VALUES (?, NULL, ?, ?, ?)`)
    .bind(f.org_id, nowIso(), agree ? 'balance confirmed' : 'balance disputed', `${f.party} ${rs(f.balance)}${agree ? '' : ': ' + note}`).run();
  return { ok: true, status: agree ? 'agreed' : 'disputed' };
}

/* ---------------------------------------------------------------- the recovery file */
export async function recoveryFile(c, partyId, bankRatePct) {
  const org = c.org.id, t = today();
  const p = await c.db.prepare(`SELECT * FROM parties WHERE id = ? AND org_id = ?`).bind(partyId, org).first();
  if (!p) throw notFound('Party not found.');
  const [bills, pays, confs, rems, proms] = await c.db.batch([
    c.db.prepare(`SELECT id, number, date, due_date, total, paid, total - paid AS bal FROM docs WHERE org_id = ? AND party_id = ? AND type = 'INV' AND status IN ('unpaid','partial')
      ORDER BY date, id`).bind(org, p.id),
    c.db.prepare(`SELECT y.number, y.date, y.amount, y.reference, a.name AS account FROM payments y LEFT JOIN accounts a ON a.id = y.account_id
      WHERE y.org_id = ? AND y.party_id = ? AND y.kind = 'receipt' AND ${NOT_VOID} ORDER BY y.date DESC, y.id DESC LIMIT 50`).bind(org, p.id),
    c.db.prepare(`SELECT as_of, balance, status, note, disputed_bill, created_at, answered_at FROM confirmations WHERE org_id = ? AND party_id = ? ORDER BY id DESC LIMIT 24`).bind(org, p.id),
    c.db.prepare(`SELECT r.step, r.via, r.sent_at, u.name AS by_name FROM reminder_log r LEFT JOIN users u ON u.id = r.user_id WHERE r.org_id = ? AND r.party_id = ?
      ORDER BY r.id DESC LIMIT 60`).bind(org, p.id),
    c.db.prepare(`SELECT v.made_on, v.made_by, v.amount, v.status, k.n, k.due, k.amount AS kamount, k.outcome FROM vaade v JOIN vaada_kisht k ON k.vaada_id = v.id
      WHERE v.org_id = ? AND v.party_id = ? ORDER BY v.id DESC, k.n LIMIT 60`).bind(org, p.id),
  ]);
  const rate = Number(bankRatePct);
  const rows = bills.results.map((b) => {
    const appointed = appointedDay(b.date, b.due_date), late = Math.max(0, dayNo(t) - dayNo(appointed));
    return { number: b.number, date: b.date, due_date: b.due_date, appointed, total: R(b.total), paid: R(b.paid), bal: R(b.bal), days_late: late,
      interest: R(msmedInterest(b.bal, appointed, t, rate)) };
  });
  const sum = (k) => Math.round(rows.reduce((s, r) => s + r[k] * 100, 0)) / 100;
  return {
    today: t, bank_rate: rate > 0 ? rate : null, msme: !!c.org.udyam, udyam: c.org.udyam || '',
    org: { name: c.org.name, gstin: c.org.gstin, address: c.org.address, city: c.org.city, state: c.org.state, pincode: c.org.pincode, phone: c.org.phone, email: c.org.email },
    party: { id: p.id, name: p.name, gstin: p.gstin, address: p.address, city: p.city, state: p.state, pincode: p.pincode, phone: p.phone, email: p.email },
    bills: rows, totals: { bal: sum('bal'), interest: sum('interest') },
    payments: pays.results.map((y) => ({ ...y, amount: R(y.amount) })),
    confirmations: confs.results.map((f) => ({ ...f, balance: R(f.balance) })),
    reminders: rems.results,
    promises: proms.results.map((k) => ({ ...k, amount: R(k.amount), kamount: R(k.kamount) })),
  };
}
