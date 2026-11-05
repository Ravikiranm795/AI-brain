'use strict';

const fs = require('fs');
const path = require('path');
const { GraphStore } = require('./graphStore');
const { VectorIndex } = require('./vectorIndex');
const { embedText } = require('./embedder');
const { getRepoBrainDir, getBrainsHome, isTestFile, PRESENTATION_EXTENSIONS } = require('./config');
const { loadUserConfig } = require('./userConfig');
const { queryTerms, pathTokens } = require('./identifiers');

// Reciprocal-rank-fusion constant: standard choice (see Cormack et al.'s RRF
// paper), not tuned for this corpus - low sensitivity to the exact value is
// the whole appeal of RRF over score-normalizing the two very
// differently-scaled inputs (cosine similarity vs. bm25) by hand.
// Overridable per-repo/machine-wide via brain.config.json's `rrfK` - see
// userConfig.js.
const DEFAULT_RRF_K = 60;

// --- What a result is worth before it is ranked ---------------------------
//
// Test and suite symbols are named like sentences ("asks a signed-out user to
// log in"), so they match a plain-English question better than the terse
// implementation they test does. On a repo with a spec per file that is about
// four results in ten, and they crowd the real code out of the top of the list.
// So they are demoted - not removed - unless the question is about tests.
// Whole-file chunks of markup and styles get a milder demotion: they match on
// a component's name but are rarely the answer to "where is the logic".

const TEST_INTENT = /\b(tests?|specs?|unit tests?|mocks?|mocking|coverage|karma|jasmine|jest|describe|assertions?|testing)\b/i;
const KIND_WEIGHT = { test: 0.35, suite: 0.35, hook: 0.5, file: 0.7 };
const TEST_FILE_WEIGHT = 0.35;
const PRESENTATION_WEIGHT = 0.6;

function rankWeight(kind, relPath, testIntent) {
  let w = 1;
  if (!testIntent) {
    w *= KIND_WEIGHT[kind] !== undefined ? KIND_WEIGHT[kind] : 1;
    if (relPath && isTestFile(relPath)) w = Math.min(w, TEST_FILE_WEIGHT);
  }
  if (relPath && PRESENTATION_EXTENSIONS.has(path.extname(relPath).toLowerCase())) w *= PRESENTATION_WEIGHT;
  return w;
}

/**
 * Per-symbol and per-file facts the ranking needs, read once per open store
 * (one query over symbols JOIN files) and kept on it.
 */
function getSearchMeta(store) {
  if (store._searchMeta) return store._searchMeta;
  const rows = store.db
    .prepare('SELECT s.id, s.file_id, s.kind, s.name, s.start_line, f.path FROM symbols s JOIN files f ON f.id = s.file_id')
    .all();
  const weightDefault = new Map();
  const weightTests = new Map();
  const fileOf = new Map();
  const symbolsOfFile = new Map();
  for (const r of rows) {
    weightDefault.set(r.id, rankWeight(r.kind, r.path, false));
    weightTests.set(r.id, rankWeight(r.kind, r.path, true));
    if (!fileOf.has(r.file_id)) {
      fileOf.set(r.file_id, { path: r.path, tokens: pathTokens(r.path), isTest: isTestFile(r.path) });
      symbolsOfFile.set(r.file_id, []);
    }
    symbolsOfFile.get(r.file_id).push(r);
  }
  const df = new Map();
  for (const f of fileOf.values()) for (const t of f.tokens) df.set(t, (df.get(t) || 0) + 1);
  store._searchMeta = { weightDefault, weightTests, fileOf, symbolsOfFile, df, files: fileOf.size };
  return store._searchMeta;
}

