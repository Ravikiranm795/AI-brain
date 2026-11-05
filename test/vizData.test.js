'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { GraphStore } = require('../src/graphStore');
const config = require('../src/config');
const viz = require('../src/vizData');
const { tempDir, parsedSymbols } = require('./helpers');

// Runs fn with BRAIN_HOME pointed at a fresh directory.
function withHome(fn) {
  const home = tempDir('brain-viz-');
  const prev = process.env.BRAIN_HOME;
  process.env.BRAIN_HOME = home.dir;
  try {
    return fn(home.dir);
  } finally {
    if (prev === undefined) delete process.env.BRAIN_HOME;
    else process.env.BRAIN_HOME = prev;
    home.cleanup();
  }
}

// Writes a brain directory the way a build leaves it: graph.sqlite + manifest.json.
function writeBrain(home, repoId, { rootDir, builtAt, symbols = [], calls = [] }) {
  const dir = path.join(home, repoId);
  fs.mkdirSync(dir, { recursive: true });
  const store = new GraphStore(dir);
  store.clearAll();
  const ids = new Map();
  if (symbols.length) {
    const { nameToSymbolId } = store.upsertFile('src/a.js', 'h', 1, '.js', parsedSymbols(symbols.map((name) => ({ name }))));
    nameToSymbolId.forEach((id, name) => ids.set(name, id));
  }
  calls.forEach(([from, to]) => store.insertResolvedCallEdge(ids.get(from), ids.get(to), to));
  store.close();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ rootDir, builtAt, files: {} }));
  return dir;
}

const BUILD_1 = '2026-10-01T09:00:00.000Z';
const BUILD_2 = '2026-10-02T09:00:00.000Z';
const BUILD_3 = '2026-10-03T09:00:00.000Z';

test('refreshAll snapshots a brain into the shared viz-data folder', () =>
  withHome((home) => {
    writeBrain(home, 'shop-aaaa1111', { rootDir: '/work/shop', builtAt: BUILD_1, symbols: ['a', 'b', 'c'], calls: [['a', 'b']] });
    const results = viz.refreshAll();
    assert.equal(results.length, 1);
    assert.equal(results[0].created, true);

    const index = viz.readIndex();
    assert.equal(index.repos.length, 1);
    const repo = index.repos[0];
    assert.equal(repo.name, 'shop');
    assert.equal(repo.versions.length, 1);
    assert.deepEqual(repo.versions[0].counts, { files: 1, symbols: 3, edges: 1 });

    const vizDir = config.getVizDataDir();
    assert.ok(fs.existsSync(path.join(vizDir, 'index.json')));
    assert.ok(fs.readFileSync(path.join(vizDir, 'index.js'), 'utf8').startsWith('window.BRAIN_VIZ_INDEX = '));
    assert.ok(fs.existsSync(viz.snapshotPath('shop-aaaa1111', repo.versions[0].id)));
  }));

test('a snapshot round-trips and is shaped for a <script> tag', () =>
  withHome((home) => {
    writeBrain(home, 'shop-aaaa1111', { rootDir: '/work/shop', builtAt: BUILD_1, symbols: ['a', 'b'], calls: [['a', 'b']] });
    viz.refreshAll();
    const v = viz.readIndex().repos[0].versions[0];
    const text = fs.readFileSync(viz.snapshotPath('shop-aaaa1111', v.id), 'utf8');
    assert.ok(text.startsWith('BRAIN_VIZ.register('));
    const snap = viz.loadSnapshot('shop-aaaa1111', v.id);
    assert.equal(snap.repoId, 'shop-aaaa1111');
    assert.equal(snap.symbols.length, 2);
    assert.deepEqual(snap.edges, [0, 1, 1]); // symbol indexes, then resolution code (1 = lsp)
    assert.deepEqual(snap.files[0], ['src/a.js', '.js', 0]);
  }));

test('refreshing an unchanged brain does not create another version', () =>
  withHome((home) => {
    writeBrain(home, 'shop-aaaa1111', { rootDir: '/work/shop', builtAt: BUILD_1, symbols: ['a'] });
    viz.refreshAll();
    const again = viz.refreshAll();
    assert.equal(again[0].created, false);
    assert.equal(viz.readIndex().repos[0].versions.length, 1);
  }));

test('only the latest two builds of a repo are kept, newest first', () =>
  withHome((home) => {
    writeBrain(home, 'shop-aaaa1111', { rootDir: '/work/shop', builtAt: BUILD_1, symbols: ['a'] });
    viz.refreshAll();
    writeBrain(home, 'shop-aaaa1111', { rootDir: '/work/shop', builtAt: BUILD_2, symbols: ['a', 'b'] });
    viz.refreshAll();
    writeBrain(home, 'shop-aaaa1111', { rootDir: '/work/shop', builtAt: BUILD_3, symbols: ['a', 'b', 'c'] });
    viz.refreshAll();

    const versions = viz.readIndex().repos[0].versions;
    assert.equal(versions.length, viz.KEEP_VERSIONS);
    assert.deepEqual(versions.map((v) => v.counts.symbols), [3, 2]); // latest, then previous
    const onDisk = fs.readdirSync(path.join(config.getVizDataDir(), 'repos', 'shop-aaaa1111'));
    assert.equal(onDisk.length, 2, 'the oldest snapshot file is deleted, not just forgotten');
    assert.equal(viz.loadSnapshot('shop-aaaa1111', versions[1].id).symbols.length, 2);
  }));

