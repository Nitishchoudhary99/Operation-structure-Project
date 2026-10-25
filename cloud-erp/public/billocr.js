/* Reading a supplier's bill on the phone itself, free and private: nothing is sent anywhere.
   - A PDF that has text (most e-invoices) is read exactly with pdf.js; a scanned PDF page or a photo is read with
     Tesseract OCR (both self-hosted in /vendor; the first use downloads about 7 MB, then it works offline too).
   - The text is then understood with rules for Indian GST bills: the supplier's GSTIN (OCR slips such as O/0 are
     corrected and the GSTIN check digit must match), bill number and date, item rows (a row is a line whose numbers
     include quantity x rate = amount), GST rates and the bill total.
   - Rows are matched to this business's items and the supplier to its suppliers, in the same shape the review sheet
     in app.js shows. */
const TESS = '/vendor/tesseract';
const GST_SLABS = [0, 0.25, 3, 5, 12, 18, 28, 40];
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const UNITS = /^(pcs?|nos?|no|kgs?|kg|gm?s?|ltrs?|l|ml|box(es)?|bags?|btl|bottles?|pkts?|packs?|dozen|doz|mtrs?|m|pairs?|sets?|tins?|units?|strips?|tabs?|cartons?|ctn)\.?$/i;
const SKIP = /\b(sub\s*total|grand\s*total|total|taxable|cgst|sgst|igst|utgst|cess|round(ed)?\s*off|amount\s*in\s*words|rupees|bank|ifsc|a\/c|account|gstin|invoice|bill\s*no|date|phone|mobile|e-?mail|state\s*code|place\s*of\s*supply|terms|declaration|signature|authori[sz]ed|thank|e\.?\s*&\s*o\.?\s*e|discount|freight)\b/i;
const r2 = (x) => Math.round(x * 100) / 100;

function loadScript(src) {
  return new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok;
    s.onerror = () => no(new Error('Could not load the bill reader. Open this once with internet; after that it works offline too.'));
    document.head.appendChild(s);
  });
}

/* a photo made easier to read: long side about 2200 px, black on white by the brightness around each spot (so a shadow
   across the bill does not hide its text), and the table's ruled lines taken out (they break the rows apart) */
/* how much the photo is turned (degrees): the angle at which the rows of ink line up best, found on a small copy */
function skewOf(img) {
  const k = 600 / Math.max(img.width, img.height), w = Math.round(img.width * k), h = Math.round(img.height * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data, xs = [], ys = [];
  // ink = darker than its surroundings (letters and rules), so a dark table top or a shadow does not count
  const sum = new Float64Array((w + 1) * (h + 1)), r = 6;
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += px[(y * w + x) * 4 + 1]; sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row; } }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const mean = (sum[y1 * (w + 1) + x1] - sum[y0 * (w + 1) + x1] - sum[y1 * (w + 1) + x0] + sum[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      if (px[(y * w + x) * 4 + 1] < mean * 0.8) { xs.push(x); ys.push(y); }
    }
  }
  if (xs.length < 200) return 0;
  let best = 0, bestScore = -1;
  for (let a = -5; a <= 5.001; a += 0.25) {
    const t = a * Math.PI / 180, sn = Math.sin(t), cs = Math.cos(t), bins = new Float64Array(h * 2 + w);
    for (let i = 0; i < xs.length; i++) bins[Math.round(ys[i] * cs - xs[i] * sn) + w]++;
    let score = 0; for (const b of bins) score += b * b;
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return best;
}

