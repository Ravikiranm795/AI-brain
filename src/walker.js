'use strict';

const fs = require('fs');
const path = require('path');
const ignoreLib = require('ignore');
const { MAX_FILE_SIZE_BYTES, getEffectiveIgnoreDirs, getEffectiveSupportedExtensions } = require('./config');

// Minified bundles slip through directory-name-based ignores (they're often
// checked in outside node_modules/dist/build, e.g. a vendored `jquery.min.js`
// next to source) and are useless/expensive to parse+embed: no meaningful
// symbol boundaries, and a single file can be megabytes of one line.
const MINIFIED_RE = /\.min\.(js|css)$/i;

/**
 * Walks the project ONCE. This is the only full directory traversal the
 * whole tool ever does per build - after this, everything is done through
 * the manifest hash diff, never a re-walk of the same size.
 */
function walkProject(rootDir) {
  const ignoreDirs = getEffectiveIgnoreDirs(rootDir);
  const supportedExtensions = getEffectiveSupportedExtensions(rootDir);

  const ig = ignoreLib();
  ig.add(ignoreDirs.map((d) => `${d}/`));

  const gitignorePath = path.join(rootDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, 'utf8'));
  }

  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return; // permission errors etc - skip silently
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootDir, abs).split(path.sep).join('/');

      if (ignoreDirs.includes(entry.name)) continue;
      if (ig.ignores(rel)) continue;

      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        // The tool's own repo-root config file (see userConfig.js) - never
        // worth indexing as project content.
        if (rel === 'brain.config.json') continue;

        const ext = path.extname(entry.name);
        if (!supportedExtensions.has(ext)) continue;
        if (MINIFIED_RE.test(entry.name)) continue;

        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch (_) {
          continue; // race with a deleted file, permission error, etc.
        }
        if (size > MAX_FILE_SIZE_BYTES) continue;

        results.push({ absPath: abs, relPath: rel, ext });
      }
    }
  }

  walk(rootDir);
  return results;
}

module.exports = { walkProject };
