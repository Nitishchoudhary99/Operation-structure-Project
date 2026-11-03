// Software bill of materials (CycloneDX 1.5 JSON): every npm package in the lockfiles and every library copied into
// the app (public/vendor), with its version. Run: node tools/sbom.mjs [out.json]   (CI keeps the file with each run)
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
const comps = [];
const add = (name, version, scope, purl, source) => comps.push({ type: 'library', name, version, scope, ...(purl ? { purl } : {}), properties: [{ name: 'source', value: source }] });
for (const lock of ['cloud-erp/package-lock.json', 'package-lock.json']) {
  if (!existsSync(lock)) continue;
  const pk = JSON.parse(readFileSync(lock, 'utf8')).packages || {};
  for (const [path, p] of Object.entries(pk)) {
    if (!path || !p.version) continue;
    const name = path.replace(/^.*node_modules\//, '');
    add(name, p.version, p.dev ? 'excluded' : 'required', `pkg:npm/${name.replace('@', '%40')}@${p.version}`, lock);
  }
}
// libraries shipped to the browser: public/vendor/README.txt lists "- file: Name version by ..."
const vend = 'cloud-erp/public/vendor/README.txt';
if (existsSync(vend)) {
  for (const line of readFileSync(vend, 'utf8').split('\n')) {
    const m = line.match(/^- [^:]+:\s*(.+?)\s+v?(\d+\.\d+(?:\.\d+)?(?:[-_][\w.]+)?)/);
    if (!m) continue;
    for (const part of line.replace(/^- [^:]+:\s*/, '').split(/\s\+\s/)) {
      const n = part.match(/(.+?)\s+v?(\d+\.\d+(?:\.\d+)?)/);
      if (n) add(n[1].replace(/\s*\(.*$/, '').trim(), n[2], 'required', null, vend);
    }
  }
}
const bom = { bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, metadata: { timestamp: new Date().toISOString(), component: { type: 'application', name: 'smarttrader-cloud-erp' } }, components: comps };
const out = process.argv[2] || 'sbom.json';
writeFileSync(out, JSON.stringify(bom, null, 1));
console.log(`${comps.length} components (${comps.filter((c) => c.scope === 'required').length} shipped) -> ${out}`);
for (const c of comps.filter((c) => c.scope === 'required')) console.log(`  ${c.name} ${c.version}  (${c.properties[0].value})`);
