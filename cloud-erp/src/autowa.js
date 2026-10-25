/* Automatic payment reminders on WhatsApp, with no tap: for a business that turned it on (Growth plan and above), every
   morning (10:00 to 13:00 India time, a few at a time each hour) the customers the Vasooli schedule says are due today
   get the approved reminder template from SmartTrader's WhatsApp Business number, with a link to their bills and UPI.
   Each one sent goes into reminder_log (via 'auto'), so the schedule moves on and nobody gets two in a day.
   Needs the WHATSAPP_TOKEN and WHATSAPP_PHONE_ID secrets (Meta WhatsApp Cloud API) and an approved Utility template
   (README: "Automatic WhatsApp reminders"). WHATSAPP_API overrides the Graph address (tests). */
import { today, nowIso, addDays } from './lib.js';
import { randomHex } from './auth.js';
import { queue } from './vasooli.js';
import { hasFeature } from './saas.js';

export const waConfigured = (env) => !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID);
const PER_ORG = 25, PER_RUN = 40;
const inr = (p) => '₹' + (Math.round(p) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/* a 10-digit Indian mobile (with or without +91 / 0) as WhatsApp wants it: 91XXXXXXXXXX */
export function waNumber(phone) {
  const d = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
  const n = d.length === 12 && d.startsWith('91') ? d.slice(2) : d;
  return /^[6-9]\d{9}$/.test(n) ? '91' + n : '';
}

/* one template message; the body has 4 parameters: customer, business, amount, link */
export async function sendReminder(env, to, lang, params) {
  const base = (env.WHATSAPP_API || 'https://graph.facebook.com/v21.0').replace(/\/$/, '');
  const code = lang === 'hi' ? env.WHATSAPP_LANG_HI || 'hi' : lang === 'en' ? env.WHATSAPP_LANG_EN || 'en' : env.WHATSAPP_LANG_HL || env.WHATSAPP_LANG_EN || 'en';
  const res = await fetch(`${base}/${env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template',
      template: { name: env.WHATSAPP_TEMPLATE || 'payment_reminder', language: { code },
        components: [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t).slice(0, 200) })) }] } }),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* not json */ }
  if (!res.ok) throw new Error((data.error && data.error.message) || `WhatsApp said ${res.status}`);
  return data.messages && data.messages[0] ? data.messages[0].id : '';
}

/* a plain text message: allowed (and free) only within 24 hours of the customer's own last message to this number */
export async function sendText(env, to, body) {
  const base = (env.WHATSAPP_API || 'https://graph.facebook.com/v21.0').replace(/\/$/, '');
  const res = await fetch(`${base}/${env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body: String(body).slice(0, 4000) } }),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* not json */ }
  if (!res.ok) throw new Error((data.error && data.error.message) || `WhatsApp said ${res.status}`);
  return data.messages && data.messages[0] ? data.messages[0].id : '';
}
/* the customer wrote to this number within the last 24 hours (minus a margin): text replies cost nothing */
export async function windowOpen(db, to) {
  const ct = await db.prepare(`SELECT last_in FROM wa_contacts WHERE phone = ?`).bind(to).first();
  return !!(ct && ct.last_in && Date.parse(ct.last_in) > Date.now() - 23.5 * 3600e3);
}
const REMIND_TEXT = {
  en: (n, s, a, l) => `*${s}*\nHello ${n}, ${a} is due. Your bills and UPI payment: ${l}\nReply HISAB for your account, STOP to stop reminders.`,
  hi: (n, s, a, l) => `*${s}*\nनमस्ते ${n} जी, आपके ${a} बाकी हैं। बिल और UPI से भुगतान: ${l}\nहिसाब के लिए HISAB लिखें, रिमाइंडर बंद करने के लिए STOP.`,
  hl: (n, s, a, l) => `*${s}*\nNamaste ${n} ji, aapke ${a} baaki hain. Bill aur UPI se payment: ${l}\nHisab ke liye HISAB likhein, reminder band karne ke liye STOP.`,
};

/* the customer's link: their oldest unpaid invoice, which lists the bill and the UPI button */
async function linkFor(env, org, partyId, base, lang) {
  const d = await env.DB.prepare(`SELECT id, share_token FROM docs WHERE org_id = ? AND party_id = ? AND type = 'INV' AND status IN ('unpaid','partial')
      ORDER BY COALESCE(due_date, date), id LIMIT 1`).bind(org.id, partyId).first();
  if (!d) return '';
  let tok = d.share_token;
  if (!tok) {
    await env.DB.prepare(`UPDATE docs SET share_token = ? WHERE id = ? AND share_token IS NULL`).bind(randomHex(12), d.id).run();
    tok = (await env.DB.prepare(`SELECT share_token FROM docs WHERE id = ?`).bind(d.id).first()).share_token;
  }
  return `${base}/i/${tok}${lang === 'hl' || !lang ? '' : '?l=' + lang}`;
}

