/* Plans and limits, for selling the ERP to other businesses. Plans are bought online (src/billing.js);
   the person running this deployment can also set a plan by hand with the ADMIN_KEY secret (#/admin). */
import { HttpError, today, addDays, own } from './lib.js';

/* Prices are per year in rupees, before GST. Limits: Infinity = no limit. */
export const PLANS = {
  free: { label: 'Free', price: 0, invoices_per_month: 50, users: 1, warehouses: 1, features: [] },
  starter: { label: 'Starter', price: 999, invoices_per_month: Infinity, users: 2, warehouses: 1, features: ['tally', 'vaada'] },
  growth: { label: 'Growth', price: 2499, invoices_per_month: Infinity, users: 5, warehouses: 3, features: ['tally', 'einvoice', 'vaada', 'cash', 'autowa'] },
  business: { label: 'Business', price: 4499, invoices_per_month: Infinity, users: 15, warehouses: Infinity, features: ['tally', 'einvoice', 'priority', 'vaada', 'cash', 'autowa'] },
};
export const FEATURE_LABEL = { tally: 'Tally export', einvoice: 'E-invoice & e-way bill JSON', priority: 'Priority WhatsApp support',
  vaada: 'Kisht plans & udhaar check', cash: 'Kal ka Cash (4-week cash view)', autowa: 'Automatic WhatsApp reminders' };
export const hasFeature = (org, f) => planOf(org).features.includes(f);
export const TRIAL_DAYS = 30;
/* Businesses that sign up from this day get 25 invoices a month on Free (earlier ones keep 50). */
export const FREE_SMALL_FROM = '2026-11-22';
export const FREE_SMALL = 25;
export const freeInvoices = (org) => (String((org && org.created_at) || '') >= FREE_SMALL_FROM ? FREE_SMALL : PLANS.free.invoices_per_month);
/* Right after a free trial ends without a purchase: 20% off the first year, for this many days. */
export const OFFER_DAYS = 7;
/* Refer & earn: a business invited by another gets this many extra trial days; the inviter gets REF_REWARD_DAYS of
   Growth (or that much more on its current plan) once, when the invited business first pays. */
export const REF_EXTRA_DAYS = 15;
export const REF_REWARD_DAYS = 30;
export const cleanRef = (v) => (/^[0-9a-f]{8}$/.test(String(v || '').trim().toLowerCase()) ? String(v).trim().toLowerCase() : '');
export const OFFER_PCT = 20;
/* trial: on the free trial now. offer_until: the last day of the first-year offer (after the trial), else ''. */
export function trialInfo(org) {
  const end = org.trial_end || '', t = today();
  const trial = !!end && org.plan_until === end && end >= t && org.plan !== 'free';
  const trialOffer = end && end < t && addDays(end, OFFER_DAYS) >= t ? addDays(end, OFFER_DAYS) : '';
  // an offer a step opened (free bills nearly used, back after a break) counts the same way
  const stepOffer = org.offer_until && org.offer_until >= t ? org.offer_until : '';
  const offerUntil = trialOffer > stepOffer ? trialOffer : stepOffer;
  const kind = !offerUntil ? '' : offerUntil === trialOffer ? 'trial' : (org.offer_kind || 'limit');
  return { trial, trial_end: end, offer_until: offerUntil, offer_pct: offerUntil ? OFFER_PCT : 0, offer_kind: kind };
}

/* The plan in force today: a paid plan whose end date has passed drops back to Free. */
export function planOf(org) {
  const key = org.plan && own(PLANS, org.plan) && (org.plan === 'free' || (org.plan_until && org.plan_until >= today())) ? org.plan : 'free';
  const lim = key === 'free' ? { invoices_per_month: freeInvoices(org) } : {};
  return { key, ...PLANS[key], ...lim, until: key === 'free' ? '' : org.plan_until, free_bills: freeInvoices(org), ...trialInfo(org) };
}
const fmtLimit = (n) => (n === Infinity ? null : n);
export function planOut(org) {
  const p = planOf(org);
  return { ...p, invoices_per_month: fmtLimit(p.invoices_per_month), users: fmtLimit(p.users), warehouses: fmtLimit(p.warehouses) };
}