/** The rank weights as an array aligned with the vector index, cached per intent. */
function vectorWeightsFor(meta, vectorIndex, testIntent) {
  const key = testIntent ? 'tests' : 'default';
  const cached = vectorIndex._rankWeights && vectorIndex._rankWeights[key];
  if (cached && cached.length === vectorIndex.ids.length) return cached;
  const map = testIntent ? meta.weightTests : meta.weightDefault;
  const arr = Float32Array.from(vectorIndex.ids, (id) => (map.has(id) ? map.get(id) : 1));
  vectorIndex._rankWeights = Object.assign(vectorIndex._rankWeights || {}, { [key]: arr });
  return arr;
}

// Files whose *name* says what a plain-English question is about: "cookie
// consent banner" -> cookie-consent.service.ts. In component-per-folder
// frameworks the feature name lives in the file name, not in any function.
//
// Deliberately strict. A single question word that happens to be in a file
// name ("institution", "library") is coincidence as often as evidence, and a
// vote built on it can push a correct answer from another channel down the
// list. So a file only counts when at least two distinct question words are in
// its name, it casts one vote, and that vote is worth less than a semantic or
// lexical one (PATH_VOTE_WEIGHT).
const MAX_PATH_FILES = 12;
const MIN_PATH_TERMS = 2;
const PATH_VOTE_WEIGHT = 0.75;

function pathChannel(meta, terms, testIntent) {
  if (!terms.length) return [];
  const scored = [];
  for (const [fileId, f] of meta.fileOf) {
    if (f.isTest && !testIntent) continue;
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      if (!f.tokens.has(t)) continue;
      score += Math.log(1 + meta.files / (meta.df.get(t) || 1));
      matched++;
    }
    if (matched >= MIN_PATH_TERMS) scored.push({ fileId, score, matched });
  }
  scored.sort((a, b) => b.score - a.score || b.matched - a.matched);
  const out = [];
  for (const { fileId } of scored.slice(0, MAX_PATH_FILES)) {
    const syms = (meta.symbolsOfFile.get(fileId) || []).filter((r) => r.kind !== 'test' && r.kind !== 'suite');
    const order = (r) => (r.kind === 'class' ? 0 : r.kind === 'function' || r.kind === 'method' ? 1 : 2);
    syms.sort((a, b) => order(a) - order(b) || a.start_line - b.start_line);
    if (syms.length) out.push([syms[0].id]);
  }
  return out; // one single-symbol array per file (its class, else first function), best file first
}

// --- Lexical fast path (see classifyQuery / lexicalFirstSearch) -----------
//
// Every search used to pay a synchronous local ONNX forward pass before it
// could look at anything, plus a brute-force cosine scan over every vector
// in the repo. Measured warm on a 2.3k-symbol repo that was ~16ms embedding
// + ~9ms vector scan against ~1ms for the FTS5 lookup - i.e. ~96% of the
// work, spent to answer questions like "domainToken" where the lexical
// index already holds the exact answer and the embedding adds nothing.
//
// So: when a query is shaped like an identifier or a quoted literal, try
// lexical first and return without ever loading the embedder. Fall through
// to the full hybrid search whenever that evidence is thin, which keeps
// natural-language queries on exactly the path they were on before.

// How many name/body hits count as "the lexical index already answered
// this". A name match is decisive on its own; body matches need to be
// corroborated, since one stray mention in a test file is not an answer.
const MIN_BODY_HITS_FOR_CONFIDENCE = 3;

// A query with more tokens than this is prose, whatever the tokens look
// like, and belongs on the semantic path.
const MAX_FAST_PATH_TOKENS = 3;

/**
 * Is this query asking for a literal thing by name, rather than describing
 * a concept?
 *
 * Deliberately conservative: a bare lowercase word like "authentication" is
 * NOT treated as an identifier, because it's far more likely to be a
 * concept the semantic index handles better. The signals accepted are the
 * unambiguous ones - an explicit quoted literal, or internal capitalization
 * / underscores / dots, none of which occur in ordinary prose words.
 */
