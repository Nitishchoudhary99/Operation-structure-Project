/* Recurring invoices and bills: "make this invoice every month" (rent, AMC, retainers, tuition, society maintenance,
   monthly supply). A schedule keeps its own copy of the lines (taken from the invoice it was made from, and changed
   later without touching that invoice), and its own customer, so one invoice can repeat for a whole class or building.
   Every morning the Worker's cron (and the owner's "Make due ones now") creates the next document through the normal
   createDoc(), dated the scheduled day, as the user who set the schedule up, so stock, GST, books and plan limits work
   exactly as when it is typed by hand. The new bill says which period it is for, a yearly price rise (rent) is applied
   on its day, and the bill goes to the customer: on WhatsApp by itself where automatic WhatsApp is on, otherwise it
   waits under "To send" for one tap. A failure (plan limit, deleted party) is kept on the schedule and tried again
   next day. */
import { bad, notFound, str, date, today, nowIso, oneOf, num, GST_RATES } from './lib.js';
import { USER_SQL, requireCan, randomHex } from './auth.js';
import { DOC_TYPES, SYS_SQL, sysMap, createDoc, auditStatement } from './engine.js';
import { seatBlocked, hasFeature } from './saas.js';
import { waConfigured, waNumber, sendReminder, sendText, windowOpen } from './autowa.js';

export const RECURRING_TYPES = ['INV', 'BILL'];
export const EVERY = ['week', 'month', 'quarter', 'year'];
export const SEND = ['auto', 'ask', 'off'];        // to the customer: by itself on WhatsApp, "To send" for one tap, not at all
const MAX_PER_RUN = 50, MAX_ACTIVE = 500;

/* The next date of a schedule. Months keep the anchor day (31st -> 28/29 Feb -> 31 Mar), so they never drift. */
export function advance(d, every, anchor) {
  const [y, m, day] = d.split('-').map(Number);
  if (every === 'week') return new Date(Date.UTC(y, m - 1, day + 7)).toISOString().slice(0, 10);
  const add = every === 'month' ? 1 : every === 'quarter' ? 3 : 12;
  const first = new Date(Date.UTC(y, m - 1 + add, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(anchor || day, last))).toISOString().slice(0, 10);
}

/* What the bill of date d is for, printed on it: "November 2026", "Oct–Dec 2026", "Apr 2026 – Mar 2027", "27 Oct – 2 Nov 2026" */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function periodOf(d, every) {
  const [y, m, day] = d.split('-').map(Number);
  if (every === 'week') {
    const e = new Date(Date.UTC(y, m - 1, day + 6));
    return `${day} ${MON[m - 1]} – ${e.getUTCDate()} ${MON[e.getUTCMonth()]} ${e.getUTCFullYear()}`;
  }
  if (every === 'month') return `${MONTH[m - 1]} ${y}`;
  const e = new Date(Date.UTC(y, m - 1 + (every === 'quarter' ? 2 : 11), 1));
  return e.getUTCFullYear() === y ? `${MON[m - 1]}–${MON[e.getUTCMonth()]} ${y}` : `${MON[m - 1]} ${y} – ${MON[e.getUTCMonth()]} ${e.getUTCFullYear()}`;
}
const EVERY_WORD = { week: 'weekly', month: 'monthly', quarter: 'quarterly', year: 'yearly' };

/* a schedule's lines, in rupees: [{ item_id, description, qty, rate, discount_pct, gst_rate }] */
const docLines = async (db, docId) => (await db.prepare(`SELECT item_id, description, qty, rate, discount_pct, gst_rate FROM doc_lines WHERE doc_id = ? ORDER BY id`)
  .bind(docId).all()).results.map((l) => ({ item_id: l.item_id, description: l.description || '', qty: l.qty, rate: l.rate / 100, discount_pct: l.discount_pct || 0, gst_rate: l.gst_rate }));
