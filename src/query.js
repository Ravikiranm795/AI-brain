'use strict';

const fs = require('fs');
const path = require('path');
const { GraphStore } = require('./graphStore');
const { VectorIndex } = require('./vectorIndex');
const { embedText } = require('./embedder');
const { getRepoBrainDir, getBrainsHome } = require('./config');
const { loadUserConfig } = require('./userConfig');

// Reciprocal-rank-fusion constant: standard choice (see Cormack et al.'s RRF
// paper), not tuned for this corpus - low sensitivity to the exact value is
// the whole appeal of RRF over score-normalizing the two very
// differently-scaled inputs (cosine similarity vs. bm25) by hand.
// Overridable per-repo/machine-wide via brain.config.json's `rrfK` - see
// userConfig.js.
const DEFAULT_RRF_K = 60;

/**
 * `deps` lets callers that already have an open store/index (context.js's
 * multi-step assembly, the long-lived MCP server) reuse them instead of
 * paying an open+close per call. Omit it (the CLI's usage) and behavior is
 * exactly what it was before: open fresh, close when done.
 *
 * Fuses two independent rankings - vectorIndex's semantic (embedding cosine)
 * search and the store's FTS5 lexical search over full symbol bodies (see
 * graphStore.js's chunks_fts) - via reciprocal rank fusion, so an exact
 * identifier/string-literal match inside a function body surfaces even when
 * it's not semantically close to the query text, and a semantically-close
 * result still surfaces even with zero lexical overlap.
 */
async function search(rootDir, queryText, k = 10, filters = {}, deps = {}) {
  const brainDir = getRepoBrainDir(rootDir);
  const store = deps.store || new GraphStore(brainDir);
  const vectorIndex = deps.vectorIndex || new VectorIndex(brainDir);
  const shouldClose = !deps.store;
  try {
    const { kind, ext } = filters;
    // Always overfetch, not just when a kind/ext filter needs the extra
    // headroom: semantic embeddings here are computed from a symbol's
    // truncated signature (see embedText's caller in buildBrain.js), so a
    // symbol whose *body* is the actual lexical match can rank well outside
    // the top-k semantically. A narrow fetchK would silently exclude it
    // from one side of the fusion before RRF ever gets a chance to combine
    // the two signals - see the fixture-repo repro that caught this.
    const fetchK = Math.max(k * 4, 40);
    const rrfK = loadUserConfig(rootDir, getBrainsHome()).rrfK || DEFAULT_RRF_K;

    const queryVec = await embedText(queryText);
    const semanticHits = vectorIndex.search(queryVec, fetchK);
    const lexicalHits = store.searchLexical(queryText, fetchK);

    const fused = new Map(); // symbolId -> { score, matches }
    const addHit = (id, rank) => {
      const cur = fused.get(id) || { score: 0, matches: 0 };
      cur.score += 1 / (rrfK + rank + 1);
      cur.matches += 1;
      fused.set(id, cur);
    };
    semanticHits.forEach((h, i) => addHit(h.symbolId, i));
    lexicalHits.forEach((h, i) => addHit(h.symbolId, i));

    const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, fetchK);

    // score is now an RRF-fused rank score, not a raw cosine similarity -
    // see the RRF_K comment above and README §10 for what it means and why.
    // `confidence` buckets it into something more actionable than the raw
    // number: 'high' when both the semantic and lexical searches agreed on
    // this result, 'medium'/'low' otherwise based on how high it ranked in
    // whichever single list found it.
    let results = ranked.map(([symbolId, { score, matches }]) => {
      const sym = store.getSymbolById(symbolId);
      if (!sym) return null;
      const file = store.getFileById(sym.file_id);
      const confidence = matches > 1 ? 'high' : score >= 1 / (rrfK + 5) ? 'medium' : 'low';
      return {
        symbolId: sym.id,
        name: sym.name,
        kind: sym.kind,
        path: file ? file.path : null,
        startLine: sym.start_line,
        endLine: sym.end_line,
        signature: sym.signature,
        score,
        confidence
      };
    }).filter(Boolean);

    if (kind) results = results.filter((r) => r.kind === kind);
    if (ext) results = results.filter((r) => r.path && r.path.endsWith(ext));

    return results.slice(0, k);
  } finally {
    if (shouldClose) store.close();
  }
}

function expand(rootDir, symbolId, hops = 1, deps = {}) {
  const brainDir = getRepoBrainDir(rootDir);
  const store = deps.store || new GraphStore(brainDir);
  const shouldClose = !deps.store;
  try {
    const id = Number(symbolId);
    // Previously a missing symbol silently fell through to an empty []
    // (indistinguishable from "no callers/callees"). Mirror check()'s
    // null-for-not-found so callers can tell the two cases apart.
    if (!store.getSymbolById(id)) return null;
    const related = store.expand(id, Number(hops));
    return related.map((r) => ({
      relation: r.relation,
      symbolId: r.symbol ? r.symbol.id : null,
      name: r.symbol ? r.symbol.name : null,
      kind: r.symbol ? r.symbol.kind : null,
      path: r.file ? r.file.path : null,
      startLine: r.symbol ? r.symbol.start_line : null,
      endLine: r.symbol ? r.symbol.end_line : null,
      sharedKey: r.sharedKey
    }));
  } finally {
    if (shouldClose) store.close();
  }
}

/** The only place actual file I/O happens for the agent: one targeted read. */
function read(rootDir, relPath, startLine, endLine) {
  const root = path.resolve(rootDir);
  const absPath = path.resolve(root, relPath);
  // relPath comes straight from the MCP client (mcpServer.js's brain_read) -
  // without this check, "../../../etc/passwd" (or a Windows equivalent) would
  // resolve outside the repo and this would happily return it.
  if (absPath !== root && !absPath.startsWith(root + path.sep)) {
    throw new Error(`relPath resolves outside the repo root: ${relPath}`);
  }
  const s = Math.max(1, Number(startLine));
  const e = Number(endLine);
  if (!Number.isFinite(e) || e < s) {
    throw new Error(`endLine (${endLine}) must be >= startLine (${startLine})`);
  }
  const lines = fs.readFileSync(absPath, 'utf8').split('\n');
  return lines.slice(s - 1, Math.min(lines.length, e)).join('\n');
}

/**
 * Pre-edit safety report for a symbol: who transitively calls it (blast
 * radius) and which tests, if any, exercise it - so an agent can gauge risk
 * before changing it instead of finding out after the fact.
 */
function check(rootDir, symbolId, opts = {}, deps = {}) {
  const { hops = 3, testHops = 6 } = opts;
  const brainDir = getRepoBrainDir(rootDir);
  const store = deps.store || new GraphStore(brainDir);
  const shouldClose = !deps.store;
  try {
    const id = Number(symbolId);
    const symbol = store.getSymbolById(id);
    if (!symbol) return null;
    const file = store.getFileById(symbol.file_id);

    const blastRadius = store.getCallers(id, Number(hops));
    const testsCovering = store.getTestsForSymbol(id, Number(testHops));

    return {
      symbol: {
        symbolId: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        path: file ? file.path : null,
        startLine: symbol.start_line,
        endLine: symbol.end_line
      },
      blastRadius,
      testsCovering,
      risk: testsCovering.length > 0 ? 'covered' : 'untested'
    };
  } finally {
    if (shouldClose) store.close();
  }
}

module.exports = { search, expand, read, check };