function classifyQuery(queryText) {
  const trimmed = (queryText || '').trim();
  const quoted = trimmed.length > 2 && /^(["'`])[\s\S]*\1$/.test(trimmed);
  const inner = quoted ? trimmed.slice(1, -1).trim() : trimmed;

  const tokens = inner.match(/[A-Za-z0-9_$.]+/g) || [];
  if (!tokens.length) return { lexicalFirst: false, tokens, inner };

  // An explicitly quoted string is a literal by the user's own declaration.
  // A multi-word one ("user not found") is text from a string or comment,
  // not a symbol name, so it's matched against bodies only - substring-
  // matching each of its words against symbol names would "find" every
  // symbol containing `not` or `user`.
  if (quoted) return { lexicalFirst: true, tokens, inner, reason: 'quoted-literal', nameSearch: tokens.length === 1 };

  if (tokens.length > MAX_FAST_PATH_TOKENS) return { lexicalFirst: false, tokens, inner };
  // Anything other than the identifier characters themselves (a slash, a
  // question mark, prose punctuation) means this isn't a bare identifier.
  if (tokens.join(' ') !== inner.replace(/\s+/g, ' ')) return { lexicalFirst: false, tokens, inner };

  const identifierShaped = (t) => /[a-z][A-Z]/.test(t) || /[_$.]/.test(t) || /^[A-Z][a-z]+[A-Z]/.test(t);
  if (!tokens.every(identifierShaped)) return { lexicalFirst: false, tokens, inner };

  return { lexicalFirst: true, tokens, inner, reason: 'identifier', nameSearch: true };
}

/**
 * Lexical-only search: symbol-name matches first (most precise), then FTS5
 * body matches, fused by rank the same way the full hybrid search fuses its
 * two inputs.
 *
 * Returns `{ confident, ranked }`. `confident: false` means the caller
 * should fall through to the full semantic search - nothing has been
 * wasted, since no embedding was computed.
 */
function lexicalFirstSearch(store, shape, fetchK, rrfK, weightOf) {
  const w = (id) => (weightOf ? weightOf(id) : 1);
  const fused = new Map();
  const addHit = (id, rank, via) => {
    const cur = fused.get(id) || { score: 0, matches: 0, via: [] };
    cur.score += 1 / (rrfK + rank + 1);
    cur.matches += 1;
    if (!cur.via.includes(via)) cur.via.push(via);
    fused.set(id, cur);
  };

  // Only an exact or prefix name match (rank 0/1) counts as the index having
  // answered the query. A containment match (rank 2) is fused into the
  // results but is too weak to skip semantic search on its own - `Token`
  // is inside hundreds of names.
  let strongNameHits = 0;
  if (shape.nameSearch) {
    for (const term of shape.tokens) {
      // Best match first; among equally good names the real code before its spec.
      const named = store.searchByName(term, fetchK).map((h, i) => ({ h, i }));
      if (weightOf) named.sort((a, b) => a.h.rank - b.h.rank || w(b.h.symbolId) - w(a.h.symbolId) || a.i - b.i);
      named.map((x) => x.h).forEach((h, i) => {
        if (h.rank <= 1) strongNameHits++;
        // searchByName already returns exact, then prefix, then containment,
        // so list position is the match-strength order.
        addHit(h.symbolId, i, 'name');
      });
    }
  }
  // andOnly: an empty body result must mean "not found" here, so the caller
  // falls through to semantic search instead of accepting loose OR matches.
  let bodyHits = store.searchLexical(shape.inner, fetchK * (weightOf ? 3 : 1), { andOnly: true });
  if (weightOf) bodyHits = bodyHits.map((h) => ({ ...h, score: h.score * w(h.symbolId) })).sort((a, b) => a.score - b.score).slice(0, fetchK);
  // Body matches start below every exact/prefix name match, so a test that
  // merely mentions a symbol can't outrank the symbol's own declaration. A
  // body hit on a symbol that is also a name hit still adds to its score.
  bodyHits.forEach((h, i) => addHit(h.symbolId, strongNameHits + i, 'body'));

  const confident = strongNameHits > 0 || bodyHits.length >= MIN_BODY_HITS_FOR_CONFIDENCE;
  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, fetchK);
  return { confident, ranked };
}

// A file's best symbols tend to fill the top of the list (a class and three of
// its methods), which hides the other files an answer may span. Keep the order
// but let each file show at most MAX_PER_FILE symbols before any file shows a
// third; the surplus follows, so nothing is dropped.
const MAX_PER_FILE = 2;

function spreadAcrossFiles(results) {
  const seen = new Map();
  const first = [];
  const surplus = [];
  for (const r of results) {
    const n = seen.get(r.path) || 0;
    seen.set(r.path, n + 1);
    (n < MAX_PER_FILE ? first : surplus).push(r);
  }
  return first.concat(surplus);
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

    // score is an RRF-fused rank score, not a raw cosine similarity - see
    // the RRF_K comment above and README §10 for what it means and why.
    // `confidence` buckets it into something more actionable than the raw
    // number: 'high' when two independent rankings agreed on this result,
    // 'medium'/'low' otherwise based on how high it ranked in whichever
    // single list found it.
    const decorate = (ranked, matchedVia) =>
      ranked
        .map(([symbolId, { score, matches, via }]) => {
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
            confidence,
            matchedVia: via ? via.join('+') : matchedVia
          };
        })
        .filter(Boolean);

    const applyFilters = (results) => {
      let out = results;
      if (kind) out = out.filter((r) => r.kind === kind);
      if (ext) out = out.filter((r) => r.path && r.path.endsWith(ext));
      return spreadAcrossFiles(out).slice(0, k);
    };

    // Fast path: an identifier/literal query the lexical index can answer
    // outright, without loading the embedder at all. See classifyQuery.
    const meta = getSearchMeta(store);
    const testIntent = TEST_INTENT.test(queryText) || ['test', 'suite', 'hook'].includes(kind);
    const weightMap = testIntent ? meta.weightTests : meta.weightDefault;
    const weightOf = (id) => (weightMap.has(id) ? weightMap.get(id) : 1);

    const shape = classifyQuery(queryText);
    if (shape.lexicalFirst) {
      const { confident, ranked } = lexicalFirstSearch(store, shape, fetchK, rrfK, weightOf);
      if (confident) {
        const fast = applyFilters(decorate(ranked));
        // A kind/ext filter can empty an otherwise-good lexical result set;
        // that's a reason to let the semantic search try, not to return [].
        if (fast.length) return fast;
      }
    }

    const queryVec = await embedText(queryText);
    const semanticHits = vectorIndex.search(queryVec, fetchK, vectorWeightsFor(meta, vectorIndex, testIntent));
    // Over-fetch, then re-rank by weight: with tests demoted, the lexical
    // list's top 40 would otherwise be mostly the specs that mention the words.
    const lexicalHits = store
      .searchLexical(queryText, fetchK * 3)
      .map((h) => ({ ...h, score: h.score * weightOf(h.symbolId) }))
      .sort((a, b) => a.score - b.score)
      .slice(0, fetchK);

    const fused = new Map(); // symbolId -> { score, matches }
    const addHit = (id, rank, weight = 1) => {
      const cur = fused.get(id) || { score: 0, matches: 0 };
      cur.score += weight / (rrfK + rank + 1);
      cur.matches += 1;
      fused.set(id, cur);
    };
    semanticHits.forEach((h, i) => addHit(h.symbolId, i));
    lexicalHits.forEach((h, i) => addHit(h.symbolId, i));

    const terms = queryTerms(queryText);

    // A short query is usually a name: let an exact or prefix name match count
    // as its own vote, so `slugify` finds the function before the spec that
    // is also called slugify.
    if (terms.length && terms.length <= 3) {
      for (const term of terms) {
        const named = store.searchByName(term, fetchK * 2)
          .map((h, i) => ({ h, i }))
          .filter((x) => x.h.rank <= 1)
          .sort((a, b) => a.h.rank - b.h.rank || weightOf(b.h.symbolId) - weightOf(a.h.symbolId) || a.i - b.i)
          .slice(0, fetchK);
        named.forEach((x, i) => addHit(x.h.symbolId, i));
      }
    }

    // File names that say what the question is about.
    pathChannel(meta, terms, testIntent).forEach((ids, fileRank) => ids.forEach((id) => addHit(id, fileRank, PATH_VOTE_WEIGHT)));

    const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, fetchK);

    return applyFilters(decorate(ranked, 'semantic+body'));
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
    const related = store.expand(id, Number(hops));
    return related.map((r) => ({
      relation: r.relation,
      symbolId: r.symbol ? r.symbol.id : null,
      name: r.symbol ? r.symbol.name : null,
      kind: r.symbol ? r.symbol.kind : null,
      path: r.file ? r.file.path : null,
      startLine: r.symbol ? r.symbol.start_line : null,
      endLine: r.symbol ? r.symbol.end_line : null,
      sharedKey: r.sharedKey,
      viaMember: r.viaMember || null
    }));
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
// A test reached through a direct, unambiguous edge actually demonstrates
// coverage; one reached at hop 5 through a name collision is a guess. Above
// this confidence (see graphStore's _scoreEdge) a symbol counts as genuinely
// covered - below it, 'weakly-covered' says the evidence exists but is thin,
// which is information the old binary covered/untested flag threw away.
const STRONG_COVERAGE_CONFIDENCE = 0.2;

