/* Claims on a transporter or insurer for goods damaged or lost on the way: the write-offs made "Transporter / insurance
   will pay" (src/receive.js: Dr Transit & Insurance Claims / Cr Goods in Transit, Cr GST Input), followed up to the end.
   - details: whom the claim is against, their reference (LR / claim no.), the next follow-up date and a note;
   - money received, in parts if need be: Dr cash / bank / UPI, Cr Claims;
   - what will not be paid, closed as a loss: Dr Transit Loss & Damage, Cr Claims.
   Each step is a claim_entries row with its own journal and can be cancelled; the totals are kept on the write-off
   (received, closed), so a claim is open, partly settled, settled, or closed as a loss at a glance. */
import { bad, notFound, forbidden, str, nowIso, date, today, toPaise, num, uid } from './lib.js';
import { can, requireCancel, checkBackdate } from './auth.js';
import { auditStatement, journalStatements, cashAccount } from './engine.js';

const R = (p) => Math.round(p) / 100;
const STATES = { open: 'Not paid yet', partial: 'Partly paid', settled: 'Settled', rejected: 'Closed as loss' };
export function claimState(w) {
  const total = w.value + w.cgst + w.sgst + w.igst, due = Math.max(0, total - w.received - w.closed);
  return { total, due, state: due > 0 ? (w.received + w.closed > 0 ? 'partial' : 'open') : w.received > 0 ? 'settled' : 'rejected' };
}
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3);
const claimOut = (w, t) => {
  const s = claimState(w);
  return { id: w.id, number: w.number, date: w.date, bill_id: w.bill_id, bill_number: w.bill_number, supplier: w.supplier, reason: w.reason,
    against: w.against || '', claim_ref: w.claim_ref || '', follow_up: w.follow_up || '', claim_note: w.claim_note || '',
    total: R(s.total), received: R(w.received), closed: R(w.closed), due: R(s.due), state: s.state, state_text: STATES[s.state],
    age: daysBetween(w.date, t), late: !!(s.due > 0 && w.follow_up && w.follow_up <= t) };
};
const CLAIM_SQL = `SELECT w.*, d.number AS bill_number, p.name AS supplier FROM write_offs w JOIN docs d ON d.id = w.bill_id AND d.org_id = w.org_id
  LEFT JOIN parties p ON p.id = d.party_id`;
const mayWork = (u) => can(u, 'purchase') || can(u, 'finance');

/* GET /api/claims?status=open|closed|all */
export async function listClaims(c, status = 'open') {
  const t = today();
  const { results } = await c.db.prepare(`${CLAIM_SQL} WHERE w.org_id = ? AND w.mode = 'claim' AND w.status = 'done' ORDER BY w.date DESC, w.id DESC LIMIT 500`)
    .bind(c.org.id).all();
  const all = results.map((w) => claimOut(w, t));
  const open = all.filter((x) => x.due > 0);
  const rows = status === 'all' ? all : status === 'closed' ? all.filter((x) => x.due <= 0) : open;
  const sum = (list, k) => Math.round(list.reduce((s, x) => s + x[k] * 100, 0)) / 100;
  return { rows, totals: { open: open.length, due: sum(open, 'due'), late: open.filter((x) => x.late).length, received: sum(all, 'received'), closed: sum(all, 'closed') } };
}

async function claimRow(c, id) {
  const w = await c.db.prepare(`${CLAIM_SQL} WHERE w.id = ? AND w.org_id = ? AND w.mode = 'claim'`).bind(id, c.org.id).first();
  if (!w) throw notFound('Claim not found.');
  return w;
}

/* GET /api/claims/:id: the claim with every money received and closing */
export async function claimDetail(c, id) {
  const w = await claimRow(c, id);
  const [entries, lines] = await c.db.batch([
    c.db.prepare(`SELECT e.*, a.name AS account FROM claim_entries e LEFT JOIN accounts a ON a.id = e.account_id WHERE e.org_id = ? AND e.write_off_id = ? ORDER BY e.id`).bind(c.org.id, w.id),
    c.db.prepare(`SELECT wl.qty, wl.value, wl.cgst + wl.sgst + wl.igst AS gst, i.name AS item, i.unit FROM write_off_lines wl LEFT JOIN items i ON i.id = wl.item_id WHERE wl.write_off_id = ?`).bind(w.id),
  ]);
  return { ...claimOut(w, today()), cancelled: w.status === 'cancelled',
    entries: entries.results.map((e) => ({ id: e.id, kind: e.kind, date: e.date, amount: R(e.amount), account: e.account || '', note: e.note || '', status: e.status })),
    lines: lines.results.map((l) => ({ ...l, value: R(l.value), gst: R(l.gst) })) };
}

/* PUT /api/claims/:id { against, claim_ref, follow_up, claim_note } */
export async function saveClaim(c, id, body) {
  if (!mayWork(c.user)) throw forbidden();
  const w = await claimRow(c, id);
  const follow = body.follow_up ? date(body.follow_up, 'Follow-up date') : '';
  await c.db.batch([c.db.prepare(`UPDATE write_offs SET against = ?, claim_ref = ?, follow_up = ?, claim_note = ? WHERE id = ?`)
    .bind(str(body.against, 80), str(body.claim_ref, 40), follow, str(body.claim_note, 300), w.id),
  auditStatement(c, 'claim details', `${w.number}: ${str(body.against, 80)} ${str(body.claim_ref, 40)}`.slice(0, 300))]);
  return claimDetail(c, id);
}