const linesOf = async (db, r) => (r.lines ? JSON.parse(r.lines) : docLines(db, r.src_doc_id));
/* about what each bill comes to, GST included (the real bill rounds per line) */
export const estimate = (lines) => Math.round(lines.reduce((s, l) => s + l.qty * l.rate * (1 - (l.discount_pct || 0) / 100) * (1 + (l.gst_rate || 0) / 100), 0) * 100) / 100;

async function cleanLines(c, raw) {
  if (!Array.isArray(raw) || !raw.length) throw bad('Keep at least one item on the bill.');
  if (raw.length > 100) throw bad('At most 100 lines.');
  const lines = raw.map((l, i) => {
    const n = `Line ${i + 1}`;
    const item_id = l.item_id ? Math.trunc(+l.item_id) || null : null, description = str(l.description, 200);
    if (!item_id && !description) throw bad(`${n}: choose an item or type what it is for.`);
    const gst = +l.gst_rate || 0;
    if (!GST_RATES.includes(gst)) throw bad(`${n}: GST rate ${l.gst_rate}% is not a GST rate.`);
    return { item_id, description, qty: num(l.qty, `${n} quantity`, { min: 0.001, max: 1e7 }), rate: Math.round(num(l.rate, `${n} rate`, { min: 0, max: 1e10 }) * 100) / 100,
      discount_pct: num(l.discount_pct, `${n} discount`, { min: 0, max: 100, def: 0 }), gst_rate: gst };
  });
  const ids = [...new Set(lines.map((l) => l.item_id).filter(Boolean))];
  if (ids.length) {
    const { results } = await c.db.prepare(`SELECT id FROM items WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(c.org.id, ...ids).all();
    if (results.length !== ids.length) throw bad('An item on the bill is not in your items.');
  }
  return lines;
}
/* customers for an invoice, suppliers for a bill, all of this business */
async function partiesFor(c, type, ids) {
  const want = [...new Set((Array.isArray(ids) ? ids : [ids]).map((x) => Math.trunc(+x)).filter((x) => x > 0))];
  if (!want.length) throw bad(type === 'INV' ? 'Choose a customer.' : 'Choose a supplier.');
  if (want.length > 300) throw bad('At most 300 at a time.');
  const { results } = await c.db.prepare(`SELECT id, kind FROM parties WHERE org_id = ? AND id IN (${want.map(() => '?').join(',')})`).bind(c.org.id, ...want).all();
  const side = type === 'INV' ? 'customer' : 'supplier';
  if (results.length !== want.length || results.some((p) => p.kind !== side && p.kind !== 'both')) throw bad(`Choose ${side}s of this business.`);
  return want;
}
const raiseOf = (b, next) => {
  const pct = num(b.raise_pct, 'Yearly rise', { min: 0, max: 100, def: 0 });
  return { pct, on: pct ? (b.raise_on ? date(b.raise_on, 'Rise from') : advance(next, 'year')) : null };
};
async function roomFor(c, n) {
  const open = await c.db.prepare(`SELECT COUNT(*) AS n FROM recurring WHERE org_id = ? AND active = 1`).bind(c.org.id).first();
  if (open.n + n > MAX_ACTIVE) throw bad(`You can have up to ${MAX_ACTIVE} active schedules. Stop the ones you no longer need.`);
}
async function insertSchedules(c, src, parties, s) {
  await roomFor(c, parties.length);
  const lines = JSON.stringify(s.lines), now = nowIso();
  await c.db.batch(parties.map((pid) => c.db.prepare(`INSERT INTO recurring (org_id, src_doc_id, party_id, lines, notes, every, anchor_day, next_on, ends_on, send, sent,
      raise_pct, raise_on, active, created_by, created_at, runs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?, 0)`)
    .bind(c.org.id, src.id, pid, lines, s.notes, s.every, s.anchor, s.next, s.ends, s.send, s.raise.pct, s.raise.on, c.user.id, now)));
}

/* POST /api/docs/:id/recurring { every, next_on?, ends_on?, send?, raise_pct?, raise_on?, party_ids? } (party_ids: the
   same bill for many customers at once) */
export async function createRecurring(c, id) {
  const d = await c.db.prepare(`SELECT * FROM docs WHERE id = ? AND org_id = ?`).bind(id, c.org.id).first();
  if (!d) throw notFound('Document not found.');
  if (!RECURRING_TYPES.includes(d.type)) throw bad('Only invoices and purchase bills can repeat by themselves.');
  if (d.status === 'cancelled') throw bad('This document is cancelled.');
  requireCan(c.user, DOC_TYPES[d.type].side === 'sales' ? 'sales' : 'purchase');
  const every = oneOf(String(c.body.every || 'month'), EVERY, 'Repeat');
  let next;
  if (c.body.next_on) {
    next = date(c.body.next_on, 'First date');
    if (next < today()) throw bad('The first date cannot be in the past.');
  } else {
    next = advance(d.date, every);                                 // one period after this bill, never in the past
    while (next < today()) next = advance(next, every, +d.date.slice(8, 10));
  }
  const ends = c.body.ends_on ? date(c.body.ends_on, 'End date') : null;
  if (ends && ends < next) throw bad('The end date is before the first date.');
  const parties = await partiesFor(c, d.type, c.body.party_ids && c.body.party_ids.length ? c.body.party_ids : [d.party_id]);
  const send = d.type === 'BILL' ? 'off' : c.body.send ? oneOf(String(c.body.send), SEND, 'Send') : c.org.auto_wa ? 'auto' : 'ask';
  const lines = await docLines(c.db, d.id);
  await insertSchedules(c, d, parties, { lines, notes: str(d.notes, 300), every, anchor: +next.slice(8, 10), next, ends, send, raise: raiseOf(c.body, next) });
  await c.db.batch([auditStatement(c, 'recurring on', `${d.number} every ${every} from ${next}${parties.length > 1 ? ` for ${parties.length} parties` : ''}`)]);
  return { count: parties.length, next_on: next };
}

export async function listRecurring(c) {
  const { results } = await c.db.prepare(`SELECT r.id, r.every, r.next_on, r.ends_on, r.active, r.runs, r.last_run_on, r.last_error, r.src_doc_id, r.lines, r.notes, r.send, r.sent,
      r.raise_pct, r.raise_on, d.type, d.number, d.total, COALESCE(r.party_id, d.party_id) AS party_id, p.name AS party, p.phone, p.lang,
      l.number AS last_number, l.id AS last_doc_id, l.total AS last_total, l.date AS last_date
    FROM recurring r JOIN docs d ON d.id = r.src_doc_id LEFT JOIN parties p ON p.id = COALESCE(r.party_id, d.party_id) LEFT JOIN docs l ON l.id = r.last_doc_id
    WHERE r.org_id = ? ORDER BY r.active DESC, r.next_on, p.name`).bind(c.org.id).all();
  return results.map(({ lines, ...r }) => {
    const ls = lines ? JSON.parse(lines) : null;
    const upcoming = [];
    if (r.active) for (let d = r.next_on; upcoming.length < 3 && (!r.ends_on || d <= r.ends_on); d = advance(d, r.every, +r.next_on.slice(8, 10))) upcoming.push(d);
    return { ...r, amount: ls ? estimate(ls) : r.total / 100, items: ls ? ls.length : null, last_total: r.last_total == null ? null : r.last_total / 100, upcoming };
  });
}

/* one schedule with its lines (item names for the editor) */
export async function getRecurring(c, id) {
  const r = await one(c, id);
  const lines = await linesOf(c.db, r);
  const ids = [...new Set(lines.map((l) => l.item_id).filter(Boolean))];
  const names = ids.length ? (await c.db.prepare(`SELECT id, name FROM items WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`).bind(c.org.id, ...ids).all()).results : [];
  const nm = new Map(names.map((i) => [i.id, i.name]));
  return { id: r.id, type: r.type, number: r.number, party_id: r.party_id || r.src_party, every: r.every, next_on: r.next_on, ends_on: r.ends_on, send: r.send,
    raise_pct: r.raise_pct, raise_on: r.raise_on, notes: r.notes ?? r.src_notes ?? '', active: r.active, lines: lines.map((l) => ({ ...l, item: nm.get(l.item_id) || '' })), amount: estimate(lines) };
}
async function one(c, id) {
  const r = await c.db.prepare(`SELECT r.*, d.type, d.number, d.status, d.party_id AS src_party, d.notes AS src_notes FROM recurring r JOIN docs d ON d.id = r.src_doc_id
    WHERE r.id = ? AND r.org_id = ?`).bind(id, c.org.id).first();
  if (!r) throw notFound('Schedule not found.');
  requireCan(c.user, DOC_TYPES[r.type].side === 'sales' ? 'sales' : 'purchase');
  return r;
}

/* PUT /api/recurring/:id: any of every, next_on, ends_on, send, raise_pct, raise_on, party_id, lines, notes */
export async function updateRecurring(c, id) {
  const r = await one(c, id), b = c.body, set = {};
  if (b.every !== undefined) set.every = oneOf(String(b.every), EVERY, 'Repeat');
  if (b.next_on !== undefined) {
    set.next_on = date(b.next_on, 'Next bill on');
    if (set.next_on < today()) throw bad('The next date cannot be in the past.');
  }
  const next = set.next_on || r.next_on;
  if (set.next_on || set.every) set.anchor_day = +next.slice(8, 10);
  if (b.ends_on !== undefined) set.ends_on = b.ends_on ? date(b.ends_on, 'End date') : null;
  const ends = b.ends_on !== undefined ? set.ends_on : r.ends_on;
  if (ends && ends < next) throw bad('The end date is before the next bill.');
  if (b.send !== undefined) set.send = r.type === 'BILL' ? 'off' : oneOf(String(b.send), SEND, 'Send');
  if (b.raise_pct !== undefined) { const x = raiseOf(b, next); set.raise_pct = x.pct; set.raise_on = x.on; }
  if (b.party_id !== undefined) set.party_id = (await partiesFor(c, r.type, [b.party_id]))[0];
  if (b.lines !== undefined) set.lines = JSON.stringify(await cleanLines(c, b.lines));
  if (b.notes !== undefined) set.notes = str(b.notes, 300);
  const keys = Object.keys(set);
  if (!keys.length) throw bad('Nothing to change.');
  await c.db.batch([c.db.prepare(`UPDATE recurring SET ${keys.map((k) => `${k} = ?`).join(', ')}, last_error = NULL WHERE id = ?`).bind(...keys.map((k) => set[k]), id),
    auditStatement(c, 'recurring changed', `${r.number}: ${keys.filter((k) => k !== 'anchor_day').join(', ')}`)]);
  return getRecurring(c, id);
}

/* the same schedule for more customers (each gets their own; lines, dates and settings copied) */
export async function copyRecurring(c, id) {
  const r = await one(c, id);
  const parties = (await partiesFor(c, r.type, c.body.party_ids)).filter((p) => p !== (r.party_id || r.src_party));
  if (!parties.length) throw bad('Choose at least one other customer.');
  const lines = await linesOf(c.db, r);
  await insertSchedules(c, { id: r.src_doc_id }, parties, { lines, notes: r.notes ?? str(r.src_notes, 300), every: r.every, anchor: r.anchor_day,
    next: r.next_on < today() ? today() : r.next_on, ends: r.ends_on, send: r.send || 'ask', raise: { pct: r.raise_pct || 0, on: r.raise_on || null } });
  await c.db.batch([auditStatement(c, 'recurring copied', `${r.number} for ${parties.length} more`)]);
  return { count: parties.length };
}

/* skip the next bill (a month the shop is shut, a free month): the date after it becomes the next */
export async function skipRecurring(c, id) {
  const r = await one(c, id);
  if (!r.active) throw bad('This schedule is stopped.');
  const next = advance(r.next_on, r.every, r.anchor_day), done = r.ends_on && next > r.ends_on;
  await c.db.batch([c.db.prepare(`UPDATE recurring SET next_on = ?, active = ? WHERE id = ?`).bind(next, done ? 0 : 1, id),
    auditStatement(c, 'recurring skipped', `${r.number} on ${r.next_on}`)]);
  return { next_on: done ? null : next };
}

export async function stopRecurring(c, id) {
  const r = await one(c, id);
  await c.db.batch([c.db.prepare(`UPDATE recurring SET active = 0 WHERE id = ?`).bind(id), auditStatement(c, 'recurring off', r.number)]);
}

/* Start a stopped or paused schedule again; a date already past moves to today, so no backlog is made */
export async function resumeRecurring(c, id) {
  const r = await one(c, id);
  if (r.status === 'cancelled' && !r.lines) throw bad('The original document is cancelled.');     // a schedule with its own lines does not need it
  const next = r.next_on < today() ? today() : r.next_on;
  if (r.ends_on && next > r.ends_on) throw bad('This schedule has already ended. Change its end date first.');
  await c.db.batch([c.db.prepare(`UPDATE recurring SET active = 1, next_on = ?, last_error = NULL WHERE id = ?`).bind(next, id), auditStatement(c, 'recurring on', r.number)]);
}

/* the newest bill of a schedule went to the customer (by hand, from "To send") */
export async function markSent(c, ids) {
  const want = (Array.isArray(ids) ? ids : [ids]).map((x) => Math.trunc(+x)).filter((x) => x > 0).slice(0, 500);
  if (!want.length) return 0;
  const r = await c.db.prepare(`UPDATE recurring SET sent = 1 WHERE org_id = ? AND id IN (${want.map(() => '?').join(',')})`).bind(c.org.id, ...want).run();
  return r.meta ? r.meta.changes : want.length;
}

/* ---------- making the bills ---------- */
const BILL_TEXT = {
  en: (n, s, a, p, l) => `*${s}*\nHello ${n}, your ${p} bill is ${a}. See the bill and pay by UPI: ${l}`,
  hi: (n, s, a, p, l) => `*${s}*\nनमस्ते ${n} जी, ${p} का आपका बिल ${a} है। बिल देखें और UPI से भुगतान करें: ${l}`,
  hl: (n, s, a, p, l) => `*${s}*\nNamaste ${n} ji, ${p} ka aapka bill ${a} hai. Bill dekhein aur UPI se payment karein: ${l}`,
};
const inr = (p) => '₹' + (Math.round(p) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/* The new invoice to the customer on WhatsApp, with no tap: only for a business on automatic WhatsApp (its plan has it),
   a customer with a mobile number who did not answer STOP. A customer who wrote in the last 24 hours gets free text;
   the others the approved template (WHATSAPP_BILL_TEMPLATE, else the reminder one: customer, business, amount, link). */
async function sendBill(env, org, doc, party, period) {
  if (!waConfigured(env) || !org.auto_wa || !hasFeature(org, 'autowa')) return false;
  const to = waNumber(party.phone);
  if (!to || party.wa_optout) return false;
  const lang = party.lang || org.msg_lang || 'hl', base = (env.APP_URL || 'https://erp.docbrisk.com').replace(/\/$/, '');
  let tok = doc.share_token;
  if (!tok) {
    await env.DB.prepare(`UPDATE docs SET share_token = ? WHERE id = ? AND share_token IS NULL`).bind(randomHex(12), doc.id).run();
    tok = (await env.DB.prepare(`SELECT share_token FROM docs WHERE id = ?`).bind(doc.id).first()).share_token;
  }
  const link = `${base}/i/${tok}${lang === 'hl' ? '' : '?l=' + lang}`, amount = inr(doc.total);
  const body = (BILL_TEXT[lang] || BILL_TEXT.hl)(party.name, org.name, amount, period, link);
  try {
    if (await windowOpen(env.DB, to)) await sendText(env, to, body);
    else await sendReminder(env, to, lang, [party.name, org.name, amount, link], env.WHATSAPP_BILL_TEMPLATE);
  } catch (e) { return false; }
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO wa_contacts (phone, org_id, party_id, last_out, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET org_id = excluded.org_id, party_id = excluded.party_id, choices = NULL, last_out = excluded.last_out, updated_at = excluded.updated_at`)
      .bind(to, org.id, party.id, now, now),
    env.DB.prepare(`INSERT INTO wa_messages (org_id, party_id, phone, dir, body, kind, handled, at) VALUES (?, ?, ?, 'out', ?, 'bill', 1, ?)`).bind(org.id, party.id, to, body, now),
  ]);
  return true;
}

