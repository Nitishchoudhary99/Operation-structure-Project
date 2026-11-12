/* Thermal printer (58 / 80 mm, ESC/POS): KOT and bill slips straight to the printer, without the browser's print dialog.
   Bluetooth (most small kitchen printers; Chrome on Android, Windows, Mac) or USB (Chrome on a computer, or Android with OTG).
   Opt-in: until a printer is connected here, everything prints through the browser as before, and if the printer fails the
   slip falls back to the browser too, so a ticket is never lost.
   Bluetooth: Chrome must be asked again after the page is reloaded (one tap on "Connect"); USB is remembered by Chrome. */

const BT_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000ff00-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb'];
let link = null;          // { kind, name, write(bytes) }
const KEY = 'st:printer';
const pref = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
const savePref = (v) => { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch (e) { /* storage off */ } };

export const supported = () => ({ bluetooth: !!(navigator.bluetooth && navigator.bluetooth.requestDevice), usb: !!(navigator.usb && navigator.usb.requestDevice) });
export const status = () => ({ connected: !!link, name: link ? link.name : '', kind: link ? link.kind : '', width: (pref() || {}).width || 32, wanted: !!pref() });

async function btLink(device) {
  const server = await device.gatt.connect();
  for (const s of await server.getPrimaryServices()) {
    for (const ch of await s.getCharacteristics()) {
      if (!(ch.properties.write || ch.properties.writeWithoutResponse)) continue;
      const fast = ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse;
      return { kind: 'bluetooth', name: device.name || 'Bluetooth printer', write: async (bytes) => {
        for (let i = 0; i < bytes.length; i += 180) {       // small chunks: cheap printers have tiny buffers
          const part = bytes.slice(i, i + 180);
          if (fast) await ch.writeValueWithoutResponse(part); else await ch.writeValue(part);
          if (fast) await new Promise((r) => setTimeout(r, 15));
        }
      } };
    }
  }
  throw new Error('This Bluetooth device has no printer channel.');
}
async function usbLink(dev) {
  await dev.open();
  if (dev.configuration === null) await dev.selectConfiguration(1);
  for (const iface of dev.configuration.interfaces) {
    const alt = iface.alternates[0], out = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
    if (!out) continue;
    await dev.claimInterface(iface.interfaceNumber);
    return { kind: 'usb', name: dev.productName || 'USB printer', write: async (bytes) => { for (let i = 0; i < bytes.length; i += 4096) await dev.transferOut(out.endpointNumber, bytes.slice(i, i + 4096)); } };
  }
  throw new Error('This USB device has no printer channel.');
}

export async function connect(kind, width = 32) {
  if (kind === 'bluetooth') {
    const d = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BT_SERVICES });
    link = await btLink(d);
    d.addEventListener('gattserverdisconnected', () => { link = null; });
  } else {
    const d = await navigator.usb.requestDevice({ filters: [] });      // every USB device: many cheap printers do not say they are printers
    link = await usbLink(d);
  }
  savePref({ kind, width });
  return status();
}
/* a USB printer allowed before comes back by itself after a reload */
export async function reconnect() {
  const p = pref();
  if (link || !p || p.kind !== 'usb' || !navigator.usb) return status();
  try { const [d] = await navigator.usb.getDevices(); if (d) link = await usbLink(d); } catch (e) { link = null; }
  return status();
}
export function forget() { link = null; savePref(null); }
export const setWidth = (w) => { const p = pref(); if (p) savePref({ ...p, width: w === 48 ? 48 : 32 }); };

/* ---- the slip ---- */
const ESC = 0x1b, GS = 0x1d;
// thermal printers know plain letters only (slips with Hindi go as a picture, below); anything left becomes its nearest Latin form or '?'
const plain = (s) => String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/₹/g, 'Rs ').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/×/g, 'x').replace(/·/g, '-').replace(/[^\x20-\x7e\n]/g, '?');
function wrap(text, w) {
  const out = [];
  for (const para of plain(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if ((line + ' ' + word).trim().length > w) { if (line) out.push(line); line = word.length > w ? word.slice(0, w) : word; } else line = (line + ' ' + word).trim();
    }
    out.push(line);
  }
  return out;
}
class Slip {
  constructor(w) { this.w = w; this.b = [ESC, 0x40]; }
  raw(...x) { this.b.push(...x); return this; }
  text(s) { for (const ch of plain(s)) this.b.push(ch.charCodeAt(0)); return this; }
  line(s = '') { return this.text(s).raw(0x0a); }
  align(a) { return this.raw(ESC, 0x61, a === 'center' ? 1 : a === 'right' ? 2 : 0); }
  bold(on) { return this.raw(ESC, 0x45, on ? 1 : 0); }
  big(on) { return this.raw(GS, 0x21, on ? 0x11 : 0); }
  rule() { return this.line('-'.repeat(this.w)); }
  pair(l, r) { l = plain(l); r = plain(r); const room = this.w - r.length - 1; return this.line((l.length > room ? l.slice(0, room) : l).padEnd(room) + ' ' + r); }
  end() { return new Uint8Array([...this.b, 0x0a, 0x0a, 0x0a, GS, 0x56, 0x42, 0x00]); }
}
const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

