/* Recurring invoices and bills: "make this invoice every month" (rent, AMC, retainers, tuition, monthly supply).
   A schedule points at a source document. Every morning the Worker's cron (and the owner's "Make due ones now")
   creates the next document from the source's party and lines through the normal createDoc(), dated the
   scheduled day, as the user who set the schedule up, so stock, GST, books and plan limits work exactly as when
   it is typed by hand. A failure (plan limit, deleted party) is kept on the schedule and tried again next day. */
import { bad, notFound, str, date, today, nowIso, oneOf } from './lib.js';
import { USER_SQL, requireCan } from './auth.js';
import { DOC_TYPES, SYS_SQL, sysMap, createDoc, auditStatement } from './engine.js';
import { seatBlocked } from './saas.js';

export const RECURRING_TYPES = ['INV', 'BILL'];
export const EVERY = ['week', 'month', 'quarter', 'year'];
const MAX_PER_RUN = 50;

/* The next date of a schedule. Months keep the anchor day (31st -> 28/29 Feb -> 31 Mar), so they never drift. */
export function advance(d, every, anchor) {
  const [y, m, day] = d.split('-').map(Number);
  if (every === 'week') return new Date(Date.UTC(y, m - 1, day + 7)).toISOString().slice(0, 10);
  const add = every === 'month' ? 1 : every === 'quarter' ? 3 : 12;
  const first = new Date(Date.UTC(y, m - 1 + add, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(anchor || day, last))).toISOString().slice(0, 10);
}

const srcDoc = (db, orgId, id) => db.prepare(`SELECT * FROM docs WHERE id = ? AND org_id = ?`).bind(id, orgId).first();

/* POST /api/docs/:id/recurring { every, next_on?, ends_on? } */
export async function createRecurring(c, id) {
  const d = await srcDoc(c.db, c.org.id, id);
  if (!d) throw notFound('Document not found.');
  if (!RECURRING_TYPES.includes(d.type)) throw bad('Only invoices and purchase bills can repeat by themselves.');
  if (d.status === 'cancelled') throw bad('This document is cancelled.');
  requireCan(c.user, DOC_TYPES[d.type].side === 'sales' ? 'sales' : 'purchase');
  const every = oneOf(String(c.body.every || 'month'), EVERY, 'Repeat');
  const next = c.body.next_on ? date(c.body.next_on, 'First date') : advance(today(), every);
  if (next < today()) throw bad('The first date cannot be in the past.');
  const ends = c.body.ends_on ? date(c.body.ends_on, 'End date') : null;
  if (ends && ends < next) throw bad('The end date is before the first date.');
  const open = await c.db.prepare(`SELECT COUNT(*) AS n FROM recurring WHERE org_id = ? AND active = 1`).bind(c.org.id).first();
  if (open.n >= 200) throw bad('You can have up to 200 active schedules. Stop one you no longer need.');
  const r = await c.db.prepare(`INSERT INTO recurring (org_id, src_doc_id, every, anchor_day, next_on, ends_on, active, created_by, created_at, runs)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0) RETURNING id`).bind(c.org.id, d.id, every, +next.slice(8, 10), next, ends, c.user.id, nowIso()).first();
  await c.db.batch([auditStatement(c, 'recurring on', `${d.number} every ${every} from ${next}`)]);
  return r.id;
}

export async function listRecurring(c) {
  const { results } = await c.db.prepare(`SELECT r.id, r.every, r.next_on, r.ends_on, r.active, r.runs, r.last_run_on, r.last_error, r.src_doc_id,
      d.type, d.number, d.total, p.name AS party, l.number AS last_number, l.id AS last_doc_id
    FROM recurring r JOIN docs d ON d.id = r.src_doc_id LEFT JOIN parties p ON p.id = d.party_id LEFT JOIN docs l ON l.id = r.last_doc_id
    WHERE r.org_id = ? ORDER BY r.active DESC, r.next_on`).bind(c.org.id).all();
  return results;
}

