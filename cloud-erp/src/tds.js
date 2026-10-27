/* TDS (income tax deducted at source). On a supplier payment the owner picks the section (194C contractor, 194J
   professional, 194I rent, 194H commission, 194Q goods ...): the bill is settled in full, the supplier gets the rest and
   the TDS goes to "TDS Payable" (src/engine.js paymentStatements). This screen lists what was deducted, by section and
   party (with the PAN from the GSTIN) for the quarterly return (26Q), records the challan when it is paid to the
   government (by the 7th of the next month), and lists what customers deducted from what they paid us (to claim in
   the income-tax return; it shows in Form 26AS). */
import { bad, str, num, today, nowIso, date as isoDate } from './lib.js';
import { requireCan, checkBackdate } from './auth.js';
import { journalStatements, auditStatement, cashAccount, ensureSysAccounts, TDS_ACCOUNTS } from './engine.js';
import { period } from './reports.js';

/* the usual rates (change them on the payment when a case differs; ask your CA for the current ones) */
export const TDS_SECTIONS = [
  ['194C', 'Contractor: individual / HUF', 1], ['194C', 'Contractor: company / firm', 2], ['194J', 'Professional fees', 10], ['194J', 'Technical services / royalty', 2],
  ['194I', 'Rent: land, building, furniture', 10], ['194I', 'Rent: plant & machinery', 2], ['194H', 'Commission / brokerage', 2], ['194Q', 'Purchase of goods', 0.1],
  ['194A', 'Interest (not bank)', 10],
];
const pan = (gstin) => (/^\d{2}[A-Z]{5}\d{4}[A-Z]/.test(gstin || '') ? gstin.slice(2, 12) : '');
const R = (p) => Math.round(p) / 100;

export async function tdsReport(c, q) {
  requireCan(c.user, 'finance');
  const { from, to } = period(c.org, q);
  const [paid, got, ch, bal] = await c.db.batch([
    c.db.prepare(`SELECT p.id, p.number, p.date, p.amount, p.tds, p.tds_section, pt.name AS party, pt.gstin FROM payments p JOIN parties pt ON pt.id = p.party_id
      WHERE p.org_id = ? AND p.kind = 'payment' AND p.tds > 0 AND p.date BETWEEN ? AND ? AND p.notes NOT LIKE '[void]%' ORDER BY p.date, p.id`).bind(c.org.id, from, to),
    c.db.prepare(`SELECT p.id, p.number, p.date, p.amount, p.tds, pt.name AS party FROM payments p JOIN parties pt ON pt.id = p.party_id
      WHERE p.org_id = ? AND p.kind = 'receipt' AND p.tds > 0 AND p.date BETWEEN ? AND ? AND p.notes NOT LIKE '[void]%' ORDER BY p.date, p.id`).bind(c.org.id, from, to),
    c.db.prepare(`SELECT id, date, amount, challan_no, section, notes FROM tds_challans WHERE org_id = ? AND date BETWEEN ? AND ? ORDER BY date, id`).bind(c.org.id, from, to),
    c.db.prepare(`SELECT COALESCE(SUM(cr - dr), 0) AS b FROM acct_month WHERE org_id = ? AND account_id = (SELECT id FROM accounts WHERE org_id = ? AND sys = 'tds_payable')`).bind(c.org.id, c.org.id),
  ]);
  const deducted = paid.results.map((x) => ({ id: x.id, number: x.number, date: x.date, party: x.party, pan: pan(x.gstin), section: x.tds_section, gross: R(x.amount), tds: R(x.tds) }));
  const bySection = {};
  for (const x of deducted) { const s = bySection[x.section] || (bySection[x.section] = { section: x.section, count: 0, gross: 0, tds: 0 }); s.count++; s.gross += x.gross; s.tds += x.tds; }
  return { from, to, deducted, by_section: Object.values(bySection).map((s) => ({ ...s, gross: Math.round(s.gross * 100) / 100, tds: Math.round(s.tds * 100) / 100 })),
    by_customers: got.results.map((x) => ({ id: x.id, number: x.number, date: x.date, party: x.party, gross: R(x.amount), tds: R(x.tds) })),
    challans: ch.results.map((x) => ({ ...x, amount: R(x.amount) })), payable: R(bal.results[0].b), sections: TDS_SECTIONS, due: dueDate() };
}
/* TDS deducted in a month is deposited by the 7th of the next month (March: 30 April) */
export function dueDate(d = today()) {
  const [y, m] = d.split('-').map(Number);
  return m === 3 ? `${y}-04-30` : new Date(Date.UTC(y, m, 7)).toISOString().slice(0, 10);
}

/* POST /api/tds/challan { date, amount, account_id, challan_no, section? }: TDS paid to the government */
export async function payChallan(c, b) {
  requireCan(c.user, 'finance');
  const d = isoDate(b.date, 'Date');
  checkBackdate(c.user, d, today(), 'a challan');
  const amount = Math.round(num(b.amount, 'Amount', { min: 0.01, max: 1e10 }) * 100);
  const bank = await cashAccount(c.db, c.org.id, +b.account_id);
  const no = str(b.challan_no, 40);
  const sys = await ensureSysAccounts(c, TDS_ACCOUNTS);
  const r = await c.db.prepare(`INSERT INTO tds_challans (org_id, date, amount, challan_no, section, account_id, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(c.org.id, d, amount, no, str(b.section, 12).toUpperCase(), bank.id, str(b.notes, 200), c.user.id, nowIso()).first();
  await c.db.batch([...journalStatements(c.db, c, { date: d, narration: `TDS paid to government${no ? ', challan ' + no : ''}`, refType: 'TDSC', refId: r.id,
    lines: [{ account: sys.tds_payable, amount }, { account: bank.id, amount: -amount }] }), auditStatement(c, 'tds challan', `${no} ${amount / 100}`)]);
  return { id: r.id };
}
