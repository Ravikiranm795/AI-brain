'use strict';

/**
 * "Without brain": an agent that only has the tools every coding agent has,
 * grep and read-file. It is modelled as a deterministic strategy so the run
 * is repeatable, and every step is a real process or file read that is timed
 * and whose output is counted as tokens the agent would have to read.
 *
 * Keywords are taken from the task text mechanically (stop-words removed), not
 * hand-picked per task, so the baseline can't be tuned to look good or bad.
 *
 * The baseline is deliberately given generous conditions:
 *  - searches skip src/assets (vendored and minified files); a real agent often
 *    greps the whole repo and wades through them;
 *  - files are ranked by IDF-weighted keyword matches, which is what a careful
 *    agent approximates when it weighs a rare word above a common one;
 *  - a single file read is capped at what an agent's read tool returns
 *    (2000 lines / ~25k tokens), as real tools do.
 */

const fs = require('fs');
const path = require('path');
const { run, tokens, norm } = require('./lib');

const STOP = new Set(('a an the is are was were be been being do does did done doing to of in on at by for from with without into onto over under up down out off ' +
  'and or but if then else when where which who whom whose what why how that this these those there here it its as so than too very can could should would ' +
  'will shall may might must i me my we our you your they them their he she him her not no yes about after before again all any both each few more most ' +
  'other some such only own same just also get gets got make makes made using use used code file files function functions method methods ' +
  'find finds found work works worked way ways thing things everything anything').split(/\s+/));

const MAX_KEYWORDS = 8;
const READ_TOP = 5;
const SNIPPET_CONTEXT = 3;
const SNIPPET_MAX_LINES = 80;
const READ_CAP_CHARS = 100000; // ~25k tokens, a typical read-tool ceiling
const READ_CAP_LINES = 2000;
const PATHSPEC = ['src', ':(exclude)src/assets'];

function keywordsFor(task) {
  if (task.symbol) return [task.symbol];
  const seen = new Set();
  const out = [];
  for (const w of task.query.toLowerCase().match(/[a-z][a-z0-9]+/g) || []) {
    if (w.length < 4 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length === MAX_KEYWORDS) break;
  }
  return out;
}

function gitGrep(repo, args) {
  return run('git', ['-C', repo, '-c', 'core.quotepath=off', 'grep', ...args, '--', ...PATHSPEC]);
}

let searchedFiles = null;
function fileCount(repo) {
  if (searchedFiles === null) {
    searchedFiles = run('git', ['-C', repo, 'ls-files', '--', ...PATHSPEC]).stdout.split('\n').filter(Boolean).length;
  }
  return searchedFiles;
}

/** What a read tool would hand back for one file. */
function readCapped(abs) {
  let text = fs.readFileSync(abs, 'utf8');
  const lines = text.split('\n');
  if (lines.length > READ_CAP_LINES) text = lines.slice(0, READ_CAP_LINES).join('\n');
  return text.length > READ_CAP_CHARS ? text.slice(0, READ_CAP_CHARS) : text;
}

/**
 * One grep call per keyword (case-insensitive substring, counting matches per
 * file). Files are then ranked by the summed rarity of the keywords they match
 * (a word found in 5 files counts for far more than one found in 300), with
 * total hits as the tie-break and the path as the last resort.
 */
function rankFiles(repo, keywords) {
  const N = fileCount(repo);
  const perKeyword = [];
  let ms = 0;
  let listing = '';
  for (const kw of keywords) {
    const r = gitGrep(repo, ['-i', '-c', '-F', '-e', kw]);
    ms += r.ms;
    listing += r.stdout;
    const hits = new Map();
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^(.*):(\d+)$/);
      if (m) hits.set(norm(m[1]), Number(m[2]));
    }
    perKeyword.push(hits);
  }
  const perFile = new Map();
  for (const hits of perKeyword) {
    const idf = Math.log(1 + N / Math.max(1, hits.size));
    for (const [f, n] of hits) {
      const cur = perFile.get(f) || { score: 0, hits: 0 };
      cur.score += idf;
      cur.hits += n;
      perFile.set(f, cur);
    }
  }
  const ranked = [...perFile.entries()]
    .sort((a, b) => b[1].score - a[1].score || b[1].hits - a[1].hits || a[0].localeCompare(b[0]))
    .map(([f]) => f);
  return { ranked, ms, listing, calls: keywords.length };
}

/** B1: grep, then read the top files in full. */
function grepReadFiles(repo, task) {
  const keywords = keywordsFor(task);
  const g = rankFiles(repo, keywords);
  let ms = g.ms;
  const reads = [];
  for (const f of g.ranked.slice(0, READ_TOP)) {
    const t0 = process.hrtime.bigint();
    const text = readCapped(path.join(repo, f));
    ms += Number(process.hrtime.bigint() - t0) / 1e6;
    reads.push({ path: f, tokens: tokens(text) });
  }
  return {
    keywords, ms, calls: g.calls + reads.length,
    listingTokens: tokens(g.listing),
    candidates: g.ranked,
    items: reads
  };
}

/** B2: the frugal agent - grep with a few lines of context for the top files instead of whole files. */
function grepSnippets(repo, task) {
  const keywords = keywordsFor(task);
  const g = rankFiles(repo, keywords);
  const top = g.ranked.slice(0, READ_TOP);
  let ms = g.ms;
  const items = [];
  if (top.length) {
    const args = ['-n', '-i', '-F', `-C${SNIPPET_CONTEXT}`];
    keywords.forEach((k) => args.push('-e', k));
    // --null puts a NUL after the file name, so paths containing '-' or digits parse unambiguously.
    const r = run('git', ['-C', repo, '-c', 'core.quotepath=off', 'grep', '--null', ...args, '--', ...top]);
    ms += r.ms;
    const byFile = new Map();
    for (const line of r.stdout.split('\n')) {
      const i = line.indexOf('\0');
      if (i < 0) continue;
      const f = norm(line.slice(0, i));
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(line.slice(i + 1));
    }
    for (const f of top) {
      const lines = (byFile.get(f) || []).slice(0, SNIPPET_MAX_LINES);
      items.push({ path: f, tokens: tokens(lines.join('\n')) });
    }
  }
  return {
    keywords, ms, calls: g.calls + (top.length ? 1 : 0),
    listingTokens: tokens(g.listing),
    candidates: g.ranked,
    items
  };
}

/** For "what calls X": a single word-boundary grep with line numbers; the output itself is the answer. */
function grepCallers(repo, task) {
  const r = gitGrep(repo, ['-n', '--null', '-w', '-F', '-e', task.symbol]);
  const byFile = new Map();
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('\0');
    if (i < 0) continue;
    const f = norm(line.slice(0, i));
    byFile.set(f, (byFile.get(f) || 0) + tokens(`${f}:${line.slice(i + 1)}\n`));
  }
  const plain = gitGrep(repo, ['-n', '-w', '-F', '-e', task.symbol]).stdout; // what the agent actually reads
  return {
    keywords: [task.symbol], ms: r.ms, calls: 1,
    listingTokens: tokens(plain),
    candidates: [...byFile.keys()],
    items: [...byFile.entries()].map(([p, t]) => ({ path: p, tokens: t }))
  };
}

module.exports = { keywordsFor, grepReadFiles, grepSnippets, grepCallers, READ_TOP };
