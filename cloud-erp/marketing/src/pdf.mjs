import { chromium } from '/tmp/claude-0/pw/node_modules/playwright-core/index.mjs';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage(); await p.goto('file:///tmp/claude-0/guide/guide.html'); await p.waitForTimeout(500);
await p.pdf({ path: '/home/user/Operation-structure-Project/cloud-erp/marketing/SmartTrader-ERP-User-Guide.pdf', format: 'A4', printBackground: true, preferCSSPageSize: true });
await b.close();
