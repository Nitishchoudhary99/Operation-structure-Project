/* Staff, attendance and salary, the way a shop runs it: tap P / A / ½ / L for each person each day, give an advance
   when someone asks, and at the month end pay the salary with the advance cut from it.
   - Monthly staff earn salary × payable days ÷ days in the month. A day nobody marked counts as present (most shops only
     mark the absences); A = absent, H = half day, L = paid leave, O = week off / holiday (paid).
   - Daily-wage staff earn the wage for each day marked P (H = half, L = paid leave); unmarked days are not paid.
   - Overtime: hours × the person's overtime rate per hour.
   Books: an advance is Dr Staff Advances / Cr cash; a salary is Dr Salaries & Wages (earned + bonus) / Cr Staff Advances
   (the advance cut) / Cr cash (what is paid). Cancelling reverses the journal. */
import { bad, notFound, str, reqStr, num, toPaise, nowIso, today, date, uid, oneOf, addDays } from './lib.js';
import { requireCan, requireCancel } from './auth.js';
import { journalStatements, auditStatement, cashAccount, ensureSysAccounts } from './engine.js';
import { setupOf } from './setup.js';

/* ---------- statutory deductions: PF (EPF / EPS / EDLI), ESI, professional tax ----------
   Under the Code on Social Security and the EPF Scheme, 2026: PF is 12% of Wages (basic + DA, at least 50% of the
   pay: staff.wage_pct) up to the wage ceiling (₹25,000 from 17 Sep 2026; Settings → payroll rates), employee and employer
   each; the employer's 12% splits into 8.33% to the pension fund (EPS, on wages up to the EPS ceiling) and the rest to
   EPF; EDLI 0.5% and EPF admin 0.5% are employer costs. ESI: 0.75% employee + 3.25% employer of gross pay while it is
   ₹21,000 or less, rounded up to the next rupee. Professional tax: the state's monthly amount, typed per person.
   All rates are the owner's to change (the CA has the last word); amounts are whole rupees, as the ECR wants. */
export const STAT_DEFAULTS = { pf_ceiling: 25000, eps_ceiling: 25000, pf_rate: 12, eps_rate: 8.33, edli_rate: 0.5, admin_rate: 0.5, esi_limit: 21000, esi_emp: 0.75, esi_er: 3.25 };
export const STAT_ACCOUNTS = [['pf_payable', ['2410', '2411', '2419'], 'PF Payable (EPF)', 'liability'], ['esi_payable', ['2420', '2421', '2429'], 'ESI Payable', 'liability'],
  ['pt_payable', ['2430', '2431', '2439'], 'Professional Tax Payable', 'liability'], ['er_contrib', ['6015', '6016', '6019'], 'Employer PF & ESI', 'expense']];
export const ratesOf = (org) => ({ ...STAT_DEFAULTS, ...(setupOf(org).payroll || {}) });
const rupee = (p) => Math.round(p / 100) * 100;                   // paise → whole rupees (in paise)
const rupeeUp = (p) => Math.ceil(Math.round(p) / 100) * 100;
/* s: staff row; pay: salaryFor(); amounts in paise. wages for PF exclude overtime and bonus (Code on Wages) */
export function statutoryFor(s, pay, rates) {
  const r = rates, out = { pf: 0, eps: 0, er_epf: 0, edli: 0, admin: 0, esi: 0, er_esi: 0, pt: 0, gross_wages: pay.earned, epf_wages: 0, eps_wages: 0, edli_wages: 0, esi_wages: 0,
    ncp: Math.max(0, Math.floor(pay.days - pay.payable - (pay.from ? 0 : 0))) };
  if (s.pf) {
    const wages = rupee(pay.base * Math.min(100, Math.max(50, s.wage_pct || 50)) / 100);
    const cap = r.pf_ceiling * 100, epsCap = r.eps_ceiling * 100;
    out.epf_wages = Math.min(wages, cap); out.eps_wages = Math.min(wages, epsCap); out.edli_wages = Math.min(wages, cap);
    out.pf = rupee(out.epf_wages * r.pf_rate / 100);
    out.eps = s.eps === 0 ? 0 : rupee(out.eps_wages * r.eps_rate / 100);
    out.er_epf = Math.max(0, rupee(out.epf_wages * r.pf_rate / 100) - out.eps);
    out.edli = rupee(out.edli_wages * r.edli_rate / 100); out.admin = rupee(out.epf_wages * r.admin_rate / 100);
  }
  if (s.esi && pay.earned > 0 && pay.earned <= r.esi_limit * 100) {
    out.esi_wages = pay.earned; out.esi = rupeeUp(pay.earned * r.esi_emp / 100); out.er_esi = rupeeUp(pay.earned * r.esi_er / 100);
  }
  out.pt = s.pt || 0;
  out.employee = out.pf + out.esi + out.pt;
  out.employer = out.eps + out.er_epf + out.edli + out.admin + out.er_esi;
  return out;
}

