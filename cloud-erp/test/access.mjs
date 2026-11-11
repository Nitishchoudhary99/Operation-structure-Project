/* Access-control attack test (zero trust): every API route of the worker is called the way an attacker would,
   and every answer is checked at the server.
     node test/access.mjs [http://localhost:8787]
   Needs a fresh dev server started with a known signing secret (to mint an expired / forged token):
     npx wrangler dev --port 8787 --persist-to <fresh dir> --var QUERY_COUNT:1 --var SESSION_SECRET:access-test-secret-0123456789
   Writes a JSON report (every test, result, evidence) to test/access-report.json.

   Who attacks:
     anon   - no cookie, a forged cookie, an expired token, a token for another business
     B      - the owner of another business, using Company A's ids in the URL, the query and the body
     guard  - Company A staff with a custom role that may only use the gate register
     sales  - Company A staff with the built-in "sales" role (no settings / users rights)
     gone   - Company A staff who was switched off by the owner
   Company A's data is marked "ZZA" so that any answer that carries it to the wrong person is caught. */
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Router } from '../src/lib.js';

const BASE = process.argv[2] || process.env.ERP_URL || 'http://localhost:8787';
const SECRET = process.env.SESSION_SECRET || 'access-test-secret-0123456789';
const results = [];
let pass = 0, fail = 0, ipn = 10;

