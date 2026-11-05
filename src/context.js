'use strict';

const path = require('path');
const { GraphStore } = require('./graphStore');
const { VectorIndex } = require('./vectorIndex');
const { getRepoBrainDir, getBrainsHome, PRESENTATION_EXTENSIONS, isGenericallyParsed } = require('./config');
const { loadUserConfig } = require('./userConfig');
const query = require('./query');

const DEFAULT_K = 8;
const DEFAULT_HOPS = 1;
const DEFAULT_BUDGET_CHARS = 24000;
const MAX_ITEMS = 60;

// --- Context-assembly re-ranking (see contextRelevanceWeight) -------------
//
// brain_search returns hits ranked purely by relevance, which is right for
// search. brain_context is different: it spends a fixed char budget reading
// real source, in priority order, and stops when the budget runs out. So
// what matters there isn't only "does this match" but "is this worth
// spending the budget on" - and a whole-file SCSS blob that matched on the
// component's name is not, even when it legitimately scores well.
//
// These multiply the search score to produce the ordering the budget loop
// consumes. They only ever reorder: nothing is filtered out, so a query
// genuinely about styles still gets its stylesheet, just not ahead of the
// logic.

// By symbol kind. 'file' is the generic whole-file chunk (see parser.js's
// parseGenericFile) - the single biggest budget risk, since one such item
// can be thousands of characters.
const KIND_WEIGHT = {
  method: 1,
  function: 1,
  class: 0.95,
  test: 0.6,
  suite: 0.55,
  hook: 0.5,
  file: 0.2
};

// By file extension, on top of kind. Presentation files are penalized
// hardest; other generically-parsed files (config, data, markup) sit
// between them and real parsed source.
const PRESENTATION_WEIGHT = 0.25;
const GENERIC_WEIGHT = 0.6;

/**
 * Combined priority multiplier for one search hit. Bounded well above zero
 * so this stays a re-ranking, not a filter - an item that is genuinely the
 * only match still surfaces.
 */
function contextRelevanceWeight(item) {
  const kindWeight = KIND_WEIGHT[item.kind] != null ? KIND_WEIGHT[item.kind] : 0.8;
  const ext = item.path ? path.extname(item.path).toLowerCase() : '';
  let extWeight = 1;
  if (PRESENTATION_EXTENSIONS.has(ext)) extWeight = PRESENTATION_WEIGHT;
  else if (ext && isGenericallyParsed(ext)) extWeight = GENERIC_WEIGHT;
  return kindWeight * extWeight;
}

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
  const userCfg = loadUserConfig(rootDir, getBrainsHome());
  const defaultBudgetChars = userCfg.defaultBudgetChars || DEFAULT_BUDGET_CHARS;
  const maxItems = userCfg.maxItems || MAX_ITEMS;

  const {
    k = DEFAULT_K,
    hops = DEFAULT_HOPS,
    budgetChars = defaultBudgetChars,
    kind,
    ext
  } = opts;

  const brainDir = getRepoBrainDir(rootDir);
  const store = deps.store || new GraphStore(brainDir);
  const vectorIndex = deps.vectorIndex || new VectorIndex(brainDir);
  const shouldClose = !deps.store;

  try {
    const searchHits = await query.search(rootDir, taskText, k, { kind, ext }, { store, vectorIndex });

    // Re-rank before anything downstream reads the order: primaryHits[0]
    // decides which neighborhood gets the hop1 tier below, and the budget
    // loop spends its allowance strictly in this order. Sorting here is the
    // whole of fix "presentation files eat the budget" - see
    // contextRelevanceWeight.
    const primaryHits = searchHits
      .map((h) => ({ ...h, contextWeight: contextRelevanceWeight(h) }))
      .map((h) => ({ ...h, contextScore: h.score * h.contextWeight }))
      .sort((a, b) => b.contextScore - a.contextScore);

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
    ].slice(0, maxItems);

    const notes = [];
    const totalCandidates =
      primaryHits.length + hop1.length + hop2plus.length;
    if (totalCandidates > priorityOrder.length) {
      notes.push(`${totalCandidates - priorityOrder.length} lower-priority neighbors omitted (item cap reached)`);
    }

    // usedChars tracks a running estimate (per-item JSON size) so the code-
    // inclusion decisions below can be made cheaply without re-serializing
    // the whole response on every item; the authoritative number reported to
    // the caller is computed once at the end from the actual assembled
    // response (see approxResponseChars below), not this running estimate.
    let usedChars = 0;
    let truncated = false;
    const primary = [];
    const neighbors = [];
    const filesTouched = new Set();

    let neighborsDropped = 0;

    for (const item of priorityOrder) {
      // A neighbor is metadata-only once the budget is spent, and past that
      // it isn't worth its own ~200 chars either. Primary hits are the
      // answer, so they are never dropped - only their code is.
      if (item.tier !== 'primary' && usedChars >= budgetChars) {
        neighborsDropped++;
        truncated = true;
        continue;
      }

      if (item.path) filesTouched.add(item.path);

      const wantsCode = item.tier !== 'hop2plus';
      let code = null;
      if (wantsCode && item.path && usedChars < budgetChars) {
        const text = query.read(rootDir, item.path, item.startLine, item.endLine);
        // JSON.stringify(text).length, not text.length, so escaping/quoting
        // overhead counts toward the budget the same way it will once this
        // is actually serialized.
        const cost = JSON.stringify(text).length;
        if (usedChars + cost <= budgetChars) {
          code = text;
          usedChars += cost;
        } else {
          truncated = true;
        }
      } else if (wantsCode) {
        truncated = true;
      }

      // Once we're over budget on code, neighbor-tier metadata is trimmed
      // next (dropping the ~160-char signature) rather than dropping the
      // item outright - cheaper than code, but not free at MAX_ITEMS scale.
      const dropSignature = truncated && item.tier !== 'primary';
      const base = {
        symbolId: item.symbolId,
        name: item.name,
        kind: item.kind,
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        signature: dropSignature ? null : item.signature,
        code
      };

      const entry =
        item.tier === 'primary'
          ? { ...base, score: item.score }
          : { ...base, relation: item.relation, via: item.via };

      // Metadata is charged to the budget too. Previously only `code`
      // counted, so a bundle with 60 neighbors could return well past its
      // stated limit in pure metadata - the budget described one part of
      // the response while the agent paid for all of it. `code` is excluded
      // here because it was already charged when it was read above;
      // counting it again would halve the effective budget.
      usedChars += JSON.stringify({ ...entry, code: null }).length;

      if (item.tier === 'primary') primary.push(entry);
      else neighbors.push(entry);
    }

    if (neighborsDropped) {
      notes.push(`${neighborsDropped} lower-priority neighbors dropped (char budget exhausted)`);
    }

    const response = {
      task: taskText,
      budget: { limitChars: budgetChars, usedChars: 0, truncated },
      primary,
      neighbors,
      filesTouched: [...filesTouched],
      notes
    };

    // Ground-truth size: the actual pretty-printed JSON this bundle turns
    // into (matching mcpServer.js's textResult()/the CLI's JSON.stringify),
    // not just the sum of included code text - metadata, hop2plus
    // neighbors, and pretty-print overhead all count now.
    response.budget.usedChars = JSON.stringify(response, null, 2).length;

    return response;
  } finally {
    if (shouldClose) store.close();
  }
}

module.exports = { buildContext };
