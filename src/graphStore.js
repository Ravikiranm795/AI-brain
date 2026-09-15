'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { isTestFile } = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  ext TEXT,
  is_test INTEGER NOT NULL DEFAULT 0
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
  kind TEXT NOT NULL, -- 'calls' | 'imports'
  resolution TEXT NOT NULL DEFAULT 'heuristic' -- 'heuristic' | 'lsp'
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
    this.migrate();
  }

  /**
   * `CREATE TABLE IF NOT EXISTS` above only shapes brand-new databases -
   * it does nothing to a `graph.sqlite` built before a column existed. Any
   * future additive column should follow this same guarded-ALTER pattern.
   */
  migrate() {
    const addColumnIfMissing = (table, column, ddl) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes(column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
        return true;
      }
      return false;
    };

    const addedIsTest = addColumnIfMissing('files', 'is_test', 'is_test INTEGER NOT NULL DEFAULT 0');
    if (addedIsTest) {
      const rows = this.db.prepare('SELECT id, path FROM files').all();
      const update = this.db.prepare('UPDATE files SET is_test = ? WHERE id = ?');
      const tx = this.db.transaction(() => {
        for (const r of rows) update.run(isTestFile(r.path) ? 1 : 0, r.id);
      });
      tx();
    }

    addColumnIfMissing('edges', 'resolution', "resolution TEXT NOT NULL DEFAULT 'heuristic'");
  }

  close() {
    this.db.close();
  }

  /** Wipes every row (cascades from files to symbols/edges/imports/chunks) - used by a `--force` rebuild. */
  clearAll() {
    this.db.exec('DELETE FROM files');
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
        .prepare('INSERT INTO files (path, hash, mtime, ext, is_test) VALUES (?, ?, ?, ?, ?)')
        .run(relPath, hash, mtime, ext, isTestFile(relPath) ? 1 : 0).lastInsertRowid;

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
  insertCallEdges(fileId, calls) {
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

  /**
   * Adds one precisely-resolved call edge (from a language-server lookup,
   * see src/lsp/), alongside whatever the name-based heuristic already
   * inserted for the same call site - see README for why these coexist
   * instead of replacing the heuristic edge outright.
   */
  insertResolvedCallEdge(srcSymbolId, dstSymbolId, calleeName) {
    this.db
      .prepare('INSERT INTO edges (src_symbol_id, dst_symbol_id, dst_name, kind, resolution) VALUES (?, ?, ?, ?, ?)')
      .run(srcSymbolId, dstSymbolId, calleeName, 'calls', 'lsp');
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

  /**
   * Transitive callers of `symbolId` only - a one-directional incoming BFS.
   * `expand()` deliberately walks BOTH directions from every frontier node
   * (it's built for "show me the neighborhood"), so filtering its output by
   * relation === 'caller' does NOT give true transitive callers: once the
   * walk passes through a node that's also called by unrelated code (e.g. a
   * common method name over-matched by the name-based heuristic), that
   * unrelated code gets misattributed as a "caller" of the original symbol.
   * This method only ever follows dst->src edges, so it can't cross into
   * callee territory the way expand() can. Used by `brain check`'s blast
   * radius, where that distinction is the whole point.
   */
  getCallers(symbolId, maxHops = 3) {
    const incoming = this.db.prepare('SELECT src_symbol_id AS id FROM edges WHERE dst_symbol_id = ?');
    const visited = new Set([Number(symbolId)]);
    let frontier = [Number(symbolId)];
    const callers = [];

    for (let h = 1; h <= maxHops && frontier.length; h++) {
      const next = [];
      for (const id of frontier) {
        for (const row of incoming.all(id)) {
          if (visited.has(row.id)) continue;
          visited.add(row.id);
          const sym = this.getSymbolById(row.id);
          if (!sym) continue;
          const file = this.getFileById(sym.file_id);
          callers.push({
            symbolId: sym.id,
            name: sym.name,
            kind: sym.kind,
            path: file ? file.path : null,
            startLine: sym.start_line,
            endLine: sym.end_line,
            hops: h
          });
          next.push(row.id);
        }
      }
      frontier = next;
    }

    return callers;
  }

  /**
   * Walks incoming call edges from `symbolId` looking for symbols that live
   * in a test file (`files.is_test`), stopping at each hit instead of
   * walking through a test into whatever helper it calls. Used by
   * `brain check` to answer "is this covered by any test".
   */
  getTestsForSymbol(symbolId, maxHops = 6) {
    const incoming = this.db.prepare('SELECT src_symbol_id AS id FROM edges WHERE dst_symbol_id = ?');
    const lookup = this.db.prepare(
      `SELECT s.id, s.name, s.kind, s.start_line, s.end_line, f.path AS file_path, f.is_test
       FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`
    );

    const visited = new Set([Number(symbolId)]);
    let frontier = [Number(symbolId)];
    const hits = [];

    for (let h = 1; h <= maxHops && frontier.length; h++) {
      const next = [];
      for (const id of frontier) {
        for (const row of incoming.all(id)) {
          if (visited.has(row.id)) continue;
          visited.add(row.id);
          const sym = lookup.get(row.id);
          if (!sym) continue;
          if (sym.is_test) {
            hits.push({
              symbolId: sym.id,
              name: sym.name,
              kind: sym.kind,
              path: sym.file_path,
              startLine: sym.start_line,
              endLine: sym.end_line,
              hops: h
            });
          } else {
            next.push(row.id);
          }
        }
      }
      frontier = next;
    }

    return hits;
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
