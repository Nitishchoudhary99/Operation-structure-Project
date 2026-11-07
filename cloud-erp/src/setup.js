/* Business type & menu (Settings → Business type & menu): the owner picks the kind of business, and each module of the
   app is switched on or off for the whole business. The packs and modules themselves (names, screens, what each pack
   turns on) live in the app (public/app.js PACKS / MODULES); the server keeps the keys honest and stores the choice in
   orgs.setup. Who may do what stays with the roles; this only shapes the menu, the first screens and new-item defaults. */
import { str, num, bad } from './lib.js';

export const PACK_KEYS = ['kirana', 'wholesale', 'clothing', 'online', 'pharmacy', 'electronics', 'repair', 'hardware', 'restaurant', 'maker', 'services', 'export'];
export const MODULE_KEYS = ['pos', 'orders', 'quotes', 'procure', 'khata', 'loyalty', 'shop', 'channels', 'restaurant', 'jobs', 'wms', 'batch', 'serial',
  'mfg', 'recurring', 'staff', 'books', 'claims'];

export function setupOf(org) {
  let s = {};
  try { s = JSON.parse((org && org.setup) || '{}') || {}; } catch (e) { s = {}; }
  return cleanSetup(s);
}
export function cleanSetup(b) {
  b = b && typeof b === 'object' ? b : {};
  const modules = {};
  if (b.modules && typeof b.modules === 'object') for (const k of MODULE_KEYS) if (Object.hasOwn(b.modules, k)) modules[k] = b.modules[k] === true;
  const d = b.item_defaults && typeof b.item_defaults === 'object' ? b.item_defaults : {};
  const gst = d.gst_rate === undefined || d.gst_rate === null || d.gst_rate === '' ? null : num(d.gst_rate, 'Usual GST rate', { min: 0, max: 40 });
  // payroll rates the owner (or the CA) changed; the rest stay at the law's defaults (src/payroll.js STAT_DEFAULTS)
  const P = b.payroll && typeof b.payroll === 'object' ? b.payroll : {}, payroll = {};
  for (const [k, max, name] of [['pf_ceiling', 1e6, 'PF wage ceiling'], ['eps_ceiling', 1e6, 'EPS wage ceiling'], ['pf_rate', 30, 'PF rate'], ['eps_rate', 12, 'EPS rate'],
    ['edli_rate', 5, 'EDLI rate'], ['admin_rate', 5, 'PF admin charges'], ['esi_limit', 1e6, 'ESI wage limit'], ['esi_emp', 5, 'ESI employee rate'], ['esi_er', 10, 'ESI employer rate']]) {
    if (P[k] !== undefined && P[k] !== null && P[k] !== '') payroll[k] = num(P[k], name, { min: 0, max });
  }
  // rates that cannot both be right: a nil ceiling (no PF at all) or a pension share above the whole employer share
  for (const k of ['pf_ceiling', 'eps_ceiling', 'esi_limit']) if (payroll[k] === 0) throw bad('A wage ceiling or limit cannot be 0.');
  if ((payroll.eps_rate ?? 8.33) > (payroll.pf_rate ?? 12)) throw bad('The EPS (pension) share cannot be more than the PF rate.');
  // the employer's TAN (for salary TDS: Form 138 returns and Form 130 certificates)
  const tan = str(P.tan, 10).toUpperCase().replace(/\s/g, '');
  if (tan && !/^[A-Z]{4}\d{5}[A-Z]$/.test(tan)) throw bad('TAN is 10 characters, like DELA12345B.');
  if (tan) payroll.tan = tan;
  return {
    biz: PACK_KEYS.includes(b.biz) ? b.biz : '',
    modules,
    item_defaults: { unit: str(d.unit, 12), gst_rate: gst, track_batch: d.track_batch === true, track_serial: d.track_serial === true },
    payroll,
  };
}