function upgrade(msg) { return new HttpError(402, msg + ' Upgrade your plan in Settings → Plan & billing.', { upgrade: true }); }
export { upgrade as upgradeError };

export function requireFeature(org, feature) {
  const p = planOf(org);
  if (!p.features.includes(feature)) throw upgrade(`${own(FEATURE_LABEL, feature) || 'This feature'} is not included in the ${p.label} plan.`);
}
/* First instant of this month in India (00:00 IST), as the ISO text docs.created_at uses. Invoices are counted by the
   moment they were created, never by the date typed on them, so back-dating cannot hide an invoice from the cap.
   Cancelled invoices count too: they still used an invoice number, and cancelling then re-issuing would otherwise be free. */
export const monthStartIso = () => new Date(Date.parse(today().slice(0, 8) + '01T00:00:00+05:30')).toISOString();
export const INV_COUNT_SQL = `SELECT COUNT(*) FROM docs WHERE org_id = ? AND type = 'INV' AND created_at >= ?`;
/* { max, since } while the plan has a monthly invoice cap, else null */
export function invoiceCap(org) {
  const p = planOf(org);
  return p.invoices_per_month === Infinity ? null : { max: p.invoices_per_month, since: monthStartIso(), label: p.label };
}
export const invoiceCapError = (cap) => upgrade(`The ${cap.label} plan allows ${cap.max} invoices a month and you have used them all.`);
export async function checkInvoiceLimit(db, org) {
  const cap = invoiceCap(org);
  if (!cap) return;
  const r = await db.prepare(INV_COUNT_SQL.replace('COUNT(*)', 'COUNT(*) AS n')).bind(org.id, cap.since).first();
  if (r.n >= cap.max) throw invoiceCapError(cap);
}
const COUNT_SQL = {
  users: `SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND active = 1`,
  warehouses: `SELECT COUNT(*) AS n FROM warehouses WHERE org_id = ?`,
};
export const countError = (org, what) => {
  const p = planOf(org), max = p[what];
  return upgrade(`The ${p.label} plan allows ${max} ${what === 'users' ? 'active user' : 'godown'}${max === 1 ? '' : 's'}.`);
};
export async function checkCount(db, org, what) {
  const max = planOf(org)[what];
  if (max === Infinity) return;
  const r = await db.prepare(COUNT_SQL[what]).bind(org.id).first();
  if (r.n >= max) throw countError(org, what);
}
/* The staff who may still sign in after a plan lapses: the owner and the oldest staff, up to the plan's user limit. */
export const seatBlocked = (org, user) => {
  const max = planOf(org).users;
  return user.role !== 'owner' && Number.isFinite(max) && (user.seat || 0) >= max - 1;
};
export const seatError = (org) => {
  const p = planOf(org);
  return new HttpError(403, `The ${p.label} plan allows ${p.users} user${p.users === 1 ? '' : 's'}, and this login is paused. Ask the business owner to upgrade the plan in Settings → Plan & billing.`, { upgrade: true });
};
export async function usage(db, org) {
  return db.prepare(`SELECT
      (SELECT COUNT(*) FROM docs WHERE org_id = ?1 AND type = 'INV' AND created_at >= ?2) AS invoices_this_month,
      (SELECT COUNT(*) FROM users WHERE org_id = ?1 AND active = 1) AS users,
      (SELECT COUNT(*) FROM warehouses WHERE org_id = ?1) AS warehouses`).bind(org.id, monthStartIso()).first();
}

export function adminKey(env) {
  return env.ADMIN_KEY && String(env.ADMIN_KEY).length >= 16 ? String(env.ADMIN_KEY) : null;
}
/* Same plan: add the months on top of the current end date. New plan: start from today. */
export async function extendPlan(db, org, plan, months) {
  const cur = planOf(org);
  const from = cur.key === plan && org.plan_until > today() ? org.plan_until : today();
  const until = plan === 'free' ? '' : addMonths(from, months);
  await db.prepare(`UPDATE orgs SET plan = ?, plan_until = ? WHERE id = ?`).bind(plan, until, org.id).run();
  return until;
}
function addMonths(d, n) {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCMonth(dt.getUTCMonth() + n);
  return dt.toISOString().slice(0, 10);
}
export const trialUntil = () => addDays(today(), TRIAL_DAYS);
