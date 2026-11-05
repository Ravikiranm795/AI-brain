'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GraphStore } = require('../src/graphStore');
const query = require('../src/query');
const { buildContext } = require('../src/context');
const { tempDir, parsedSymbols } = require('./helpers');

// buildContext calls query.search through the module object, so the semantic
// search (which would load the ONNX model) can be replaced with canned hits.
function withStubbedSearch(hits, fn) {
  const original = query.search;
  query.search = async () => hits;
  return Promise.resolve(fn()).finally(() => {
    query.search = original;
  });
}

async function withRepo(files, symbolsByFile, fn) {
  const home = tempDir('brain-home-');
  const repo = tempDir('brain-repo-');
  const prevHome = process.env.BRAIN_HOME;
  process.env.BRAIN_HOME = home.dir;
  fs.mkdirSync(path.join(home.dir, 'store'));
  const store = new GraphStore(path.join(home.dir, 'store'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, rel), text);
    }
    for (const [rel, symbols] of Object.entries(symbolsByFile)) {
      store.upsertFile(rel, 'h', 1, path.extname(rel), parsedSymbols(symbols));
    }
    return await fn({ store, repoDir: repo.dir });
  } finally {
    store.close();
    if (prevHome === undefined) delete process.env.BRAIN_HOME;
    else process.env.BRAIN_HOME = prevHome;
    home.cleanup();
    repo.cleanup();
  }
}

const hit = (store, name, score, extra = {}) => {
  const sym = store.db.prepare('SELECT * FROM symbols WHERE name = ?').get(name);
  const file = store.getFileById(sym.file_id);
  return {
    symbolId: sym.id,
    name,
    kind: sym.kind,
    path: file.path,
    startLine: sym.start_line,
    endLine: sym.end_line,
    signature: sym.signature,
    score,
    ...extra
  };
};

test('code is charged to the budget once, not twice', async () => {
  // Three one-line functions of ~300 chars each, all on their own line 1..3.
  const line = (c) => `// ${c.repeat(295)}`;
  const text = [line('a'), line('b'), line('c')].join('\n');
  await withRepo(
    { 'big.js': text },
    { 'big.js': [
      { name: 'fnA', startLine: 1, endLine: 1 },
      { name: 'fnB', startLine: 2, endLine: 2 },
      { name: 'fnC', startLine: 3, endLine: 3 }
    ] },
    async ({ store, repoDir }) => {
      const hits = [hit(store, 'fnA', 0.9), hit(store, 'fnB', 0.8), hit(store, 'fnC', 0.7)];
      await withStubbedSearch(hits, async () => {
        const res = await buildContext(repoDir, 'task', { budgetChars: 1500 }, { store, vectorIndex: {} });
        // ~300 chars of code + ~130 of metadata each = ~1300 total, which fits
        // in 1500. With code double-counted the third item lost its code.
        assert.equal(res.primary.length, 3);
        assert.ok(res.primary.every((p) => p.code), 'every primary should carry its code');
        assert.equal(res.budget.truncated, false);
      });
    }
  );
});

test('presentation files are re-ranked below real logic', async () => {
  await withRepo(
    { 'comp.ts': 'x\ny\nz', 'comp.scss': 'a\nb\nc' },
    { 'comp.ts': [{ name: 'render', kind: 'method', startLine: 1, endLine: 2 }],
      'comp.scss': [{ name: 'comp.scss', kind: 'file', startLine: 1, endLine: 3 }] },
    async ({ store, repoDir }) => {
      // The stylesheet out-scores the method on raw relevance...
      const hits = [hit(store, 'comp.scss', 0.5), hit(store, 'render', 0.3)];
      await withStubbedSearch(hits, async () => {
        const res = await buildContext(repoDir, 'task', {}, { store, vectorIndex: {} });
        // ...but the budget loop must see the logic first.
        assert.deepEqual(res.primary.map((p) => p.name), ['render', 'comp.scss']);
      });
    }
  );
});

test('neighbors are dropped, with a note, once the budget is spent; primaries never are', async () => {
  await withRepo(
    { 'a.js': 'a\nb\nc\nd' },
    { 'a.js': [
      { name: 'main', startLine: 1, endLine: 2 },
      { name: 'helperOne', startLine: 3, endLine: 3 },
      { name: 'helperTwo', startLine: 4, endLine: 4 }
    ] },
    async ({ store, repoDir }) => {
      const id = (n) => store.db.prepare('SELECT id FROM symbols WHERE name = ?').get(n).id;
      store.insertResolvedCallEdge(id('main'), id('helperOne'), 'helperOne');
      store.insertResolvedCallEdge(id('main'), id('helperTwo'), 'helperTwo');

      await withStubbedSearch([hit(store, 'main', 0.9)], async () => {
        // The primary's own metadata already exceeds this budget.
        const res = await buildContext(repoDir, 'task', { budgetChars: 50 }, { store, vectorIndex: {} });
        assert.equal(res.primary.length, 1);
        assert.equal(res.neighbors.length, 0);
        assert.equal(res.budget.truncated, true);
        assert.ok(res.notes.some((n) => /2 lower-priority neighbors dropped/.test(n)), res.notes.join('|'));
      });
    }
  );
});
