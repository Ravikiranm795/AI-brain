'use strict';

const fs = require('fs');
const path = require('path');
const { getVizDataDir } = require('./config');
const { refreshAll, readIndex } = require('./vizData');

// The viewer's own files (src/viewer/) are copied next to the data they read,
// so the whole thing - page, scripts and snapshots - is one folder that can
// be opened from disk with no server, and moved or zipped as a unit.
const VIEWER_FILES = ['index.html', 'app.css', 'app.js', 'core.js'];

/** three.js ships a classic (non-module) build, which is what a file:// page can load. */
function threeBuild() {
  const build = path.join(path.dirname(require.resolve('three')), 'three.min.js');
  if (!fs.existsSync(build)) throw new Error(`three.js build not found at ${build} - run npm install`);
  return { js: build, license: path.join(path.dirname(build), '..', 'LICENSE') };
}

/**
 * Brings the shared data folder up to date and (re)writes the viewer into it.
 * Returns { dir, indexHtml, repos } where `repos` summarizes what's available.
 */
function generateCityViewer({ onProgress = () => {} } = {}) {
  const dir = getVizDataDir();
  refreshAll({ onProgress });

  for (const f of VIEWER_FILES) {
    fs.copyFileSync(path.join(__dirname, 'viewer', f), path.join(dir, f));
  }

  const vendor = path.join(dir, 'vendor');
  fs.mkdirSync(vendor, { recursive: true });
  const three = threeBuild();
  fs.copyFileSync(three.js, path.join(vendor, 'three.min.js'));
  if (fs.existsSync(three.license)) fs.copyFileSync(three.license, path.join(vendor, 'three.LICENSE'));

  const repos = readIndex().repos.map((r) => ({
    repoId: r.repoId,
    name: r.name,
    empty: !r.versions.length,
    versions: r.versions.map((v) => ({ id: v.id, builtAt: v.builtAt, symbols: v.counts.symbols }))
  }));
  return { dir, indexHtml: path.join(dir, 'index.html'), repos };
}

module.exports = { generateCityViewer };