function record(id, test, ok, evidence) {
  results.push({ id, test, result: ok ? 'PASS' : 'FAIL', evidence });
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${test}${ok ? '' : '  ' + JSON.stringify(evidence).slice(0, 400)}`);
}

const rq = async (method, path, body, o = {}) => {
  const res = await fetch(BASE + path, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'SmartTrader', 'CF-Connecting-IP': o.ip || `198.18.${(ipn >> 8) & 255}.${ipn++ & 255}`,
      ...(o.cookie ? { Cookie: o.cookie } : {}), ...(o.headers || {}) },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { data = { _text: text.slice(0, 200) }; }
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, text, cookie: sc ? sc.split(';')[0] : '' };
};
const ok2 = (r) => r.status >= 200 && r.status < 300;
const must = async (method, path, body, o) => {
  const r = await rq(method, path, body, o);
  if (!ok2(r)) throw new Error(`${method} ${path} -> ${r.status} ${r.text.slice(0, 200)}`);
  return r;
};

/* ---------------------------------------------------------------- the route table, read from the worker itself */
const routes = [];
{
  const orig = Router.prototype.add;
  Router.prototype.add = function (method, pattern, handler, opts = {}) {
    routes.push({ method, pattern, public: !!opts.public, webhook: !!opts.webhook });
    return orig.call(this, method, pattern, handler, opts);
  };
  await import(pathToFileURL(new URL('../src/worker.js', import.meta.url).pathname).href);
  Router.prototype.add = orig;
}
const priv = routes.filter((r) => !r.public);
console.log(`${routes.length} routes, ${priv.length} need a signed-in user, ${routes.length - priv.length} public / webhook / admin-key\n`);

/* ---------------------------------------------------------------- two businesses */
const stamp = Date.now();
const signup = async (tag, name) => {
  const r = await must('POST', '/api/auth/signup', { business: name, name: `${tag}-owner`, email: `${tag.toLowerCase()}${stamp}@access.test`, password: 'Access-pass-12345', state: 'Bihar' });
  return { cookie: r.cookie, me: (await must('GET', '/api/me', undefined, { cookie: r.cookie })).data };
};
const A = await signup('ZZA', 'ZZA Alpha Traders'), B = await signup('YYB', 'YYB Beta Stores');
const a = { cookie: A.cookie }, b = { cookie: B.cookie };

// Company A's data, all marked ZZA
const itemA = (await must('POST', '/api/items', { name: 'ZZA secret item', sale_price: 120, purchase_price: 80, gst_rate: 5, opening_qty: 50 }, a)).data;
const custA = (await must('POST', '/api/parties', { name: 'ZZA secret customer', kind: 'customer', state: 'Bihar', phone: '9000000001' }, a)).data;
const suppA = (await must('POST', '/api/parties', { name: 'ZZA secret supplier', kind: 'supplier', state: 'Bihar' }, a)).data;
const invA = (await must('POST', '/api/docs', { type: 'INV', party_id: custA.id, notes: 'ZZA secret invoice', lines: [{ item_id: itemA.id, qty: 2 }] }, a)).data;
const soA = (await must('POST', '/api/docs', { type: 'SO', party_id: custA.id, notes: 'ZZA secret order', lines: [{ item_id: itemA.id, qty: 1 }] }, a)).data;
const poA = (await must('POST', '/api/docs', { type: 'PO', party_id: suppA.id, notes: 'ZZA secret purchase', lines: [{ item_id: itemA.id, qty: 5 }] }, a)).data;
const roleGuard = (await must('POST', '/api/roles', { name: 'ZZA guard', perms: { view: ['gate'], edit: ['gate'] } }, a)).data;
const mkUser = async (tag, role) => {
  const email = `${tag}${stamp}@access.test`;
  await must('POST', '/api/users', { email, name: `ZZA ${tag}`, role, password: 'Staff-pass-12345' }, a);
  return (await must('POST', '/api/auth/login', { email, password: 'Staff-pass-12345' })).cookie;
};
const guard = { cookie: await mkUser('guard', `c:${roleGuard.id || roleGuard.role?.id}`) };
const sales = { cookie: await mkUser('sales', 'sales') };
const goneCookie = await mkUser('gone', 'store');
const usersA = (await must('GET', '/api/users', undefined, a)).data;
const userRows = usersA.rows || usersA.users || [];

/* every number called "id" anywhere in Company A's lists: the ids an attacker would try */
const idsA = { docs: [invA.id, soA.id, poA.id], items: [itemA.id], parties: [custA.id, suppA.id], users: userRows.map((u) => u.id), roles: [roleGuard.id] };
const anyIdsA = new Set(Object.values(idsA).flat().filter(Boolean));
const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) { if (/(^|_)id$/.test(k) && Number.isInteger(x) && x > 0) anyIdsA.add(x); walk(x); } } };
for (const r of priv.filter((r) => r.method === 'GET' && !r.pattern.includes(':'))) {
  const res = await rq('GET', r.pattern, undefined, a);
  if (ok2(res)) walk(res.data);
}
const KIND = [[/^\/api\/(docs|doc|dispatch|courier\/(rates|track)|pick|receive|grn)/, 'docs'], [/^\/api\/(items|item|variants|stock|lots|serials|bom)/, 'items'],
  [/^\/api\/(parties|party|khata|vasooli|vaada|ledger|statement)/, 'parties'], [/^\/api\/users/, 'users'], [/^\/api\/roles/, 'roles']];
const idsFor = (pattern) => {
  const hit = KIND.find(([re]) => re.test(pattern));
  const own = hit ? idsA[hit[1]] : [];
  return [...new Set([...own, ...[...anyIdsA].slice(0, 3)])].slice(0, 4);
};
const fill = (pattern, id) => pattern.replace(/:([a-z_]+)/g, (_, k) => (/id$/.test(k) ? String(id) : k === 'kind' ? 'logo' : 'x' + 'ab12'.repeat(8)));

/* Company A's data as A sees it, to prove later that nobody else changed it */
const SNAP = ['/api/items', '/api/parties', '/api/docs?type=INV', '/api/docs?type=SO', '/api/docs?type=PO', '/api/users', '/api/roles', '/api/settings/print', '/api/me'];
const snapshot = async () => {
  const out = {};
  for (const p of SNAP) {
    const r = await rq('GET', p, undefined, a);
    out[p] = JSON.stringify(r.data, (k, v) => (/(_at|time|seen|last_|now|today|since|expires)$/i.test(k) ? undefined : v));
  }
  return out;
};
const idsB = new Set();
{
  const walkB = (v) => { if (Array.isArray(v)) v.forEach(walkB); else if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) { if (/(^|_)id$/.test(k) && Number.isInteger(x)) idsB.add(x); walkB(x); } } };
  for (const r of priv.filter((r) => r.method === 'GET' && !r.pattern.includes(':'))) { const res = await rq('GET', r.pattern, undefined, b); if (ok2(res)) walkB(res.data); }
  for (const x of idsB) if (!Object.values(idsA).flat().includes(x)) anyIdsA.delete(x);
}
const before = await snapshot();
const hasA = (r) => /ZZA/.test(r.text);

/* ---------------------------------------------------------------- 1, 8: anonymous and direct API calls */
{
  const bad = [];
  for (const r of priv) {
    const path = fill(r.pattern, idsFor(r.pattern)[0] || 1);
    const res = await rq(r.method, path, r.method === 'GET' ? undefined : {});
    const signinRedirect = res.status === 302 && r.pattern === '/api/gdrive/callback';      // Google sends the browser here
    if ((res.status !== 401 && !signinRedirect) || hasA(res)) bad.push(`${r.method} ${path} -> ${res.status}`);
  }
  record('ERP-01', `Anonymous user (no cookie), direct API call to every protected route (${priv.length} routes, read + write) gets 401 and no data`, bad.length === 0, bad.slice(0, 20));
  const html = await rq('GET', '/#/dashboard');
  const me = await rq('GET', '/api/me');
  record('ERP-01b', 'Anonymous user opening a protected screen gets only the app shell; the data call behind it is refused', me.status === 401 && !/ZZA/.test(html.text), { me: me.status });
}

/* ---------------------------------------------------------------- 11: forged, expired, cross-business tokens */
{
  const tok = (p) => { const body = Buffer.from(JSON.stringify(p)).toString('base64url'); return body + '.' + createHmac('sha256', SECRET).update(body).digest('base64url'); };
  const aMe = A.me.user, bMe = B.me.user;
  const meA = (await must('GET', '/api/me', undefined, a)).data.user;
  const tries = {
    'tampered signature': a.cookie.slice(0, -3) + 'abc',
    'body changed to another business, old signature': (() => { const [n, v] = a.cookie.split('='); const [body, sig] = v.split('.'); const p = JSON.parse(Buffer.from(body, 'base64url')); p.o = B.me.org.id; return `${n}=${Buffer.from(JSON.stringify(p)).toString('base64url')}.${sig}`; })(),
    'validly signed but expired': `${a.cookie.split('=')[0]}=${tok({ u: meA.id, o: A.me.org.id, v: 0, e: Date.now() - 1000, i: 'x1' })}`,
    'validly signed, user of A claiming business B': `${a.cookie.split('=')[0]}=${tok({ u: meA.id, o: B.me.org.id, v: 0, e: Date.now() + 1e7, i: 'x2' })}`,
    'validly signed but old password version': `${a.cookie.split('=')[0]}=${tok({ u: meA.id, o: A.me.org.id, v: 1, e: Date.now() + 1e7, i: 'x3' })}`,
  };
  const got = {};
  for (const [k, c] of Object.entries(tries)) got[k] = [(await rq('GET', '/api/items', undefined, { cookie: c })).status, (await rq('POST', '/api/items', { name: 'ZZX' }, { cookie: c })).status];
  record('ERP-11', 'Forged, tampered, expired, wrong-business and stale tokens are refused for reads and writes (401)', Object.values(got).every((s) => s[0] === 401 && s[1] === 401), got);
  void aMe; void bMe;
}

/* ---------------------------------------------------------------- 3,4,5,7,9: another business with Company A's ids */
{
  const leaks = [], allowed = [];
  let tried = 0;
  for (const r of priv) {
    if (!r.pattern.includes(':') && r.method !== 'GET') continue;           // B's own writes act on B only (body tests below)
    for (const id of (r.pattern.includes(':') ? idsFor(r.pattern) : [0])) {
      const path = fill(r.pattern, id) + (r.method === 'GET' && !r.pattern.includes(':') ? `?org_id=${A.me.org.id}&user_id=${idsA.users[0]}&company=${A.me.org.id}` : '');
      if (/\/api\/(org\/close|me\/logout-all|auth\/logout|me\/password)/.test(path)) continue;
      const res = await rq(r.method, path, r.method === 'GET' ? undefined : { id, org_id: A.me.org.id, name: 'YYB was here', notes: 'YYB was here', active: false, role: 'admin' }, b);
      tried++;
      if (hasA(res)) leaks.push(`${r.method} ${path} -> ${res.status}`);
      else if (ok2(res) && r.pattern.includes(':') && r.method !== 'GET') allowed.push(`${r.method} ${path} -> ${res.status}`);
    }
  }
  record('ERP-03/04/05/07', `Another business's owner (B) puts A's user / document / item / customer / dashboard ids into the URL and query on every route (${tried} requests): nothing of A comes back`, leaks.length === 0, leaks.slice(0, 20));
  const after = await snapshot();
  const changed = SNAP.filter((p) => before[p] !== after[p]);
  record('ERP-09w', 'Those writes with A\'s ids (PUT / POST / DELETE, with org_id of A in the body) changed nothing of Company A', changed.length === 0, { changed, accepted_by_server: allowed.slice(0, 20) });
}

{
  // the answer itself must not tell B anything about A's records (sold or not, there or not)
  const del = await rq('DELETE', `/api/items/${itemA.id}`, undefined, b);
  const none = await rq('DELETE', '/api/items/99999999', undefined, b);
  const t = await rq('DELETE', `/api/dine/tables/${idsA.docs[0]}`, undefined, b), u = await rq('POST', `/api/bank/unclear/${idsA.docs[0]}`, {}, b);
  record('ERP-04b', "Deleting A's item from B answers exactly like a missing item (404), never \"has transactions\" or a quiet ok; table / bank-line ids of others: 404",
    del.status === 404 && none.status === 404 && del.data.error === none.data.error && t.status === 404 && u.status === 404,
    { a_item: `${del.status} ${del.data.error}`, missing: `${none.status} ${none.data.error}`, table: t.status, bank_line: u.status });
}
/* ---------------------------------------------------------------- 9: ids of A inside B's request body */
{
  const t = {
    'invoice in B for A\'s customer and item': await rq('POST', '/api/docs', { type: 'INV', party_id: custA.id, lines: [{ item_id: itemA.id, qty: 1 }] }, b),
    'B\'s customer with A\'s item on the line': await (async () => {
      const cb = (await must('POST', '/api/parties', { name: 'YYB cust', kind: 'customer', state: 'Bihar' }, b)).data;
      return rq('POST', '/api/docs', { type: 'INV', party_id: cb.id, lines: [{ item_id: itemA.id, qty: 1 }] }, b);
    })(),
    'B renames its business with A\'s org id in the body': await rq('PUT', '/api/org', { id: A.me.org.id, org_id: A.me.org.id, name: 'YYB Beta Stores', state: 'Bihar' }, b),
    'B adds a user with A\'s org id in the body': await rq('POST', '/api/users', { org_id: A.me.org.id, email: `x${stamp}@access.test`, name: 'X', role: 'admin', password: 'Staff-pass-12345' }, b),
  };
  const aOrg = (await must('GET', '/api/me', undefined, a)).data.org.name;
  const aUsers = JSON.stringify((await must('GET', '/api/users', undefined, a)).data);
  const okRes = !ok2(t['invoice in B for A\'s customer and item']) && !ok2(t['B\'s customer with A\'s item on the line'])
    && aOrg === 'ZZA Alpha Traders' && !aUsers.includes(`x${stamp}@access.test`);
  record('ERP-09b', 'Request body manipulation: A\'s customer / item / org ids inside B\'s requests are refused or ignored; A\'s business and users unchanged',
    okRes, Object.fromEntries(Object.entries(t).map(([k, v]) => [k, `${v.status} ${v.text.slice(0, 80)}`])));
}

/* ---------------------------------------------------------------- 2: ordinary staff on admin / settings / users */
{
  const ADMIN = [['GET', '/api/admin/orgs'], ['GET', '/api/admin/payments'], ['GET', '/api/admin/config'], ['GET', '/api/admin/integrity'], ['POST', `/api/admin/orgs/${A.me.org.id}/plan`], ['POST', '/api/admin/purge']];
  const got = [];
  for (const who of [['owner A', a], ['sales', sales]]) {
    for (const [m, p] of ADMIN) {
      for (const key of [undefined, 'wrong-admin-key-123456']) {
        const r = await rq(m, p, m === 'GET' ? undefined : { plan: 'business', days: 999 }, { ...who[1], headers: key ? { 'X-Admin-Key': key } : {} });
        if (r.status !== 401 && r.status !== 404) got.push(`${who[0]} ${m} ${p} key=${!!key} -> ${r.status}`);
      }
    }
  }
  record('ERP-02a', 'Deployment admin panel (/api/admin/*): owners and staff, with no key or a wrong key, are refused (401)', got.length === 0, got);
  const PRIV = [['PUT', '/api/org', { name: 'hacked' }], ['PUT', '/api/org/mode', { mode: 'advanced' }], ['POST', '/api/users', { email: `s${stamp}x@access.test`, name: 'S', role: 'admin', password: 'Staff-pass-12345' }],
    ['PUT', `/api/users/${idsA.users.find((x) => x) }`, { role: 'admin' }], ['POST', '/api/roles', { name: 'evil', perms: { view: ['settings'], edit: ['settings'] } }],
    ['PUT', '/api/settings/require-2fa', { on: false }], ['PUT', '/api/settings/print', { layout: 'modern' }], ['PUT', '/api/settings/workflow', {}], ['PUT', '/api/settings/approvals', { limit: 0 }],
    ['GET', '/api/users'], ['GET', '/api/audit'], ['POST', '/api/org/close', {}], ['POST', `/api/users/${idsA.users[0]}/2fa-reset`, {}]];
  const g2 = [];
  for (const [m, p, body] of PRIV) {
    const r = await rq(m, p, body, sales);
    if (r.status !== 403) g2.push(`sales ${m} ${p} -> ${r.status}`);
  }
  record('ERP-02b', 'Built-in "sales" staff cannot change the business, settings, users, roles, two-step rule, or close the business (403)', g2.length === 0, g2);
}

/* ---------------------------------------------------------------- least privilege: a gate-only custom role on every route */
{
  const leaks = [], writes = [];
  for (const r of priv) {
    if (/^\/api\/(me|security|auth)/.test(r.pattern)) continue;              // a user's own account
    if (/\/api\/(org\/close|me\/logout-all)/.test(r.pattern)) continue;
    const path = fill(r.pattern, idsFor(r.pattern)[0] || 1);
    const res = await rq(r.method, path, r.method === 'GET' ? undefined : { name: 'ZZG', notes: 'ZZG' }, guard);
    const gate = /^\/api\/gate/.test(r.pattern);
    if (r.method === 'GET' && ok2(res) && !gate && /ZZA secret/.test(res.text)) leaks.push(`${r.method} ${path} -> ${res.status}`);
    // a user's own saved dashboard layouts are theirs (scoped to user_id, checked below that no figures leak)
    const personal = /^\/api\/dashboards/.test(r.pattern);
    if (r.method !== 'GET' && ok2(res) && !gate && !personal) writes.push(`${r.method} ${path} -> ${res.status}`);
  }
  {
    const { WIDGETS } = await import('../src/widgets.js').catch(() => ({}));
    const ids = Object.keys(WIDGETS || {});
    const r = await rq('GET', `/api/dash/widgets?ids=${ids.join(',')}`, undefined, guard);
    const answered = Object.entries((r.data && r.data.widgets) || {}).filter(([, v]) => v && !['denied', 'error'].includes(v.kind) && !v.kind?.startsWith?.('client') && v.kind !== undefined && JSON.stringify(v).length > 40);
    record('ERP-02e', `Dashboard figures: a gate-only role asking for every one of the ${ids.length} dashboard widgets gets "denied" for all business figures`,
      r.status === 200 && answered.length === 0 && ids.length > 0, { status: r.status, answered: answered.map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 80)}`).slice(0, 10) });
  }
  record('ERP-02c', 'A gate-only custom role sees none of the business\'s items / customers / bills on any route', leaks.length === 0, leaks.slice(0, 20));
  record('ERP-02d', 'A gate-only custom role cannot write anything outside the gate register on any route', writes.length === 0, writes.slice(0, 20));
}

