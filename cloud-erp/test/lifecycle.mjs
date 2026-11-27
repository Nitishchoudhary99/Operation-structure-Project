/* Messages at the right moment (runLifeMails in src/worker.js), on a small in-memory database:
   who gets which e-mail, once, and who gets none. node test/lifecycle.mjs */
import { DatabaseSync } from 'node:sqlite';
import { runLifeMails } from '../src/worker.js';
import { trialInfo } from '../src/saas.js';
import { today, addDays } from '../src/lib.js';
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (info ? '  ' + info : '')); } };
const sq = new DatabaseSync(':memory:');
const st = (sql) => ({ bind: (...a) => ({
  all: async () => ({ results: sq.prepare(sql).all(...a) }), first: async () => sq.prepare(sql).get(...a) || null,
  run: async () => ({ meta: { changes: sq.prepare(sql).run(...a).changes } }) }) });
const DB = { prepare: st, batch: async (l) => { for (const x of l) await x.run(); } };
sq.exec(`CREATE TABLE orgs (id INTEGER PRIMARY KEY, name TEXT, plan TEXT, plan_until TEXT DEFAULT '', trial_end TEXT DEFAULT '', created_at TEXT, close_after TEXT, demo INT DEFAULT 0,
    life_mail TEXT NOT NULL DEFAULT '', offer_until TEXT NOT NULL DEFAULT '', offer_kind TEXT NOT NULL DEFAULT '');
  CREATE TABLE users (id INTEGER PRIMARY KEY, org_id INT, email TEXT, name TEXT, role TEXT, active INT DEFAULT 1, mkt_ok INT DEFAULT 0, mail_token TEXT, mail_off INT DEFAULT 0);
  CREATE TABLE docs (id INTEGER PRIMARY KEY, org_id INT, type TEXT, status TEXT DEFAULT 'open', date TEXT, created_at TEXT);`);
const t = today(), iso = (d) => d + 'T10:00:00.000Z';
const org = (id, name, o = {}) => {
  sq.prepare(`INSERT INTO orgs (id, name, plan, plan_until, created_at, close_after, demo) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, name, o.plan || 'free', o.plan_until || '', iso(o.created || addDays(t, -100)), o.close || '', o.demo || 0);
  sq.prepare(`INSERT INTO users (id, org_id, email, name, role, mkt_ok, mail_off) VALUES (?, ?, ?, ?, 'owner', ?, ?)`).run(id, id, `o${id}@test.in`, 'Owner ' + id, o.mkt ? 1 : 0, o.off ? 1 : 0);
};
const bills = (id, n, day) => { for (let i = 0; i < n; i++) sq.prepare(`INSERT INTO docs (org_id, type, date, created_at) VALUES (?, 'INV', ?, ?)`).run(id, day, iso(day)); };
// 1 new, no bill; 2 new, has a bill; 3 free, 20 of 25 bills this month; 4 quiet 40 days, chose offers; 5 same, did not choose;
// 6 quiet but stopped e-mails; 7 demo; 8 on a paid plan with 30 bills
org(1, 'New Shop', { created: addDays(t, -4) });
org(2, 'Busy New Shop', { created: addDays(t, -4) }); bills(2, 1, t);
org(3, 'Nearly Full', { created: '2026-11-23' }); bills(3, 20, t);
org(4, 'Quiet Opt-in', { mkt: true }); bills(4, 3, addDays(t, -40));
org(5, 'Quiet No Opt-in'); bills(5, 3, addDays(t, -40));
org(6, 'Stopped Mails', { mkt: true, off: true }); bills(6, 1, addDays(t, -40));
org(7, 'Demo', { demo: 1, created: addDays(t, -4) });
org(8, 'Paid', { plan: 'growth', plan_until: addDays(t, 200), created: '2026-11-23' }); bills(8, 30, t);
const sent = [];
globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); sent.push({ to: b.to[0], subject: b.subject, html: b.html, unsub: (b.headers || {})['List-Unsubscribe'] }); return new Response('{}'); };
const env = { DB, RESEND_API_KEY: 'test', APP_URL: 'https://erp.docbrisk.com' };
const r = await runLifeMails(env);
const to = (id) => sent.filter((m) => m.to === `o${id}@test.in`);
check('new shop with no bill gets "make your first bill"', to(1).length === 1 && /first bill/.test(to(1)[0].subject), JSON.stringify(to(1).map((m) => m.subject)));
check('new shop that already billed gets nothing', to(2).length === 0);
check('free shop at 20 of 25 bills gets the 20% offer', to(3).length === 1 && /20 of your 25 free bills: 20% off/.test(to(3)[0].subject), JSON.stringify(to(3).map((m) => m.subject)));
const o3 = sq.prepare('SELECT * FROM orgs WHERE id = 3').get(), i3 = trialInfo(o3);
check('...and its 7-day offer is open, marked as a limit offer', o3.offer_until === addDays(t, 7) && i3.offer_pct === 20 && i3.offer_kind === 'limit', JSON.stringify([o3.offer_until, i3]));
check('quiet shop that chose offers gets the win-back offer', to(4).length === 1 && /We kept your shop ready/.test(to(4)[0].subject));
check('quiet shop that did not choose offers gets no win-back', to(5).length === 0);
check('an owner who stopped e-mails gets none', to(6).length === 0);
check('demo shops get none', to(7).length === 0);
check('a paid shop gets no upgrade offer', to(8).length === 0);
check('every e-mail carries a stop link and a List-Unsubscribe header', sent.length > 0 && sent.every((m) => /\/api\/public\/unsub\/[0-9a-f]{32}/.test(m.html) && /^<https:\/\/erp\.docbrisk\.com\/api\/public\/unsub\//.test(m.unsub || '')));
const before = sent.length; await runLifeMails(env);
check('running again the same day sends nothing new', sent.length === before, `${before} -> ${sent.length}`);
check('the count returned matches', r.due === before);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
