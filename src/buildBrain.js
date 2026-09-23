'use strict';

const fs = require('fs');
const path = require('path');
const { walkProject } = require('./walker');
const { hashFile } = require('./hasher');
const { parseFile } = require('./parser');
const { GraphStore } = require('./graphStore');
const { embedBatch } = require('./embedder');
const { VectorIndex } = require('./vectorIndex');
const { readManifest, writeManifest, diffAgainstManifest, CONTENT_VERSION } = require('./manifest');
const { getRepoBrainDir, getRepoId, VECTOR_INDEX_WARN_THRESHOLD } = require('./config');
const { writeInstructions } = require('./instructions');

async function buildBrain(rootDir, { onProgress = () => {}, force = false, precise = false, instructions = true } = {}) {
  const root = path.resolve(rootDir);
  const brainDir = getRepoBrainDir(root);
  const repoId = getRepoId(root);

  onProgress(`Repo: ${root}`);
  onProgress(`Brain: ${brainDir}`);

  // 1. Walk (the one and only full traversal)
  const walked = walkProject(root);
  onProgress(`Found ${walked.length} source files`);

  // 2. Hash every file, diff against the last manifest
  const priorManifest = force ? null : readManifest(brainDir);
  // A content-shape change (e.g. chunks.code now storing full bodies - see
  // manifest.js's CONTENT_VERSION) invalidates every file's cached
  // symbols/embeddings even though the file itself hasn't changed, so treat
  // it exactly like --force for this one build.
  const contentUpgrade = !force && !!priorManifest && priorManifest.contentVersion !== CONTENT_VERSION;
  if (contentUpgrade) {
    onProgress('Brain content format upgraded - forcing one full rebuild to pick up the new format.');
  }
  force = force || contentUpgrade;
  const manifest = force ? { version: 1, rootDir: root, builtAt: null, files: {} } : priorManifest;
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
    // `force` promises "rebuild everything from scratch" - actually wipe
    // existing rows/vectors first, otherwise a file that's been removed (or
    // renamed) since the last build leaves stale symbols/edges behind
    // forever, since an empty manifest also makes the deleted-files diff
    // below come back empty (nothing to compare against).
    if (force) {
      store.clearAll();
      vectorIndex.clear();
    }

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

    // 4. Re-parse what changed or is new (fast: no I/O beyond one read per
    // file, tree-sitter parsing, and sqlite writes). Embedding - the actual
    // bottleneck, an ONNX forward pass per call - is deferred to one global
    // batched pass below instead of running once per file: transformers.js's
    // per-call overhead (tokenization setup, tensor allocation) dominates at
    // small batch sizes, so 3,000 single-file batches of ~5 symbols each is
    // far slower than a few dozen batches of hundreds - same total symbols
    // embedded, far fewer round trips into the runtime.
    const toProcess = [...changed, ...added];
    let processedCount = 0;
    const parseT0 = Date.now();
    // Call-edge resolution is deferred to a further pass below (see the
    // comment there for why) - collect each file's parsed calls here first.
    const pendingCallEdges = [];
    // { id, text } for every new/changed symbol across ALL files in this
    // pass - fed to the single embedBatch pass below instead of per file.
    const pendingEmbeds = [];

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
      const { fileId } = store.upsertFile(f.relPath, f.hash, f.mtime, f.ext, parsed);
      pendingCallEdges.push({ fileId, relPath: f.relPath, ext: f.ext, source, calls: parsed.calls });

      const symbolRows = store.db.prepare('SELECT id, name, kind, signature FROM symbols WHERE file_id = ?').all(fileId);
      for (const sym of symbolRows) {
        pendingEmbeds.push({ id: sym.id, text: `${sym.kind} ${sym.name}: ${sym.signature}` });
      }

      manifest.files[f.relPath] = { hash: f.hash, mtime: f.mtime };
      processedCount++;
      if (processedCount % 100 === 0 || processedCount === toProcess.length) {
        const pct = ((processedCount / toProcess.length) * 100).toFixed(0);
        onProgress(`  ...parsed ${processedCount}/${toProcess.length} files (${pct}%)`);
      }
    }
    if (toProcess.length) {
      onProgress(`Parsed ${toProcess.length} files in ${((Date.now() - parseT0) / 1000).toFixed(1)}s`);
    }

    // Resolve call edges only now that every file in this pass has its
    // symbols inserted - doing this per-file inline (as this loop used to)
    // meant a call to a symbol in a file processed LATER in the same pass
    // would never resolve, since that symbol didn't exist yet at lookup
    // time. That's most of a fresh/forced build, not an edge case.
    for (const { fileId, calls } of pendingCallEdges) {
      store.insertCallEdges(fileId, calls);
    }

    // One global batched embedding pass - see the comment above pendingEmbeds
    // for why this replaces the old one-batch-per-file loop.
    const EMBED_BATCH_SIZE = 256;
    const embedT0 = Date.now();
    for (let i = 0; i < pendingEmbeds.length; i += EMBED_BATCH_SIZE) {
      const batch = pendingEmbeds.slice(i, i + EMBED_BATCH_SIZE);
      const vecs = await embedBatch(batch.map((b) => b.text));
      vectorIndex.addBatch(batch.map((b, j) => [b.id, vecs[j]]));
      const done = Math.min(i + EMBED_BATCH_SIZE, pendingEmbeds.length);
      const pct = pendingEmbeds.length ? ((done / pendingEmbeds.length) * 100).toFixed(0) : 100;
      onProgress(`  ...embedded ${done}/${pendingEmbeds.length} symbols (${pct}%)`);
    }
    if (pendingEmbeds.length) {
      onProgress(`Embedded ${pendingEmbeds.length} symbols in ${((Date.now() - embedT0) / 1000).toFixed(1)}s`);
    }

    // Optional precision pass: opt-in (`--precise`) because it depends on an
    // externally-installed language server and is slower than the default
    // heuristic. Never lets a missing/unresponsive server fail the build -
    // resolvePreciseCallEdges reports one warning per language and moves on.
    if (precise && pendingCallEdges.length) {
      try {
        const { resolvePreciseCallEdges } = require('./lsp/resolveCalls');
        await resolvePreciseCallEdges(root, store, pendingCallEdges, onProgress);
      } catch (err) {
        onProgress(`Precise call resolution skipped: ${err.message}`);
      }
    }

    vectorIndex.save();

    const totalSymbols = store.countSymbols();

    manifest.rootDir = root;
    manifest.builtAt = new Date().toISOString();
    manifest.repoId = repoId;
    manifest.contentVersion = CONTENT_VERSION;
    // Cheap to read back later (see config.js's summarizeManifest/
    // listAllRepoBrains) without opening graph.sqlite just to answer "how
    // big is this brain" for a listing.
    manifest.stats = { filesTotal: walked.length, symbols: totalSymbols, vectors: vectorIndex.size };
    writeManifest(brainDir, manifest);

    if (instructions) writeInstructions(root, brainDir, repoId);

    onProgress(`Done. ${totalSymbols} symbols indexed. Vector index size: ${vectorIndex.size}`);
    // vectorIndex.js documents a ~200k-symbol design ceiling for its
    // brute-force cosine search (no ANN structure) - warn well before that,
    // so a growing repo gets a heads-up instead of a silent slowdown.
    if (vectorIndex.size > VECTOR_INDEX_WARN_THRESHOLD) {
      onProgress(
        `WARNING: vector index has ${vectorIndex.size} symbols, past the ${VECTOR_INDEX_WARN_THRESHOLD}-symbol early-warning ` +
        `threshold for the brute-force cosine search (~200k documented ceiling - see vectorIndex.js). Search will keep working ` +
        `but may start to noticeably slow down as this grows.`
      );
    }

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
