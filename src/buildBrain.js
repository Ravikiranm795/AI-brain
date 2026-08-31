'use strict';

const fs = require('fs');
const path = require('path');
const { walkProject } = require('./walker');
const { hashFile } = require('./hasher');
const { parseFile } = require('./parser');
const { GraphStore } = require('./graphStore');
const { embedText } = require('./embedder');
const { VectorIndex } = require('./vectorIndex');
const { readManifest, writeManifest, diffAgainstManifest } = require('./manifest');
const { getRepoBrainDir, getRepoId } = require('./config');
const { writeInstructions } = require('./instructions');

async function buildBrain(rootDir, { onProgress = () => {}, force = false } = {}) {
  const root = path.resolve(rootDir);
  const brainDir = getRepoBrainDir(root);
  const repoId = getRepoId(root);

  onProgress(`Repo: ${root}`);
  onProgress(`Brain: ${brainDir}`);

  // 1. Walk (the one and only full traversal)
  const walked = walkProject(root);
  onProgress(`Found ${walked.length} source files`);

  // 2. Hash every file, diff against the last manifest
  const manifest = force ? { version: 1, rootDir: root, builtAt: null, files: {} } : readManifest(brainDir);
  const hashed = [];
  for (const f of walked) {
    const hash = await hashFile(f.absPath);
    const stat = fs.statSync(f.absPath);
    hashed.push({ ...f, hash, mtime: stat.mtimeMs });
  }
  const { changed, added, unchanged, deleted } = diffAgainstManifest(manifest, hashed);
  onProgress(`Changed: ${changed.length}, Added: ${added.length}, Unchanged: ${unchanged.length}, Deleted: ${deleted.length}`);

  const store = new GraphStore(brainDir);
  const vectorIndex = new VectorIndex(brainDir);

  try {
    // 3. Remove deleted files entirely (cascades to symbols/edges/chunks)
    for (const relPath of deleted) {
      const existing = store.getFileByPath(relPath);
      store.deleteFile(relPath);
      if (existing) {
        const oldSymbolIds = store.db
          .prepare('SELECT id FROM symbols WHERE file_id = ?')
          .all(existing.id)
          .map((r) => r.id);
        vectorIndex.removeIds(oldSymbolIds);
      }
      delete manifest.files[relPath];
    }

    // 4. Re-parse + re-embed only what changed or is new
    const toProcess = [...changed, ...added];
    let processedCount = 0;

    for (const f of toProcess) {
      // Wipe stale vectors for this file's old symbol ids before replacing
      const existing = store.getFileByPath(f.relPath);
      if (existing) {
        const oldSymbolIds = store.db
          .prepare('SELECT id FROM symbols WHERE file_id = ?')
          .all(existing.id)
          .map((r) => r.id);
        vectorIndex.removeIds(oldSymbolIds);
      }

      const source = fs.readFileSync(f.absPath, 'utf8');
      const parsed = parseFile(f.absPath, f.ext, source);
      const { fileId, nameToSymbolId } = store.upsertFile(f.relPath, f.hash, f.mtime, f.ext, parsed);
      store.insertCallEdges(fileId, parsed.calls, nameToSymbolId);

      // Embed each new symbol's chunk summary
      const symbolRows = store.db.prepare('SELECT id, name, kind, signature FROM symbols WHERE file_id = ?').all(fileId);
      const pairs = [];
      for (const sym of symbolRows) {
        const text = `${sym.kind} ${sym.name}: ${sym.signature}`;
        const vec = await embedText(text);
        pairs.push([sym.id, vec]);
      }
      if (pairs.length) vectorIndex.addBatch(pairs);

      manifest.files[f.relPath] = { hash: f.hash, mtime: f.mtime };
      processedCount++;
      if (processedCount % 25 === 0) onProgress(`  ...processed ${processedCount}/${toProcess.length}`);
    }

    vectorIndex.save();

    manifest.rootDir = root;
    manifest.builtAt = new Date().toISOString();
    manifest.repoId = repoId;
    writeManifest(brainDir, manifest);

    writeInstructions(root, brainDir, repoId);

    const totalSymbols = store.countSymbols();
    onProgress(`Done. ${totalSymbols} symbols indexed. Vector index size: ${vectorIndex.size}`);

    return {
      repoId,
      brainDir,
      stats: {
        filesTotal: walked.length,
        changed: changed.length,
        added: added.length,
        unchanged: unchanged.length,
        deleted: deleted.length,
        symbols: totalSymbols,
        vectors: vectorIndex.size
      }
    };
  } finally {
    store.close();
  }
}

module.exports = { buildBrain };
