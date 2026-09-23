'use strict';

const fs = require('fs');
const path = require('path');
const { GraphStore } = require('./graphStore');
const { VectorIndex } = require('./vectorIndex');
const { embedText } = require('./embedder');
const { getRepoBrainDir, getBrainsHome, FULLY_PARSED_EXTENSIONS } = require('./config');
const { loadUserConfig } = require('./userConfig');

const FULLY_PARSED_EXTENSION_SET = new Set(FULLY_PARSED_EXTENSIONS);
// Applied to a generic-parsed-file symbol's (see parser.js's
// parseGenericFile - no real logic granularity, whole file as one symbol)
// TOTAL fused score, unless it earned a genuine lexical hit against its
// actual body content. Two of the three signals can otherwise let a
// filename coincidence alone win: the name-match signal (see
// graphStore.js's searchByNameMatch, which discounts itself at the source)
// and, more subtly, the semantic signal - a generic-file symbol's `name` IS
// its filename (see buildBrain.js's embed text), so its embedding already
// has the filename baked in, unlike a real code symbol whose name is an
// identifier, not the file it lives in. Without this, a "theme.scss" can
// tie or outrank a real "ThemeService" class for a "theme" query even after
// the name-match signal alone is fixed.
const GENERIC_FILE_SCORE_DISCOUNT = 0.5;

// Reciprocal-rank-fusion constant: standard choice (see Cormack et al.'s RRF
// paper), not tuned for this corpus - low sensitivity to the exact value is
// the whole appeal of RRF over score-normalizing the two very
// differently-scaled inputs (cosine similarity vs. bm25) by hand.
// Overridable per-repo/machine-wide via brain.config.json's `rrfK` - see
// userConfig.js.
const DEFAULT_RRF_K = 60;

/**
 * `deps` lets callers that already have an open store/index (context.js's
 * multi-step assembly, the long-lived MCP server) reuse them instead of
 * paying an open+close per call. Omit it (the CLI's usage) and behavior is
 * exactly what it was before: open fresh, close when done.
 *
 * Fuses two independent rankings - vectorIndex's semantic (embedding cosine)
 * search and the store's FTS5 lexical search over full symbol bodies (see
 * graphStore.js's chunks_fts) - via reciprocal rank fusion, so an exact
 * identifier/string-literal match inside a function body surfaces even when
 * it's not semantically close to the query text, and a semantically-close
 * result still surfaces even with zero lexical overlap.
 */
