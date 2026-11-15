'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** A fresh temp directory, removed by the returned cleanup function. */
function tempDir(prefix = 'brain-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A `parsed` payload shaped like parser.js's output, for GraphStore.upsertFile. */
function parsedSymbols(symbols) {
  let byte = 0;
  return {
    symbols: symbols.map((s, i) => {
      const body = s.body != null ? s.body : `function ${s.name}() {}`;
      const startByte = byte;
      byte += body.length + 1;
      return {
        name: s.name,
        kind: s.kind || 'function',
        startLine: s.startLine || i * 10 + 1,
        endLine: s.endLine || i * 10 + 5,
        startByte: s.startByte != null ? s.startByte : startByte,
        endByte: s.endByte != null ? s.endByte : byte,
        signature: s.signature || `${s.name}()`,
        body
      };
    }),
    literals: []
  };
}

module.exports = { tempDir, parsedSymbols };
