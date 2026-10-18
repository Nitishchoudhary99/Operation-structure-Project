/* Authentication: PBKDF2 passwords, HMAC-signed session cookies, roles, rate limits. */
import { HttpError, forbidden, own } from './lib.js';

/* Workers Free allows ~10 ms CPU per request; 30k PBKDF2 rounds fits, 100k does not. */
const PBKDF2_ITERATIONS = 30000;
const SESSION_DAYS = 30;
export const COOKIE = 'st_session';

const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

export const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

export async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS }, key, 256);
  return hex(bits);
}

export function sameText(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

export function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 8) return 'Password must be at least 8 characters.';
  if (s.length > 200) return 'Password must be at most 200 characters.';
  if (/^(password|12345678|qwerty|admin|welcome)/i.test(s)) return 'Choose a less guessable password.';
  return null;
}

/* The signing secret: SESSION_SECRET if set, otherwise one generated once and kept in the database. */
let secretCache = null;
async function sessionSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (secretCache) return secretCache;
  let row = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'session_secret'`).first();
  if (!row) {
    await env.DB.prepare(`INSERT OR IGNORE INTO meta (k, v) VALUES ('session_secret', ?)`).bind(randomHex(32)).run();
    row = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'session_secret'`).first();
  }
  return (secretCache = row.v);
}

let keyCache = null;          // the imported HMAC key, kept for the life of this isolate
async function hmac(secret, text) {
  if (!keyCache || keyCache.secret !== secret) {
    keyCache = { secret, key: await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) };
  }
  const key = keyCache.key;
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text))));
}

export async function issueSession(env, user) {
  const body = b64url(enc.encode(JSON.stringify({ u: user.id, o: user.org_id, v: user.pw_changed_at, e: Date.now() + SESSION_DAYS * 864e5, i: randomHex(12) })));
  return body + '.' + (await hmac(await sessionSecret(env), body));
}

const secureFlag = (request) => (new URL(request.url).protocol === 'https:' ? '; Secure' : '');
export function sessionCookie(token, request) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secureFlag(request)}`;
}
export const clearCookie = (request) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${request ? secureFlag(request) : ''}`;

/* The signed session from the cookie (or Bearer token): { u: user id, o: business id, v: password version, i: session id }, or null. */
export async function sessionFromRequest(env, request) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const token = (m && m[1]) || auth;
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  if (!sameText(sig, await hmac(await sessionSecret(env), body))) return null;
  let p;
  try { p = JSON.parse(b64urlDecode(body)); } catch (e) { return null; }
  return p && typeof p === 'object' && p.e >= Date.now() ? p : null;
}
/* Logout: this one session id goes on the revoked list until the token would have expired anyway.
   A token from before session ids existed has none, so it is ended by moving the user's password version instead. */
