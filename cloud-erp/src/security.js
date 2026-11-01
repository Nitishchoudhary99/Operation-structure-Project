/* Security and privacy of each business:
   - two-step sign-in: a 6-digit code from an authenticator app (TOTP, RFC 6238) after the password, with one-time backup codes;
     the owner can make it a must for everyone, and the owner or an admin can reset it for a staff member who lost the phone
   - the sign-in history (who, when, from where, right or wrong), kept 180 days
   - closing a business: the owner asks, the business waits 7 days (the owner can still sign in, cancel and download a backup),
     then every record of it is deleted. The payment records of its SmartTrader plan are kept, as the law needs. */
import { HttpError, bad, forbidden, nowIso, str } from './lib.js';
import { hashPassword, sameText, sessionSecret } from './auth.js';

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));
const sha256 = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');

/* the authenticator secret is kept sealed (AES-GCM) with a key made from the session secret, never in plain text */
async function sealKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('smarttrader-2fa|' + await sessionSecret(env)));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return b64u(iv) + '.' + b64u(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(env), enc.encode(text)));
}
async function unseal(env, s) {
  const [iv, ct] = String(s || '').split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, await sealKey(env), unb64u(ct)));
}

/* ---------------------------------------------------------------- TOTP */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes) {
  let out = '', bits = 0, val = 0;
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
    val &= (1 << bits) - 1;
  }
  return bits ? out + B32[(val << (5 - bits)) & 31] : out;
}
function unbase32(s) {
  const out = [];
  let bits = 0, val = 0;
  for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    val = (val << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; val &= (1 << bits) - 1; }
  }
  return new Uint8Array(out);
}
/* the 6-digit code of a 30-second step */
export async function totpCode(secretB32, step) {
  const key = await crypto.subtle.importKey('raw', unbase32(secretB32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  for (let i = 7, c = step; i >= 0; i--, c = Math.floor(c / 256)) msg[i] = c & 255;
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg)), o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}
const stepNow = () => Math.floor(Date.now() / 30000);
/* the step a code belongs to (this one, the one before or after, for a phone clock a little off), only if newer than `after` */
async function matchStep(secret, code, after) {
  for (const s of [stepNow(), stepNow() - 1, stepNow() + 1]) if (s > after && sameText(await totpCode(secret, s), code)) return s;
  return 0;
}
const backupCodes = () => Array.from({ length: 8 }, () => { const d = [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b % 10).join(''); return d.slice(0, 5) + '-' + d.slice(5); });
const codeOf = (v) => str(v, 20).replace(/[\s-]/g, '');

/* After a right password: the second step. Returns how it was passed ('code' or 'backup code') or '' when the code is wrong.
   A code works once (the step is remembered); a backup code is crossed off. */
export async function secondStep(env, db, user, raw) {
  const code = codeOf(raw);
  if (/^\d{6}$/.test(code) && user.totp_secret) {
    const s = await matchStep(await unseal(env, user.totp_secret), code, user.totp_last || 0);
    if (s) {
      const r = await db.prepare(`UPDATE users SET totp_last = ? WHERE id = ? AND totp_last < ?`).bind(s, user.id, s).run();
      return r.meta.changes ? 'code' : '';             // two sign-ins racing with the same code: only one gets through
    }
  }
  if (/^\d{10}$/.test(code)) {
    const list = JSON.parse(user.totp_backup || '[]'), h = await sha256(code), left = list.filter((x) => x !== h);
    if (left.length < list.length) {
      const r = await db.prepare(`UPDATE users SET totp_backup = ? WHERE id = ? AND totp_backup = ?`).bind(JSON.stringify(left), user.id, user.totp_backup).run();
      return r.meta.changes ? 'backup code' : '';
    }
  }
  return '';
}

const freshUser = (c) => c.db.prepare(`SELECT * FROM users WHERE id = ?`).bind(c.user.id).first();
const audit = (c, action, detail = '') => c.db.prepare(`INSERT INTO audit (org_id, user_id, at, action, detail) VALUES (?, ?, ?, ?, ?)`)
  .bind(c.org.id, c.user.id, nowIso(), action, String(detail).slice(0, 300));

