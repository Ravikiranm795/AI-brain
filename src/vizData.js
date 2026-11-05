'use strict';

const fs = require('fs');
const path = require('path');
const { getVizDataDir, listAllRepoBrains } = require('./config');
const { GraphStore } = require('./graphStore');

/**
 * The single data point every graph viewer reads from.
 *
 * Layout, all under <BRAIN_HOME>/viz-data/:
 *
 *   index.json / index.js            which repos exist and which versions each has
 *   repos/<repoId>/<versionId>.js    one graph snapshot (script-loadable, see below)
 *   index.html, app.js, ...          the 3D viewer, written by visualizeCity.js
 *
 * A version is one build of one repo. Only the newest KEEP_VERSIONS are kept
 * per repo - the "latest" and the "previous" the viewer offers in its
 * dropdown - and older ones are deleted as each new build lands.
 *
 * Snapshots are `.js` files, not `.json`, because a page opened from disk
 * (file://) cannot fetch() a sibling JSON file but can load a <script src>.
 * The viewer pulls only the repo/version being looked at, so opening it no
 * longer means parsing every repo's graph up front.
 */

const SCHEMA_VERSION = 1;
const KEEP_VERSIONS = 2;

const SNAPSHOT_PREFIX = 'BRAIN_VIZ.register(';
const SNAPSHOT_SUFFIX = ');\n';

const RESOLUTION_CODES = { heuristic: 0, lsp: 1 };
const RESOLUTION_NAMES = ['heuristic', 'lsp'];

function reposDir() {
  return path.join(getVizDataDir(), 'repos');
}

function snapshotPath(repoId, versionId) {
  return path.join(reposDir(), repoId, `${versionId}.js`);
}

function indexPath() {
  return path.join(getVizDataDir(), 'index.json');
}

function emptyIndex() {
  return { schema: SCHEMA_VERSION, updatedAt: null, repos: [] };
}

function readIndex() {
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    if (idx && idx.schema === SCHEMA_VERSION && Array.isArray(idx.repos)) return idx;
  } catch (_) {
    /* missing or corrupt - start over; snapshots are derived data */
  }
  return emptyIndex();
}

/** Write via a temp file so a crash mid-write can't leave a half-written file the viewer would choke on. */
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function writeIndex(idx) {
  idx.updatedAt = new Date().toISOString();
  idx.repos.sort((a, b) => a.name.localeCompare(b.name) || a.repoId.localeCompare(b.repoId));
  const json = JSON.stringify(idx);
  writeFileAtomic(indexPath(), json);
  // Same content, loadable from a file:// page.
  writeFileAtomic(path.join(getVizDataDir(), 'index.js'), `window.BRAIN_VIZ_INDEX = ${json};\n`);
}

