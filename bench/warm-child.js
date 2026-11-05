'use strict';

/**
 * The warm path: one long-lived process (what the MCP server is) answering many
 * queries with the store, vector index and embedding model already loaded.
 * Reports per-task latency plus the process's own memory.
 *
 * usage: BRAIN_HOME=<dir> node warm-child.js <repo> <tasks.json> <reps>
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { StoreCache } = require('../src/storeCache');
const { getRepoBrainDir } = require('../src/config');
const query = require('../src/query');
const { buildContext } = require('../src/context');

const rss = () => Math.round(process.memoryUsage().rss / 1048576);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2 + 0.5)]; };

(async () => {
  const repo = path.resolve(process.argv[2]);
  const tasks = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).tasks;
  const reps = Number(process.argv[4] || 5);

  const rssStart = rss();
  const cache = new StoreCache();
  let t = performance.now();
  const deps = cache.get(getRepoBrainDir(repo));
  const openMs = performance.now() - t;

  // The very first embedding pays the model load; measure it on its own.
  t = performance.now();
  await query.search(repo, 'warm up the embedding model', 3, {}, deps);
  const modelLoadMs = performance.now() - t;
  const rssWarm = rss();

  const time = async (fn) => { const s = performance.now(); await fn(); return performance.now() - s; };
  const out = [];
  for (const task of tasks) {
    const rec = { id: task.id };
    if (task.type === 'impact') {
      const samples = [];
      for (let i = 0; i < reps; i++) {
        samples.push(await time(async () => {
          const hits = await query.search(repo, task.symbol, 5, {}, deps);
          const top = hits.find((h) => h.name === task.symbol) || hits[0];
          if (top) query.check(repo, top.symbolId, {}, deps);
        }));
      }
      rec.checkMs = median(samples);
    } else {
      const s1 = [], s2 = [], s3 = [];
      for (let i = 0; i < reps; i++) {
        s1.push(await time(() => query.search(repo, task.query, 5, {}, deps)));
        s2.push(await time(() => buildContext(repo, task.query, {}, deps)));
        s3.push(await time(() => buildContext(repo, task.query, { k: 5, budgetChars: 8000 }, deps)));
      }
      rec.searchMs = median(s1); rec.contextMs = median(s2); rec.contextLeanMs = median(s3);
    }
    out.push(rec);
  }
  const ru = process.resourceUsage();
  process.stdout.write(JSON.stringify({
    openMs, modelLoadMs, rssStartMB: rssStart, rssWarmMB: rssWarm, rssEndMB: rss(), peakRssMB: Math.round(ru.maxRSS / 1024), tasks: out
  }));
  cache.closeAll && cache.closeAll();
  process.exit(0);
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
