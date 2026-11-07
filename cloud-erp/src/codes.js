/* What a scanned code stands for. Three kinds of label are read the same way everywhere (sales order, picking, receiving):
   - the app's own QR / barcode: the item's barcode, SKU, or ST<id>;
   - a code learnt once (a supplier's barcode, a carton, the shop's own QR): item_codes;
   - a QR the shop printed itself with the product written in it ("Kurti 101 Red M", "Name: Kurti 101, Colour: Red,
     Size: M", or JSON): the words are matched against the item names (design, colour, size), and an item is taken only
     when every word of its name is in the QR and no other item fits as well. */
const STOP = new Set(['name', 'design', 'item', 'product', 'style', 'colour', 'color', 'size', 'sku', 'code', 'article', 'art', 'no', 'qty', 'mrp', 'rs', 'price', 'pcs']);
const words = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter((w) => w && !STOP.has(w));

/* the key a code is kept under: the code without spaces; a long QR text is shortened with a hash of itself */
export function codeKey(raw) {
  const s = String(raw || '').replace(/\s+/g, '');
  if (s.length <= 48) return s;
  let h = 5381;
  for (const ch of s) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return s.slice(0, 36) + '#' + h.toString(36);
}

/* { item, pack, how } | { item: null, candidates: [{ id, name, score }] } */
export async function findItem(c, raw) {
  const text = String(raw || '').trim().slice(0, 500), key = codeKey(text);
  if (!key) return { item: null, candidates: [] };
  const m = key.toUpperCase().match(/^ST(\d+)$/);
  const it = await c.db.prepare(`SELECT * FROM items WHERE org_id = ? AND (barcode = ? OR (sku != '' AND sku = ?) OR id = ?) ORDER BY barcode = ? DESC LIMIT 1`)
    .bind(c.org.id, key, key, m ? +m[1] : -1, key).first();
  if (it) return { item: it, pack: 1, how: 'code' };
  const x = await c.db.prepare(`SELECT i.*, x.pack_qty AS pack_learnt FROM item_codes x JOIN items i ON i.id = x.item_id WHERE x.org_id = ? AND x.code = ?`).bind(c.org.id, key).first();
  if (x) { const { pack_learnt, ...row } = x; return { item: row, pack: pack_learnt || 1, how: 'learnt' }; }
  // the words of the QR against every stock item's name
  const q = new Set(words(text));
  if (!q.size) return { item: null, candidates: [] };
  const { results } = await c.db.prepare(`SELECT * FROM items WHERE org_id = ? AND is_service = 0 LIMIT 5000`).bind(c.org.id).all();
  const scored = results.map((i) => {
    const w = [...new Set(words(i.name))];
    const hit = w.filter((t) => q.has(t)).length;
    return { i, all: w.length > 0 && hit === w.length, n: w.length, score: w.length ? hit / w.length : 0 };
  });
  const full = scored.filter((s) => s.all).sort((a, b) => b.n - a.n);
  // the most specific name that fits wholly ("Kurti 101 - Red - M" over "Kurti 101"); two equally specific = ask
  if (full.length && (full.length === 1 || full[0].n > full[1].n)) return { item: full[0].i, pack: 1, how: 'text' };
  // what to offer: the items that fit wholly, else the ones that fit best (half their words or more)
  const top = Math.max(0, ...scored.map((s) => s.score));
  const cand = (full.length ? full : top >= 0.5 ? scored.filter((s) => s.score === top) : []).sort((a, b) => b.n - a.n).slice(0, 8);
  return { item: null, candidates: cand.map((s) => ({ id: s.i.id, name: s.i.name, score: Math.round(s.score * 100) / 100 })) };
}
