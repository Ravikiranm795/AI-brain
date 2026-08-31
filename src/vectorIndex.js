'use strict';

const fs = require('fs');
const path = require('path');
const { EMBEDDING_DIM } = require('./embedder');

/**
 * A local, dependency-free ANN-style index: vectors are stored as a single
 * flat Float32Array binary file, ids in a parallel JSON array. Search is
 * brute-force cosine similarity.
 *
 * Why not a "real" HNSW index (usearch/faiss)? At the scale this tool
 * targets - tens of thousands of symbols per repo, not millions - a
 * normalized dot-product over a flat Float32Array is already sub-20ms in
 * plain JS, and this approach has zero native-binary install risk across
 * Windows/Mac/Linux. Swap this module for usearch later if a repo's symbol
 * count grows past ~200k and search time becomes noticeable.
 */
class VectorIndex {
  constructor(brainDir) {
    this.dir = brainDir;
    this.binPath = path.join(brainDir, 'vectors.bin');
    this.metaPath = path.join(brainDir, 'vectors.meta.json');
    this.ids = [];
    this.vectors = null; // Float32Array, length = ids.length * EMBEDDING_DIM
    this._load();
  }

  _load() {
    if (fs.existsSync(this.metaPath) && fs.existsSync(this.binPath)) {
      this.ids = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      const buf = fs.readFileSync(this.binPath);
      this.vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    } else {
      this.ids = [];
      this.vectors = new Float32Array(0);
    }
  }

  _save() {
    fs.writeFileSync(this.metaPath, JSON.stringify(this.ids));
    fs.writeFileSync(this.binPath, Buffer.from(this.vectors.buffer, this.vectors.byteOffset, this.vectors.byteLength));
  }

  /** Removes any existing vectors for the given symbol ids (used before re-adding on rebuild). */
  removeIds(idsToRemove) {
    const removeSet = new Set(idsToRemove);
    const keepIdx = [];
    for (let i = 0; i < this.ids.length; i++) {
      if (!removeSet.has(this.ids[i])) keepIdx.push(i);
    }
    const newIds = keepIdx.map((i) => this.ids[i]);
    const newVectors = new Float32Array(keepIdx.length * EMBEDDING_DIM);
    keepIdx.forEach((oldI, newI) => {
      newVectors.set(this.vectors.subarray(oldI * EMBEDDING_DIM, oldI * EMBEDDING_DIM + EMBEDDING_DIM), newI * EMBEDDING_DIM);
    });
    this.ids = newIds;
    this.vectors = newVectors;
  }

  addBatch(idVectorPairs) {
    const extra = new Float32Array(idVectorPairs.length * EMBEDDING_DIM);
    idVectorPairs.forEach(([id, vec], i) => {
      extra.set(vec, i * EMBEDDING_DIM);
      this.ids.push(id);
    });
    const merged = new Float32Array(this.vectors.length + extra.length);
    merged.set(this.vectors, 0);
    merged.set(extra, this.vectors.length);
    this.vectors = merged;
  }

  save() {
    this._save();
  }

  search(queryVec, k = 10) {
    const n = this.ids.length;
    const scores = new Array(n);
    for (let i = 0; i < n; i++) {
      let dot = 0;
      const base = i * EMBEDDING_DIM;
      for (let d = 0; d < EMBEDDING_DIM; d++) {
        dot += this.vectors[base + d] * queryVec[d];
      }
      scores[i] = dot; // vectors are pre-normalized -> dot product == cosine similarity
    }
    const indexed = scores.map((s, i) => [s, this.ids[i]]);
    indexed.sort((a, b) => b[0] - a[0]);
    return indexed.slice(0, k).map(([score, id]) => ({ symbolId: id, score }));
  }

  get size() {
    return this.ids.length;
  }
}

module.exports = { VectorIndex };