/* the KOT as lines with their style; printed as text, or as a picture when a dish is written in Hindi (or any script
   the printer has no letters for), so the cook reads it as typed */
function kotLines(k, shop) {
  const L = [{ t: shop, c: 1 }];
  if (k.kind === 'cancel') L.push({ t: '*** CANCEL ***', c: 1, b: 1, g: 1 });
  L.push({ t: `KOT ${k.number}`, c: 1, b: 1, g: 1 }, { t: `Table ${k.table}`, c: 1, b: 1, g: 1 },
    { t: `${String(k.at).slice(0, 10)} ${hhmm(k.at)}${k.user ? ' - ' + k.user : ''}`, c: 1 }, { rule: 1 });
  for (const l of k.lines) { L.push({ t: `${+l.qty} x ${l.name}`, b: 1, q: `${+l.qty} x `.length }); if (l.note) L.push({ t: '  > ' + l.note }); }
  L.push({ rule: 1 });
  return L;
}
const latinOnly = (L) => L.every((l) => !l.t || /^[\x20-\x7e₹×·–—‘’“”]*$/.test(l.t));
export function kotBytes(k, shop) {
  const w = status().width, L = kotLines(k, shop);
  if (!latinOnly(L) && typeof document !== 'undefined') return rasterBytes(L, w);
  const s = new Slip(w);
  for (const l of L) {
    if (l.rule) { s.align('left').rule(); continue; }
    s.align(l.c ? 'center' : 'left').bold(!!l.b).big(!!l.g);
    const cw = l.g ? Math.floor(w / 2) : w, pad = l.q || 0;
    wrap(l.t.slice(pad), cw - pad).forEach((t, i) => s.line((i ? ' '.repeat(pad) : l.t.slice(0, pad)) + t));
    s.big(false).bold(false);
  }
  return s.end();
}
/* GS v 0: the slip drawn on a canvas (58 mm = 384 dots, 80 mm = 576), black and white, sent in bands */
function rasterBytes(L, w) {
  const W = w === 48 ? 576 : 384, cv = document.createElement('canvas'), g = cv.getContext('2d');
  const font = (l) => `${l.b ? 'bold ' : ''}${l.g ? 34 : 22}px "Noto Sans Devanagari", "Noto Sans", Arial, sans-serif`;
  const rows = [];
  for (const l of L) {
    if (l.rule) { rows.push({ rule: 1, h: 14 }); continue; }
    g.font = font(l);
    let line = '';
    for (const word of String(l.t).split(' ')) {
      const tryL = line ? line + ' ' + word : word;
      if (g.measureText(tryL).width > W - 8 && line) { rows.push({ ...l, t: line, h: l.g ? 42 : 30 }); line = '  ' + word; } else line = tryL;
    }
    rows.push({ ...l, t: line, h: l.g ? 42 : 30 });
  }
  const H = rows.reduce((a, r) => a + r.h, 0) + 8;
  cv.width = W; cv.height = H;
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.fillStyle = '#000'; g.textBaseline = 'top';
  let y = 4;
  for (const r of rows) {
    if (r.rule) { g.fillRect(0, y + 6, W, 2); y += r.h; continue; }
    g.font = font(r); g.textAlign = r.c ? 'center' : 'left';
    g.fillText(r.t, r.c ? W / 2 : 4, y); y += r.h;
  }
  const px = g.getImageData(0, 0, W, H).data, bw = W / 8, out = [ESC, 0x40];
  for (let y0 = 0; y0 < H; y0 += 96) {
    const h = Math.min(96, H - y0);
    out.push(GS, 0x76, 0x30, 0, bw & 255, bw >> 8, h & 255, h >> 8);
    for (let y1 = y0; y1 < y0 + h; y1++) for (let x = 0; x < bw; x++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) { const i = (y1 * W + x * 8 + bit) * 4; if (px[i] + px[i + 1] + px[i + 2] < 384) byte |= 0x80 >> bit; }
      out.push(byte);
    }
  }
  out.push(0x0a, 0x0a, 0x0a, GS, 0x56, 0x42, 0x00);
  return new Uint8Array(out);
}

/* sends the bytes; false means "print it through the browser instead" */
export async function send(bytes) {
  if (!link) await reconnect();
  if (!link) return false;
  try { await link.write(bytes); return true; } catch (e) { link = null; return false; }
}
export const test = (shop) => send(new Slip(status().width).align('center').bold(true).line(shop).bold(false).line('Printer connected').line(new Date().toLocaleString('en-IN')).rule().end());