export async function stopRecurring(c, id) {
  const r = await c.db.prepare(`SELECT r.*, d.type, d.number FROM recurring r JOIN docs d ON d.id = r.src_doc_id WHERE r.id = ? AND r.org_id = ?`).bind(id, c.org.id).first();
  if (!r) throw notFound('Schedule not found.');
  requireCan(c.user, DOC_TYPES[r.type].side === 'sales' ? 'sales' : 'purchase');
  await c.db.batch([c.db.prepare(`UPDATE recurring SET active = 0 WHERE id = ?`).bind(id), auditStatement(c, 'recurring off', r.number)]);
}

/* One schedule: make the document, then move the schedule on. Returns the new document id, or null. */
async function runOne(env, r, day) {
  const db = env.DB;
  const org = await db.prepare(`SELECT * FROM orgs WHERE id = ?`).bind(r.org_id).first();
  let user = await db.prepare(USER_SQL).bind(r.created_by).first();
  if (!user || !user.active || user.org_id !== r.org_id || seatBlocked(org, user)) user = await db.prepare(USER_SQL.replace(/WHERE u\.id = \?/, `WHERE u.org_id = ? AND u.role = 'owner' AND u.active = 1`)).bind(r.org_id).first();
  const fail = (msg) => db.prepare(`UPDATE recurring SET last_error = ?, last_run_on = ? WHERE id = ?`).bind(str(msg, 300), day, r.id).run();
  if (!org || !user) { await fail('No active user can make this document.'); return null; }
  const src = await srcDoc(db, r.org_id, r.src_doc_id);
  if (!src) { await db.prepare(`UPDATE recurring SET active = 0, last_error = 'The original document is gone.' WHERE id = ?`).bind(r.id).run(); return null; }
  const { results: lines } = await db.prepare(`SELECT item_id, description, qty, rate, discount_pct, gst_rate FROM doc_lines WHERE doc_id = ? ORDER BY id`).bind(src.id).all();
  const sys = sysMap((await db.prepare(SYS_SQL).bind(r.org_id).all()).results);
  const ctx = { db, org, user, sys, body: {} };
  Object.defineProperty(ctx, 'env', { value: env, enumerable: false });
  try {
    const made = await createDoc(ctx, { type: src.type, party_id: src.party_id, warehouse_id: src.warehouse_id, date: r.next_on, notes: src.notes || '', design: src.design || undefined,
      extra: src.extra ? JSON.parse(src.extra) : undefined, lines: lines.map((l) => ({ ...l, rate: l.rate / 100 })) });   // rates are stored in paise
    const next = advance(r.next_on, r.every, r.anchor_day);
    const done = r.ends_on && next > r.ends_on;
    await db.batch([
      db.prepare(`UPDATE recurring SET next_on = ?, last_doc_id = ?, last_run_on = ?, runs = runs + 1, last_error = NULL, active = ? WHERE id = ?`).bind(next, made.id, day, done ? 0 : 1, r.id),
      auditStatement(ctx, 'recurring made', `${src.number} -> new ${src.type} for ${r.next_on}`),
    ]);
    return made.id;
  } catch (e) {
    await fail(e && e.message ? e.message : 'Could not make the document.');
    return null;
  }
}

/* Every schedule due on or before today (one document per schedule per run, so a long gap catches up a day at a
   time instead of flooding the books). orgId limits the run to one business ("Make due ones now"). */
export async function runDue(env, orgId) {
  const day = today();
  const q = orgId
    ? env.DB.prepare(`SELECT * FROM recurring WHERE active = 1 AND next_on <= ? AND org_id = ? ORDER BY next_on LIMIT ${MAX_PER_RUN}`).bind(day, orgId)
    : env.DB.prepare(`SELECT * FROM recurring WHERE active = 1 AND next_on <= ? AND (last_run_on IS NULL OR last_run_on < ?) ORDER BY next_on LIMIT ${MAX_PER_RUN}`).bind(day, day);
  const { results } = await q.all();
  let made = 0;
  for (const r of results) if (await runOne(env, r, day)) made++;
  return { due: results.length, made };
}
