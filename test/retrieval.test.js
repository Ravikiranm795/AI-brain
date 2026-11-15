'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseFile } = require('../src/parser');
const { GraphStore } = require('../src/graphStore');
const { VectorIndex } = require('../src/vectorIndex');
const { EMBEDDING_DIM } = require('../src/embedder');
const query = require('../src/query');
const { queryTerms, pathTokens, commentWords, embeddingText, STOPWORDS } = require('../src/identifiers');
const { tempDir, parsedSymbols } = require('./helpers');

/* ---------------------------------------------------------- text helpers */

test('queryTerms drops stop-words and short words, folds plurals, keeps numbers', () => {
  assert.deepEqual(queryTerms('Where do we retry a failed request after a 401 for the cookies?'), ['retry', 'failed', 'request', '401', 'cookie']);
  assert.deepEqual(queryTerms('How does the app notice'), ['app', 'notice']);
  assert.ok(STOPWORDS.has('the') && STOPWORDS.has('where'));
});

test('pathTokens splits file names into folded lowercase words', () => {
  const t = pathTokens('src/app/core/cookie-consent/CookieConsent.service.ts');
  for (const w of ['cookie', 'consent', 'service', 'core', 'app']) assert.ok(t.has(w), `missing ${w}`);
  assert.ok(pathTokens('a/services/x.ts').has('service'), 'plural folds to singular');
});

test('commentWords keeps meaningful words once, lowercase', () => {
  assert.equal(commentWords('Signs the user out. Signs them out after INACTIVITY.'), 'signs user inactivity');
});

test('embeddingText carries the name as words, the file words and the doc comment', () => {
  const text = embeddingText(
    { kind: 'class', name: 'IdleSessionService', signature: 'export class IdleSessionService {', doc: 'Signs the user out after inactivity' },
    'src/app/core/services/idle-session.service.ts'
  );
  assert.match(text, /idle session service/);
  assert.match(text, /in services \/ idle session service/);
  assert.match(text, /Signs the user out after inactivity/);
  assert.ok(text.length <= 700);
});

/* -------------------------------------------------------- doc comments */

