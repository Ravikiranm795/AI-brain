'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  ext TEXT
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  signature TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  dst_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  dst_name TEXT,
  kind TEXT NOT NULL -- 'calls' | 'imports'
);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  specifier TEXT NOT NULL,
  imported_names TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  code TEXT,
  summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_symbol_id);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
`;

class GraphStore {
  constructor(brainDir) {
    this.dbPath = path.join(brainDir, 'graph.sqlite');
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  getFileByPath(relPath) {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(relPath);
  }

  /** Fully removes a file and everything that cascades from it (symbols, edges, chunks, imports). */
  deleteFile(relPath) {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(relPath);
  }

  /**
   * Replaces all data for one file in a single transaction: delete-then-insert
   * is simpler and plenty fast at file granularity (we only do this for
   * files whose hash actually changed).
   */
  upsertFile(relPath, hash, mtime, ext, parsed) {
    const tx = this.db.transaction(() => {
      this.deleteFile(relPath);

      const fileId = this.db
        .prepare('INSERT INTO files (path, hash, mtime, ext) VALUES (?, ?, ?, ?)')
        .run(relPath, hash, mtime, ext).lastInsertRowid;

      const insertSymbol = this.db.prepare(
        `INSERT INTO symbols (file_id, name, kind, start_line, end_line, start_byte, end_byte, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertChunk = this.db.prepare('INSERT INTO chunks (symbol_id, code, summary) VALUES (?, ?, ?)');
      const insertImport = this.db.prepare('INSERT INTO imports (file_id, specifier, imported_names) VALUES (?, ?, ?)');

      const nameToSymbolId = new Map();

      for (const sym of parsed.symbols) {
        const symId = insertSymbol.run(
          fileId,
          sym.name,
          sym.kind,
          sym.startLine,
          sym.endLine,
          sym.startByte,
          sym.endByte,
          sym.signature
        ).lastInsertRowid;
        nameToSymbolId.set(sym.name, symId);
        insertChunk.run(symId, sym.signature, `${sym.kind} ${sym.name} in ${relPath} (lines ${sym.startLine}-${sym.endLine})`);
      }

      for (const imp of parsed.imports || []) {
        insertImport.run(fileId, imp.specifier, JSON.stringify(imp.names || []));
      }

      return { fileId, nameToSymbolId };
    });

    return tx();
  }

  /**
   * Call-edge resolution is name-based and project-wide: after all files in
   * this build pass are inserted, look up each recorded call by callee name
   * anywhere in the graph. Simple, fast, and good enough for "who calls
   * this" style queries; it can over-match same-named functions across
   * files, which is a known, documented simplification.
   */
  insertCallEdges(fileId, calls, nameToSymbolId) {
    const findSrc = this.db.prepare('SELECT id FROM symbols WHERE file_id = ? AND name = ?');
    const findDst = this.db.prepare('SELECT id FROM symbols WHERE name = ? LIMIT 5');
    const insertEdge = this.db.prepare(
      'INSERT INTO edges (src_symbol_id, dst_symbol_id, dst_name, kind) VALUES (?, ?, ?, ?)'
    );

    const tx = this.db.transaction(() => {
      for (const call of calls) {
        const src = findSrc.get(fileId, call.callerName);
        if (!src) continue;
        const dsts = findDst.all(call.calleeName);
        if (dsts.length === 0) {
          insertEdge.run(src.id, null, call.calleeName, 'calls');
        } else {
          for (const dst of dsts) {
            insertEdge.run(src.id, dst.id, call.calleeName, 'calls');
          }
        }
      }
    });
    tx();
  }

  getSymbolById(id) {
    return this.db.prepare('SELECT * FROM symbols WHERE id = ?').get(id);
  }

  getFileById(id) {
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  }

  getChunk(symbolId) {
    return this.db.prepare('SELECT * FROM chunks WHERE symbol_id = ?').get(symbolId);
  }

  /** Callers of + callees from a given symbol, `hops` deep. */
  expand(symbolId, hops = 1) {
    const visited = new Set([symbolId]);
    let frontier = [symbolId];
    const related = [];

    const outgoing = this.db.prepare('SELECT * FROM edges WHERE src_symbol_id = ?');
    const incoming = this.db.prepare('SELECT * FROM edges WHERE dst_symbol_id = ?');

    for (let h = 0; h < hops; h++) {
      const next = [];
      for (const id of frontier) {
        for (const e of outgoing.all(id)) {
          if (e.dst_symbol_id && !visited.has(e.dst_symbol_id)) {
            visited.add(e.dst_symbol_id);
            next.push(e.dst_symbol_id);
            related.push({ symbolId: e.dst_symbol_id, relation: 'callee', via: id });
          }
        }
        for (const e of incoming.all(id)) {
          if (e.src_symbol_id && !visited.has(e.src_symbol_id)) {
            visited.add(e.src_symbol_id);
            next.push(e.src_symbol_id);
            related.push({ symbolId: e.src_symbol_id, relation: 'caller', via: id });
          }
        }
      }
      frontier = next;
    }

    return related.map((r) => ({ ...r, symbol: this.getSymbolById(r.symbolId), file: null })).map((r) => {
      const sym = r.symbol;
      const file = sym ? this.getFileById(sym.file_id) : null;
      return { ...r, file };
    });
  }

  /** Everything needed to render the whole graph in the HTML visualizer. */
  exportFullGraph() {
    const files = this.db.prepare('SELECT * FROM files').all();
    const symbols = this.db.prepare('SELECT * FROM symbols').all();
    const edges = this.db.prepare('SELECT * FROM edges WHERE dst_symbol_id IS NOT NULL').all();
    return { files, symbols, edges };
  }

  countSymbols() {
    return this.db.prepare('SELECT COUNT(*) AS c FROM symbols').get().c;
  }
}

module.exports = { GraphStore };
