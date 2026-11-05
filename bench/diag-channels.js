'use strict';

// Shows where the symbols of the required files rank in EACH search channel
// (semantic, lexical, name, path), to see which channel helps or hurts a task.
// usage: BRAIN_HOME=<dir> node bench/diag-channels.js <taskFile.json> <id> [<id>...]
const fs = require('fs');
const path = require('path');
const { GraphStore } = require('../src/graphStore');
const { VectorIndex } = require('../src/vectorIndex');
const { embedText } = require('../src/embedder');
const { getRepoBrainDir } = require('../src/config');
const { queryTerms } = require('../src/identifiers');
const query = require('../src/query');

(async () => {
  const [file, ...ids] = process.argv.slice(2);
  const cfg = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const repo = path.resolve(process.env.BENCH_REPO || cfg.repo);
  const dir = getRepoBrainDir(repo);
  const store = new GraphStore(dir);
  const vi = new VectorIndex(dir);
  const meta = query.getSearchMeta(store);

  for (const id of ids) {
    const t = cfg.tasks.find((x) => x.id === id);
    const testIntent = query.TEST_INTENT.test(t.query);
    const wMap = testIntent ? meta.weightTests : meta.weightDefault;
    const w = (i) => (wMap.has(i) ? wMap.get(i) : 1);
    const mustFile = (symId) => {
      const s = store.getSymbolById(symId);
      const f = s && store.getFileById(s.file_id);
      return f && t.must.includes(f.path.replace(/\\/g, '/'));
    };
    const label = (symId) => {
      const s = store.getSymbolById(symId);
      const f = store.getFileById(s.file_id);
      return `${s.kind} ${s.name} (${f.path.replace(/\\/g, '/').split('/').pop()})`;
    };
    const show = (name, list) => {
      const hit = list.findIndex(mustFile);
      console.log(`  ${name.padEnd(9)} first required symbol at rank ${hit >= 0 ? hit + 1 : 'none'} of ${list.length}${hit >= 0 ? `  -> ${label(list[hit])}` : ''}`);
      console.log(`            top 5: ${list.slice(0, 5).map(label).join(' | ')}`);
    };

    console.log(`\n== ${id}  terms: ${queryTerms(t.query).join(' ')}`);
    const qv = await embedText(t.query);
    const sem = vi.search(qv, 40, null).map((h) => h.symbolId);
    const semW = vi.search(qv, 40, Float32Array.from(vi.ids, (i) => w(i))).map((h) => h.symbolId);
    const lex = store.searchLexical(t.query, 120).map((h) => ({ ...h, score: h.score * w(h.symbolId) })).sort((a, b) => a.score - b.score).slice(0, 40).map((h) => h.symbolId);
    const pc = query.pathChannel(meta, queryTerms(t.query), testIntent);
    show('semantic', sem);
    show('semantic*', semW);
    show('lexical', lex);
    console.log(`  path      files: ${pc.length}; ${pc.map((ids2) => label(ids2[0])).slice(0, 6).join(' | ')}`);
  }
  store.close();
})();
