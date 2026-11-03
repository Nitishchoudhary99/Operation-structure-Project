/* Adding SESSION_SECRET to a deployment that ran without it (the key was kept in the database) must not lock anyone
   out: a two-step secret sealed with the old key still opens, the user signs in with their code, and the secret is
   sealed again with the new key. Runs in Node with its own SQLite standing in for D1 (Node 22.5+).
     node test/keys.mjs */
import { DatabaseSync } from 'node:sqlite';
import { sessionSecret, legacySecret } from '../src/auth.js';
import { twoStepStart, twoStepEnable, secondStep, totpCode } from '../src/security.js';

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };

/* the part of D1's API the code uses */
const sql = new DatabaseSync(':memory:');
sql.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY, org_id INTEGER, email TEXT, totp_secret TEXT, totp_last INTEGER DEFAULT 0, totp_on INTEGER DEFAULT 0, totp_backup TEXT);
  CREATE TABLE audit (org_id INTEGER, user_id INTEGER, at TEXT, action TEXT, detail TEXT);
  INSERT INTO users (id, org_id, email) VALUES (1, 1, 'owner@test.in');`);
const stmt = (q, args = []) => ({
  bind: (...a) => stmt(q, a),
  first: async () => sql.prepare(q).get(...args) ?? null,
  all: async () => ({ results: sql.prepare(q).all(...args) }),
  run: async () => ({ meta: { changes: Number(sql.prepare(q).run(...args).changes) } }),
});
const DB = { prepare: (q) => stmt(q), batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; } };
const user = () => sql.prepare(`SELECT * FROM users WHERE id = 1`).get();
const step = () => Math.floor(Date.now() / 30000);

// 1. no SESSION_SECRET: a key is made and kept in the database, and two-step sign-in is turned on with it
const before = { DB };
const dbKey = await sessionSecret(before);
check('without SESSION_SECRET the key is kept in the database', /^[0-9a-f]{64}$/.test(dbKey) && sql.prepare(`SELECT v FROM meta WHERE k = 'session_secret'`).get().v === dbKey);
check('and there is no older key to fall back to', (await legacySecret(before)) === null);
const c = { env: before, db: DB, user: { id: 1 }, org: { id: 1 }, body: {} };
const { secret } = await twoStepStart(c);
c.body.code = await totpCode(secret, step());
await twoStepEnable(c);
const sealedOld = user().totp_secret;
check('two-step sign-in is on, its secret sealed (not in plain text)', user().totp_on === 1 && sealedOld && !sealedOld.includes(secret));

// 2. SESSION_SECRET is added: the user still signs in with the code from their app
const after = { DB, SESSION_SECRET: 'a-long-random-session-secret-for-this-test-0123456789' };
check('after SESSION_SECRET is added, the old database key is known as the older key', (await legacySecret(after)) === dbKey);
sql.prepare(`UPDATE users SET totp_last = 0 WHERE id = 1`).run();
const how = await secondStep(after, DB, user(), await totpCode(secret, step()));
check('the user signs in with their authenticator code (not locked out)', how === 'code', how);
const sealedNew = user().totp_secret;
check('the secret was sealed again with the new key', sealedNew && sealedNew !== sealedOld);

// 3. the new seal opens with the new key alone (worked out here the same way the worker does)
const enc = new TextEncoder();
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));
const keyOf = async (k) => crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode('smarttrader-2fa|' + k)), 'AES-GCM', false, ['decrypt']);
const open = async (sealed, k) => { const [iv, ct] = sealed.split('.'); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, await keyOf(k), unb64u(ct))); };
check('the new seal opens with SESSION_SECRET', (await open(sealedNew, after.SESSION_SECRET)) === secret);
check('and no longer with the old database key', await open(sealedNew, dbKey).then(() => false, () => true));

// 4. a wrong code is still refused after the change
sql.prepare(`UPDATE users SET totp_last = 0 WHERE id = 1`).run();
check('a wrong code is refused', (await secondStep(after, DB, user(), '000000')) === '' || (await totpCode(secret, step())) === '000000');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
