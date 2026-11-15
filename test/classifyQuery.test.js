'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyQuery, lexicalFirstSearch } = require('../src/query');

test('camelCase / snake_case / dotted queries are lexical-first', () => {
  assert.equal(classifyQuery('getUserToken').lexicalFirst, true);
  assert.equal(classifyQuery('user_token').lexicalFirst, true);
  assert.equal(classifyQuery('auth.service').lexicalFirst, true);
});

test('plain words and prose stay on the semantic path', () => {
  assert.equal(classifyQuery('authentication').lexicalFirst, false);
  assert.equal(classifyQuery('how does login work').lexicalFirst, false);
  assert.equal(classifyQuery('where is getUserToken used?').lexicalFirst, false);
  assert.equal(classifyQuery('').lexicalFirst, false);
});

test('a quoted single token is a literal and may search names', () => {
  const shape = classifyQuery('"encryptUsingAES"');
  assert.equal(shape.lexicalFirst, true);
  assert.equal(shape.nameSearch, true);
});

test('a quoted multi-word literal is body-only: it must not search symbol names', () => {
  const shape = classifyQuery('"user not found"');
  assert.equal(shape.lexicalFirst, true);
  assert.equal(shape.nameSearch, false);
});

// A stub store that records what lexicalFirstSearch asked of it.
function stubStore({ names = {}, body = [] } = {}) {
  const calls = { names: [], lexical: [] };
  return {
    calls,
    searchByName: (term) => {
      calls.names.push(term);
      return names[term] || [];
    },
    searchLexical: (text, limit, opts) => {
      calls.lexical.push({ text, opts });
      return body;
    }
  };
}

test('lexicalFirstSearch skips name search for multi-word quoted literals', () => {
  const store = stubStore({ names: { not: [{ symbolId: 1, rank: 2 }] } });
  const { confident } = lexicalFirstSearch(store, classifyQuery('"user not found"'), 40, 60);
  assert.deepEqual(store.calls.names, []);
  assert.equal(confident, false);
});

test('a containment-only name match (rank 2) is not confident on its own', () => {
  const store = stubStore({ names: { getToken: [{ symbolId: 1, rank: 2 }] } });
  const { confident, ranked } = lexicalFirstSearch(store, classifyQuery('getToken'), 40, 60);
  assert.equal(confident, false);
  assert.equal(ranked.length, 1); // still fused into the results
});

test('an exact or prefix name match is confident', () => {
  for (const rank of [0, 1]) {
    const store = stubStore({ names: { getToken: [{ symbolId: 1, rank }] } });
    assert.equal(lexicalFirstSearch(store, classifyQuery('getToken'), 40, 60).confident, true);
  }
});

test('body hits need corroboration, and the body search is AND-only', () => {
  const few = stubStore({ body: [{ symbolId: 1 }, { symbolId: 2 }] });
  assert.equal(lexicalFirstSearch(few, classifyQuery('"some literal"'), 40, 60).confident, false);
  assert.deepEqual(few.calls.lexical[0].opts, { andOnly: true });

  const many = stubStore({ body: [{ symbolId: 1 }, { symbolId: 2 }, { symbolId: 3 }] });
  assert.equal(lexicalFirstSearch(many, classifyQuery('"some literal"'), 40, 60).confident, true);
});

test('exact name hits outrank prefix hits, which outrank body-only hits', () => {
  const store = stubStore({
    names: { getToken: [{ symbolId: 10, rank: 0 }, { symbolId: 11, rank: 1 }] },
    body: [{ symbolId: 12 }]
  });
  const { ranked } = lexicalFirstSearch(store, classifyQuery('getToken'), 40, 60);
  assert.deepEqual(ranked.map(([id]) => id), [10, 11, 12]);
});
