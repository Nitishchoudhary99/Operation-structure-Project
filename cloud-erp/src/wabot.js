/* WhatsApp bot on the official WhatsApp Cloud API: customers write to SmartTrader's WhatsApp Business number (the one
   automatic reminders come from) and get an answer at once. Replies cost nothing: on the Cloud API every message sent
   within 24 hours of the customer's own message is free, and a reminder due to a customer who wrote in the last 24 hours
   goes as free text too (src/autowa.js).
   - Which shop: the code in the shop's link / QR ("HISAB #A1B2C3"), else a shop the customer just picked from a list,
     else the shop this mobile was talking to (a reminder, a reply), else the shops that have this mobile on a customer
     (one: that shop; several: the customer picks). Only shops that turned the bot on (Settings) answer.
   - What it answers: menu; hisab (what is due: each open bill with its link and UPI, and the khata); bill (the last bills);
     pay; vaada (pick a pay date on the bill page); shop (the message goes to the shop's inbox); stop / start (automatic
     reminders off / on). Anything else is passed to the shop.
   - Everything said either way is kept in wa_messages: the shop's WhatsApp Inbox, where the shop can answer (free within
     the 24 hours). Meta's webhook is checked with the app secret (X-Hub-Signature-256); a delivery Meta repeats is
     recognised by its message id and answered once. Needs WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_APP_SECRET and
     WHATSAPP_VERIFY_TOKEN (README "WhatsApp bot"); WHATSAPP_NUMBER is the number customers see in the shop's link. */
import { bad, notFound, forbidden, str, nowIso, HttpError } from './lib.js';
import { can, requireCan, randomHex, sameText, rateLimit } from './auth.js';
import { auditStatement } from './engine.js';
import { waConfigured, sendText } from './autowa.js';