const R = (p) => Math.round(p) / 100;
const STATUS = ['P', 'A', 'H', 'L', 'O'];
const monthOf = (m) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(m || '') ? m : today().slice(0, 7));
const daysIn = (m) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
const D = (account, amount) => ({ account, amount });
const C = (account, amount) => ({ account, amount: -amount });

const staffFields = (b) => ({
  name: reqStr(b.name, 'Name', 80), phone: str(b.phone, 20).replace(/[^\d+]/g, ''), title: str(b.title, 60),
  pay_type: oneOf(b.pay_type || 'month', ['month', 'day'], 'Pay type'),
  rate: toPaise(num(b.rate, b.pay_type === 'day' ? 'Daily wage' : 'Monthly salary', { min: 0, max: 1e8 })),
  ot_rate: toPaise(num(b.ot_rate, 'Overtime per hour', { min: 0, max: 1e6, def: 0 })),
  join_date: b.join_date ? date(b.join_date, 'Joining date') : today(), notes: str(b.notes, 300),
  // statutory: PF (UAN), ESI (IP number), professional tax per month, wages share for PF (basic + DA, 50% or more)
  pf: b.pf === true || b.pf === 1 || b.pf === '1' ? 1 : 0, uan: str(b.uan, 12).replace(/\D/g, ''),
  esi: b.esi === true || b.esi === 1 || b.esi === '1' ? 1 : 0, esi_no: str(b.esi_no, 17).replace(/\D/g, ''),
  pt: toPaise(num(b.pt, 'Professional tax', { min: 0, max: 2500, def: 0 })), wage_pct: Math.round(num(b.wage_pct, 'Wages share for PF', { min: 50, max: 100, def: 50 })),
});
const checkIds = (f) => {
  if (f.uan && !/^\d{12}$/.test(f.uan)) throw bad('UAN has 12 digits.');
  if (f.esi_no && !/^\d{10}$/.test(f.esi_no)) throw bad('ESI IP number has 10 digits.');
};
const staffOut = (s) => ({ ...s, rate: R(s.rate), ot_rate: R(s.ot_rate), pt: R(s.pt || 0) });

async function staffOf(c, id) {
  const s = await c.db.prepare(`SELECT * FROM staff WHERE id = ? AND org_id = ?`).bind(id, c.org.id).first();
  if (!s) throw notFound('Staff member not found.');
  return s;
}

/* what a person earned in a month from the marks: the days counted run from joining (or the 1st) to the month end,
   or to today in the running month */
