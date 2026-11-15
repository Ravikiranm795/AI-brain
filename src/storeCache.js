'use strict';

const path = require('path');
const { GraphStore } = require('./graphStore');
const { VectorIndex } = require('./vectorIndex');
const { getBrainsHome } = require('./config');
const { loadUserConfig } = require('./userConfig');

const DEFAULT_MAX_OPEN = 5;

/**
 * Keeps GraphStore/VectorIndex pairs open across many MCP tool calls for the
 * same repo, instead of the CLI's per-invocation open+close - the whole
 * point of a long-lived server process. Small LRU cap so a session that
 * touches many repos doesn't accumulate unbounded open file handles.
 */
class StoreCache {
  constructor() {
    this.entries = new Map(); // brainDir -> { store, vectorIndex, lastUsed }
    // StoreCache spans every repo this process touches, not one repo, so
    // its override can only come from the machine-wide BRAIN_HOME-level
    // brain.config.json, not a repo-level one (there's no single rootDir
    // here) - see userConfig.js.
    const userCfg = loadUserConfig(null, getBrainsHome());
    this.maxOpen = userCfg.maxOpen || DEFAULT_MAX_OPEN;
  }

  /**
   * Cache keys are canonicalized the same way repo roots are (see
   * config.js's canonicalizeRootPath): the map key has to be one spelling
   * per brain directory, or two calls in one session that differ only in
   * casing/separator open two independent GraphStore handles onto the same
   * sqlite file - doubling the handle count the LRU cap is there to bound,
   * and letting one call's writes go unseen by the other's already-loaded
   * VectorIndex.
   */
  _key(brainDir) {
    let key = path.resolve(brainDir);
    if (key.length > 1) key = key.replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? key.toLowerCase() : key;
  }

  get(brainDir) {
    const key = this._key(brainDir);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { store: new GraphStore(brainDir), vectorIndex: new VectorIndex(brainDir) };
      this.entries.set(key, entry);
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
    const key = this._key(brainDir);
    const entry = this.entries.get(key);
    if (entry) {
      entry.store.close();
      this.entries.delete(key);
    }
  }

  _evictLeastRecentlyUsedIfOverCap() {
    if (this.entries.size <= this.maxOpen) return;
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
