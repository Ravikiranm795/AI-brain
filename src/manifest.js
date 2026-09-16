'use strict';

const fs = require('fs');
const path = require('path');

// Bump whenever a change alters what gets stored per-symbol independent of
// the source file's own hash (e.g. chunks.code switching from a truncated
// signature to the full body - see parser.js's nodeBody()/graphStore.js's
// upsertFile). buildBrain.js compares this against the manifest's own
// contentVersion and forces one full rebuild when they differ, so existing
// indexed repos pick up the new content shape on their next `brain build`
// without the user needing to know about `--force`.
const CONTENT_VERSION = 2;

function manifestPath(brainDir) {
  return path.join(brainDir, 'manifest.json');
}

function readManifest(brainDir) {
  const p = manifestPath(brainDir);
  if (!fs.existsSync(p)) {
    return { version: 1, rootDir: null, builtAt: null, files: {} };
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeManifest(brainDir, manifest) {
  fs.writeFileSync(manifestPath(brainDir), JSON.stringify(manifest, null, 2));
}

/**
 * The core of "never rescan everything again": compares this walk's file
 * hashes against the last build's manifest and returns exactly what needs
 * work. On an unchanged repo this returns empty changed/added/deleted -
 * the build becomes a near-instant no-op.
 */
function diffAgainstManifest(manifest, currentFiles) {
  const changed = [];
  const added = [];
  const unchanged = [];
  const seen = new Set();

  for (const f of currentFiles) {
    seen.add(f.relPath);
    const prev = manifest.files[f.relPath];
    if (!prev) {
      added.push(f);
    } else if (prev.hash !== f.hash) {
      changed.push(f);
    } else {
      unchanged.push(f);
    }
  }

  const deleted = Object.keys(manifest.files).filter((p) => !seen.has(p));

  return { changed, added, unchanged, deleted };
}

module.exports = { readManifest, writeManifest, diffAgainstManifest, CONTENT_VERSION };