export const botReady = (env) => waConfigured(env) && !!env.WHATSAPP_APP_SECRET;
const inr = (p) => '₹' + (Math.round(p) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const DAY = 86400e3;
// an Indian mobile on WhatsApp (91 + 10 digits) as saved on parties.phone10; any other number matches no customer, so a
// foreign number that ends in the same 10 digits never sees an Indian customer's account
const mobile10 = (p) => (/^91[6-9]\d{9}$/.test(p) ? p.slice(2) : '');
const fdate = (d) => (d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' }) : '');

/* the shop's link and QR: a WhatsApp message to our number that carries the shop's code */
export const botLink = (env, code) => (env.WHATSAPP_NUMBER && code ? `https://wa.me/${String(env.WHATSAPP_NUMBER).replace(/\D/g, '')}?text=${encodeURIComponent('HISAB #' + code)}` : '');

/* ---------- what the bot says, in the customer's language ---------- */
const T = {
  hl: {
    menu: (s, n) => `*${s}*\nNamaste${n ? ' ' + n + ' ji' : ''}! Number bhejein:\n1 - Hisab (kitna baaki hai)\n2 - Bills\n3 - Payment (UPI)\n4 - Payment ki date batayein\n5 - Dukaan se baat\nReminder band karne ke liye STOP.`,
    choose: (list) => `Aap kis dukaan ka hisab dekhna chahte hain? Number bhejein:\n${list}`,
    unknown: 'Namaste! Ye SmartTrader ka WhatsApp number hai. Aapka number kisi dukaan ki list mein nahi mila. Dukaan se unka WhatsApp QR / link maangein.',
    notListed: (s) => `*${s}*\nAapka number dukaan ki list mein nahi hai. Aapka message dukaan ko bhej diya hai, woh jald jawab denge.`,
    clear: (s, n) => `*${s}*\nNamaste ${n} ji, aapka kuch baaki nahi hai. Dhanyavaad! 🙏`,
    due: 'baaki', total: 'Kul baaki', bills: 'Bills', khata: 'Khata', pay: 'Har bill ke link par UPI se payment kar sakte hain.',
    lastBills: 'Aapke pichhle bills', paid: 'paid', noBills: 'Abhi koi bill nahi hai.',
    payNow: (a, l, u) => `${a} baaki hain. Is link par UPI se payment karein: ${l}${u ? `\nUPI ID: ${u}` : ''}`,
    vaada: (l) => `Is link par "Kab tak denge?" mein apni date chunein: ${l}`,
    shop: (s, p) => `Aapka message ${s} ko bhej diya hai. Woh yahin jawab denge${p ? ` ya aap call karein: ${p}` : ''}.`,
    passed: (s) => `Aapka message ${s} ko bhej diya hai. Hisab ke liye 1 bhejein, menu ke liye MENU.`,
    stop: (s) => `${s} ke automatic reminder band kar diye. Phir chalu karne ke liye START bhejein.`,
    start: (s) => `${s} ke reminder phir chalu kar diye.`,
  },
  hi: {
    menu: (s, n) => `*${s}*\nनमस्ते${n ? ' ' + n + ' जी' : ''}! नंबर भेजें:\n1 - हिसाब (कितना बाकी है)\n2 - बिल\n3 - भुगतान (UPI)\n4 - भुगतान की तारीख बताएं\n5 - दुकान से बात\nरिमाइंडर बंद करने के लिए STOP.`,
    choose: (list) => `आप किस दुकान का हिसाब देखना चाहते हैं? नंबर भेजें:\n${list}`,
    unknown: 'नमस्ते! यह SmartTrader का WhatsApp नंबर है। आपका नंबर किसी दुकान की सूची में नहीं मिला। दुकान से उनका WhatsApp QR / लिंक मांगें।',
    notListed: (s) => `*${s}*\nआपका नंबर दुकान की सूची में नहीं है। आपका संदेश दुकान को भेज दिया है, वे जल्द जवाब देंगे।`,
    clear: (s, n) => `*${s}*\nनमस्ते ${n} जी, आपका कुछ बाकी नहीं है। धन्यवाद! 🙏`,
    due: 'बाकी', total: 'कुल बाकी', bills: 'बिल', khata: 'खाता', pay: 'हर बिल के लिंक पर UPI से भुगतान कर सकते हैं।',
    lastBills: 'आपके पिछले बिल', paid: 'भुगतान हो गया', noBills: 'अभी कोई बिल नहीं है।',
    payNow: (a, l, u) => `${a} बाकी हैं। इस लिंक पर UPI से भुगतान करें: ${l}${u ? `\nUPI ID: ${u}` : ''}`,
    vaada: (l) => `इस लिंक पर "कब तक देंगे?" में अपनी तारीख चुनें: ${l}`,
    shop: (s, p) => `आपका संदेश ${s} को भेज दिया है। वे यहीं जवाब देंगे${p ? ` या आप कॉल करें: ${p}` : ''}।`,
    passed: (s) => `आपका संदेश ${s} को भेज दिया है। हिसाब के लिए 1 भेजें, मेनू के लिए MENU.`,
    stop: (s) => `${s} के ऑटोमैटिक रिमाइंडर बंद कर दिए। फिर चालू करने के लिए START भेजें।`,
    start: (s) => `${s} के रिमाइंडर फिर चालू कर दिए।`,
  },
  en: {
    menu: (s, n) => `*${s}*\nHello${n ? ' ' + n : ''}! Send a number:\n1 - Account (what is due)\n2 - Bills\n3 - Pay (UPI)\n4 - Tell us a pay date\n5 - Talk to the shop\nSend STOP to stop reminders.`,
    choose: (list) => `Which shop's account do you want? Send the number:\n${list}`,
    unknown: 'Hello! This is SmartTrader\'s WhatsApp number. Your number is not on any shop\'s list. Ask the shop for their WhatsApp QR / link.',
    notListed: (s) => `*${s}*\nYour number is not on the shop's list. Your message has gone to the shop; they will reply soon.`,
    clear: (s, n) => `*${s}*\nHello ${n}, nothing is due. Thank you! 🙏`,
    due: 'due', total: 'Total due', bills: 'Bills', khata: 'Khata', pay: 'Pay by UPI from any bill link.',
    lastBills: 'Your last bills', paid: 'paid', noBills: 'No bills yet.',
    payNow: (a, l, u) => `${a} is due. Pay by UPI on this link: ${l}${u ? `\nUPI ID: ${u}` : ''}`,
    vaada: (l) => `Pick your pay date under "When will you pay?" on this link: ${l}`,
    shop: (s, p) => `Your message has gone to ${s}. They will reply here${p ? ` or call them: ${p}` : ''}.`,
    passed: (s) => `Your message has gone to ${s}. Send 1 for your account, MENU for the menu.`,
    stop: (s) => `Automatic reminders from ${s} are stopped. Send START to turn them on again.`,
    start: (s) => `Reminders from ${s} are on again.`,
  },
};
const COMMANDS = [
  ['stop', /^(stop|unsubscribe|band karo|बंद)$/],
  ['start', /^(start|chalu|चालू)$/],
  ['hisab', /^(1|hisab|hisaab|hisab do|balance|bal|baki|baaki|due|account|हिसाब|बाकी)$/],
  ['bill', /^(2|bill|bills|invoice|invoices|बिल)$/],
  ['pay', /^(3|pay|upi|payment|paisa|pay now|भुगतान)$/],
  ['vaada', /^(4|vaada|vada|promise|date|तारीख)$/],
  ['shop', /^(5|shop|call|baat|talk|dukaan|दुकान)$/],
  ['menu', /^(0|hi|hii|hello|hey|namaste|namaskar|menu|help|नमस्ते|मेनू)$/],
];
const commandOf = (text) => {
  const t = text.toLowerCase().replace(/#[0-9a-f]{6}\b/gi, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return 'menu';
  const hit = COMMANDS.find(([, re]) => re.test(t));
  return hit ? hit[0] : /\bhisa+b\b|हिसाब/.test(t) ? 'hisab' : '';
};

/* ---------- Meta's webhook ---------- */
/* GET /api/wa/webhook: Meta checks the address once, with the verify token set in its dashboard */
export function verifyWebhook(c) {
  const q = c.url.searchParams, want = c.env.WHATSAPP_VERIFY_TOKEN || '';
  if (!want || q.get('hub.mode') !== 'subscribe' || !sameText(String(q.get('hub.verify_token') || ''), want)) throw new HttpError(403, 'Not verified.');
  return new Response(String(q.get('hub.challenge') || '').slice(0, 200), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
async function hmacHex(secret, raw) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/* POST /api/wa/webhook: messages from customers (delivery statuses are ignored) */
export async function receiveWebhook(c) {
  if (!botReady(c.env)) throw new HttpError(503, 'The WhatsApp bot is not set up.');
  const sig = c.request.headers.get('X-Hub-Signature-256') || '';
  if (!sig.startsWith('sha256=') || !sameText(sig.slice(7).toLowerCase(), await hmacHex(c.env.WHATSAPP_APP_SECRET, c.raw))) throw new HttpError(401, 'Bad signature.');
  const msgs = [];
  for (const e of Array.isArray(c.body.entry) ? c.body.entry : []) {
    for (const ch of Array.isArray(e && e.changes) ? e.changes : []) {
      const v = (ch && ch.value) || {};
      for (const m of Array.isArray(v.messages) ? v.messages : []) msgs.push(m);
    }
  }
  let answered = 0;
  for (const m of msgs.slice(0, 20)) {
    // one bad message must not make Meta send the whole batch again
    try { if (await handleMessage(c, m)) answered++; } catch (e) { console.error('wabot', e && e.message); }
  }
  return { ok: true, answered };
}

function textOf(m) {
  if (m.type === 'text') return str(m.text && m.text.body, 1000);
  if (m.type === 'button') return str(m.button && (m.button.text || m.button.payload), 200);
  if (m.type === 'interactive') { const r = (m.interactive && (m.interactive.button_reply || m.interactive.list_reply)) || {}; return str(r.title || r.id, 200); }
  return `[${str(m.type, 20) || 'message'}]`;
}

async function handleMessage(c, m) {
  const { db, env } = c;
  const phone = String((m && m.from) || '').replace(/\D/g, ''), wamid = str(m && m.id, 120);
  if (!/^\d{8,15}$/.test(phone) || !wamid) return false;
  const text = textOf(m), now = nowIso();
  // kept first: a delivery Meta repeats has the same id and stops here
  const ins = await db.prepare(`INSERT OR IGNORE INTO wa_messages (phone, dir, body, kind, wamid, at) VALUES (?, 'in', ?, '', ?, ?)`).bind(phone, text, wamid, now).run();
  if (!ins.meta.changes) return false;
  const inId = ins.meta.last_row_id;
  try { await rateLimit(env, 'wabot:' + phone, 30, 3600); } catch (e) { return false; }      // a loop or a flood: stay quiet
  const ct = await db.prepare(`SELECT * FROM wa_contacts WHERE phone = ?`).bind(phone).first();
  await db.prepare(`INSERT INTO wa_contacts (phone, last_in, updated_at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET last_in = excluded.last_in, updated_at = excluded.updated_at`)
    .bind(phone, now, now).run();
  const r = await routeOf(c, phone, text, ct);
  const say = async (orgId, partyId, body, kind = 'bot') => {
    await sendText(env, phone, body);
    const t = nowIso();
    await db.batch([db.prepare(`INSERT INTO wa_messages (org_id, party_id, phone, dir, body, kind, handled, at) VALUES (?, ?, ?, 'out', ?, ?, 1, ?)`).bind(orgId, partyId, phone, body, kind, t),
      db.prepare(`UPDATE wa_contacts SET last_out = ? WHERE phone = ?`).bind(t, phone)]);
    return true;
  };
  if (r.choose) {       // this mobile is a customer of several shops: let them pick
    const lang = 'hl';
    await db.prepare(`UPDATE wa_contacts SET org_id = NULL, party_id = NULL, choices = ? WHERE phone = ?`).bind(JSON.stringify(r.choose.map((o) => o.id)), phone).run();
    return say(null, null, T[lang].choose(r.choose.map((o, i) => `${i + 1}. ${o.name}`).join('\n')));
  }
  if (!r.org) return say(null, null, T.hl.unknown);
  const org = r.org;
  const party = mobile10(phone) ? await db.prepare(`SELECT * FROM parties WHERE org_id = ? AND phone10 = ? ORDER BY (kind = 'supplier'), id LIMIT 1`).bind(org.id, mobile10(phone)).first() : null;
  const lang = T[(party && party.lang) || org.msg_lang] ? (party && party.lang) || org.msg_lang : 'hl', L = T[lang];
  await db.batch([db.prepare(`UPDATE wa_contacts SET org_id = ?, party_id = ?, choices = NULL WHERE phone = ?`).bind(org.id, party ? party.id : null, phone),
    db.prepare(`UPDATE wa_messages SET org_id = ?, party_id = ? WHERE id = ?`).bind(org.id, party ? party.id : null, inId)]);
  const mark = (kind, handled) => db.prepare(`UPDATE wa_messages SET kind = ?, handled = ? WHERE id = ?`).bind(kind, handled, inId).run();
  if (!party) { await mark('ask', 0); return say(org.id, null, L.notListed(org.name)); }
  const cmd = r.picked ? 'menu' : commandOf(text);
  await mark(cmd === 'shop' || !cmd ? 'ask' : 'cmd', cmd === 'shop' || !cmd ? 0 : 1);
  const first = (party.name || '').split(' ')[0];
  switch (cmd) {
    case 'menu': return say(org.id, party.id, L.menu(org.name, first));
    case 'stop':
      await db.prepare(`UPDATE parties SET wa_optout = 1 WHERE id = ?`).bind(party.id).run();
      return say(org.id, party.id, L.stop(org.name));
    case 'start':
      await db.prepare(`UPDATE parties SET wa_optout = 0 WHERE id = ?`).bind(party.id).run();
      return say(org.id, party.id, L.start(org.name));
    case 'hisab': return say(org.id, party.id, await hisabText(c, org, party, lang));
    case 'bill': return say(org.id, party.id, await billsText(c, org, party, lang));
    case 'pay': case 'vaada': {
      const open = await openBills(c, org, party, lang, 1);
      if (!open.rows.length) return say(org.id, party.id, L.clear(org.name, first));
      return say(org.id, party.id, `*${org.name}*\n` + (cmd === 'pay' ? L.payNow(inr(open.due), open.rows[0].link, org.upi_id) : L.vaada(open.rows[0].link)));
    }
    case 'shop': return say(org.id, party.id, L.shop(org.name, org.phone));
    default: return say(org.id, party.id, L.passed(org.name));
  }
}

/* which shop this message is for */
async function routeOf(c, phone, text, ct) {
  const { db } = c;
  const code = (text.match(/#([0-9a-f]{6})\b/i) || [])[1];
  if (code) {
    const org = await db.prepare(`SELECT * FROM orgs WHERE bot_code = ? AND wa_bot = 1`).bind(code.toUpperCase()).first();
    if (org) return { org };
  }
  if (ct && ct.choices && /^\s*\d{1,2}\s*$/.test(text)) {
    let list = [];
    try { list = JSON.parse(ct.choices) || []; } catch (e) { list = []; }
    const id = list[+text.trim() - 1];
    const org = id && await db.prepare(`SELECT * FROM orgs WHERE id = ? AND wa_bot = 1`).bind(id).first();
    if (org) return { org, picked: true };
  }
  if (ct && ct.org_id && ct.updated_at >= ago(30 * DAY)) {
    const org = await db.prepare(`SELECT * FROM orgs WHERE id = ? AND wa_bot = 1`).bind(ct.org_id).first();
    if (org) return { org };
  }
  if (!mobile10(phone)) return {};
  const { results } = await db.prepare(`SELECT DISTINCT o.id, o.name FROM parties p JOIN orgs o ON o.id = p.org_id
      WHERE p.phone10 = ? AND o.wa_bot = 1 ORDER BY o.name LIMIT 9`).bind(mobile10(phone)).all();
  if (results.length === 1) return { org: await db.prepare(`SELECT * FROM orgs WHERE id = ?`).bind(results[0].id).first() };
  if (results.length > 1) return { choose: results };
  return {};
}

/* ---------- the answers ---------- */
const appUrl = (env) => (env.APP_URL || 'https://erp.docbrisk.com').replace(/\/$/, '');
async function shareLinks(c, rows, lang) {
  const missing = rows.filter((d) => !d.share_token);
  if (missing.length) {
    await c.db.batch(missing.map((d) => { d.share_token = randomHex(12); return c.db.prepare(`UPDATE docs SET share_token = ? WHERE id = ? AND share_token IS NULL`).bind(d.share_token, d.id); }));
    const fresh = await c.db.batch(missing.map((d) => c.db.prepare(`SELECT share_token FROM docs WHERE id = ?`).bind(d.id)));
    missing.forEach((d, i) => { d.share_token = fresh[i].results[0].share_token; });
  }
  for (const d of rows) d.link = `${appUrl(c.env)}/i/${d.share_token}${lang === 'hl' ? '' : '?l=' + lang}`;
  return rows;
}
async function openBills(c, org, party, lang, n) {
  const [rows, sum] = await c.db.batch([
    c.db.prepare(`SELECT id, number, date, due_date, total - paid AS due, share_token FROM docs WHERE org_id = ? AND party_id = ? AND type = 'INV' AND status IN ('unpaid','partial')
      ORDER BY COALESCE(due_date, date), id LIMIT ?`).bind(org.id, party.id, n),
    c.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total - paid), 0) AS due FROM docs WHERE org_id = ? AND party_id = ? AND type = 'INV' AND status IN ('unpaid','partial')`).bind(org.id, party.id),
  ]);
  return { rows: await shareLinks(c, rows.results, lang), n: sum.results[0].n, due: sum.results[0].due };
}
async function hisabText(c, org, party, lang) {
  const L = T[lang], first = (party.name || '').split(' ')[0];
  const [open, kh] = await Promise.all([openBills(c, org, party, lang, 5),
    c.db.prepare(`SELECT COALESCE(SUM(CASE WHEN status = 'sent' THEN (CASE WHEN kind = 'gave' THEN amount ELSE -amount END) ELSE 0 END), 0) AS b FROM khata WHERE party_id = ?`).bind(party.id).first()]);
  const kbal = kh.b || 0;
  if (open.due <= 0 && kbal <= 0) return L.clear(org.name, first);
  const out = [`*${org.name}*`, `${party.name}`];
  if (open.due > 0) {
    out.push('', `${L.bills}: ${inr(open.due)} ${L.due} (${open.n})`);
    for (const d of open.rows) out.push(`• ${d.number}, ${fdate(d.date)}: ${inr(d.due)} ${d.link}`);
    if (open.n > open.rows.length) out.push(`  + ${open.n - open.rows.length}`);
  }
  if (kbal > 0) {
    let tok = party.khata_token;
    if (!tok) {
      await c.db.prepare(`UPDATE parties SET khata_token = ? WHERE id = ? AND (khata_token IS NULL OR khata_token = '')`).bind(randomHex(12), party.id).run();
      tok = (await c.db.prepare(`SELECT khata_token FROM parties WHERE id = ?`).bind(party.id).first()).khata_token;
    }
    out.push('', `${L.khata}: ${inr(kbal)} ${L.due} ${appUrl(c.env)}/k/${tok}`);
  }
  out.push('', `*${L.total}: ${inr(open.due + kbal)}*`, L.pay);
  return out.join('\n');
}
async function billsText(c, org, party, lang) {
  const L = T[lang];
  const { results } = await c.db.prepare(`SELECT id, number, date, total, paid, status, share_token FROM docs WHERE org_id = ? AND party_id = ? AND type = 'INV' AND status != 'cancelled'
      ORDER BY date DESC, id DESC LIMIT 5`).bind(org.id, party.id).all();
  if (!results.length) return `*${org.name}*\n${L.noBills}`;
  await shareLinks(c, results, lang);
  return [`*${org.name}*`, `${L.lastBills}:`, ...results.map((d) => `• ${d.number}, ${fdate(d.date)}: ${inr(d.total)}${d.paid >= d.total ? ` (${L.paid})` : d.paid > 0 ? ` (${inr(d.total - d.paid)} ${L.due})` : ''} ${d.link}`)].join('\n');
}

/* ---------- the shop's side: settings and inbox ---------- */
/* PUT /api/settings/wa-bot { on } */
export async function setBot(c, on) {
  requireCan(c.user, 'settings');
  if (on && !botReady(c.env)) throw bad('The WhatsApp bot is not set up on this server yet (WhatsApp secrets). Ask SmartTrader support.');
  let code = c.org.bot_code;
  const st = [];
  if (on && !code) { code = randomHex(3).toUpperCase(); st.push(c.db.prepare(`UPDATE orgs SET bot_code = ? WHERE id = ? AND bot_code IS NULL`).bind(code, c.org.id)); }
  st.push(c.db.prepare(`UPDATE orgs SET wa_bot = ? WHERE id = ?`).bind(on ? 1 : 0, c.org.id), auditStatement(c, 'whatsapp bot', on ? 'on' : 'off'));
  await c.db.batch(st);
  const o = await c.db.prepare(`SELECT wa_bot, bot_code FROM orgs WHERE id = ?`).bind(c.org.id).first();
  return { on: !!o.wa_bot, code: o.bot_code, link: botLink(c.env, o.bot_code) };
}

const mayAnswer = (u) => can(u, 'sales') || can(u, 'khata') || can(u, 'finance');
/* GET /api/wa/inbox: one row per customer, newest first, with what is waiting for an answer */
export async function inbox(c) {
  const { results } = await c.db.prepare(`SELECT m.phone, MAX(m.id) AS last_id, MAX(m.party_id) AS party_id,
      SUM(CASE WHEN m.dir = 'in' AND m.kind = 'ask' AND m.handled = 0 THEN 1 ELSE 0 END) AS waiting,
      MAX(CASE WHEN m.dir = 'in' THEN m.at END) AS last_in
      FROM wa_messages m WHERE m.org_id = ? GROUP BY m.phone ORDER BY last_id DESC LIMIT 100`).bind(c.org.id).all();
  if (!results.length) return { rows: [], waiting: 0 };
  const ids = results.map((r) => r.last_id), pids = [...new Set(results.map((r) => r.party_id).filter(Boolean))];
  const [last, parties] = await c.db.batch([
    c.db.prepare(`SELECT id, dir, body, kind, at FROM wa_messages WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids),
    c.db.prepare(`SELECT id, name FROM parties WHERE org_id = ? AND id IN (${pids.length ? pids.map(() => '?').join(',') : 'NULL'})`).bind(c.org.id, ...pids),
  ]);
  const lm = new Map(last.results.map((x) => [x.id, x])), pm = new Map(parties.results.map((x) => [x.id, x.name]));
  const open = ago(23.5 * 3600e3);
  const rows = results.map((r) => ({ phone: r.phone, party_id: r.party_id, name: pm.get(r.party_id) || '', waiting: r.waiting, last: lm.get(r.last_id) || null,
    window_open: !!(r.last_in && r.last_in > open) }));
  return { rows, waiting: rows.filter((r) => r.waiting).length };
}
/* GET /api/wa/inbox/:phone */
export async function thread(c, phone) {
  phone = String(phone).replace(/\D/g, '');
  const { results } = await c.db.prepare(`SELECT id, dir, body, kind, handled, at, by_user FROM wa_messages WHERE org_id = ? AND phone = ? ORDER BY id DESC LIMIT 200`).bind(c.org.id, phone).all();
  if (!results.length) throw notFound('No messages with this number.');
  const lastIn = results.find((m) => m.dir === 'in');
  const party = mobile10(phone) ? await c.db.prepare(`SELECT id, name, phone, wa_optout FROM parties WHERE org_id = ? AND phone10 = ? ORDER BY (kind = 'supplier'), id LIMIT 1`).bind(c.org.id, mobile10(phone)).first() : null;
  return { phone, party, messages: results.reverse(), window_open: !!(lastIn && lastIn.at > ago(23.5 * 3600e3)) };
}
/* POST /api/wa/inbox/:phone/reply { text }: free, within 24 hours of the customer's last message to this shop */
export async function reply(c, phone, body) {
  if (!mayAnswer(c.user)) throw forbidden();
  if (!botReady(c.env)) throw bad('The WhatsApp bot is not set up on this server.');
  phone = String(phone).replace(/\D/g, '');
  const text = str(body.text, 1500);
  if (!text) throw bad('Type a reply.');
  const lastIn = await c.db.prepare(`SELECT party_id, at FROM wa_messages WHERE org_id = ? AND phone = ? AND dir = 'in' ORDER BY id DESC LIMIT 1`).bind(c.org.id, phone).first();
  if (!lastIn) throw notFound('No messages with this number.');
  if (lastIn.at <= ago(23.5 * 3600e3)) throw bad('More than 24 hours since the customer wrote: WhatsApp allows only an approved template now. Call them, or send a reminder from Vasooli.');
  await rateLimit(c.env, 'wareply:' + c.org.id, 300, 3600);
  const msg = `*${c.org.name}*\n${text}`, now = nowIso();
  await sendText(c.env, phone, msg);
  await c.db.batch([
    c.db.prepare(`INSERT INTO wa_messages (org_id, party_id, phone, dir, body, kind, handled, by_user, at) VALUES (?, ?, ?, 'out', ?, 'reply', 1, ?, ?)`).bind(c.org.id, lastIn.party_id, phone, msg, c.user.id, now),
    c.db.prepare(`UPDATE wa_messages SET handled = 1 WHERE org_id = ? AND phone = ? AND dir = 'in' AND handled = 0`).bind(c.org.id, phone),
    // the customer's next message comes back to this shop
    c.db.prepare(`INSERT INTO wa_contacts (phone, org_id, party_id, last_out, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET org_id = excluded.org_id, party_id = excluded.party_id, choices = NULL, last_out = excluded.last_out, updated_at = excluded.updated_at`)
      .bind(phone, c.org.id, lastIn.party_id, now, now),
  ]);
  return thread(c, phone);
}
/* POST /api/wa/inbox/:phone/done: answered another way (a call, in person) */
export async function markDone(c, phone) {
  if (!mayAnswer(c.user)) throw forbidden();
  await c.db.prepare(`UPDATE wa_messages SET handled = 1 WHERE org_id = ? AND phone = ? AND dir = 'in' AND handled = 0`).bind(c.org.id, String(phone).replace(/\D/g, '')).run();
  return { ok: true };
}