export function salaryFor(s, month, marks) {
  const n = daysIn(month), first = `${month}-01`, last = `${month}-${String(n).padStart(2, '0')}`;
  const from = s.join_date > first ? s.join_date : first, t = today(), to = last < t ? last : t;
  const by = new Map(marks.map((m) => [m.date, m]));
  const count = { P: 0, A: 0, H: 0, L: 0, O: 0, unmarked: 0 };
  let payable = 0, ot = 0;
  for (let d = 1; d <= n; d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`;
    if (day < from || day > to) continue;
    const m = by.get(day), st = m ? m.status : '';
    if (m) { count[st]++; ot += m.ot_hours || 0; } else count.unmarked++;
    if (s.pay_type === 'month') payable += st === 'A' ? 0 : st === 'H' ? 0.5 : 1;
    else payable += st === 'P' || st === 'L' ? 1 : st === 'H' ? 0.5 : 0;
  }
  const base = s.pay_type === 'month' ? s.rate * payable / n : s.rate * payable;
  const otPay = ot * s.ot_rate;
  return { month, days: n, from: from <= to ? from : '', to, ...count, payable, ot_hours: Math.round(ot * 100) / 100,
    base: Math.round(base / 100) * 100, ot_pay: Math.round(otPay / 100) * 100, earned: Math.round((base + otPay) / 100) * 100 };
}

/* advance still to be recovered: advances given − advances cut from salaries */
const ADV_SQL = `SELECT staff_id, COALESCE(SUM(CASE WHEN kind = 'advance' THEN amount ELSE -advance_cut END), 0) AS due
  FROM staff_txns WHERE org_id = ? AND status = 'done'`;

export async function listStaff(c, month) {
  requireCan(c.user, 'finance');
  month = monthOf(month);
  const t = today(), n = daysIn(month);
  const [staff, marks, adv, paid] = await c.db.batch([
    c.db.prepare(`SELECT * FROM staff WHERE org_id = ? ORDER BY active DESC, name`).bind(c.org.id),
    c.db.prepare(`SELECT staff_id, date, status, ot_hours FROM attendance WHERE org_id = ? AND date BETWEEN ? AND ?`).bind(c.org.id, `${month}-01`, `${month}-${n}`),
    c.db.prepare(`${ADV_SQL} GROUP BY staff_id`).bind(c.org.id),
    c.db.prepare(`SELECT staff_id, id, amount FROM staff_txns WHERE org_id = ? AND kind = 'salary' AND status = 'done' AND month = ?`).bind(c.org.id, month),
  ]);
  const todayMarks = month === t.slice(0, 7) ? marks.results.filter((m) => m.date === t) : (await c.db.prepare(`SELECT staff_id, status, ot_hours FROM attendance WHERE org_id = ? AND date = ?`).bind(c.org.id, t).all()).results;
  return { month, today: t, rows: staff.results.map((s) => {
    const mine = marks.results.filter((m) => m.staff_id === s.id), pay = salaryFor(s, month, mine);
    const tm = todayMarks.find((m) => m.staff_id === s.id), a = adv.results.find((x) => x.staff_id === s.id), p = paid.results.find((x) => x.staff_id === s.id);
    return { ...staffOut(s), today: tm ? tm.status : '', today_ot: tm ? tm.ot_hours : 0, pay: { ...pay, base: R(pay.base), ot_pay: R(pay.ot_pay), earned: R(pay.earned) },
      advance_due: R(a ? a.due : 0), paid: p ? { id: p.id, amount: R(p.amount) } : null };
  }) };
}

export async function saveStaff(c, id, body) {
  requireCan(c.user, 'finance');
  const f = staffFields(body);
  checkIds(f);
  const stat = c.db.prepare(`UPDATE staff SET pf = ?, uan = ?, esi = ?, esi_no = ?, pt = ?, wage_pct = ? WHERE id = ? AND org_id = ?`);
  if (id) {
    await staffOf(c, id);
    await c.db.batch([c.db.prepare(`UPDATE staff SET name = ?, phone = ?, title = ?, pay_type = ?, rate = ?, ot_rate = ?, join_date = ?, notes = ?, active = ? WHERE id = ? AND org_id = ?`)
      .bind(f.name, f.phone, f.title, f.pay_type, f.rate, f.ot_rate, f.join_date, f.notes, body.active === false || body.active === 0 ? 0 : 1, id, c.org.id),
    stat.bind(f.pf, f.uan, f.esi, f.esi_no, f.pt, f.wage_pct, id, c.org.id),
    auditStatement(c, 'edit staff', f.name)]);
    return staffOut(await staffOf(c, id));
  }
  const n = await c.db.prepare(`SELECT COUNT(*) AS n FROM staff WHERE org_id = ?`).bind(c.org.id).first();
  if (n.n >= 500) throw bad('At most 500 staff in one business.');
  const r = await c.db.prepare(`INSERT INTO staff (org_id, name, phone, title, pay_type, rate, ot_rate, join_date, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(c.org.id, f.name, f.phone, f.title, f.pay_type, f.rate, f.ot_rate, f.join_date, f.notes, nowIso()).first();
  await stat.bind(f.pf, f.uan, f.esi, f.esi_no, f.pt, f.wage_pct, r.id, c.org.id).run();
  return staffOut(await staffOf(c, r.id));
}

/* marks: [{ staff_id, date?, status ('' clears), ot_hours? }] (date defaults to body.date or today) */
export async function markAttendance(c, body) {
  requireCan(c.user, 'finance');
  const marks = Array.isArray(body.marks) ? body.marks : [];
  if (!marks.length) throw bad('Nothing to mark.');
  if (marks.length > 600) throw bad('At most 600 marks at a time.');
  const def = body.date ? date(body.date) : today();
  if (def > today()) throw bad('Attendance cannot be marked for a future date.');
  const ids = [...new Set(marks.map((m) => +m.staff_id || 0))];
  const { results } = await c.db.prepare(`SELECT id, join_date FROM staff WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(c.org.id, ...ids).all();
  const known = new Map(results.map((s) => [s.id, s]));
  const st = [];
  for (const m of marks) {
    const s = known.get(+m.staff_id);
    if (!s) throw bad('Unknown staff member.');
    const d = m.date ? date(m.date) : def;
    if (d > today()) throw bad('Attendance cannot be marked for a future date.');
    const status = String(m.status || '').toUpperCase();
    if (!status) { st.push(c.db.prepare(`DELETE FROM attendance WHERE staff_id = ? AND date = ? AND org_id = ?`).bind(s.id, d, c.org.id)); continue; }
    if (!STATUS.includes(status)) throw bad('Mark P, A, H, L or O.');
    const ot = num(m.ot_hours, 'Overtime hours', { min: 0, max: 24, def: 0 });
    st.push(c.db.prepare(`INSERT INTO attendance (org_id, staff_id, date, status, ot_hours, marked_by) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(staff_id, date) DO UPDATE SET status = excluded.status, ot_hours = excluded.ot_hours, marked_by = excluded.marked_by`)
      .bind(c.org.id, s.id, d, status, ot, c.user.id));
  }
  await c.db.batch(st);
  return { ok: true, marked: st.length };
}

export async function staffDetail(c, id, month) {
  requireCan(c.user, 'finance');
  month = monthOf(month);
  const s = await staffOf(c, id), n = daysIn(month);
  const [marks, txns, adv] = await c.db.batch([
    c.db.prepare(`SELECT date, status, ot_hours FROM attendance WHERE staff_id = ? AND org_id = ? AND date BETWEEN ? AND ? ORDER BY date`).bind(id, c.org.id, `${month}-01`, `${month}-${n}`),
    c.db.prepare(`SELECT t.*, a.name AS account FROM staff_txns t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.org_id = ? AND t.staff_id = ? ORDER BY t.date DESC, t.id DESC LIMIT 200`).bind(c.org.id, id),
    c.db.prepare(`${ADV_SQL} AND staff_id = ?`).bind(c.org.id, id),
  ]);
  const pay = salaryFor(s, month, marks.results);
  const paid = txns.results.find((x) => x.kind === 'salary' && x.status === 'done' && x.month === month);
  return { staff: staffOut(s), month, marks: marks.results, pay: { ...pay, base: R(pay.base), ot_pay: R(pay.ot_pay), earned: R(pay.earned) },
    advance_due: R(adv.results[0] ? adv.results[0].due : 0), paid: paid ? { id: paid.id, amount: R(paid.amount) } : null,
    txns: txns.results.map((t) => ({ ...t, gross: R(t.gross), bonus: R(t.bonus), advance_cut: R(t.advance_cut), other_cut: R(t.other_cut), amount: R(t.amount), detail: JSON.parse(t.detail || '{}') })) };
}

export async function giveAdvance(c, id, body) {
  requireCan(c.user, 'finance');
  const s = await staffOf(c, id);
  const amount = toPaise(num(body.amount, 'Amount', { min: 1, max: 1e8 })), d = date(body.date || today());
  const from = await cashAccount(c.db, c.org.id, +body.paid_from);
  const txk = uid();
  await c.db.batch([
    c.db.prepare(`INSERT INTO staff_txns (org_id, staff_id, kind, date, amount, account_id, notes, created_by, created_at, txk) VALUES (?, ?, 'advance', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(c.org.id, s.id, d, amount, from.id, str(body.notes, 200), c.user.id, nowIso(), txk),
    ...journalStatements(c.db, c, { date: d, narration: `Advance to ${s.name}`, refType: 'ADV', refTxk: txk, refTable: 'staff_txns',
      lines: [D(c.sys.staff_adv, amount), C(from.id, amount)] }),
    auditStatement(c, 'staff advance', `${s.name} ${amount / 100}`),
  ]);
  return { ok: true };
}

/* pay one month's salary: body { month, bonus, advance_cut, other_cut, paid_from, date, notes } */
export async function paySalary(c, id, body) {
  requireCan(c.user, 'finance');
  const s = await staffOf(c, id), month = monthOf(body.month), n = daysIn(month);
  const [marks, adv, done] = await c.db.batch([
    c.db.prepare(`SELECT date, status, ot_hours FROM attendance WHERE staff_id = ? AND org_id = ? AND date BETWEEN ? AND ?`).bind(id, c.org.id, `${month}-01`, `${month}-${n}`),
    c.db.prepare(`${ADV_SQL} AND staff_id = ?`).bind(c.org.id, id),
    c.db.prepare(`SELECT id FROM staff_txns WHERE staff_id = ? AND month = ? AND kind = 'salary' AND status = 'done'`).bind(id, month),
  ]);
  if (done.results.length) throw bad(`${s.name}'s salary for ${month} is already paid. Cancel that payment first to pay it again.`);
  const pay = salaryFor(s, month, marks.results);
  if (!pay.from) throw bad(`${s.name} joined after ${month}.`);
  const gross = body.gross === undefined || body.gross === '' ? pay.earned : toPaise(num(body.gross, 'Salary', { min: 0, max: 1e9 }));
  const bonus = toPaise(num(body.bonus, 'Bonus', { min: 0, max: 1e9, def: 0 }));
  const due = adv.results[0] ? adv.results[0].due : 0;
  const advCut = toPaise(num(body.advance_cut, 'Advance to cut', { min: 0, max: 1e9, def: 0 }));
  if (advCut > due) throw bad(`Only ${R(due)} of advance is due from ${s.name}.`);
  const other = toPaise(num(body.other_cut, 'Other deduction', { min: 0, max: 1e9, def: 0 }));
  // PF / ESI / professional tax on what was earned this month (a salary typed by hand scales the month's pay)
  const scale = pay.earned > 0 ? gross / pay.earned : 1;
  const st = statutoryFor(s, { ...pay, base: Math.round(pay.base * scale), earned: gross }, ratesOf(c.org));
  const net = gross + bonus - advCut - other - st.employee;
  if (net < 0) throw bad('The deductions are more than the salary.');
  if (st.employee || st.employer) await ensureSysAccounts(c, STAT_ACCOUNTS);
  const from = await cashAccount(c.db, c.org.id, +body.paid_from);
  const d = date(body.date || today()), txk = uid();
  const salaryAcc = c.sys.salary || c.sys.misc_exp;
  const detail = { ...pay, base: pay.base, ot_pay: pay.ot_pay, earned: pay.earned, rate: s.rate, pay_type: s.pay_type, advance_left: due - advCut,
    stat: st.employee || st.employer ? { ...st, uan: s.uan || '', esi_no: s.esi_no || '' } : null };
  const S = c.sys;
  await c.db.batch([
    c.db.prepare(`INSERT INTO staff_txns (org_id, staff_id, kind, date, month, gross, bonus, advance_cut, other_cut, amount, account_id, detail, notes, created_by, created_at, txk)
        VALUES (?, ?, 'salary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(c.org.id, s.id, d, month, gross, bonus, advCut, other, net, from.id, JSON.stringify(detail), str(body.notes, 200), c.user.id, nowIso(), txk),
    // other deductions (fine, damage) stay with the business: the expense is only what was earned less them
    ...journalStatements(c.db, c, { date: d, narration: `Salary ${month}: ${s.name}`, refType: 'SAL', refTxk: txk, refTable: 'staff_txns',
      lines: [D(salaryAcc, gross + bonus - other), D(S.er_contrib, st.employer), C(c.sys.staff_adv, advCut),
        C(S.pf_payable, st.pf + st.eps + st.er_epf + st.edli + st.admin), C(S.esi_payable, st.esi + st.er_esi), C(S.pt_payable, st.pt), C(from.id, net)] }),
    auditStatement(c, 'salary', `${s.name} ${month} ${net / 100}`),
  ]);
  const row = await c.db.prepare(`SELECT id FROM staff_txns WHERE txk = ?`).bind(txk).first();
  return { ok: true, id: row.id, net: R(net) };
}

export async function cancelStaffTxn(c, txnId) {
  requireCan(c.user, 'finance');
  requireCancel(c.user);
  const t = await c.db.prepare(`SELECT t.*, s.name FROM staff_txns t JOIN staff s ON s.id = t.staff_id WHERE t.id = ? AND t.org_id = ?`).bind(txnId, c.org.id).first();
  if (!t) throw notFound('Payment not found.');
  if (t.status === 'cancelled') throw bad('Already cancelled.');
  if (t.kind === 'advance') {
    const adv = await c.db.prepare(`${ADV_SQL} AND staff_id = ?`).bind(c.org.id, t.staff_id).first();
    if (adv.due < t.amount) throw bad('Part of this advance was already cut from a salary. Cancel that salary first.');
  }
  const ref = t.kind === 'advance' ? 'ADV' : 'SAL';
  const { results: jls } = await c.db.prepare(`SELECT jl.* FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id WHERE j.org_id = ? AND j.ref_type = ? AND j.ref_id = ?`)
    .bind(c.org.id, ref, t.id).all();
  await c.db.batch([
    c.db.prepare(`UPDATE staff_txns SET status = 'cancelled' WHERE id = ? AND status = 'done'`).bind(t.id),
    ...journalStatements(c.db, c, { date: t.date, narration: `Cancelled ${t.kind} ${t.name}`, refType: ref + '-X', refId: t.id,
      lines: jls.map((l) => ({ account: l.account_id, amount: l.credit - l.debit })) }),
    auditStatement(c, `cancel ${t.kind}`, `${t.name} ${t.amount / 100}`),
  ]);
  return { ok: true };
}

/* one payslip */
export async function payslip(c, txnId) {
  requireCan(c.user, 'finance');
  const t = await c.db.prepare(`SELECT t.*, s.name, s.phone, s.title, s.pay_type, s.join_date FROM staff_txns t JOIN staff s ON s.id = t.staff_id
      WHERE t.id = ? AND t.org_id = ? AND t.kind = 'salary'`).bind(txnId, c.org.id).first();
  if (!t) throw notFound('Payslip not found.');
  const dt = JSON.parse(t.detail || '{}');
  return { id: t.id, name: t.name, phone: t.phone, title: t.title, pay_type: t.pay_type, month: t.month, date: t.date, status: t.status,
    gross: R(t.gross), bonus: R(t.bonus), advance_cut: R(t.advance_cut), other_cut: R(t.other_cut), net: R(t.amount), notes: t.notes,
    detail: { ...dt, base: R(dt.base || 0), ot_pay: R(dt.ot_pay || 0), earned: R(dt.earned || 0), rate: R(dt.rate || 0), advance_left: R(dt.advance_left || 0),
      stat: dt.stat ? Object.fromEntries(Object.entries(dt.stat).map(([k, v]) => [k, typeof v === 'number' && !['ncp'].includes(k) ? R(v) : v])) : null },
    org: { name: c.org.name, address: c.org.address, phone: c.org.phone, gstin: c.org.gstin } };
}

/* for the Today card: active staff not marked today, and last month's salaries not paid yet (first half of the month) */
export function todayStaffQueries(db, orgId) {
  const t = today(), first = `${t.slice(0, 7)}-01`;
  const d = new Date(`${first}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1);
  const last = d.toISOString().slice(0, 7);
  return [
    // only for a business that marks attendance (something marked in the last week)
    ['attendance', db.prepare(`SELECT COUNT(*) AS n, 0 AS v FROM staff s WHERE s.org_id = ? AND s.active = 1 AND s.join_date <= ?
      AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.staff_id = s.id AND a.date = ?)
      AND EXISTS (SELECT 1 FROM attendance b WHERE b.org_id = s.org_id AND b.date >= ?)`).bind(orgId, t, t, addDays(t, -7))],
    ['salary_due', db.prepare(`SELECT COUNT(*) AS n, 0 AS v FROM staff s WHERE s.org_id = ? AND s.active = 1 AND s.join_date < ? AND ? <= 15
      AND NOT EXISTS (SELECT 1 FROM staff_txns x WHERE x.staff_id = s.id AND x.kind = 'salary' AND x.status = 'done' AND x.month = ?)`).bind(orgId, first, +t.slice(8, 10), last)],
  ];
}

/* ---------- the month's statutory return: PF (ECR for the EPFO portal), ESI (upload sheet), professional tax ---------- */
async function monthSalaries(c, month) {
  const { results } = await c.db.prepare(`SELECT t.id, t.detail, t.gross, s.name, s.uan, s.esi_no FROM staff_txns t JOIN staff s ON s.id = t.staff_id
      WHERE t.org_id = ? AND t.kind = 'salary' AND t.status = 'done' AND t.month = ? ORDER BY s.name`).bind(c.org.id, month).all();
  return results.map((t) => { const d = JSON.parse(t.detail || '{}'); return { ...t, stat: d.stat || null, days: d.days, payable: d.payable }; }).filter((t) => t.stat);
}
export async function statutoryMonth(c, monthIn) {
  requireCan(c.user, 'finance');
  const month = monthOf(monthIn), rows = await monthSalaries(c, month);
  const sum = (k) => rows.reduce((a, r) => a + (r.stat[k] || 0), 0);
  const { results: paid } = await c.db.prepare(`SELECT kind, COALESCE(SUM(amount), 0) AS amount FROM stat_challans WHERE org_id = ? AND month = ? AND status = 'done' GROUP BY kind`)
    .bind(c.org.id, month).all();
  const { results: challans } = await c.db.prepare(`SELECT id, kind, date, amount, ref, status FROM stat_challans WHERE org_id = ? AND month = ? ORDER BY id`).bind(c.org.id, month).all();
  const paidOf = (k) => R((paid.find((p) => p.kind === k) || { amount: 0 }).amount);
  const pf = sum('pf') + sum('eps') + sum('er_epf') + sum('edli') + sum('admin'), esi = sum('esi') + sum('er_esi'), pt = sum('pt');
  return { month, rates: ratesOf(c.org), due_by: `${addDays(`${month}-01`, 31).slice(0, 7)}-15`,
    rows: rows.map((r) => ({ name: r.name, uan: r.stat.uan || r.uan, esi_no: r.stat.esi_no || r.esi_no, ncp: r.stat.ncp, ...Object.fromEntries(['gross_wages', 'epf_wages', 'eps_wages', 'edli_wages', 'esi_wages', 'pf', 'eps', 'er_epf', 'edli', 'admin', 'esi', 'er_esi', 'pt'].map((k) => [k, R(r.stat[k] || 0)])) })),
    totals: { pf: R(pf), esi: R(esi), pt: R(pt), pf_paid: paidOf('pf'), esi_paid: paidOf('esi'), pt_paid: paidOf('pt') },
    challans: challans.map((x) => ({ ...x, amount: R(x.amount) })),
    missing_uan: rows.filter((r) => (r.stat.pf || 0) > 0 && !(r.stat.uan || r.uan)).map((r) => r.name),
    missing_esi: rows.filter((r) => (r.stat.esi || 0) > 0 && !(r.stat.esi_no || r.esi_no)).map((r) => r.name) };
}
/* ECR 2.0 text: UAN#~#NAME#~#GROSS#~#EPF#~#EPS#~#EDLI#~#EE share#~#EPS#~#ER share (EPF − EPS)#~#NCP days#~#refund of advances */
export async function ecrFile(c, monthIn) {
  requireCan(c.user, 'finance');
  const month = monthOf(monthIn), rows = (await monthSalaries(c, month)).filter((r) => (r.stat.pf || 0) > 0);
  if (!rows.length) throw bad(`No PF on the salaries paid for ${month}.`);
  const miss = rows.filter((r) => !(r.stat.uan || r.uan));
  if (miss.length) throw bad(`Add the UAN of ${miss.map((r) => r.name).join(', ')} (Staff → edit) before the ECR.`);
  const W = (p) => String(Math.round((p || 0) / 100));
  const clean = (n) => String(n).toUpperCase().replace(/[^A-Z .]/g, ' ').replace(/\s+/g, ' ').trim();
  return rows.map((r) => [r.stat.uan || r.uan, clean(r.name), W(r.stat.gross_wages), W(r.stat.epf_wages), W(r.stat.eps_wages), W(r.stat.edli_wages),
    W(r.stat.pf), W(r.stat.eps), W(r.stat.er_epf), String(r.stat.ncp || 0), '0'].join('#~#')).join('\n');
}
/* ESI monthly contribution upload: IP number, IP name, days paid, total monthly wages, reason code, last working day */
export async function esiFile(c, monthIn) {
  requireCan(c.user, 'finance');
  const month = monthOf(monthIn), rows = (await monthSalaries(c, month)).filter((r) => (r.stat.esi || 0) > 0);
  if (!rows.length) throw bad(`No ESI on the salaries paid for ${month}.`);
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return ['IP Number,IP Name,No of Days for which wages paid/payable during the month,Total Monthly Wages,Reason Code for Zero workings days,Last Working Day',
    ...rows.map((r) => [q(r.stat.esi_no || r.esi_no || ''), q(r.name), Math.round(r.payable || 0), Math.round((r.stat.esi_wages || 0) / 100), '', ''].join(','))].join('\n');
}
/* paying the month's PF / ESI / professional tax challan: Dr the payable / Cr bank */
export async function payChallan(c, body) {
  requireCan(c.user, 'finance');
  const kind = oneOf(String(body.kind || ''), ['pf', 'esi', 'pt'], 'Challan');
  const month = monthOf(body.month), amount = toPaise(num(body.amount, 'Amount', { min: 1, max: 1e10 })), d = date(body.date || today());
  const from = await cashAccount(c.db, c.org.id, +body.paid_from);
  await ensureSysAccounts(c, STAT_ACCOUNTS);
  const acc = { pf: c.sys.pf_payable, esi: c.sys.esi_payable, pt: c.sys.pt_payable }[kind], txk = uid();
  const name = { pf: 'PF challan (EPFO)', esi: 'ESI challan', pt: 'Professional tax' }[kind];
  await c.db.batch([
    c.db.prepare(`INSERT INTO stat_challans (org_id, kind, month, date, amount, account_id, ref, created_by, created_at, txk) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(c.org.id, kind, month, d, amount, from.id, str(body.ref, 60), c.user.id, nowIso(), txk),
    ...journalStatements(c.db, c, { date: d, narration: `${name} ${month}${body.ref ? ' ' + str(body.ref, 60) : ''}`, refType: 'STAT', refTxk: txk, refTable: 'stat_challans',
      lines: [D(acc, amount), C(from.id, amount)] }),
    auditStatement(c, 'statutory challan', `${kind} ${month} ${amount / 100}`),
  ]);
  return { ok: true };
}
export async function cancelChallan(c, id) {
  requireCan(c.user, 'finance');
  requireCancel(c.user);
  const t = await c.db.prepare(`SELECT * FROM stat_challans WHERE id = ? AND org_id = ?`).bind(id, c.org.id).first();
  if (!t) throw notFound('Challan not found.');
  if (t.status === 'cancelled') throw bad('Already cancelled.');
  const { results: jls } = await c.db.prepare(`SELECT jl.* FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id WHERE j.org_id = ? AND j.ref_type = 'STAT' AND j.ref_id = ?`)
    .bind(c.org.id, t.id).all();
  await c.db.batch([
    c.db.prepare(`UPDATE stat_challans SET status = 'cancelled' WHERE id = ? AND status = 'done'`).bind(t.id),
    ...journalStatements(c.db, c, { date: t.date, narration: `Cancelled ${t.kind} challan ${t.month}`, refType: 'STAT-X', refId: t.id,
      lines: jls.map((l) => ({ account: l.account_id, amount: l.credit - l.debit })) }),
    auditStatement(c, 'cancel statutory challan', `${t.kind} ${t.month} ${t.amount / 100}`),
  ]);
  return { ok: true };
}
