/* Full backup of a business, downloaded or sent to the owner's own Google Drive (like WhatsApp's chat backup).
   Drive: the owner connects once (Google sign-in, scope drive.file: the app sees only the files it made itself).
   A backup goes to a "SmartTrader Backup" folder every day or every week from the cron, and on "Back up now",
   with a readable Excel copy next to it (the owner can turn that off); the newest 30 of each are kept. Google's
   checksum of each stored file is compared with ours, so a backup that says "checked" is known to be whole.
   The Google refresh token is stored AES-GCM encrypted with a key derived from the session secret. Needs the
   GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET settings (Google Cloud OAuth client, web type, redirect URI
   https://<erp host>/api/gdrive/callback); without them Drive backup shows as "not set up". */
import { HttpError, bad, forbidden, str, today, nowIso } from './lib.js';
import { sessionSecret } from './auth.js';
import { auditStatement } from './engine.js';
import { isEmptyOrg } from './restore.js';
import { excelBackup } from './export.js';

/* ---------- the backup file ---------- */
const BACKUP_TABLES = ['accounts', 'warehouses', 'parties', 'items', 'stock', 'stock_moves', 'docs', 'payments', 'journals', 'journal_lines',
  'khata', 'counters', 'gate_entries', 'roles', 'vaade', 'vaada_kisht', 'recurring', 'billing_orders', 'audit', 'org_files', 'reminder_log', 'confirmations', 'bins', 'bin_stock', 'batches', 'batch_moves',
  'serials', 'serial_moves', 'boms', 'productions', 'channel_orders', 'staff', 'attendance', 'staff_txns', 'shop_hooks', 'item_codes', 'write_offs', 'role_rules', 'claim_entries'];

/* Every record of this business. Login secrets (password hashes, salts), private link tokens and caches rebuilt
   from the records are left out. */
export async function buildBackup(db, orgId) {
  const all = async (sql) => (await db.prepare(sql).bind(orgId).all()).results;
  const tables = {};
  for (const t of BACKUP_TABLES) tables[t] = await all(`SELECT * FROM ${t} WHERE org_id = ?`);
  tables.doc_lines = await all(`SELECT l.* FROM doc_lines l JOIN docs d ON d.id = l.doc_id WHERE d.org_id = ?`);
  tables.bom_lines = await all(`SELECT l.* FROM bom_lines l JOIN boms b ON b.id = l.bom_id WHERE b.org_id = ?`);
  tables.write_off_lines = await all(`SELECT l.* FROM write_off_lines l JOIN write_offs w ON w.id = l.write_off_id WHERE w.org_id = ?`);
  tables.payment_allocs = await all(`SELECT a.* FROM payment_allocs a JOIN payments p ON p.id = a.payment_id WHERE p.org_id = ?`);
  tables.users = await all(`SELECT id, email, name, role, role_id, active, created_at FROM users WHERE org_id = ?`);
  tables.parties.forEach((r) => { delete r.khata_token; });
  tables.docs.forEach((r) => { delete r.share_token; });
  tables.confirmations.forEach((r) => { delete r.token; });
  tables.shop_hooks.forEach((r) => { delete r.token; delete r.secret; });
  const org = (await all(`SELECT * FROM orgs WHERE id = ?`))[0] || {};
  const records = Object.values(tables).reduce((n, r) => n + r.length, 0);
  return { records, json: JSON.stringify({ format: 'smarttrader-backup', version: 1, exported_at: nowIso(), org, tables }) };
}

/* ---------- Google endpoints (overridable for tests) ---------- */
const G = (env) => ({
  auth: env.GDRIVE_OAUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  token: env.GDRIVE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  revoke: env.GDRIVE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
  api: (env.GDRIVE_API || 'https://www.googleapis.com').replace(/\/$/, ''),
});
export const driveConfigured = (env) => !!(env.GDRIVE_CLIENT_ID && env.GDRIVE_CLIENT_SECRET);
/* Drive files only. Asking for one permission keeps Google's page simple: with a second one (email) Google lists each
   with a box to tick, and owners who pressed Continue without ticking the Drive box ended up not connected.
   The account's address comes from Drive itself (about.user). */
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const KEEP = 30;
const redirectUri = (url) => url.origin + '/api/gdrive/callback';

