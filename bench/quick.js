'use strict';

// A fast, in-process retrieval check (no CLI spawns): how well does `search` rank the required files?
// It exists for tuning. Tune on the original tasks and keep the stage tasks held out.
//
// usage: BRAIN_HOME=<dir> node bench/quick.js <tasks.json> [--rrfk 20] [--verbose]
const fs = require('fs');
const path = require('path');
const { StoreCache } = require('../src/storeCache');
const { getRepoBrainDir } = require('../src/config');
const query = require('../src/query');

const argv = process.argv.slice(2);
const file = argv[0];
const verbose = argv.includes('--verbose');

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const repo = path.resolve(cfg.repo);
  const deps = new StoreCache().get(getRepoBrainDir(repo));
  const norm = (p) => String(p).replace(/\\/g, '/');
  let n = 0, solved5 = 0, solved8 = 0, top1 = 0, mrr = 0;
  const lines = [];
  for (const t of cfg.tasks.filter((x) => x.type !== 'impact')) {
    const hits = await query.search(repo, t.query, 12, {}, deps);
    const files = hits.map((h) => norm(h.path));
    const must = new Set(t.must);
    const firstSym = files.findIndex((f) => must.has(f));
    const within = (k) => t.must.every((m) => files.slice(0, k).includes(m));
    n++;
    if (within(5)) solved5++;
    if (within(8)) solved8++;
    if (firstSym === 0) top1++;
    mrr += firstSym >= 0 ? 1 / (firstSym + 1) : 0;
    lines.push(`${t.id.padEnd(4)} first-required-symbol=${firstSym >= 0 ? firstSym + 1 : '-'}  all-in-top5=${within(5) ? 'Y' : 'n'}  all-in-top8=${within(8) ? 'Y' : 'n'}`);
  }
  if (verbose) console.log(lines.join('\n'));
  console.log(`${path.basename(file)}: n=${n}  solved@5=${solved5}  solved@8=${solved8}  top1=${top1}  MRR=${(mrr / n).toFixed(3)}`);
  process.exit(0);
})();