/* POST /api/claims/:id/receive { date, amount, account_id, note }: money the transporter / insurer paid */
export async function claimReceipt(c, id, body) {
  if (!can(c.user, 'finance')) throw forbidden('Recording money needs the Money (finance) right.');
  const w = await claimRow(c, id);
  if (w.status !== 'done') throw bad('This claim was cancelled.');
  const { due } = claimState(w);
  const amount = toPaise(num(body.amount, 'Amount', { min: 0.01 }));
  if (amount > due) throw bad(`Only ₹${(due / 100).toFixed(2)} is still due on ${w.number}.`);
  const d = date(body.date);
  checkBackdate(c.user, d, today(), 'a receipt');
  if (d < w.date) throw bad(`The money cannot come before the claim (${w.date}).`);
  const acct = await cashAccount(c.db, c.org.id, +body.account_id);
  return entry(c, w, { kind: 'receipt', d, amount, account: acct.id, note: str(body.note, 200),
    narration: `Claim ${w.number} received${w.against ? ' from ' + w.against : ''}`, lines: [{ account: acct.id, amount }, { account: c.sys.claims, amount: -amount }] });
}

/* POST /api/claims/:id/close { date, note }: the rest will not be paid (rejected, or settled for less): it becomes our loss */
export async function closeClaim(c, id, body) {
  if (!can(c.user, 'finance')) throw forbidden('Closing a claim needs the Money (finance) right.');
  const w = await claimRow(c, id);
  if (w.status !== 'done') throw bad('This claim was cancelled.');
  const { due } = claimState(w);
  if (due <= 0) throw bad(`Nothing is due on ${w.number}.`);
  const d = date(body.date);
  checkBackdate(c.user, d, today(), 'a closing');
  if (d < w.date) throw bad(`The claim cannot be closed before it was made (${w.date}).`);
  if (!c.sys.transit_loss) throw bad('The Transit Loss & Damage account is missing in the chart of accounts.');
  return entry(c, w, { kind: 'loss', d, amount: due, account: null, note: str(body.note, 200),
    narration: `Claim ${w.number} closed as loss${body.note ? ': ' + str(body.note, 200) : ''}`, lines: [{ account: c.sys.transit_loss, amount: due }, { account: c.sys.claims, amount: -due }] });
}

async function entry(c, w, { kind, d, amount, account, note, narration, lines }) {
  if (!c.sys.claims) throw bad('The Transit & Insurance Claims account is missing in the chart of accounts.');
  const txk = uid(), col = kind === 'receipt' ? 'received' : 'closed';
  await c.db.batch([
    c.db.prepare(`INSERT INTO claim_entries (org_id, write_off_id, kind, date, amount, account_id, note, created_by, created_at, txk) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(c.org.id, w.id, kind, d, amount, account, note, c.user.id, nowIso(), txk),
    c.db.prepare(`UPDATE write_offs SET ${col} = ${col} + ? WHERE id = ?`).bind(amount, w.id),
    ...journalStatements(c.db, c, { date: d, narration, refType: 'CLAIM', refTxk: txk, refTable: 'claim_entries', lines }),
    auditStatement(c, kind === 'receipt' ? 'claim received' : 'claim closed', `${w.number}: ${amount / 100}`),
  ]);
  return claimDetail(c, w.id);
}

/* POST /api/claim-entries/:id/cancel: a receipt or closing entered by mistake */
export async function cancelClaimEntry(c, id) {
  if (!can(c.user, 'finance')) throw forbidden();
  requireCancel(c.user);
  const e = await c.db.prepare(`SELECT * FROM claim_entries WHERE id = ? AND org_id = ?`).bind(id, c.org.id).first();
  if (!e) throw notFound('Entry not found.');
  if (e.status === 'cancelled') throw bad('Already cancelled.');
  const { results: jls } = await c.db.prepare(`SELECT jl.* FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id WHERE j.org_id = ? AND j.ref_type = 'CLAIM' AND j.ref_id = ?`)
    .bind(c.org.id, e.id).all();
  const col = e.kind === 'receipt' ? 'received' : 'closed';
  await c.db.batch([
    c.db.prepare(`UPDATE claim_entries SET status = 'cancelled' WHERE id = ? AND status = 'done'`).bind(e.id),
    c.db.prepare(`UPDATE write_offs SET ${col} = MAX(0, ${col} - ?) WHERE id = ?`).bind(e.amount, e.write_off_id),
    ...journalStatements(c.db, c, { date: e.date, narration: 'Cancelled claim entry', refType: 'CLAIM-X', refId: e.id,
      lines: jls.map((l) => ({ account: l.account_id, party: l.party_id, amount: l.credit - l.debit })) }),
    auditStatement(c, 'cancel claim entry', `${e.kind} ${e.amount / 100}`),
  ]);
  return claimDetail(c, e.write_off_id);
}
