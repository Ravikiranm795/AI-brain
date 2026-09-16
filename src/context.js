'use strict';

const { GraphStore } = require('./graphStore');
const { VectorIndex } = require('./vectorIndex');
const { embedText } = require('./embedder');
const { getRepoBrainDir, getBrainsHome } = require('./config');
const { loadUserConfig } = require('./userConfig');
const query = require('./query');

const DEFAULT_K = 8;
const DEFAULT_HOPS = 1;
const DEFAULT_BUDGET_CHARS = 24000;
const MAX_ITEMS = 60;
// Below this cosine similarity to the task text, a graph-adjacent neighbor
// (a caller/callee with no other relevance signal) is dropped rather than
// riding along on hop-distance alone - this is what keeps an unrelated
// *.spec.ts/*.scss neighbor out of a context bundle. Deliberately soft: it
// only applies to buildContext's neighbor selection, never to
// query.js/graphStore.js's getCallers() (brain_check's blast radius, where
// completeness - not topical relevance - is the whole point). Tune via
// brain.config.json's `minNeighborSimilarity` if this default cuts too
// much/too little for a given repo's embedding distribution. Lowered from
// an initial 0.15 after real-repo testing showed that value zeroing out
// ALL neighbors on some tasks - see MIN_GUARANTEED_NEIGHBORS below for the
// backstop that makes the exact value here less load-bearing.
const DEFAULT_MIN_NEIGHBOR_SIMILARITY = 0.1;
// Regardless of the floor above, the top N hop1 neighbors by similarity are
// always kept - a caller/callee genuinely worth surfacing can still score
// low on raw embedding similarity (short signatures carry little semantic
// signal - see context.js's module doc comment on where real code text
// comes from), and a floor with no backstop can silently degrade
// brain_context into "just the primary hits, no graph context at all" on a
// task whose neighborhood happens to embed poorly. This guarantee is what
// actually keeps that from happening; the floor value above only decides
// what gets trimmed *beyond* this guaranteed set.
const MIN_GUARANTEED_NEIGHBORS = 5;

