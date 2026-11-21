/* Refer & earn. node test/referral.mjs [http://localhost:8787]
   Part 1 (no server): the inviter's free month, on a small in-memory database. Part 2 (server): sign-up by invite. */
import { DatabaseSync } from 'node:sqlite';
import { rewardInviter } from '../src/billing.js';
import { today, addDays } from '../src/lib.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (info ? '  ' + info : '')); } };
// a D1-shaped wrapper over node:sqlite
const d1 = (sq) => {
  const st = (sql) => ({ bind: (...a) => ({ run: async () => ({ meta: { changes: sq.prepare(sql).run(...a).changes } }), first: async () => sq.prepare(sql).get(...a) || null }) });
  return { prepare: st, batch: async (list) => { for (const x of list) await x.run(); } };
};
const mk = () => {
  const sq = new DatabaseSync(':memory:');
  sq.exec(`CREATE TABLE orgs (id INTEGER PRIMARY KEY, name TEXT, plan TEXT, plan_until TEXT, trial_end TEXT DEFAULT '', referred_by INTEGER, ref_rewarded INTEGER DEFAULT 0);
           CREATE TABLE audit (org_id INTEGER, user_id INTEGER, at TEXT, action TEXT, detail TEXT);`);
  return { sq, db: d1(sq) };
};
const t = today();
{ const { sq, db } = mk();
  sq.prepare(`INSERT INTO orgs (id, name, plan, plan_until) VALUES (1, 'Inviter', 'free', '')`).run();
  sq.prepare(`INSERT INTO orgs (id, name, plan, plan_until, referred_by) VALUES (2, 'Friend', 'growth', ?, 1)`).run(addDays(t, 365));
  await rewardInviter(db, sq.prepare('SELECT * FROM orgs WHERE id = 2').get());
  const a = sq.prepare('SELECT * FROM orgs WHERE id = 1').get();
  check('an inviter on Free gets 30 days of Growth from today', a.plan === 'growth' && a.plan_until === addDays(t, 30), JSON.stringify(a));
  await rewardInviter(db, sq.prepare('SELECT * FROM orgs WHERE id = 2').get());
  check('the reward is given once, not on the next payment', sq.prepare('SELECT plan_until FROM orgs WHERE id = 1').get().plan_until === addDays(t, 30));
  check('the reward is in the audit log', sq.prepare(`SELECT COUNT(*) AS n FROM audit WHERE org_id = 1 AND action = 'referral reward'`).get().n === 1); }
{ const { sq, db } = mk();
  sq.prepare(`INSERT INTO orgs (id, name, plan, plan_until) VALUES (1, 'Inviter', 'starter', ?)`).run(addDays(t, 100));
  sq.prepare(`INSERT INTO orgs (id, name, plan, plan_until, referred_by) VALUES (2, 'Friend', 'growth', ?, 1)`).run(addDays(t, 365));
  await rewardInviter(db, sq.prepare('SELECT * FROM orgs WHERE id = 2').get());
  const a = sq.prepare('SELECT * FROM orgs WHERE id = 1').get();
  check('an inviter with a running plan gets 30 days added to it', a.plan === 'starter' && a.plan_until === addDays(t, 130), JSON.stringify(a)); }
{ const { sq, db } = mk();
  sq.prepare(`INSERT INTO orgs (id, name, plan, plan_until, trial_end) VALUES (1, 'Inviter', 'growth', ?, ?)`).run(addDays(t, 5), addDays(t, 5));
  sq.prepare(`INSERT INTO orgs (id, name, plan, plan_until, referred_by) VALUES (2, 'Friend', 'growth', ?, 1)`).run(addDays(t, 365));
  await rewardInviter(db, sq.prepare('SELECT * FROM orgs WHERE id = 2').get());
  const a = sq.prepare('SELECT * FROM orgs WHERE id = 1').get();
  check('an inviter on its free trial gets the trial made 30 days longer', a.plan_until === addDays(t, 35) && a.trial_end === addDays(t, 35), JSON.stringify(a)); }

const BASE = process.argv[2];
if (BASE) {
  let ck = '';
  const rq = async (m, p, b, cookie = ck) => { const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', Cookie: cookie, 'CF-Connecting-IP': '203.0.113.' + (10 + Math.floor(Math.random() * 200)) }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); return { status: r.status, data: await r.json().catch(() => ({})), cookie: sc ? sc.split(';')[0] : '' }; };
  const n = Date.now();
  const a = await rq('POST', '/api/auth/signup', { business: 'Inviting Shop', name: 'A', email: `inv${n}@test.in`, password: 'Tenant-pass-1', state: 'Rajasthan' });
  ck = a.cookie;
  const r = (await rq('GET', '/api/referral')).data;
  check('the owner gets an invite code and link', /^[0-9a-f]{8}$/.test(r.code) && r.link.endsWith('/?ref=' + r.code) && r.joined === 0, JSON.stringify(r));
  const pub = (await rq('GET', '/api/public/ref/' + r.code, undefined, '')).data;
  check('the sign-up page can name the inviter (and nothing else)', pub.ok && pub.name === 'Inviting Shop' && Object.keys(pub).length === 3, JSON.stringify(pub));
  check('an unknown code names nobody', (await rq('GET', '/api/public/ref/00000000', undefined, '')).data.ok === false);
  const b = await rq('POST', '/api/auth/signup', { business: 'Friend Shop', name: 'B', email: `fr${n}@test.in`, password: 'Tenant-pass-1', state: 'Rajasthan', ref: r.code }, '');
  const me = (await rq('GET', '/api/me', undefined, b.cookie)).data;
  check('a shop that joins by invite gets a 45-day trial', me.plan && me.plan.trial && me.plan.until === addDays(t, 45), JSON.stringify(me.plan));
  const c = await rq('POST', '/api/auth/signup', { business: 'Plain Shop', name: 'C', email: `pl${n}@test.in`, password: 'Tenant-pass-1', state: 'Rajasthan', ref: 'zzzz' }, '');
  check('a bad code is ignored: the usual 30-day trial', (await rq('GET', '/api/me', undefined, c.cookie)).data.plan.until === addDays(t, 30));
  check('the inviter sees one shop joined', (await rq('GET', '/api/referral')).data.joined === 1);
  check('a staff-free view: the invite page needs the owner', (await rq('GET', '/api/referral', undefined, '')).status === 401);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
