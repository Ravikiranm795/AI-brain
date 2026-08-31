'use strict';

const fs = require('fs');
const path = require('path');
const { GraphStore } = require('./graphStore');
const { VectorIndex } = require('./vectorIndex');
const { embedText } = require('./embedder');
const { getRepoBrainDir } = require('./config');

async function search(rootDir, queryText, k = 10) {
  const brainDir = getRepoBrainDir(rootDir);
  const store = new GraphStore(brainDir);
  const vectorIndex = new VectorIndex(brainDir);
  try {
    const queryVec = await embedText(queryText);
    const hits = vectorIndex.search(queryVec, k);
    return hits.map((h) => {
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
  } finally {
    store.close();
  }
}

function expand(rootDir, symbolId, hops = 1) {
  const brainDir = getRepoBrainDir(rootDir);
  const store = new GraphStore(brainDir);
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
    store.close();
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

module.exports = { search, expand, read };
