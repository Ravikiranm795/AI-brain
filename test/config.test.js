'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { StoreCache } = require('../src/storeCache');
const { tempDir } = require('./helpers');

// Runs fn with BRAIN_HOME pointed at a fresh temp directory.
function withBrainHome(fn) {
  const home = tempDir('brain-home-');
  const prev = process.env.BRAIN_HOME;
  process.env.BRAIN_HOME = home.dir;
  try {
    return fn(home.dir);
  } finally {
    if (prev === undefined) delete process.env.BRAIN_HOME;
    else process.env.BRAIN_HOME = prev;
    home.cleanup();
  }
}

function writeLegacyBrain(home, name, rootDir, mtimeSec) {
  const dir = path.join(home, name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ rootDir }));
  fs.writeFileSync(path.join(dir, 'graph.sqlite'), name);
  fs.utimesSync(manifest, mtimeSec, mtimeSec);
  return dir;
}

test('getRepoId is stable across trailing separators and relative spellings', () => {
  const repo = tempDir('brain-repo-');
  try {
    const id = config.getRepoId(repo.dir);
    assert.equal(config.getRepoId(repo.dir + path.sep), id);
    assert.equal(config.getRepoId(path.join(repo.dir, 'sub', '..')), id);
  } finally {
    repo.cleanup();
  }
});

test('getRepoId ignores drive/path casing on Windows only', { skip: process.platform !== 'win32' }, () => {
  const repo = tempDir('brain-repo-');
  try {
    assert.equal(config.getRepoId(repo.dir.toUpperCase()), config.getRepoId(repo.dir.toLowerCase()));
  } finally {
    repo.cleanup();
  }
});

test('a not-yet-existing root is re-resolved once it exists, not cached unresolved', () => {
  const repo = tempDir('brain-repo-');
  try {
    const target = path.join(repo.dir, 'created-later');
    config.canonicalizeRootPath(target); // root doesn't exist yet
    fs.mkdirSync(target);
    let expected = fs.realpathSync.native(target);
    if (process.platform === 'win32') expected = expected.toLowerCase();
    assert.equal(config.canonicalizeRootPath(target), expected);
  } finally {
    repo.cleanup();
  }
});

test('a legacy brain directory is adopted into the canonical location', () =>
  withBrainHome((home) => {
    const repo = tempDir('brain-repo-');
    try {
      const legacy = writeLegacyBrain(home, 'old-spelling-deadbeef', repo.dir, 1000);
      const dir = config.getRepoBrainDir(repo.dir);
      assert.equal(path.basename(dir), config.getRepoId(repo.dir));
      assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
      assert.equal(fs.existsSync(legacy), false);
      // Pinned: later calls in the same process answer identically.
      assert.equal(config.getRepoBrainDir(repo.dir), dir);
    } finally {
      repo.cleanup();
    }
  }));

test('with several legacy brains for one repo, the most recently built wins', () =>
  withBrainHome((home) => {
    const repo = tempDir('brain-repo-');
    try {
      writeLegacyBrain(home, 'aaa-oldest-00000001', repo.dir, 1000);
      writeLegacyBrain(home, 'zzz-newest-00000002', repo.dir, 3000);
      writeLegacyBrain(home, 'mmm-middle-00000003', repo.dir, 2000);
      const dir = config.getRepoBrainDir(repo.dir);
      assert.equal(fs.readFileSync(path.join(dir, 'graph.sqlite'), 'utf8'), 'zzz-newest-00000002');
    } finally {
      repo.cleanup();
    }
  }));

test('a manifest-less directory squatting on the canonical id is parked, not deleted', () =>
  withBrainHome((home) => {
    const repo = tempDir('brain-repo-');
    try {
      const squatter = path.join(home, config.getRepoId(repo.dir));
      fs.mkdirSync(squatter);
      fs.writeFileSync(path.join(squatter, 'graph.sqlite'), 'half-built');
      writeLegacyBrain(home, 'real-brain-00000004', repo.dir, 1000);

      const dir = config.getRepoBrainDir(repo.dir);
      assert.equal(fs.readFileSync(path.join(dir, 'graph.sqlite'), 'utf8'), 'real-brain-00000004');
      const parked = fs.readdirSync(home).filter((n) => n.includes('.superseded-'));
      assert.equal(parked.length, 1);
      assert.equal(fs.readFileSync(path.join(home, parked[0], 'graph.sqlite'), 'utf8'), 'half-built');
      // ...and parked directories are not listed as brains.
      assert.equal(config.listAllRepoBrains().some((b) => b.repoId.includes('.superseded-')), false);
    } finally {
      repo.cleanup();
    }
  }));

test('a brain that does not belong to this repo is left alone', () =>
  withBrainHome((home) => {
    const repo = tempDir('brain-repo-');
    const other = tempDir('brain-other-');
    try {
      const foreign = writeLegacyBrain(home, 'foreign-00000005', other.dir, 1000);
      config.getRepoBrainDir(repo.dir);
      assert.ok(fs.existsSync(foreign));
    } finally {
      repo.cleanup();
      other.cleanup();
    }
  }));

test('StoreCache keys one brain directory under one entry regardless of spelling', () =>
  withBrainHome((home) => {
    const cache = new StoreCache();
    const brain = path.join(home, 'some-brain');
    fs.mkdirSync(brain);
    try {
      const a = cache.get(brain);
      const b = cache.get(brain + path.sep);
      assert.equal(a, b);
      if (process.platform === 'win32') assert.equal(cache.get(brain.toUpperCase()), a);
      assert.equal(cache.entries.size, 1);
    } finally {
      for (const e of cache.entries.values()) e.store.close();
    }
  }));
