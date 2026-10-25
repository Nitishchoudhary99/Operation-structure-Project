/* SmartTrader Cloud ERP - Cloudflare Worker.
   /api/*  -> JSON API (this file)
   anything else -> the web app in /public (Workers static assets, single-page app) */
import { migrate, DEFAULT_ACCOUNTS } from './schema.js';
import {
  HttpError, bad, notFound, forbidden, json, readJson, str, reqStr, num, int, date, nowIso, oneOf, toPaise, Router, GST_RATES, today, counterStatements, counterValueSql,
  addDays, uid, own,
} from './lib.js';
import {
  hashPassword, randomHex, sameText, passwordProblem, issueSession, sessionCookie, clearCookie, sessionFromRequest, sessionValid, USER_SQL, REVOKED_SQL, ROLES, can, requireCan, rateLimit,
  AREAS, canView, seesCosts, permsOf, uiOf, loginGate, loginFailed, revokeSession, endAllSessions, requireCancel, rulesOf, cleanRules,
  standardPerms, BUILT_IN, limitedView,
} from './auth.js';
import {
  DOC_TYPES, NOTE_TYPES, stockCount, loadByIds, SYS_SQL, sysMap, createDoc, cancelDoc, createPayment, voidPayment, stockAdjust, stockTransfer, createExpense, createJournal, partyOpening,
  auditStatement, cashAccount, approveDoc, approvalsOf,
} from './engine.js';
import { getBom, saveBom, listProductions, createProduction, cancelProduction } from './mfg.js';
import { importOrders, stockFile } from './channels.js';
import { waConfigured, runAutoReminders, remindOrg } from './autowa.js';
import { listHooks, addHook, deleteHook, receiveHook } from './hooks.js';
import { receivePending, matchBill, learnCode, autoBins, writeOff, cancelWriteOff, writeOffOut } from './receive.js';
import { listClaims, claimDetail, saveClaim, claimReceipt, closeClaim, cancelClaimEntry } from './claims.js';
import { listStaff, saveStaff, markAttendance, staffDetail, giveAdvance, paySalary, cancelStaffTxn, payslip, todayStaffQueries } from './payroll.js';
import * as rep from './reports.js';
import { PLANS, planOut, planOf, usage, checkCount, countError, seatBlocked, seatError, requireFeature, extendPlan, adminKey, trialUntil, hasFeature } from './saas.js';
import { secure } from './headers.js';
import { createRecurring, listRecurring, stopRecurring, resumeRecurring, runDue } from './recurring.js';
import { buildBackup, driveRoutes, runDriveBackups, listDriveBackups, readDriveBackup } from './gdrive.js';
import { excelBackup } from './export.js';
import { restoreBackup, isEmptyOrg } from './restore.js';
import { LANGS, cleanLang, phrases, PREVIEW, withLang, BRAND, sendLinks, inrW, rs, fd } from './msg.js';
import { queue as vasooliQueue, logReminder, summary as vasooliSummary, summaryText, receiptMessage, makeConfirmation, listConfirmations, publicConfirmation,
  answerConfirmation, recoveryFile, stepFor, toneFor } from './vasooli.js';
import { cleanVaada, splitPlan, planOptions, minPart, risk, riskStatements, riskInput, setStatements, evalSet, writeBackStatements, promiseOut, pctOf,
  forecast, inr0, FREE_OPEN_MAX } from './vaada.js';
import { STATES, einvoiceJson, ewaybillJson } from './gst.js';
import { listBins, addBins, deleteBin, binContents, moveInBins, itemLots, expiryReport, serialLookup, putawayPlan, wavePick } from './lots.js';
import { tallyXml } from './tally.js';
import { printOf, cleanPrint, imageFromDataUrl, shortHash, imageResponse, FILE_KINDS, seriesOf, numberSpec, formatNumber, cleanSeries, fyParts,
  fieldsOf, extraOf, cleanField, cleanExtra, extraFilter, printExtra, LAYOUTS } from './custom.js';
import { billingMode, razorpayMode, grossPaise, billingStart, billingVerify, billingWebhook, billingStatus, billingHistory, hubFetch, hubOn,
  billingUpiCallback, billingUpiClaim, billingUpiCancel } from './billing.js';

const R = (p) => Math.round(p) / 100;
const router = new Router();
let migrated = false;

/* ======================================================================= auth */
/* A new business: the business, its owner, the chart of accounts, a godown and a walk-in customer, in one transaction.
   `hash` and `salt` come from hashPassword(). Returns the owner row. */
async function createBusiness(c, { business, name, email, hash, salt, gstin, state, phone, address }) {
  const now = nowIso(), otx = crypto.randomUUID(), db = c.db;
  const st = [
    db.prepare(`INSERT INTO orgs (name, gstin, state, phone, address, email, plan, plan_until, created_at) VALUES (?, ?, ?, ?, ?, ?, 'growth', ?, ?)`)
      .bind(business, str(gstin, 15).toUpperCase(), str(state, 60), str(phone, 20), str(address, 300), email, trialUntil(), otx),
    db.prepare(`INSERT INTO users (org_id, email, name, role, pw_hash, salt, pw_changed_at, created_at)
                VALUES ((SELECT id FROM orgs WHERE created_at = ?), ?, ?, 'owner', ?, ?, ?, ?)`).bind(otx, email, name, hash, salt, Date.now(), now),
    ...DEFAULT_ACCOUNTS.map(([code, nm, type, sys, isCash]) => db.prepare(`INSERT INTO accounts (org_id, code, name, type, sys, is_cash)
                VALUES ((SELECT id FROM orgs WHERE created_at = ?), ?, ?, ?, ?, ?)`).bind(otx, code, nm, type, sys, isCash)),
    db.prepare(`INSERT INTO warehouses (org_id, name) VALUES ((SELECT id FROM orgs WHERE created_at = ?), 'Main Store')`).bind(otx),
    db.prepare(`INSERT INTO parties (org_id, name, kind, state, created_at) VALUES ((SELECT id FROM orgs WHERE created_at = ?), 'Walk-in Customer', 'customer', ?, ?)`)
      .bind(otx, str(state, 60), now),
    db.prepare(`UPDATE orgs SET created_at = ? WHERE created_at = ?`).bind(now, otx),
  ];
  try { await db.batch(st); } catch (e) {
    if (/UNIQUE constraint failed: users\.email/.test(String(e && e.message))) throw bad('An account with this email already exists. Sign in instead.');
    throw e;
  }
  return db.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first();
}

/* Sign-up. When e-mail works, the account is made only after the owner opens the link we mail to the address (so nobody
   can register someone else's address, and the answer is the same whether or not the address already has an account).
   Without working e-mail the account is made at once, and an address that is taken has to be said so. */
const SIGNUP_HOURS = 24;
const verifyOn = (env) => env.SIGNUP_VERIFY !== 'off' && mailOn(env);
router.add('POST', '/api/auth/signup', async (c) => {
  const b = c.body;
  await rateLimit(c.env, 'signup:' + clientIp(c), 5, 3600);
  const business = reqStr(b.business, 'Business name', 120);
  const name = reqStr(b.name, 'Your name', 80);
  const email = reqStr(b.email, 'Email', 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw bad('Please enter a valid email address.');
  const prob = passwordProblem(b.password);
  if (prob) throw bad(prob);
  const salt = randomHex(16), hash = await hashPassword(b.password, salt);       // hashed in every case, so timing does not tell either
  const taken = !!(await c.db.prepare(`SELECT 1 FROM users WHERE email = ?`).bind(email).first());
  const fields = { business, name, email, hash, salt, gstin: b.gstin, state: b.state, phone: b.phone, address: b.address };
  if (verifyOn(c.env)) {
    await rateLimit(c.env, 'signup-mail:' + email, 3, 3600);
    const origin = new URL(c.request.url).origin;
    if (taken) {
      await sendMail(c, 'exists', { to: email, name, origin });
      return json({ ok: true, verify: true });
    }
    const token = randomHex(32), now = Date.now();
    await c.db.batch([c.db.prepare(`DELETE FROM signups WHERE email = ? OR expires_at < ?`).bind(email, now),
      c.db.prepare(`INSERT INTO signups (token_hash, email, data, expires_at) VALUES (?, ?, ?, ?)`)
        .bind(await sha256Hex(token), email, JSON.stringify({ business, name, hash, salt, gstin: str(b.gstin, 15), state: str(b.state, 60), phone: str(b.phone, 20), address: str(b.address, 300) }), now + SIGNUP_HOURS * 3600e3)]);
    if (await sendMail(c, 'verify', { to: email, name, token, origin })) return json({ ok: true, verify: true });
    await c.db.prepare(`DELETE FROM signups WHERE email = ?`).bind(email).run();       // mail is down: carry on without the check rather than lock the owner out
  }
  if (taken) throw bad('An account with this email already exists. Sign in instead.');
  const user = await createBusiness(c, fields);
  const token = await issueSession(c.env, user);
  return json({ ok: true, user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(token, c.request) });
}, { public: true });

/* The link in the sign-up e-mail: now the business is made and the owner is signed in. */
router.add('POST', '/api/auth/verify', async (c) => {
  await rateLimit(c.env, 'verify:' + clientIp(c), 20, 3600);
  const token = str(c.body.token, 80);
  if (!/^[0-9a-f]{64}$/.test(token)) throw bad('This link is not valid. Please sign up again.');
  const row = await c.db.prepare(`SELECT * FROM signups WHERE token_hash = ?`).bind(await sha256Hex(token)).first();
  if (!row || row.expires_at < Date.now()) throw bad('This link has expired or was already used. Please sign up again.');
  if (await c.db.prepare(`SELECT 1 FROM users WHERE email = ?`).bind(row.email).first()) {
    await c.db.prepare(`DELETE FROM signups WHERE email = ?`).bind(row.email).run();
    throw bad('This email already has an account. Please sign in.');
  }
  const d = JSON.parse(row.data);
  const claim = await c.db.prepare(`DELETE FROM signups WHERE token_hash = ?`).bind(row.token_hash).run();        // one use only, even for two clicks at once
  if (!claim.meta.changes) throw bad('This link has expired or was already used. Please sign up again.');
  const user = await createBusiness(c, { ...d, email: row.email });
  const session = await issueSession(c.env, user);
  return json({ ok: true, user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(session, c.request) });
}, { public: true });

const clientIp = (c) => c.request.headers.get('CF-Connecting-IP') || 'local';
router.add('POST', '/api/auth/login', async (c) => {
  const email = str(c.body.email, 120).toLowerCase(), ip = clientIp(c);
  const release = await loginGate(c.env, email, ip);
  try {
    const user = await c.db.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first();
    const hash = await hashPassword(c.body.password || '', user ? user.salt : 'no-such-user-salt');
    if (!user || !user.active || !sameText(hash, user.pw_hash)) {
      await loginFailed(c.env, email, ip);
      throw new HttpError(401, 'Incorrect email or password.');
    }
    const [row, org] = await c.db.batch([c.db.prepare(USER_SQL).bind(user.id), c.db.prepare(`SELECT * FROM orgs WHERE id = ?`).bind(user.org_id)]);
    if (seatBlocked(org.results[0], row.results[0])) throw seatError(org.results[0]);
    const token = await issueSession(c.env, user);
    return json({ ok: true, user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(token, c.request) });
  } finally { release(); }
}, { public: true });

/* Forgot password: a one-time link by e-mail (Resend, same account as docbrisk.com), valid 30 minutes.
   The answer is the same whether or not the account exists. Without RESEND_API_KEY the app tells the user to ask the owner. */
const sha256Hex = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const mailOn = (env) => !!env.RESEND_API_KEY || hubOn(env);   // own Resend key, or docbrisk.com's mail account via the hub link
/* The sign-up e-mails ('verify': the confirm link, 'exists': "you already have an account"). True when the mail was handed over. */
async function sendMail(c, kind, { to, name, token, origin }) {
  try {
    if (!c.env.RESEND_API_KEY) {      // docbrisk.com's mail account, through the hub link
      const r = await hubFetch(c.env, 'POST', '/api/pay/svc/erp-verify-mail', { kind, to, name, token, origin });
      return r.status === 200 && !!(r.data && r.data.ok);
    }
    const link = `${origin}/#/verify/${token}`;
    const inner = kind === 'verify'
      ? `<p>Namaste ${attr(name)},</p><p>Please confirm this e-mail address to start your SmartTrader account.</p>
         <p><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Confirm and start</a></p>
         <p style="color:#6b7280;font-size:13px">This link works once, for ${SIGNUP_HOURS} hours. If you did not ask for it, ignore this e-mail and nothing will be created.</p>`
      : `<p>Namaste ${attr(name)},</p><p>Someone asked to create a SmartTrader account with this e-mail address, but you already have one.
         Open ${attr(origin)} and sign in, or use "Forgot password" there if you do not remember the password.</p>
         <p style="color:#6b7280;font-size:13px">If it was not you, you can ignore this e-mail. Nothing has changed.</p>`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1f2937"><h2 style="color:#0f766e">SmartTrader ERP</h2>${inner}</div>`;
    const res = await fetch(c.env.RESEND_URL || 'https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: c.env.MAIL_FROM || 'SmartTrader ERP <no-reply@docbrisk.com>', to: [to],
        subject: kind === 'verify' ? 'Confirm your SmartTrader account' : 'You already have a SmartTrader account', html }),
    });
    return res.ok;
  } catch (e) { return false; }
}
router.add('POST', '/api/auth/forgot', async (c) => {
  const email = str(c.body.email, 120).toLowerCase();
  const ip = clientIp(c);
  await rateLimit(c.env, 'forgot-ip:' + ip, 10, 3600);
  if (!mailOn(c.env)) return json({ ok: true, mail: false });
  await rateLimit(c.env, 'forgot:' + email, 3, 3600);
  const user = email && await c.db.prepare(`SELECT u.id, u.name, u.email, o.name AS org FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.email = ? AND u.active = 1`).bind(email).first();
  if (user) {
    const token = randomHex(32), now = Date.now();
    await c.db.batch([
      c.db.prepare(`DELETE FROM pw_resets WHERE user_id = ? OR expires_at < ?`).bind(user.id, now),
      c.db.prepare(`INSERT INTO pw_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)`).bind(await sha256Hex(token), user.id, now + 30 * 60000),
    ]);
    const origin = new URL(c.request.url).origin, link = `${origin}/#/reset/${token}`;
    if (!c.env.RESEND_API_KEY) {   // send through docbrisk.com (docbrisk-api builds and sends the same e-mail)
      await hubFetch(c.env, 'POST', '/api/pay/svc/erp-reset-mail', { to: user.email, name: user.name, org: user.org, token, origin });
      return json({ ok: true, mail: true });
    }
    const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1f2937">
      <h2 style="color:#0f766e">SmartTrader ERP</h2><p>Namaste ${attr(user.name)},</p>
      <p>We got a request to reset the password for <b>${attr(user.email)}</b> (${attr(user.org)}).</p>
      <p><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Set a new password</a></p>
      <p style="color:#6b7280;font-size:13px">This link works once, for 30 minutes. If you did not ask for it, ignore this e-mail; your password stays the same.</p></div>`;
    await fetch(c.env.RESEND_URL || 'https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: c.env.MAIL_FROM || 'SmartTrader ERP <no-reply@docbrisk.com>', to: [user.email], subject: 'Reset your SmartTrader password', html }),
    }).catch(() => {});
  }
  return json({ ok: true, mail: true });
}, { public: true });

router.add('POST', '/api/auth/reset', async (c) => {
  const ip = clientIp(c);
  await rateLimit(c.env, 'reset:' + ip, 20, 3600);
  const token = str(c.body.token, 80);
  if (!/^[0-9a-f]{64}$/.test(token)) throw bad('This reset link is not valid. Please ask for a new one.');
  const r = await c.db.prepare(`SELECT r.user_id, r.expires_at, r.used_at, u.* FROM pw_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?`).bind(await sha256Hex(token)).first();
  if (!r || r.used_at || r.expires_at < Date.now() || !r.active) throw bad('This reset link has expired or was already used. Please ask for a new one.');
  const prob = passwordProblem(c.body.password);
  if (prob) throw bad(prob);
  const salt = randomHex(16), now = Date.now();
  await c.db.batch([
    c.db.prepare(`UPDATE users SET pw_hash = ?, salt = ?, pw_changed_at = ? WHERE id = ?`).bind(await hashPassword(c.body.password, salt), salt, now, r.user_id),
    c.db.prepare(`DELETE FROM pw_resets WHERE user_id = ?`).bind(r.user_id),
  ]);
  const token2 = await issueSession(c.env, { ...r, id: r.user_id, pw_changed_at: now });
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token2, c.request) });
}, { public: true });

router.add('POST', '/api/auth/logout', async (c) => {
  const p = await sessionFromRequest(c.env, c.request);
  if (p) await revokeSession(c.env, p);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(c.request) });
}, { public: true });
/* Sign out everywhere: every token of this user (all devices) stops working, including the one that asked. */
router.add('POST', '/api/me/logout-all', async (c) => {
  await endAllSessions(c.env, c.user.id);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(c.request) });
});

router.add('GET', '/api/me', async (c) => json({
  user: { ...publicUser(c.user), role_key: c.user.role }, org: orgOut(c.org),
  can: Object.fromEntries(['settings', 'users', 'items', 'purchase', 'sales', 'stock', 'finance', 'khata', 'masters', 'gate'].map((a) => [a, can(c.user, a)])),
  ui: uiOf(c.user.ui), role_ui: uiOf(c.user.role_ui), rules: rulesOf(c.user),
  view: Object.fromEntries(AREAS.map((a) => [a, canView(c.user, a)])), costs: seesCosts(c.user), wa_auto: waConfigured(c.env),
  doc_types: Object.fromEntries(Object.entries(DOC_TYPES).map(([k, v]) => [k, { label: v.label, side: v.side, from: v.from, prefix: v.prefix, note: !!v.note, stock: v.stock || '' }])),
  gst_rates: GST_RATES, today: today(), states: STATES.map(([, n]) => n), plan: planOut(c.org),
}));

router.add('POST', '/api/me/password', async (c) => {
  await rateLimit(c.env, 'pwchange:' + c.user.id, 10, 3600);
  const u = await c.db.prepare(`SELECT * FROM users WHERE id = ?`).bind(c.user.id).first();
  if (!sameText(await hashPassword(c.body.current || '', u.salt), u.pw_hash)) throw bad('Your current password is not correct.');
  const prob = passwordProblem(c.body.password);
  if (prob) throw bad(prob);
  const salt = randomHex(16), now = Date.now();
  await c.db.prepare(`UPDATE users SET pw_hash = ?, salt = ?, pw_changed_at = ? WHERE id = ?`).bind(await hashPassword(c.body.password, salt), salt, now, u.id).run();
  const token = await issueSession(c.env, { ...u, pw_changed_at: now });
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, c.request) });
});

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role === 'custom' ? u.role_name || 'custom' : u.role });

/* ======================================================================= business settings & users */
router.add('PUT', '/api/org', async (c) => {
  requireCan(c.user, 'settings');
  const b = c.body;
  await c.db.prepare(`UPDATE orgs SET name = ?, gstin = ?, state = ?, address = ?, phone = ?, upi_id = ?, fy_start = ?, city = ?, pincode = ?, email = ?,
      msg_lang = ?, udyam = ? WHERE id = ?`)
    .bind(reqStr(b.name, 'Business name', 120), str(b.gstin, 15).toUpperCase(), str(b.state, 60), str(b.address, 300), str(b.phone, 20),
      str(b.upi_id, 60), /^\d{2}-\d{2}$/.test(b.fy_start || '') ? b.fy_start : c.org.fy_start, str(b.city, 60), str(b.pincode, 6).replace(/\D/g, ''),
      str(b.email, 120), cleanLang(b.msg_lang, cleanLang(c.org.msg_lang)), b.udyam === undefined ? c.org.udyam || '' : str(b.udyam, 19).toUpperCase(), c.org.id).run();
  return json({ ok: true });
});

router.add('PUT', '/api/org/mode', async (c) => {
  requireCan(c.user, 'settings');
  const mode = oneOf(c.body.mode, ['simple', 'advanced'], 'Mode');
  await c.db.batch([c.db.prepare(`UPDATE orgs SET mode = ? WHERE id = ?`).bind(mode, c.org.id), auditStatement(c, 'mode', mode)]);
  return json({ ok: true, mode });
});
/* business row for the app: settings JSON parsed, image URLs ready for <img> */
const orgOut = (o) => ({ ...o, print: printOf(o), series: seriesOf(o), fields: fieldsOf(o), vaada: cleanVaada(o.vaada), approvals: approvalsOf(o) });
/* approval rules: purchase orders above po_above rupees made by anyone but the owner or an admin wait for approval */
router.add('PUT', '/api/settings/approvals', async (c) => {
  requireCan(c.user, 'settings');
  const a = { po_above: Math.round(num(c.body.po_above, 'Approval limit', { min: 0, max: 1e10, def: 0 })) };
  await c.db.batch([c.db.prepare(`UPDATE orgs SET approvals = ? WHERE id = ?`).bind(JSON.stringify(a), c.org.id),
    auditStatement(c, 'approval rules', a.po_above ? `PO above ${a.po_above}` : 'off')]);
  return json({ ok: true, approvals: a });
});
const fileUrls = (P, base) => ({ logo_url: P.logo ? `${base}/logo?v=${P.logo}` : '', sign_url: P.signature ? `${base}/signature?v=${P.signature}` : '' });

/* Branding & print: layout, colour, title, terms, bank, UPI on bill, signatory, footer */
router.add('GET', '/api/settings/print', async (c) => { const P = printOf(c.org); return json({ print: P, ...fileUrls(P, '/api/org/files') }); });
router.add('PUT', '/api/settings/print', async (c) => {
  requireCan(c.user, 'settings');
  const P = cleanPrint(c.body, printOf(c.org));
  await c.db.batch([c.db.prepare(`UPDATE orgs SET print = ? WHERE id = ?`).bind(JSON.stringify(P), c.org.id), auditStatement(c, 'print settings', P.layout)]);
  return json({ print: P, ...fileUrls(P, '/api/org/files') });
});
/* logo / signature: the browser shrinks the image first; at most 64 KB */
router.add('PUT', '/api/org/files/:kind', async (c) => {
  requireCan(c.user, 'settings');
  const kind = oneOf(c.params.kind, FILE_KINDS, 'File');
  const img = imageFromDataUrl(c.body.data);
  const hash = await shortHash(img.b64);
  const P = { ...printOf(c.org), [kind]: hash };
  await c.db.batch([
    c.db.prepare(`INSERT INTO org_files (org_id, kind, mime, data, hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (org_id, kind) DO UPDATE SET mime = excluded.mime, data = excluded.data, hash = excluded.hash, updated_at = excluded.updated_at`)
      .bind(c.org.id, kind, img.mime, img.b64, hash, nowIso()),
    c.db.prepare(`UPDATE orgs SET print = ? WHERE id = ?`).bind(JSON.stringify(P), c.org.id),
    auditStatement(c, 'upload ' + kind, `${Math.round(img.size / 1024)} KB`)]);
  return json({ print: P, ...fileUrls(P, '/api/org/files') });
});
router.add('DELETE', '/api/org/files/:kind', async (c) => {
  requireCan(c.user, 'settings');
  const kind = oneOf(c.params.kind, FILE_KINDS, 'File');
  const P = { ...printOf(c.org), [kind]: '' };
  await c.db.batch([c.db.prepare(`DELETE FROM org_files WHERE org_id = ? AND kind = ?`).bind(c.org.id, kind),
    c.db.prepare(`UPDATE orgs SET print = ? WHERE id = ?`).bind(JSON.stringify(P), c.org.id), auditStatement(c, 'remove ' + kind)]);
  return json({ print: P, ...fileUrls(P, '/api/org/files') });
});
router.add('GET', '/api/org/files/:kind', async (c) => {
  const row = await c.db.prepare(`SELECT mime, data FROM org_files WHERE org_id = ? AND kind = ?`).bind(c.org.id, oneOf(c.params.kind, FILE_KINDS, 'File')).first();
  if (!row) throw notFound('No image.');
  return imageResponse(row);
});

/* Numbering: prefix, digits, next number and yearly reset for each document type, receipts and payments */
const SERIES = () => [...Object.entries(DOC_TYPES).map(([k, v]) => [k, v.label, v.prefix]), ['receipt', 'Receipt', 'RCT'], ['payment', 'Payment', 'PAY']];
async function seriesRows(c, only) {
  const { results } = await c.db.prepare(`SELECT key, next FROM counters WHERE org_id = ?`).bind(c.org.id).all();
  const next = Object.fromEntries(results.map((r) => [r.key, r.next])), S = seriesOf(c.org), d = today();
  return SERIES().filter(([k]) => !only || k === only).map(([k, label, prefix]) => {
    const spec = numberSpec(c.org, k, prefix, d), n = next[spec.key] || 1, s = S[k];
    return { type: k, label, custom: !!s, prefix: s ? s.prefix : prefix + '-', pad: s ? s.pad : 5, fy_reset: s ? s.fy_reset : 0, next: n, preview: formatNumber(spec, n) };
  });
}
router.add('GET', '/api/settings/series', async (c) => json({ rows: await seriesRows(c), fy: fyParts(c.org, today()).fy }));
router.add('PUT', '/api/settings/series/:type', async (c) => {
  requireCan(c.user, 'settings');
  const def = SERIES().find(([k]) => k === c.params.type);
  if (!def) throw bad('Unknown document type.');
  const d = today(), S = seriesOf(c.org);
  const v = cleanSeries(c.body, c.org, d);
  const org = { ...c.org, series: JSON.stringify({ ...S, [def[0]]: { prefix: v.prefix, pad: v.pad, fy_reset: v.fy_reset } }) };
  const spec = numberSpec(org, def[0], def[2], d);
  const st = [c.db.prepare(`UPDATE orgs SET series = ? WHERE id = ?`).bind(org.series, c.org.id), auditStatement(c, 'numbering', `${def[0]} ${v.prefix} ${v.pad}${v.fy_reset ? ' yearly' : ''}${v.next ? ' next ' + v.next : ''}`)];
  if (v.next) {
    const cur = await c.db.prepare(`SELECT next FROM counters WHERE org_id = ? AND key = ?`).bind(c.org.id, spec.key).first();
    if (cur && v.next < cur.next) throw bad(`Next number cannot go back. It must be ${cur.next} or more.`);
    st.push(c.db.prepare(`INSERT INTO counters (org_id, key, next) VALUES (?, ?, ?) ON CONFLICT (org_id, key) DO UPDATE SET next = MAX(next, excluded.next)`).bind(c.org.id, spec.key, v.next));
  }
  await c.db.batch(st);
  c.org = org;
  return json((await seriesRows(c, def[0]))[0]);
});
router.add('DELETE', '/api/settings/series/:type', async (c) => {
  requireCan(c.user, 'settings');
  const def = SERIES().find(([k]) => k === c.params.type);
  if (!def) throw bad('Unknown document type.');
  const S = seriesOf(c.org);
  delete S[def[0]];
  c.org = { ...c.org, series: JSON.stringify(S) };
  await c.db.batch([c.db.prepare(`UPDATE orgs SET series = ? WHERE id = ?`).bind(c.org.series, c.org.id), auditStatement(c, 'numbering', `${c.params.type} default`)]);
  return json({ ok: true });
});

/* Custom fields for items, parties and documents */
router.add('GET', '/api/settings/fields', async (c) => json({ rows: fieldsOf(c.org) }));
async function saveFields(c, defs, what) {
  await c.db.batch([c.db.prepare(`UPDATE orgs SET fields = ? WHERE id = ?`).bind(JSON.stringify(defs), c.org.id), auditStatement(c, 'custom field', what)]);
  return json({ rows: defs });
}
router.add('POST', '/api/settings/fields', async (c) => {
  requireCan(c.user, 'settings');
  const defs = fieldsOf(c.org), f = cleanField(c.body, defs);
  return saveFields(c, [...defs, f], `add ${f.entity} ${f.label}`);
});
router.add('PUT', '/api/settings/fields/:id', async (c) => {
  requireCan(c.user, 'settings');
  const defs = fieldsOf(c.org), cur = defs.find((f) => f.id === +c.params.id);
  if (!cur) throw notFound('Field not found.');
  const f = cleanField(c.body, defs, cur);
  return saveFields(c, defs.map((x) => (x.id === cur.id ? f : x)), `edit ${f.entity} ${f.label}`);
});
router.add('DELETE', '/api/settings/fields/:id', async (c) => {
  requireCan(c.user, 'settings');
  const defs = fieldsOf(c.org), cur = defs.find((f) => f.id === +c.params.id);
  if (!cur) throw notFound('Field not found.');
  return saveFields(c, defs.filter((x) => x.id !== cur.id), `remove ${cur.entity} ${cur.label}`);
});

router.add('GET', '/api/users', async (c) => {
  requireCan(c.user, 'users');
  const [u, r] = await c.db.batch([c.db.prepare(`SELECT u.id, u.email, u.name, u.role, u.role_id, r.name AS role_name, u.active, u.created_at, u.ui FROM users u
      LEFT JOIN roles r ON r.id = u.role_id WHERE u.org_id = ? ORDER BY u.id`).bind(c.org.id), c.db.prepare(`SELECT id, name FROM roles WHERE org_id = ? ORDER BY name`).bind(c.org.id)]);
  const max = planOf(c.org).users;
  let seat = 0;       // staff past the plan's user limit are paused (see seatBlocked)
  return json({ rows: u.results.map((x) => ({ ...x, ui: uiOf(x.ui), paused: x.active && x.role !== 'owner' && Number.isFinite(max) && seat++ >= max - 1, role_key: x.role === 'custom' ? 'c:' + x.role_id : x.role, role: x.role === 'custom' ? x.role_name : x.role })),
    roles: ROLES, custom_roles: r.results });
});
/* Custom roles: a name and per-area view / edit switches */
const cleanPerms = (b) => {
  const pick = (v) => [...new Set((Array.isArray(v) ? v : []).filter((a) => AREAS.includes(a)))];
  const edit = pick(b && b.edit);
  return { view: [...new Set([...pick(b && b.view), ...edit])], edit };
};
/* Every role is made to measure (role_rules): limits (src/auth.js cleanRules) and the role's menu for all its users;
   a built-in role's rights too, once the owner changes them (perms NULL = the standard rights). */
const ROLE_NAMES = { admin: 'Admin', accountant: 'Accountant', store: 'Store / godown', sales: 'Sales' };
const ruleText = (r) => Object.entries(r).filter(([, v]) => v !== null && v !== false).map(([k, v]) => (v === true ? k : `${k} ${v}`)).join(', ');
const saveRuleStatement = (c, key, { perms = null, rules, ui }) => {
  const u = uiOf(ui), noUi = !u.job && !u.screens && !u.home;
  return c.db.prepare(`INSERT INTO role_rules (org_id, role_key, perms, rules, ui, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, role_key) DO UPDATE SET perms = excluded.perms, rules = excluded.rules, ui = excluded.ui, updated_at = excluded.updated_at`)
    .bind(c.org.id, key, perms ? JSON.stringify(perms) : null, JSON.stringify(cleanRules(rules || {})), noUi ? null : JSON.stringify(u), nowIso());
};
router.add('GET', '/api/roles', async (c) => {
  requireCan(c.user, 'users');
  const [rs, rr, n] = await c.db.batch([
    c.db.prepare(`SELECT r.id, r.name, r.perms, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.org_id = r.org_id) AS users
      FROM roles r WHERE r.org_id = ? ORDER BY r.name`).bind(c.org.id),
    c.db.prepare(`SELECT role_key, perms, rules, ui FROM role_rules WHERE org_id = ?`).bind(c.org.id),
    c.db.prepare(`SELECT role, COUNT(*) AS n FROM users WHERE org_id = ? AND role != 'custom' GROUP BY role`).bind(c.org.id),
  ]);
  const extra = (key) => { const x = rr.results.find((r) => r.role_key === key) || {}; return { rules: rulesOf({ role: '', role_rules: x.rules }), ui: uiOf(x.ui), own: x.perms || null }; };
  return json({
    rows: rs.results.map((r) => { const x = extra('c:' + r.id); return { ...r, perms: permsOf(r), rules: x.rules, ui: x.ui }; }),
    builtin: BUILT_IN.map((key) => {
      const x = extra(key), standard = standardPerms(key);
      return { key, name: ROLE_NAMES[key], perms: x.own ? permsOf({ perms: x.own }) : standard, standard, changed: !!x.own, rules: x.rules, ui: x.ui,
        users: (n.results.find((r) => r.role === key) || { n: 0 }).n, locked: key === 'admin' && c.user.role !== 'owner' };
    }),
    areas: AREAS,
  });
});
router.add('POST', '/api/roles', async (c) => {
  requireCan(c.user, 'users');
  const name = reqStr(c.body.name, 'Role name', 40), perms = cleanPerms(c.body.perms);
  if (await c.db.prepare(`SELECT 1 FROM roles WHERE org_id = ? AND name = ?`).bind(c.org.id, name).first()) throw bad(`A role called ${name} already exists.`);
  if ((await c.db.prepare(`SELECT COUNT(*) AS n FROM roles WHERE org_id = ?`).bind(c.org.id).first()).n >= 20) throw bad('At most 20 roles.');
  const [r] = await c.db.batch([c.db.prepare(`INSERT INTO roles (org_id, name, perms, created_at) VALUES (?, ?, ?, ?) RETURNING id`).bind(c.org.id, name, JSON.stringify(perms), nowIso()),
    auditStatement(c, 'add role', `${name}: edit ${perms.edit.join(',')}; view ${perms.view.join(',')}; ${ruleText(cleanRules(c.body.rules || {}))}`.slice(0, 300))]);
  const id = r.results[0].id;
  await c.db.batch([saveRuleStatement(c, 'c:' + id, { rules: c.body.rules, ui: c.body.ui })]);
  return json({ id, name, perms, rules: cleanRules(c.body.rules || {}), ui: uiOf(c.body.ui) });
});
router.add('PUT', '/api/roles/:id', async (c) => {
  requireCan(c.user, 'users');
  const name = reqStr(c.body.name, 'Role name', 40), perms = cleanPerms(c.body.perms);
  if (await c.db.prepare(`SELECT 1 FROM roles WHERE org_id = ? AND name = ? AND id != ?`).bind(c.org.id, name, +c.params.id).first()) throw bad(`A role called ${name} already exists.`);
  const [r] = await c.db.batch([c.db.prepare(`UPDATE roles SET name = ?, perms = ? WHERE id = ? AND org_id = ?`).bind(name, JSON.stringify(perms), +c.params.id, c.org.id),
    auditStatement(c, 'edit role', `${name}: edit ${perms.edit.join(',')}; view ${perms.view.join(',')}; ${ruleText(cleanRules(c.body.rules || {}))}`.slice(0, 300))]);
  if (!r.meta.changes) throw notFound('Role not found.');
  await c.db.batch([saveRuleStatement(c, 'c:' + +c.params.id, { rules: c.body.rules, ui: c.body.ui })]);
  return json({ id: +c.params.id, name, perms, rules: cleanRules(c.body.rules || {}), ui: uiOf(c.body.ui) });
});
router.add('DELETE', '/api/roles/:id', async (c) => {
  requireCan(c.user, 'users');
  if (await c.db.prepare(`SELECT 1 FROM users WHERE org_id = ? AND role_id = ?`).bind(c.org.id, +c.params.id).first()) throw bad('Some users have this role. Give them another role first.');
  const [r] = await c.db.batch([c.db.prepare(`DELETE FROM roles WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id),
    c.db.prepare(`DELETE FROM role_rules WHERE org_id = ? AND role_key = ?`).bind(c.org.id, 'c:' + +c.params.id)]);
  if (!r.meta.changes) throw notFound('Role not found.');
  return json({ ok: true });
});
/* a built-in role made to measure: perms (null = its standard rights), rules, ui; only the owner changes the admin role */
const builtinKey = (c) => {
  requireCan(c.user, 'users');
  const key = oneOf(c.params.key, BUILT_IN, 'Role');
  if (key === 'admin' && c.user.role !== 'owner') throw forbidden('Only the owner changes the admin role.');
  return key;
};
router.add('PUT', '/api/roles/builtin/:key', async (c) => {
  const key = builtinKey(c), perms = c.body.perms ? cleanPerms(c.body.perms) : null;
  await c.db.batch([saveRuleStatement(c, key, { perms, rules: c.body.rules, ui: c.body.ui }),
    auditStatement(c, 'edit role', `${key}: ${perms ? `edit ${perms.edit.join(',')}; view ${perms.view.join(',')}` : 'standard rights'}; ${ruleText(cleanRules(c.body.rules || {}))}`.slice(0, 300))]);
  return json({ ok: true, key, perms: perms || standardPerms(key), changed: !!perms, rules: cleanRules(c.body.rules || {}), ui: uiOf(c.body.ui) });
});
router.add('DELETE', '/api/roles/builtin/:key', async (c) => {
  const key = builtinKey(c);
  await c.db.batch([c.db.prepare(`DELETE FROM role_rules WHERE org_id = ? AND role_key = ?`).bind(c.org.id, key), auditStatement(c, 'edit role', `${key}: back to standard`)]);
  return json({ ok: true });
});

