'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Central store for ALL repo brains lives here.
 * Override with the BRAIN_HOME env var, e.g. on Windows:
 *   setx BRAIN_HOME C:\brains
 */
function getBrainsHome() {
  const home = process.env.BRAIN_HOME || path.join(os.homedir(), '.brains');
  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true });
  }
  return home;
}

/**
 * Every repo's id is just its folder name, so the brain directory reads
 * cleanly (e.g. `<BRAIN_HOME>/my-repo`) and re-running `brain build` from
 * that same repo always updates the same folder in place. If two different
 * repos share a basename, the second one's build reuses/overwrites the
 * first's brain folder - by design, kept simple.
 */
function getRepoId(rootDir) {
  const abs = path.resolve(rootDir);
  const base = path.basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return base || 'repo';
}

function getRepoBrainDir(rootDir) {
  const dir = path.join(getBrainsHome(), getRepoId(rootDir));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function listAllRepoBrains() {
  const home = getBrainsHome();
  return fs
    .readdirSync(home, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(home, d.name);
      const manifestPath = path.join(dir, 'manifest.json');
      let manifest = null;
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (_) {
          /* ignore corrupt manifest */
        }
      }
      return { repoId: d.name, dir, manifest };
    });
}

const SUPPORTED_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.java']);

const DEFAULT_IGNORE_DIRS = [
  'node_modules',
  '.git',
  '.brain',
  '.brains',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'vendor'
];

module.exports = {
  getBrainsHome,
  getRepoId,
  getRepoBrainDir,
  listAllRepoBrains,
  SUPPORTED_EXTENSIONS,
  DEFAULT_IGNORE_DIRS
};
