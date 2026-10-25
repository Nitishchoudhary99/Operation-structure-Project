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
import { journalStatements, auditStatement, cashAccount } from './engine.js';

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
});
const staffOut = (s) => ({ ...s, rate: R(s.rate), ot_rate: R(s.ot_rate) });

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
  if (id) {
    await staffOf(c, id);
    await c.db.batch([c.db.prepare(`UPDATE staff SET name = ?, phone = ?, title = ?, pay_type = ?, rate = ?, ot_rate = ?, join_date = ?, notes = ?, active = ? WHERE id = ? AND org_id = ?`)
      .bind(f.name, f.phone, f.title, f.pay_type, f.rate, f.ot_rate, f.join_date, f.notes, body.active === false || body.active === 0 ? 0 : 1, id, c.org.id),
    auditStatement(c, 'edit staff', f.name)]);
    return staffOut(await staffOf(c, id));
  }
  const n = await c.db.prepare(`SELECT COUNT(*) AS n FROM staff WHERE org_id = ?`).bind(c.org.id).first();
  if (n.n >= 500) throw bad('At most 500 staff in one business.');
  const r = await c.db.prepare(`INSERT INTO staff (org_id, name, phone, title, pay_type, rate, ot_rate, join_date, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(c.org.id, f.name, f.phone, f.title, f.pay_type, f.rate, f.ot_rate, f.join_date, f.notes, nowIso()).first();
  return staffOut(r);
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
  const net = gross + bonus - advCut - other;
  if (net < 0) throw bad('The deductions are more than the salary.');
  const from = await cashAccount(c.db, c.org.id, +body.paid_from);
  const d = date(body.date || today()), txk = uid();
  const salaryAcc = c.sys.salary || c.sys.misc_exp;
  const detail = { ...pay, base: pay.base, ot_pay: pay.ot_pay, earned: pay.earned, rate: s.rate, pay_type: s.pay_type, advance_left: due - advCut };
  await c.db.batch([
    c.db.prepare(`INSERT INTO staff_txns (org_id, staff_id, kind, date, month, gross, bonus, advance_cut, other_cut, amount, account_id, detail, notes, created_by, created_at, txk)
        VALUES (?, ?, 'salary', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(c.org.id, s.id, d, month, gross, bonus, advCut, other, net, from.id, JSON.stringify(detail), str(body.notes, 200), c.user.id, nowIso(), txk),
    // other deductions (fine, damage) stay with the business: the expense is only what was earned less them
    ...journalStatements(c.db, c, { date: d, narration: `Salary ${month}: ${s.name}`, refType: 'SAL', refTxk: txk, refTable: 'staff_txns',
      lines: [D(salaryAcc, gross + bonus - other), C(c.sys.staff_adv, advCut), C(from.id, net)] }),
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
    detail: { ...dt, base: R(dt.base || 0), ot_pay: R(dt.ot_pay || 0), earned: R(dt.earned || 0), rate: R(dt.rate || 0), advance_left: R(dt.advance_left || 0) },
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