async function prepare(source) {
  const img = source instanceof HTMLCanvasElement ? source : await createImageBitmap(source);
  const k = Math.min(2.5, 2200 / Math.max(img.width, img.height));
  const cv = document.createElement('canvas');
  const W = cv.width = Math.round(img.width * k), H = cv.height = Math.round(img.height * k);
  const g = cv.getContext('2d', { willReadFrequently: true });
  // turned straight first, so ruled lines run along whole rows and text lines stay on one line
  const skew = skewOf(img);
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.translate(W / 2, H / 2); g.rotate(-skew * Math.PI / 180); g.translate(-W / 2, -H / 2);
  g.drawImage(img, 0, 0, W, H);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const d = g.getImageData(0, 0, W, H), px = d.data, N = W * H;
  const grey = new Uint8Array(N), sum = new Float64Array((W + 1) * (H + 1));
  for (let i = 0; i < N; i++) grey[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000 | 0;
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += grey[y * W + x]; sum[(y + 1) * (W + 1) + x + 1] = sum[y * (W + 1) + x + 1] + row; } }
  const r = Math.max(8, W / 48 | 0), ink = new Uint8Array(N), flat = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const mean = (sum[y1 * (W + 1) + x1] - sum[y0 * (W + 1) + x1] - sum[y1 * (W + 1) + x0] + sum[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      ink[y * W + x] = grey[y * W + x] < mean * 0.85 ? 1 : 0;
      // the page lit evenly: each spot against the brightness around it (a shadow becomes white paper again),
      // keeping the soft edges of letters, which the reader needs on a blurred photo
      flat[y * W + x] = Math.min(255, 255 * grey[y * W + x] / Math.max(1, mean * 1.08)) | 0;
    }
  }
  // ruled lines: dark runs much longer than any letter (small breaks in a line are bridged)
  const minH = W * 0.15, minV = H * 0.06, GAP = 4, kill = new Uint8Array(N);
  const sweep = (len, other, at, minRun) => {
    for (let a = 0; a < other; a++) {
      let start = -1, last = -1;
      for (let b = 0; b <= len; b++) {
        const on = b < len && ink[at(a, b)];
        if (on) { if (start < 0) start = b; last = b; } else if (start >= 0 && b - last > GAP) {
          if (last - start + 1 >= minRun) for (let i = start; i <= last; i++) { kill[at(a, i)] = 1; if (a + 1 < other) kill[at(a + 1, i)] = 1; if (a > 0) kill[at(a - 1, i)] = 1; }
          start = -1;
        }
      }
    }
  };
  sweep(W, H, (y, x) => y * W + x, minH);     // rows
  sweep(H, W, (x, y) => y * W + x, minV);     // columns
  for (let i = 0; i < N; i++) { const v = kill[i] ? 255 : flat[i]; px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; px[i * 4 + 3] = 255; }
  g.putImageData(d, 0, 0);
  return cv;
}

/* the reader may split a table into column blocks: its words are put back into lines by their height on the page
   (the photo is already straight), left to right, with a wide gap kept as two spaces */
function wordsToLines(data) {
  const ws = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) {
    if (w.text && w.text.trim()) ws.push({ t: w.text, x0: w.bbox.x0, x1: w.bbox.x1, yc: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0 });
  }
  if (!ws.length) return '';
  const hs = ws.map((w) => w.h).sort((a, b) => a - b), mh = hs[hs.length >> 1] || 10;
  ws.sort((a, b) => a.yc - b.yc);
  const lines = [];
  for (const w of ws) {
    const l = lines[lines.length - 1];
    if (l && Math.abs(w.yc - l.yc) <= mh * 0.55) { l.ws.push(w); l.yc = (l.yc * (l.ws.length - 1) + w.yc) / l.ws.length; } else lines.push({ yc: w.yc, ws: [w] });
  }
  return lines.map((l) => {
    l.ws.sort((a, b) => a.x0 - b.x0);
    let s = '', end = null;
    for (const w of l.ws) { s += end === null ? '' : w.x0 - end > mh * 1.2 ? '  ' : ' '; s += w.t; end = w.x1; }
    return s;
  }).join('\n');
}

async function ocr(sources, onProgress) {
  if (!window.Tesseract) await loadScript(`${TESS}/tesseract.min.js`);
  const worker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: `${TESS}/worker.min.js`, corePath: TESS, langPath: TESS, workerBlobURL: false, gzip: true,
    logger: (m) => { if (onProgress && m.status === 'recognizing text') onProgress(m.progress); },
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '4', preserve_interword_spaces: '1' });     // a single column of lines of varying size
    let text = '';
    for (const s of sources) {
      const { data } = await worker.recognize(s, {}, { text: true, blocks: true });
      text += (wordsToLines(data) || data.text) + '\n';
    }
    return text;
  } finally { await worker.terminate(); }
}

/* the text of a PDF, line by line (items on one baseline joined left to right); scanned pages are read by OCR */
async function pdfText(file, onProgress) {
  const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const pages = Math.min(doc.numPages, 3), out = [], scans = [];
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p), tc = await page.getTextContent();
    const items = tc.items.filter((i) => i.str && i.str.trim()).map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0 }));
    if (items.reduce((n, i) => n + i.s.trim().length, 0) < 40) {        // no text layer: a scanned page
      const vp = page.getViewport({ scale: 2.5 }), cv = document.createElement('canvas');
      cv.width = vp.width; cv.height = vp.height;
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      scans.push(cv); continue;
    }
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of items) {
      const l = lines.find((x) => Math.abs(x.y - it.y) <= 2.5);
      if (l) l.items.push(it); else lines.push({ y: it.y, items: [it] });
    }
    for (const l of lines.sort((a, b) => b.y - a.y)) {
      let s = '', end = null;
      for (const it of l.items.sort((a, b) => a.x - b.x)) { s += (end !== null && it.x - end > 1.5 ? '  ' : '') + it.s; end = it.x + it.w; }
      out.push(s);
    }
  }
  if (scans.length) out.push(...(await ocr(await Promise.all(scans.map(prepare)), onProgress)).split('\n'));
  return out.join('\n');
}