/** `2026-11-05T07:41:44.482Z` -> `20261105T074144Z`: sortable, filesystem-safe. */
function versionIdFor(builtAt) {
  const d = new Date(builtAt);
  const when = Number.isNaN(d.getTime()) ? new Date() : d;
  return when.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function repoName(repoId, rootDir) {
  if (rootDir) {
    const base = path.basename(String(rootDir).replace(/[\\/]+$/, ''));
    if (base) return base;
  }
  return repoId;
}

/** The compact, column-oriented payload the viewers consume. */
function exportSnapshot(store, meta) {
  const files = store.db.prepare('SELECT id, path, ext, is_test FROM files ORDER BY id').all();
  const fileIdx = new Map(files.map((f, i) => [f.id, i]));

  const symbolRows = store.db
    .prepare('SELECT id, file_id, name, kind, start_line, end_line, signature FROM symbols ORDER BY id')
    .all();
  const symIdx = new Map(symbolRows.map((s, i) => [s.id, i]));

  // Flat [src, dst, resolution, src, dst, resolution, ...] over symbol
  // *indexes* - at the 450k-edge scale an array of objects is several times
  // the size and slower to parse than three numbers per edge.
  const edges = [];
  const rows = store.db
    .prepare('SELECT src_symbol_id, dst_symbol_id, resolution FROM edges WHERE dst_symbol_id IS NOT NULL')
    .raw(true);
  for (const [src, dst, resolution] of rows.iterate()) {
    const s = symIdx.get(src);
    const d = symIdx.get(dst);
    if (s === undefined || d === undefined) continue;
    edges.push(s, d, RESOLUTION_CODES[resolution] || 0);
  }

  return {
    schema: SCHEMA_VERSION,
    repoId: meta.repoId,
    name: repoName(meta.repoId, meta.rootDir),
    rootDir: meta.rootDir || null,
    builtAt: meta.builtAt,
    versionId: meta.versionId,
    resolutions: RESOLUTION_NAMES,
    files: files.map((f) => [f.path, f.ext || '', f.is_test ? 1 : 0]),
    symbols: symbolRows.map((s) => [
      s.id,
      fileIdx.get(s.file_id),
      s.name,
      s.kind,
      s.start_line,
      s.end_line,
      s.signature ? String(s.signature).slice(0, 160) : ''
    ]),
    edges
  };
}

function findEntry(idx, repoId) {
  return idx.repos.find((r) => r.repoId === repoId);
}

/**
 * Records `meta`'s build as the repo's newest version, unless that exact
 * build is already the newest. Safe to call on every build and every
 * `brain view`: an unchanged repo costs one index read.
 *
 * Returns { created, versionId, empty }.
 */
function snapshotFromStore(store, meta) {
  const idx = readIndex();
  let entry = findEntry(idx, meta.repoId);
  if (!entry) {
    entry = { repoId: meta.repoId, name: repoName(meta.repoId, meta.rootDir), rootDir: meta.rootDir || null, empty: false, versions: [] };
    idx.repos.push(entry);
  }
  entry.name = repoName(meta.repoId, meta.rootDir || entry.rootDir);
  entry.rootDir = meta.rootDir || entry.rootDir;

  const builtAt = meta.builtAt || new Date().toISOString();
  const latest = entry.versions[0];
  if (latest && latest.builtAt === builtAt && fs.existsSync(snapshotPath(meta.repoId, latest.id))) {
    return { created: false, versionId: latest.id, empty: false };
  }

  const symbolCount = store.countSymbols();
  if (symbolCount === 0) {
    // A brain that never finished building. Listed so the viewer can say so,
    // but never snapshotted - an empty graph would just be a blank canvas.
    entry.empty = entry.versions.length === 0;
    writeIndex(idx);
    return { created: false, versionId: null, empty: true };
  }

  let versionId = versionIdFor(builtAt);
  const taken = new Set(entry.versions.map((v) => v.id));
  for (let n = 2; taken.has(versionId); n++) versionId = `${versionIdFor(builtAt)}-${n}`;

  const snap = exportSnapshot(store, { ...meta, builtAt, versionId });
  writeFileAtomic(snapshotPath(meta.repoId, versionId), `${SNAPSHOT_PREFIX}${JSON.stringify(snap)}${SNAPSHOT_SUFFIX}`);

  entry.empty = false;
  entry.versions.unshift({
    id: versionId,
    builtAt,
    createdAt: new Date().toISOString(),
    counts: { files: snap.files.length, symbols: snap.symbols.length, edges: snap.edges.length / 3 }
  });

  for (const old of entry.versions.splice(KEEP_VERSIONS)) {
    try {
      fs.unlinkSync(snapshotPath(meta.repoId, old.id));
    } catch (_) {
      /* already gone */
    }
  }

  writeIndex(idx);
  return { created: true, versionId, empty: false };
}

/**
 * Brings the shared folder in step with every brain on disk: snapshots any
 * repo whose current build isn't recorded yet, and forgets repos whose brain
 * has been deleted. Opens a repo's database only when it actually needs a
 * new snapshot.
 */
function refreshAll({ onProgress = () => {} } = {}) {
  const brains = listAllRepoBrains().filter((b) => fs.existsSync(path.join(b.dir, 'graph.sqlite')));
  const results = [];

  for (const b of brains) {
    const rootDir = b.manifest ? b.manifest.rootDir : null;
    const builtAt = b.manifest ? b.manifest.builtAt : null;

    const entry = findEntry(readIndex(), b.repoId);
    const latest = entry && entry.versions[0];
    if (latest && builtAt && latest.builtAt === builtAt && fs.existsSync(snapshotPath(b.repoId, latest.id))) {
      results.push({ repoId: b.repoId, created: false, versionId: latest.id });
      continue;
    }

    const store = new GraphStore(b.dir);
    try {
      // No manifest timestamp (a brain from before manifests carried one):
      // fall back to the database file's own mtime so it still versions sanely.
      const stamp = builtAt || fs.statSync(path.join(b.dir, 'graph.sqlite')).mtime.toISOString();
      const r = snapshotFromStore(store, { repoId: b.repoId, rootDir, builtAt: stamp });
      results.push({ repoId: b.repoId, ...r });
      if (r.created) onProgress(`Snapshot ${b.repoId} @ ${r.versionId}`);
    } finally {
      store.close();
    }
  }

  const idx = readIndex();
  const live = new Set(brains.map((b) => b.repoId));
  const gone = idx.repos.filter((r) => !live.has(r.repoId));
  if (gone.length) {
    idx.repos = idx.repos.filter((r) => live.has(r.repoId));
    for (const g of gone) fs.rmSync(path.join(reposDir(), g.repoId), { recursive: true, force: true });
    writeIndex(idx);
  }

  return results;
}

/** Parses a snapshot file back into its payload object. Null if absent or unreadable. */
function loadSnapshot(repoId, versionId) {
  try {
    const text = fs.readFileSync(snapshotPath(repoId, versionId), 'utf8');
    if (!text.startsWith(SNAPSHOT_PREFIX)) return null;
    return JSON.parse(text.slice(SNAPSHOT_PREFIX.length, text.length - SNAPSHOT_SUFFIX.length));
  } catch (_) {
    return null;
  }
}

/**
 * Rebuilds the row-shaped graph the cytoscape viewers were written against
 * ({ files, symbols, edges } as GraphStore.exportFullGraph returned them), so
 * they can read the shared snapshots without being rewritten.
 */
function toLegacyGraph(snap) {
  const files = snap.files.map(([p, ext, isTest], i) => ({ id: i + 1, path: p, ext, is_test: isTest }));
  const symbols = snap.symbols.map(([id, fileIdx, name, kind, startLine, endLine, signature]) => ({
    id,
    file_id: fileIdx + 1,
    name,
    kind,
    start_line: startLine,
    end_line: endLine,
    signature
  }));
  const edges = [];
  for (let i = 0; i < snap.edges.length; i += 3) {
    edges.push({
      id: i / 3 + 1,
      src_symbol_id: snap.symbols[snap.edges[i]][0],
      dst_symbol_id: snap.symbols[snap.edges[i + 1]][0],
      kind: 'calls',
      resolution: snap.resolutions[snap.edges[i + 2]] || 'heuristic'
    });
  }
  return { files, symbols, edges };
}

/**
 * What the older viewers iterate over: the newest snapshot of every repo
 * that has one, in the legacy graph shape. Refreshes first, so a viewer
 * generated right after a build never shows stale data.
 */
function latestGraphs() {
  refreshAll();
  const out = [];
  for (const entry of readIndex().repos) {
    const latest = entry.versions[0];
    if (!latest) continue;
    const snap = loadSnapshot(entry.repoId, latest.id);
    if (!snap) continue;
    out.push({
      repoId: entry.repoId,
      rootDir: entry.rootDir || entry.repoId,
      builtAt: latest.builtAt,
      versionId: latest.id,
      graph: toLegacyGraph(snap)
    });
  }
  return out;
}

module.exports = {
  KEEP_VERSIONS,
  SCHEMA_VERSION,
  readIndex,
  snapshotFromStore,
  refreshAll,
  loadSnapshot,
  toLegacyGraph,
  latestGraphs,
  snapshotPath
};