/* ---------- small crypto helpers ---------- */
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));
async function keyFor(env, use) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('smarttrader-gdrive|' + use + '|' + await sessionSecret(env)));
  return use === 'seal'
    ? crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
    : crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(env, 'seal'), enc.encode(text));
  return b64u(iv) + '.' + b64u(ct);
}
async function unseal(env, s) {
  const [iv, ct] = String(s || '').split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, await keyFor(env, 'seal'), unb64u(ct));
  return new TextDecoder().decode(pt);
}
/* state = payload.signature, bound to the org and the user who started the connect, valid for 10 minutes */
async function signState(env, o) {
  const body = b64u(enc.encode(JSON.stringify({ ...o, x: Date.now() + 600e3, n: b64u(crypto.getRandomValues(new Uint8Array(9))) })));
  return body + '.' + b64u(await crypto.subtle.sign('HMAC', await keyFor(env, 'state'), enc.encode(body)));
}
async function readState(env, s) {
  const [body, sig] = String(s || '').split('.');
  if (!body || !sig) return null;
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await keyFor(env, 'state'), unb64u(sig), enc.encode(body)); } catch (e) { ok = false; }
  if (!ok) return null;
  const o = JSON.parse(new TextDecoder().decode(unb64u(body)));
  return o.x > Date.now() ? o : null;
}

/* ---------- Google calls ---------- */
async function gjson(res, what) {
  const t = await res.text();
  let j = {}; try { j = JSON.parse(t || '{}'); } catch (e) { j = {}; }
  if (!res.ok) {
    const msg = (j.error && (j.error.message || j.error_description || j.error)) || j.error_description || res.status;
    const e = new Error(`${what}: ${typeof msg === 'string' ? msg : res.status}`);
    e.status = res.status; e.gone = j.error === 'invalid_grant';
    // the Drive box was not ticked on Google's page (Google asks for each permission separately)
    e.scope = /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(t);
    e.apiOff = /accessNotConfigured|SERVICE_DISABLED|has not been used in project|API has not been used|is disabled/i.test(t);
    throw e;
  }
  return j;
}
async function tokenCall(env, params) {
  const res = await fetch(G(env).token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GDRIVE_CLIENT_ID, client_secret: env.GDRIVE_CLIENT_SECRET, ...params }) });
  return gjson(res, 'Google sign-in');
}
const authed = (token, extra) => ({ Authorization: 'Bearer ' + token, ...(extra || {}) });

async function ensureFolder(env, token, link, orgName) {
  if (link.folder_id) {
    const r = await fetch(`${G(env).api}/drive/v3/files/${encodeURIComponent(link.folder_id)}?fields=id,trashed`, { headers: authed(token) });
    if (r.ok) { const f = await r.json(); if (!f.trashed) return link.folder_id; }
  }
  const f = await gjson(await fetch(`${G(env).api}/drive/v3/files?fields=id`, { method: 'POST', headers: authed(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: `SmartTrader Backup - ${orgName}`.slice(0, 120), mimeType: 'application/vnd.google-apps.folder' }) }), 'Drive folder');
  return f.id;
}
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const md5hex = async (bytes) => {
  try { return [...new Uint8Array(await crypto.subtle.digest('MD5', bytes))].map((x) => x.toString(16).padStart(2, '0')).join(''); } catch (e) { return ''; }
};
/* One file into the folder. Google answers with its own MD5 of what it stored: the same as ours means the file
   arrived whole; a different one means it did not, so it is removed and the backup counts as failed. */
