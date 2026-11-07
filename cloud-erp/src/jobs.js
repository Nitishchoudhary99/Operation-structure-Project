/* Repair & service job cards (mobile / electronics / AC / two-wheeler / computer repair, tailoring, any job-work counter).
   Intake at the counter: the customer, the device or vehicle with its IMEI / serial / number plate, the problem, what was
   handed over with it and its condition, the estimate, an advance (a real receipt in the books) and the promised date.
   Then: received → checking → waiting for parts → ready → delivered (or cancelled). Each step can go to the customer on
   WhatsApp, the job slip prints for the customer, and the bill is an ordinary sales invoice made from the job (parts
   from stock + labour), which the job remembers. */
import { bad, notFound, forbidden, str, num, nowIso, today, date, toPaise, counterStatements, counterValueSql } from './lib.js';
import { can, canView } from './auth.js';
import { auditStatement, createPayment } from './engine.js';

export const JOB_STATES = ['received', 'checking', 'waiting', 'ready', 'delivered', 'cancelled'];
const R = (p) => Math.round(p) / 100;
const mayWork = (u) => can(u, 'sales');
const jobOut = (j) => ({ ...j, estimate: R(j.estimate), advance: R(j.advance), inv_total: j.inv_total ? R(j.inv_total) : 0 });
const JOB_SQL = `SELECT j.*, p.name AS party, p.phone, d.number AS invoice, d.total AS inv_total
  FROM job_cards j LEFT JOIN parties p ON p.id = j.party_id LEFT JOIN docs d ON d.id = j.inv_id AND d.org_id = j.org_id`;

/* GET /api/jobs?status=open|all|<state>&q= */
export async function listJobs(c, status = 'open', q = '') {
  if (!canView(c.user, 'sales')) throw forbidden('Your role cannot see job cards.');
  const t = today(), f = str(q, 60);
  const { results } = await c.db.prepare(`${JOB_SQL} WHERE j.org_id = ?1
      AND (?2 = '' OR j.number LIKE ?3 OR p.name LIKE ?3 OR p.phone LIKE ?3 OR j.serial LIKE ?3 OR j.device LIKE ?3)
      ORDER BY CASE j.status WHEN 'ready' THEN 0 WHEN 'received' THEN 1 WHEN 'checking' THEN 2 WHEN 'waiting' THEN 3 ELSE 4 END, j.promised, j.id DESC LIMIT 500`)
    .bind(c.org.id, f, `%${f}%`).all();
  const counts = Object.fromEntries(JOB_STATES.map((s) => [s, 0]));
  for (const j of results) counts[j.status]++;
  const open = (j) => !['delivered', 'cancelled'].includes(j.status);
  const rows = results.filter((j) => (status === 'all' ? true : status === 'open' ? open(j) : j.status === status)).map((j) => ({ ...jobOut(j), late: open(j) && j.status !== 'ready' && !!j.promised && j.promised < t }));
  return { rows, counts, late: rows.filter((r) => r.late).length };
}
export async function jobDetail(c, id) {
  if (!canView(c.user, 'sales')) throw forbidden('Your role cannot see job cards.');
  const j = await c.db.prepare(`${JOB_SQL} WHERE j.id = ? AND j.org_id = ?`).bind(id, c.org.id).first();
  if (!j) throw notFound('Job card not found.');
  return jobOut(j);
}

const fields = (b) => ({
  device: str(b.device, 120), serial: str(b.serial, 60), problem: String(b.problem ?? '').replace(/\r/g, '').slice(0, 600).trim(),
  accessories: str(b.accessories, 200), condition: str(b.condition, 200), tech: str(b.tech, 60), notes: String(b.notes ?? '').replace(/\r/g, '').slice(0, 600).trim(),
  estimate: toPaise(num(b.estimate, 'Estimate', { min: 0, max: 1e8, def: 0 })), promised: b.promised ? date(b.promised, 'Promised date') : '',
});