test('the parser captures the comment above a symbol, including above `export class`', () => {
  const src = [
    '/**',
    ' * Signs the user out after a period of inactivity.',
    ' * @since 2',
    ' */',
    'export class IdleSession {',
    '  // checks the clock',
    '  tick() {}',
    '}',
    '',
    'function undocumented() {}'
  ].join('\n');
  const parsed = parseFile('x.ts', '.ts', src);
  const byName = Object.fromEntries(parsed.symbols.map((s) => [s.name, s]));
  assert.match(byName.IdleSession.doc, /Signs the user out after a period of inactivity/);
  assert.doesNotMatch(byName.IdleSession.doc, /@since|\*\//);
  assert.match(byName.tick.doc, /checks the clock/);
  assert.equal(byName.undocumented.doc, '');
});

test('a comment separated by a blank line is not attributed to the symbol', () => {
  const parsed = parseFile('x.ts', '.ts', '// license header\n\n\nfunction f() {}\n');
  assert.equal(parsed.symbols[0].doc, '');
});

/* ------------------------------------------------- lexical + doc indexing */

function withStore(fn) {
  const { dir, cleanup } = tempDir();
  const store = new GraphStore(dir);
  try {
    return fn(store);
  } finally {
    store.close();
    cleanup();
  }
}

test('a plain-English question finds code through the words of its doc comment', () =>
  withStore((store) => {
    const parsed = parsedSymbols([{ name: 'tick', body: 'function tick() { x(); }' }, { name: 'other', body: 'function other() { y(); }' }]);
    parsed.symbols[0].doc = 'Signs the visitor out after inactivity';
    store.upsertFile('a.ts', 'h', 1, '.ts', parsed);
    const hits = store.searchLexical('inactivity');
    assert.equal(hits.length, 1);
    assert.equal(store.getSymbolById(hits[0].symbolId).name, 'tick');
    assert.equal(store.getChunk(hits[0].symbolId).summary, 'Signs the visitor out after inactivity');
  }));

test('stop-words in a sentence do not drive the lexical match', () =>
  withStore((store) => {
    // "the" and "how" are in both bodies; only one body has the meaningful word.
    store.upsertFile('a.ts', 'h', 1, '.ts', parsedSymbols([
      { name: 'one', body: 'function one() { /* how the thing works */ }' },
      { name: 'two', body: 'function two() { /* how the thing works with throttling */ }' }
    ]));
    const hits = store.searchLexical('how does the thing work with throttling');
    assert.equal(store.getSymbolById(hits[0].symbolId).name, 'two');
  }));

/* ------------------------------------------------------ rank weights */

test('tests and suites are demoted unless the question is about tests', () => {
  assert.equal(query.rankWeight('method', 'src/a.ts', false), 1);
  assert.ok(query.rankWeight('test', 'src/a.spec.ts', false) < 0.5);
  assert.ok(query.rankWeight('suite', 'src/a.spec.ts', false) < 0.5);
  assert.ok(query.rankWeight('class', 'src/a.spec.ts', false) < 0.5, 'any symbol in a spec file');
  assert.equal(query.rankWeight('test', 'src/a.spec.ts', true), 1, 'test intent switches the demotion off');
  assert.ok(query.rankWeight('file', 'src/a.html', false) < 1, 'whole markup files are demoted mildly');
});

test('TEST_INTENT recognises questions about tests and ignores the rest', () => {
  for (const q of ['which tests cover login', 'add a unit test for the guard', 'the spec for token service', 'mock the http client']) assert.ok(query.TEST_INTENT.test(q), q);
  for (const q of ['where is the token refreshed', 'attestation of the contest']) assert.equal(query.TEST_INTENT.test(q), false, q);
});

test('the fast path ranks the real function ahead of the spec with the same name', () => {
  // Both are an exact name match; with weights the implementation must win.
  const store = {
    searchByName: () => [{ symbolId: 1, rank: 0 }, { symbolId: 2, rank: 0 }], // 1 = spec suite, 2 = function
    searchLexical: () => []
  };
  const weightOf = (id) => (id === 1 ? 0.35 : 1);
  const shape = query.classifyQuery('"slugify"');
  const { ranked } = query.lexicalFirstSearch(store, shape, 40, 60, weightOf);
  assert.deepEqual(ranked.map(([id]) => id), [2, 1]);
});

test('weights push a test below real code in the vector search', () => {
  const { dir, cleanup } = tempDir();
  try {
    const index = new VectorIndex(dir);
    const unit = (i) => Float32Array.from({ length: EMBEDDING_DIM }, (_, k) => (k === i ? 1 : 0));
    // symbol 1 (a test) is a slightly better match than symbol 2 (the code)
    const q = Float32Array.from({ length: EMBEDDING_DIM }, (_, k) => (k === 0 ? 0.8 : k === 1 ? 0.7 : 0));
    index.addBatch([[1, unit(0)], [2, unit(1)]]);
    assert.deepEqual(index.search(q, 2).map((h) => h.symbolId), [1, 2]);
    assert.deepEqual(index.search(q, 2, Float32Array.from([0.35, 1])).map((h) => h.symbolId), [2, 1]);
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------- path channel */

function metaOf(files) {
  // files: [{ id, path, symbols: [{id, kind, name, start_line}] }]
  const fileOf = new Map();
  const symbolsOfFile = new Map();
  const df = new Map();
  for (const f of files) {
    fileOf.set(f.id, { path: f.path, tokens: pathTokens(f.path), isTest: /\.spec\./.test(f.path) });
    symbolsOfFile.set(f.id, f.symbols);
    for (const t of pathTokens(f.path)) df.set(t, (df.get(t) || 0) + 1);
  }
  return { fileOf, symbolsOfFile, df, files: files.length };
}

test('the path channel finds the file whose name matches the question, class first', () => {
  const meta = metaOf([
    { id: 1, path: 'src/core/cookie-consent/cookie-consent.service.ts', symbols: [{ id: 10, kind: 'method', name: 'openBanner', start_line: 5 }, { id: 11, kind: 'class', name: 'CookieConsentService', start_line: 1 }] },
    { id: 2, path: 'src/core/cookie-consent/cookie-consent.service.spec.ts', symbols: [{ id: 20, kind: 'suite', name: 'CookieConsentService', start_line: 1 }] },
    { id: 3, path: 'src/core/token.service.ts', symbols: [{ id: 30, kind: 'class', name: 'TokenService', start_line: 1 }] },
    { id: 4, path: 'src/core/idle.service.ts', symbols: [{ id: 40, kind: 'class', name: 'IdleService', start_line: 1 }] }
  ]);
  const out = query.pathChannel(meta, queryTerms('Where is the cookie consent banner opened?'), false);
  assert.deepEqual(out[0], [11]); // one vote per file: its class
  assert.ok(!out.flat().includes(20), 'spec files are skipped unless the question is about tests');
  assert.ok(!out.flat().includes(30));
});

test('a single shared word never counts, however rare; two do', () => {
  const files = [
    { id: 1, path: 'src/s/kinesis.service.ts', symbols: [{ id: 10, kind: 'class', name: 'KinesisService', start_line: 1 }] },
    { id: 2, path: 'src/s/media-library.component.ts', symbols: [{ id: 20, kind: 'class', name: 'MediaLibraryComponent', start_line: 1 }] },
    { id: 3, path: 'src/s/institution-access.service.ts', symbols: [{ id: 30, kind: 'class', name: 'InstitutionAccessService', start_line: 1 }] }
  ];
  const meta = metaOf(files);
  // "institution" and "library" each match one file name: coincidence, not evidence
  assert.deepEqual(query.pathChannel(meta, queryTerms('institution library card disabled'), false), []);
  assert.deepEqual(query.pathChannel(meta, queryTerms('kinesis'), false), []);
  // two words in one name is evidence
  assert.deepEqual(query.pathChannel(meta, queryTerms('institution access denied'), false), [[30]]);
});

test('spreadAcrossFiles lets each file show two symbols before any shows a third, dropping nothing', () => {
  const r = (path, n) => ({ path, name: `${path}${n}` });
  const input = [r('a', 1), r('a', 2), r('a', 3), r('a', 4), r('b', 1), r('c', 1)];
  const out = query.spreadAcrossFiles(input);
  assert.deepEqual(out.map((x) => x.name), ['a1', 'a2', 'b1', 'c1', 'a3', 'a4']);
  assert.equal(out.length, input.length);
});