/* ---------- understanding the text ---------- */
const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstinValid(g) {
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) { const p = CH.indexOf(g[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); }
  return CH[(36 - (sum % 36)) % 36] === g[14];
}
const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
const TO_LETTER = { 0: 'O', 1: 'I', 5: 'S', 8: 'B', 2: 'Z', 6: 'G' };
function fixGstin(s) {
  const c = s.split('');
  for (const i of [0, 1, 7, 8, 9, 10]) c[i] = TO_DIGIT[c[i]] || c[i];
  for (const i of [2, 3, 4, 5, 6, 11]) c[i] = TO_LETTER[c[i]] || c[i];
  if (c[13] === '2') c[13] = 'Z';
  const g = c.join('');
  return gstinValid(g) ? g : '';
}
export function findGstins(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.toUpperCase().replace(/[^0-9A-Z]/g, '');
    for (let i = 0; i + 15 <= s.length; i++) {
      let g = fixGstin(s.slice(i, i + 15));
      // OCR sometimes reads one extra character inside it: try the 16 characters here without each one
      for (let j = 0; !g && j < 16 && i + 16 <= s.length; j++) { const w = s.slice(i, i + 16); g = fixGstin(w.slice(0, j) + w.slice(j + 1)); }
      if (g && !out.includes(g)) { out.push(g); i += 14; }
    }
  }
  return out;
}
export function isoDate(s) {
  let m = s.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?[\s.-]*([A-Za-z]{3,4})[a-z]*[\s.,-]*(\d{4}|\d{2})\b/);
  if (m && MON[m[2].toLowerCase()]) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return `${y}-${String(MON[m[2].toLowerCase()]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return m ? m[0] : '';
}
/* the numbers of a line, in order: 1,23,456.50 -> 123456.5; "18%" marked as a percent */
function numbersOf(line) {
  const out = [], re = /(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,3})?|\d+(?:\.\d{1,3})?)(\s*%)?/g;
  let m;
  while ((m = re.exec(line))) {
    const before = line[m.index - 1] || ' ', after = line[m.index + m[0].length] || ' ';
    if (/[A-Za-z]/.test(before) || /[A-Za-z/]/.test(after) && !m[2]) continue;      // part of a code (HSN-like words, batch, date)
    out.push({ v: parseFloat(m[1].replace(/,/g, '')), raw: m[1], at: m.index, dec: m[1].includes('.'), pct: !!m[2] });
  }
  return out;
}
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w.length > 1);
/* how alike two names are: shared words, or (for OCR that joined or dropped letters, "LEDBub9W") shared letter pairs */
function likeness(a, b) {
  const A = new Set(words(a)), B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  const pairs = (s) => { const t = s.toLowerCase().replace(/[^a-z0-9]/g, ''), m = new Map(); for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return [m, Math.max(0, t.length - 1)]; };
  const [pa, na] = pairs(a), [pb, nb] = pairs(b);
  let common = 0; for (const [k, c] of pa) common += Math.min(c, pb.get(k) || 0);
  const dice = na + nb ? (2 * common) / (na + nb) : 0;
  return Math.max(n / Math.max(A.size, B.size), dice * 0.9);
}

/* one item row, or null: quantity x rate = amount among its numbers (amount before or after GST) */
function rowOf(line, billGst) {
  // a serial number in front ("1 ", "2.", "3)") is not one of the row's figures
  const lead = (line.match(/^\s*\d{1,3}[.):-]?\s+(?=[A-Za-z])/) || [''])[0].length;
  const nums = numbersOf(line).filter((n) => n.at >= lead);
  if (nums.length < 2) return null;
  const first = nums[0];
  // the name runs up to the HSN or the quantity (so "LED bulb 9 W" keeps its 9)
  const nameTo = (at) => line.slice(lead, at).replace(/[|[\]{}]/g, ' ').replace(/\s+/g, ' ').replace(/[\s:-]+$/, '').trim();
  let name = nameTo(first.at);
  const pcts = nums.filter((n) => n.pct).map((n) => n.v);
  const vals = nums.filter((n) => !n.pct);
  // HSN: a 4, 6 or 8 digit whole number that is not the last figure
  let hsn = '';
  const h = vals.find((n, i) => i < vals.length - 1 && !n.dec && /^\d{4}(\d{2}){0,2}$/.test(n.raw));
  if (h) hsn = h.raw;
  const figs = vals.filter((n) => n !== h);
  let gst = pcts.find((p) => GST_SLABS.includes(p) && p > 0);
  if (gst === undefined && pcts.length >= 2 && pcts[0] === pcts[1] && GST_SLABS.includes(pcts[0] * 2)) gst = pcts[0] * 2;     // CGST 9% + SGST 9%
  if (gst === undefined) gst = billGst;
  let best = null;
  for (let k = figs.length - 1; k >= 1 && !best; k--) {
    const amt = figs[k].v;
    if (!(amt > 0)) continue;
    for (let i = 0; i < k && !best; i++) {
      for (let j = i + 1; j < k && !best; j++) {
        const q = figs[i].v, r = figs[j].v;
        if (!(q > 0 && q <= 1e5 && r > 0)) continue;
        const base = q * r, tol = Math.max(1, amt * 0.015);
        if (Math.abs(base - amt) <= tol) best = { qty: q, rate: r, amount: amt, incl: false, at: figs[i].at };
        else if (gst && Math.abs(base * (1 + gst / 100) - amt) <= tol) best = { qty: q, rate: r, amount: amt, incl: true, at: figs[i].at };
      }
    }
  }
  if (!best) return { name, hsn, nums: figs, gst, weak: true };
  name = nameTo(Math.min(h ? h.at : Infinity, best.at));
  const unitTok = line.slice(first.at).match(/\b([A-Za-z]{1,8})\.?\b/);
  return { name, hsn, qty: best.qty, rate: best.rate, amount: best.amount, gst, unit: unitTok && UNITS.test(unitTok[1]) ? unitTok[1] : '', weak: false };
}

export function parseBill(text, { items = [], parties = [], orgGstin = '' } = {}) {
  // "1,450. 00" read with a space inside is one number
  const lines = text.split('\n').map((l) => l.replace(/(\d)([.,])\s+(\d{2})\b/g, '$1$2$3').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const gstins = findGstins(text).filter((g) => g !== String(orgGstin || '').toUpperCase());
  const gstin = gstins[0] || '';
  // the bill's own GST: "CGST @ 9%" lines (doubled) or "IGST 18%"
  let billGst = 0;
  for (const l of lines) {
    const m = l.match(/\b(cgst|sgst|igst)\b[^%\d]{0,12}(\d{1,2}(?:\.\d+)?)\s*%/i);
    if (m) { const p = +m[2] * (/igst/i.test(m[1]) ? 1 : 2); if (GST_SLABS.includes(p)) { billGst = p; break; } }
  }
  let billNo = '', billDate = '';
  for (const l of lines) {
    if (!billNo) { const m = l.match(/\b(?:invoice|inv|bill|voucher)\s*(?:no|number|#)\.?\s*[:\-.]?\s*([A-Z0-9][A-Z0-9/\-_]{0,24})/i); if (m && /\d/.test(m[1])) billNo = m[1]; }
    if (!billDate && /date|dt\b|dated/i.test(l)) billDate = isoDate(l);
  }
  if (!billDate) for (const l of lines) { const d = isoDate(l); if (d) { billDate = d; break; } }
  // the supplier: by GSTIN, by a known supplier's name in the text, else the first line that looks like a name
  const sups = parties.filter((p) => p.kind !== 'customer');
  let party = gstin ? sups.find((p) => p.gstin && p.gstin.toUpperCase() === gstin) : null;
  if (!party) {
    const top = lines.slice(0, 12).join(' ').toLowerCase();
    party = sups.find((p) => p.name.length > 3 && top.includes(p.name.toLowerCase())) || null;
  }
  const nameLine = lines.slice(0, 8).find((l) => /[A-Za-z]{3}/.test(l) && !/tax\s*invoice|^invoice|bill\s*of\s*supply|original|duplicate|triplicate|gstin|phone|mobile|^\W*$/i.test(l)) || '';
  // rows
  const byName = new Map(items.map((i) => [i.name.toLowerCase(), i]));
  const rows = [];
  for (const l of lines) {
    const r = rowOf(l, billGst);
    if (!r) continue;
    let it = byName.get(r.name.toLowerCase()) || items.find((i) => (i.sku && i.sku.toLowerCase() === r.name.toLowerCase()));
    let match = it ? 'exact' : 'none';
    if (!it) {
      const best = items.map((i) => [i, Math.max(likeness(i.name, r.name), likeness(i.name, l) * 0.9) + (r.hsn && i.hsn && i.hsn.startsWith(r.hsn.slice(0, 4)) ? 0.15 : 0)])
        .sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] >= 0.5) { it = best[0]; match = 'guess'; }
    }
    if (r.weak) {
      // no quantity x rate = amount: only a line naming one of the items counts, with its first small whole number as quantity
      if (!it || SKIP.test(l)) continue;
      const q = r.nums.find((n) => !n.dec && n.v > 0 && n.v < 10000), amt = r.nums[r.nums.length - 1];
      if (!q || !amt || amt === q) continue;
      Object.assign(r, { qty: q.v, rate: r2(amt.v / q.v), amount: amt.v });
    } else if (!it && (SKIP.test(l) || !/[A-Za-z]{3}/.test(r.name))) continue;
    const gst = r.gst || (it ? it.gst_rate : 0);
    let batch = '', expiry = '';
    if (it && it.track_batch) {
      const e = l.match(/\b(0[1-9]|1[0-2])[/-](\d{4}|\d{2})\b/);
      if (e) expiry = `${e[2].length === 2 ? '20' + e[2] : e[2]}-${e[1]}`;
      const b = l.slice(r.name.length).match(/\b(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9-]{4,14}\b/i);
      if (b) batch = b[0];
    }
    rows.push({ name: r.name || (it ? it.name : ''), hsn: r.hsn, qty: r.qty, unit: r.unit || (it ? it.unit : ''), rate: r2(r.rate), discount_pct: 0, gst_rate: gst,
      amount: r.amount, batch_no: batch, expiry, incl: !!r.incl, item_id: it ? it.id : null, item: it ? it.name : '', match });
  }
  // the bill's total: "Grand total" / "Total amount" / "Invoice value", else the largest "Total"
  let total = 0;
  for (const l of lines) if (/grand\s*total|total\s*(amount|payable|invoice|value)|invoice\s*(value|total|amount)|net\s*(amount|payable)|amount\s*payable/i.test(l)) {
    const n = numbersOf(l).filter((x) => !x.pct); if (n.length) total = Math.max(total, n[n.length - 1].v);
  }
  if (!total) for (const l of lines) if (/^\W*total\b/i.test(l)) { const n = numbersOf(l).filter((x) => !x.pct); if (n.length) total = Math.max(total, n[n.length - 1].v); }
  // rates that already include GST (retail bills): quantity x rate of all rows adds up to the grand total itself, not
  // to it before GST; then each rate is taken back to before GST
  const plain = rows.reduce((s, r) => s + r.qty * r.rate, 0), withGst = rows.reduce((s, r) => s + r.qty * r.rate * (1 + r.gst_rate / 100), 0);
  if (total && rows.length && !rows.some((r) => r.incl) && Math.abs(plain - total) <= Math.max(2, total * 0.01) && Math.abs(withGst - total) > Math.max(2, total * 0.01)) {
    for (const r of rows) r.rate = r2(r.rate / (1 + r.gst_rate / 100));
  }
  const calc = rows.reduce((s, r) => s + r.qty * r.rate * (1 + r.gst_rate / 100), 0);
  return {
    supplier: { name: party ? party.name : nameLine.slice(0, 120), gstin, phone: '', state: '', address: '', party_id: party ? party.id : null, party: party ? party.name : '' },
    bill_no: billNo, bill_date: billDate, lines: rows.map(({ incl, ...r }) => r),
    totals: { taxable: 0, cgst: 0, sgst: 0, igst: 0, round_off: 0, total },
    calc_total: r2(calc), adds_up: !total || Math.abs(calc - total) <= Math.max(2, total * 0.01),
    notes: rows.length ? '' : 'No item rows were found. Take the photo straight from above, in good light, with the whole bill in view.',
  };
}

/* the whole job for a photo or a PDF; onProgress(0..1) while text is read */
export async function readBill(file, opts = {}) {
  let text;
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) text = await pdfText(file, opts.onProgress);
  else if (/^image\//.test(file.type)) text = await ocr([await prepare(file)], opts.onProgress);
  else throw new Error('Choose a photo or a PDF of the bill.');
  return { ...parseBill(text, opts), text };
}
