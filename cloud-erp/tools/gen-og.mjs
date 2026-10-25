/* The link-preview posters WhatsApp shows under a customer link (1200 x 630), in English, Hindi and Hinglish:
   public/og-{invoice,khata,confirm}[-en|-hi].png (no suffix = Hinglish). Run: node tools/gen-og.mjs <dir with
   noto-sans-devanagari-devanagari-{400,700}-normal.woff2> (from @fontsource/noto-sans-devanagari). Needs Playwright. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');   // a global install works too
const fontDir = process.argv[2];
if (!fontDir) { console.error('usage: node tools/gen-og.mjs <font dir>'); process.exit(1); }
const font = (w) => readFileSync(join(fontDir, `noto-sans-devanagari-devanagari-${w}-normal.woff2`)).toString('base64');
const icon = readFileSync(new URL('../public/icons/icon-192.png', import.meta.url)).toString('base64');

const T = {
  invoice: {
    hl: ['Aapka GST Bill', 'Dekhein, PDF download karein, pay karein.', ['View', 'Download PDF', 'UPI se pay'], ['GST invoice', 'PDF download', 'UPI payment', 'Secure link']],
    en: ['Your GST Invoice', 'View it, download the PDF, pay by UPI.', ['View', 'Download PDF', 'Pay by UPI'], ['GST invoice', 'PDF download', 'UPI payment', 'Secure link']],
    hi: ['आपका GST बिल', 'देखें, PDF डाउनलोड करें, भुगतान करें।', ['देखें', 'PDF डाउनलोड', 'UPI से भुगतान'], ['GST बिल', 'PDF डाउनलोड', 'UPI भुगतान', 'सुरक्षित लिंक']],
  },
  khata: {
    hl: ['Aapka Digital Khata', 'Har entry aapke paas, har hisaab saaf.', ['Dekhein', 'Confirm karein', 'UPI se pay'], ['Har udhaar', 'Har payment', 'Live balance', 'Aapka confirm']],
    en: ['Your Digital Khata', 'Every entry with you, every account clear.', ['View', 'Confirm', 'Pay by UPI'], ['Every credit', 'Every payment', 'Live balance', 'Your confirmation']],
    hi: ['आपका डिजिटल खाता', 'हर एंट्री आपके पास, हर हिसाब साफ़।', ['देखें', 'पुष्टि करें', 'UPI से भुगतान'], ['हर उधार', 'हर भुगतान', 'लाइव बकाया', 'आपकी पुष्टि']],
  },
  confirm: {
    hl: ['Balance Confirmation', 'Apna baaki check karein, ek tap mein confirm.', ['Sahi hai ✓', 'Kuch galat hai', 'UPI se pay'], ['Saare bills', 'Total baaki', 'Ek tap jawaab', 'Secure link']],
    en: ['Balance Confirmation', 'Check your balance, confirm with one tap.', ['Correct ✓', 'Something is wrong', 'Pay by UPI'], ['All open bills', 'Total due', 'One-tap answer', 'Secure link']],
    hi: ['बकाया की पुष्टि', 'अपना बकाया जाँचें, एक टैप में पुष्टि करें।', ['सही है ✓', 'कुछ गलत है', 'UPI से भुगतान'], ['सभी बिल', 'कुल बकाया', 'एक टैप जवाब', 'सुरक्षित लिंक']],
  },
};
const foot = { hl: 'Secure private link  ·  Pay by any UPI app', en: 'Secure private link  ·  Pay by any UPI app', hi: 'सुरक्षित निजी लिंक  ·  किसी भी UPI ऐप से भुगतान' };

const page = (lang, [title, sub, pills, ticks]) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Dev; font-weight: 400; src: url(data:font/woff2;base64,${font(400)}) format('woff2'); }
@font-face { font-family: Dev; font-weight: 700; src: url(data:font/woff2;base64,${font(700)}) format('woff2'); }
* { box-sizing: border-box; margin: 0; }
body { width: 1200px; height: 630px; font-family: 'DejaVu Sans', Dev, sans-serif; color: #fff; background: linear-gradient(180deg, #0f766e 0%, #0e4f4c 55%, #0b1a24 100%); position: relative; overflow: hidden; }
.brand { position: absolute; left: 70px; top: 64px; display: flex; align-items: center; gap: 22px; }
.brand img { width: 82px; height: 82px; border-radius: 16px; box-shadow: 0 0 0 3px rgba(255,255,255,.9); }
.brand b { font-size: 42px; display: block; letter-spacing: .5px; } .brand span { font-size: 22px; opacity: .85; }
h1 { position: absolute; left: 70px; top: 205px; font-size: ${title.length > 16 ? 52 : 62}px; font-weight: 700; white-space: nowrap; line-height: 1.15; }
.sub { position: absolute; left: 72px; top: 296px; font-size: 27px; opacity: .92; max-width: 700px; }
.pills { position: absolute; left: 70px; top: 371px; display: flex; gap: 13px; }
.pills span { background: #fff; color: #0f766e; font-weight: 700; font-size: 24px; padding: 10px 21px; border-radius: 26px; }
.card { position: absolute; right: 70px; top: 190px; width: 311px; background: #fff; border-radius: 22px; padding: 18px 28px; color: #334155; }
.card div { display: flex; justify-content: space-between; font-size: 24px; padding: 19px 0 17px; border-bottom: 2px solid #e5e7eb; }
.card div:last-child { border: 0; } .card i { color: #15803d; font-style: normal; }
.foot { position: absolute; left: 70px; bottom: 60px; font-size: 23px; opacity: .8; }
</style></head><body>
<div class="brand"><img src="data:image/png;base64,${icon}"><div><b>SmartTrader ERP</b><span>by DocBrisk  ·  erp.docbrisk.com</span></div></div>
<h1>${title}</h1><div class="sub">${sub}</div>
<div class="pills">${pills.map((p) => `<span>${p}</span>`).join('')}</div>
<div class="card">${ticks.map((t) => `<div>${t}<i>✓</i></div>`).join('')}</div>
<div class="foot">${foot[lang]}</div></body></html>`;

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1200, height: 630 } });
for (const [kind, langs] of Object.entries(T)) {
  for (const [lang, text] of Object.entries(langs)) {
    await p.setContent(page(lang, text));
    await p.evaluate(() => document.fonts.ready);
    const out = new URL(`../public/og-${kind}${lang === 'hl' ? '' : '-' + lang}.png`, import.meta.url);
    await p.screenshot({ path: out.pathname });
    console.log('wrote', out.pathname.split('/').pop());
  }
}
await browser.close();