function check(rootDir, symbolId, opts = {}, deps = {}) {
  const { hops = 3, testHops = 6, minConfidence, limit } = opts;
  const brainDir = getRepoBrainDir(rootDir);
  const store = deps.store || new GraphStore(brainDir);
  const shouldClose = !deps.store;
  try {
    const id = Number(symbolId);
    const symbol = store.getSymbolById(id);
    if (!symbol) return null;
    const file = store.getFileById(symbol.file_id);

    const rankOpts = {};
    if (minConfidence != null) rankOpts.minConfidence = Number(minConfidence);
    if (limit != null) rankOpts.limit = Number(limit);

    const blastRadius = store.getCallers(id, Number(hops), rankOpts);
    const testsCovering = store.getTestsForSymbol(id, Number(testHops), rankOpts);

    const strongestTest = testsCovering.reduce((m, t) => Math.max(m, t.confidence || 0), 0);
    const risk =
      strongestTest >= STRONG_COVERAGE_CONFIDENCE ? 'covered' : testsCovering.length ? 'weakly-covered' : 'untested';

    // Class checks walk the class's methods too (see getClassMembers), so
    // say so - otherwise a non-empty result on a symbol with no incoming
    // edges of its own looks like a bug rather than the rollup working.
    const members = symbol.kind === 'class' ? store.getClassMembers(id) : [];

    return {
      symbol: {
        symbolId: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        path: file ? file.path : null,
        startLine: symbol.start_line,
        endLine: symbol.end_line
      },
      rolledUpMembers: members.map((m) => m.name),
      blastRadius,
      testsCovering,
      risk,
      coverageConfidence: Number(strongestTest.toFixed(3)),
      omitted: {
        blastRadius: blastRadius.omitted || { belowThreshold: 0, overLimit: 0 },
        testsCovering: testsCovering.omitted || { belowThreshold: 0, overLimit: 0 }
      }
    };
  } finally {
    if (shouldClose) store.close();
  }
}

module.exports = { search, expand, read, check, classifyQuery, lexicalFirstSearch, rankWeight, pathChannel, spreadAcrossFiles, getSearchMeta, TEST_INTENT };