/* POST /api/jobs: a new job at the counter. The customer is an existing party, or a new one from name + mobile. */
export async function createJob(c, b) {
  if (!mayWork(c.user)) throw forbidden('Your role cannot open job cards.');
  const f = fields(b);
  if (!f.device) throw bad('What is being repaired? Type the device or vehicle.');
  if (!f.problem) throw bad('Type the problem the customer told you.');
  let party = b.party_id ? await c.db.prepare(`SELECT id, name, kind FROM parties WHERE id = ? AND org_id = ?`).bind(+b.party_id, c.org.id).first() : null;
  if (b.party_id && !party) throw bad('Customer not found.');
  if (party && party.kind === 'supplier') throw bad(`${party.name} is a supplier, not a customer.`);
  if (!party) {
    const name = str(b.name, 120), phone = str(b.phone, 15).replace(/[^\d+]/g, '');
    if (!name) throw bad('Choose the customer, or type their name and mobile number.');
    if (phone && !/^\+?\d{10,13}$/.test(phone)) throw bad('Mobile number looks wrong.');
    // the same mobile is the same customer; the same name with another mobile gets the mobile's last digits (names are unique)
    const same = phone ? await c.db.prepare(`SELECT id, name, kind FROM parties WHERE org_id = ? AND phone = ? AND kind != 'supplier' LIMIT 1`).bind(c.org.id, phone).first() : null;
    const named = same ? null : await c.db.prepare(`SELECT id, name, kind, phone FROM parties WHERE org_id = ? AND name = ?`).bind(c.org.id, name).first();
    if (same) party = same;
    else if (named && named.kind !== 'supplier' && (!phone || !named.phone || named.phone === phone)) party = named;
    else {
      const nm = named ? `${name} (${phone.slice(-4) || 'new'})`.slice(0, 120) : name;
      party = await c.db.prepare(`INSERT INTO parties (org_id, name, kind, phone, state, created_at) VALUES (?, ?, 'customer', ?, ?, ?) RETURNING id, name`)
        .bind(c.org.id, nm, phone, c.org.state || '', nowIso()).first();
    }
  }
  const advance = toPaise(num(b.advance, 'Advance', { min: 0, max: 1e8, def: 0 }));
  if (advance && !b.account_id) throw bad('Choose where the advance was paid: cash, UPI or bank.');
  const now = nowIso(), d = today();
  const [, ins] = await c.db.batch([counterStatements(c.db, c.org.id, 'JOB'),
    c.db.prepare(`INSERT INTO job_cards (org_id, number, date, party_id, device, serial, problem, accessories, condition, estimate, advance, promised, status, tech, notes,
        created_by, created_at, updated_at) VALUES (?, ${counterValueSql}, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'received', ?, ?, ?, ?, ?) RETURNING id, number`)
      .bind(c.org.id, 'JOB-%05d', c.org.id, 'JOB', d, party.id, f.device, f.serial, f.problem, f.accessories, f.condition, f.estimate, f.promised, f.tech, f.notes, c.user.id, now, now)]);
  const job = ins.results[0];
  await c.db.batch([auditStatement(c, 'job card', `${job.number}: ${f.device} for ${party.name}`.slice(0, 300))]);
  // the advance is a receipt from the customer (cash / UPI / bank), so the books and the khata show it at once
  if (advance) {
    try {
      await createPayment(c, { kind: 'receipt', party_id: party.id, account_id: b.account_id, amount: advance / 100, date: d, notes: `Advance for job ${job.number}` });
      await c.db.prepare(`UPDATE job_cards SET advance = ? WHERE id = ? AND org_id = ?`).bind(advance, job.id, c.org.id).run();
    } catch (e) {
      throw bad(`Job ${job.number} is saved, but the advance was not recorded: ${e.message} Record it from Receipts.`);
    }
  }
  return jobDetail(c, job.id);
}

/* PUT /api/jobs/:id  { action: 'status', status } | { action: 'edit', ...fields } | { action: 'bill', inv_id } */
export async function updateJob(c, id, b) {
  if (!mayWork(c.user)) throw forbidden('Your role cannot change job cards.');
  const j = await c.db.prepare(`SELECT * FROM job_cards WHERE id = ? AND org_id = ?`).bind(id, c.org.id).first();
  if (!j) throw notFound('Job card not found.');
  const save = async (sets, vals, what) => {
    await c.db.batch([c.db.prepare(`UPDATE job_cards SET ${sets}, updated_at = ? WHERE id = ? AND org_id = ?`).bind(...vals, nowIso(), j.id, c.org.id),
      auditStatement(c, 'job card', `${j.number}: ${what}`.slice(0, 300))]);
  };
  const action = String(b.action || '');
  if (action === 'status') {
    const s = String(b.status || '');
    if (!JOB_STATES.includes(s)) throw bad('Unknown job status.');
    if (j.status === 'delivered' && s !== 'delivered') throw bad(`${j.number} is already delivered.`);
    if (j.status === 'cancelled') throw bad(`${j.number} is cancelled.`);
    await save('status = ?', [s], `status ${s}`);
  } else if (action === 'edit') {
    if (['delivered', 'cancelled'].includes(j.status)) throw bad(`${j.number} is closed.`);
    const f = fields({ ...j, estimate: R(j.estimate), ...b });
    if (!f.device || !f.problem) throw bad('Device and problem cannot be empty.');
    await save('device = ?, serial = ?, problem = ?, accessories = ?, condition = ?, tech = ?, notes = ?, estimate = ?, promised = ?',
      [f.device, f.serial, f.problem, f.accessories, f.condition, f.tech, f.notes, f.estimate, f.promised], 'details changed');
  } else if (action === 'bill') {
    const inv = await c.db.prepare(`SELECT id, number, party_id, status FROM docs WHERE id = ? AND org_id = ? AND type = 'INV'`).bind(+b.inv_id || 0, c.org.id).first();
    if (!inv || inv.status === 'cancelled') throw bad('Invoice not found.');
    if (inv.party_id !== j.party_id) throw bad('That invoice is for another customer.');
    await save(`inv_id = ?, status = CASE WHEN status IN ('delivered', 'cancelled') THEN status ELSE 'ready' END`, [inv.id], `billed ${inv.number}`);
  } else throw bad('Unknown action.');
  return jobDetail(c, j.id);
}
