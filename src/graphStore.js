'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { isTestFile } = require('./config');
const { identifierParts, indexableParts, isCompoundIdentifier, commentWords, STOPWORDS } = require('./identifiers');

// The chunks -> chunks_fts sync triggers. These are deliberately NOT part
// of SCHEMA: migrate() owns them outright (create when absent, drop and
// recreate when the body is stale), so there is exactly one definition and
// one code path for fresh and existing databases alike. Written without
// `IF NOT EXISTS` for the same reason - that clause silently preserves a
// stale body forever, which is the bug the migration block exists to
// repair.
const FTS_TRIGGERS = `
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, code, parts) VALUES (new.symbol_id, new.code, new.parts);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, code, parts) VALUES('delete', old.symbol_id, old.code, old.parts);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, code, parts) VALUES('delete', old.symbol_id, old.code, old.parts);
  INSERT INTO chunks_fts(rowid, code, parts) VALUES (new.symbol_id, new.code, new.parts);
END;
`;

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
  kind TEXT NOT NULL, -- always 'calls' - shared-storage-key coupling is computed on the fly (see getStorageKeyPeers), not stored as an edge row
  resolution TEXT NOT NULL DEFAULT 'heuristic' -- 'heuristic' | 'lsp'
);

CREATE TABLE IF NOT EXISTS chunks (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  code TEXT,
  summary TEXT,
  -- camelCase/snake_case sub-tokens of every compound identifier in the
  -- code column (see identifiers.js). Indexed as its own FTS column so a
  -- query for domainToken can reach INSIDE getDomainTokenHeader, which
  -- FTS5's default tokenizer indexes as one solid token.
  parts TEXT
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
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(code, parts, content='chunks', content_rowid='symbol_id');
`;

// --- Edge scoring (see scoreEdge / getCallers / getTestsForSymbol) ---------
//
// Every caller/test result carries a numeric `confidence` in (0, 1] instead
// of being reported flat, so a hop-1 caller through a precisely-resolved
// edge outranks a hop-4 caller reached through a name collision. The three
// factors below are independent and multiply.

// How much trust an edge's `resolution` column is worth on its own. The
// column has been populated since LSP resolution landed but nothing ever
// read it - a heuristic edge is a *name* match project-wide (see
// insertCallEdges), an 'lsp' edge is a real language-server resolution.
const RESOLUTION_BASE = { lsp: 1, heuristic: 0.75 };

// Per-hop multiplier. At 0.55 a hop-4 caller scores ~0.17x a hop-1 caller,
// which is roughly how much less useful it is when the question is "what
// breaks if I change this" - far enough to sort below every direct hit,
// not so far that a genuine 3-hop chain disappears.
const HOP_DECAY = 0.55;

// Storage-key peers (see getStorageKeyPeers) aren't call edges at all, so
// hop decay doesn't apply. They sit deliberately just below a direct
// heuristic call: real coupling, weaker evidence.
const STORAGE_PEER_CONFIDENCE = 0.6;

// Results below this are dropped unless the caller lowers it. Chosen to sit
// just under the weakest hop-3 heuristic edge, so the default keeps the
// whole blast radius `brain check` used to return and only trims noise
// beyond it; callers wanting everything can pass minConfidence: 0.
const DEFAULT_MIN_CONFIDENCE = 0.05;

// Hard cap on returned rows. brain_check on a hot symbol was returning ~100
// rows / 27k chars of mostly hop-3 noise in one tool response - the payload
// an agent pays for. Highest-confidence rows survive; the rest are reported
// as a count.
const DEFAULT_MAX_RESULTS = 25;

/**
 * A name-based edge that could point at any of N same-named symbols is
 * weaker evidence than one whose callee name is unique in the repo - see
 * insertCallEdges, which deliberately over-matches (`LIMIT 5`) rather than
 * guess. 1/sqrt(N) rather than 1/N so a name shared by two symbols is
 * discounted, not discarded.
 */
function ambiguityFactor(fanout) {
  return fanout > 1 ? 1 / Math.sqrt(fanout) : 1;
}

class GraphStore {
  constructor(brainDir) {
    this.dbPath = path.join(brainDir, 'graph.sqlite');
    this.db = new Database(this.dbPath);
    this._stmtCache = new Map();
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
      const cols = this._stmt(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes(column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
        return true;
      }
      return false;
    };

    const addedIsTest = addColumnIfMissing('files', 'is_test', 'is_test INTEGER NOT NULL DEFAULT 0');
    if (addedIsTest) {
      const rows = this._stmt('SELECT id, path FROM files').all();
      const update = this._stmt('UPDATE files SET is_test = ? WHERE id = ?');
      const tx = this.db.transaction(() => {
        for (const r of rows) update.run(isTestFile(r.path) ? 1 : 0, r.id);
      });
      tx();
    }

    addColumnIfMissing('edges', 'resolution', "resolution TEXT NOT NULL DEFAULT 'heuristic'");

    // `chunks.parts` (the camelCase sub-token stream - see identifiers.js)
    // and the second FTS column that indexes it. A brain built before this
    // existed has the rows but not the tokens, and rebuilding the whole
    // brain to get them would re-run parsing AND ~90MB of ONNX embedding
    // for content that hasn't changed. Backfilling here is a pure
    // string+SQL pass over data already on disk, so the upgrade costs
    // seconds instead of minutes.
    const addedParts = addColumnIfMissing('chunks', 'parts', 'parts TEXT');
    if (addedParts) {
      const rows = this._stmt('SELECT symbol_id, code FROM chunks').all();
      const update = this._stmt('UPDATE chunks SET parts = ? WHERE symbol_id = ?');
      const tx = this.db.transaction(() => {
        for (const r of rows) update.run(identifierParts(r.code), r.symbol_id);
      });
      tx();
    }

    // The FTS table's shape is fixed at creation, so `CREATE VIRTUAL TABLE
    // IF NOT EXISTS` above is a no-op against a pre-existing single-column
    // chunks_fts - it has to be dropped and recreated to gain the `parts`
    // column.
    const ftsCols = this._stmt('PRAGMA table_info(chunks_fts)').all().map((c) => c.name);
    const ftsNeedsReshape = !ftsCols.includes('parts');
    if (ftsNeedsReshape) {
      this.db.exec(`
        DROP TABLE IF EXISTS chunks_fts;
        CREATE VIRTUAL TABLE chunks_fts USING fts5(code, parts, content='chunks', content_rowid='symbol_id');
      `);
      // Statements compiled against the dropped table are dead.
      this._stmtCache.clear();
    }

    // `CREATE TRIGGER IF NOT EXISTS` in SCHEMA only shapes a brand-new
    // database: against one that already has a trigger of that name it is a
    // silent no-op, so an existing brain kept its ORIGINAL single-column
    // trigger bodies even after chunks_fts gained the `parts` column. The
    // failure that causes is subtle - inserts go on writing only `code`, so
    // the index's per-column size records disagree with the table's
    // declared column count, and every bm25()-RANKED query on that brain
    // fails with "database disk image is malformed" while unranked rowid
    // queries keep working. Since searchLexical ranks by bm25, that is the
    // entire lexical half of the hybrid search silently returning nothing.
    const triggers = this._stmt(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('chunks_ai', 'chunks_ad', 'chunks_au')"
    ).all();
    const triggersStale = triggers.length < 3 || triggers.some((t) => !t.sql || !t.sql.includes('parts'));
    if (triggersStale) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS chunks_ai;
        DROP TRIGGER IF EXISTS chunks_ad;
        DROP TRIGGER IF EXISTS chunks_au;
        ${FTS_TRIGGERS}
      `);
      this._stmtCache.clear();
    }

    // `CREATE VIRTUAL TABLE IF NOT EXISTS` above creates chunks_fts empty on
    // a database that already had rows in `chunks` from before FTS existed -
    // the insert-trigger only fires on new writes, so pre-existing content
    // needs one explicit rebuild to become searchable.
    // EXISTS, not COUNT(*): these two only ever answer "is it empty?", but
    // COUNT(*) has to scan - and on chunks_fts, whose content is external,
    // it scans the chunks table. Measured at ~195ms of pure startup cost on
    // a 28k-chunk brain, paid on every process start, to compute two
    // numbers that are immediately compared against zero.
    const hasChunks = this._stmt('SELECT EXISTS(SELECT 1 FROM chunks) AS e').get().e === 1;
    const hasFtsRows = this._stmt('SELECT EXISTS(SELECT 1 FROM chunks_fts_docsize) AS e').get().e === 1;
    let needsRebuild = hasChunks && (!hasFtsRows || ftsNeedsReshape || addedParts || triggersStale);

    // Whatever the schema now says, the index itself may already have been
    // written through stale triggers. One bm25 probe is the cheapest way to
    // find out, and it's the exact query shape searchLexical uses.
    if (!needsRebuild && hasChunks) {
      try {
        this._stmt('SELECT rowid, bm25(chunks_fts) AS s FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 1').get('"a"');
      } catch (_) {
        needsRebuild = true;
      }
    }

    if (needsRebuild) {
      this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
    }
  }

  /**
   * Prepared-statement cache.
   *
   * Every query method here called `db.prepare()` inline, which recompiles
   * the SQL on each call - measured at ~75us per prepare against ~19us to
   * run an already-compiled statement. That's invisible per call and
   * dominant in aggregate: decorating 23 search results (one symbol + one
   * file lookup each) spent ~3.5ms of its 7ms purely compiling the same two
   * statements 46 times, and the caller-BFS in getCallers/getTestsForSymbol
   * re-runs those same lookups once per visited node.
   *
   * Statements are keyed by SQL text and are safe to reuse - SQLite
   * recompiles them itself if the schema changes underneath.
   */
  _stmt(sql) {
    let cached = this._stmtCache.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql);
      this._stmtCache.set(sql, cached);
    }
    return cached;
  }

  close() {
    this._stmtCache.clear();
    this.db.close();
  }

  /** Wipes every row (cascades from files to symbols/edges/chunks/string_literals) - used by a `--force` rebuild. */
  clearAll() {
    this.db.exec('DELETE FROM files');
  }

  getFileByPath(relPath) {
    return this._stmt('SELECT * FROM files WHERE path = ?').get(relPath);
  }

  /** Fully removes a file and everything that cascades from it (symbols, edges, chunks, string_literals). */
  deleteFile(relPath) {
    this._stmt('DELETE FROM files WHERE path = ?').run(relPath);
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

      const insertSymbol = this._stmt(
        `INSERT INTO symbols (file_id, name, kind, start_line, end_line, start_byte, end_byte, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      // chunks.code now holds the full (capped) symbol body - see parser.js's
      // nodeBody() - so it's actually searchable via chunks_fts, not just the
      // ~160-char signature. chunks.summary holds the symbol's leading doc
      // comment (see parser.js's leadingDoc): it feeds the embedding text at
      // build time, and its words are indexed in `parts` below so a plain-
      // English question can match the comment that describes the code.
      const insertChunk = this._stmt('INSERT INTO chunks (symbol_id, code, summary, parts) VALUES (?, ?, ?, ?)');
      const insertLiteral = this._stmt(
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
          sym.signature
        ).lastInsertRowid;
        nameToSymbolId.set(sym.name, symId);
        const chunkCode = sym.body != null ? sym.body : sym.signature;
        const doc = sym.doc || null;
        const parts = [identifierParts(chunkCode), commentWords(doc)].filter(Boolean).join(' ');
        insertChunk.run(symId, chunkCode, doc, parts);
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
   * Call-edge resolution is name-based and project-wide: after all files in
   * this build pass are inserted, look up each recorded call by callee name
   * anywhere in the graph. Simple, fast, and good enough for "who calls
   * this" style queries; it can over-match same-named functions across
   * files, which is a known, documented simplification.
   */
  insertCallEdges(fileId, calls) {
    const findSrc = this._stmt('SELECT id FROM symbols WHERE file_id = ? AND name = ?');
    const findDst = this._stmt('SELECT id FROM symbols WHERE name = ? LIMIT 5');
    const insertEdge = this._stmt(
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
    return this._stmt('SELECT * FROM symbols WHERE id = ?').get(id);
  }

  getFileById(id) {
    return this._stmt('SELECT * FROM files WHERE id = ?').get(id);
  }

  getChunk(symbolId) {
    return this._stmt('SELECT * FROM chunks WHERE symbol_id = ?').get(symbolId);
  }

  /**
   * One query term, expanded into everything that should count as a match
   * for it, as an FTS5 OR-group:
   *
   *   exact        "domaintoken"          the token as written
   *   prefix       "domaintoken"*         reaches encryptUsingAES256 from
   *                                       a query of encryptUsingAES
   *   sub-tokens   parts:"domain token"   reaches INSIDE getDomainTokenHeader,
   *                                       which the default tokenizer stores
   *                                       as one solid token
   *
   * The phrase form on `parts` (rather than ANDing the sub-tokens) keeps the
   * word order, so `domainToken` doesn't match a chunk that merely mentions
   * `token` and `domain` in unrelated places.
   */
  _expandTerm(term) {
    const quoted = (t) => `"${t.replace(/"/g, '""')}"`;
    const variants = [quoted(term), `${quoted(term)}*`];
    if (isCompoundIdentifier(term)) {
      // Same filtered run the index side stores (see indexableParts).
      const parts = indexableParts(term);
      if (parts.length) variants.push(`parts:${quoted(parts.join(' '))}`);
    }
    return `(${variants.join(' OR ')})`;
  }

  /**
   * Lexical/substring match over full symbol bodies via FTS5 (see the
   * chunks_fts virtual table) - complements vectorIndex's semantic search,
   * which can miss an exact identifier/string literal that only appears
   * inside a function body. Each raw query token is quoted so FTS5 treats it
   * as a literal term instead of parsing user input as FTS5 query syntax,
   * which would throw on stray `"`/`-`/`*` etc.
   *
   * Terms are ANDed, then retried as OR if that finds nothing: AND is the
   * right default for a precise multi-token identifier query, but it makes a
   * prose task description ("reader-launcher component token/slug/error
   * flow") require every word to co-occur in one symbol body, which is
   * almost never true and silently collapses the lexical half of the hybrid
   * search to nothing.
   *
   * `opts.andOnly` skips the OR retry and returns [] when the AND finds
   * nothing. The lexical fast path (query.js) uses it: there, an empty
   * answer must mean "not found" so the caller falls through to semantic
   * search, rather than being padded with loose any-word matches.
   */
  searchLexical(queryText, limit = 40, opts = {}) {
    let terms = (queryText.match(/[A-Za-z0-9_]+/g) || []).slice(0, 16);
    if (!terms.length) return [];
    // A sentence, not an identifier lookup: "how", "the" and "where" occur in
    // every comment, so OR-ing them in makes the match list noise. Keep the
    // words that carry meaning (and fall back to all of them if none do).
    if (terms.length >= 4) {
      const meaningful = terms.filter((t) => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()));
      if (meaningful.length) terms = meaningful;
    }
    const groups = terms.map((t) => this._expandTerm(t));

    // chunks_fts only exposes `rowid` (aliased to chunks.symbol_id via
    // content_rowid) and its declared columns (`code`, `parts`) -
    // `symbol_id` itself is NOT a selectable column on the FTS virtual
    // table, even though that's the name of the underlying content-table
    // column.
    const stmt = this._stmt(
      'SELECT rowid AS symbolId, bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?'
    );
    const run = (match) => {
      try {
        return stmt.all(match, limit);
      } catch (_) {
        return null; // malformed FTS query (e.g. all-punctuation input)
      }
    };

    // AND is the right first attempt for a short, precise query, but past a
    // few tokens the input is prose and AND is guaranteed to miss (no single
    // symbol body contains every word of a task description) - so spending
    // an FTS query to discover that is pure latency. Measured at ~2.5ms of
    // the ~5ms this method cost on a 7-word task query.
    const worthTryingAnd = groups.length <= 4;
    const andHits = worthTryingAnd ? run(groups.join(' AND ')) : null;
    if (andHits && andHits.length) return andHits;
    if (opts.andOnly || groups.length < 2) return andHits || [];
    const orHits = run(groups.join(' OR '));
    // degrade to semantic-only rather than fail the whole search
    return orHits || andHits || [];
  }

  /**
   * Symbols whose *name* matches a term, strongest match first: exact
   * (case-insensitive), then prefix, then compound-identifier containment
   * (`Token` finding `getCurrentToken`).
   *
   * This is the single most precise signal available for an
   * identifier-shaped query and it costs one pass over the symbols table (the
   * containment match is a leading-wildcard LIKE, so it can't use an index;
   * that stays cheap at the symbol counts a single repo has) - the case that
   * used to lose to grep outright. searchLexical matches anywhere in a
   * body, which is why it can rank a test that merely mentions a symbol
   * above the symbol's own declaration; this can't.
   *
   * `rank` (0 = exact) is what the caller sorts on - it is deliberately not
   * folded into a score here, since the two lists are fused by rank, not by
   * magnitude.
   */
  searchByName(term, limit = 40) {
    if (!term) return [];
    const like = term.replace(/[%_\\]/g, '\\$&');
    return this._stmt(
      `SELECT id AS symbolId,
              CASE
                WHEN name = ? COLLATE NOCASE THEN 0
                WHEN name LIKE ? ESCAPE '\\' THEN 1
                ELSE 2
              END AS rank
       FROM symbols
       WHERE name = ? COLLATE NOCASE OR name LIKE ? ESCAPE '\\'
       ORDER BY rank, LENGTH(name)
       LIMIT ?`
    ).all(term, `${like}%`, term, `%${like}%`, limit);
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

  /** Callers of + callees from a given symbol, `hops` deep, plus its direct storage-key peers (see getStorageKeyPeers). */
  expand(symbolId, hops = 1) {
    // Same class rollup getCallers does (see _rollupSeeds): expanding a
    // class that has no incoming call edges of its own would otherwise
    // return an empty neighborhood, which reads as "nothing uses this".
    const { seeds, memberNames } = this._rollupSeeds(symbolId);
    const visited = new Set(seeds);
    let frontier = seeds;
    const related = [];

    const outgoing = this._stmt('SELECT * FROM edges WHERE src_symbol_id = ?');
    const incoming = this._stmt('SELECT * FROM edges WHERE dst_symbol_id = ?');

    for (let h = 0; h < hops; h++) {
      const next = [];
      for (const id of frontier) {
        const viaMember = memberNames.get(id) || null;
        for (const e of outgoing.all(id)) {
          if (e.dst_symbol_id && !visited.has(e.dst_symbol_id)) {
            visited.add(e.dst_symbol_id);
            next.push(e.dst_symbol_id);
            related.push({ symbolId: e.dst_symbol_id, relation: 'callee', via: id, viaMember });
          }
        }
        for (const e of incoming.all(id)) {
          if (e.src_symbol_id && !visited.has(e.src_symbol_id)) {
            visited.add(e.src_symbol_id);
            next.push(e.src_symbol_id);
            related.push({ symbolId: e.src_symbol_id, relation: 'caller', via: id, viaMember });
          }
        }
      }
      frontier = next;
    }

    // Storage-key coupling is a second, independent edge kind (see
    // getStorageKeyPeers) - only checked against the root symbol, not
    // chained through each hop, since "shares a storage key with a peer of
    // a peer" isn't a meaningful transitive relation the way calls are.
    for (const seed of seeds) {
      for (const peer of this.getStorageKeyPeers(seed)) {
        if (visited.has(peer.symbolId)) continue;
        visited.add(peer.symbolId);
        related.push({
          symbolId: peer.symbolId,
          relation: 'shares-storage-key',
          via: seed,
          viaMember: memberNames.get(seed) || null,
          sharedKey: peer.key
        });
      }
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
  /**
   * The methods/functions declared inside a class, found by byte-range
   * containment within the class symbol's own span rather than by a stored
   * containment edge (there isn't one).
   *
   * This is what makes a class-level `brain check` mean anything. Classes
   * are never pushed onto the parser's scopeStack, so a call is always
   * attributed to the innermost method - and in an Angular/DI codebase the
   * class itself is never the target of a `call_expression` either, since
   * it arrives through constructor injection. The result was that every
   * class accumulated ~zero incoming edges and reported an empty, "untested"
   * blast radius even when its methods were called and tested everywhere.
   *
   * Byte ranges, not line ranges: a one-line class body would make
   * start_line/end_line containment ambiguous, and byte offsets are already
   * stored and exact.
   */
  getClassMembers(symbolId) {
    const cls = this.getSymbolById(Number(symbolId));
    if (!cls) return [];
    return this.db
      .prepare(
        `SELECT id, name, kind FROM symbols
         WHERE file_id = ? AND id != ? AND start_byte >= ? AND end_byte <= ?
           AND kind IN ('method', 'function', 'hook')
         ORDER BY start_byte`
      )
      .all(cls.file_id, cls.id, cls.start_byte, cls.end_byte);
  }

  /**
   * Seed set for a blast-radius/coverage walk: the symbol itself, plus - if
   * it's a class - every method declared in it, so "who depends on this
   * class" means "who depends on any of its surface" (see getClassMembers).
   * Returns the seeds and a symbolId -> member-name map for attribution.
   */
  _rollupSeeds(symbolId) {
    const id = Number(symbolId);
    const sym = this.getSymbolById(id);
    const seeds = [id];
    const memberNames = new Map();
    if (sym && sym.kind === 'class') {
      for (const m of this.getClassMembers(id)) {
        seeds.push(m.id);
        memberNames.set(m.id, m.name);
      }
    }
    return { seeds, memberNames };
  }

  /** Cached `how many symbols in this repo share this name` - see ambiguityFactor. */
  _nameFanout(name) {
    if (!this._fanoutCache) this._fanoutCache = new Map();
    if (this._fanoutCache.has(name)) return this._fanoutCache.get(name);
    const n = name
      ? this._stmt('SELECT COUNT(*) AS c FROM symbols WHERE name = ?').get(name).c
      : 1;
    this._fanoutCache.set(name, n);
    return n;
  }

  /** Confidence for one incoming edge traversed at hop `h` - see the constants above. */
  _scoreEdge(edge, h) {
    const base = RESOLUTION_BASE[edge.resolution] != null ? RESOLUTION_BASE[edge.resolution] : RESOLUTION_BASE.heuristic;
    // An LSP edge is already a precise resolution; penalizing it for a
    // name that happens to be common would be double-counting.
    const ambiguity = edge.resolution === 'lsp' ? 1 : ambiguityFactor(this._nameFanout(edge.dst_name));
    return base * Math.pow(HOP_DECAY, h - 1) * ambiguity;
  }

  /**
   * Sort by confidence, trim to `limit`, and report what was dropped rather
   * than silently truncating.
   */
  _rank(rows, { minConfidence = DEFAULT_MIN_CONFIDENCE, limit = DEFAULT_MAX_RESULTS } = {}) {
    const kept = rows
      .filter((r) => r.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence || a.hops - b.hops);
    const belowThreshold = rows.length - kept.length;
    const out = limit > 0 ? kept.slice(0, limit) : kept;
    out.omitted = { belowThreshold, overLimit: kept.length - out.length };
    return out;
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
   *
   * On a class symbol the walk is seeded from its methods too (see
   * _rollupSeeds); each result carries `viaMember` when it was reached that
   * way. Every result carries a `confidence` (see _scoreEdge), and the list
   * comes back sorted by it and trimmed - opts.minConfidence / opts.limit
   * override the defaults, and `.omitted` on the returned array says what
   * that cost.
   */
  getCallers(symbolId, maxHops = 3, opts = {}) {
    const incoming = this._stmt(
      'SELECT src_symbol_id AS id, dst_name, resolution FROM edges WHERE dst_symbol_id = ?'
    );
    const { seeds, memberNames } = this._rollupSeeds(symbolId);
    // Every seed is pre-visited: a class's own methods are the thing being
    // checked, not callers of it.
    const visited = new Set(seeds);
    let frontier = seeds.map((id) => ({ id, viaMember: memberNames.get(id) || null }));
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
          callers.push({
            symbolId: sym.id,
            name: sym.name,
            kind: sym.kind,
            path: file ? file.path : null,
            startLine: sym.start_line,
            endLine: sym.end_line,
            relation: 'caller',
            hops: h,
            resolution: row.resolution || 'heuristic',
            viaMember: node.viaMember,
            confidence: Number(this._scoreEdge(row, h).toFixed(3))
          });
          next.push({ id: row.id, viaMember: node.viaMember });
        }
      }
      frontier = next;
    }

    // Storage-key peers aren't "callers" in the call-graph sense this
    // method otherwise guarantees (see the docstring above), but for blast
    // radius purposes they're exactly the kind of thing that breaks if
    // `symbolId` changes - a reader of a key that this symbol's writer stops
    // writing. Reported flat (not hop-chained) alongside true callers.
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
          resolution: 'literal',
          viaMember: memberNames.get(seed) || null,
          confidence: STORAGE_PEER_CONFIDENCE
        });
      }
    }

    return this._rank(callers, opts);
  }

  /**
   * Walks incoming call edges from `symbolId` looking for symbols that live
   * in a test file (`files.is_test`), stopping at each hit instead of
   * walking through a test into whatever helper it calls. Used by
   * `brain check` to answer "is this covered by any test".
   */
  getTestsForSymbol(symbolId, maxHops = 6, opts = {}) {
    const incoming = this._stmt(
      'SELECT src_symbol_id AS id, dst_name, resolution FROM edges WHERE dst_symbol_id = ?'
    );
    const lookup = this._stmt(
      `SELECT s.id, s.name, s.kind, s.start_line, s.end_line, f.path AS file_path, f.is_test
       FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`
    );

    const { seeds, memberNames } = this._rollupSeeds(symbolId);
    const visited = new Set(seeds);
    let frontier = seeds.map((id) => ({ id, viaMember: memberNames.get(id) || null }));
    const hits = [];

    for (let h = 1; h <= maxHops && frontier.length; h++) {
      const next = [];
      for (const node of frontier) {
        for (const row of incoming.all(node.id)) {
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
              hops: h,
              resolution: row.resolution || 'heuristic',
              viaMember: node.viaMember,
              confidence: Number(this._scoreEdge(row, h).toFixed(3))
            });
          } else {
            next.push({ id: row.id, viaMember: node.viaMember });
          }
        }
      }
      frontier = next;
    }

    return this._rank(hits, opts);
  }

  /** Everything needed to render the whole graph in the HTML visualizer. */
  exportFullGraph() {
    const files = this._stmt('SELECT * FROM files').all();
    const symbols = this._stmt('SELECT * FROM symbols').all();
    const edges = this._stmt('SELECT * FROM edges WHERE dst_symbol_id IS NOT NULL').all();
    return { files, symbols, edges };
  }

  countSymbols() {
    return this._stmt('SELECT COUNT(*) AS c FROM symbols').get().c;
  }
}

module.exports = { GraphStore };