async function search(rootDir, queryText, k = 10, filters = {}, deps = {}) {
  const brainDir = getRepoBrainDir(rootDir);
  const store = deps.store || new GraphStore(brainDir);
  const vectorIndex = deps.vectorIndex || new VectorIndex(brainDir);
  const shouldClose = !deps.store;
  try {
    const { kind, ext } = filters;
    // Always overfetch, not just when a kind/ext filter needs the extra
    // headroom: semantic embeddings here are computed from a symbol's
    // truncated signature (see embedText's caller in buildBrain.js), so a
    // symbol whose *body* is the actual lexical match can rank well outside
    // the top-k semantically. A narrow fetchK would silently exclude it
    // from one side of the fusion before RRF ever gets a chance to combine
    // the two signals - see the fixture-repo repro that caught this.
    const fetchK = Math.max(k * 4, 40);
    const rrfK = loadUserConfig(rootDir, getBrainsHome()).rrfK || DEFAULT_RRF_K;

    const queryVec = await embedText(queryText);
    const semanticHits = vectorIndex.search(queryVec, fetchK);
    const lexicalHits = store.searchLexical(queryText, fetchK);
    // Third signal: does the query match the symbol's own name or its
    // file's path/basename? Neither of the other two signals looks at names
    // specifically - see graphStore.js's searchByNameMatch() doc comment.
    // This is what makes a file named near-exactly for the query (e.g.
    // `generic-filter.component.ts` for "filter flow") a reliable hit even
    // when its body content isn't semantically/lexically close to the
    // query wording.
    const nameHits = store.searchByNameMatch(queryText, fetchK);

    const fused = new Map(); // symbolId -> { score, matches, hasLexicalHit }
    const addHit = (id, rank, isLexical) => {
      const cur = fused.get(id) || { score: 0, matches: 0, hasLexicalHit: false };
      cur.score += 1 / (rrfK + rank + 1);
      cur.matches += 1;
      if (isLexical) cur.hasLexicalHit = true;
      fused.set(id, cur);
    };
    semanticHits.forEach((h, i) => addHit(h.symbolId, i, false));
    lexicalHits.forEach((h, i) => addHit(h.symbolId, i, true));
    nameHits.forEach((h, i) => addHit(h.symbolId, i, false));

    // Fourth signal, applied directly to the fused score rather than as a
    // ranked list: does the query literally name a real symbol? E.g. a query
    // like "trace AuthService login" already tells you the exact thing to
    // find - that's a far stronger, unambiguous signal than anything
    // semantic/lexical scoring produces, and it's exactly the gap a prior
    // benchmark of this tool found: a plain grep for a known symbol name beat
    // semantic search, which ranked an unrelated-but-similar-sounding hit
    // (a "remote login" settings page for a query about the login flow)
    // above the real target. EXACT_MATCH_BONUS dwarfs the largest possible
    // RRF score (at most ~3/(rrfK+1), one rank-0 hit from each of the three
    // signals above) so a genuine exact-name match always sorts first,
    // rather than merely nudging it up a few places. Only identifier-shaped
    // words of 4+ chars are checked, so short common words in the query text
    // (e.g. "the", "flow") can't spuriously "exact match" a same-named
    // symbol - a real identifier that short would be unusual and low-value
    // to boost this hard anyway.
    const EXACT_MATCH_BONUS = 10;
    const identifierWords = [...new Set((queryText.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).filter((w) => w.length >= 4))];
    for (const word of identifierWords) {
      for (const id of store.getSymbolsByExactName(word)) {
        const cur = fused.get(id) || { score: 0, matches: 0, hasLexicalHit: false };
        cur.score += EXACT_MATCH_BONUS;
        cur.matches += 1;
        cur.hasLexicalHit = true; // an exact name match is real, not a filename coincidence - exempt from the generic-file discount below
        fused.set(id, cur);
      }
    }

    // See GENERIC_FILE_SCORE_DISCOUNT above: a generic-parsed-file symbol
    // without a real lexical hit against its actual content only got here
    // via filename-driven signals, so its total score is discounted before
    // the final sort - done here (post-fusion), not per-signal, so it
    // reads directly off `hasLexicalHit` instead of duplicating that
    // reasoning at each addHit() call site.
    for (const [symbolId, entry] of fused) {
      if (entry.hasLexicalHit) continue;
      const sym = store.getSymbolById(symbolId);
      const file = sym ? store.getFileById(sym.file_id) : null;
      const ext = file ? path.extname(file.path).toLowerCase() : null;
      if (ext && !FULLY_PARSED_EXTENSION_SET.has(ext)) entry.score *= GENERIC_FILE_SCORE_DISCOUNT;
    }

    const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, fetchK);

    // score is now an RRF-fused rank score, not a raw cosine similarity -
    // see the RRF_K comment above and README §10 for what it means and why.
    // `confidence` buckets it into something more actionable than the raw
    // number: 'high' when at least two of the three search signals (semantic,
    // lexical, name) agreed on this result, 'medium'/'low' otherwise based on
    // how high it ranked in whichever single list found it.
    let results = ranked.map(([symbolId, { score, matches }]) => {
      const sym = store.getSymbolById(symbolId);
      if (!sym) return null;
      const file = store.getFileById(sym.file_id);
      const confidence = matches > 1 ? 'high' : score >= 1 / (rrfK + 5) ? 'medium' : 'low';
      return {
        symbolId: sym.id,
        name: sym.name,
        kind: sym.kind,
        path: file ? file.path : null,
        startLine: sym.start_line,
        endLine: sym.end_line,
        signature: sym.signature,
        score,
        confidence
      };
    }).filter(Boolean);

    if (kind) results = results.filter((r) => r.kind === kind);
    if (ext) results = results.filter((r) => r.path && r.path.endsWith(ext));

    return results.slice(0, k);
  } finally {
    if (shouldClose) store.close();
  }
}

