'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VectorIndex } = require('../src/vectorIndex');
const { EMBEDDING_DIM } = require('../src/embedder');
const { tempDir } = require('./helpers');

// Deterministic unit vectors from a seeded generator.
function seededVectors(n) {
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
  return Array.from({ length: n }, () => {
    const v = Float32Array.from({ length: EMBEDDING_DIM }, rand);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / norm);
  });
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function indexOf(vectors) {
  const { dir, cleanup } = tempDir();
  const index = new VectorIndex(dir);
  index.addBatch(vectors.map((v, i) => [i + 1, v]));
  return { index, cleanup };
}

test('search returns the same top-k as a full sort', () => {
  const vectors = seededVectors(200);
  const { index, cleanup } = indexOf(vectors);
  try {
    const query = vectors[17];
    const expected = vectors
      .map((v, i) => ({ symbolId: i + 1, score: Math.fround(dot(query, v)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    const got = index.search(query, 10);
    assert.equal(got.length, 10);
    assert.deepEqual(got.map((h) => h.symbolId), expected.map((h) => h.symbolId));
    assert.equal(got[0].symbolId, 18); // a vector is its own nearest neighbour
  } finally {
    cleanup();
  }
});

test('search returns results best-first', () => {
  const vectors = seededVectors(50);
  const { index, cleanup } = indexOf(vectors);
  try {
    const scores = index.search(vectors[3], 20).map((h) => h.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  } finally {
    cleanup();
  }
});

test('search clamps k to the index size', () => {
  const { index, cleanup } = indexOf(seededVectors(5));
  try {
    assert.equal(index.search(seededVectors(1)[0], 50).length, 5);
  } finally {
    cleanup();
  }
});

test('search handles an empty index and a non-positive k without throwing', () => {
  const { dir, cleanup } = tempDir();
  try {
    assert.deepEqual(new VectorIndex(dir).search(seededVectors(1)[0], 10), []);
  } finally {
    cleanup();
  }
  const { index, cleanup: cleanup2 } = indexOf(seededVectors(5));
  try {
    assert.deepEqual(index.search(seededVectors(1)[0], 0), []);
    assert.deepEqual(index.search(seededVectors(1)[0], -3), []);
  } finally {
    cleanup2();
  }
});
