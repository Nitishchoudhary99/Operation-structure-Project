/* Business type & menu (Settings → Business type & menu): the owner picks the kind of business, and each module of the
   app is switched on or off for the whole business. The packs and modules themselves (names, screens, what each pack
   turns on) live in the app (public/app.js PACKS / MODULES); the server keeps the keys honest and stores the choice in
   orgs.setup. Who may do what stays with the roles; this only shapes the menu, the first screens and new-item defaults. */
import { str, num } from './lib.js';

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
  return {
    biz: PACK_KEYS.includes(b.biz) ? b.biz : '',
    modules,
    item_defaults: { unit: str(d.unit, 12), gst_rate: gst, track_batch: d.track_batch === true, track_serial: d.track_serial === true },
  };
}