/* ---------------------------------------------------------------- 10: removed user; logout; password change */
{
  const goneMe = (await rq('GET', '/api/me', undefined, { cookie: goneCookie })).data.user;
  await must('PUT', `/api/users/${goneMe.id}`, { active: false }, a);
  const r1 = await rq('GET', '/api/items', undefined, { cookie: goneCookie }), r2 = await rq('POST', '/api/items', { name: 'ZZX' }, { cookie: goneCookie });
  const r3 = await rq('POST', '/api/auth/login', { email: `gone${stamp}@access.test`, password: 'Staff-pass-12345' });
  record('ERP-10', 'A staff member switched off by the owner: old session refused at once for reads and writes, and cannot sign in again', r1.status === 401 && r2.status === 401 && !ok2(r3), { read: r1.status, write: r2.status, login: r3.status });
  const s = await must('POST', '/api/auth/login', { email: `zza${stamp}@access.test`, password: 'Access-pass-12345' });
  await rq('POST', '/api/auth/logout', {}, { cookie: s.cookie });
  const r4 = await rq('GET', '/api/me', undefined, { cookie: s.cookie });
  record('ERP-11b', 'A session that was logged out cannot be used again (copied cookie)', r4.status === 401, { status: r4.status });
}

/* ---------------------------------------------------------------- 6, 12: rooms, WebSockets, shared links */
{
  const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const ws = /WebSocketPair|Upgrade.*websocket/i.test(src);
  const http = await import('node:http');
  const up = await new Promise((done) => {
    const u = new URL(BASE + '/api/me');
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } });
    req.on('response', (res) => { res.resume(); done({ status: res.statusCode }); });
    req.on('upgrade', (res, sock) => { sock.destroy(); done({ status: 101 }); });
    req.on('error', (e) => done({ status: 'error ' + e.message }));
    req.end();
  });
  record('ERP-12', 'WebSockets: the ERP has no WebSocket / live room endpoint; an upgrade request is treated as a normal request and refused without a session', !ws && up.status === 401, { websocket_code_in_worker: ws, upgrade_status: up.status });
  const toks = ['00000000000000000000000000000000', 'ab'.repeat(16), String(invA.id), '1', 'x'.repeat(64)];
  const g = [];
  for (const t of toks) for (const p of ['/api/public/doc/', '/api/public/khata/', '/api/public/confirm/', '/api/public/shop/']) {
    const r = await rq('GET', p + t);
    if (ok2(r) || hasA(r)) g.push(`${p}${t} -> ${r.status}`);
  }
  const share = await rq('GET', `/api/docs/${invA.id}/share`, undefined, a);
  const tok = share.data && (share.data.token || String(share.data.url || share.data.link || '').split('/').pop());
  const open1 = tok ? (await rq('GET', '/api/public/doc/' + tok)).status : 0;
  const shareB = await rq('GET', `/api/docs/${invA.id}/share`, undefined, b);
  const revokeB = await rq('POST', `/api/docs/${invA.id}/share/revoke`, {}, b);
  await rq('POST', `/api/docs/${invA.id}/share/revoke`, {}, a);
  const open2 = tok ? (await rq('GET', '/api/public/doc/' + tok)).status : 0;
  record('ERP-06', 'Shared links (the ERP\'s "rooms": bill / khata / confirm / shop pages): guessed, sequential or doc-id tokens open nothing; '
    + 'real tokens are long random strings; another business cannot make or cancel A\'s link; a cancelled link stops working at once',
    g.length === 0 && tok && tok.length >= 20 && open1 === 200 && !ok2(shareB) && !ok2(revokeB) && open2 === 404,
    { guessed_ok: g, token_length: tok ? tok.length : 'no token ' + share.status + ' ' + share.text.slice(0, 80), open_before: open1, B_make: shareB.status, B_cancel: revokeB.status, open_after_cancel: open2 });
}

console.log(`\n${pass} passed, ${fail} failed`);
writeFileSync(new URL('./access-report.json', import.meta.url), JSON.stringify({ when: new Date().toISOString(), base: BASE, routes: routes.length, protected: priv.length,
  public: routes.filter((r) => r.public).map((r) => `${r.method} ${r.pattern}${r.webhook ? ' (webhook, signed)' : ''}`), pass, fail, results }, null, 1));
process.exit(fail ? 1 : 0);