/* One schedule: make the document, then move the schedule on. Returns the new document id, or null. */
async function runOne(env, r, day) {
  const db = env.DB;
  const org = await db.prepare(`SELECT * FROM orgs WHERE id = ?`).bind(r.org_id).first();
  let user = await db.prepare(USER_SQL).bind(r.created_by).first();
  if (!user || !user.active || user.org_id !== r.org_id || seatBlocked(org, user)) user = await db.prepare(USER_SQL.replace(/WHERE u\.id = \?/, `WHERE u.org_id = ? AND u.role = 'owner' AND u.active = 1`)).bind(r.org_id).first();
  const fail = (msg) => db.prepare(`UPDATE recurring SET last_error = ?, last_run_on = ? WHERE id = ?`).bind(str(msg, 300), day, r.id).run();
  if (!org || !user) { await fail('No active user can make this document.'); return null; }
  const src = await db.prepare(`SELECT * FROM docs WHERE id = ? AND org_id = ?`).bind(r.src_doc_id, r.org_id).first();
  if (!src) { await db.prepare(`UPDATE recurring SET active = 0, last_error = 'The original document is gone.' WHERE id = ?`).bind(r.id).run(); return null; }
  let lines = await linesOf(db, r), raised = null;
  // the yearly rise (rent): from its day on, every rate goes up by the percentage, and stays up
  if (r.raise_pct > 0 && r.raise_on && r.next_on >= r.raise_on) {
    lines = lines.map((l) => ({ ...l, rate: Math.round(l.rate * (1 + r.raise_pct / 100) * 100) / 100 }));
    raised = advance(r.raise_on, 'year');
  }
  const sys = sysMap((await db.prepare(SYS_SQL).bind(r.org_id).all()).results);
  const ctx = { db, org, user, sys, body: {} };
  Object.defineProperty(ctx, 'env', { value: env, enumerable: false });
  const period = periodOf(r.next_on, r.every), notes = r.notes ?? src.notes ?? '';
  try {
    const made = await createDoc(ctx, { type: src.type, party_id: r.party_id || src.party_id, warehouse_id: src.warehouse_id, date: r.next_on,
      notes: [notes, `For ${period} (${EVERY_WORD[r.every]} bill)`].filter(Boolean).join(' · '), design: src.design || undefined,
      extra: src.extra ? JSON.parse(src.extra) : undefined, lines });
    const next = advance(r.next_on, r.every, r.anchor_day);
    const done = r.ends_on && next > r.ends_on;
    const party = await db.prepare(`SELECT id, name, phone, lang, wa_optout FROM parties WHERE id = ?`).bind(made.party_id).first();
    const sent = made.type !== 'INV' || r.send === 'off' ? 1 : r.send === 'auto' && party && await sendBill(env, org, made, party, period) ? 1 : 0;
    const st = [db.prepare(`UPDATE recurring SET next_on = ?, last_doc_id = ?, last_run_on = ?, runs = runs + 1, last_error = NULL, active = ?, sent = ?${raised ? ', lines = ?, raise_on = ?' : ''} WHERE id = ?`)
      .bind(next, made.id, day, done ? 0 : 1, sent, ...(raised ? [JSON.stringify(lines), raised] : []), r.id),
    auditStatement(ctx, 'recurring made', `${made.number} for ${period}${sent && r.send === 'auto' ? ', sent on WhatsApp' : ''}`)];
    if (raised) st.push(auditStatement(ctx, 'recurring price up', `${r.raise_pct}% from ${r.next_on}`));
    await db.batch(st);
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
