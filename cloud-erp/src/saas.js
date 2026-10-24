/* Plans and limits, for selling the ERP to other businesses. Plans are bought online (src/billing.js);
   the person running this deployment can also set a plan by hand with the ADMIN_KEY secret (#/admin). */
import { HttpError, today, addDays, own } from './lib.js';

/* Prices are per year in rupees, before GST. Limits: Infinity = no limit. */
export const PLANS = {
  free: { label: 'Free', price: 0, invoices_per_month: 50, users: 1, warehouses: 1, features: [] },
  starter: { label: 'Starter', price: 999, invoices_per_month: Infinity, users: 2, warehouses: 1, features: ['tally', 'vaada'] },
  growth: { label: 'Growth', price: 2499, invoices_per_month: Infinity, users: 5, warehouses: 3, features: ['tally', 'einvoice', 'vaada', 'cash'] },
  business: { label: 'Business', price: 4499, invoices_per_month: Infinity, users: 15, warehouses: Infinity, features: ['tally', 'einvoice', 'priority', 'vaada', 'cash'] },
};
export const FEATURE_LABEL = { tally: 'Tally export', einvoice: 'E-invoice & e-way bill JSON', priority: 'Priority WhatsApp support',
  vaada: 'Kisht plans & udhaar check', cash: 'Kal ka Cash (4-week cash view)' };
export const hasFeature = (org, f) => planOf(org).features.includes(f);
export const TRIAL_DAYS = 14;

/* The plan in force today: a paid plan whose end date has passed drops back to Free. */
export function planOf(org) {
  const key = org.plan && own(PLANS, org.plan) && (org.plan === 'free' || (org.plan_until && org.plan_until >= today())) ? org.plan : 'free';
  return { key, ...PLANS[key], until: key === 'free' ? '' : org.plan_until };
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
