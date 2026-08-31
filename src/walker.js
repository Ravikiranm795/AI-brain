'use strict';

const fs = require('fs');
const path = require('path');
const ignoreLib = require('ignore');
const { SUPPORTED_EXTENSIONS, DEFAULT_IGNORE_DIRS } = require('./config');

/**
 * Walks the project ONCE. This is the only full directory traversal the
 * whole tool ever does per build - after this, everything is done through
 * the manifest hash diff, never a re-walk of the same size.
 */
function walkProject(rootDir) {
  const ig = ignoreLib();
  ig.add(DEFAULT_IGNORE_DIRS.map((d) => `${d}/`));

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

      if (DEFAULT_IGNORE_DIRS.includes(entry.name)) continue;
      if (ig.ignores(rel)) continue;

      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          results.push({ absPath: abs, relPath: rel, ext });
        }
      }
    }
  }

  walk(rootDir);
  return results;
}

module.exports = { walkProject };
