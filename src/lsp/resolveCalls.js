'use strict';

const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { LspClient } = require('./client');
const { REGISTRY, languageForExt } = require('./servers');

function uriToRelPath(uri, rootDir) {
  try {
    const abs = fileURLToPath(uri);
    const rel = path.relative(rootDir, abs).split(path.sep).join('/');
    return rel.startsWith('..') ? null : rel;
  } catch (_) {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A definition request fired immediately after didOpen reliably comes back
// empty - the server needs a moment to actually analyze a just-opened file
// before it can answer intelligence requests about it. Waiting for the
// server's own diagnostics notification would be more precise, but a fixed
// settle time after opening every file once (rather than per file) is far
// simpler and good enough for this best-effort feature.
const ANALYSIS_SETTLE_MS = 1500;

/**
 * Groups this build pass's changed/added files by LSP-registered language,
 * spins up one language server per language (reused across every file of
 * that language, never per-file - project load alone can take seconds),
 * and asks textDocument/definition at each call site's exact position -
 * resolving hits straight into store.insertResolvedCallEdge. Used only for
 * `brain build --precise`; the caller must catch failures and continue
 * without aborting the build.
 *
 * `filesWithCalls`: [{ fileId, relPath, ext, source, calls }] - `calls` are
 * parser.js's call records, which carry 0-indexed calleeLine/calleeColumn
 * for the exact position to query.
 */
async function resolvePreciseCallEdges(rootDir, store, filesWithCalls, onProgress) {
  const byLanguage = new Map();
  for (const entry of filesWithCalls) {
    const lang = languageForExt(entry.ext);
    if (!lang) continue;
    if (!byLanguage.has(lang)) byLanguage.set(lang, []);
    byLanguage.get(lang).push(entry);
  }

  for (const [lang, entries] of byLanguage) {
    const cfg = REGISTRY[lang];
    const client = new LspClient(cfg.command, cfg.args);

    // vscode-jsonrpc's stream writer can emit a write-after-destroy failure
    // on a detached tick (after a dead/dying server) that occurs outside any
    // promise chain a try/catch here could reach - it doesn't reject a
    // promise, it throws asynchronously as a bare uncaught exception. Since
    // this whole feature must never bring down `brain build`, catch that
    // narrowly, only for the window this one language server is in use.
    let internalCrash = null;
    const onUncaught = (err) => { internalCrash = err; };
    process.on('uncaughtException', onUncaught);

    try {
      try {
        await client.start(pathToFileURL(rootDir).toString());
      } catch (err) {
        onProgress(
          `${cfg.command} not found or unresponsive - falling back to name-based resolution for ${cfg.extensions.join(', ')}. ` +
            `Install with: npm i -g typescript-language-server typescript`
        );
        // A failed/timed-out start() can still have left a real child
        // process running - without this, its open stdio pipes keep the
        // whole `brain build` process alive indefinitely even though the
        // build itself already finished.
        await client.dispose().catch(() => {});
        continue;
      }

      try {
        for (const entry of entries) {
          const absPath = path.join(rootDir, entry.relPath);
          entry.uri = pathToFileURL(absPath).toString();
          client.didOpen(entry.uri, cfg.languageId, entry.source);
        }

        await sleep(ANALYSIS_SETTLE_MS);

        for (const entry of entries) {
          if (internalCrash) break;
          const uri = entry.uri;

          for (const call of entry.calls) {
            if (internalCrash) break;
            if (call.calleeLine === undefined || call.calleeColumn === undefined) continue;

            let locations;
            try {
              locations = await client.definition(uri, call.calleeLine, call.calleeColumn);
            } catch (_) {
              continue;
            }

            const list = Array.isArray(locations) ? locations : locations ? [locations] : [];
            for (const loc of list) {
              const targetPath = uriToRelPath(loc.uri, rootDir);
              if (!targetPath) continue;
              const targetFile = store.getFileByPath(targetPath);
              if (!targetFile) continue;

              const targetLine = loc.range.start.line + 1; // LSP is 0-indexed; this schema's start_line/end_line are 1-indexed
              // A method's line range is also inside its enclosing class's
              // range, so an unordered query here can just as easily return
              // the class as the actual method the definition points at -
              // ordering by the smallest containing range picks the most
              // specific (innermost) symbol, which is what a "go to
              // definition" answer actually means.
              const dst = store.db
                .prepare(
                  `SELECT id FROM symbols WHERE file_id = ? AND start_line <= ? AND end_line >= ?
                   ORDER BY (end_line - start_line) ASC LIMIT 1`
                )
                .get(targetFile.id, targetLine, targetLine);
              if (!dst) continue;

              const src = store.db.prepare('SELECT id FROM symbols WHERE file_id = ? AND name = ?').get(entry.fileId, call.callerName);
              if (src) store.insertResolvedCallEdge(src.id, dst.id, call.calleeName);
            }
          }
        }
      } finally {
        await client.dispose().catch(() => {});
      }

      if (internalCrash) {
        onProgress(`Precise resolution for ${lang} hit an internal error and was stopped early: ${internalCrash.message}`);
      }
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  }
}

module.exports = { resolvePreciseCallEdges };
