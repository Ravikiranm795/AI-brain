'use strict';

// Shows what `brain search` returns for benchmark tasks, to see WHY a task fails.
// usage: node bench/diag.js <taskFile.json> <id> [<id>...]   (uses the real BRAIN_HOME)
const fs = require('fs');
const path = require('path');
const query = require('../src/query');

(async () => {
  const [file, ...ids] = process.argv.slice(2);
  const cfg = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const repo = path.resolve(process.env.BENCH_REPO || cfg.repo);
  for (const id of ids) {
    const t = cfg.tasks.find((x) => x.id === id);
    const hits = await query.search(repo, t.query, 12, {});
    console.log(`\n== ${id}  must=${t.must.map((m) => m.split('/').pop()).join(', ')}`);
    hits.forEach((h, i) => {
      const p = h.path.replace(/\\/g, '/');
      const mark = t.must.includes(p) ? ' <== MUST' : '';
      console.log(String(i + 1).padStart(2), h.kind.padEnd(8), h.name.slice(0, 46).padEnd(46), p.split('/').slice(-2).join('/'), h.matchedVia + mark);
    });
  }
})();
