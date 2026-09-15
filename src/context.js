'use strict';

const { GraphStore } = require('./graphStore');
const { VectorIndex } = require('./vectorIndex');
const { getRepoBrainDir } = require('./config');
const query = require('./query');

const DEFAULT_K = 8;
const DEFAULT_HOPS = 1;
const DEFAULT_BUDGET_CHARS = 24000;
const MAX_ITEMS = 60;

/**
 * One-shot context assembly for an agent: search -> expand -> read,
 * budget-bounded, so a task's starting context is a single call instead of
 * the agent chaining three primitives (query.search/expand/read) itself and
 * reasoning about which symbol ids to expand or read.
 *
 * Real source code comes from query.read() over the symbol's line range -
 * never from chunks.code/signature, which are truncated to ~160 chars (see
 * parser.js's nodeSig()/parseGenericFile) and are not full code bodies.
 */
async function buildContext(rootDir, taskText, opts = {}, deps = {}) {
  const {
    k = DEFAULT_K,
    hops = DEFAULT_HOPS,
    budgetChars = DEFAULT_BUDGET_CHARS,
    kind,
    ext
  } = opts;

  const brainDir = getRepoBrainDir(rootDir);
  const store = deps.store || new GraphStore(brainDir);
  const vectorIndex = deps.vectorIndex || new VectorIndex(brainDir);
  const shouldClose = !deps.store;

  try {
    const primaryHits = await query.search(rootDir, taskText, k, { kind, ext }, { store, vectorIndex });

    const seen = new Set(primaryHits.map((h) => h.symbolId));
    const hop1 = [];
    const hop2plus = [];

    for (const hit of primaryHits) {
      const related = store.expand(hit.symbolId, hops);
      for (const r of related) {
        if (!r.symbol || seen.has(r.symbolId)) continue;
        seen.add(r.symbolId);
        const entry = {
          symbolId: r.symbolId,
          relation: r.relation,
          via: hit.symbolId,
          name: r.symbol.name,
          kind: r.symbol.kind,
          path: r.file ? r.file.path : null,
          startLine: r.symbol.start_line,
          endLine: r.symbol.end_line,
          signature: r.symbol.signature
        };
        // store.expand's own hop count already caps how far it walks; a
        // hop-1 request only ever produces hop-1 neighbors, so anything
        // beyond the immediate neighbors of the top hits is intentionally
        // deprioritized below rather than re-computed here.
        hop1.push(entry);
      }
    }

    // Neighbors of everything but the single top hit are treated as the
    // lower-priority "hop2plus" tier, so budget favors the most relevant
    // primary hit's immediate neighborhood first.
    const topHitId = primaryHits.length ? primaryHits[0].symbolId : null;
    const prioritizedHop1 = [];
    for (const entry of hop1) {
      if (entry.via === topHitId) prioritizedHop1.push(entry);
      else hop2plus.push(entry);
    }

    const priorityOrder = [
      ...primaryHits.map((h) => ({ ...h, tier: 'primary' })),
      ...prioritizedHop1.map((n) => ({ ...n, tier: 'hop1' })),
      ...hop2plus.map((n) => ({ ...n, tier: 'hop2plus' }))
    ].slice(0, MAX_ITEMS);

    const notes = [];
    const totalCandidates =
      primaryHits.length + hop1.length + hop2plus.length;
    if (totalCandidates > priorityOrder.length) {
      notes.push(`${totalCandidates - priorityOrder.length} lower-priority neighbors omitted (item cap reached)`);
    }

    let usedChars = 0;
    let truncated = false;
    const primary = [];
    const neighbors = [];
    const filesTouched = new Set();

    for (const item of priorityOrder) {
      if (item.path) filesTouched.add(item.path);

      const wantsCode = item.tier !== 'hop2plus';
      let code = null;
      if (wantsCode && item.path && usedChars < budgetChars) {
        const text = query.read(rootDir, item.path, item.startLine, item.endLine);
        if (usedChars + text.length <= budgetChars) {
          code = text;
          usedChars += text.length;
        } else {
          truncated = true;
        }
      } else if (wantsCode) {
        truncated = true;
      }

      const base = {
        symbolId: item.symbolId,
        name: item.name,
        kind: item.kind,
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        signature: item.signature,
        code
      };

      if (item.tier === 'primary') {
        primary.push({ ...base, score: item.score });
      } else {
        neighbors.push({ ...base, relation: item.relation, via: item.via });
      }
    }

    return {
      task: taskText,
      budget: { limitChars: budgetChars, usedChars, truncated },
      primary,
      neighbors,
      filesTouched: [...filesTouched],
      notes
    };
  } finally {
    if (shouldClose) store.close();
  }
}

module.exports = { buildContext };
