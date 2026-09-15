'use strict';

const { GraphStore } = require('./graphStore');
const { VectorIndex } = require('./vectorIndex');

const MAX_OPEN = 5;

/**
 * Keeps GraphStore/VectorIndex pairs open across many MCP tool calls for the
 * same repo, instead of the CLI's per-invocation open+close - the whole
 * point of a long-lived server process. Small LRU cap so a session that
 * touches many repos doesn't accumulate unbounded open file handles.
 */
class StoreCache {
  constructor() {
    this.entries = new Map(); // brainDir -> { store, vectorIndex, lastUsed }
  }

  get(brainDir) {
    let entry = this.entries.get(brainDir);
    if (!entry) {
      entry = { store: new GraphStore(brainDir), vectorIndex: new VectorIndex(brainDir) };
      this.entries.set(brainDir, entry);
      this._evictLeastRecentlyUsedIfOverCap();
    }
    entry.lastUsed = Date.now();
    return entry;
  }

  /**
   * Must be called right after a `brain_build` for this brainDir - the
   * build opens its own independent GraphStore/VectorIndex internally, so a
   * cached VectorIndex here would keep serving pre-build data forever
   * otherwise (it loads vectors.bin once at construction and never re-reads
   * it).
   */
  evict(brainDir) {
    const entry = this.entries.get(brainDir);
    if (entry) {
      entry.store.close();
      this.entries.delete(brainDir);
    }
  }

  _evictLeastRecentlyUsedIfOverCap() {
    if (this.entries.size <= MAX_OPEN) return;
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.entries) {
      if ((entry.lastUsed || 0) < oldestTime) {
        oldestTime = entry.lastUsed || 0;
        oldestKey = key;
      }
    }
    if (oldestKey) this.evict(oldestKey);
  }

  closeAll() {
    for (const brainDir of [...this.entries.keys()]) this.evict(brainDir);
  }
}

module.exports = { StoreCache };