test('a brain with no symbols is listed as empty and never snapshotted', () =>
  withHome((home) => {
    writeBrain(home, 'hollow-bbbb2222', { rootDir: '/work/hollow', builtAt: BUILD_1, symbols: [] });
    const results = viz.refreshAll();
    assert.equal(results[0].empty, true);
    const repo = viz.readIndex().repos[0];
    assert.equal(repo.empty, true);
    assert.deepEqual(repo.versions, []);
    assert.equal(fs.existsSync(path.join(config.getVizDataDir(), 'repos', 'hollow-bbbb2222')), false);
  }));

test('a repo whose brain was deleted is dropped from the shared folder', () =>
  withHome((home) => {
    writeBrain(home, 'shop-aaaa1111', { rootDir: '/work/shop', builtAt: BUILD_1, symbols: ['a'] });
    writeBrain(home, 'api-cccc3333', { rootDir: '/work/api', builtAt: BUILD_1, symbols: ['x'] });
    viz.refreshAll();
    fs.rmSync(path.join(home, 'shop-aaaa1111'), { recursive: true, force: true });
    viz.refreshAll();
    assert.deepEqual(viz.readIndex().repos.map((r) => r.name), ['api']);
    assert.equal(fs.existsSync(path.join(config.getVizDataDir(), 'repos', 'shop-aaaa1111')), false);
  }));

test('the shared folder itself is never mistaken for a repo brain', () =>
  withHome((home) => {
    writeBrain(home, 'shop-aaaa1111', { rootDir: '/work/shop', builtAt: BUILD_1, symbols: ['a'] });
    viz.refreshAll();
    assert.ok(fs.existsSync(path.join(home, config.VIZ_DATA_DIRNAME)));
    assert.deepEqual(config.listAllRepoBrains().map((b) => b.repoId), ['shop-aaaa1111']);
  }));

test('latestGraphs hands the older viewers the newest build in the legacy row shape', () =>
  withHome((home) => {
    writeBrain(home, 'shop-aaaa1111', { rootDir: '/work/shop', builtAt: BUILD_1, symbols: ['a'] });
    viz.refreshAll();
    writeBrain(home, 'shop-aaaa1111', { rootDir: '/work/shop', builtAt: BUILD_2, symbols: ['a', 'b'], calls: [['a', 'b']] });
    const graphs = viz.latestGraphs(); // refreshes first
    assert.equal(graphs.length, 1);
    const g = graphs[0];
    assert.equal(g.builtAt, BUILD_2);
    assert.equal(g.graph.symbols.length, 2);
    const { files, symbols, edges } = g.graph;
    assert.deepEqual(Object.keys(files[0]).sort(), ['ext', 'id', 'is_test', 'path']);
    assert.ok(['id', 'file_id', 'name', 'kind', 'start_line', 'end_line', 'signature'].every((k) => k in symbols[0]));
    assert.equal(edges.length, 1);
    assert.equal(edges[0].src_symbol_id, symbols[0].id);
    assert.equal(edges[0].dst_symbol_id, symbols[1].id);
    assert.equal(edges[0].resolution, 'lsp');
  }));

test('a corrupt index is rebuilt rather than breaking every viewer', () =>
  withHome((home) => {
    writeBrain(home, 'shop-aaaa1111', { rootDir: '/work/shop', builtAt: BUILD_1, symbols: ['a'] });
    viz.refreshAll();
    fs.writeFileSync(path.join(config.getVizDataDir(), 'index.json'), '{not json');
    assert.deepEqual(viz.readIndex().repos, []);
    viz.refreshAll();
    assert.equal(viz.readIndex().repos[0].versions.length, 1);
  }));

test('snapshotFromStore (the build hook) records the build and is idempotent', () =>
  withHome((home) => {
    const dir = writeBrain(home, 'shop-aaaa1111', { rootDir: '/work/shop', builtAt: BUILD_1, symbols: ['a', 'b'] });
    const store = new GraphStore(dir);
    try {
      const first = viz.snapshotFromStore(store, { repoId: 'shop-aaaa1111', rootDir: '/work/shop', builtAt: BUILD_1 });
      const second = viz.snapshotFromStore(store, { repoId: 'shop-aaaa1111', rootDir: '/work/shop', builtAt: BUILD_1 });
      assert.deepEqual([first.created, second.created], [true, false]);
      assert.equal(first.versionId, second.versionId);
    } finally {
      store.close();
    }
  }));
