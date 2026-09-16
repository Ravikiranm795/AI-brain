'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Optional user overrides for the hardcoded defaults scattered across
 * config.js/context.js/storeCache.js/query.js. Looked up as
 * `brain.config.json` at the repo root (repo-specific overrides) and at
 * BRAIN_HOME (machine-wide defaults, e.g. for StoreCache's maxOpen which
 * isn't tied to any one repo). Repo-level wins when both exist. Neither
 * file existing is the common case and costs two fs.existsSync calls.
 *
 * Recognized keys (all optional):
 *   ignoreDirs         string[] - directory names ADDED to DEFAULT_IGNORE_DIRS
 *   extraExtensions    string[] - file extensions ADDED to SUPPORTED_EXTENSIONS (e.g. [".mts"])
 *   defaultBudgetChars number   - overrides context.js's DEFAULT_BUDGET_CHARS
 *   maxItems           number   - overrides context.js's MAX_ITEMS
 *   maxOpen            number   - overrides storeCache.js's MAX_OPEN
 *   rrfK               number   - overrides query.js's RRF_K hybrid-search fusion constant
 */
function readConfigFile(p) {
  if (!p || !fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null; // malformed config - ignore rather than fail every tool call over a typo
  }
}

const cache = new Map();

/**
 * `rootDir` may be null/omitted for process-wide-only lookups (e.g.
 * StoreCache, which spans multiple repos and has no single repo root).
 * Cached per (rootDir, brainsHome) pair for the life of the process - config
 * files aren't expected to change mid-session.
 */
function loadUserConfig(rootDir, brainsHome) {
  const key = `${rootDir || ''}::${brainsHome || ''}`;
  if (cache.has(key)) return cache.get(key);

  const homeLevel = readConfigFile(brainsHome && path.join(brainsHome, 'brain.config.json'));
  const repoLevel = readConfigFile(rootDir && path.join(rootDir, 'brain.config.json'));
  const merged = Object.assign({}, homeLevel || {}, repoLevel || {});
  cache.set(key, merged);
  return merged;
}

module.exports = { loadUserConfig };