export async function revokeSession(env, p) {
  const now = Date.now();
  if (p.i) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM revoked_tokens WHERE exp < ?`).bind(now),
      env.DB.prepare(`INSERT OR IGNORE INTO revoked_tokens (jti, exp) VALUES (?, ?)`).bind(String(p.i).slice(0, 40), +p.e || now),
    ]);
  } else await endAllSessions(env, p.u);
}
/* Every token of this user stops working (they all carry the old password version). */
export async function endAllSessions(env, userId) {
  const v = Date.now();
  await env.DB.prepare(`UPDATE users SET pw_changed_at = MAX(pw_changed_at + 1, ?) WHERE id = ?`).bind(v, userId).run();
}

/* seat = how many older active staff the business has: when a plan lapses only the owner and the oldest staff keep a seat */
export const USER_SQL = `SELECT u.id, u.org_id, u.email, u.name, u.role, u.active, u.pw_changed_at, u.role_id, r.name AS role_name, r.perms,
  (SELECT COUNT(*) FROM users x WHERE x.org_id = u.org_id AND x.active = 1 AND x.role != 'owner' AND x.id < u.id) AS seat
  FROM users u LEFT JOIN roles r ON r.id = u.role_id AND r.org_id = u.org_id WHERE u.id = ?`;
export const REVOKED_SQL = `SELECT 1 AS x FROM revoked_tokens WHERE jti = ?`;
/* the user row still matches the session: active, same business, password not changed since */
export const sessionValid = (user, p) => !!(user && user.active && user.org_id === p.o && user.pw_changed_at === p.v);


/* ---------- roles ----------
   owner/admin: everything; accountant: finance + reports; store: stock + procurement; sales: selling + khata.
   Every role can read its business's data; writes are checked per area. */
export const ROLES = ['owner', 'admin', 'accountant', 'store', 'sales'];
const WRITE = {
  settings: ['owner', 'admin'],
  users: ['owner', 'admin'],
  masters: ['owner', 'admin', 'accountant', 'store', 'sales'],
  items: ['owner', 'admin', 'store'],
  purchase: ['owner', 'admin', 'store', 'accountant'],
  sales: ['owner', 'admin', 'sales', 'accountant'],
  stock: ['owner', 'admin', 'store'],
  finance: ['owner', 'admin', 'accountant'],
  khata: ['owner', 'admin', 'accountant', 'sales'],
};
/* Custom roles (role = 'custom', role_id -> roles): per-area "view" and "edit" switches.
   Built-in roles keep the table above and can view everything, as before. Only owner/admin manage users and roles. */
export const AREAS = ['sales', 'purchase', 'items', 'masters', 'finance', 'khata', 'reports', 'settings'];
const AREA_OF = { stock: 'items' };
export function permsOf(user) {
  let p = {};
  try { p = JSON.parse(user.perms || '{}') || {}; } catch (e) { /* bad JSON = no rights */ }
  const edit = AREAS.filter((a) => Array.isArray(p.edit) && p.edit.includes(a));
  return { edit, view: AREAS.filter((a) => edit.includes(a) || (Array.isArray(p.view) && p.view.includes(a))) };
}
const areaOf = (area) => own(AREA_OF, area) || area;
export function can(user, area) {
  if (user.role === 'custom') return area !== 'users' && permsOf(user).edit.includes(areaOf(area));
  const roles = own(WRITE, area);
  return !!(roles && roles.includes(user.role));
}
export const canView = (user, area) => !user || user.role !== 'custom' || permsOf(user).view.includes(areaOf(area));
/* purchase rates, average cost, stock value and profit: hidden from custom roles that see neither reports nor purchase */
export const seesCosts = (user) => canView(user, 'reports') || canView(user, 'purchase');
export function requireCan(user, area) { if (!can(user, area)) throw forbidden(); }

/* Expired counters are removed now and then (1 call in 100, 200 rows at most), so the table cannot grow without bound. */
async function purgeLimits(env, now) {
  if (Math.random() < 0.01) await env.DB.prepare(`DELETE FROM rate_limits WHERE k IN (SELECT k FROM rate_limits WHERE reset_at < ? LIMIT 200)`).bind(now - 3600).run().catch(() => {});
}
const tooMany = (secs) => new HttpError(429, `Too many attempts. Try again in ${Math.max(1, secs)} seconds.`);

/* Fixed-window rate limit kept in D1. */
export async function rateLimit(env, key, max, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  await purgeLimits(env, now);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (k, n, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(k) DO UPDATE SET n = CASE WHEN reset_at < ? THEN 1 ELSE n + 1 END,
                                  reset_at = CASE WHEN reset_at < ? THEN excluded.reset_at ELSE reset_at END
     RETURNING n, reset_at`).bind(key, now + windowSec, now, now).first();
  if (row && row.n > max) throw tooMany(row.reset_at - now);
}

/* Login throttle. Only FAILED attempts are counted, so a successful login costs one D1 read and no write.
   Three counters: per address (password spraying over many accounts), per account + address (one stranger cannot
   lock the owner out from elsewhere) and a looser per-account cap (slow distributed guessing).
   Attempts still in flight in this isolate are counted too, so a burst of parallel guesses cannot all slip past the check. */
const LOGIN_WINDOW = 900;
const loginKeys = (email, ip) => [['lg-ip:' + ip, 30], ['lg-ai:' + email + ':' + ip, 10], ['lg-acct:' + email, 40]];
const inflight = new Map();
export async function loginGate(env, email, ip) {
  const keys = loginKeys(email, ip), now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare(`SELECT k, n, reset_at FROM rate_limits WHERE k IN (?, ?, ?)`).bind(...keys.map((k) => k[0])).all();
  const by = new Map(results.map((r) => [r.k, r]));
  let wait = 0;
  for (const [k, max] of keys) {
    const r = by.get(k), live = r && r.reset_at >= now;
    if ((live ? r.n : 0) + (inflight.get(k) || 0) >= max) wait = Math.max(wait, live ? r.reset_at - now : 1);
  }
  if (wait) throw tooMany(wait);
  for (const [k] of keys) inflight.set(k, (inflight.get(k) || 0) + 1);
  return () => { for (const [k] of keys) { const v = (inflight.get(k) || 1) - 1; if (v > 0) inflight.set(k, v); else inflight.delete(k); } };
}
export async function loginFailed(env, email, ip) {
  const keys = loginKeys(email, ip), now = Math.floor(Date.now() / 1000);
  await purgeLimits(env, now);
  const res = await env.DB.batch(keys.map(([k]) => env.DB.prepare(
    `INSERT INTO rate_limits (k, n, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(k) DO UPDATE SET n = CASE WHEN reset_at < ? THEN 1 ELSE n + 1 END,
                                  reset_at = CASE WHEN reset_at < ? THEN excluded.reset_at ELSE reset_at END
     RETURNING n, reset_at`).bind(k, now + LOGIN_WINDOW, now, now)));
  const over = res.map((r, i) => ({ r: r.results[0], max: keys[i][1] })).filter((x) => x.r && x.r.n > x.max);
  if (over.length) throw tooMany(Math.max(...over.map((x) => x.r.reset_at - now)));
}
