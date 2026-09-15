'use strict';

const fs = require('fs');
const path = require('path');
const { GraphStore } = require('./graphStore');
const { VectorIndex } = require('./vectorIndex');
const { embedText } = require('./embedder');
const { getRepoBrainDir } = require('./config');

/**
 * `deps` lets callers that already have an open store/index (context.js's
 * multi-step assembly, the long-lived MCP server) reuse them instead of
 * paying an open+close per call. Omit it (the CLI's usage) and behavior is
 * exactly what it was before: open fresh, close when done.
 */
async function search(rootDir, queryText, k = 10, filters = {}, deps = {}) {
  const brainDir = getRepoBrainDir(rootDir);
  const store = deps.store || new GraphStore(brainDir);
  const vectorIndex = deps.vectorIndex || new VectorIndex(brainDir);
  const shouldClose = !deps.store;
  try {
    const { kind, ext } = filters;
    const needsFilter = Boolean(kind || ext);
    const fetchK = needsFilter ? Math.max(k * 4, 40) : k;

    const queryVec = await embedText(queryText);
    const hits = vectorIndex.search(queryVec, fetchK);

    let results = hits.map((h) => {
      const sym = store.getSymbolById(h.symbolId);
      if (!sym) return null;
      const file = store.getFileById(sym.file_id);
      return {
        symbolId: sym.id,
        name: sym.name,
        kind: sym.kind,
        path: file ? file.path : null,
        startLine: sym.start_line,
        endLine: sym.end_line,
        signature: sym.signature,
        score: h.score
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
    const related = store.expand(Number(symbolId), Number(hops));
    return related.map((r) => ({
      relation: r.relation,
      symbolId: r.symbol ? r.symbol.id : null,
      name: r.symbol ? r.symbol.name : null,
      kind: r.symbol ? r.symbol.kind : null,
      path: r.file ? r.file.path : null,
      startLine: r.symbol ? r.symbol.start_line : null,
      endLine: r.symbol ? r.symbol.end_line : null
    }));
  } finally {
    if (shouldClose) store.close();
  }
}

/** The only place actual file I/O happens for the agent: one targeted read. */
function read(rootDir, relPath, startLine, endLine) {
  const absPath = path.join(path.resolve(rootDir), relPath);
  const lines = fs.readFileSync(absPath, 'utf8').split('\n');
  const s = Math.max(1, Number(startLine));
  const e = Math.min(lines.length, Number(endLine));
  return lines.slice(s - 1, e).join('\n');
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
