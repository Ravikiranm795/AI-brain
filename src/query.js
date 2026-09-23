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

// Hard cap on how many blast-radius entries brain_check serializes. Without
// one, a check on a heavily-used symbol has produced a ~800KB response -
// unusable by any MCP client, and absurd for a tool whose premise is
// spending fewer tokens than reading the files would. The full totals are
// always reported alongside, so a capped answer is never mistakable for a
// complete one. Override per-call with `maxCallers`.
const DEFAULT_MAX_CALLERS = 40;

// Above this many symbols sharing one exact name, the exact-identifier boost
// is treated as ambiguous and skipped entirely - see its use in search().
const MAX_EXACT_MATCH_SYMBOLS = 5;

/**
 * Words in a query that are plausibly CODE identifiers rather than English.
 * This distinction is the whole safety margin on the exact-identifier boost:
 * the boost forces a symbol to the top of the results, so firing it on a
 * plain word is actively harmful. A benchmark of the previous version found
 * exactly that - "parse publication year from pub-date element" force-ranked
 * four unrelated `parse` methods, and every query containing the word
 * "Service" force-ranked classes literally named `Service`, pushing the real
 * answers off the list.
 *
 * A word qualifies only with structural evidence that it was written as
 * code, never on length alone:
 *   - an internal capital, i.e. camelCase/PascalCase compounds
 *     (`parseBookMeta`, `ProductService`) but NOT `Product`, `parse`, or a
 *     capitalized sentence opener
 *   - an underscore (`snake_case`, `CONST_NAME`)
 *   - dotted or ::-qualified (`Foo.bar`, `Foo::bar`) - only the final
 *     segment is returned, which is what symbol names are stored as
 *   - wrapped in backticks by the caller, an explicit "this is code" signal
 *     that overrides all of the above
 */
