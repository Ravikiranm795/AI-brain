'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { GraphStore } = require('../src/graphStore');
const { identifierParts } = require('../src/identifiers');
const { tempDir, parsedSymbols } = require('./helpers');

function withStore(fn) {
  const { dir, cleanup } = tempDir();
  const store = new GraphStore(dir);
  try {
    return fn(store, dir);
  } finally {
    store.close();
    cleanup();
  }
}

function idsFor(store, name) {
  return store.db.prepare('SELECT id FROM symbols WHERE name = ?').all(name).map((r) => r.id);
}

test('searchLexical reaches inside a camelCase identifier via the parts column', () =>
  withStore((store) => {
    store.upsertFile('a.js', 'h', 1, '.js', parsedSymbols([
      { name: 'handler', body: 'function handler() { return getDomainTokenHeader(); }' },
      { name: 'other', body: 'function other() { return 1; }' }
    ]));
    const hits = store.searchLexical('domainToken');
    assert.deepEqual(hits.map((h) => h.symbolId), idsFor(store, 'handler'));
  }));

test('a later compound identifier is still findable after an earlier one shares a sub-token', () =>
  withStore((store) => {
    // Regression for the per-sub-token dedupe bug in identifierParts.
    store.upsertFile('a.js', 'h', 1, '.js', parsedSymbols([
      { name: 'handler', body: 'function handler() { setDomain(); getDomainToken(); }' }
    ]));
    assert.equal(store.searchLexical('domainToken').length, 1);
  }));

test('searchLexical prefix-matches a longer token', () =>
  withStore((store) => {
    store.upsertFile('a.js', 'h', 1, '.js', parsedSymbols([
      { name: 'enc', body: 'function enc() { encryptUsingAES256(); }' }
    ]));
    assert.equal(store.searchLexical('encryptUsingAES').length, 1);
  }));

test('searchLexical falls back to OR unless andOnly is set', () =>
  withStore((store) => {
    store.upsertFile('a.js', 'h', 1, '.js', parsedSymbols([
      { name: 'one', body: 'function one() { alphaword(); }' },
      { name: 'two', body: 'function two() { betaword(); }' }
    ]));
    assert.equal(store.searchLexical('alphaword betaword').length, 2);
    assert.deepEqual(store.searchLexical('alphaword betaword', 40, { andOnly: true }), []);
  }));

test('searchLexical survives punctuation-only input', () =>
  withStore((store) => {
    assert.deepEqual(store.searchLexical('!!! ???'), []);
  }));

test('searchByName ranks exact, then prefix, then containment', () =>
  withStore((store) => {
    store.upsertFile('a.js', 'h', 1, '.js', parsedSymbols([
      { name: 'getCurrentToken' },
      { name: 'tokenize' },
      { name: 'Token' },
      { name: 'unrelated' }
    ]));
    const hits = store.searchByName('token');
    const names = hits.map((h) => store.getSymbolById(h.symbolId).name);
    assert.deepEqual(names, ['Token', 'tokenize', 'getCurrentToken']);
    assert.deepEqual(hits.map((h) => h.rank), [0, 1, 2]);
  }));

test('searchByName treats LIKE wildcards in the term literally', () =>
  withStore((store) => {
    store.upsertFile('a.js', 'h', 1, '.js', parsedSymbols([{ name: 'a_b' }, { name: 'axb' }]));
    const names = store.searchByName('a_b').map((h) => store.getSymbolById(h.symbolId).name);
    assert.deepEqual(names, ['a_b']);
  }));

test('FTS stays consistent when a file is re-upserted (update/delete triggers)', () =>
  withStore((store) => {
    store.upsertFile('a.js', 'h1', 1, '.js', parsedSymbols([{ name: 'f', body: 'function f() { oldMarkerToken(); }' }]));
    assert.equal(store.searchLexical('oldMarkerToken').length, 1);
    store.upsertFile('a.js', 'h2', 2, '.js', parsedSymbols([{ name: 'f', body: 'function f() { newMarkerToken(); }' }]));
    assert.equal(store.searchLexical('oldMarkerToken').length, 0);
    assert.equal(store.searchLexical('newMarkerToken').length, 1);
  }));

// The database shape a brain had before the `parts` column: single-column
// FTS table and single-column triggers, already holding rows.
function buildLegacyDb(dir) {
  const db = new Database(path.join(dir, 'graph.sqlite'));
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT UNIQUE NOT NULL, hash TEXT, mtime REAL, ext TEXT);
    CREATE TABLE symbols (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
      name TEXT, kind TEXT, start_line INTEGER, end_line INTEGER, start_byte INTEGER, end_byte INTEGER, signature TEXT);
    CREATE TABLE chunks (symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE, code TEXT, summary TEXT);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(code, content='chunks', content_rowid='symbol_id');
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, code) VALUES (new.symbol_id, new.code);
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, code) VALUES('delete', old.symbol_id, old.code);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, code) VALUES('delete', old.symbol_id, old.code);
      INSERT INTO chunks_fts(rowid, code) VALUES (new.symbol_id, new.code);
    END;
    INSERT INTO files (id, path, hash, mtime, ext) VALUES (1, 'a.js', 'h', 1, '.js');
    INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, start_byte, end_byte, signature)
      VALUES (1, 1, 'handler', 'function', 1, 3, 0, 10, 'handler()');
    INSERT INTO chunks (symbol_id, code) VALUES (1, 'function handler() { return getDomainTokenHeader(); }');
  `);
  db.close();
}

test('migrating a pre-parts brain backfills tokens, reshapes FTS, and keeps ranked queries working', () => {
  const { dir, cleanup } = tempDir();
  try {
    buildLegacyDb(dir);
    const store = new GraphStore(dir);
    try {
      const row = store.getChunk(1);
      assert.equal(row.parts, identifierParts(row.code));
      // The sub-token query only works if the FTS table was reshaped and rebuilt.
      assert.equal(store.searchLexical('domainToken').length, 1);
      // New writes after migration must go through the new triggers.
      store.upsertFile('b.js', 'h', 1, '.js', parsedSymbols([{ name: 'g', body: 'function g() { freshMarkerToken(); }' }]));
      assert.equal(store.searchLexical('freshMarkerToken').length, 1);
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});

test('migrating twice is a no-op', () => {
  const { dir, cleanup } = tempDir();
  try {
    buildLegacyDb(dir);
    new GraphStore(dir).close();
    const store = new GraphStore(dir);
    try {
      assert.equal(store.searchLexical('domainToken').length, 1);
    } finally {
      store.close();
    }
  } finally {
    cleanup();
  }
});