/* 'admin' | 'accountant' | 'store' | 'sales', or 'c:<id>' for a custom role of this business */
async function roleOf(c, v) {
  const m = String(v || '').match(/^c:(\d+)$/);
  if (!m) return { role: oneOf(v, ROLES.filter((r) => r !== 'owner'), 'Role'), role_id: null };
  const r = await c.db.prepare(`SELECT id FROM roles WHERE id = ? AND org_id = ?`).bind(+m[1], c.org.id).first();
  if (!r) throw bad('Unknown role.');
  return { role: 'custom', role_id: r.id };
}
router.add('POST', '/api/users', async (c) => {
  requireCan(c.user, 'users');
  const email = reqStr(c.body.email, 'Email', 120).toLowerCase();
  const { role, role_id } = await roleOf(c, c.body.role);
  const prob = passwordProblem(c.body.password);
  if (prob) throw bad(prob);
  await rateLimit(c.env, 'adduser:' + c.org.id, 30, 3600);
  if (await c.db.prepare(`SELECT 1 FROM users WHERE email = ?`).bind(email).first()) throw bad('This email cannot be used. Please use a different email address.');
  await checkCount(c.db, c.org, 'users');
  const salt = randomHex(16), max = planOf(c.org).users;
  // the insert checks the plan's user limit itself, so two requests at once cannot both take the last seat
  const [ins] = await c.db.batch([c.db.prepare(`INSERT INTO users (org_id, email, name, role, role_id, pw_hash, salt, pw_changed_at, created_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE (SELECT COUNT(*) FROM users WHERE org_id = ?1 AND active = 1) < ?10`)
    .bind(c.org.id, email, reqStr(c.body.name, 'Name', 80), role, role_id, await hashPassword(c.body.password, salt), salt, Date.now(), nowIso(), Number.isFinite(max) ? max : 1e9),
  c.db.prepare(`INSERT INTO audit (org_id, user_id, at, action, detail) SELECT ?, ?, ?, 'add user', ? WHERE changes() > 0`)
    .bind(c.org.id, c.user.id, nowIso(), `${email} ${role}${role_id ? ' ' + role_id : ''}`.slice(0, 300))]);
  if (!ins.meta.changes) throw countError(c.org, 'users');
  return json({ ok: true });
});
router.add('PUT', '/api/users/:id', async (c) => {
  requireCan(c.user, 'users');
  const u = await c.db.prepare(`SELECT * FROM users WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!u) throw notFound('User not found.');
  if (u.role === 'owner') throw bad('The owner cannot be changed here.');
  const { role, role_id } = c.body.role ? await roleOf(c, c.body.role) : { role: u.role, role_id: u.role_id };
  if (c.body.password !== undefined) {   // owner/admin sets a new password for a staff member who forgot theirs
    const prob = passwordProblem(c.body.password);
    if (prob) throw bad(prob);
    const salt = randomHex(16);
    await c.db.batch([c.db.prepare(`UPDATE users SET pw_hash = ?, salt = ?, pw_changed_at = MAX(pw_changed_at + 1, ?) WHERE id = ?`).bind(await hashPassword(c.body.password, salt), salt, Date.now(), u.id),
      auditStatement(c, 'reset password', u.email)]);
    return json({ ok: true });
  }
  const active = c.body.active === undefined ? u.active : (c.body.active ? 1 : 0);
  const max = planOf(c.org).users;
  if (active && !u.active) await checkCount(c.db, c.org, 'users');
  // switching a user off (or back on) moves their password version, so every token they hold stops working at once;
  // switching on also re-checks the plan's user limit inside the statement
  const [upd] = await c.db.batch([c.db.prepare(`UPDATE users SET role = ?1, role_id = ?2, active = ?3, pw_changed_at = CASE WHEN ?3 != active THEN MAX(pw_changed_at + 1, ?4) ELSE pw_changed_at END
      WHERE id = ?5 AND org_id = ?6 AND (?3 = 0 OR active = 1 OR (SELECT COUNT(*) FROM users WHERE org_id = ?6 AND active = 1) < ?7)`)
    .bind(role, role_id, active, Date.now(), u.id, c.org.id, Number.isFinite(max) ? max : 1e9),
  c.db.prepare(`INSERT INTO audit (org_id, user_id, at, action, detail) SELECT ?, ?, ?, 'edit user', ? WHERE changes() > 0`)
    .bind(c.org.id, c.user.id, nowIso(), `${u.email} ${role}${role_id ? ' ' + role_id : ''} ${active ? 'on' : 'off'}`.slice(0, 300))]);
  if (!upd.meta.changes) throw countError(c.org, 'users');
  return json({ ok: true });
});

/* A user's own menu: job, screens, start screen (src/auth.js uiOf). The owner's menu is the owner's to change. */
router.add('PUT', '/api/users/:id/ui', async (c) => {
  requireCan(c.user, 'users');
  const u = await c.db.prepare(`SELECT id, email, role FROM users WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!u) throw notFound('User not found.');
  if (u.role === 'owner' && u.id !== c.user.id) throw bad("Only the owner changes the owner's menu.");
  const ui = uiOf(c.body);
  const empty = !ui.job && !ui.screens && !ui.home;
  await c.db.batch([c.db.prepare(`UPDATE users SET ui = ? WHERE id = ?`).bind(empty ? null : JSON.stringify(ui), u.id),
    auditStatement(c, 'user menu', `${u.email}: ${ui.job || (ui.screens ? ui.screens.length + ' screens' : 'by role')}${ui.home ? ' → ' + ui.home : ''}`.slice(0, 300))]);
  return json({ ok: true, ui });
});