function extractIdentifierWords(queryText) {
  const words = new Set();

  // Backticked spans are taken at face value, including bare words.
  for (const m of queryText.matchAll(/`([^`]+)`/g)) {
    const inner = m[1].trim();
    const seg = inner.split(/[.:#]+/).pop();
    if (/^[A-Za-z_$][\w$]*$/.test(seg)) words.add(seg);
  }

  for (const m of queryText.matchAll(/[A-Za-z_$][\w$]*(?:[.:]{1,2}[A-Za-z_$][\w$]*)*/g)) {
    const token = m[0];
    const isDotted = /[.:]/.test(token);
    const segments = token.split(/[.:]+/).filter(Boolean);
    segments.forEach((seg, i) => {
      if (seg.length < 3) return;
      const isFinalSegment = i === segments.length - 1;
      const hasInternalCapital = /[a-z0-9][A-Z]/.test(seg);
      const hasUnderscore = seg.includes('_');
      // Every segment of a dotted token is worth matching (`ProductService.getProducts`
      // names two real symbols, not one), but a bare undotted word still has
      // to earn it structurally.
      if (hasInternalCapital || hasUnderscore || (isDotted && isFinalSegment)) words.add(seg);
    });
  }

  return [...words];
}

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
    for (const word of extractIdentifierWords(queryText)) {
      const ids = store.getSymbolsByExactName(word);
      // An "exact" match that hits dozens of symbols isn't identifying
      // anything - it's a common name (an overload set, an interface and its
      // implementations, a method defined on every DTO). Forcing all of them
      // to the top would bury the ranked results under a wall of ties, so
      // past this threshold the boost stands down and the normal three-signal
      // fusion decides.
      if (!ids.length || ids.length > MAX_EXACT_MATCH_SYMBOLS) continue;
      for (const id of ids) {
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

// Bounds the raw-text scan below. The degraded set should be tiny (a
// handful of oversized or unparseable files); if a repo somehow has
// hundreds, scanning them all on every check() is not worth the latency -
// the first N are enough to establish "this answer is incomplete", which is
// the actual finding.
const MAX_GAP_FILES_SCANNED = 50;

/**
 * Files that are part of the repo but NOT fully in the symbol index (parse
 * failure, size-skipped - see graphStore's files.index_status) and whose raw
 * text mentions `symbolName`. Each one is a place a caller could be hiding
 * where no graph walk can reach it.
 *
 * The literal text scan is the point: these files have no symbols to query,
 * so the only way to know whether they're relevant is to look at the bytes.
 * Cheap in practice because the degraded set is small, and infinitely better
 * than reporting a confident empty blast radius that simply couldn't see
 * half the repo.
 */
function findIndexGapsMentioning(rootDir, store, symbolName) {
  if (!symbolName || symbolName.length < 3) return [];
  let degraded;
  try {
    degraded = store.getDegradedFiles();
  } catch (_) {
    return []; // pre-migration brain without the index_status column
  }
  if (!degraded.length) return [];

  const gaps = [];
  for (const f of degraded.slice(0, MAX_GAP_FILES_SCANNED)) {
    let text;
    try {
      text = fs.readFileSync(path.resolve(rootDir, f.path), 'utf8');
    } catch (_) {
      continue; // deleted/unreadable since the build - nothing to report
    }
    if (text.includes(symbolName)) gaps.push({ path: f.path, reason: f.index_status });
  }
  return gaps;
}

/**
 * Pre-edit safety report for a symbol: who transitively calls it (blast
 * radius) and which tests, if any, exercise it - so an agent can gauge risk
 * before changing it instead of finding out after the fact.
 */
function check(rootDir, symbolId, opts = {}, deps = {}) {
  const { hops = 3, testHops = 6, maxCallers = DEFAULT_MAX_CALLERS } = opts;
  const brainDir = getRepoBrainDir(rootDir);
  const store = deps.store || new GraphStore(brainDir);
  const shouldClose = !deps.store;
  try {
    const id = Number(symbolId);
    const symbol = store.getSymbolById(id);
    if (!symbol) return null;
    const file = store.getFileById(symbol.file_id);

    const { callers: allCallers, meta: callerMeta } = store.getCallers(id, Number(hops));
    const { tests: testsCovering, meta: testMeta } = store.getTestsForSymbol(id, Number(testHops));
    const classAggregation = callerMeta.classAggregation || testMeta.classAggregation || null;

    // Cap the response. An unbounded blast radius on a widely-used symbol
    // has come back at ~800KB in one call - far past what any MCP client can
    // use, and self-defeating for a tool whose whole pitch is spending fewer
    // tokens than reading files directly. Highest-confidence, nearest hops
    // are kept first (see graphStore's sort), and the summary below still
    // reports the full totals so a truncated answer never reads as a
    // complete one.
    const blastRadius = allCallers.slice(0, maxCallers);
    const byFile = new Map();
    for (const c of allCallers) {
      const key = c.path || '(unknown)';
      byFile.set(key, (byFile.get(key) || 0) + 1);
    }
    const highConfidenceCallers = allCallers.filter((c) => c.confidence === 'high').length;
    // A class/interface with zero discoverable members (see graphStore.js's
    // _resolveSeeds) means the walk never actually ran - an empty
    // blastRadius/testsCovering there is NOT the same finding as "we looked
    // and this really has no callers/tests". Surface that as its own `risk`
    // value instead of the misleadingly confident 'untested', which is
    // exactly the false-safe reading a prior benchmark of this tool flagged
    // as its biggest risk: an agent could take an empty, unresolved result
    // as "safe to change" instead of "unknown".
    const unresolved = !!(classAggregation && classAggregation.unresolved);

    // Index gaps: a file that's in the repo but has degraded or zero symbol
    // coverage (parse failure, size-skipped - see graphStore's index_status)
    // and mentions this symbol's name in its raw text is a caller this walk
    // structurally COULD NOT see. Reporting an empty blast radius without
    // saying so is the single most dangerous output this tool can produce,
    // and the reason `risk` has an 'incomplete' value at all.
    const indexGaps = findIndexGapsMentioning(rootDir, store, symbol.name);

    // A test reached only through an ambiguous name-match is not evidence of
    // coverage - see graphStore's TRUSTED_RESOLUTIONS. `stream()` matching
    // every list.stream() in a repo previously produced 916 "covering tests"
    // for a class with none.
    const confidentTests = testsCovering.filter((t) => t.confidence === 'high');

    let risk;
    if (unresolved) risk = 'unresolved';
    else if (indexGaps.length) risk = 'incomplete';
    else if (confidentTests.length) risk = 'covered';
    else risk = 'untested';

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
      blastRadiusSummary: {
        total: allCallers.length,
        shown: blastRadius.length,
        truncated: allCallers.length > blastRadius.length,
        highConfidence: highConfidenceCallers,
        lowConfidence: allCallers.length - highConfidenceCallers,
        files: byFile.size,
        topFiles: [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([path, count]) => ({ path, count }))
      },
      testsCovering,
      risk,
      ...(indexGaps.length
        ? {
            indexGaps,
            indexGapWarning:
              `${indexGaps.length} file(s) mention "${symbol.name}" but are not fully indexed, so this blast radius is ` +
              `INCOMPLETE - callers in those files cannot appear here. Grep them directly, and see the build output for why they were skipped.`
          }
        : {}),
      ...(classAggregation ? { classAggregation } : {})
    };
  } finally {
    if (shouldClose) store.close();
  }
}

module.exports = { search, expand, read, check };
