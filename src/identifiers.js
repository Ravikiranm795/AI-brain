'use strict';

/**
 * Identifier tokenization shared by the FTS5 index (graphStore's chunks.parts,
 * written at index time) and by query expansion (graphStore's searchLexical,
 * applied at query time). Both sides must split the same way or the index and
 * the query disagree about what a token is.
 *
 * The problem this exists to solve: FTS5's default (unicode61) tokenizer
 * splits on non-alphanumerics only. It does NOT split camelCase, so
 * `getDomainTokenHeader` is indexed as the single token
 * `getdomaintokenheader`, and an exact-token MATCH for `domainToken` cannot
 * reach inside it. Measured on a real Angular repo: a search for
 * `encryptUsingAES` returned 0 FTS hits while the file containing
 * `encryptUsingAES256` was one grep away.
 */

// Cap on tokens stored per chunk, so a generated or minified file can't put
// a pathological string into the index. Well above what real source needs.
const MAX_PARTS_PER_CHUNK = 400;

// Sub-tokens shorter than this are dropped: they're overwhelmingly loop
// variables and type-parameter noise (`i`, `x`, `T`), and each one matches
// most of the repo.
const MIN_PART_LENGTH = 2;

/**
 * Splits one identifier into its constituent words.
 *   getDomainTokenHeader -> [get, Domain, Token, Header]
 *   encryptUsingAES256   -> [encrypt, Using, AES, 256]
 *   HTTP_PROXY_URL       -> [HTTP, PROXY, URL]
 *   reader-launcher      -> [reader, launcher]
 */
function splitIdentifier(word) {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // An acronym run followed by a word: HTTPServer -> HTTP Server, and
    // without this the first rule alone would yield the useless `HTTPS erver`.
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/**
 * The ordered, lowercase, length-filtered sub-tokens of one identifier.
 * Both the index side (identifierParts) and the query side (graphStore's
 * _expandTerm) go through this, so a query phrase is always built from
 * exactly the token run the index holds - filtering on one side only would
 * make `getXToken` index as `get token` but query as `get x token`.
 */
function indexableParts(word) {
  return splitIdentifier(word)
    .filter((p) => p.length >= MIN_PART_LENGTH)
    .map((p) => p.toLowerCase());
}

/**
 * The sub-token stream indexed alongside a chunk's raw code, as a
 * lowercase space-joined string.
 *
 * Each compound identifier contributes its parts as one contiguous run,
 * because the query side matches them as an ordered phrase
 * (`parts:"domain token"`). Deduplication is therefore per *identifier*, not
 * per sub-token: deduping sub-tokens would let an earlier `setDomain` eat
 * the `domain` of a later `getDomainToken`, leaving `get token` in the
 * stream and making the phrase `domain token` unfindable.
 *
 * Only *compound* identifiers contribute. A single-word identifier is
 * already an exact FTS token in the `code` column, so re-indexing it here
 * would just double the index size for no extra recall.
 */
function identifierParts(code) {
  if (!code) return '';
  const seen = new Set();
  const out = [];
  const words = code.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    if (splitIdentifier(w).length < 2) continue;
    const parts = indexableParts(w);
    if (!parts.length) continue;
    // Whole runs only: a truncated run would be an adjacency lie.
    if (out.length + parts.length > MAX_PARTS_PER_CHUNK) break;
    out.push(...parts);
  }
  return out.join(' ');
}

/** True when a term is a compound identifier worth expanding into parts. */
function isCompoundIdentifier(term) {
  return splitIdentifier(term).length > 1;
}

// Words that carry no signal in a plain-English request. Used to keep prose
// queries from matching on "the", "how", "where" - which appear in every
// comment and make the lexical channel return noise - and to pick the terms
// worth comparing against file paths.
const STOPWORDS = new Set((
  'a an the is are was were be been being do does did done doing to of in on at by for from with without into onto over under up down out off ' +
  'and or but if then else when where which who whom whose what why how that this these those there here it its as so than too very can could ' +
  'should would will shall may might must i me my we our you your they them their he she him her not no yes about after before again all any ' +
  'both each few more most other some such only own same just also get gets got make makes made use used using find finds found work works ' +
  'way ways thing things want wants need needs please'
).split(/\s+/));

/** Naive plural folding so `cookies` matches `cookie` and `services` matches `service`. */
function stem(word) {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/**
 * The meaningful words of a query: lowercase, stop-words and 1-2 letter words
 * removed, plurals folded, duplicates dropped. Digits are kept (`401`).
 */
function queryTerms(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    const w = stem(raw);
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** The lowercase, plural-folded words in a file path: `core/cookie-consent.service.ts` -> cookie, consent, service, core. */
function pathTokens(relPath) {
  const out = new Set();
  const base = String(relPath || '').replace(/\\/g, '/').replace(/\.[A-Za-z0-9]+$/, '');
  for (const seg of base.split('/')) {
    for (const piece of splitIdentifier(seg)) {
      const w = piece.toLowerCase();
      if (w.length >= 3) out.add(stem(w));
    }
  }
  return out;
}

/** Plain words from a code comment, for indexing: markers removed, lowercase, de-duplicated, capped. */
function commentWords(doc, max = 80) {
  const seen = new Set();
  const out = [];
  for (const w of String(doc || '').toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []) {
    if (STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out.join(' ');
}

// Path segments that say nothing about what a file is for.
const BORING_SEGMENTS = new Set(['src', 'app', 'lib', 'main', 'java', 'com', 'index', 'dist', 'core']);

/**
 * The text that gets embedded for a symbol. A bare `kind name: first line`
 * makes terse implementation names (`intercept`, `start`) land far from the
 * plain-English question that should find them, while sentence-like test names
 * land right on it. So the text also carries what the surrounding code says
 * about the symbol: its name as words, the words of the file it lives in
 * (feature names live in file names: cookie-consent.service.ts) and its
 * leading doc comment.
 */
function embeddingText(sym, relPath) {
  const nameWords = splitIdentifier(sym.name).join(' ').toLowerCase();
  const where = String(relPath || '').replace(/\\/g, '/').replace(/\.[A-Za-z0-9]+$/, '').split('/').filter(Boolean)
    .filter((seg) => !BORING_SEGMENTS.has(seg.toLowerCase())).slice(-3)
    .map((seg) => splitIdentifier(seg).join(' ').toLowerCase()).join(' / ');
  let text = `${sym.kind} ${sym.name}${nameWords && nameWords !== sym.name.toLowerCase() ? ` (${nameWords})` : ''}`;
  if (where) text += ` in ${where}`;
  text += `: ${sym.signature || ''}`;
  if (sym.doc) text += ` - ${sym.doc}`;
  return text.slice(0, 700);
}

module.exports = {
  embeddingText,
  splitIdentifier,
  indexableParts,
  identifierParts,
  isCompoundIdentifier,
  STOPWORDS,
  stem,
  queryTerms,
  pathTokens,
  commentWords,
  MAX_PARTS_PER_CHUNK,
  MIN_PART_LENGTH
};
