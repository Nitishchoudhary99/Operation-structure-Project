// Fails when a tracked file looks like it holds a live secret: payment, cloud, chat or mail API keys, private keys,
// tokens. Public identifiers (a Razorpay key *id*, a UPI ID) are not secrets and are not matched.
// Run: node tools/secret-scan.mjs      (in CI on every push; secrets belong in Cloudflare secrets, never in the repo)
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
const PATTERNS = [
  ['Razorpay key secret', /\brzp_(live|test)_[A-Za-z0-9]{14,}\b[^\n]{0,40}(secret|SECRET)|key_secret["'\s:=]+[A-Za-z0-9]{20,}/],
  ['Stripe secret key', /\bsk_live_[A-Za-z0-9]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Private key', /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Resend API key', /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}\b/],
  ['Cloudflare API token assignment', /CLOUDFLARE_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{30,}/],
  ['WhatsApp / Meta access token', /(?<![A-Za-z0-9+/])EAA[A-Za-z0-9]{60,}(?![A-Za-z0-9+/=])/],   // not inside base64 data
  ['Generic secret assignment', /\b(SESSION_SECRET|ADMIN_KEY|WEBHOOK_SECRET|API_SECRET|PW_PEPPER)\s*[=:]\s*["'][^"'\s]{12,}["']/],
];
const files = execSync('git ls-files -z', { encoding: 'utf8' }).split('\0').filter(Boolean);
let hits = 0;
for (const f of files) {
  if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|wasm|onnx|gz|zip|mp4|eml)$/i.test(f) || /\.min\.(m?js)$/.test(f) || /(^|\/)vendor\//.test(f)) continue;
  let text;
  try { if (statSync(f).size > 5e6) continue; text = readFileSync(f, 'utf8'); } catch (e) { continue; }
  text.split('\n').forEach((line, n) => {
    for (const [name, re] of PATTERNS) {
      const m = line.match(re);
      // made-up values in tests and examples are not secrets
      if (m && !/test|example|dummy|sample|placeholder|changeme|your[-_]|x{4,}|\.\.\./i.test(m[0])) { hits++; console.log(`${f}:${n + 1}: looks like a ${name}`); }
    }
  });
}
console.log(hits ? `\n${hits} possible secret(s). Move them to Cloudflare secrets and rotate them.` : `No secrets found in ${files.length} tracked files.`);
process.exit(hits ? 1 : 0);