/* send today's reminders for one business; returns { sent, failed, skipped } */
export async function remindOrg(env, org, budget = PER_ORG) {
  const c = { db: env.DB, org, env };
  const t = today(), base = (env.APP_URL || 'https://erp.docbrisk.com').replace(/\/$/, '');
  const { results: done } = await env.DB.prepare(`SELECT DISTINCT party_id FROM reminder_log WHERE org_id = ? AND sent_at >= ?`).bind(org.id, addDays(t, -1) + 'T18:30:00Z').all();
  const already = new Set(done.map((r) => r.party_id));
  // customers who answered STOP get no automatic reminders
  const { results: off } = await env.DB.prepare(`SELECT id FROM parties WHERE org_id = ? AND wa_optout = 1`).bind(org.id).all();
  const stopped = new Set(off.map((r) => r.id));
  const out = { sent: 0, free: 0, failed: 0, skipped: 0, errors: [], complete: true };
  for (const r of await queue(c)) {
    if (out.sent + out.failed >= budget) { out.complete = false; break; }
    if (r.status !== 'due' || already.has(r.party_id)) continue;
    const to = waNumber(r.phone);
    if (!to || stopped.has(r.party_id)) { out.skipped++; continue; }
    const lang = r.lang || org.msg_lang || 'hl';
    try {
      const link = await linkFor(env, org, r.party_id, base, lang);
      // a customer who wrote to us in the last 24 hours gets it as a free text; the others get the (paid) approved template
      const free = await windowOpen(env.DB, to), body = (REMIND_TEXT[lang] || REMIND_TEXT.hl)(r.name, org.name, inr(r.due * 100), link);
      if (free) await sendText(env, to, body); else await sendReminder(env, to, lang, [r.name, org.name, inr(r.due * 100), link]);
      const now = nowIso();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO reminder_log (org_id, party_id, step, via, lang, user_id, sent_at) VALUES (?, ?, ?, 'auto', ?, NULL, ?)`).bind(org.id, r.party_id, r.step ?? 0, lang, now),
        // the customer's answer to this reminder comes back to this shop (src/wabot.js)
        env.DB.prepare(`INSERT INTO wa_contacts (phone, org_id, party_id, last_out, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(phone) DO UPDATE SET org_id = excluded.org_id, party_id = excluded.party_id, choices = NULL, last_out = excluded.last_out, updated_at = excluded.updated_at`)
          .bind(to, org.id, r.party_id, now, now),
        env.DB.prepare(`INSERT INTO wa_messages (org_id, party_id, phone, dir, body, kind, handled, at) VALUES (?, ?, ?, 'out', ?, 'reminder', 1, ?)`).bind(org.id, r.party_id, to, body, now),
      ]);
      out.sent++; if (free) out.free++;
    } catch (e) { out.failed++; if (out.errors.length < 3) out.errors.push(`${r.name}: ${e.message}`.slice(0, 160)); }
  }
  // a business with more to send than this run allows is picked up again next hour (the note then starts "more ")
  const note = `${out.complete ? t : 'more ' + t}: ${out.sent} sent${out.free ? ` (${out.free} free, inside the customer's 24 hours)` : ''}${out.failed ? `, ${out.failed} failed (${out.errors.join('; ')})` : ''}${out.skipped ? `, ${out.skipped} skipped (no mobile number or reminders stopped)` : ''}`;
  await env.DB.prepare(`UPDATE orgs SET auto_wa_note = ? WHERE id = ?`).bind(note.slice(0, 500), org.id).run();
  return out;
}

/* the hourly job: 10:00 to 13:00 India time, the businesses that turned it on, a few each run */
export async function runAutoReminders(env, { force = false } = {}) {
  if (!waConfigured(env)) return { due: 0 };
  const hour = new Date(Date.now() + 5.5 * 3600e3).getUTCHours();
  if (!force && (hour < 10 || hour > 13)) return { due: 0 };
  const t = today();
  const { results: orgs } = await env.DB.prepare(`SELECT * FROM orgs WHERE auto_wa = 1 AND COALESCE(substr(auto_wa_note, 1, 10), '') != ? ORDER BY id LIMIT 20`).bind(t).all();
  let left = PER_RUN, sent = 0;
  for (const org of orgs) {
    if (left <= 0) break;
    if (!hasFeature(org, 'autowa')) continue;
    const r = await remindOrg(env, org, Math.min(PER_ORG, left));
    left -= r.sent + r.failed; sent += r.sent;
  }
  return { due: orgs.length, sent };
}