/* ======================================================================= parties */
const partyFields = (b, c) => ({
  extra: b.extra === undefined ? null : cleanExtra(fieldsOf(c.org), 'party', b.extra),
  name: reqStr(b.name, 'Name', 120), kind: oneOf(b.kind || 'customer', ['customer', 'supplier', 'both'], 'Type'),
  phone: str(b.phone, 20), email: str(b.email, 120), gstin: str(b.gstin, 15).toUpperCase(), state: str(b.state, 60), address: str(b.address, 300),
  credit_limit: toPaise(num(b.credit_limit, 'Credit limit', { min: 0, def: 0 })), credit_days: int(b.credit_days, 'Credit days', { min: 0, max: 365, def: 0 }),
  city: str(b.city, 60), pincode: str(b.pincode, 6).replace(/\D/g, ''),
  lang: b.lang === undefined ? null : LANGS.includes(b.lang) ? b.lang : '', vip: b.vip === undefined ? null : b.vip === true || b.vip === 1 || b.vip === '1' || b.vip === 'on' ? 1 : 0,
});
router.add('GET', '/api/parties', async (c) => {
  const q = c.url.searchParams;
  const kind = q.get('kind'), cf = extraFilter(fieldsOf(c.org), 'party', q, 'extra');
  // a custom role sees the kinds of party its areas deal with, and balances only when it handles money (masters, finance, khata, reports)
  const u = c.user, money = ['masters', 'finance', 'khata', 'reports'].some((a) => canView(u, a));
  const custs = money || canView(u, 'sales'), supps = money || canView(u, 'purchase');
  if (!custs && !supps) throw forbidden('Your role cannot see this. Ask the owner.');
  const { results } = await c.db.prepare(`SELECT * FROM parties WHERE org_id = ? ${kind === 'customer' ? "AND kind IN ('customer','both')" : kind === 'supplier' ? "AND kind IN ('supplier','both')" : ''}
      ${custs && supps ? '' : custs ? "AND kind != 'supplier'" : "AND kind != 'customer'"}
      AND (? = '' OR name LIKE ? OR phone LIKE ?)${cf.sql} ORDER BY name LIMIT 1000`).bind(c.org.id, q.get('q') || '', `%${q.get('q') || ''}%`, `%${q.get('q') || ''}%`, ...cf.args).all();
  const bal = money ? await rep.partyBalances(c.db, c.org.id) : {};
  return json({ rows: results.map((p) => {
    const b = bal[p.id] || 0, o = { ...p, extra: extraOf(p.extra), credit_limit: R(p.credit_limit) };
    return money ? { ...o, balance: R(b), over_limit: p.credit_limit > 0 && b > p.credit_limit } : o;
  }) });
});
router.add('POST', '/api/parties', async (c) => {
  requireCan(c.user, 'masters');
  const f = partyFields(c.body, c);
  if (await c.db.prepare(`SELECT 1 FROM parties WHERE org_id = ? AND name = ?`).bind(c.org.id, f.name).first()) throw bad(`A party called ${f.name} already exists.`);
  const r = await c.db.prepare(`INSERT INTO parties (org_id, name, kind, phone, email, gstin, state, address, credit_limit, credit_days, city, pincode, extra, lang, vip, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).bind(c.org.id, f.name, f.kind, f.phone, f.email, f.gstin, f.state, f.address, f.credit_limit, f.credit_days, f.city, f.pincode,
    f.extra ?? cleanExtra(fieldsOf(c.org), 'party', {}), f.lang ?? '', f.vip ?? 0, nowIso()).first();
  return json({ ...r, extra: extraOf(r.extra), credit_limit: R(r.credit_limit) });
});
router.add('PUT', '/api/parties/:id', async (c) => {
  requireCan(c.user, 'masters');
  const f = partyFields(c.body, c);
  const dup = await c.db.prepare(`SELECT id FROM parties WHERE org_id = ? AND name = ? AND id != ?`).bind(c.org.id, f.name, +c.params.id).first();
  if (dup) throw bad(`A party called ${f.name} already exists.`);
  const r = await c.db.prepare(`UPDATE parties SET name = ?, kind = ?, phone = ?, email = ?, gstin = ?, state = ?, address = ?, credit_limit = ?, credit_days = ?, city = ?, pincode = ?,
      extra = COALESCE(?, extra), lang = COALESCE(?, lang), vip = COALESCE(?, vip) WHERE id = ? AND org_id = ?`)
    .bind(f.name, f.kind, f.phone, f.email, f.gstin, f.state, f.address, f.credit_limit, f.credit_days, f.city, f.pincode, f.extra, f.lang, f.vip, +c.params.id, c.org.id).run();
  if (!r.meta.changes) throw notFound('Party not found.');
  return json({ ok: true });
});
router.add('DELETE', '/api/parties/:id', async (c) => {
  requireCan(c.user, 'masters');
  const id = +c.params.id;
  const used = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM docs WHERE org_id = ?1 AND party_id = ?2) + EXISTS (SELECT 1 FROM journal_lines WHERE org_id = ?1 AND party_id = ?2)
      + EXISTS (SELECT 1 FROM khata WHERE party_id = ?2) + EXISTS (SELECT 1 FROM payments WHERE org_id = ?1 AND party_id = ?2)
      + EXISTS (SELECT 1 FROM vaade WHERE org_id = ?1 AND party_id = ?2) AS n`).bind(c.org.id, id).first();
  if (used.n) throw bad('This party has transactions and cannot be deleted.');
  await c.db.prepare(`DELETE FROM parties WHERE id = ? AND org_id = ?`).bind(id, c.org.id).run();
  return json({ ok: true });
});
router.add('POST', '/api/parties/:id/opening', async (c) => json(await partyOpening(c, +c.params.id, c.body)));
router.add('GET', '/api/parties/:id/ledger', async (c) => json(await rep.partyLedger(c.db, c.org, +c.params.id, c.url.searchParams)));

/* ======================================================================= bins (racks / shelves) and batches: src/lots.js */
router.add('GET', '/api/bins', async (c) => json(await listBins(c, +c.url.searchParams.get('warehouse_id') || 0)));
router.add('GET', '/api/bins/putaway', async (c) => json(await putawayPlan(c, +c.url.searchParams.get('warehouse_id') || 0)));
router.add('POST', '/api/bins/auto', async (c) => json(await autoBins(c, c.body)));
router.add('GET', '/api/receive', async (c) => json(await receivePending(c)));
router.add('GET', '/api/picklist', async (c) => json(await wavePick(c, String(c.url.searchParams.get('ids') || '').split(','))));
router.add('POST', '/api/bins', async (c) => json(await addBins(c, c.body)));
router.add('POST', '/api/bins/move', async (c) => json(await moveInBins(c, c.body)));
router.add('GET', '/api/bins/:id', async (c) => json(await binContents(c, +c.params.id)));
router.add('DELETE', '/api/bins/:id', async (c) => json(await deleteBin(c, +c.params.id)));
router.add('GET', '/api/items/:id/lots', async (c) => json(await itemLots(c, +c.params.id, +c.url.searchParams.get('warehouse_id') || 0)));
router.add('GET', '/api/serials', async (c) => json(await serialLookup(c, c.url.searchParams.get('q') || '')));   // IMEI / serial: where, sold to whom, warranty

/* ======================================================================= manufacturing: src/mfg.js */
router.add('GET', '/api/items/:id/bom', async (c) => json(await getBom(c, +c.params.id, +c.url.searchParams.get('warehouse_id') || 0)));
router.add('PUT', '/api/items/:id/bom', async (c) => json(await saveBom(c, +c.params.id, c.body)));
router.add('GET', '/api/productions', async (c) => json(await listProductions(c)));
router.add('POST', '/api/productions', async (c) => json(await createProduction(c, c.body)));
router.add('POST', '/api/productions/:id/cancel', async (c) => json(await cancelProduction(c, +c.params.id)));

/* ======================================================================= marketplace orders and stock file: src/channels.js */
router.add('POST', '/api/channels/import', async (c) => json(await importOrders(c, c.body)), { bodyMax: 3000000 });
router.add('GET', '/api/channels/stock', async (c) => download(`stock-${today()}.csv`, await stockFile(c, +c.url.searchParams.get('warehouse_id') || 0), 'text/csv'));

/* ======================================================================= staff, attendance and salary: src/payroll.js */
router.add('GET', '/api/staff', async (c) => json(await listStaff(c, c.url.searchParams.get('month'))));
router.add('POST', '/api/staff', async (c) => json(await saveStaff(c, 0, c.body)));
router.add('PUT', '/api/staff/:id', async (c) => json(await saveStaff(c, +c.params.id, c.body)));
router.add('POST', '/api/staff/attendance', async (c) => json(await markAttendance(c, c.body)));
router.add('GET', '/api/staff/:id', async (c) => json(await staffDetail(c, +c.params.id, c.url.searchParams.get('month'))));
router.add('POST', '/api/staff/:id/advance', async (c) => json(await giveAdvance(c, +c.params.id, c.body)));
router.add('POST', '/api/staff/:id/salary', async (c) => json(await paySalary(c, +c.params.id, c.body)));
router.add('POST', '/api/staff/txns/:id/cancel', async (c) => json(await cancelStaffTxn(c, +c.params.id)));
router.add('GET', '/api/staff/payslip/:id', async (c) => json(await payslip(c, +c.params.id)));

/* ======================================================================= automatic WhatsApp reminders: src/autowa.js */
router.add('PUT', '/api/settings/auto-wa', async (c) => {
  requireCan(c.user, 'settings');
  const on = !!c.body.on;
  if (on) {
    if (!waConfigured(c.env)) throw new HttpError(501, 'Automatic WhatsApp is not set up on this server yet.');
    requireFeature(c.org, 'autowa');
  }
  await c.db.batch([c.db.prepare(`UPDATE orgs SET auto_wa = ? WHERE id = ?`).bind(on ? 1 : 0, c.org.id), auditStatement(c, 'auto WhatsApp reminders', on ? 'on' : 'off')]);
  return json({ ok: true, on });
});
/* send today's due reminders now (owner / admin), instead of waiting for the morning run */
router.add('POST', '/api/settings/auto-wa/run', async (c) => {
  requireCan(c.user, 'settings');
  if (!c.org.auto_wa) throw bad('Turn on automatic reminders first.');
  requireFeature(c.org, 'autowa');
  await rateLimit(c.env, 'autowa-run:' + c.org.id, 5, 86400);
  const r = await remindOrg(c.env, c.org);
  return json({ sent: r.sent, failed: r.failed, skipped: r.skipped, errors: r.errors });
});

/* ======================================================================= live orders from web stores: src/hooks.js */
router.add('GET', '/api/hooks', async (c) => json(await listHooks(c)));
router.add('POST', '/api/hooks', async (c) => json(await addHook(c, c.body)));
router.add('DELETE', '/api/hooks/:id', async (c) => json(await deleteHook(c, +c.params.id)));
router.add('POST', '/api/hooks/:token', async (c) => {
  await rateLimit(c.env, 'hook:' + String(c.params.token).slice(0, 64), 600, 3600);
  return json(await receiveHook(c, c.params.token));
}, { public: true, webhook: true, rawOk: true });

/* ======================================================================= today: what needs doing, one tap each */
router.add('GET', '/api/today', async (c) => {
  const { db } = c, o = c.org.id, t = today(), u = c.user;
  const want = [];
  const sees = (area) => (u.role === 'custom' ? canView(u, area) : can(u, area));    // built-in roles: what they work on, not everything they may read
  const add = (key, area, sql, ...args) => { if (sees(area)) want.push([key, db.prepare(sql).bind(...args)]); };
  add('overdue', 'sales', `SELECT COUNT(*) AS n, COALESCE(SUM(total - paid), 0) AS v FROM docs WHERE org_id = ? AND type = 'INV' AND status IN ('unpaid','partial') AND due_date < ?`, o, t);
  add('promises', 'khata', `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS v FROM vaada_kisht WHERE org_id = ? AND outcome IS NULL AND due <= ?`, o, t);
  add('bills_due', 'finance', `SELECT COUNT(*) AS n, COALESCE(SUM(total - paid), 0) AS v FROM docs WHERE org_id = ? AND type = 'BILL' AND status IN ('unpaid','partial') AND due_date <= ?`, o, addDays(t, 7));
  add('approve', 'settings', `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS v FROM docs WHERE org_id = ? AND type = 'PO' AND status = 'pending'`, o);
  add('to_deliver', 'sales', `SELECT COUNT(*) AS n, 0 AS v FROM docs WHERE org_id = ? AND type = 'SO' AND status IN ('open','partial')`, o);
  add('to_receive', 'purchase', `SELECT COUNT(*) AS n, 0 AS v FROM docs WHERE org_id = ? AND type = 'PO' AND status IN ('open','partial')`, o);
  add('at_gate', 'purchase', `SELECT COUNT(*) AS n, 0 AS v FROM gate_entries WHERE org_id = ? AND kind = 'in' AND status = 'open'`, o);
  add('in_transit', 'purchase', `SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS v FROM docs WHERE org_id = ? AND type = 'BILL' AND transit = 1 AND status != 'cancelled'`, o);
  add('claims', 'finance', `SELECT COUNT(*) AS n, COALESCE(SUM(value + cgst + sgst + igst - received - closed), 0) AS v FROM write_offs
    WHERE org_id = ? AND mode = 'claim' AND status = 'done' AND value + cgst + sgst + igst > received + closed AND (follow_up = '' OR follow_up <= ?)`, o, t);
  add('low_stock', 'items', `SELECT COUNT(*) AS n, 0 AS v FROM items WHERE org_id = ? AND is_service = 0 AND reorder_level > 0 AND qty_on_hand <= reorder_level`, o);
  add('expired', 'items', `SELECT COUNT(*) AS n, COALESCE(SUM(b.qty * i.avg_cost), 0) AS v FROM batches b JOIN items i ON i.id = b.item_id
    WHERE b.org_id = ? AND b.qty > 0.0005 AND b.expiry != '' AND b.expiry < ?`, o, t);
  add('expiring', 'items', `SELECT COUNT(*) AS n, COALESCE(SUM(b.qty * i.avg_cost), 0) AS v FROM batches b JOIN items i ON i.id = b.item_id
    WHERE b.org_id = ? AND b.qty > 0.0005 AND b.expiry != '' AND b.expiry BETWEEN ? AND ?`, o, t, addDays(t, 30));
  add('put_away', 'items', `SELECT COUNT(*) AS n, 0 AS v FROM (SELECT s.item_id FROM stock s WHERE s.org_id = ? AND s.qty > 0.0005
    AND s.warehouse_id IN (SELECT DISTINCT warehouse_id FROM bins WHERE org_id = ?)
    AND s.qty - COALESCE((SELECT SUM(qty) FROM bin_stock b WHERE b.item_id = s.item_id AND b.warehouse_id = s.warehouse_id), 0) > 0.0005)`, o, o);
  add('disputed', 'finance', `SELECT COUNT(*) AS n, 0 AS v FROM confirmations WHERE org_id = ? AND status = 'disputed' AND answered_at >= ?`, o, addDays(t, -30));
  add('recurring', 'sales', `SELECT COUNT(*) AS n, 0 AS v FROM recurring WHERE org_id = ? AND active = 1 AND COALESCE(last_error, '') != ''`, o);
  if (sees('finance')) want.push(...todayStaffQueries(db, o));
  const rs = want.length ? await db.batch(want.map(([, q]) => q)) : [];
  const costs = seesCosts(u), rows = [];
  want.forEach(([key], i) => {
    const r = rs[i].results[0] || { n: 0, v: 0 };
    if (!r.n) return;
    const money = ['overdue', 'promises', 'bills_due', 'approve', 'claims'].includes(key) || costs;
    rows.push({ key, n: r.n, value: money ? R(r.v) : null });
  });
  return json({ date: t, rows });
});