async function upload(env, token, folder, name, bytes, mime) {
  const boundary = 'st' + b64u(crypto.getRandomValues(new Uint8Array(12)));
  const meta = JSON.stringify({ name, parents: [folder], mimeType: mime });
  const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--`);
  const payload = new Uint8Array(head.length + bytes.length + tail.length);
  payload.set(head); payload.set(bytes, head.length); payload.set(tail, head.length + bytes.length);
  const f = await gjson(await fetch(`${G(env).api}/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,md5Checksum`, {
    method: 'POST', headers: authed(token, { 'Content-Type': `multipart/related; boundary=${boundary}` }), body: payload }), 'Drive upload');
  const ours = await md5hex(bytes);
  if (f.md5Checksum && ours && f.md5Checksum !== ours) {
    try { await fetch(`${G(env).api}/drive/v3/files/${encodeURIComponent(f.id)}`, { method: 'DELETE', headers: authed(token) }); } catch (e) { /* best effort */ }
    throw new Error(`The copy of ${name} in Google Drive did not match what was sent, so it was removed. The next backup tries again.`);
  }
  return { ...f, checked: !!(f.md5Checksum && ours) };
}
/* keep the newest KEEP backups, and the newest KEEP Excel copies, in the folder (only files this app made are visible to it) */
async function prune(env, token, folder) {
  const q = encodeURIComponent(`'${folder}' in parents and trashed = false`);
  const list = await gjson(await fetch(`${G(env).api}/drive/v3/files?q=${q}&orderBy=createdTime desc&pageSize=100&fields=files(id,name,createdTime)`, { headers: authed(token) }), 'Drive list');
  const mine = list.files || [];
  const old = [/^smarttrader-backup-/, /^smarttrader-excel-/].flatMap((re) => mine.filter((f) => re.test(f.name)).slice(KEEP));
  for (const f of old) await fetch(`${G(env).api}/drive/v3/files/${encodeURIComponent(f.id)}`, { method: 'DELETE', headers: authed(token) });
  return old.length;
}

/* ---------- one backup to Drive ---------- */
export async function backupToDrive(env, orgId, by) {
  const db = env.DB;
  const link = await db.prepare(`SELECT * FROM drive_links WHERE org_id = ?`).bind(orgId).first();
  if (!link) throw bad('Google Drive is not connected.');
  const org = await db.prepare(`SELECT * FROM orgs WHERE id = ?`).bind(orgId).first();
  // an empty business has nothing to back up (and an empty file would only crowd the list when restoring)
  if (!by && await isEmptyOrg(db, orgId)) return { ok: true, skipped: true };
  try {
    let refresh;
    try { refresh = await unseal(env, link.refresh_enc); } catch (e) { const g = new Error('sealed'); g.gone = true; throw g; }   // the session secret changed
    const tok = await tokenCall(env, { grant_type: 'refresh_token', refresh_token: refresh });
    const folder = await ensureFolder(env, tok.access_token, link, org.name);
    const b = await buildBackup(db, orgId), bytes = enc.encode(b.json);
    const stamp = nowIso().slice(0, 16).replace('T', '_').replace(':', '-');
    const f = await upload(env, tok.access_token, folder, `smarttrader-backup-${stamp}.json`, bytes, 'application/json');
    // the readable copy: a failure here does not undo the backup itself, it is only reported
    let x = null, xerr = null;
    if (link.excel !== 0) {
      try { x = await upload(env, tok.access_token, folder, `smarttrader-excel-${stamp}.xlsx`, (await excelBackup(db, org)).bytes, XLSX); }
      catch (e) { if (e.gone || e.scope || e.apiOff) throw e; xerr = 'The backup was saved, but its Excel copy was not: ' + String(e && e.message || e).slice(0, 200); }
    }
    await prune(env, tok.access_token, folder);
    const st = [db.prepare(`UPDATE drive_links SET folder_id = ?, last_backup_at = ?, last_file = ?, last_size = ?, last_file_id = ?, last_excel_id = ?, last_checked = ?,
        last_error = ? WHERE org_id = ?`)
      .bind(folder, nowIso(), f.name || '', bytes.length, f.id || null, x ? x.id : null, f.checked && (!x || x.checked) ? 1 : 0, xerr, orgId)];
    if (by) st.push(auditStatement({ db, org, user: by }, 'drive backup', `${b.records} records${x ? ' + Excel' : ''}`));
    await db.batch(st);
    return { ok: true, file: f.name, records: b.records, size: bytes.length, excel: !!x, checked: !!f.checked, ...(xerr ? { warning: xerr } : {}) };
  } catch (e) {
    const msg = e.gone ? 'Google access was removed. Connect Google Drive again.'
      : e.scope ? 'Google did not give SmartTrader permission for Drive files. Tap Disconnect, then Connect Google Drive again and press Continue on Google’s page (if it shows a Google Drive box, tick it).'
      : e.apiOff ? 'The Google Drive API is switched off in SmartTrader’s Google Cloud project, so backups cannot be saved yet. (Operator: Google Cloud → APIs & Services → Google Drive API → Enable.)'
      : String(e && e.message || 'Backup failed.').slice(0, 300);
    await db.prepare(`UPDATE drive_links SET last_error = ?, last_try_at = ? WHERE org_id = ?`).bind(msg, nowIso(), orgId).run();
    return { ok: false, error: msg };
  }
}

/* ---------- restoring from Drive ---------- */
async function driveToken(env, orgId) {
  const link = await env.DB.prepare(`SELECT refresh_enc FROM drive_links WHERE org_id = ?`).bind(orgId).first();
  if (!link) throw bad('Connect Google Drive first.');
  let refresh;
  try { refresh = await unseal(env, link.refresh_enc); } catch (e) { throw bad('Google access was removed. Connect Google Drive again.'); }
  try { return (await tokenCall(env, { grant_type: 'refresh_token', refresh_token: refresh })).access_token; }
  catch (e) { throw bad(e.gone ? 'Google access was removed. Connect Google Drive again.' : 'Could not reach Google Drive. Please try again.'); }
}
/* The SmartTrader backups this Google account has (from any business it was connected to), newest first */
export async function listDriveBackups(env, orgId) {
  const token = await driveToken(env, orgId);
  const q = encodeURIComponent(`name contains 'smarttrader-backup-' and trashed = false`);
  const r = await gjson(await fetch(`${G(env).api}/drive/v3/files?q=${q}&orderBy=createdTime desc&pageSize=50&fields=files(id,name,createdTime,size)`, { headers: authed(token) }), 'Drive list');
  return (r.files || []).filter((f) => /\.json$/i.test(f.name || '')).map((f) => ({ id: f.id, name: f.name, created: f.createdTime || '', size: +f.size || 0 }));
}
export async function readDriveBackup(env, orgId, fileId) {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(String(fileId || ''))) throw bad('Choose a backup.');
  const token = await driveToken(env, orgId);
  const res = await fetch(`${G(env).api}/drive/v3/files/${fileId}?alt=media`, { headers: authed(token) });
  if (!res.ok) throw bad('Could not download that backup from Google Drive.');
  const text = await res.text();
  if (text.length > 30e6) throw bad('This backup is too big to restore here. Please contact support.');
  try { return JSON.parse(text); } catch (e) { throw bad('That file is not a SmartTrader backup.'); }
}

/* ---------- routes ---------- */
const owner = (c) => { if (c.user.role !== 'owner') throw forbidden('Only the business owner can change Google Drive backup.'); };
const statusOf = async (c) => {
  const l = await c.db.prepare(`SELECT email, every, excel, connected_at, last_backup_at, last_file, last_size, last_error, last_try_at, folder_id, last_excel_id, last_checked
    FROM drive_links WHERE org_id = ?`).bind(c.org.id).first();
  return { configured: driveConfigured(c.env), connected: !!l, ...(l || {}) };
};

export function driveRoutes(router) {
  router.add('GET', '/api/gdrive', async (c) => new Response(JSON.stringify(await statusOf(c)), { headers: { 'Content-Type': 'application/json' } }));

  /* the Google sign-in address for this owner (the page sends the browser there) */
  router.add('POST', '/api/gdrive/connect', async (c) => {
    owner(c);
    if (!driveConfigured(c.env)) throw new HttpError(503, 'Google Drive backup is not set up on this server yet.');
    const state = await signState(c.env, { o: c.org.id, u: c.user.id });
    const q = new URLSearchParams({ client_id: c.env.GDRIVE_CLIENT_ID, redirect_uri: redirectUri(c.url), response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
    return new Response(JSON.stringify({ url: G(c.env).auth + '?' + q }), { headers: { 'Content-Type': 'application/json' } });
  });

  /* Google sends the browser back here (a top-level GET, so the session cookie comes along) */
  router.add('GET', '/api/gdrive/callback', async (c) => {
    const back = (q) => new Response(null, { status: 302, headers: { Location: '/#/settings?drive=' + q, 'Cache-Control': 'no-store' } });
    const s = await readState(c.env, c.url.searchParams.get('state'));
    if (!s || s.o !== c.org.id || s.u !== c.user.id || c.user.role !== 'owner') return back('bad');
    if (c.url.searchParams.get('error') || !c.url.searchParams.get('code')) return back(c.url.searchParams.get('error') === 'access_denied' ? 'denied' : 'cancel');
    try {
      const t = await tokenCall(c.env, { grant_type: 'authorization_code', code: c.url.searchParams.get('code'), redirect_uri: redirectUri(c.url) });
      if (!t.refresh_token) return back('norefresh');
      // Google lists the permissions the person actually ticked; without the Drive one, a backup can never be saved
      if (t.scope && !/\/auth\/drive\.file\b/.test(t.scope)) {
        try { await fetch(G(c.env).revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.refresh_token }) }); } catch (e) { /* best effort */ }
        return back('noscope');
      }
      let email = '';
      try { email = ((await gjson(await fetch(`${G(c.env).api}/drive/v3/about?fields=user(emailAddress)`, { headers: authed(t.access_token) }), 'Google account')).user || {}).emailAddress || ''; } catch (e) { email = ''; }
      await c.db.batch([
        c.db.prepare(`INSERT INTO drive_links (org_id, user_id, email, refresh_enc, every, connected_at) VALUES (?, ?, ?, ?, 'day', ?)
          ON CONFLICT(org_id) DO UPDATE SET user_id = excluded.user_id, email = excluded.email, refresh_enc = excluded.refresh_enc, connected_at = excluded.connected_at, last_error = NULL`)
          .bind(c.org.id, c.user.id, str(email, 120), await seal(c.env, t.refresh_token), nowIso()),
        auditStatement(c, 'drive connected', email),
      ]);
      if (await isEmptyOrg(c.db, c.org.id)) return back('okempty');     // nothing to back up yet; a backup can be restored instead
      const r = await backupToDrive(c.env, c.org.id, c.user);
      return back(r.ok ? 'ok' : 'fail');
    } catch (e) {
      return back('fail');
    }
  });

  router.add('POST', '/api/gdrive/backup', async (c) => {
    owner(c);
    const r = await backupToDrive(c.env, c.org.id, c.user);
    if (!r.ok) throw new HttpError(502, r.error);
    return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } });
  });

  router.add('PUT', '/api/gdrive', async (c) => {
    owner(c);
    const sets = [], vals = [];
    if (c.body.every !== undefined) {
      if (!['day', 'week'].includes(c.body.every)) throw bad('Back up every day or every week.');
      sets.push('every = ?'); vals.push(c.body.every);
    }
    if (c.body.excel !== undefined) { sets.push('excel = ?'); vals.push(c.body.excel ? 1 : 0); }
    if (!sets.length) throw bad('Nothing to change.');
    await c.db.prepare(`UPDATE drive_links SET ${sets.join(', ')} WHERE org_id = ?`).bind(...vals, c.org.id).run();
    return new Response(JSON.stringify(await statusOf(c)), { headers: { 'Content-Type': 'application/json' } });
  });

  router.add('DELETE', '/api/gdrive', async (c) => {
    owner(c);
    const l = await c.db.prepare(`SELECT refresh_enc FROM drive_links WHERE org_id = ?`).bind(c.org.id).first();
    if (l) {
      try { await fetch(G(c.env).revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: await unseal(c.env, l.refresh_enc) }) }); } catch (e) { /* already gone */ }
      await c.db.batch([c.db.prepare(`DELETE FROM drive_links WHERE org_id = ?`).bind(c.org.id), auditStatement(c, 'drive disconnected', '')]);
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  });
}

/* Cron: backups that are due (daily: not yet today; weekly: 7 days since the last one). A few per run, so one slow
   Google call never holds up the rest; the hourly cron gets through every business within the day. */
export async function runDriveBackups(env, limit = 20) {
  if (!driveConfigured(env)) return { due: 0, ok: 0 };
  const dayStart = new Date(Date.parse(today() + 'T00:00:00+05:30')).toISOString(), weekAgo = new Date(Date.now() - 6.5 * 86400e3).toISOString();   // India days
  const { results } = await env.DB.prepare(`SELECT org_id FROM drive_links
    WHERE (last_try_at IS NULL OR last_try_at < ?) AND (last_backup_at IS NULL OR (every = 'day' AND last_backup_at < ?) OR (every = 'week' AND last_backup_at < ?))
    ORDER BY last_backup_at LIMIT ?`).bind(new Date(Date.now() - 3600e3).toISOString(), dayStart, weekAgo, limit).all();
  let ok = 0;
  for (const r of results) {
    await env.DB.prepare(`UPDATE drive_links SET last_try_at = ? WHERE org_id = ?`).bind(nowIso(), r.org_id).run();
    if ((await backupToDrive(env, r.org_id, null)).ok) ok++;
  }
  return { due: results.length, ok };
}
