'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { isTestFile, FULLY_PARSED_EXTENSIONS } = require('./config');

const FULLY_PARSED_EXTENSION_SET = new Set(FULLY_PARSED_EXTENSIONS);
// A generic-parsed file (.scss/.html/.json/...) has no real logic
// granularity - it's indexed as one whole-file symbol (see parser.js's
// parseGenericFile) rather than real functions/classes. Halving its
// name-match score keeps a filename coincidence there (a stylesheet named
// "theme.scss" for a "theme" query) from outranking an actual .ts/.js
// logic file with the same or a weaker token match.
const GENERIC_FILE_NAME_MATCH_DISCOUNT = 0.5;

// Method names so common across standard libraries, collections, builders and
// framework base classes that matching them by name alone carries no
// information. A call to one of these with an UNRESOLVED receiver (see
// parser.js's receiverTypeOf) gets no target edge at all, rather than
// fanning out to every same-named method in the repo. Sized deliberately
// small and literal: this is a denylist of names whose name-only match is
// known-meaningless, not an attempt to enumerate every standard-library
// method. Receiver-typed calls are unaffected - `myService.get()` still
// resolves normally once `myService`'s type is known.
const AMBIGUOUS_METHOD_NAMES = new Set([
  // JDK / collections / streams
  'stream', 'get', 'set', 'add', 'remove', 'put', 'size', 'isEmpty', 'contains', 'clear',
  'map', 'filter', 'forEach', 'collect', 'sorted', 'reduce', 'anyMatch', 'allMatch', 'findFirst',
  'iterator', 'next', 'hasNext', 'toList', 'toArray', 'of', 'empty', 'orElse', 'orElseGet', 'ifPresent',
  // Object / lang basics
  'toString', 'equals', 'hashCode', 'clone', 'compareTo', 'valueOf', 'parse', 'format', 'trim',
  'length', 'charAt', 'substring', 'split', 'join', 'replace', 'indexOf', 'startsWith', 'endsWith',
  // Ubiquitous builder/accessor shapes
  'build', 'builder', 'create', 'apply', 'accept', 'run', 'call', 'execute', 'close', 'open',
  'getName', 'getId', 'getValue', 'getType', 'getMessage', 'getKey', 'getData', 'getStatus',
  'setName', 'setId', 'setValue', 'setType', 'setStatus',
  // Logging
  'info', 'warn', 'error', 'debug', 'trace', 'log',
  // JS/TS promise & console shapes
  'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'push', 'pop', 'slice', 'splice',
  'subscribe', 'pipe', 'emit', 'on', 'off', 'once'
]);

// Resolutions precise enough to make a positive claim from - see
// insertCallEdges' doc comment. 'heuristic' is deliberately excluded: an
// edge that only matched by a shared, ambiguous name is fine for "here's
// somewhere to look" but must never underwrite "this is covered by a test".
const TRUSTED_RESOLUTIONS = new Set(['typed', 'unique', 'lsp']);

// Splits a file path or symbol name into lowercase word tokens, aware of
// kebab-case, snake_case, camelCase and path/extension separators - so
// "generic-filter.component.ts" tokenizes to [generic, filter, component,
// ts] and matches a query like "filter flow" on the "filter" token. Used by
// GraphStore.searchByNameMatch() below.
function tokenizeForNameMatch(text) {
  return (text.match(/[A-Za-z0-9]+/g) || [])
    .flatMap((chunk) => chunk.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_-]+/))
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  ext TEXT,
  is_test INTEGER NOT NULL DEFAULT 0,
  -- 'ok' | 'parse-failed' | 'too-large' | 'minified'. Anything but 'ok' means
  -- this file is in the index with degraded (or zero) symbol coverage, so an
  -- empty answer about a symbol it might contain is "unknown", not "no".
  -- Queried by getDegradedFiles() and surfaced by query.js's check().
  index_status TEXT NOT NULL DEFAULT 'ok'
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
  signature TEXT,
  -- Enclosing class/interface name for a method, null for a top-level
  -- symbol. This is what lets a call through a typed receiver resolve to
  -- ONE method instead of every same-named method in the repo - see
  -- insertCallEdges().
  parent_name TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  dst_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  dst_name TEXT,
  kind TEXT NOT NULL, -- always 'calls' - shared-storage-key coupling is computed on the fly (see getStorageKeyPeers), not stored as an edge row
  resolution TEXT NOT NULL DEFAULT 'heuristic' -- 'heuristic' | 'lsp'
);