function cosineSim(a, b) {
  // Both vectors are pre-normalized at embed time (see embedder.js), so a
  // plain dot product already is the cosine similarity - same shortcut
  // vectorIndex.js's search() takes.
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

const TRUNCATION_MARKER = '\n… (truncated to fit budget)';
// Below this, truncating isn't worth doing - there's no room left for a
// meaningful line of code plus the marker itself, so it's simpler and more
// honest to just omit the code entirely (see MIN_TRUNCATE_CHARS's caller).
const MIN_TRUNCATE_CHARS = 40;

/**
 * Shrinks `text` to the largest line-prefix (plus TRUNCATION_MARKER) whose
 * JSON-serialized cost fits within `maxJsonCost`, or returns null if even
 * that doesn't fit. Used so a primary/hop1 hit whose full code doesn't fit
 * the remaining budget still gets SOMETHING back instead of nothing - a
 * budget tight enough to only fit one hit's code previously meant every
 * hit after it got dropped to `code: null` outright, with no way for a
 * caller to ask for "give me what fits" instead.
 */
function truncateCodeToFit(text, maxJsonCost) {
  if (maxJsonCost < MIN_TRUNCATE_CHARS) return null;
  if (JSON.stringify(text).length <= maxJsonCost) return text;

  const lines = text.split('\n');
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = lines.slice(0, mid).join('\n') + TRUNCATION_MARKER;
    if (JSON.stringify(candidate).length <= maxJsonCost) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return null; // can't fit even one line plus the marker
  return lines.slice(0, lo).join('\n') + TRUNCATION_MARKER;
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
 *
 * `budgetChars` bounds the ENTIRE serialized response (see the
 * droppedForSize trimming below), not just included code text - a caller
 * asking for 8000 chars back gets at most ~8000 chars back, not 8000 chars
 * of code plus however much metadata riding along for free.
 *
 * Neighbors (hop1/hop2plus) are also filtered by relevance-to-task
 * similarity, not just hop distance - see DEFAULT_MIN_NEIGHBOR_SIMILARITY -
 * so a graph-adjacent but topically-unrelated file (a `*.spec.ts` or
 * `*.scss` with no real bearing on the task) doesn't crowd out more
 * relevant neighbors.
 */
async function buildContext(rootDir, taskText, opts = {}, deps = {}) {
  const userCfg = loadUserConfig(rootDir, getBrainsHome());
  const defaultBudgetChars = userCfg.defaultBudgetChars || DEFAULT_BUDGET_CHARS;
  const maxItems = userCfg.maxItems || MAX_ITEMS;
  const minNeighborSimilarity =
    userCfg.minNeighborSimilarity != null ? userCfg.minNeighborSimilarity : DEFAULT_MIN_NEIGHBOR_SIMILARITY;
  const minGuaranteedNeighbors =
    userCfg.minGuaranteedNeighbors != null ? userCfg.minGuaranteedNeighbors : MIN_GUARANTEED_NEIGHBORS;

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

    // Score each neighbor's relevance to the task text (not just its hop
    // distance), and drop ones below the floor - this is what keeps an
    // unrelated *.spec.ts/*.scss file from riding along just because it's
    // graph-adjacent to a primary hit. 'shares-storage-key' neighbors are
    // exempt: that relation is itself an explicit, strong relevance signal
    // (see graphStore.js's getStorageKeyPeers), not something embedding
    // similarity should second-guess. The top `minGuaranteedNeighbors` by
    // similarity are ALSO exempt, regardless of the floor - a caller/callee
    // worth surfacing can still score low on raw embedding similarity
    // (short signatures carry little signal), and without this backstop a
    // task whose whole neighborhood embeds poorly loses its graph context
    // entirely rather than just the least-relevant part of it.
    let droppedForRelevance = 0;
    if (hop1.length && minNeighborSimilarity > -1) {
      const taskVec = await embedText(taskText);
      for (const entry of hop1) {
        if (entry.relation === 'shares-storage-key') {
          entry.similarity = null;
          continue;
        }
        const vec = vectorIndex.getVector(entry.symbolId);
        entry.similarity = vec ? cosineSim(taskVec, vec) : null;
      }
      // Unscored (exempt/no-vector) entries sort as a neutral mid-value so
      // they neither dominate nor get buried relative to scored ones.
      const sorted = [...hop1].sort((a, b) => (b.similarity ?? 0.5) - (a.similarity ?? 0.5));
      const kept = [];
      sorted.forEach((entry, i) => {
        const exempt = entry.similarity === null || i < minGuaranteedNeighbors;
        if (exempt || entry.similarity >= minNeighborSimilarity) {
          kept.push(entry);
        } else {
          droppedForRelevance++;
        }
      });
      hop1.length = 0;
      hop1.push(...kept);
    }

    // Neighbors of everything but the single top hit are treated as the
    // lower-priority "hop2plus" tier, so budget favors the most relevant
    // primary hit's immediate neighborhood first. Within each tier,
    // relevance-sorted (see above) rather than left in graph-traversal order.
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
    // hop1 (post relevance-filter, above) already contains the union of
    // prioritizedHop1 + hop2plus - adding hop2plus.length again here would
    // double-count every hop2plus entry.
    const totalCandidates = primaryHits.length + hop1.length;
    if (totalCandidates > priorityOrder.length) {
      notes.push(`${totalCandidates - priorityOrder.length} lower-priority neighbors omitted (item cap reached)`);
    }
    if (droppedForRelevance > 0) {
      notes.push(`${droppedForRelevance} neighbor(s) omitted (below the ${minNeighborSimilarity} relevance-to-task similarity floor)`);
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

    for (const item of priorityOrder) {
      if (item.path) filesTouched.add(item.path);

      const wantsCode = item.tier !== 'hop2plus';
      let code = null;
      if (wantsCode && item.path) {
        const remaining = budgetChars - usedChars;
        if (remaining < MIN_TRUNCATE_CHARS) {
          // No point reading the file just to immediately discard it -
          // there isn't enough budget left for even a truncated snippet.
          truncated = true;
        } else {
          const text = query.read(rootDir, item.path, item.startLine, item.endLine);
          // JSON.stringify(text).length, not text.length, so escaping/
          // quoting overhead counts toward the budget the same way it will
          // once this is actually serialized.
          const fullCost = JSON.stringify(text).length;
          if (fullCost <= remaining) {
            code = text;
            usedChars += fullCost;
          } else {
            // Doesn't fit whole - shrink it to what does, rather than
            // dropping it to null outright. Every primary hit (and hop1
            // neighbor, budget permitting) gets at least a truncated look
            // at its code instead of some getting the full thing and
            // everyone after getting nothing.
            const shrunk = truncateCodeToFit(text, remaining);
            if (shrunk) {
              code = shrunk;
              usedChars += JSON.stringify(shrunk).length;
            }
            truncated = true;
          }
        }
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

      if (item.tier === 'primary') {
        primary.push({ ...base, score: item.score });
      } else {
        // similarity is undefined (dropped by JSON.stringify) for primary
        // hits and for sharedKey-exempt neighbors - present only where it
        // actually drove ordering/filtering, so its absence is meaningful.
        neighbors.push({ ...base, relation: item.relation, via: item.via, similarity: item.similarity ?? undefined });
      }
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

    // budgetChars is a budget for the whole response, not just code - the
    // per-item loop above already keeps *code* text within it, but with
    // enough neighbors, metadata/signature overhead alone can still push
    // the total past what was asked for (a caller that requested 8000 chars
    // has no way to actually get ~8000 back without this - the response
    // above could otherwise land 3x over with nothing but a `truncated`
    // flag to show for it). Drop lowest-priority neighbors first (hop2plus
    // tail, then hop1) until it fits or there's nothing left to drop -
    // primary hits are never dropped, since they're the direct answer to
    // the search.
    let droppedForSize = 0;
    while (response.budget.usedChars > budgetChars && response.neighbors.length > 0) {
      response.neighbors.pop();
      response.budget.usedChars = JSON.stringify(response, null, 2).length;
      droppedForSize++;
    }
    if (droppedForSize > 0) {
      response.budget.truncated = true;
      notes.push(`${droppedForSize} lowest-priority neighbor(s) dropped to fit budgetChars as a total-response cap`);
      response.budget.usedChars = JSON.stringify(response, null, 2).length;
    }

    // Last resort: dropping neighbors has a floor of zero, and once it's
    // hit there's no lever left if the response is STILL over budget - e.g.
    // a single primary hit whose per-item metadata (symbolId/name/kind/
    // path/signature/score) plus the response wrapper itself already
    // approaches budgetChars, which the per-item truncation loop above
    // can't see (it only sizes the `code` field, not what surrounds it).
    // Shrink primary code further - largest first - rather than leave the
    // caller with an unenforced `truncated: true` and nothing to show for
    // it. Primary items are never dropped entirely, only shrunk.
    //
    // The note about this is pushed BEFORE the loop runs (a guess it'll be
    // needed) rather than after, and popped back out if it turns out not to
    // be - the note's own bytes have to be part of what the loop converges
    // against, or its own overhead can undo the very convergence it's
    // reporting on (this is exactly what happened before this comment was
    // written: usedChars would land back over budget by roughly the note
    // string's own length).
    const shrinkNote = 'primary hit code further shrunk to fit budgetChars - even minimal metadata for the requested items approached the budget';
    notes.push(shrinkNote);
    response.budget.usedChars = JSON.stringify(response, null, 2).length;
    let shrinkPasses = 0;
    while (response.budget.usedChars > budgetChars && shrinkPasses < 25) {
      const withCode = response.primary.filter((p) => p.code);
      if (!withCode.length) break;
      withCode.sort((a, b) => JSON.stringify(b.code).length - JSON.stringify(a.code).length);
      const target = withCode[0];
      const currentCost = JSON.stringify(target.code).length;
      target.code = truncateCodeToFit(target.code, Math.floor(currentCost / 2));
      response.budget.truncated = true;
      response.budget.usedChars = JSON.stringify(response, null, 2).length;
      shrinkPasses++;
    }
    if (shrinkPasses === 0) {
      notes.pop(); // wasn't needed after all
      response.budget.usedChars = JSON.stringify(response, null, 2).length;
    }

    return response;
  } finally {
    if (shouldClose) store.close();
  }
}

module.exports = { buildContext };