/* ======================================================================= items & warehouses */
const itemFields = (b, c) => ({
  extra: b.extra === undefined ? null : cleanExtra(fieldsOf(c.org), 'item', b.extra),
  name: reqStr(b.name, 'Item name', 120), sku: str(b.sku, 40), category: str(b.category, 60), unit: str(b.unit, 12) || 'Pcs', hsn: str(b.hsn, 10),
  gst_rate: num(b.gst_rate, 'GST rate', { min: 0, max: 100, def: 0 }),
  purchase_price: b.purchase_price === undefined ? null : toPaise(num(b.purchase_price, 'Purchase price', { min: 0, def: 0 })), sale_price: toPaise(num(b.sale_price, 'Sale price', { min: 0, def: 0 })),
  reorder_level: num(b.reorder_level, 'Reorder level', { min: 0, def: 0 }), is_service: b.is_service ? 1 : 0,
  barcode: str(b.barcode, 48).replace(/\s+/g, ''), location: str(b.location, 30).toUpperCase(),
  track_batch: b.track_batch === undefined ? null : b.track_batch === true || b.track_batch === 1 || b.track_batch === '1' || b.track_batch === 'on' ? 1 : 0,
  track_serial: b.track_serial === undefined ? null : b.track_serial === true || b.track_serial === 1 || b.track_serial === '1' || b.track_serial === 'on' ? 1 : 0,
  warranty_months: b.warranty_months === undefined ? null : Math.round(num(b.warranty_months, 'Warranty months', { min: 0, max: 240, def: 0 })),
});
async function barcodeTaken(c, code, exceptId = 0) {
  if (!code) return;
  const hit = await c.db.prepare(`SELECT name FROM items WHERE org_id = ? AND id != ? AND (barcode = ? OR (sku != '' AND sku = ?))
      UNION ALL SELECT i.name FROM item_codes x JOIN items i ON i.id = x.item_id WHERE x.org_id = ? AND x.code = ? AND x.item_id != ? LIMIT 1`)
    .bind(c.org.id, exceptId, code, code, c.org.id, code, exceptId).first();
  if (hit) throw bad(`Barcode ${code} is already used by ${hit.name}.`);
}
const itemOut = (i, c) => {
  const o = { ...i, extra: extraOf(i.extra), purchase_price: R(i.purchase_price), sale_price: R(i.sale_price), avg_cost: R(i.avg_cost), stock_value: R(Math.max(0, i.qty_on_hand) * i.avg_cost) };
  if (c && !seesCosts(c.user)) { delete o.purchase_price; delete o.avg_cost; delete o.stock_value; }
  return o;
};
router.add('GET', '/api/items', async (c) => {
  const q = c.url.searchParams.get('q') || '', cf = extraFilter(fieldsOf(c.org), 'item', c.url.searchParams, 'extra');
  const { results } = await c.db.prepare(`SELECT * FROM items WHERE org_id = ? AND (? = '' OR name LIKE ? OR sku LIKE ?)${cf.sql} ORDER BY name LIMIT 2000`)
    .bind(c.org.id, q, `%${q}%`, `%${q}%`, ...cf.args).all();
  return json({ rows: results.map((i) => itemOut(i, c)) });
});
router.add('POST', '/api/items', async (c) => {
  requireCan(c.user, 'items');
  const f = itemFields(c.body, c);
  if (await c.db.prepare(`SELECT 1 FROM items WHERE org_id = ? AND name = ?`).bind(c.org.id, f.name).first()) throw bad(`An item called ${f.name} already exists.`);
  await barcodeTaken(c, f.barcode);
  const r = await c.db.prepare(`INSERT INTO items (org_id, sku, name, category, unit, hsn, gst_rate, purchase_price, sale_price, reorder_level, is_service, avg_cost, barcode, location, extra,
      track_batch, track_serial, warranty_months, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(c.org.id, f.sku, f.name, f.category, f.unit, f.hsn, f.gst_rate, f.purchase_price ?? 0, f.sale_price, f.reorder_level, f.is_service, f.purchase_price ?? 0, f.barcode, f.location,
      f.extra ?? cleanExtra(fieldsOf(c.org), 'item', {}), f.is_service ? 0 : f.track_batch ?? 0, f.is_service ? 0 : f.track_serial ?? 0, f.warranty_months ?? 0, nowIso()).first();
  if (c.body.opening_qty && +c.body.opening_qty > 0 && !f.is_service) {
    await stockAdjust(c, { item_id: r.id, qty: c.body.opening_qty, rate: c.body.opening_rate === undefined || c.body.opening_rate === '' ? R(f.purchase_price ?? 0) : c.body.opening_rate, reason: 'opening',
      warehouse_id: c.body.warehouse_id, batch_no: c.body.opening_batch, expiry: c.body.opening_expiry, serials: c.body.opening_serials });
  }
  return json(itemOut(await c.db.prepare(`SELECT * FROM items WHERE id = ?`).bind(r.id).first(), c));
});
router.add('PUT', '/api/items/:id', async (c) => {
  requireCan(c.user, 'items');
  const f = itemFields(c.body, c);
  const dup = await c.db.prepare(`SELECT id FROM items WHERE org_id = ? AND name = ? AND id != ?`).bind(c.org.id, f.name, +c.params.id).first();
  if (dup) throw bad(`An item called ${f.name} already exists.`);
  await barcodeTaken(c, f.barcode, +c.params.id);
  const r = await c.db.prepare(`UPDATE items SET sku = ?, name = ?, category = ?, unit = ?, hsn = ?, gst_rate = ?, purchase_price = COALESCE(?, purchase_price), sale_price = ?, reorder_level = ?, barcode = ?, location = ?,
      extra = COALESCE(?, extra), track_batch = CASE WHEN is_service = 1 THEN 0 ELSE COALESCE(?, track_batch) END,
      track_serial = CASE WHEN is_service = 1 THEN 0 ELSE COALESCE(?, track_serial) END, warranty_months = COALESCE(?, warranty_months) WHERE id = ? AND org_id = ?`)
    .bind(f.sku, f.name, f.category, f.unit, f.hsn, f.gst_rate, f.purchase_price, f.sale_price, f.reorder_level, f.barcode, f.location, f.extra, f.track_batch,
      f.track_serial, f.warranty_months, +c.params.id, c.org.id).run();
  if (!r.meta.changes) throw notFound('Item not found.');
  return json({ ok: true });
});
router.add('DELETE', '/api/items/:id', async (c) => {
  requireCan(c.user, 'items');
  const id = +c.params.id;
  const used = await c.db.prepare(`SELECT EXISTS (SELECT 1 FROM doc_lines WHERE item_id = ?) + EXISTS (SELECT 1 FROM stock_moves WHERE org_id = ? AND item_id = ?) AS n`).bind(id, c.org.id, id).first();
  if (used.n) throw bad('This item has transactions and cannot be deleted.');
  await c.db.batch([c.db.prepare(`DELETE FROM items WHERE id = ? AND org_id = ?`).bind(id, c.org.id),
    c.db.prepare(`DELETE FROM item_codes WHERE item_id = ? AND org_id = ?`).bind(id, c.org.id)]);
  return json({ ok: true });
});
router.add('POST', '/api/items/:id/codes', async (c) => json(await learnCode(c, +c.params.id, c.body)));
/* Scanner lookup: barcode, SKU, the printed label code ST<id>, or a code learnt while receiving */
router.add('GET', '/api/items/lookup', async (c) => {
  const code = str(c.url.searchParams.get('code'), 60).replace(/\s+/g, '');
  if (!code) throw bad('Scan or type a code.');
  const m = code.toUpperCase().match(/^ST(\d+)$/);
  const it = await c.db.prepare(`SELECT * FROM items WHERE org_id = ? AND (barcode = ? OR (sku != '' AND sku = ?) OR id = ?) ORDER BY barcode = ? DESC LIMIT 1`)
    .bind(c.org.id, code, code, m ? +m[1] : -1, code).first();
  if (it) return json({ ...itemOut(it, c), pack_qty: 1 });
  // a code learnt while receiving (a supplier's barcode, a carton)
  const x = await c.db.prepare(`SELECT i.*, x.pack_qty AS pack FROM item_codes x JOIN items i ON i.id = x.item_id WHERE x.org_id = ? AND x.code = ?`).bind(c.org.id, code).first();
  if (!x) throw notFound(`No item with code ${code}.`);
  const { pack, ...row } = x;
  return json({ ...itemOut(row, c), pack_qty: pack });
});
router.add('GET', '/api/items/:id/moves', async (c) => {
  const rows = await rep.itemMoves(c.db, c.org, +c.params.id);
  return json({ rows: seesCosts(c.user) ? rows : rows.map((r) => noCosts({ ...r }, ['unit_cost', 'value'])) });
});

router.add('GET', '/api/warehouses', async (c) => {
  const { results } = await c.db.prepare(`SELECT w.*, COALESCE((SELECT SUM(s.qty * i.avg_cost) FROM stock s JOIN items i ON i.id = s.item_id WHERE s.org_id = w.org_id AND s.warehouse_id = w.id AND s.qty > 0), 0) AS value
      FROM warehouses w WHERE w.org_id = ? ORDER BY w.id`).bind(c.org.id).all();
  const costs = seesCosts(c.user);
  return json({ rows: results.map(({ value, ...w }) => (costs ? { ...w, value: R(value) } : w)) });
});
router.add('POST', '/api/warehouses', async (c) => {
  requireCan(c.user, 'stock');
  const name = reqStr(c.body.name, 'Warehouse name', 80);
  if (await c.db.prepare(`SELECT 1 FROM warehouses WHERE org_id = ? AND name = ?`).bind(c.org.id, name).first()) throw bad('That warehouse already exists.');
  await checkCount(c.db, c.org, 'warehouses');
  const max = planOf(c.org).warehouses;
  const row = await c.db.prepare(`INSERT INTO warehouses (org_id, name) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM warehouses WHERE org_id = ?1) < ?3 RETURNING *`)
    .bind(c.org.id, name, Number.isFinite(max) ? max : 1e9).first();
  if (!row) throw countError(c.org, 'warehouses');
  return json(row);
});

/* ======================================================================= accounts */
router.add('GET', '/api/accounts', async (c) => {
  const rows = await rep.accountBalances(c.db, c.org.id, '0001-01-01', '9999-12-31');
  const full = canView(c.user, 'finance') || canView(c.user, 'reports');
  if (!full) {      // a role that sees neither finance nor reports gets the cash/bank/UPI accounts only (the dashboard shows those balances anyway)
    return json({ rows: rows.filter((a) => a.is_cash).map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, sys: a.sys, is_cash: a.is_cash, balance: R(a.dr - a.cr) })) });
  }
  return json({ rows: rows.map((a) => ({ ...a, bal: a.dr - a.cr, balance: R(['asset', 'expense'].includes(a.type) ? a.dr - a.cr : a.cr - a.dr) })) });
});
router.add('POST', '/api/accounts', async (c) => {
  requireCan(c.user, 'finance');
  const code = reqStr(c.body.code, 'Code', 10), name = reqStr(c.body.name, 'Name', 80);
  const type = oneOf(c.body.type, ['asset', 'liability', 'equity', 'income', 'expense'], 'Type');
  if (await c.db.prepare(`SELECT 1 FROM accounts WHERE org_id = ? AND code = ?`).bind(c.org.id, code).first()) throw bad('That account code is in use.');
  return json(await c.db.prepare(`INSERT INTO accounts (org_id, code, name, type, is_cash) VALUES (?, ?, ?, ?, ?) RETURNING *`)
    .bind(c.org.id, code, name, type, type === 'asset' && c.body.is_cash ? 1 : 0).first());
});
router.add('GET', '/api/accounts/:id/ledger', async (c) => json(await rep.accountLedger(c.db, c.org, +c.params.id, c.url.searchParams)));

/* ======================================================================= documents */
router.add('GET', '/api/docs', async (c) => {
  const q = c.url.searchParams;
  const where = ['d.org_id = ?'], args = [c.org.id];
  if (q.get('type')) { where.push('d.type = ?'); args.push(q.get('type').toUpperCase()); }
  if (q.get('status')) { where.push('d.status = ?'); args.push(q.get('status')); }
  if (q.get('party_id')) { where.push('d.party_id = ?'); args.push(+q.get('party_id')); }
  if (q.get('from')) { where.push('d.date >= ?'); args.push(date(q.get('from'))); }
  if (q.get('to')) { where.push('d.date <= ?'); args.push(date(q.get('to'))); }
  if (q.get('q')) { where.push('(d.number LIKE ? OR p.name LIKE ?)'); args.push(`%${q.get('q')}%`, `%${q.get('q')}%`); }
  const cf = extraFilter(fieldsOf(c.org), 'doc', q, 'd.extra');
  if (limitedView(c.user)) {      // custom (or changed) role: only the sides it may see
    const types = Object.keys(DOC_TYPES).filter((t) => canView(c.user, DOC_TYPES[t].side));
    where.push(`d.type IN (${types.map((t) => `'${t}'`).join(',') || "''"})`);
  }
  const limit = Math.min(500, +q.get('limit') || 100), offset = Math.max(0, +q.get('offset') || 0);
  const { results } = await c.db.prepare(`SELECT d.id, d.type, d.number, d.date, d.due_date, d.status, d.total, d.paid, d.taxable, d.ref_id, d.extra, p.name AS party
      FROM docs d LEFT JOIN parties p ON p.id = d.party_id WHERE ${where.join(' AND ')}${cf.sql} ORDER BY d.date DESC, d.id DESC LIMIT ? OFFSET ?`)
    .bind(...args, ...cf.args, limit, offset).all();
  return json({ rows: results.map((r) => ({ ...r, extra: extraOf(r.extra), total: R(r.total), paid: R(r.paid), taxable: R(r.taxable), balance: R(r.total - r.paid) })) });
});

async function docDetail(c, id) {
  const d = await c.db.prepare(`SELECT d.*, w.name AS warehouse FROM docs d LEFT JOIN warehouses w ON w.id = d.warehouse_id WHERE d.id = ? AND d.org_id = ?`).bind(id, c.org.id).first();
  if (!d) throw notFound('Document not found.');
  if (c.user && !canView(c.user, DOC_TYPES[d.type].side)) throw forbidden('Your role cannot see this document.');
  const [lines, party, children, parent, pays, wos] = await Promise.all([
    c.db.prepare(`SELECT l.*, i.name AS item, i.unit, i.hsn, i.is_service, i.location, i.track_batch, i.track_serial, i.extra AS item_extra FROM doc_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.doc_id = ? ORDER BY l.id`).bind(id).all(),
    c.db.prepare(`SELECT * FROM parties WHERE id = ?`).bind(d.party_id).first(),
    c.db.prepare(`SELECT id, type, number, date, status, total FROM docs WHERE ref_id = ? AND org_id = ? ORDER BY id`).bind(id, c.org.id).all(),
    d.ref_id ? c.db.prepare(`SELECT id, type, number, date, status FROM docs WHERE id = ?`).bind(d.ref_id).first() : null,
    c.db.prepare(`SELECT pa.amount, pa.note_id, p.id, p.number, p.date, p.kind, n.number AS note_number FROM payment_allocs pa
        LEFT JOIN payments p ON p.id = pa.payment_id LEFT JOIN docs n ON n.id = pa.note_id WHERE pa.doc_id = ?`).bind(id).all(),
    // goods of a bill-first bill written off (damaged / lost on the way)
    d.type === 'BILL' && d.transit ? c.db.prepare(`SELECT * FROM write_offs WHERE bill_id = ? AND org_id = ? ORDER BY id`).bind(id, c.org.id).all() : { results: [] },
  ]);
  const money = (x) => R(x), defs = fieldsOf(c.org), side = DOC_TYPES[d.type].side;
  return {
    ...d, extra: extraOf(d.extra), print_fields: [...printExtra(defs, 'doc', d.extra, side), ...printExtra(defs, 'party', party && party.extra)], taxable: money(d.taxable), cgst: money(d.cgst), sgst: money(d.sgst), igst: money(d.igst), round_off: money(d.round_off),
    total: money(d.total), paid: money(d.paid), balance: money(d.total - d.paid), label: DOC_TYPES[d.type].label, side: DOC_TYPES[d.type].side,
    party: party && { ...party, extra: extraOf(party.extra) }, parent, children: children.results.map((x) => ({ ...x, total: money(x.total) })),
    settlements: pays.results.map((p) => ({ ...p, amount: money(p.amount), number: p.number || p.note_number })), write_offs: wos.results.map(writeOffOut),
    lines: lines.results.map(({ item_extra, ...l }) => ({ ...l, print_extra: printExtra(defs, 'item', item_extra).map((x) => `${x.label}: ${x.value}`).join(' · '), rate: money(l.rate), taxable: money(l.taxable), cgst: money(l.cgst), sgst: money(l.sgst), igst: money(l.igst),
      total: money(l.total), cost: c.user && !seesCosts(c.user) ? undefined : money(l.cost),
      // a bill booked before its goods came: returns only from what came, receipts from what has not
      remaining: Math.round((d.transit && d.type === 'BILL' ? l.recv_qty - l.done_qty : l.qty - l.done_qty) * 1000) / 1000,
      to_receive: d.transit && d.type === 'BILL' && l.item_id && !l.is_service ? Math.round((l.qty - l.recv_qty - l.short_qty) * 1000) / 1000 : 0 })),
    org: orgOut(c.org), ...fileUrls(printOf(c.org), '/api/org/files'),
  };
}
router.add('GET', '/api/docs/:id', async (c) => json(await docDetail(c, +c.params.id)));
router.add('POST', '/api/docs', async (c) => json(await docDetail(c, (await createDoc(c, c.body)).id)));
router.add('POST', '/api/docs/:id/cancel', async (c) => { await cancelDoc(c, +c.params.id); return json(await docDetail(c, +c.params.id)); });
router.add('POST', '/api/docs/:id/approve', async (c) => { await approveDoc(c, +c.params.id); return json(await docDetail(c, +c.params.id)); });
router.add('POST', '/api/docs/:id/write-off', async (c) => json(await writeOff(c, +c.params.id, c.body)));
router.add('POST', '/api/write-offs/:id/cancel', async (c) => json(await cancelWriteOff(c, +c.params.id)));
/* transit claims followed up: src/claims.js */
router.add('GET', '/api/claims', async (c) => json(await listClaims(c, c.url.searchParams.get('status') || 'open')));
router.add('GET', '/api/claims/:id', async (c) => json(await claimDetail(c, +c.params.id)));
router.add('PUT', '/api/claims/:id', async (c) => json(await saveClaim(c, +c.params.id, c.body)));
router.add('POST', '/api/claims/:id/receive', async (c) => json(await claimReceipt(c, +c.params.id, c.body)));
router.add('POST', '/api/claims/:id/close', async (c) => json(await closeClaim(c, +c.params.id, c.body)));
router.add('POST', '/api/claim-entries/:id/cancel', async (c) => json(await cancelClaimEntry(c, +c.params.id)));

/* A ready-to-post draft of the next document in the chain, with the quantities still open. */
router.add('GET', '/api/docs/:id/convert', async (c) => {
  const src = await docDetail(c, +c.params.id);
  const to = (c.url.searchParams.get('to') || '').toUpperCase();
  const T = own(DOC_TYPES, to);
  if (!T || !T.from.includes(src.type)) throw bad(`Cannot make a ${to} from a ${src.type}.`);
  if (src.status === 'pending') throw bad(`${src.number} is waiting for approval by the owner or an admin.`);
  const receiving = to === 'GRN' && src.type === 'BILL', short = to === 'DNOTE' && c.url.searchParams.get('short') === '1';
  if ((receiving || short) && src.transit !== 1) throw bad(`${src.number} has no goods left to receive.`);
  if (short) {      // shortage note: what has not come, at the bill's price
    const lines = src.lines.filter((l) => l.to_receive > 0.0005).map((l) => ({ item_id: l.item_id, item: l.item, unit: l.unit, description: l.description, qty: l.to_receive,
      rate: l.rate, discount_pct: l.discount_pct, gst_rate: l.gst_rate, src_line_id: l.id }));
    return json({ type: to, short: true, party_id: src.party_id, ref_id: src.id, ref_number: src.number, ref_type: src.type, warehouse_id: src.warehouse_id, date: today(),
      notes: `Goods short received against ${src.party_ref ? 'bill ' + src.party_ref + ' / ' : ''}${src.number}`, lines });
  }
  if (T.note) {     // value note: every line of the bill/invoice, the user types the rate difference per unit
    return json({ type: to, party_id: src.party_id, ref_id: src.id, ref_number: src.number, warehouse_id: src.warehouse_id, date: today(), extra: src.extra,
      lines: src.lines.map((l) => ({ item_id: l.item_id, item: l.item, unit: l.unit, description: l.description || l.item, qty: l.qty, rate: '', discount_pct: 0, gst_rate: l.gst_rate, orig_rate: l.rate })) });
  }
  const left = (l) => (receiving ? l.to_receive : l.remaining);
  const lines = src.lines.filter((l) => left(l) > 0.0005).map((l) => ({
    item_id: l.item_id, item: l.item, unit: l.unit, description: l.description, qty: left(l), rate: l.rate,
    discount_pct: l.discount_pct, gst_rate: l.gst_rate, src_line_id: l.id, batch_no: l.batch_no || '', expiry: l.expiry || '',
    serials: l.serials && Math.abs(left(l) - l.qty) < 0.0005 ? l.serials : '', src_serials: l.serials || '',
    track_batch: l.track_batch, track_serial: l.track_serial, location: l.location,
  }));
  if (!lines.length) throw bad(`Nothing left to ${['SRET', 'PRET'].includes(to) ? 'return' : receiving ? 'receive' : 'process'} on ${src.number}.`);
  return json({ type: to, party_id: src.party_id, ref_id: src.id, ref_number: src.number, ref_type: src.type, warehouse_id: src.warehouse_id, date: today(), extra: src.extra,
    party_ref: src.party_ref || '', lines });
});

/* Print design of one document (presentation only, so it can change after saving; '' goes back to the business default) */
router.add('PUT', '/api/docs/:id/design', async (c) => {
  const d = await c.db.prepare(`SELECT id, type, number FROM docs WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!d) throw notFound('Document not found.');
  requireCan(c.user, DOC_TYPES[d.type].side === 'sales' ? 'sales' : 'purchase');
  const design = String(c.body.design || '');
  if (design && !LAYOUTS.includes(design)) throw bad(`Design must be one of: ${LAYOUTS.join(', ')}.`);
  await c.db.batch([c.db.prepare(`UPDATE docs SET design = ? WHERE id = ?`).bind(design || null, d.id), auditStatement(c, 'design', `${d.number}: ${design || 'default'}`)]);
  return json({ ok: true, design: design || null });
});

/* Recurring: the document is made again by itself every week / month / quarter / year (src/recurring.js) */
router.add('POST', '/api/docs/:id/recurring', async (c) => json({ id: await createRecurring(c, +c.params.id) }));
router.add('GET', '/api/recurring', async (c) => json({ rows: await listRecurring(c) }));
router.add('POST', '/api/recurring/:id/stop', async (c) => { await stopRecurring(c, +c.params.id); return json({ ok: true }); });
router.add('POST', '/api/recurring/:id/resume', async (c) => { await resumeRecurring(c, +c.params.id); return json({ ok: true }); });
router.add('POST', '/api/recurring/run', async (c) => {
  if (c.user.role !== 'owner') throw forbidden('Only the business owner can do this.');
  return json(await runDue(c.env, c.org.id));
});

/* Repeat: a new draft of the same type, party and lines as an earlier document, dated today (monthly bills,
   regular orders). It is only a draft for the new-document form; nothing is saved or linked to the original. */
const REPEATABLE = ['INV', 'BILL', 'QUOTE', 'SO', 'PO'];
router.add('GET', '/api/docs/:id/copy', async (c) => {
  const src = await docDetail(c, +c.params.id);
  if (!REPEATABLE.includes(src.type)) throw bad(`A ${src.type} cannot be repeated.`);
  return json({ type: src.type, party_id: src.party_id, warehouse_id: src.warehouse_id, date: today(), extra: src.extra, notes: src.notes || '', design: src.design || '',
    lines: src.lines.map((l) => ({ item_id: l.item_id, item: l.item, unit: l.unit, description: l.description, qty: l.qty, rate: l.rate, discount_pct: l.discount_pct, gst_rate: l.gst_rate })) });
});