CREATE TABLE IF NOT EXISTS chunks (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  code TEXT,
  summary TEXT
);

-- Tracks localStorage/sessionStorage get/set/remove calls with a literal
-- key, so coupling between files that share a storage key but never
-- directly call each other (file A writes 'X', file B reads 'X') is
-- discoverable - see getStorageKeyPeers()/expand()/getCallers() below.
CREATE TABLE IF NOT EXISTS string_literals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  store TEXT NOT NULL,
  action TEXT NOT NULL,
  line INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_symbol_id);
CREATE INDEX IF NOT EXISTS idx_string_literals_key ON string_literals(key);
CREATE INDEX IF NOT EXISTS idx_string_literals_symbol ON string_literals(symbol_id);

-- FTS5 lexical index over full chunk bodies (chunks.code - see parser.js's
-- nodeBody()), so brain_search can find an identifier/string literal that
-- only appears inside a function body, not just its first line. Kept in
-- sync with the chunks table by the triggers below rather than an
-- external-content setup that needs manual maintenance.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(code, content='chunks', content_rowid='symbol_id');

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, code) VALUES (new.symbol_id, new.code);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, code) VALUES('delete', old.symbol_id, old.code);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, code) VALUES('delete', old.symbol_id, old.code);
  INSERT INTO chunks_fts(rowid, code) VALUES (new.symbol_id, new.code);