/* Start: a new secret, kept sealed until the first right code turns it on */
export async function twoStepStart(c) {
  const u = await freshUser(c);
  if (u.totp_on) throw bad('Two-step sign-in is already on.');
  const secret = base32(crypto.getRandomValues(new Uint8Array(20)));
  await c.db.prepare(`UPDATE users SET totp_secret = ?, totp_last = 0 WHERE id = ?`).bind(await seal(c.env, secret), u.id).run();
  const label = encodeURIComponent(`SmartTrader:${u.email}`);
  return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=SmartTrader&algorithm=SHA1&digits=6&period=30` };
}
export async function twoStepEnable(c) {
  const u = await freshUser(c);
  if (u.totp_on) throw bad('Two-step sign-in is already on.');
  if (!u.totp_secret) throw bad('Start again: tap "Turn on two-step sign-in".');
  const s = await matchStep(await unseal(c.env, u.totp_secret), codeOf(c.body.code), 0);
  if (!s) throw bad('That code is not right. Type the 6-digit code your authenticator app shows now.');
  const codes = backupCodes();
  await c.db.batch([
    c.db.prepare(`UPDATE users SET totp_on = 1, totp_last = ?, totp_backup = ? WHERE id = ?`).bind(s, JSON.stringify(await Promise.all(codes.map((x) => sha256(x.replace('-', ''))))), u.id),
    audit(c, 'two-step sign-in on'),
  ]);
  return { ok: true, backup_codes: codes };
}
async function passwordAndCode(c, u) {
  if (!sameText(await hashPassword(c.body.password || '', u.salt), u.pw_hash)) throw bad('Your password is not correct.');
  if (u.totp_on && !(await secondStep(c.env, c.db, u, c.body.code))) throw bad('That code is not right. Use the code from your authenticator app or a backup code.');
}
export async function twoStepDisable(c) {
  const u = await freshUser(c);
  if (!u.totp_on) throw bad('Two-step sign-in is already off.');
  if (c.org.require_2fa) throw bad('Your business needs two-step sign-in for everyone. The owner can change that in Settings → Security.');
  await passwordAndCode(c, u);
  await c.db.batch([c.db.prepare(`UPDATE users SET totp_on = 0, totp_secret = '', totp_backup = '', totp_last = 0 WHERE id = ?`).bind(u.id), audit(c, 'two-step sign-in off')]);
  return { ok: true };
}
export async function newBackupCodes(c) {
  const u = await freshUser(c);
  if (!u.totp_on) throw bad('Turn on two-step sign-in first.');
  await passwordAndCode(c, u);
  const codes = backupCodes();
  await c.db.batch([c.db.prepare(`UPDATE users SET totp_backup = ? WHERE id = ?`).bind(JSON.stringify(await Promise.all(codes.map((x) => sha256(x.replace('-', ''))))), u.id),
    audit(c, 'new backup codes')]);
  return { ok: true, backup_codes: codes };
}
/* The owner or an admin turns it off for a staff member who lost the phone (never for the owner) */
export async function twoStepReset(c, userId) {
  if (!['owner', 'admin'].includes(c.user.role)) throw forbidden('Only the owner or an admin can do this.');
  const u = await c.db.prepare(`SELECT id, name, role FROM users WHERE id = ? AND org_id = ?`).bind(userId, c.org.id).first();
  if (!u) throw bad('No such user.');
  if (u.role === 'owner' || u.id === c.user.id) throw forbidden('Your own two-step sign-in is changed by you, with your code.');
  await c.db.batch([c.db.prepare(`UPDATE users SET totp_on = 0, totp_secret = '', totp_backup = '', totp_last = 0 WHERE id = ?`).bind(u.id),
    audit(c, 'two-step sign-in reset', u.name)]);
  return { ok: true };
}
export async function requireTwoStep(c, on) {
  if (c.user.role !== 'owner') throw forbidden('Only the owner can change this.');
  if (on && !(await freshUser(c)).totp_on) throw bad('Turn on two-step sign-in for yourself first.');
  await c.db.batch([c.db.prepare(`UPDATE orgs SET require_2fa = ? WHERE id = ?`).bind(on ? 1 : 0, c.org.id), audit(c, 'two-step sign-in for everyone', on ? 'on' : 'off')]);
  return { ok: true };
}

/* ---------------------------------------------------------------- sign-in history */
export const loginStatement = (db, { org_id, user_id, email, ip, ua, ok, how }) =>
  db.prepare(`INSERT INTO logins (org_id, user_id, email, at, ip, ua, ok, how) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(org_id, user_id || null, str(email, 120), nowIso(), str(ip, 64), str(ua, 300), ok ? 1 : 0, str(how, 40));
/* "Chrome on Android", "Safari on iPhone", ... from the browser's user agent */
export function deviceOf(ua) {
  const u = String(ua || '');
  const app = /Edg\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera' : /SamsungBrowser/.test(u) ? 'Samsung Internet' : /Firefox\//.test(u) ? 'Firefox'
    : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : /node|undici|curl|python|okhttp/i.test(u) ? 'a script' : 'a browser';
  const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac OS X|Macintosh/.test(u) ? 'Mac'
    : /Linux/.test(u) ? 'Linux' : '';
  return os ? `${app} on ${os}` : app;
}
export async function signInHistory(c) {
  const all = ['owner', 'admin'].includes(c.user.role);
  const { results } = await c.db.prepare(`SELECT l.at, l.email, l.ip, l.ua, l.ok, l.how, u.name FROM logins l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.org_id = ? ${all ? '' : 'AND l.user_id = ?'} ORDER BY l.id DESC LIMIT 100`).bind(...(all ? [c.org.id] : [c.org.id, c.user.id])).all();
  const { results: users } = all ? await c.db.prepare(`SELECT id, name, email, role, totp_on, active FROM users WHERE org_id = ? ORDER BY id`).bind(c.org.id).all() : { results: [] };
  return { all, rows: results.map(({ ua, ...r }) => ({ ...r, device: deviceOf(ua) })), users };
}

/* ---------------------------------------------------------------- closing a business */
export const CLOSE_DAYS = 7;
export async function closeBusiness(c) {
  if (c.user.role !== 'owner') throw forbidden('Only the owner can close the business.');
  if (c.org.close_after) throw bad('The business is already set to close.');
  const u = await freshUser(c);
  await passwordAndCode(c, u);
  if (str(c.body.name, 120).toLowerCase() !== String(c.org.name).trim().toLowerCase()) throw bad('Type the business name exactly as it is, to be sure.');
  const at = new Date(Date.now() + CLOSE_DAYS * 864e5).toISOString();
  await c.db.batch([c.db.prepare(`UPDATE orgs SET close_after = ? WHERE id = ?`).bind(at, c.org.id), audit(c, 'business set to close', at.slice(0, 10))]);
  return { ok: true, close_after: at };
}
export async function cancelClose(c) {
  if (c.user.role !== 'owner') throw forbidden('Only the owner can do this.');
  if (!c.org.close_after) throw bad('The business is not set to close.');
  await c.db.batch([c.db.prepare(`UPDATE orgs SET close_after = '' WHERE id = ?`).bind(c.org.id), audit(c, 'closing cancelled')]);
  return { ok: true };
}

/* tables that hold rows of a business without an org_id column: their rows go first, found through the parent */
const CHILDREN = {
  doc_lines: 'doc_id IN (SELECT id FROM docs WHERE org_id = ?1)',
  payment_allocs: 'payment_id IN (SELECT id FROM payments WHERE org_id = ?1) OR doc_id IN (SELECT id FROM docs WHERE org_id = ?1)',
  bom_lines: 'bom_id IN (SELECT id FROM boms WHERE org_id = ?1)',
  write_off_lines: 'write_off_id IN (SELECT id FROM write_offs WHERE org_id = ?1)',
  pw_resets: 'user_id IN (SELECT id FROM users WHERE org_id = ?1)',
};
/* kept: the business's SmartTrader plan payments (tax records of the service) */
const KEEP = new Set(['orgs', 'billing_orders']);
const CHUNK = 5000;
/* Deletes every record of one business, a chunk per table per round, children before parents. Returns done:false when it ran out
   of rounds (a very large business): the next daily run carries on. */
export async function purgeOrg(db, orgId, rounds = 12) {
  const { results: tabs } = await db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'`).all();
  const info = await db.batch(tabs.map((t) => db.prepare(`PRAGMA table_info(${t.name})`)));
  const owned = tabs.filter((t, i) => !KEEP.has(t.name) && info[i].results.some((col) => col.name === 'org_id'));
  const children = tabs.filter((t) => Object.hasOwn(CHILDREN, t.name));
  const del = (t, cond) => (/WITHOUT ROWID/i.test(t.sql)
    ? db.prepare(`DELETE FROM ${t.name} WHERE ${cond}`)
    : db.prepare(`DELETE FROM ${t.name} WHERE rowid IN (SELECT rowid FROM ${t.name} WHERE ${cond} LIMIT ${CHUNK})`)).bind(orgId);
  const deleted = {};
  for (const set of [children.map((t) => [t, CHILDREN[t.name]]), owned.map((t) => [t, 'org_id = ?1'])]) {
    for (;;) {
      if (rounds-- <= 0) return { done: false, deleted };
      const res = await db.batch(set.map(([t, cond]) => del(t, cond)));
      let n = 0;
      res.forEach((r, i) => { const k = set[i][0].name, ch = (r.meta && r.meta.changes) || 0; if (ch) deleted[k] = (deleted[k] || 0) + ch; n += ch; });
      if (!n) break;
    }
  }
  await db.prepare(`DELETE FROM orgs WHERE id = ?`).bind(orgId).run();
  return { done: true, deleted };
}
/* the daily run: businesses whose 7 days are over (or, from the admin, one asked for by id that is set to close) */
export async function purgeClosed(env, { orgId = 0, now = nowIso() } = {}) {
  const { results } = orgId
    ? await env.DB.prepare(`SELECT id FROM orgs WHERE id = ? AND close_after != ''`).bind(orgId).all()
    : await env.DB.prepare(`SELECT id FROM orgs WHERE close_after != '' AND close_after <= ? LIMIT 3`).bind(now).all();
  const out = [];
  for (const o of results) out.push({ org_id: o.id, ...(await purgeOrg(env.DB, o.id)) });
  return out;
}
export const notOwnerWhileClosing = (org, user) => {
  if (org.close_after && user.role !== 'owner') throw new HttpError(403, 'This business is being closed by its owner.', { code: 'closing' });
};