/* GST portal files: e-invoice (IRP) and e-way bill JSON, and the numbers the portal gives back */
const download = (name, body, type = 'application/json') => new Response(body, { headers: {
  'Content-Type': type + '; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } });
router.add('GET', '/api/docs/:id/einvoice', async (c) => {
  requireFeature(c.org, 'einvoice');
  const d = await docDetail(c, +c.params.id);
  return download(`einvoice-${d.number}.json`, JSON.stringify([einvoiceJson(d)], null, 2));
});
router.add('GET', '/api/docs/:id/ewaybill', async (c) => {
  requireFeature(c.org, 'einvoice');
  const d = await docDetail(c, +c.params.id);
  return download(`ewaybill-${d.number}.json`, JSON.stringify(ewaybillJson(d, Object.fromEntries(c.url.searchParams)), null, 2));
});
router.add('PUT', '/api/docs/:id/gst-refs', async (c) => {
  requireCan(c.user, 'sales');
  const b = c.body;
  const r = await c.db.prepare(`UPDATE docs SET irn = ?, ack_no = ?, ack_date = ?, ewb_no = ?, ewb_date = ? WHERE id = ? AND org_id = ?`)
    .bind(str(b.irn, 64), str(b.ack_no, 20), str(b.ack_date, 30), str(b.ewb_no, 20), str(b.ewb_date, 30), +c.params.id, c.org.id).run();
  if (!r.meta.changes) throw notFound('Document not found.');
  return json({ ok: true });
});
/* Customer link for a document: view, print/download and pay by UPI. Shared on WhatsApp with a banner card.
   Only roles that may sell can create one; anyone with the link can read the document until the link is revoked. */
async function shareToken(c, docId) {
  const d = await c.db.prepare(`SELECT share_token FROM docs WHERE id = ? AND org_id = ?`).bind(docId, c.org.id).first();
  if (!d) throw notFound('Document not found.');
  if (d.share_token) return d.share_token;
  requireCan(c.user, 'sales');
  await c.db.prepare(`UPDATE docs SET share_token = ? WHERE id = ? AND org_id = ? AND share_token IS NULL`).bind(randomHex(12), docId, c.org.id).run();
  return (await c.db.prepare(`SELECT share_token FROM docs WHERE id = ? AND org_id = ?`).bind(docId, c.org.id).first()).share_token;
}
/* The customer's language: ?lang= (then remembered on the contact), else the contact's, else the business default */
async function langFor(c, p) {
  const want = c.url.searchParams.get('lang');
  if (LANGS.includes(want)) {
    if (p && p.id && p.lang !== want && (can(c.user, 'sales') || can(c.user, 'khata'))) await c.db.prepare(`UPDATE parties SET lang = ? WHERE id = ? AND org_id = ?`).bind(want, p.id, c.org.id).run();
    return want;
  }
  return cleanLang(p && p.lang, cleanLang(c.org.msg_lang));
}
router.add('GET', '/api/docs/:id/share', async (c) => {
  requireCan(c.user, 'sales');
  const d = await docDetail(c, +c.params.id);
  const p = d.party || {}, paise = (x) => Math.round(x * 100);
  const lang = await langFor(c, p), L = phrases(lang);
  const url = withLang(`${c.url.origin}/i/${await shareToken(c, d.id)}`, lang);
  const owes = d.type === 'INV' && d.balance > 0, upi = owes && c.org.upi_id, label = L.docLabel(d.type, d.label);
  const status = d.type === 'INV' ? (d.balance <= 0 ? L.paid : `${L.due}: *${inrW(paise(d.balance))}*`) : '';
  const wa = [`*${c.org.name}*`, `${label} *${d.number}* · ${fd(d.date)}`, '', L.hello(p.name || ''), `${L.amount}: *${inrW(paise(d.total))}*`,
    ...(status ? [status] : []), ...(upi ? [`UPI: ${c.org.upi_id}`] : []), '', upi ? L.viewDocPay : L.viewDoc, url, '', L.sentVia(BRAND)].join('\n');
  const sms = `${L.smsDoc(c.org.name, label, d.number, fd(d.date), rs(paise(d.total)), owes ? rs(paise(d.balance)) : '', url)} -${BRAND}`;
  return json({ url, lang, file_name: `${d.number.replace(/[^\w.-]+/g, '-')}.pdf`, ...sendLinks(p.phone, wa, sms) });
});
/* Stop sharing one document: its link stops working at once, and sharing it again makes a new link. */
router.add('POST', '/api/docs/:id/share/revoke', async (c) => {
  requireCan(c.user, 'sales');
  const r = await c.db.prepare(`UPDATE docs SET share_token = NULL WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).run();
  if (!r.meta.changes) throw notFound('Document not found.');
  await c.db.batch([auditStatement(c, 'revoke document link', String(+c.params.id))]);
  return json({ ok: true });
});
/* Stop sharing one party's khata statement link. */
router.add('POST', '/api/khata/:party/revoke-link', async (c) => {
  requireCan(c.user, 'khata');
  const r = await c.db.prepare(`UPDATE parties SET khata_token = NULL WHERE id = ? AND org_id = ?`).bind(+c.params.party, c.org.id).run();
  if (!r.meta.changes) throw notFound('Contact not found.');
  await c.db.batch([auditStatement(c, 'revoke khata link', String(+c.params.party))]);
  return json({ ok: true });
});
/* Owner/admin panic button: every customer link of this business (invoices and khata statements) stops working. */
router.add('POST', '/api/org/revoke-links', async (c) => {
  requireCan(c.user, 'settings');
  const [d, k] = await c.db.batch([c.db.prepare(`UPDATE docs SET share_token = NULL WHERE org_id = ? AND share_token IS NOT NULL`).bind(c.org.id),
    c.db.prepare(`UPDATE parties SET khata_token = NULL WHERE org_id = ? AND khata_token IS NOT NULL`).bind(c.org.id),
    auditStatement(c, 'revoke all customer links')]);
  return json({ ok: true, invoices: d.meta.changes, khata: k.meta.changes });
});
const PUBLIC_DOCS = ['INV', 'SRET', 'CNOTE', 'QUOTE', 'SO', 'DN'];
router.add('GET', '/api/public/doc/:token', async (c) => {
  await rateLimit(c.env, 'dview:' + (clientIp(c)), 120, 600);
  const t = String(c.params.token || '');
  const row = /^[0-9a-f]{24}$/.test(t) ? await c.db.prepare(`SELECT id, org_id, party_id FROM docs WHERE share_token = ?`).bind(t).first() : null;
  if (!row) throw notFound('This link is not valid.');
  c.org = await c.db.prepare(`SELECT * FROM orgs WHERE id = ?`).bind(row.org_id).first();
  const d = await docDetail(c, row.id);
  if (!PUBLIC_DOCS.includes(d.type) || d.status === 'cancelled') throw notFound('This link is not valid.');
  const o = d.org, p = d.party || {};
  const vaada = d.type === 'INV' && d.status !== 'cancelled' && row.party_id ? await publicVaada(c, c.org, row.party_id, 'inv') : null;
  return json({ vaada,   // only what is printed on the document: no costs, margins, links to other records or internal ids
    type: d.type, label: d.label, side: d.side, number: d.number, date: d.date, due_date: d.due_date, status: d.status, place_of_supply: d.place_of_supply,
    inter_state: d.inter_state, taxable: d.taxable, cgst: d.cgst, sgst: d.sgst, igst: d.igst, round_off: d.round_off, total: d.total, paid: d.paid, balance: d.balance,
    notes: d.notes, print_fields: d.print_fields, irn: d.irn, ack_no: d.ack_no, ack_date: d.ack_date, ewb_no: d.ewb_no, ewb_date: d.ewb_date, warehouse: '',
    parent: d.parent && ['SRET', 'CNOTE'].includes(d.type) ? { number: d.parent.number, date: d.parent.date } : null,
    org: { name: o.name, gstin: o.gstin, state: o.state, address: o.address, phone: o.phone, upi_id: o.upi_id, email: o.email, print: o.print },
    ...fileUrls(o.print, `/api/public/doc/${t}/file`),
    party: { name: p.name, gstin: p.gstin, address: p.address, phone: p.phone, state: p.state },
    lines: d.lines.map((l) => ({ item: l.item, description: l.description, hsn: l.hsn, unit: l.unit, qty: l.qty, rate: l.rate, discount_pct: l.discount_pct,
      gst_rate: l.gst_rate, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, total: l.total, print_extra: l.print_extra })),
  });
}, { public: true });

/* logo / signature on the customer's link: only for a business that has a shared document with this token */
router.add('GET', '/api/public/doc/:token/file/:kind', async (c) => {
  const t = String(c.params.token || ''), kind = oneOf(c.params.kind, FILE_KINDS, 'File');
  const row = /^[0-9a-f]{24}$/.test(t) ? await c.db.prepare(`SELECT f.mime, f.data FROM docs d JOIN org_files f ON f.org_id = d.org_id AND f.kind = ?
      WHERE d.share_token = ? AND d.status != 'cancelled' AND d.type IN ('${PUBLIC_DOCS.join("','")}')`).bind(kind, t).first() : null;
  if (!row) throw notFound('No image.');
  return imageResponse(row);
}, { public: true });

router.add('GET', '/api/export/tally', async (c) => {
  requireFeature(c.org, 'tally');
  const t = await tallyXml(c.db, c.org, c.url.searchParams);
  return download(`tally-${t.from}-to-${t.to}.xml`, t.xml, 'application/xml');
});

/* Full backup: every record of this business in one JSON file, so the owner's data is never locked in here (owner only).
   The same file goes to the owner's Google Drive when it is connected (src/gdrive.js). */
router.add('GET', '/api/export/backup', async (c) => {
  if (c.user.role !== 'owner') throw forbidden('Only the business owner can download a full backup.');
  const b = await buildBackup(c.db, c.org.id);
  await c.db.batch([auditStatement(c, 'backup', `${b.records} records`)]);
  return download(`smarttrader-backup-${today()}.json`, b.json);
});
driveRoutes(router);

/* The same records as a readable Excel workbook (owner only): one sheet per kind of record, amounts in rupees */
router.add('GET', '/api/export/excel', async (c) => {
  if (c.user.role !== 'owner') throw forbidden('Only the business owner can download a full backup.');
  const x = await excelBackup(c.db, c.org);
  await c.db.batch([auditStatement(c, 'backup excel', `${x.counts.bills} bills`)]);
  return new Response(x.bytes, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="smarttrader-${today()}.xlsx"`, 'Cache-Control': 'no-store' } });
});

/* Restore (src/restore.js): only into an empty business, by the owner, from an uploaded backup or from Google Drive */
const ownerOnly = (c) => { if (c.user.role !== 'owner') throw forbidden('Only the business owner can restore a backup.'); };
router.add('GET', '/api/restore/check', async (c) => json({ empty: await isEmptyOrg(c.db, c.org.id) }));
router.add('POST', '/api/restore', async (c) => { ownerOnly(c); return json(await restoreBackup(c, c.body)); }, { bodyMax: 30e6 });
router.add('GET', '/api/gdrive/backups', async (c) => { ownerOnly(c); return json({ files: await listDriveBackups(c.env, c.org.id) }); });
router.add('POST', '/api/restore/drive', async (c) => {
  ownerOnly(c);
  if (!(await isEmptyOrg(c.db, c.org.id))) throw bad('Restore works only in a new, empty business. Make a new SmartTrader account, then restore the backup there.');
  return json(await restoreBackup(c, await readDriveBackup(c.env, c.org.id, c.body.file_id)));
});

/* ======================================================================= plan & billing (SaaS) */
router.add('GET', '/api/plan', async (c) => json({
  plan: planOut(c.org), usage: await usage(c.db, c.org),
  plans: Object.entries(PLANS).map(([k, p]) => ({ key: k, ...p, invoices_per_month: p.invoices_per_month === Infinity ? null : p.invoices_per_month,
    users: p.users === Infinity ? null : p.users, warehouses: p.warehouses === Infinity ? null : p.warehouses, pay: p.price ? grossPaise(k) / 100 : 0 })),
  billing: billingMode(c.env), razorpay: razorpayMode(c.env), history: canView(c.user, 'settings') ? await billingHistory(c) : [], support_whatsapp: c.env.SUPPORT_WHATSAPP || '',
}));
/* Online payment (DocBrisk Pay UPI; Razorpay optional): see src/billing.js */
router.add('POST', '/api/billing/start', async (c) => { requireCan(c.user, 'settings'); await rateLimit(c.env, 'pay:' + c.org.id, 20, 3600); return json(await billingStart(c)); });
router.add('POST', '/api/billing/verify', async (c) => json(await billingVerify(c)));
router.add('GET', '/api/billing/status', async (c) => json(await billingStatus(c)));
router.add('POST', '/api/billing/webhook', async (c) => json(await billingWebhook(c)), { public: true, webhook: true });
router.add('POST', '/api/billing/upi-callback', async (c) => json(await billingUpiCallback(c)), { public: true, webhook: true });
router.add('POST', '/api/billing/upi-claim', async (c) => { requireCan(c.user, 'settings'); await rateLimit(c.env, 'upiclaim:' + c.org.id, 20, 3600); return json(await billingUpiClaim(c)); });
router.add('POST', '/api/billing/upi-cancel', async (c) => { requireCan(c.user, 'settings'); return json(await billingUpiCancel(c)); });

/* Admin (the person who runs this deployment): header X-Admin-Key must equal the ADMIN_KEY secret. */
async function requireAdmin(c) {
  const key = adminKey(c.env);
  if (!key) throw new HttpError(404, 'Admin is switched off. Add an ADMIN_KEY secret (16+ characters) to the worker to use it.');
  await rateLimit(c.env, 'admin:' + (clientIp(c)), 60, 600);
  if (!sameText(c.request.headers.get('X-Admin-Key') || '', key)) throw new HttpError(401, 'Wrong admin key.');
}
router.add('GET', '/api/admin/orgs', async (c) => {
  await requireAdmin(c);
  const { results } = await c.db.prepare(`SELECT o.id, o.name, o.gstin, o.state, o.phone, o.plan, o.plan_until, o.created_at,
      (SELECT email FROM users WHERE org_id = o.id AND role = 'owner' LIMIT 1) AS owner,
      (SELECT COUNT(*) FROM users WHERE org_id = o.id AND active = 1) AS users,
      (SELECT COUNT(*) FROM docs WHERE org_id = o.id AND type = 'INV') AS invoices,
      (SELECT MAX(at) FROM audit WHERE org_id = o.id) AS last_active
    FROM orgs o ORDER BY o.id DESC LIMIT 1000`).all();
  return json({ rows: results.map((o) => ({ ...o, effective: planOut(o).key })), plans: Object.keys(PLANS) });
}, { public: true });
router.add('POST', '/api/admin/orgs/:id/plan', async (c) => {
  await requireAdmin(c);
  const org = await c.db.prepare(`SELECT * FROM orgs WHERE id = ?`).bind(+c.params.id).first();
  if (!org) throw notFound('Business not found.');
  const plan = oneOf(c.body.plan, Object.keys(PLANS), 'Plan');
  const until = await extendPlan(c.db, org, plan, int(c.body.months, 'Months', { min: 1, max: 1200, def: 12 }));
  return json({ ok: true, plan, until });
}, { public: true });
router.add('GET', '/api/admin/payments', async (c) => {
  await requireAdmin(c);
  const { results } = await c.db.prepare(`SELECT b.ref, b.plan, b.paise, b.status, b.payment_id, b.method, b.created_at, b.paid_at, b.plan_until, o.name AS business,
      (SELECT email FROM users WHERE id = b.user_id) AS email FROM billing_orders b JOIN orgs o ON o.id = b.org_id
      WHERE b.status != 'created' ORDER BY b.id DESC LIMIT 300`).all();
  return json({ rows: results.map((r) => ({ ...r, amount: r.paise / 100 })), mode: billingMode(c.env), razorpay: razorpayMode(c.env) });
}, { public: true });

/* ======================================================================= gate entry (security gate register)
   Inward (GE): every vehicle that arrives is logged before unloading: supplier, vehicle, driver, challan/invoice,
   packages. The goods receipt (GRN) is then made from the gate entry, and the entry closes.
   Outward (GP, gate pass): goods leaving against a delivery note / invoice, with vehicle and exit time. */
const nowTime = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(11, 16);
const geOut = (g) => ({ ...g, value: R(g.value || 0) });      // invoice value read from the e-invoice QR, in rupees
router.add('GET', '/api/gate', async (c) => {
  const q = c.url.searchParams, kind = q.get('kind') === 'out' ? 'out' : 'in';
  const { results } = await c.db.prepare(`SELECT g.*, p.name AS party, r.number AS ref_number, r.type AS ref_type, n.number AS grn_number, b.number AS bill_number
      FROM gate_entries g LEFT JOIN parties p ON p.id = g.party_id LEFT JOIN docs r ON r.id = g.ref_doc_id LEFT JOIN docs n ON n.id = g.grn_id LEFT JOIN docs b ON b.id = g.bill_id AND b.org_id = g.org_id
      WHERE g.org_id = ? AND g.kind = ? AND (? = '' OR g.status = ?) ORDER BY g.date DESC, g.id DESC LIMIT 300`)
    .bind(c.org.id, kind, q.get('status') || '', q.get('status') || '').all();
  return json({ rows: results.map(geOut) });
});
router.add('GET', '/api/gate/:id', async (c) => {
  const g = await c.db.prepare(`SELECT g.*, p.name AS party, r.number AS ref_number, r.type AS ref_type, n.number AS grn_number, b.number AS bill_number FROM gate_entries g
      LEFT JOIN parties p ON p.id = g.party_id LEFT JOIN docs r ON r.id = g.ref_doc_id LEFT JOIN docs n ON n.id = g.grn_id LEFT JOIN docs b ON b.id = g.bill_id AND b.org_id = g.org_id
      WHERE g.id = ? AND g.org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!g) throw notFound('Gate entry not found.');
  return json(geOut(g));
});
const gateWriter = (u) => can(u, 'gate') || can(u, 'stock') || can(u, 'purchase') || can(u, 'sales');
router.add('POST', '/api/gate', async (c) => {
  if (!gateWriter(c.user)) throw forbidden();
  const b = c.body, kind = b.kind === 'out' ? 'out' : 'in';
  let partyId = +b.party_id || null;
  if (partyId && !(await c.db.prepare(`SELECT 1 FROM parties WHERE id = ? AND org_id = ?`).bind(partyId, c.org.id).first())) throw bad('Unknown party.');
  // read from the supplier's e-invoice QR at the gate: the supplier by GSTIN, the IRN (one entry per invoice) and its value
  const gstin = str(b.party_gstin, 15).toUpperCase(), irn = kind === 'in' ? str(b.irn, 64).toLowerCase() : '';
  if (irn && !/^[0-9a-f]{64}$/.test(irn)) throw bad('The IRN read from the QR is not valid.');
  if (!partyId && /^\d{2}[A-Z0-9]{13}$/.test(gstin)) {
    const p = await c.db.prepare(`SELECT id FROM parties WHERE org_id = ? AND UPPER(gstin) = ? AND kind != 'customer' LIMIT 1`).bind(c.org.id, gstin).first();
    if (p) partyId = p.id;
  }
  if (irn) {
    const dup = await c.db.prepare(`SELECT number FROM gate_entries WHERE org_id = ? AND irn = ? AND status != 'rejected' LIMIT 1`).bind(c.org.id, irn).first();
    if (dup) throw bad(`This invoice already came in at the gate: ${dup.number}.`);
  }
  const value = kind === 'in' ? toPaise(num(b.value, 'Invoice value', { min: 0, max: 1e10, def: 0 })) : 0;
  let refId = +b.ref_doc_id || null;
  if (refId) {
    const r = await c.db.prepare(`SELECT type, party_id, status FROM docs WHERE id = ? AND org_id = ?`).bind(refId, c.org.id).first();
    const ok = kind === 'in' ? ['PO'] : ['DN', 'INV', 'PRET'];
    if (!r || !ok.includes(r.type)) throw bad(kind === 'in' ? 'Link a purchase order (optional).' : 'Link a delivery note, invoice or purchase return.');
    if (r.status === 'cancelled') throw bad('That document is cancelled.');
    if (partyId && r.party_id !== partyId) throw bad('The linked document belongs to another party.');
  }
  const vehicle = str(b.vehicle_no, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!vehicle && !b.by_hand) throw bad('Enter the vehicle number (or tick "By hand / courier").');
  const key = kind === 'in' ? 'GE' : 'GP';
  const challan = str(b.challan_no, 40);
  const billId = kind === 'in' && !refId ? await matchBill(c.db, c.org.id, partyId, challan, value) : null;
  const remarks = [str(b.remarks, 300), !partyId && gstin ? `Supplier GSTIN ${gstin}` : ''].filter(Boolean).join(' · ').slice(0, 300);
  await c.db.batch([
    counterStatements(c.db, c.org.id, key),
    c.db.prepare(`INSERT INTO gate_entries (org_id, number, kind, date, time_in, time_out, party_id, ref_doc_id, vehicle_no, driver_name, driver_phone, transporter, lr_no,
        challan_no, challan_date, packages, weight_kg, remarks, status, created_by, created_at, irn, value, bill_id)
      VALUES (?, ${counterValueSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`)
      .bind(c.org.id, key + '-%05d', c.org.id, key, kind, date(b.date), str(b.time_in, 5) || nowTime(), kind === 'out' && b.exited ? nowTime() : '', partyId, refId, vehicle || 'BY HAND',
        str(b.driver_name, 60), str(b.driver_phone, 15), str(b.transporter, 80), str(b.lr_no, 30), challan, b.challan_date ? date(b.challan_date) : '',
        int(b.packages, 'Packages', { min: 0, max: 100000, def: 0 }), num(b.weight_kg, 'Weight', { min: 0, max: 1e7, def: 0 }), remarks,
        c.user.id, nowIso(), irn, value, billId),
  ]);
  const g = await c.db.prepare(`SELECT * FROM gate_entries WHERE org_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`).bind(c.org.id, kind).first();
  if (kind === 'out' && b.exited) await c.db.prepare(`UPDATE gate_entries SET status = 'closed' WHERE id = ?`).bind(g.id).run();
  await c.db.batch([auditStatement(c, `gate ${kind}`, `${g.number} ${g.vehicle_no}`)]);
  return json(g);
});
/* exit time, reject at gate (goods sent back unloaded), or close */
router.add('POST', '/api/gate/:id/:action', async (c) => {
  if (!gateWriter(c.user)) throw forbidden();
  const action = oneOf(c.params.action, ['exit', 'reject', 'close'], 'Action');
  const g = await c.db.prepare(`SELECT * FROM gate_entries WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!g) throw notFound('Gate entry not found.');
  if (action === 'exit') {
    await c.db.prepare(`UPDATE gate_entries SET time_out = ?, status = CASE WHEN status = 'open' AND kind = 'out' THEN 'closed' ELSE status END WHERE id = ?`).bind(str(c.body.time, 5) || nowTime(), g.id).run();
  } else {
    if (g.status !== 'open') throw bad(`${g.number} is already ${g.status === 'grn_done' ? 'received' : g.status}.`);
    await c.db.prepare(`UPDATE gate_entries SET status = ?, remarks = TRIM(remarks || ' ' || ?), time_out = CASE WHEN time_out = '' THEN ? ELSE time_out END WHERE id = ?`)
      .bind(action === 'reject' ? 'rejected' : 'closed', str(c.body.reason, 200), nowTime(), g.id).run();
  }
  await c.db.batch([auditStatement(c, `gate ${action}`, g.number)]);
  return json({ ok: true });
});

/* ======================================================================= pending work (what is stuck where) */
router.add('GET', '/api/reports/pending', async (c) => {
  const buy = canView(c.user, 'purchase'), sell = canView(c.user, 'sales');      // purchase side: PO, GRN, gate; sales side: SO, DN, quotes
  const lines = async (type) => (await c.db.prepare(`SELECT d.id, d.number, d.date, d.due_date, p.name AS party, i.name AS item, i.unit, l.qty, l.done_qty, ROUND(l.qty - l.done_qty, 3) AS pending
      FROM docs d JOIN doc_lines l ON l.doc_id = d.id LEFT JOIN items i ON i.id = l.item_id LEFT JOIN parties p ON p.id = d.party_id
      WHERE d.org_id = ? AND d.type = ? AND d.status IN ('open','partial') AND l.qty - l.done_qty > 0.0005 ORDER BY d.date, d.id LIMIT 500`).bind(c.org.id, type).all()).results;
  const docs = async (type) => (await c.db.prepare(`SELECT d.id, d.number, d.date, d.total, p.name AS party FROM docs d LEFT JOIN parties p ON p.id = d.party_id
      WHERE d.org_id = ? AND d.type = ? AND d.status IN ('open','partial') ORDER BY d.date LIMIT 300`).bind(c.org.id, type).all()).results
    .map((r) => ({ ...r, total: R(r.total) }));
  const none = async () => [];
  const [so, po, dn, grn, quotes, gate] = await Promise.all([sell ? lines('SO') : none(), buy ? lines('PO') : none(), sell ? docs('DN') : none(), buy ? docs('GRN') : none(), sell ? docs('QUOTE') : none(),
    buy ? c.db.prepare(`SELECT g.id, g.number, g.date, g.time_in, g.vehicle_no, g.challan_no, p.name AS party FROM gate_entries g LEFT JOIN parties p ON p.id = g.party_id
      WHERE g.org_id = ? AND g.kind = 'in' AND g.status = 'open' ORDER BY g.date, g.id`).bind(c.org.id).all().then((r) => r.results) : none()]);
  return json({ to_deliver: so, to_receive: po, to_invoice: dn, to_bill: grn, open_quotes: quotes, at_gate: gate });
});

/* ======================================================================= vasooli (collections): see src/vasooli.js */
router.add('GET', '/api/vasooli', async (c) => {
  requireCan(c.user, 'sales');
  const money = can(c.user, 'finance');          // the week and who collected what: owner, admin, accountant
  const [rows, sum, conf] = await Promise.all([vasooliQueue(c), money ? vasooliSummary(c) : null, listConfirmations(c)]);
  return json({ today: today(), queue: rows, summary: sum, confirmations: conf, msme: !!c.org.udyam, lang: cleanLang(c.org.msg_lang) });
});
router.add('POST', '/api/vasooli/:party/sent', async (c) => json(await logReminder(c, +c.params.party, c.body)));
router.add('GET', '/api/vasooli/report', async (c) => {
  requireCan(c.user, 'finance');
  const lang = cleanLang(c.url.searchParams.get('lang'), cleanLang(c.org.msg_lang)), s = await vasooliSummary(c);
  return json({ lang, ...sendLinks(c.org.phone, summaryText(c.org, s, lang)), summary: s });
});
/* monthly balance confirmation: the buyer answers on /c/<token> */
router.add('POST', '/api/parties/:id/confirm', async (c) => {
  requireCan(c.user, 'sales');
  const lang = c.url.searchParams.get('lang') || c.body.lang;
  if (LANGS.includes(lang)) await c.db.prepare(`UPDATE parties SET lang = ? WHERE id = ? AND org_id = ?`).bind(lang, +c.params.id, c.org.id).run();
  return json(await makeConfirmation(c, +c.params.id, LANGS.includes(lang) ? lang : ''));
});
router.add('POST', '/api/vasooli/confirm/:id/sent', async (c) => {
  requireCan(c.user, 'sales');
  const r = await c.db.prepare(`UPDATE confirmations SET sent_via = ?, sent_at = ? WHERE id = ? AND org_id = ?`).bind(c.body.via === 'sms' ? 'sms' : 'whatsapp', nowIso(), +c.params.id, c.org.id).run();
  if (!r.meta.changes) throw notFound('Not found.');
  return json({ ok: true });
});
router.add('GET', '/api/public/confirm/:token', async (c) => {
  await rateLimit(c.env, 'cview:' + clientIp(c), 120, 600);
  if (!/^[0-9a-f]{24}$/.test(c.params.token)) throw notFound('This link is not valid any more.');
  return json(await publicConfirmation(c, c.params.token));
}, { public: true });
router.add('POST', '/api/public/confirm/:token', async (c) => {
  await rateLimit(c.env, 'cans:' + clientIp(c), 20, 600);
  if (!/^[0-9a-f]{24}$/.test(c.params.token)) throw notFound('This link is not valid any more.');
  return json(await answerConfirmation(c, c.params.token, c.body));
}, { public: true });
/* the customer's receipt on WhatsApp, right after the payment is saved (by the owner or a salesperson) */
router.add('GET', '/api/payments/:id/message', async (c) => {
  if (!can(c.user, 'sales') && !can(c.user, 'finance')) throw forbidden();
  const lang = c.url.searchParams.get('lang');
  if (LANGS.includes(lang)) await c.db.prepare(`UPDATE parties SET lang = ? WHERE org_id = ? AND id = (SELECT party_id FROM payments WHERE id = ? AND org_id = ?)`)
    .bind(lang, c.org.id, +c.params.id, c.org.id).run();
  return json(await receiptMessage(c, +c.params.id, LANGS.includes(lang) ? lang : ''));
});
/* MSMED interest, notice draft and the evidence for one buyer */
router.add('GET', '/api/parties/:id/recovery', async (c) => {
  requireCan(c.user, 'finance');
  const rate = Number(c.url.searchParams.get('rate'));
  return json(await recoveryFile(c, +c.params.id, Number.isFinite(rate) && rate > 0 && rate < 30 ? rate : 0));
});

/* Payment reminder for invoice dues (the khata has its own): overdue invoices, total and UPI, for WhatsApp/SMS. */
router.add('GET', '/api/parties/:id/reminder', async (c) => {
  const p = await c.db.prepare(`SELECT id, name, phone, lang, vip FROM parties WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!p) throw notFound('Party not found.');
  const { results } = await c.db.prepare(`SELECT id, number, date, COALESCE(due_date, date) AS due_date, total - paid AS bal FROM docs WHERE org_id = ? AND party_id = ? AND type = 'INV'
      AND status IN ('unpaid','partial') ORDER BY due_date, id`).bind(c.org.id, p.id).all();
  const due = results.reduce((t, r) => t + r.bal, 0);
  if (!due) throw bad(`${p.name} has no unpaid invoices.`);
  const lang = await langFor(c, p), L = phrases(lang);
  // how firm: from the oldest bill's lateness (the reminder schedule's step), softer for a VIP buyer
  const late = Math.round((Date.parse(today()) - Date.parse(results[0].due_date)) / 864e5), step = stepFor(late), tone = toneFor(step, p.vip);
  const link = withLang(`${c.url.origin}/i/${await shareToken(c, results[0].id)}`, lang);
  const v = await vaadaReminder(c, p.id, 'inv', L);
  const listW = results.slice(0, 8).map((r) => `• ${r.number} (${fd(r.date)}): ${inrW(r.bal)}`).join('\n') + (results.length > 8 ? `\n${L.more(results.length - 8)}` : '');
  const firm = tone === 'late30' || tone === 'final';
  const wa = [`*${c.org.name}*`, L.remTitle, '', L.hello(p.name), L.tone[tone], listW, '', `${L.totalDue}: *${inrW(due)}*`,
    ...(c.org.upi_id ? [`UPI: ${c.org.upi_id}`] : []), '', ...(firm && c.org.udyam ? [L.msme(c.org.udyam), ''] : []), ...(tone === 'final' ? [L.finalAsk, ''] : []),
    ...(v ? [...v.wa, ''] : []), c.org.upi_id ? L.viewBillPay : L.viewBill, link, '', L.sentVia(BRAND)].join('\n');
  const sms = `${L.smsRem(c.org.name, p.name, results.length, rs(due), link)}${v && v.sms ? ' ' + v.sms : ''} -${BRAND}`;
  return json({ party: p.name, due: R(due), invoices: results.length, lang, step, tone, vip: !!p.vip, ...sendLinks(p.phone, wa, sms) });
});

/* ======================================================================= payments, expenses, journals */
router.add('GET', '/api/payments', async (c) => {
  const q = c.url.searchParams;
  const { results } = await c.db.prepare(`SELECT p.*, pt.name AS party, a.name AS account FROM payments p JOIN parties pt ON pt.id = p.party_id
      JOIN accounts a ON a.id = p.account_id WHERE p.org_id = ? AND (? = '' OR p.kind = ?) ORDER BY p.date DESC, p.id DESC LIMIT 300`)
    .bind(c.org.id, q.get('kind') || '', q.get('kind') || '').all();
  return json({ rows: results.map((p) => ({ ...p, amount: R(p.amount), void: (p.notes || '').startsWith('[void]') })) });
});
router.add('GET', '/api/payments/open', async (c) => {
  const q = c.url.searchParams;
  const { results } = await c.db.prepare(`SELECT id, number, date, due_date, total, paid FROM docs WHERE org_id = ? AND party_id = ? AND type = ?
      AND status IN ('unpaid','partial') ORDER BY due_date, id`).bind(c.org.id, +q.get('party_id') || 0, q.get('kind') === 'payment' ? 'BILL' : 'INV').all();
  return json({ rows: results.map((d) => ({ ...d, total: R(d.total), balance: R(d.total - d.paid) })) });
});
router.add('POST', '/api/payments', async (c) => json(await createPayment(c, c.body)));
router.add('POST', '/api/payments/:id/void', async (c) => { await voidPayment(c, +c.params.id); return json({ ok: true }); });
router.add('POST', '/api/expenses', async (c) => json(await createExpense(c, c.body)));
router.add('POST', '/api/journals', async (c) => json(await createJournal(c, c.body)));
router.add('POST', '/api/stock/adjust', async (c) => json(await stockAdjust(c, c.body)));
router.add('POST', '/api/stock/count', async (c) => json(await stockCount(c, c.body)));
router.add('POST', '/api/stock/transfer', async (c) => json(await stockTransfer(c, c.body)));

/* ======================================================================= khata (Khatabook-style credit book)
   Trust rules: a new entry stays PENDING and does not count until it has been sent to the customer on
   WhatsApp or SMS. Sent entries can never be edited or deleted, only reversed by a new (also sent) entry.
   Every message carries a private link where the customer sees their full khata and can confirm or dispute
   each entry, so neither side can quietly change the record. */
const KHATA_BAL = `COALESCE(SUM(CASE WHEN k.status = 'sent' THEN (CASE WHEN k.kind = 'gave' THEN k.amount ELSE -k.amount END) ELSE 0 END), 0)`;

async function khataToken(c, partyId, create = true) {
  const p = await c.db.prepare(`SELECT khata_token FROM parties WHERE id = ? AND org_id = ?`).bind(partyId, c.org.id).first();
  if (!p) throw notFound('Contact not found.');
  if (p.khata_token) return p.khata_token;
  if (!create) return '';
  requireCan(c.user, 'khata');          // only roles that may write the khata can publish its link
  const t = randomHex(12);
  await c.db.prepare(`UPDATE parties SET khata_token = ? WHERE id = ? AND org_id = ? AND (khata_token IS NULL OR khata_token = '')`).bind(t, partyId, c.org.id).run();
  return (await c.db.prepare(`SELECT khata_token FROM parties WHERE id = ? AND org_id = ?`).bind(partyId, c.org.id).first()).khata_token;
}
async function khataBalance(c, partyId) {
  return (await c.db.prepare(`SELECT ${KHATA_BAL} AS b FROM khata k WHERE k.party_id = ?`).bind(partyId).first()).b;
}
const khataLink = async (c, partyId, create = true) => { const t = await khataToken(c, partyId, create); return t ? `${c.url.origin}/k/${t}` : ''; };
/* The messages for one entry, with the balance it makes once sent. */
const entrySend = (p, [wa, sms, lang]) => ({ lang, ...sendLinks(p.phone, wa, sms) });
async function entryMessage(c, e, p) {
  const after = (await khataBalance(c, p.id)) + (e.status === 'sent' ? 0 : (e.kind === 'gave' ? e.amount : -e.amount));
  const lang = await langFor(c, p), L = phrases(lang);
  const link = withLang(await khataLink(c, p.id), lang);
  const balW = after > 0 ? `${L.totalDue}: *${inrW(after)}*` : after < 0 ? `${L.advance}: *${inrW(-after)}*` : L.clear;
  const wa = [
    `*${c.org.name}*`,
    `${L.khEntry} · ${fd(e.date)}`,
    '',
    e.kind === 'gave' ? `${L.gave}: *${inrW(e.amount)}*` : `${L.got}: *${inrW(e.amount)}* ✅`,
    ...(e.note ? [`${L.note}: ${e.note}`] : []),
    balW,
    '',
    L.khSee,
    link,
    '',
    L.sentVia(BRAND),
  ].join('\n');
  const balS = after > 0 ? `${L.totalDue} ${rs(after)}` : after < 0 ? `${L.advance} ${rs(-after)}` : L.clear.replace(' ✅', '');
  const sms = `${L.smsKhEntry(c.org.name, e.kind === 'gave' ? L.gave : L.got, rs(e.amount), e.note, fd(e.date), balS, link)} -${BRAND}`;
  return [wa, sms, lang];
}

router.add('GET', '/api/khata', async (c) => {
  const { results } = await c.db.prepare(`SELECT p.id, p.name, p.phone, p.kind, p.lang, ${KHATA_BAL} AS balance,
        MAX(CASE WHEN k.status = 'sent' THEN k.date END) AS last_date, SUM(k.status = 'sent') AS entries, SUM(k.status = 'pending') AS pending,
        SUM(k.ack = 'disputed') AS disputed
      FROM parties p LEFT JOIN khata k ON k.party_id = p.id WHERE p.org_id = ? GROUP BY p.id
      HAVING COUNT(k.id) > 0 OR ? = '1' ORDER BY pending DESC, last_date DESC, p.name`).bind(c.org.id, c.url.searchParams.get('all') ? '1' : '0').all();
  const get = results.filter((r) => r.balance > 0).reduce((s, r) => s + r.balance, 0);
  const give = results.filter((r) => r.balance < 0).reduce((s, r) => s - r.balance, 0);
  return json({ rows: results.map((r) => ({ ...r, balance: R(r.balance) })), you_will_get: R(get), you_will_give: R(give) });
});
/* Creates a PENDING entry and returns the message to send. It counts only after /send. */
router.add('POST', '/api/khata', async (c) => {
  requireCan(c.user, 'khata');
  const b = c.body;
  let partyId = +b.party_id || 0;
  if (!partyId) {                                     // quick add a new contact from the khata screen
    const name = reqStr(b.name, 'Name', 120);
    const ex = await c.db.prepare(`SELECT id FROM parties WHERE org_id = ? AND name = ?`).bind(c.org.id, name).first();
    partyId = ex ? ex.id : (await c.db.prepare(`INSERT INTO parties (org_id, name, kind, phone, created_at) VALUES (?, ?, 'customer', ?, ?) RETURNING id`)
      .bind(c.org.id, name, str(b.phone, 20), nowIso()).first()).id;
    if (ex && b.phone) await c.db.prepare(`UPDATE parties SET phone = ? WHERE id = ? AND phone = ''`).bind(str(b.phone, 20), ex.id).run();
  }
  const p = await c.db.prepare(`SELECT id, name, phone, lang FROM parties WHERE id = ? AND org_id = ?`).bind(partyId, c.org.id).first();
  if (!p) throw bad('Unknown contact.');
  const kind = oneOf(b.kind, ['gave', 'got'], 'Entry type');
  const amount = toPaise(num(b.amount, 'Amount', { min: 0.01 }));
  const e = await c.db.prepare(`INSERT INTO khata (org_id, party_id, date, kind, amount, note, created_by, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING *`)
    .bind(c.org.id, partyId, date(b.date), kind, amount, str(b.note, 200), c.user.id, nowIso()).first();
  return json({ ok: true, party_id: partyId, entry_id: e.id, phone: p.phone, ...entrySend(p, await entryMessage(c, e, p)) });
});
router.add('GET', '/api/khata/entries/:id/message', async (c) => {
  const e = await c.db.prepare(`SELECT * FROM khata WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!e) throw notFound('Entry not found.');
  const p = await c.db.prepare(`SELECT id, name, phone, lang FROM parties WHERE id = ? AND org_id = ?`).bind(e.party_id, c.org.id).first();
  return json({ entry_id: e.id, status: e.status, phone: p.phone, ...entrySend(p, await entryMessage(c, e, p)) });
});
/* Called when the user taps Send on WhatsApp / SMS: from now on the entry is part of the khata. */
router.add('POST', '/api/khata/entries/:id/send', async (c) => {
  requireCan(c.user, 'khata');
  const via = oneOf(c.body.via, ['whatsapp', 'sms'], 'Sent via');
  const r = await c.db.prepare(`UPDATE khata SET status = 'sent', sent_at = ?, sent_via = ? WHERE id = ? AND org_id = ? AND status = 'pending'`)
    .bind(nowIso(), via, +c.params.id, c.org.id).run();
  if (!r.meta.changes) {
    const e = await c.db.prepare(`SELECT status FROM khata WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
    if (!e) throw notFound('Entry not found.');
  }
  return json({ ok: true });
});
router.add('GET', '/api/khata/:party', async (c) => {
  const p = await c.db.prepare(`SELECT id, name, phone, lang FROM parties WHERE id = ? AND org_id = ?`).bind(+c.params.party, c.org.id).first();
  if (!p) throw notFound('Contact not found.');
  const { results } = await c.db.prepare(`SELECT id, date, kind, amount, note, status, sent_at, sent_via, ack, ack_at, ack_note, reverses
      FROM khata WHERE org_id = ? AND party_id = ? ORDER BY date, id`).bind(c.org.id, p.id).all();
  let bal = 0;
  const rows = results.map((r) => ({ ...r, amount: R(r.amount), balance: R(r.status === 'sent' ? (bal += r.kind === 'gave' ? r.amount : -r.amount) : bal) }));
  return json({ party: p, rows: rows.reverse(), balance: R(bal), statement_url: await khataLink(c, p.id, can(c.user, 'khata')) });
});
/* Pending (never sent) entries can be discarded. Sent entries are permanent: reverse them instead. */
router.add('DELETE', '/api/khata/entries/:id', async (c) => {
  requireCan(c.user, 'khata');
  const e = await c.db.prepare(`SELECT status FROM khata WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!e) throw notFound('Entry not found.');
  if (e.status !== 'pending') throw bad('This entry was already sent to the customer, so it cannot be deleted. Use Reverse to cancel it with a new entry.');
  await c.db.prepare(`DELETE FROM khata WHERE id = ? AND status = 'pending'`).bind(+c.params.id).run();
  return json({ ok: true });
});
router.add('POST', '/api/khata/entries/:id/reverse', async (c) => {
  requireCan(c.user, 'khata');
  requireCancel(c.user);
  const e = await c.db.prepare(`SELECT * FROM khata WHERE id = ? AND org_id = ?`).bind(+c.params.id, c.org.id).first();
  if (!e) throw notFound('Entry not found.');
  if (e.status !== 'sent') throw bad('Only sent entries can be reversed. A pending entry can simply be discarded.');
  if (await c.db.prepare(`SELECT 1 FROM khata WHERE reverses = ?`).bind(e.id).first()) throw bad('This entry has already been reversed.');
  const p = await c.db.prepare(`SELECT id, name, phone, lang FROM parties WHERE id = ? AND org_id = ?`).bind(e.party_id, c.org.id).first();
  const r = await c.db.prepare(`INSERT INTO khata (org_id, party_id, date, kind, amount, note, created_by, created_at, status, reverses)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING *`)
    .bind(c.org.id, e.party_id, today(), e.kind === 'gave' ? 'got' : 'gave', e.amount, `Correction of entry dated ${fd(e.date)}${c.body.reason ? ': ' + str(c.body.reason, 120) : ''}`,
      c.user.id, nowIso(), e.id).first();
  return json({ ok: true, entry_id: r.id, phone: p.phone, ...entrySend(p, await entryMessage(c, r, p)) });
});
router.add('GET', '/api/khata/:party/reminder', async (c) => {
  const p = await c.db.prepare(`SELECT id, name, phone, lang FROM parties WHERE id = ? AND org_id = ?`).bind(+c.params.party, c.org.id).first();
  if (!p) throw notFound('Contact not found.');
  const bal = await khataBalance(c, p.id), amt = R(bal);
  const lang = await langFor(c, p), L = phrases(lang);
  const link = withLang(await khataLink(c, p.id), lang);
  const upi = c.org.upi_id && amt > 0 ? `upi://pay?pa=${encodeURIComponent(c.org.upi_id).replace(/%40/g, '@')}&pn=${encodeURIComponent(c.org.name)}&am=${amt.toFixed(2)}&cu=INR` : '';
  const v = bal > 0 ? await vaadaReminder(c, p.id, 'khata', L) : null;
  const wa = bal > 0
    ? [`*${c.org.name}*`, L.remTitle, '', L.hello(p.name), `${L.yourDue}: *${inrW(bal)}*`, L.payPlease, ...(c.org.upi_id ? [`UPI: ${c.org.upi_id}`] : []),
      '', ...(v ? [...v.wa, ''] : []), c.org.upi_id ? L.khSeePay : L.khSeeAll, link, '', L.sentVia(BRAND)].join('\n')
    : [`*${c.org.name}*`, '', L.clearHello(p.name), L.thanks, '', link, '', L.sentVia(BRAND)].join('\n');
  const sms = `${bal > 0 ? L.smsKhRem(c.org.name, p.name, rs(bal), link) : L.smsKhClear(c.org.name, p.name, link)}${v && v.sms ? ' ' + v.sms : ''} -${BRAND}`;
  return json({ lang, ...sendLinks(p.phone, wa, sms), upi_url: upi });
});

/* ---------- the customer's side: a private, read-only statement link (no login) ---------- */
async function khataByToken(c) {
  const t = String(c.params.token || '');
  if (!/^[0-9a-f]{24}$/.test(t)) throw notFound('This khata link is not valid.');
  const p = await c.db.prepare(`SELECT p.id, p.name, p.org_id, o.name AS org_name, o.phone AS org_phone, o.upi_id, o.address AS org_address,
        o.vaada, o.plan, o.plan_until FROM parties p JOIN orgs o ON o.id = p.org_id WHERE p.khata_token = ?`).bind(t).first();
  if (!p) throw notFound('This khata link is not valid.');
  return p;
}
router.add('GET', '/api/public/khata/:token', async (c) => {
  await rateLimit(c.env, 'kview:' + (clientIp(c)), 120, 600);
  const p = await khataByToken(c);
  const { results } = await c.db.prepare(`SELECT id, date, kind, amount, note, sent_at, ack, ack_at FROM khata
      WHERE party_id = ? AND status = 'sent' ORDER BY date, id`).bind(p.id).all();
  let bal = 0;
  const rows = results.map((r) => ({ ...r, amount: R(r.amount), balance: R(bal += r.kind === 'gave' ? r.amount : -r.amount) })).reverse();
  const vaada = await publicVaada(c, khataOrg(p), p.id, 'khata');
  return json({ shop: { name: p.org_name, phone: p.org_phone, upi_id: p.upi_id, address: p.org_address }, customer: p.name, balance: R(bal), rows, vaada });
}, { public: true });
router.add('POST', '/api/public/khata/:token/ack', async (c) => {
  await rateLimit(c.env, 'kack:' + (clientIp(c)), 60, 600);
  const p = await khataByToken(c);
  const ack = oneOf(c.body.ack, ['confirmed', 'disputed'], 'Answer');
  const r = await c.db.prepare(`UPDATE khata SET ack = ?, ack_at = ?, ack_note = ? WHERE id = ? AND party_id = ? AND status = 'sent'`)
    .bind(ack, nowIso(), str(c.body.note, 200), +c.body.entry_id || 0, p.id).run();
  if (!r.meta.changes) throw notFound('Entry not found.');
  return json({ ok: true });
}, { public: true });

/* ======================================================================= Vaada Pakka: payment promises
   The customer picks a pay date or instalments on their own khata / invoice link (or the shop writes down a promise
   made on the phone). Each instalment becomes kept or broken from the receipts when a screen is opened (no cron):
   receipts are never edited silently (void and reverse only), so the record is fair to both sides. Data stays with
   the shop: never shared across businesses, never called a score. Algorithms: src/vaada.js. */
const VAADA_429 = 'Aaj bahut baar koshish hui. Kal dobara try karein.';
async function limitHi(c, key, max, win, msg = VAADA_429) {
  try { await rateLimit(c.env, key, max, win); } catch (e) { if (e instanceof HttpError && e.status === 429) throw new HttpError(429, msg); throw e; }
}
const dueSql = (book) => book === 'inv'
  ? `SELECT COALESCE(SUM(total - paid), 0) AS due FROM docs WHERE org_id = ? AND party_id = ? AND type = 'INV' AND status IN ('unpaid','partial')`
  : `SELECT ${KHATA_BAL} AS due FROM khata k WHERE k.org_id = ? AND k.party_id = ?`;
const khataOrg = (p) => ({ id: p.org_id, name: p.org_name, phone: p.org_phone, vaada: p.vaada, plan: p.plan, plan_until: p.plan_until });
const bookSeen = (u) => ({ khata: canView(u, 'khata'), inv: canView(u, 'sales') || canView(u, 'finance') });

/* read a set of promises (one D1 call, plus `extra` statements in the same batch), evaluate, write back the changes (≤ 1 call) */
async function vaadaSet(c, orgId, o, extra = []) {
  const res = await c.db.batch([...setStatements(c.db, { orgId, today: o.today, partyId: o.partyId, book: o.book }), ...extra]);
  const ev = evalSet(res.slice(0, 6), o.today, o.s.grace);
  const wb = writeBackStatements(c.db, orgId, o.today, ev.diffs, ev.doneIds);
  if (wb.length) await c.db.batch(wb);
  return { ...ev, extra: res.slice(6) };
}

/* the `vaada` block of the customer's khata / invoice link */
async function publicVaada(c, org, partyId, book) {
  try {
    const s = cleanVaada(org.vaada), t = today();
    if (!s.on) return { enabled: false, book };
    const set = await vaadaSet(c, org.id, { today: t, partyId, book, s }, [
      c.db.prepare(dueSql(book)).bind(org.id, partyId),
      c.db.prepare(`SELECT COUNT(*) AS n FROM vaade WHERE org_id = ? AND status = 'open'`).bind(org.id)]);
    const due = Math.max(0, set.extra[0].results[0].due || 0), openN = set.extra[1].results[0].n;
    const open = set.list.find((p) => p.status === 'open' && p.book === book) || null;
    const feat = hasFeature(org, 'vaada');
    // a gated option is simply not offered: no upgrade text ever reaches the customer
    const enabled = (due > 0 || !!open) && (feat || openN < FREE_OPEN_MAX || !!open);
    return { enabled, book, due: R(due), today: t, open: open ? promiseOut(open) : null,
      options: { max_date: addDays(t, s.max_days), min_amount: R(s.part ? minPart(due, s) : due), part: s.part, plans: feat && due > 0 ? planOptions(due, s, t) : [] } };
  } catch (e) {
    console.error(e && e.stack || e);
    return { enabled: false, book };     // never break the customer's link
  }
}

/* create (or replace) the open promise of a party in one book. by: 'customer' (link) | 'shop' (phone par) */
async function makePromise(c, { org, partyId, partyName, book, docId, by, body }) {
  const s = cleanVaada(org.vaada), t = today(), db = c.db, shop = by === 'shop';
  if (!s.on) throw notFound(shop ? 'Vaade band hain. Settings mein chalu karein.' : 'Ye link sahi nahi hai.');
  const kind = body.kind;
  if (kind !== 'date' && kind !== 'plan') throw bad('Tareekh ya kisht chunein.');
  const feat = hasFeature(org, 'vaada');
  if (kind === 'plan' && !feat) throw new HttpError(402, shop ? 'Kisht ke liye Starter plan lein (Settings → Plan & billing).' : 'Kisht ka option abhi nahi hai. Shop se baat karein.', { upgrade: shop });
  const [dueR, openR, kR, cntR] = await db.batch([
    db.prepare(dueSql(book)).bind(org.id, partyId),
    db.prepare(`SELECT * FROM vaade WHERE org_id = ? AND party_id = ? AND book = ? AND status = 'open'`).bind(org.id, partyId, book),
    db.prepare(`SELECT k.outcome, k.due FROM vaada_kisht k JOIN vaade v ON v.id = k.vaada_id WHERE v.org_id = ? AND v.party_id = ? AND v.book = ? AND v.status = 'open'`).bind(org.id, partyId, book),
    db.prepare(`SELECT COUNT(*) AS n FROM vaade WHERE org_id = ? AND status = 'open'`).bind(org.id)]);
  const due = dueR.results[0].due || 0, old = openR.results[0] || null;
  if (!feat && !old && cntR.results[0].n >= FREE_OPEN_MAX) {
    throw new HttpError(402, shop ? `${FREE_OPEN_MAX} se zyada vaade ke liye Starter plan lein.` : 'Abhi vaada nahi le sakte. Shop se baat karein.', { upgrade: shop });
  }
  if (due <= 0) throw bad('Koi baaki nahi hai.');
  if (old && !shop) {      // the customer may change their own promise once, and only before anything is broken
    const brokenAny = kR.results.some((k) => k.outcome === 'broken' || (!k.outcome && addDays(k.due, s.grace) < t));
    if (old.made_by !== 'customer' || old.changes || brokenAny) throw new HttpError(409, 'Ye vaada pehle hi badla ja chuka hai. Shop se baat karein.');
  }
  let kisht, amount;
  if (kind === 'date') {
    const d = str(body.date, 10), max = addDays(t, s.max_days);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(Date.parse(d + 'T00:00:00Z'))) throw bad('Tareekh chunein.');
    if (d < t) throw bad('Aaj ya aage ki tareekh chunein.');
    if (d > max) throw bad(`Tareekh ${fd(max)} ya usse pehle ki chunein.`);
    if (body.amount === undefined || body.amount === null || body.amount === '') amount = due;
    else {
      const a = Number(body.amount);
      if (!Number.isFinite(a) || a <= 0) throw bad('Rakam sahi likhein.');
      amount = toPaise(a);
    }
    const minAmt = s.part ? minPart(due, s) : due;
    if (amount > due) throw bad(`Baaki se zyada ka vaada nahi ho sakta (${inrW(due)}).`);
    if (amount < minAmt) throw bad(s.part ? `Kam se kam ${inr0(minAmt)} ka vaada karein.` : `Poore ${inrW(due)} ka vaada karein.`);
    kisht = [{ n: 1, d, a: amount }];
  } else {
    const key = str(body.plan, 4);
    if (!s.plans.includes(key)) throw bad('Ye kisht plan abhi chalu nahi hai.');
    amount = due;                                   // instalments always cover the full due
    kisht = splitPlan(due, key, t, s.min_kisht);
  }
  const name = str(body.name, 60), note = shop ? str(body.note, 200) : '';
  if (shop) await limitHi(c, 'vshop:' + org.id, 300, 3600, 'Bahut zyada vaade ek saath. Thodi der baad try karein.');
  else await limitHi(c, `vparty:${org.id}:${partyId}`, 3, 86400);
  const txk = uid(), now = nowIso(), last = kisht[kisht.length - 1].d, changes = old && !shop ? (old.changes || 0) + 1 : 0;
  const st = [];
  if (old) st.push(db.prepare(`UPDATE vaade SET status = 'replaced', closed_on = ? WHERE id = ? AND org_id = ? AND status = 'open'`).bind(t, old.id, org.id));
  st.push(db.prepare(`INSERT INTO vaade (org_id, party_id, book, doc_id, kind, amount, due_at_start, made_on, made_by, user_id, cust_name, note, changes, created_at, txk)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(org.id, partyId, book, docId || null, kind, amount, due, t, by, shop ? c.user.id : null, name, note, changes, now, txk));
  st.push(db.prepare(`INSERT INTO vaada_kisht (vaada_id, org_id, party_id, n, due, amount)
      SELECT (SELECT id FROM vaade WHERE txk = ?), ?, ?, CAST(j.key AS INTEGER) + 1, json_extract(j.value, '$.d'), json_extract(j.value, '$.a') FROM json_each(?) j`)
    .bind(txk, org.id, partyId, JSON.stringify(kisht.map((k) => ({ d: k.d, a: k.a })))));
  st.push(db.prepare(`INSERT INTO audit (org_id, user_id, at, action, detail) VALUES (?, ?, ?, ?, ?)`)
    .bind(org.id, shop ? c.user.id : null, now, `vaada by ${by}`, `${partyName} ${amount / 100} ${kind} ${last}`.slice(0, 300)));
  let res;
  try { res = await db.batch(st); } catch (e) {
    if (/UNIQUE constraint failed: vaade\./.test(String(e && e.message))) throw new HttpError(409, 'Vaada abhi save ho chuka hai. Page refresh karein.');
    throw e;
  }
  let id = ((res[old ? 1 : 0].results || [])[0] || {}).id;
  if (!id) id = (await db.prepare(`SELECT id FROM vaade WHERE txk = ?`).bind(txk).first()).id;
  const p = { id, book, kind, amount, made_on: t, made_by: by, status: 'open', doc_id: docId, cust_name: name, note, changes, paid_since: 0, broken_any: false,
    kisht: kisht.map((k) => ({ n: k.n, due: k.d, amount: k.a, state: t >= k.d ? 'due' : 'upcoming' })) };
  return { vaada: promiseOut(p), kisht, amount, last, due };
}
/* the customer's "tell the shop" WhatsApp link */
function shopWhatsapp(org, r, who, lang = 'hl') {
  const phone = String(org.phone || '').replace(/\D/g, '');
  if (!phone) return '';
  const a = inrW(r.amount), d = fd(r.last), text = {
    en: `Hello, I have promised to pay ${a} to ${org.name} by ${d}. – ${who}`,
    hi: `नमस्ते, मैंने ${org.name} को ${d} तक ${a} देने का वादा किया है। – ${who}`,
  }[lang] || `Namaste, maine ${org.name} ko ${d} tak ${a} dene ka vaada kiya hai. – ${who}`;
  return `https://wa.me/${phone.length === 10 ? '91' + phone : phone}?text=${encodeURIComponent(text)}`;
}
router.add('POST', '/api/public/khata/:token/vaada', async (c) => {
  await limitHi(c, 'vpost:' + clientIp(c), 10, 600);
  const p = await khataByToken(c);
  const org = khataOrg(p);
  const r = await makePromise(c, { org, partyId: p.id, partyName: p.name, book: 'khata', docId: null, by: 'customer', body: c.body });
  return json({ ok: true, vaada: r.vaada, shop_whatsapp_url: shopWhatsapp(org, r, str(c.body.name, 60) || p.name, cleanLang(c.body.lang)) });
}, { public: true });
router.add('POST', '/api/public/doc/:token/vaada', async (c) => {
  await limitHi(c, 'vpost:' + clientIp(c), 10, 600);
  const t = String(c.params.token || '');
  const row = /^[0-9a-f]{24}$/.test(t) ? await c.db.prepare(`SELECT d.id AS doc_id, d.type, d.status, d.party_id, d.org_id, p.name AS party,
      o.name AS org_name, o.phone AS org_phone, o.vaada, o.plan, o.plan_until FROM docs d JOIN parties p ON p.id = d.party_id JOIN orgs o ON o.id = d.org_id
      WHERE d.share_token = ?`).bind(t).first() : null;
  if (!row || row.type !== 'INV' || row.status === 'cancelled') throw notFound('Ye link sahi nahi hai.');
  const org = khataOrg(row);
  const r = await makePromise(c, { org, partyId: row.party_id, partyName: row.party, book: 'inv', docId: row.doc_id, by: 'customer', body: c.body });
  return json({ ok: true, vaada: r.vaada, shop_whatsapp_url: shopWhatsapp(org, r, str(c.body.name, 60) || row.party, cleanLang(c.body.lang)) });
}, { public: true });

/* Reminder lines (§5.4): the tone follows the party's open promise in that book. Read-only. */
async function vaadaReminder(c, partyId, book, L = phrases(c.org.msg_lang)) {
  const s = cleanVaada(c.org.vaada);
  if (!s.on) return null;
  try {
    const t = today();
    const res = await c.db.batch([...setStatements(c.db, { orgId: c.org.id, today: t, partyId, book }),
      c.db.prepare(`SELECT COUNT(*) AS n FROM vaada_kisht WHERE org_id = ? AND party_id = ? AND outcome = 'broken' AND due >= ?`).bind(c.org.id, partyId, addDays(t, -90))]);
    const ev = evalSet(res.slice(0, 6), t, s.grace);
    const p = ev.list.find((x) => x.status === 'open');
    if (!p) return { wa: [L.vPick], sms: '' };
    const b90 = res[6].results[0].n + ev.diffs.filter((d) => d.due >= addDays(t, -90)).reduce((n, d) => n + (d.o === 'broken') - (d.from === 'broken'), 0);
    const br = p.kisht.find((k) => k.state === 'broken'), now = p.kisht.find((k) => k.state === 'due'), up = p.kisht.find((k) => k.state === 'upcoming');
    if (br) {
      const firm = L.vFirm(fd(br.due), inrW(br.amount));
      return { wa: b90 >= s.broken_max ? [firm, L.vStop] : [firm], sms: L.vSmsBroken(fd(br.due)) };
    }
    if (now) return { wa: [L.vToday(inrW(now.amount))], sms: L.vSms(fd(now.due), rs(now.amount)) };
    if (up) return { wa: [L.vUp(fd(up.due), inrW(up.amount))], sms: L.vSms(fd(up.due), rs(up.amount)) };
    return null;
  } catch (e) { console.error(e && e.stack || e); return null; }
}

/* ---------- the shop's side ---------- */
async function vaadaList(c) {
  const s = cleanVaada(c.org.vaada), t = today(), seen = bookSeen(c.user);
  const set = await vaadaSet(c, c.org.id, { today: t, s });
  const tabs = { today: [], upcoming: [], broken: [], all: [] }, soon = addDays(t, 7), since = addDays(t, -30);
  for (const p of set.list) {
    if (!seen[p.book]) continue;
    const st = set.stats.get(p.party_id) || { kept: 0, broken: 0 };
    const base = { id: p.id, party_id: p.party_id, name: p.name, phone: p.phone || '', book: p.book, doc_id: p.doc_id, kind: p.kind, made_by: p.made_by,
      status: p.status, amount: R(p.amount), paid_since: R(p.paid_since), of: p.kisht.length, kept: st.kept, broken: st.broken, pct: pctOf(st) };
    let need = 0;
    for (const k of p.kisht) {
      need += k.amount;
      const row = { ...base, n: k.n, due: k.due, state: k.state, kamount: R(k.amount), due_amount: R(Math.max(0, Math.min(k.amount, need - p.paid_since))) };
      if (p.status === 'open' && k.state === 'due') tabs.today.push(row);
      else if (p.status === 'open' && k.state === 'upcoming' && k.due <= soon) tabs.upcoming.push(row);
      else if (k.state === 'broken' && (p.status === 'open' || (k.settled_on && k.settled_on >= since))) tabs.broken.push(row);
    }
    const cur = p.kisht.find((k) => k.state !== 'kept') || p.kisht[p.kisht.length - 1];
    tabs.all.push({ ...base, n: cur.n, due: cur.due, state: p.status === 'done' ? 'done' : cur.state, kamount: R(cur.amount), due_amount: R(Math.max(0, p.amount - p.paid_since)) });
  }
  const asc = (a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.id - b.id);
  tabs.today.sort((a, b) => b.due_amount - a.due_amount || asc(a, b));
  tabs.upcoming.sort(asc); tabs.broken.sort(asc);
  tabs.all.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || asc(a, b));
  const openN = set.list.filter((p) => p.status === 'open').length;
  const summary = { today_n: tabs.today.length, today_amount: R(tabs.today.reduce((x, r) => x + Math.round(r.due_amount * 100), 0)), upcoming_n: tabs.upcoming.length,
    broken_n: tabs.broken.length, open_n: openN, free_cap: !hasFeature(c.org, 'vaada') && openN >= FREE_OPEN_MAX };
  return { tabs, summary };
}
router.add('GET', '/api/vaade', async (c) => {
  const v = c.url.searchParams.get('view');
  const view = ['today', 'upcoming', 'broken', 'all'].includes(v) ? v : 'today';
  const L = await vaadaList(c);
  return json({ view, rows: L.tabs[view], counts: { today: L.tabs.today.length, upcoming: L.tabs.upcoming.length, broken: L.tabs.broken.length, all: L.tabs.all.length }, summary: L.summary });
});
router.add('GET', '/api/vaade/summary', async (c) => json((await vaadaList(c)).summary));
router.add('GET', '/api/vaade/party/:id', async (c) => {
  const id = +c.params.id || 0, s = cleanVaada(c.org.vaada), t = today();
  const set = await vaadaSet(c, c.org.id, { today: t, partyId: id, s }, [
    c.db.prepare(`SELECT id, name, phone FROM parties WHERE id = ? AND org_id = ?`).bind(id, c.org.id),
    c.db.prepare(`SELECT ${KHATA_BAL} AS b FROM khata k WHERE k.org_id = ? AND k.party_id = ?`).bind(c.org.id, id),
    c.db.prepare(`SELECT COUNT(*) AS n FROM vaada_kisht WHERE org_id = ? AND party_id = ? AND outcome = 'broken' AND due >= ?`).bind(c.org.id, id, addDays(t, -90))]);
  const party = set.extra[0].results[0];
  if (!party) throw notFound('Contact not found.');
  const seen = bookSeen(c.user), st = set.stats.get(id) || { kept: 0, broken: 0 };
  const due = { khata: Math.max(0, set.extra[1].results[0].b || 0), inv: Math.max(0, set.dueOf.get(id) || 0) };
  const open = {}, plans = {}, feat = hasFeature(c.org, 'vaada');
  for (const b of ['khata', 'inv']) {
    const p = set.list.find((x) => x.book === b && x.status === 'open');
    open[b] = p && seen[b] ? promiseOut(p) : null;
    plans[b] = feat && due[b] > 0 ? planOptions(due[b], s, t) : [];
  }
  const b90 = set.extra[2].results[0].n + set.diffs.filter((d) => d.due >= addDays(t, -90)).reduce((n, d) => n + (d.o === 'broken') - (d.from === 'broken'), 0);
  return json({ party, on: s.on, today: t, max_date: addDays(t, s.max_days), stats: { kept: st.kept, broken: st.broken, pct: pctOf(st), broken90: Math.max(0, b90) },
    open, due: { khata: R(due.khata), inv: R(due.inv) }, plans, can_plan: feat });
});
/* a promise the customer made on the phone, written down by the shop */
router.add('POST', '/api/vaade', async (c) => {
  requireCan(c.user, 'khata');
  const b = c.body, book = b.book === 'inv' ? 'inv' : 'khata';
  const p = await c.db.prepare(`SELECT id, name, phone, lang FROM parties WHERE id = ? AND org_id = ?`).bind(+b.party_id || 0, c.org.id).first();
  if (!p) throw notFound('Contact not found.');
  let docId = null;
  if (book === 'inv') {
    const d = await c.db.prepare(`SELECT id FROM docs WHERE org_id = ? AND party_id = ? AND type = 'INV' AND status IN ('unpaid','partial') ORDER BY due_date, id LIMIT 1`).bind(c.org.id, p.id).first();
    if (!d) throw bad('Koi baaki nahi hai.');
    docId = d.id;
  }
  const r = await makePromise(c, { org: c.org, partyId: p.id, partyName: p.name, book, docId, by: 'shop', body: b });
  const lang = await langFor(c, p), L = phrases(lang);
  const link = withLang(book === 'inv' ? `${c.url.origin}/i/${await shareToken(c, docId)}` : await khataLink(c, p.id), lang);
  const planLines = r.kisht.length > 1 ? '\n' + r.kisht.map((k) => `• ${fd(k.d)}: ${inrW(k.a)}`).join('\n') : '';
  const wa = `*${c.org.name}*\n${L.vNoted}\n\n${L.hello(p.name)}\n${L.vBy(fd(r.last), inrW(r.amount))}${planLines}\n\n${L.vSee(book)}\n${link}\n\n${L.sentVia(BRAND)}`;
  const sms = `${L.smsVNoted(c.org.name, p.name, fd(r.last), rs(r.amount), link)} -${BRAND}`;
  return json({ ok: true, vaada: r.vaada, phone: p.phone, ...sendLinks(p.phone, wa, sms) });
});
router.add('POST', '/api/vaade/:id/cancel', async (c) => {
  requireCan(c.user, 'khata');
  const id = +c.params.id || 0, reason = str(c.body.reason, 120);
  const [u] = await c.db.batch([
    c.db.prepare(`UPDATE vaade SET status = 'cancelled', closed_on = ?, note = COALESCE(note, '') || ' [radd: ' || ? || ']' WHERE id = ? AND org_id = ? AND status = 'open'`)
      .bind(today(), reason, id, c.org.id),
    c.db.prepare(`INSERT INTO audit (org_id, user_id, at, action, detail) SELECT ?, ?, ?, 'vaada cancel',
        COALESCE((SELECT p.name FROM vaade v JOIN parties p ON p.id = v.party_id WHERE v.id = ? AND v.org_id = ?), '') || ': ' || ? WHERE changes() > 0`)
      .bind(c.org.id, c.user.id, nowIso(), id, c.org.id, reason)]);
  if (!u.meta.changes) {
    if (!(await c.db.prepare(`SELECT 1 AS x FROM vaade WHERE id = ? AND org_id = ?`).bind(id, c.org.id).first())) throw notFound('Vaada nahi mila.');
    throw bad('Ye vaada khula nahi hai.');
  }
  return json({ ok: true });
});
/* udhaar check for the billing screens (the same rules createDoc enforces) */
router.add('GET', '/api/vaade/check', async (c) => {
  requireCan(c.user, 'sales');
  const s = cleanVaada(c.org.vaada), t = today(), pid = +c.url.searchParams.get('party_id') || 0;
  const mode = hasFeature(c.org, 'vaada') ? s.credit_check : 'off';
  if (mode === 'off') return json({ risky: false, reasons: [], text: '', mode, can_override: true });
  const res = await c.db.batch([...riskStatements(c.db, c.org.id, pid, t, s.grace), c.db.prepare(`SELECT id, name, credit_limit FROM parties WHERE id = ? AND org_id = ?`).bind(pid, c.org.id)]);
  const party = res[5].results[0];
  if (!party) throw notFound('Contact not found.');
  const r = risk(riskInput(res, party, 0, t), s);
  return json({ risky: r.risky, name: party.name, reasons: r.reasons, text: r.text, mode, can_override: mode === 'warn' || can(c.user, 'settings'), kept_pct: r.kept_pct, broken90: r.broken90 });
});
router.add('PUT', '/api/settings/vaada', async (c) => {
  requireCan(c.user, 'settings');
  const s = cleanVaada({ ...cleanVaada(c.org.vaada), ...(c.body && typeof c.body === 'object' ? c.body : {}) });
  await c.db.batch([c.db.prepare(`UPDATE orgs SET vaada = ? WHERE id = ?`).bind(JSON.stringify(s), c.org.id),
    auditStatement(c, 'vaada settings', `${s.on ? 'on' : 'off'} · udhaar check ${s.credit_check} · plans ${s.plans.join(',') || '-'}`)]);
  return json({ ok: true, vaada: s });
});

/* ---------- Kal ka Cash: the next 4 weeks of cash (§6.4), cached once a day per business ---------- */
const ymBack = (t, n) => { let d = t.slice(0, 8) + '01'; for (let i = 0; i < n; i++) d = addDays(d, -1).slice(0, 8) + '01'; return d.slice(0, 7); };
router.add('GET', '/api/vaade/cash', async (c) => {
  requireFeature(c.org, 'cash');
  if (limitedView(c.user) && !canView(c.user, 'finance') && !canView(c.user, 'reports')) throw forbidden('Your role cannot see this. Ask the owner.');
  const t = today(), o = c.org.id, db = c.db;
  if (c.url.searchParams.get('fresh') === '1') await limitHi(c, 'vcash:' + o, 10, 3600, 'Bahut baar dobara banaya. Thodi der baad try karein.');
  else {
    const hit = await db.prepare(`SELECT d, data FROM vaada_cache WHERE org_id = ?`).bind(o).first();
    if (hit && hit.d === t) { try { return json({ ...JSON.parse(hit.data), cached: true }); } catch (e) { /* rebuild */ } }
  }
  const res = await db.batch([
    db.prepare(`SELECT d.id, d.party_id, d.date, d.due_date, d.total - d.paid AS bal, p.name, p.phone FROM docs d JOIN parties p ON p.id = d.party_id
        WHERE d.org_id = ? AND d.type = 'INV' AND d.status IN ('unpaid','partial')`).bind(o),
    db.prepare(`SELECT d.id, d.number, d.date, d.due_date, d.total - d.paid AS bal, p.name AS party FROM docs d LEFT JOIN parties p ON p.id = d.party_id
        WHERE d.org_id = ? AND d.type = 'BILL' AND d.status IN ('unpaid','partial')`).bind(o),
    db.prepare(`SELECT d.party_id, p.date, d.due_date FROM payments p JOIN payment_allocs a ON a.payment_id = p.id JOIN docs d ON d.id = a.doc_id
        WHERE p.org_id = ? AND p.kind = 'receipt' AND p.date >= ? AND substr(COALESCE(p.notes, ''), 1, 6) != '[void]' AND d.type = 'INV' ORDER BY p.date DESC LIMIT 5000`).bind(o, addDays(t, -120)),
    db.prepare(`SELECT k.party_id, k.due, k.amount, v.book, p.name, p.phone FROM vaada_kisht k JOIN vaade v ON v.id = k.vaada_id JOIN parties p ON p.id = k.party_id
        WHERE v.org_id = ? AND v.status = 'open' AND k.outcome IS NULL`).bind(o),
    db.prepare(`SELECT party_id, kept, broken FROM vaada_stats WHERE org_id = ? AND party_id IN (SELECT party_id FROM vaade WHERE org_id = ? AND status = 'open')`).bind(o, o),
    db.prepare(`SELECT m.account_id, a.sys, a.type, m.ym, m.dr, m.cr FROM acct_month m JOIN accounts a ON a.id = m.account_id
        WHERE m.org_id = ? AND m.ym >= ? AND (a.type = 'expense' OR a.sys IN ('gst_output','gst_input'))`).bind(o, ymBack(t, 4)),
  ]);
  const bal = await rep.accountBalances(db, o, '0000-01-01', t);
  const f = forecast({ opening: bal.filter((a) => a.is_cash).reduce((x, a) => x + a.dr - a.cr, 0), invs: res[0].results, bills: res[1].results, late: res[2].results,
    kisht: res[3].results, stats: res[4].results, months: res[5].results }, t);
  const out = { today: t, at: nowTime(), low_data: String(c.org.created_at || '').slice(0, 10) > addDays(t, -60), opening: R(f.opening),
    weeks: f.weeks.map((w) => ({ from: w.from, to: w.to, in_exp: R(w.in_exp), in_full: R(w.in_full), out: R(w.out), close_exp: R(w.close_exp), close_full: R(w.close_full) })),
    short_week: f.short_week, short_amount: R(f.short_amount), remind: f.remind.map((r) => ({ ...r, amount: R(r.amount) })), remind_total: R(f.remind_total),
    bills_wait: f.bills_wait.map((b) => ({ ...b, amount: R(b.amount) })), stuck: R(f.stuck), expense_week: R(f.expense_week) };
  await db.prepare(`INSERT INTO vaada_cache (org_id, d, at, data) VALUES (?, ?, ?, ?) ON CONFLICT (org_id) DO UPDATE SET d = excluded.d, at = excluded.at, data = excluded.data`)
    .bind(o, t, nowIso(), JSON.stringify(out)).run();
  return json({ ...out, cached: false });
});

/* ======================================================================= reports */
const noCosts = (o, keys) => { keys.forEach((k) => delete o[k]); return o; };
/* The dashboard mixes every area. A custom role gets the parts its views cover: recent documents only of the sides it may see,
   purchase and profit figures only with purchase/reports, sales figures only with sales/finance/reports, costs only with seesCosts. */
function dashboardFor(user, d) {
  if (!seesCosts(user)) {
    noCosts(d, ['gross_profit_fy', 'net_profit_fy', 'gross_margin', 'stock_value']);
    d.low_stock = d.low_stock.map((r) => noCosts({ ...r }, ['avg_cost', 'value']));
  }
  if (user.role !== 'custom') return d;
  d.recent = d.recent.filter((r) => Object.hasOwn(DOC_TYPES, r.type) && canView(user, DOC_TYPES[r.type].side));
  if (!canView(user, 'purchase') && !canView(user, 'reports') && !canView(user, 'finance')) {
    noCosts(d, ['purchases_fy', 'payable', 'gst_payable']);
    d.monthly = d.monthly.map((m) => noCosts({ ...m }, ['purchases']));
  }
  if (!canView(user, 'sales') && !canView(user, 'reports') && !canView(user, 'finance') && !canView(user, 'khata')) {
    noCosts(d, ['sales_month', 'sales_fy', 'invoices_fy', 'receivable', 'gst_payable']);
    d.overdue = [];
    d.monthly = d.monthly.map((m) => noCosts({ ...m }, ['sales']));
  }
  return d;
}
const REPORTS = {
  dashboard: async (c) => dashboardFor(c.user, await rep.dashboard(c.db, c.org)),
  'trial-balance': (c) => rep.trialBalance(c.db, c.org, c.url.searchParams),
  pnl: (c) => rep.profitLoss(c.db, c.org, c.url.searchParams),
  'balance-sheet': (c) => rep.balanceSheet(c.db, c.org, c.url.searchParams),
  gst: (c) => rep.gstSummary(c.db, c.org, c.url.searchParams),
  ageing: (c) => rep.ageing(c.db, c.org, c.url.searchParams),
  stock: async (c) => { const s = await rep.stockReport(c.db, c.org); if (!seesCosts(c.user)) { s.rows.forEach((r) => noCosts(r, ['avg_cost', 'value'])); delete s.total_value; } return s; },
  daybook: (c) => rep.dayBook(c.db, c.org, c.url.searchParams),
  'stock-ageing': async (c) => {
    const s = await rep.stockAgeing(c.db, c.org, c.url.searchParams);
    if (!seesCosts(c.user)) { s.rows.forEach((r) => { delete r.value; delete r.values; delete r.sales_value; }); delete s.totals; }
    return s;
  },
  expiry: async (c) => {
    const s = await expiryReport(c, +c.url.searchParams.get('days') || 90);
    if (!seesCosts(c.user)) { s.rows.forEach((r) => delete r.value); delete s.expired_value; delete s.soon_value; }
    return s;
  },
  register: (c) => rep.register(c.db, c.org, c.url.searchParams),
};
router.add('GET', '/api/reports/:name', async (c) => {
  // Own keys only: REPORTS['constructor'] is Object(), which would hand back the whole request context (env, secrets).
  const fn = Object.hasOwn(REPORTS, c.params.name) ? REPORTS[c.params.name] : null;
  if (!fn) throw notFound('Unknown report.');
  return json(await fn(c));
});
/* Search box in the top bar: items, contacts and documents in one D1 call (only what the user's role may see) */
router.add('GET', '/api/search', async (c) => {
  const q = str(c.url.searchParams.get('q'), 60);
  const out = { items: [], parties: [], docs: [] };
  if (q.length < 2) return json(out);
  const like = `%${q.replace(/[%_]/g, '')}%`, db = c.db, st = [], keys = [];
  if (canView(c.user, 'items') || canView(c.user, 'sales') || canView(c.user, 'purchase')) {
    keys.push('items');
    st.push(db.prepare(`SELECT id, name, unit, qty_on_hand, sale_price, is_service FROM items WHERE org_id = ? AND (name LIKE ? OR sku = ? OR barcode = ?) ORDER BY name LIMIT 6`).bind(c.org.id, like, q, q));
  }
  if (canView(c.user, 'masters') || canView(c.user, 'khata')) {
    keys.push('parties');
    st.push(db.prepare(`SELECT id, name, kind, phone FROM parties WHERE org_id = ? AND (name LIKE ? OR phone LIKE ?) ORDER BY name LIMIT 6`).bind(c.org.id, like, like));
  }
  const types = Object.keys(DOC_TYPES).filter((t) => canView(c.user, DOC_TYPES[t].side));
  if (types.length) {
    keys.push('docs');
    // numbers are searched only when the text has a digit; otherwise documents of matching parties (uses the party index)
    st.push(db.prepare(`SELECT d.id, d.type, d.number, d.date, d.total, d.status, p.name AS party FROM docs d LEFT JOIN parties p ON p.id = d.party_id
        WHERE d.org_id = ?1 AND d.type IN (${types.map((t) => `'${t}'`).join(',')})
          AND (${/\d/.test(q) ? 'd.number LIKE ?2 OR ' : ''}d.party_id IN (SELECT id FROM parties WHERE org_id = ?1 AND name LIKE ?2 LIMIT 3))
        ORDER BY d.id DESC LIMIT 6`).bind(c.org.id, like));
  }
  const res = await db.batch(st);
  keys.forEach((k, i) => { out[k] = res[i].results; });
  out.items = out.items.map((i) => ({ ...i, sale_price: R(i.sale_price) }));
  out.docs = out.docs.map((d) => ({ ...d, label: DOC_TYPES[d.type].label, total: R(d.total) }));
  return json(out);
});

router.add('GET', '/api/audit', async (c) => {
  requireCan(c.user, 'users');
  const { results } = await c.db.prepare(`SELECT a.at, a.action, a.detail, u.name AS user FROM audit a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.org_id = ? ORDER BY a.id DESC LIMIT 300`).bind(c.org.id).all();
  return json({ rows: results });
});
router.add('GET', '/api/health', async (c) => json({ ok: true, db: !!c.env.DB, time: nowIso() }), { public: true });

/* ======================================================================= entry point */
/* Local testing only (QUERY_COUNT=1 in .dev.vars): counts D1 calls per request, as Cloudflare does for its
   limit of 50 per request on the free plan (a batch is one call), and reports it in the X-Query-Count header. */
function countingDb(db, counter) {
  const meta = (r) => { if (r && r.meta) { counter.read = (counter.read || 0) + (r.meta.rows_read || 0); counter.written = (counter.written || 0) + (r.meta.rows_written || 0); } return r; };
  const wrap = (st) => ({ __raw: st, bind: (...a) => wrap(st.bind(...a)),
    first: (col) => { counter.n++; return st.all().then((r) => { meta(r); const row = r.results[0] ?? null; return col && row ? row[col] : row; }); },
    all: () => { counter.n++; return st.all().then(meta); },
    run: () => { counter.n++; return st.run().then(meta); }, raw: (...a) => { counter.n++; return st.raw(...a); } });
  return { prepare: (sql) => wrap(db.prepare(sql)), batch: (list) => { counter.n++; return db.batch(list.map((x) => x.__raw || x)).then((rs) => { rs.forEach(meta); return rs; }); }, exec: (q) => db.exec(q) };
}

/* Which area a GET belongs to, for custom roles. A string is that area's view right and a list is any one of them.
   OPEN means every signed-in role may call it and the handler itself narrows what it returns (documents are checked by their
   side in docDetail). Anything not listed is refused for custom roles, so a new endpoint is closed until it is listed here. */
const OPEN = 'open';
const READ_AREAS = [
  [/^\/api\/(me|plan|search)\/?$/, OPEN],
  [/^\/api\/settings\/(print|fields)\/?$/, OPEN],
  [/^\/api\/org\/files\/[^/]+\/?$/, OPEN],
  [/^\/api\/(parties|accounts|warehouses)\/?$/, OPEN],
  [/^\/api\/reports\/(dashboard|pending)\/?$/, OPEN],
  [/^\/api\/docs\/\d+(\/(convert|einvoice|ewaybill|share))?\/?$/, OPEN],
  [/^\/api\/vaade\/(cash|check)\/?$/, OPEN],
  [/^\/api\/items(\/lookup)?\/?$/, ['items', 'sales', 'purchase']],
  [/^\/api\/items\/\d+\/moves\/?$/, 'items'],
  [/^\/api\/reports\/(stock|stock-ageing|expiry)\/?$/, 'items'],
  [/^\/api\/items\/\d+\/lots\/?$/, ['items', 'sales', 'purchase']],
  [/^\/api\/bins(\/|$)/, 'items'],
  [/^\/api\/picklist\/?$/, 'items'],
  [/^\/api\/serials\/?$/, ['items', 'sales']],
  [/^\/api\/today\/?$/, OPEN],
  [/^\/api\/staff(\/|$)/, 'finance'],
  [/^\/api\/hooks\/?$/, 'settings'],
  [/^\/api\/items\/\d+\/bom\/?$/, 'items'],
  [/^\/api\/productions\/?$/, 'items'],
  [/^\/api\/channels\/stock\/?$/, 'items'],
  [/^\/api\/reports\//, 'reports'],
  [/^\/api\/export\//, 'reports'],
  [/^\/api\/(payments|accounts\/\d+\/ledger)(\/|$)/, 'finance'],
  [/^\/api\/parties\/\d+\/(ledger|reminder)\/?$/, 'masters'],
  [/^\/api\/khata(\/|$)/, 'khata'],
  [/^\/api\/vaade(\/|$)/, 'khata'],         // coarse gate; rows are filtered per book in the handler
  [/^\/api\/gate(\/|$)/, ['purchase', 'gate']],
  [/^\/api\/receive\/?$/, 'purchase'],
  [/^\/api\/claims(\/\d+)?\/?$/, ['purchase', 'finance']],
  [/^\/api\/(audit|users|roles|billing\/status|settings\/series)\/?$/, 'settings'],
];
function readArea(url) {
  const p = url.pathname;
  if (p === '/api/docs' || p === '/api/docs/') {
    const t = (url.searchParams.get('type') || '').toUpperCase();
    return Object.hasOwn(DOC_TYPES, t) ? DOC_TYPES[t].side : OPEN;      // without a type the handler lists only the sides the role may see
  }
  const hit = READ_AREAS.find(([re]) => re.test(p));
  return hit ? hit[1] : null;
}

async function handleApi(request, env, counter) {
  const url = new URL(request.url);
  if (!env.DB) throw new HttpError(500, 'Database not connected: bind a D1 database as DB in wrangler.toml.');
  if (!migrated) { await migrate(env.DB); migrated = true; }
  if (counter) env = { ...env, DB: countingDb(env.DB, counter) };
  const m = router.match(request.method, url.pathname);
  if (!m) throw notFound('Unknown API route.');
  if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed.');
  if (request.method !== 'GET' && !m.route.opts.webhook) {
    // custom header + same origin: a page on another site cannot make these requests with your cookie
    if (request.headers.get('X-Requested-With') !== 'SmartTrader') throw forbidden('Missing request header.');
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) throw forbidden('Cross-site request blocked.');
  }
  const c = { db: env.DB, request, url, params: m.params, body: {} };
  Object.defineProperty(c, 'env', { value: env, enumerable: false, writable: true, configurable: true });   // env holds the secrets: a handler that serialises c must never be able to dump it
  if (m.route.opts.webhook) {       // a server calling us (DocBrisk Pay hub, Razorpay): signed raw body, no cookie, no custom header
    c.raw = await request.text();
    if (c.raw.length > 200000) throw new HttpError(413, 'Request too large.');
    try { c.body = JSON.parse(c.raw || '{}'); } catch (e) { if (!m.route.opts.rawOk) throw bad('Bad body.'); c.body = {}; }
  } else if (request.method !== 'GET') c.body = await readJson(request, m.route.opts.bodyMax);
  if (!m.route.opts.public) {
    const p = await sessionFromRequest(env, request);
    if (!p) throw new HttpError(401, 'Please sign in.');
    // user, business, whether this very session was logged out, and (only for writes) the posting accounts, in one D1 call
    const db = env.DB, write = request.method !== 'GET', st = [db.prepare(USER_SQL).bind(p.u), db.prepare(`SELECT * FROM orgs WHERE id = ?`).bind(p.o)];
    if (p.i) st.push(db.prepare(REVOKED_SQL).bind(String(p.i)));
    if (write) st.push(db.prepare(SYS_SQL).bind(p.o));
    const res = await db.batch(st);
    c.user = res[0].results[0];
    c.org = res[1].results[0];
    if (!sessionValid(c.user, p) || !c.org || (p.i && res[2].results.length)) throw new HttpError(401, 'Please sign in.');
    c.sys = write ? sysMap(res[res.length - 1].results) : null;
    if (seatBlocked(c.org, c.user)) throw seatError(c.org);
    if (limitedView(c.user) && request.method === 'GET') {
      const area = readArea(url);
      if (area === null) throw forbidden('Your role cannot see this. Ask the owner.');
      if (area !== OPEN && !(Array.isArray(area) ? area : [area]).some((a) => canView(c.user, a))) throw forbidden('Your role cannot see this. Ask the owner.');
    }
  }
  const key = request.method === 'POST' && c.user ? request.headers.get('Idempotency-Key') : null;
  if (key) return idempotent(c, key, () => m.route.handler(c));
  return m.route.handler(c);
}

/* A write sent again with the same Idempotency-Key (the app saved it while offline, or the answer was lost on the way)
   gets the first answer back instead of running twice. Only successes are kept: a refused request can be sent again. */
async function idempotent(c, key, run) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(key)) throw bad('Bad Idempotency-Key.');
  const db = c.db, org = c.org.id;
  const take = () => db.prepare(`INSERT INTO idem_keys (org_id, key, user_id, status, created_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT DO NOTHING`).bind(org, key, c.user.id, nowIso()).run();
  if (!(await take()).meta.changes) {
    const row = await db.prepare(`SELECT status, body, user_id, created_at FROM idem_keys WHERE org_id = ? AND key = ?`).bind(org, key).first();
    if (row && row.user_id !== c.user.id) throw bad('Bad Idempotency-Key.');
    if (row && row.status) return new Response(row.body, { status: row.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Idempotent-Replay': 'true' } });
    // a first attempt that died half-way (nothing was saved: every write is one atomic batch) is cleared after two minutes
    if (!row || Date.now() - Date.parse(row.created_at) < 120000 || !(await db.prepare(`DELETE FROM idem_keys WHERE org_id = ? AND key = ? AND status = 0`).bind(org, key).run()).meta.changes
      || !(await take()).meta.changes) throw new HttpError(409, 'This entry is still being saved. Try again in a moment.');
  }
  const drop = () => db.prepare(`DELETE FROM idem_keys WHERE org_id = ? AND key = ? AND status = 0`).bind(org, key).run();
  let res;
  try { res = await run(); } catch (e) { await drop(); throw e; }
  if (res.status >= 400) { await drop(); return res; }
  const text = await res.clone().text();
  await db.prepare(`UPDATE idem_keys SET status = ?, body = ? WHERE org_id = ? AND key = ?`).bind(res.status, text.length <= 200000 ? text : '{"ok":true}', org, key).run();
  return res;
}

/* /k/<token> (khata) and /i/<token> (invoice): the web app, with Open Graph tags so WhatsApp shows a banner card
   (title, amount, image) for the link. The page itself loads the data through the public API. */
const attr = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
async function sharePage(request, env, kind, token) {
  if (!migrated) { await migrate(env.DB); migrated = true; }
  const url = new URL(request.url);
  // the link carries the language the shop picked (?l=en / ?l=hi); no mark = Hinglish, as links always were
  const lang = cleanLang(url.searchParams.get('l')), T = PREVIEW[lang], sfx = lang === 'hl' ? '' : '-' + lang;
  let title = 'SmartTrader ERP', desc = 'Billing, stock, GST, accounts and khata for Indian businesses.', image = `/og-invoice${sfx}.png`;
  if (kind === 'k') {
    const p = await env.DB.prepare(`SELECT p.id, p.name, o.name AS org, o.upi_id FROM parties p JOIN orgs o ON o.id = p.org_id WHERE p.khata_token = ?`).bind(token).first();
    if (p) {
      const b = (await env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN status = 'sent' THEN (CASE WHEN kind = 'gave' THEN amount ELSE -amount END) ELSE 0 END), 0) AS b FROM khata WHERE party_id = ?`).bind(p.id).first()).b;
      title = T.kh(p.name, p.org);
      desc = b > 0 ? T.khDue(inrW(b), !!p.upi_id) : b < 0 ? T.khAdv(inrW(-b)) : T.khClear;
      image = `/og-khata${sfx}.png`;
    }
  } else if (kind === 'c') {
    const f = await env.DB.prepare(`SELECT f.balance, o.name AS org FROM confirmations f JOIN orgs o ON o.id = f.org_id WHERE f.token = ?`).bind(token).first();
    if (f) { title = T.cf(f.org); desc = T.cfDesc(inrW(f.balance)); image = `/og-confirm${sfx}.png`; }
  } else {
    const d = await env.DB.prepare(`SELECT d.type, d.number, d.date, d.total, d.paid, o.name AS org FROM docs d JOIN orgs o ON o.id = d.org_id WHERE d.share_token = ? AND d.status != 'cancelled'`).bind(token).first();
    if (d && Object.hasOwn(DOC_TYPES, d.type)) {
      title = T.doc(phrases(lang).docLabel(d.type, DOC_TYPES[d.type].label), d.number, d.org);
      desc = T.docDesc(inrW(d.total), d.type === 'INV' ? (d.total - d.paid > 0 ? inrW(d.total - d.paid) : '') : null);
    }
  }
  const page = await env.ASSETS.fetch(new Request(url.origin + '/', request));
  let html = await page.text();
  const tags = `<title>${attr(title)}</title>
<meta name="description" content="${attr(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="SmartTrader ERP">
<meta property="og:title" content="${attr(title)}"><meta property="og:description" content="${attr(desc)}">
<meta property="og:url" content="${attr(url.origin + url.pathname + (lang === 'hl' ? '' : '?l=' + lang))}">
<meta property="og:image" content="${attr(url.origin + image)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="robots" content="noindex">`;
  html = html.replace(/<title>[\s\S]*?<\/title>/, '').replace(/<meta (name|property)="(description|robots|og:[^"]*|twitter:[^"]*)"[^>]*>/g, '')
    .replace(/<link rel="canonical"[^>]*>/, '').replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '').replace('</head>', tags + '\n</head>');
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

/* the static files come from the ASSETS binding; headers are added to everything the Worker sends */
async function respond(request, env, url) {
  const share = url.pathname.match(/^\/(k|i|c)\/([0-9a-f]{24})\/?$/);
  if (share && env.ASSETS) return sharePage(request, env, share[1], share[2]).catch(() => env.ASSETS.fetch(new Request(url.origin + '/', request)));
  if (!url.pathname.startsWith('/api/')) {
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  }
  try {
    const counter = env.QUERY_COUNT === '1' ? { n: 0 } : null;
    const res = await handleApi(request, env, counter);
    if (counter) res.headers.set('X-Query-Count', String(counter.n));
    if (counter) res.headers.set('X-Rows', `${counter.read || 0}/${counter.written || 0}`);
    return res;
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
    console.error(e && e.stack || e);          // logged for the owner; the caller only ever sees this fixed text
    return json({ error: 'Something went wrong on the server. Please try again.' }, 500);
  }
}
export default {
  /* Cron (wrangler.toml [triggers]): make the recurring invoices and bills that are due, and the Google Drive backups. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (!migrated) { await migrate(env.DB); migrated = true; }
      const r = await runDue(env);
      if (r.due) console.log('recurring', JSON.stringify(r));
      const g = await runDriveBackups(env);
      if (g.due) console.log('drive backups', JSON.stringify(g));
      await env.DB.prepare(`DELETE FROM idem_keys WHERE created_at < ?`).bind(new Date(Date.now() - 7 * 864e5).toISOString()).run();   // replay window: a week
      const w = await runAutoReminders(env);
      if (w.due) console.log('auto whatsapp', JSON.stringify(w));
    })());
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    try { return secure(await respond(request, env, url), url.pathname.startsWith('/api/')); } catch (e) {
      console.error(e && e.stack || e);
      return secure(new Response('Something went wrong. Please try again.', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }), true);
    }
  },
};