END;
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
    addColumnIfMissing('files', 'index_status', "index_status TEXT NOT NULL DEFAULT 'ok'");
    addColumnIfMissing('edges', 'target_count', 'target_count INTEGER');
    addColumnIfMissing('symbols', 'parent_name', 'parent_name TEXT');

    // `CREATE VIRTUAL TABLE IF NOT EXISTS` above creates chunks_fts empty on
    // a database that already had rows in `chunks` from before FTS existed -
    // the insert-trigger only fires on new writes, so pre-existing content
    // needs one explicit rebuild to become searchable.
    const chunkCount = this.db.prepare('SELECT COUNT(*) AS c FROM chunks').get().c;
    const ftsCount = this.db.prepare('SELECT COUNT(*) AS c FROM chunks_fts').get().c;
    if (chunkCount > 0 && ftsCount === 0) {
      this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
    }
  }

  close() {
    this.db.close();
  }

  /** Wipes every row (cascades from files to symbols/edges/chunks/string_literals) - used by a `--force` rebuild. */
  clearAll() {
    this.db.exec('DELETE FROM files');
  }

  getFileByPath(relPath) {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(relPath);
  }

  /** Fully removes a file and everything that cascades from it (symbols, edges, chunks, string_literals). */
  deleteFile(relPath) {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(relPath);
  }

  /**
   * Replaces all data for one file in a single transaction: delete-then-insert
   * is simpler and plenty fast at file granularity (we only do this for
   * files whose hash actually changed).
   */
  upsertFile(relPath, hash, mtime, ext, parsed, opts = {}) {
    const indexStatus = opts.indexStatus || 'ok';
    const tx = this.db.transaction(() => {
      this.deleteFile(relPath);

      const fileId = this.db
        .prepare('INSERT INTO files (path, hash, mtime, ext, is_test, index_status) VALUES (?, ?, ?, ?, ?, ?)')
        .run(relPath, hash, mtime, ext, isTestFile(relPath) ? 1 : 0, indexStatus).lastInsertRowid;

      const insertSymbol = this.db.prepare(
        `INSERT INTO symbols (file_id, name, kind, start_line, end_line, start_byte, end_byte, signature, parent_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      // chunks.code now holds the full (capped) symbol body - see parser.js's
      // nodeBody() - so it's actually searchable via chunks_fts, not just the
      // ~160-char signature. chunks.summary is left unpopulated (see
      // getChunk's note): nothing reads it and it was never more than a
      // restatement of fields already on `symbols`.
      const insertChunk = this.db.prepare('INSERT INTO chunks (symbol_id, code) VALUES (?, ?)');
      const insertLiteral = this.db.prepare(
        'INSERT INTO string_literals (symbol_id, file_id, key, store, action, line) VALUES (?, ?, ?, ?, ?, ?)'
      );

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
          sym.signature,
          sym.parentName != null ? sym.parentName : null
        ).lastInsertRowid;
        nameToSymbolId.set(sym.name, symId);
        insertChunk.run(symId, sym.body != null ? sym.body : sym.signature);
      }

      // Attributed to the enclosing named symbol the same way calls are
      // (see parser.js's currentScope()) - a literal with no enclosing scope
      // has nothing to attach the FK to, so it's dropped, same as a call
      // with no enclosing scope is dropped in insertCallEdges.
      for (const lit of parsed.literals || []) {
        const symId = lit.scopeName ? nameToSymbolId.get(lit.scopeName) : null;
        if (!symId) continue;
        insertLiteral.run(symId, fileId, lit.key, lit.store, lit.action, lit.line);
      }

      return { fileId, nameToSymbolId };
    });

    return tx();
  }

  /**
   * Resolves each recorded call site to the symbol(s) it reaches, in tiers of
   * decreasing confidence, recorded in `edges.resolution`:
   *
   *   'typed'  - the call's receiver type was resolved (see parser.js's
   *              receiverTypeOf) and that type owns a method by this name.
   *              One edge, to one symbol. This is a real answer.
   *   'unique' - exactly one symbol in the whole repo has this name, so
   *              name-matching can't be wrong even without a receiver type.
   *   'heuristic' - the name matches several symbols and nothing narrowed it
   *              down. Edges are still recorded (they're better than nothing
   *              for navigation) but flagged, counted in `target_count`, and
   *              excluded from anything that claims certainty - see
   *              TRUSTED_RESOLUTIONS and query.js's check().
   *
   * A call whose name is in AMBIGUOUS_METHOD_NAMES and whose receiver is
   * unresolved records NO target edge at all. That combination is pure
   * noise: `list.stream()` matching a `stream()` method on some service
   * class is what previously produced a 1,722-symbol "blast radius" across
   * 561 files for a class actually referenced by 3, and reported it as
   * test-covered.
   */
  insertCallEdges(fileId, calls) {
    const findSrc = this.db.prepare('SELECT id FROM symbols WHERE file_id = ? AND name = ?');
    const findTyped = this.db.prepare(
      'SELECT id FROM symbols WHERE name = ? AND parent_name = ? COLLATE NOCASE LIMIT 2'
    );
    const countByName = this.db.prepare('SELECT COUNT(*) AS c FROM symbols WHERE name = ?');
    const isIndexedClass = this.db.prepare("SELECT 1 AS found FROM symbols WHERE name = ? COLLATE NOCASE AND kind = 'class' LIMIT 1");
    const findByName = this.db.prepare('SELECT id FROM symbols WHERE name = ? LIMIT 5');
    const insertEdge = this.db.prepare(
      'INSERT INTO edges (src_symbol_id, dst_symbol_id, dst_name, kind, resolution, target_count) VALUES (?, ?, ?, ?, ?, ?)'
    );

    const tx = this.db.transaction(() => {
      for (const call of calls) {
        const src = findSrc.get(fileId, call.callerName);
        if (!src) continue;

        const total = countByName.get(call.calleeName).c;

        if (call.receiverType) {
          // Tier 1: the receiver's type owns a method by this name. A real
          // answer - one edge, one target.
          const typed = findTyped.all(call.calleeName, call.receiverType);
          if (typed.length) {
            for (const dst of typed) insertEdge.run(src.id, dst.id, call.calleeName, 'calls', 'typed', typed.length);
            continue;
          }
          // Tier 1b: the receiver's type isn't a class this repo defines at
          // all (List, String, Optional, a framework base class). The call
          // therefore lands OUTSIDE the index, and any same-named symbol in
          // here is a coincidence, not the callee. Recorded with no target.
          //
          // This is the single most important negative case in this method.
          // `items.stream()` on a List does not call some service's stream()
          // method - but name-matching alone can't tell, and when a repo
          // happens to define exactly one stream() the uniqueness tier below
          // would "confidently" link every list.stream() in the codebase to
          // it. That is precisely how a class referenced by 3 files acquired
          // a 1,722-symbol blast radius across 561 files, reported as
          // test-covered.
          if (!isIndexedClass.get(call.receiverType)) {
            insertEdge.run(src.id, null, call.calleeName, 'calls', 'external', total);
            continue;
          }
          // Otherwise: the type IS ours but has no such method - inherited,
          // or a field the parser mistyped. Fall through, but never as
          // 'unique' (see below), since we have positive evidence the naive
          // name match is not the whole story.
        }

        // Tier 2: a name whose bare match carries no information, with no
        // receiver type to disambiguate it. Recorded with no target rather
        // than fanned out across every same-named symbol.
        if (AMBIGUOUS_METHOD_NAMES.has(call.calleeName)) {
          insertEdge.run(src.id, null, call.calleeName, 'calls', 'heuristic', total);
          continue;
        }

        // Tier 3: exactly one symbol in the repo has this name, and nothing
        // above contradicted it - name-matching cannot be wrong here.
        if (total === 1 && !call.receiverType) {
          const dst = findByName.get(call.calleeName);
          insertEdge.run(src.id, dst.id, call.calleeName, 'calls', 'unique', 1);
          continue;
        }

        // Tier 4: ambiguous. Edges are still recorded as leads, flagged and
        // counted, and excluded from anything that claims certainty.
        if (total === 0) {
          insertEdge.run(src.id, null, call.calleeName, 'calls', 'heuristic', 0);
          continue;
        }
        for (const dst of findByName.all(call.calleeName)) {
          insertEdge.run(src.id, dst.id, call.calleeName, 'calls', 'heuristic', total);
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

  /**
   * Records a file the walker deliberately did NOT index (too large,
   * minified) as a row with no symbols, purely so its absence is
   * discoverable afterwards. Without this the file is indistinguishable
   * from one that doesn't exist, which is what let a 484KB ProductService.java
   * silently vanish from a blast-radius answer that still reported success.
   */
  recordSkippedFile(relPath, reason, mtime) {
    const tx = this.db.transaction(() => {
      this.deleteFile(relPath);
      this.db
        .prepare('INSERT INTO files (path, hash, mtime, ext, is_test, index_status) VALUES (?, ?, ?, ?, ?, ?)')
        .run(relPath, 'skipped', mtime || 0, path.extname(relPath), isTestFile(relPath) ? 1 : 0, reason);
    });
    tx();
  }

  /** Every file in the index with degraded or zero symbol coverage - see files.index_status. */
  getDegradedFiles() {
    return this.db.prepare("SELECT id, path, index_status FROM files WHERE index_status != 'ok'").all();
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

  /**
   * Lexical/substring match over full symbol bodies via FTS5 (see the
   * chunks_fts virtual table) - complements vectorIndex's semantic search,
   * which can miss an exact identifier/string literal that only appears
   * inside a function body. Each raw query token is quoted so FTS5 treats it
   * as a literal term (ANDed together) instead of parsing user input as FTS5
   * query syntax, which would throw on stray `"`/`-`/`*` etc.
   */
  searchLexical(queryText, limit = 40) {
    const terms = (queryText.match(/[A-Za-z0-9_]+/g) || []).slice(0, 16);
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
    try {
      // chunks_fts only exposes `rowid` (aliased to chunks.symbol_id via
      // content_rowid) and its declared columns (`code`) - `symbol_id`
      // itself is NOT a selectable column on the FTS virtual table, even
      // though that's the name of the underlying content-table column.
      return this.db
        .prepare('SELECT rowid AS symbolId, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?')
        .all(match, limit);
    } catch (_) {
      return []; // malformed FTS query (e.g. all-punctuation input) - degrade to semantic-only rather than fail the whole search
    }
  }

  /**
   * Exact (case-insensitive) name match for a single identifier-like query
   * word, e.g. "AuthService" - see query.js's search() for how this is used:
   * a query that already names a real symbol is a far stronger, unambiguous
   * signal than anything semantic/lexical scoring produces, and closes the
   * gap where a plain grep for a known name is more reliable than semantic
   * search, which can rank an unrelated-but-similar-sounding hit above it.
   */
  getSymbolsByExactName(name) {
    return this.db.prepare('SELECT id FROM symbols WHERE name = ? COLLATE NOCASE').all(name).map((r) => r.id);
  }

  /**
   * Third search signal alongside vectorIndex's semantic search and
   * searchLexical's FTS5 body search: how well the query matches a symbol's
   * OWN name or its file's path/basename - neither of the other two signals
   * looks at names specifically (semantic search embeds the signature text;
   * FTS5 indexes the body). Without this, a file whose name is an
   * near-exact match for the query (e.g. `generic-filter.component.ts` for
   * "filter flow") can rank poorly if its body content doesn't happen to be
   * semantically/lexically close to the query wording.
   *
   * Scored in JS, not SQL: an exact whole-token match on the file's
   * basename or the symbol's own name counts for more than a bare substring
   * match, and files are considered once (all real work is at file
   * granularity - path tokens don't vary per symbol), with the file's
   * representative symbol (prefer a class/file-kind symbol, else the
   * earliest-declared one) standing in for it in the result.
   */
  searchByNameMatch(queryText, limit = 40) {
    const queryTokens = new Set(tokenizeForNameMatch(queryText));
    if (!queryTokens.size) return [];

    const files = this.db.prepare('SELECT id, path FROM files').all();
    const scored = [];
    for (const f of files) {
      const base = path.basename(f.path);
      const baseTokens = new Set(tokenizeForNameMatch(base));
      const baseLower = base.toLowerCase();
      let score = 0;
      for (const t of queryTokens) {
        if (baseTokens.has(t)) score += 2; // exact token match
        else if (t.length >= 3 && baseLower.includes(t)) score += 1; // substring match (skip tiny tokens - too noisy as substrings)
      }
      if (score > 0 && !FULLY_PARSED_EXTENSION_SET.has(path.extname(f.path).toLowerCase())) {
        score *= GENERIC_FILE_NAME_MATCH_DISCOUNT;
      }
      if (score > 0) scored.push({ fileId: f.id, score });
    }
    if (!scored.length) return [];
    scored.sort((a, b) => b.score - a.score);

    // Pick which symbol in each matched file represents it: the one whose
    // OWN name best matches the query tokens, if any does, otherwise the
    // file's "main" symbol (a class/file-kind symbol, else whichever is
    // declared first) - bounded to symbols within already-matched files, not
    // a full symbol-table scan.
    const fileSymbols = this.db.prepare('SELECT id, name, kind, start_line FROM symbols WHERE file_id = ?');
    const results = [];
    for (const s of scored.slice(0, limit)) {
      const syms = fileSymbols.all(s.fileId);
      if (!syms.length) continue;
      let best = null;
      let bestScore = -Infinity;
      for (const sym of syms) {
        const nameTokens = new Set(tokenizeForNameMatch(sym.name));
        let nameScore = 0;
        for (const t of queryTokens) {
          if (nameTokens.has(t)) nameScore += 2;
        }
        const kindBonus = sym.kind === 'class' || sym.kind === 'file' ? 0.5 : 0;
        const orderBonus = -sym.start_line * 1e-6; // tie-break toward earlier declarations, doesn't affect real distinctions
        const total = nameScore + kindBonus + orderBonus;
        if (total > bestScore) {
          bestScore = total;
          best = sym;
        }
      }
      if (best) results.push({ symbolId: best.id, score: s.score + Math.max(0, bestScore) });
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Other symbols that read/write/remove the same literal localStorage/
   * sessionStorage key as `symbolId` (see parser.js's literal capture) -
   * coupling the call graph can't see at all, since there's no function
   * call between the writer and the reader.
   */
  getStorageKeyPeers(symbolId) {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT sl2.symbol_id AS id, sl1.key AS key
         FROM string_literals sl1
         JOIN string_literals sl2 ON sl2.key = sl1.key AND sl2.symbol_id != sl1.symbol_id
         WHERE sl1.symbol_id = ?`
      )
      .all(Number(symbolId));
    return rows
      .map((row) => {
        const sym = this.getSymbolById(row.id);
        if (!sym) return null;
        const file = this.getFileById(sym.file_id);
        return { symbolId: row.id, key: row.key, symbol: sym, file };
      })
      .filter(Boolean);
  }

  /**
   * A class/interface's member methods, parsed as separate 'method' symbols
   * within its line range (see parser.js's class_declaration/class_definition
   * cases, which never push the class itself onto scopeStack). This is why a
   * class-level query needs special handling everywhere below: a call made
   * through `new Foo()` or `this.method()` attributes to the METHOD symbol,
   * never to the enclosing class, so the class symbol itself almost always
   * has zero direct edges even when it's used constantly. A TS `interface`
   * shares the 'class' kind (see parser.js's interface_declaration comment)
   * but its members are `method_signature` nodes, which parser.js doesn't
   * capture as symbols at all - so this correctly comes back empty for an
   * interface, which _resolveSeeds() below turns into an explicit
   * `unresolved` flag instead of a silently-confident "no callers".
   */
  getClassMembers(symbol) {
    if (!symbol || symbol.kind !== 'class') return [];
    return this.db
      .prepare(
        `SELECT id, name, kind FROM symbols
         WHERE file_id = ? AND id != ? AND kind = 'method'
           AND start_line >= ? AND end_line <= ?`
      )
      .all(symbol.file_id, symbol.id, symbol.start_line, symbol.end_line);
  }

  /**
   * Turns a single requested symbol id into the full set of graph seeds a
   * caller/callee/test walk should start from, plus metadata describing that
   * expansion. For anything but a class this is just `[symbolId]` and empty
   * meta - identical to the pre-aggregation behavior. For a class, the seeds
   * also include every member method (see getClassMembers), so
   * getCallers/expand/getTestsForSymbol below transparently union "who calls
   * this class" into "who calls any of its methods" - instead of reporting a
   * falsely-confident empty result. `unresolved: true` marks the one case
   * that's genuinely indeterminate: a class/interface with zero discoverable
   * members, where an empty result means "couldn't look" not "looked and
   * found nothing".
   */
  _resolveSeeds(symbolId) {
    const symbol = this.getSymbolById(Number(symbolId));
    if (!symbol) return null;
    const members = this.getClassMembers(symbol);
    const seeds = [symbol.id, ...members.map((m) => m.id)];
    const meta = symbol.kind === 'class'
      ? { classAggregation: { memberCount: members.length, unresolved: members.length === 0 } }
      : {};
    return { symbol, seeds, meta };
  }

  /** Callers of + callees from a given symbol, `hops` deep, plus its direct storage-key peers (see getStorageKeyPeers). */
  expand(symbolId, hops = 1) {
    const resolved = this._resolveSeeds(symbolId);
    if (!resolved) return { items: [], meta: {} };
    const { seeds, meta } = resolved;

    const visited = new Set(seeds);
    let frontier = [...seeds];
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

    // Storage-key coupling is a second, independent edge kind (see
    // getStorageKeyPeers) - only checked against the seed set, not chained
    // through each hop, since "shares a storage key with a peer of a peer"
    // isn't a meaningful transitive relation the way calls are.
    for (const seed of seeds) {
      for (const peer of this.getStorageKeyPeers(seed)) {
        if (visited.has(peer.symbolId)) continue;
        visited.add(peer.symbolId);
        related.push({ symbolId: peer.symbolId, relation: 'shares-storage-key', via: seed, sharedKey: peer.key });
      }
    }

    const items = related.map((r) => ({ ...r, symbol: this.getSymbolById(r.symbolId), file: null })).map((r) => {
      const sym = r.symbol;
      const file = sym ? this.getFileById(sym.file_id) : null;
      return { ...r, file };
    });

    return { items, meta };
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
    const resolved = this._resolveSeeds(symbolId);
    if (!resolved) return { callers: [], meta: {} };
    const { seeds, meta } = resolved;

    const incoming = this.db.prepare('SELECT src_symbol_id AS id, resolution, target_count FROM edges WHERE dst_symbol_id = ?');
    const visited = new Set(seeds);
    // A caller is only as trustworthy as the weakest edge on the path that
    // reached it - one ambiguous name-match anywhere in the chain makes the
    // whole attribution a guess, so `trusted` is ANDed along the path rather
    // than read off the final edge.
    let frontier = seeds.map((id) => ({ id, trusted: true }));
    const callers = [];

    for (let h = 1; h <= maxHops && frontier.length; h++) {
      const next = [];
      for (const node of frontier) {
        for (const row of incoming.all(node.id)) {
          if (visited.has(row.id)) continue;
          visited.add(row.id);
          const sym = this.getSymbolById(row.id);
          if (!sym) continue;
          const file = this.getFileById(sym.file_id);
          const trusted = node.trusted && TRUSTED_RESOLUTIONS.has(row.resolution);
          callers.push({
            symbolId: sym.id,
            name: sym.name,
            kind: sym.kind,
            path: file ? file.path : null,
            startLine: sym.start_line,
            endLine: sym.end_line,
            relation: 'caller',
            hops: h,
            resolution: row.resolution,
            // How many symbols shared this callee name at resolution time -
            // present only when the match was ambiguous, as a direct measure
            // of how much salt to take this caller with.
            ...(TRUSTED_RESOLUTIONS.has(row.resolution) ? {} : { nameMatchedSymbols: row.target_count }),
            confidence: trusted ? 'high' : 'low'
          });
          next.push({ id: row.id, trusted });
        }
      }
      frontier = next;
    }

    // Storage-key peers aren't "callers" in the call-graph sense this
    // method otherwise guarantees (see the docstring above), but for blast
    // radius purposes they're exactly the kind of thing that breaks if
    // `symbolId` changes - a reader of a key that this symbol's writer stops
    // writing. Reported flat (not hop-chained) alongside true callers.
    // Checked across the whole seed set (see _resolveSeeds) so a class's
    // member methods contribute their storage-key peers too.
    for (const seed of seeds) {
      for (const peer of this.getStorageKeyPeers(seed)) {
        if (visited.has(peer.symbolId)) continue;
        visited.add(peer.symbolId);
        callers.push({
          symbolId: peer.symbolId,
          name: peer.symbol.name,
          kind: peer.symbol.kind,
          path: peer.file ? peer.file.path : null,
          startLine: peer.symbol.start_line,
          endLine: peer.symbol.end_line,
          relation: 'shares-storage-key',
          sharedKey: peer.key,
          hops: 0,
          resolution: 'storage-key',
          confidence: 'high'
        });
      }
    }

    // Most-trustworthy and nearest first, so a truncated view keeps the part
    // worth reading rather than whatever the traversal happened to reach.
    callers.sort((a, b) => (a.confidence === b.confidence ? a.hops - b.hops : a.confidence === 'high' ? -1 : 1));

    return { callers, meta };
  }

  /**
   * Walks incoming call edges from `symbolId` looking for symbols that live
   * in a test file (`files.is_test`), stopping at each hit instead of
   * walking through a test into whatever helper it calls. Used by
   * `brain check` to answer "is this covered by any test".
   */
  getTestsForSymbol(symbolId, maxHops = 6) {
    const resolved = this._resolveSeeds(symbolId);
    if (!resolved) return { tests: [], meta: {} };
    const { seeds, meta } = resolved;

    const incoming = this.db.prepare('SELECT src_symbol_id AS id, resolution FROM edges WHERE dst_symbol_id = ?');
    const lookup = this.db.prepare(
      `SELECT s.id, s.name, s.kind, s.start_line, s.end_line, f.path AS file_path, f.is_test
       FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`
    );

    const visited = new Set(seeds);
    let frontier = seeds.map((id) => ({ id, trusted: true }));
    const hits = [];

    for (let h = 1; h <= maxHops && frontier.length; h++) {
      const next = [];
      for (const node of frontier) {
        for (const row of incoming.all(node.id)) {
          if (visited.has(row.id)) continue;
          visited.add(row.id);
          const sym = lookup.get(row.id);
          if (!sym) continue;
          const trusted = node.trusted && TRUSTED_RESOLUTIONS.has(row.resolution);
          if (sym.is_test) {
            hits.push({
              symbolId: sym.id,
              name: sym.name,
              kind: sym.kind,
              path: sym.file_path,
              startLine: sym.start_line,
              endLine: sym.end_line,
              hops: h,
              // A test reached only through an ambiguous name-match is NOT
              // evidence of coverage - query.js's check() requires at least
              // one high-confidence hit before it will say "covered".
              confidence: trusted ? 'high' : 'low'
            });
          } else {
            next.push({ id: row.id, trusted });
          }
        }
      }
      frontier = next;
    }

    hits.sort((a, b) => (a.confidence === b.confidence ? a.hops - b.hops : a.confidence === 'high' ? -1 : 1));

    return { tests: hits, meta };
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