function expand(rootDir, symbolId, hops = 1, deps = {}) {
  const brainDir = getRepoBrainDir(rootDir);
  const store = deps.store || new GraphStore(brainDir);
  const shouldClose = !deps.store;
  try {
    const id = Number(symbolId);
    // Previously a missing symbol silently fell through to an empty []
    // (indistinguishable from "no callers/callees"). Mirror check()'s
    // null-for-not-found so callers can tell the two cases apart.
    if (!store.getSymbolById(id)) return null;
    const { items, meta } = store.expand(id, Number(hops));
    const related = items.map((r) => ({
      relation: r.relation,
      symbolId: r.symbol ? r.symbol.id : null,
      name: r.symbol ? r.symbol.name : null,
      kind: r.symbol ? r.symbol.kind : null,
      path: r.file ? r.file.path : null,
      startLine: r.symbol ? r.symbol.start_line : null,
      endLine: r.symbol ? r.symbol.end_line : null,
      sharedKey: r.sharedKey
    }));
    // See graphStore.js's _resolveSeeds(): a class/interface's own symbol
    // almost never has direct call edges (its methods do), so `related` here
    // is already unioned across its members. classAggregation.unresolved
    // means there were zero discoverable members (e.g. a TS interface, whose
    // members parser.js doesn't capture as symbols at all) - an empty
    // `related` in that case means "couldn't look", not "looked, found
    // nothing", and callers should not read it as a confident answer.
    return meta.classAggregation ? { related, classAggregation: meta.classAggregation } : { related };
  } finally {
    if (shouldClose) store.close();
  }
}

/** The only place actual file I/O happens for the agent: one targeted read. */
function read(rootDir, relPath, startLine, endLine) {
  const root = path.resolve(rootDir);
  const absPath = path.resolve(root, relPath);
  // relPath comes straight from the MCP client (mcpServer.js's brain_read) -
  // without this check, "../../../etc/passwd" (or a Windows equivalent) would
  // resolve outside the repo and this would happily return it.
  if (absPath !== root && !absPath.startsWith(root + path.sep)) {
    throw new Error(`relPath resolves outside the repo root: ${relPath}`);
  }
  const s = Math.max(1, Number(startLine));
  const e = Number(endLine);
  if (!Number.isFinite(e) || e < s) {
    throw new Error(`endLine (${endLine}) must be >= startLine (${startLine})`);
  }
  const lines = fs.readFileSync(absPath, 'utf8').split('\n');
  return lines.slice(s - 1, Math.min(lines.length, e)).join('\n');
}

/**
 * Pre-edit safety report for a symbol: who transitively calls it (blast
 * radius) and which tests, if any, exercise it - so an agent can gauge risk
 * before changing it instead of finding out after the fact.
 */
function check(rootDir, symbolId, opts = {}, deps = {}) {
  const { hops = 3, testHops = 6 } = opts;
  const brainDir = getRepoBrainDir(rootDir);
  const store = deps.store || new GraphStore(brainDir);
  const shouldClose = !deps.store;
  try {
    const id = Number(symbolId);
    const symbol = store.getSymbolById(id);
    if (!symbol) return null;
    const file = store.getFileById(symbol.file_id);

    const { callers: blastRadius, meta: callerMeta } = store.getCallers(id, Number(hops));
    const { tests: testsCovering, meta: testMeta } = store.getTestsForSymbol(id, Number(testHops));
    const classAggregation = callerMeta.classAggregation || testMeta.classAggregation || null;
    // A class/interface with zero discoverable members (see graphStore.js's
    // _resolveSeeds) means the walk never actually ran - an empty
    // blastRadius/testsCovering there is NOT the same finding as "we looked
    // and this really has no callers/tests". Surface that as its own `risk`
    // value instead of the misleadingly confident 'untested', which is
    // exactly the false-safe reading a prior benchmark of this tool flagged
    // as its biggest risk: an agent could take an empty, unresolved result
    // as "safe to change" instead of "unknown".
    const unresolved = !!(classAggregation && classAggregation.unresolved);

    return {
      symbol: {
        symbolId: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        path: file ? file.path : null,
        startLine: symbol.start_line,
        endLine: symbol.end_line
      },
      blastRadius,
      testsCovering,
      risk: unresolved ? 'unresolved' : testsCovering.length > 0 ? 'covered' : 'untested',
      ...(classAggregation ? { classAggregation } : {})
    };
  } finally {
    if (shouldClose) store.close();
  }
}

module.exports = { search, expand, read, check };
