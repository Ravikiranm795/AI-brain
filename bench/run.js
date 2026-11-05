'use strict';

/**
 * Benchmark: the same engineering questions answered with the brain and without it.
 *
 *   node bench/run.js                                   # the original 19 tasks (bench/tasks.json)
 *   node bench/run.js --tasks bench/tasks-stages.json   # medium / hard / expert rounds
 *   node bench/run.js --label after --compare bench/results/bench-before-....json
 *   node bench/run.js --only L1,I1 --reps 1             # quick check
 *
 * Without the brain = grep + read-file (bench/baseline.js).
 * With the brain    = the real CLI, in a cold process per call, plus a warm
 *                     long-lived process (what the MCP server is).
 * Everything is written to bench/results/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, tokens, norm, sum, mean, median, percentile, run, runBrain } = require('./lib');
const baseline = require('./baseline');
const query = require('../src/query');

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(name);

const TASKS_FILE = path.resolve(arg('--tasks', path.join(__dirname, 'tasks.json')));
const cfg = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
const only = arg('--only', null);
if (only) cfg.tasks = cfg.tasks.filter((t) => only.split(',').includes(t.id));
const REPO = path.resolve(arg('--repo', cfg.repo));
const LABEL = arg('--label', 'run');
const COMPARE = arg('--compare', null);
const REPS_CLI = Number(arg('--reps', 3));
const REPS_BASE = 5;
const REPS_WARM = 5;
const PRICE_PER_MTOK_IN = 3.0; // USD per million input tokens - an ASSUMPTION for the cost lines; change to your model's price
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const STAGES = ['medium', 'hard', 'expert'];

const log = (...a) => console.error(...a);

/* ----------------------------------------------------------------- setup */

function validateTasks() {
  const tracked = new Set(run('git', ['-C', REPO, 'ls-files']).stdout.split('\n').map(norm));
  const missing = [];
  for (const t of cfg.tasks) for (const f of [...t.must, ...t.useful]) if (!tracked.has(f)) missing.push(`${t.id}: ${f}`);
  if (missing.length) throw new Error(`ground-truth files not tracked in ${REPO}:\n  ${missing.join('\n  ')}`);
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

function repoFacts() {
  const files = run('git', ['-C', REPO, 'ls-files', 'src']).stdout.split('\n').filter(Boolean);
  let bytes = 0;
  for (const f of files) { try { bytes += fs.statSync(path.join(REPO, f)).size; } catch (_) { /* renamed since checkout */ } }
  const sha = run('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']).stdout.trim();
  return { files: files.length, bytes, tokens: Math.ceil(bytes / 4), commit: sha };
}

function buildBrain(env, force, repo = REPO) {
  const r = run(process.execPath, [path.join(__dirname, 'build-child.js'), repo, ...(force ? ['--force'] : [])], { env, cwd: ROOT });
  if (r.code !== 0) throw new Error(`build failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/**
 * Freshness: how long until the brain reflects ONE edited file. Measured on a
 * throwaway clone so the real repo is never written to.
 */
function incrementalUpdate() {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-bench-clone-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-bench-home-'));
  try {
    const c = run('git', ['clone', '--quiet', '--local', '--no-hardlinks', REPO, clone]);
    if (c.code !== 0) return null;
    const env = { BRAIN_HOME: home };
    buildBrain(env, true, clone);
    const target = path.join(clone, 'src/app/core/services/token.service.ts');
    fs.appendFileSync(target, '\n// bench: one edited file\nexport const benchTouched = 1;\n');
    const t = buildBrain(env, false, clone);
    return { ms: t.ms, changed: t.stats.changed, added: t.stats.added };
  } catch (e) {
    return { error: e.message };
  } finally {
    fs.rmSync(clone, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------ scoring */

function ndcg(task, candidates, k = 5) {
  const gain = (f) => (task.must.includes(f) ? 2 : task.useful.includes(f) ? 1 : 0);
  const dcg = candidates.slice(0, k).reduce((s, f, i) => s + gain(f) / Math.log2(i + 2), 0);
  const ideal = [...task.must.map(() => 2), ...task.useful.map(() => 1)].sort((a, b) => b - a).slice(0, k)
    .reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  return ideal ? dcg / ideal : 0;
}

function score(task, o) {
  const must = new Set(task.must);
  const rel = new Set([...task.must, ...task.useful]);
  const delivered = new Set(o.delivered);
  const hitMust = task.must.filter((f) => delivered.has(f));
  const rank = o.candidates.findIndex((c) => must.has(c));
  const itemTok = sum(o.items.map((i) => i.tokens));
  const relTok = sum(o.items.filter((i) => rel.has(i.path)).map((i) => i.tokens));
  const top5 = o.candidates.slice(0, 5);
  const msAll = o.msAll || [o.ms];
  const m = mean(msAll);
  return {
    ms: o.ms, msAll, msStd: Math.sqrt(mean(msAll.map((x) => (x - m) ** 2))),
    calls: o.calls, tokens: o.totalTokens,
    tokensToFirstMust: o.tokensToFirstMust,
    rank: rank >= 0 ? rank + 1 : null,
    recall: hitMust.length / task.must.length,
    solved: hitMust.length === task.must.length,
    ndcg5: ndcg(task, o.candidates),
    p5: top5.length ? top5.filter((f) => rel.has(f)).length / top5.length : 0,
    filesDelivered: delivered.size,
    filePrecision: delivered.size ? [...delivered].filter((f) => rel.has(f)).length / delivered.size : 0,
    relevantShare: itemTok ? relTok / itemTok : 0,
    tokensPerCorrectFile: hitMust.length ? o.totalTokens / hitMust.length : null,
    costUsd: (o.totalTokens / 1e6) * PRICE_PER_MTOK_IN,
    ...(o.extra || {})
  };
}

function prefixTokensToFirstMust(task, listingTokens, items) {
  const must = new Set(task.must);
  let t = listingTokens;
  for (const it of items) {
    t += it.tokens;
    if (must.has(it.path)) return t;
  }
  return null;
}

function repeat(n, fn) {
  const times = [];
  let last;
  for (let i = 0; i < n; i++) { last = fn(); times.push(last.ms); }
  return { last, ms: median(times), all: times };
}

/* ---------------------------------------------------------- strategies */

function withoutBrain(task) {
  const out = {};
  if (task.type === 'impact') {
    const r = repeat(REPS_BASE, () => baseline.grepCallers(REPO, task));
    const b = r.last;
    out['grep'] = score(task, {
      candidates: b.candidates, delivered: b.candidates, items: b.items, totalTokens: b.listingTokens,
      tokensToFirstMust: b.candidates.some((c) => task.must.includes(c)) ? b.listingTokens : null, ms: r.ms, msAll: r.all, calls: b.calls
    });
    return out;
  }
  for (const [name, fn] of [['grep+read', baseline.grepReadFiles], ['grep+snippets', baseline.grepSnippets]]) {
    const r = repeat(REPS_BASE, () => fn(REPO, task));
    const b = r.last;
    out[name] = score(task, {
      candidates: b.candidates, delivered: b.items.map((i) => i.path), items: b.items,
      totalTokens: b.listingTokens + sum(b.items.map((i) => i.tokens)),
      tokensToFirstMust: prefixTokensToFirstMust(task, b.listingTokens, b.items), ms: r.ms, msAll: r.all, calls: b.calls,
      extra: { keywords: b.keywords.join(' ') }
    });
  }
  return out;
}

const uniq = (a) => [...new Set(a)];

function brainSearch(task, env) {
  const args = ['search', task.query, '-p', REPO, '-k', '5'];
  const runs = [];
  for (let i = 0; i < REPS_CLI; i++) runs.push(runBrain(args, env));
  const first = runs[0];
  const hits = JSON.parse(first.stdout);
  const candidates = uniq(hits.map((h) => norm(h.path)));
  const perHit = hits.map((h) => ({ path: norm(h.path), tokens: tokens(JSON.stringify(h, null, 2)) }));

  // What it costs an agent to confirm the answer: read each candidate's symbol, best first, until a required file is read.
  const must = new Set(task.must);
  let t = tokens(first.stdout);
  let readMs = 0;
  let toFirst = null;
  const seen = new Set();
  for (const h of hits) {
    const p = norm(h.path);
    if (seen.has(p)) continue;
    seen.add(p);
    const text = query.read(REPO, p, h.startLine, h.endLine);
    t += tokens(text);
    readMs += runBrain(['read', p, String(h.startLine), String(h.endLine), '-p', REPO], env).ms;
    if (must.has(p)) { toFirst = t; break; }
  }
  const ms = median(runs.map((r) => r.ms));
  return score(task, {
    candidates, delivered: candidates, items: perHit, totalTokens: tokens(first.stdout),
    tokensToFirstMust: toFirst, ms, msAll: runs.map((r) => r.ms), calls: 1,
    extra: { msToFirstMust: toFirst === null ? null : ms + readMs, callsToFirstMust: toFirst === null ? null : 1 + seen.size }
  });
}

function brainContext(task, env, extraArgs) {
  const args = ['context', task.query, '-p', REPO, ...extraArgs];
  const runs = [];
  for (let i = 0; i < REPS_CLI; i++) runs.push(runBrain(args, env));
  const first = runs[0];
  const ctx = JSON.parse(first.stdout);
  const entries = [...ctx.primary, ...ctx.neighbors].map((e) => ({ ...e, path: e.path ? norm(e.path) : null }));
  const withCode = entries.filter((e) => e.path && e.code != null);
  const items = entries.filter((e) => e.path).map((e) => ({ path: e.path, tokens: tokens(JSON.stringify(e, null, 2)) }));
  const candidates = uniq(entries.filter((e) => e.path).map((e) => e.path));
  const total = tokens(first.stdout);
  const delivered = uniq(withCode.map((e) => e.path));
  const must = new Set(task.must);
  const limit = ctx.budget && ctx.budget.limitChars;
  return score(task, {
    candidates, delivered, items, totalTokens: total,
    tokensToFirstMust: delivered.some((d) => must.has(d)) ? total : null, ms: median(runs.map((r) => r.ms)), msAll: runs.map((r) => r.ms), calls: 1,
    extra: {
      recallAny: task.must.filter((f) => candidates.includes(f)).length / task.must.length,
      truncated: !!(ctx.budget && ctx.budget.truncated), budgetUsed: limit ? ctx.budget.usedChars / limit : null
    }
  });
}

function brainCheck(task, env) {
  const searchArgs = ['search', task.symbol, '-p', REPO, '-k', '10'];
  const runs = [];
  let checkOut = null, searchOut = null;
  for (let i = 0; i < REPS_CLI; i++) {
    const s = runBrain(searchArgs, env);
    const hits = JSON.parse(s.stdout);
    const top = hits.find((h) => h.name === task.symbol && norm(h.path) === task.definedIn) || hits.find((h) => h.name === task.symbol) || hits[0];
    if (!top) { runs.push({ ms: s.ms }); continue; }
    const c = runBrain(['check', String(top.symbolId), '-p', REPO], env);
    runs.push({ ms: s.ms + c.ms });
    if (i === 0) { searchOut = s.stdout; checkOut = c.stdout; }
  }
  const msAll = runs.map((r) => r.ms);
  if (!checkOut) return score(task, { candidates: [], delivered: [], items: [], totalTokens: 0, tokensToFirstMust: null, ms: median(msAll), msAll, calls: 2 });
  const res = JSON.parse(checkOut);
  const rows = [...(res.blastRadius || []), ...(res.testsCovering || [])]
    .map((r) => ({ path: norm(r.path || r.file_path || ''), tokens: tokens(JSON.stringify(r, null, 2)) }))
    .filter((r) => r.path);
  const candidates = uniq(rows.map((r) => r.path));
  const total = tokens(searchOut) + tokens(checkOut);
  return score(task, {
    candidates, delivered: candidates, items: rows, totalTokens: total,
    tokensToFirstMust: candidates.some((c) => task.must.includes(c)) ? total : null, ms: median(msAll), msAll, calls: 2,
    extra: { risk: res.risk, blastRows: (res.blastRadius || []).length, testRows: (res.testsCovering || []).length }
  });
}

/* ------------------------------------------------------------- report */

const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const fx = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : Number(x).toFixed(d));
const num = (x) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : Math.round(x).toLocaleString('en-US'));
const usd = (x) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : `$${x < 0.01 ? x.toFixed(4) : x.toFixed(3)}`);

function aggregate(rows) {
  const ok = (k) => rows.map((r) => r[k]).filter((v) => v !== null && v !== undefined);
  const ranks = rows.map((r) => r.rank);
  const solved = rows.filter((r) => r.solved).length;
  return {
    n: rows.length, solvedN: solved,
    solved: solved / rows.length,
    recall: mean(rows.map((r) => r.recall)),
    hit1: ranks.filter((r) => r === 1).length / rows.length,
    hit3: ranks.filter((r) => r !== null && r <= 3).length / rows.length,
    mrr: mean(ranks.map((r) => (r ? 1 / r : 0))),
    ndcg5: mean(rows.map((r) => r.ndcg5)),
    p5: mean(rows.map((r) => r.p5)),
    calls: mean(rows.map((r) => r.calls)),
    tokens: mean(rows.map((r) => r.tokens)),
    tokensToFirst: ok('tokensToFirstMust').length ? mean(ok('tokensToFirstMust')) : null,
    tokensPerCorrectFile: ok('tokensPerCorrectFile').length ? mean(ok('tokensPerCorrectFile')) : null,
    ms: median(rows.map((r) => r.ms)),
    msP95: percentile(rows.flatMap((r) => r.msAll), 0.95),
    msStd: mean(rows.map((r) => r.msStd)),
    relevantShare: mean(rows.map((r) => r.relevantShare)),
    cost: mean(rows.map((r) => r.costUsd)),
    costPerSolved: solved ? sum(rows.map((r) => r.costUsd)) / solved : null,
    truncated: rows.some((r) => r.truncated !== undefined) ? rows.filter((r) => r.truncated).length / rows.length : null,
    budgetUsed: ok('budgetUsed').length ? mean(ok('budgetUsed')) : null
  };
}

function table(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

const STRATS = [
  ['grep+read', 'without'], ['grep+snippets', 'without'], ['grep', 'without'],
  ['brain-search', 'with'], ['brain-context', 'with'], ['brain-context-lean', 'with'], ['brain-check', 'with']
];
const WARM_KEY = { 'brain-search': 'searchMs', 'brain-context': 'contextMs', 'brain-context-lean': 'contextLeanMs', 'brain-check': 'checkMs' };

function groupsOf(R) {
  const hasStages = R.tasks.some((t) => t.stage);
  const keys = hasStages ? STAGES.filter((s) => R.tasks.some((t) => t.stage === s)) : ['locate', 'feature', 'identifier', 'impact'].filter((s) => R.tasks.some((t) => t.type === s));
  return keys.map((k) => ({ key: k, test: (t) => (hasStages ? t.stage === k : t.type === k) }));
}

function stratRows(R, subset) {
  return STRATS
    .map(([s, side]) => ({ s, side, rows: R.results.filter((r) => subset(r.task) && r.strategies[s]).map((r) => r.strategies[s]) }))
    .filter((x) => x.rows.length);
}

function warmMedian(R, subset, s) {
  const k = WARM_KEY[s];
  if (!k) return null;
  const v = R.results.filter((r) => subset(r.task) && r.warm && r.warm[k] !== undefined).map((r) => r.warm[k]);
  return v.length ? median(v) : null;
}

function best(rows) {
  return [...rows].sort((a, b) => b.agg.solved - a.agg.solved || b.agg.ndcg5 - a.agg.ndcg5 || a.agg.tokens - b.agg.tokens)[0];
}

function buildReport(R) {
  const L = [];
  const f = R.facts;
  L.push(`# Brain benchmark (${R.label}): with the brain vs without it`);
  L.push('');
  L.push(`Repo: \`${R.repo}\` @ \`${f.commit}\` (${f.files} files under src/, ${(f.bytes / 1048576).toFixed(1)} MB, about ${num(f.tokens)} tokens if read whole). Run ${R.stamp}.`);
  L.push(`Machine: ${R.env.cpu}, ${R.env.cores} threads, ${R.env.memGB} GB RAM, Node ${R.env.node}, ${R.env.platform}.`);
  L.push(`Tasks: ${R.tasks.length} (${groupsOf(R).map((g) => `${R.tasks.filter(g.test).length} ${g.key}`).join(', ')}) from \`${path.basename(R.tasksFile)}\`. Ground truth was fixed by reading the code before either method was run.`);
  L.push('');
  L.push('## How to read this');
  L.push('');
  L.push('- **Without the brain**: an agent with only grep and read-file. Keywords come mechanically from the task text; files are ranked by keyword rarity; the top 5 are read in full (`grep+read`) or as matching lines with 3 lines of context (`grep+snippets`). For "what depends on X" it is one word-match grep (`grep`). It skips `src/assets` and caps one read at about 25k tokens, which are generous to it.');
  L.push('- **With the brain**: the real CLI in a cold process per call, plus the same calls in one warm process (what the MCP server pays). `brain-search` = ranked symbols; `brain-context` = search + neighbours + code in one bundle (24k-char budget); `brain-context-lean` = `-k 5 --budget 8000`; `brain-check` = search then blast-radius report.');
  L.push(`- **Tokens** = characters / 4 for both sides (a real tokenizer differs by about 20%, the same way for both). Cost lines assume $${PRICE_PER_MTOK_IN.toFixed(2)} per million input tokens.`);
  L.push('- **Solved** = every required file was in what the method delivered. **hit@k** = a required file is among the first k candidate files. **nDCG@5** scores the first 5 candidates (required = 2, useful = 1). **P@5** = share of the first 5 candidates that are required or useful. **Relevant share** = share of delivered tokens that sit in required or useful files (the rest is noise the model must read). **Tokens to first answer** counts only tasks the method found, so read it next to Solved.');
  L.push('- **Latency** is retrieval only (process time and file reads), not model time. p95 is over all repetitions; jitter is the run-to-run standard deviation.');
  L.push('');

  L.push('## Standing costs of the brain');
  L.push('');
  const b = R.build;
  const inc = R.incremental;
  L.push(table(['Measure', 'Value'], [
    ['Full index build (cold, includes loading the embedding model)', `${(b.full.ms / 1000).toFixed(1)} s`],
    ['Incremental rebuild, nothing changed', `${(b.noop.ms / 1000).toFixed(1)} s`],
    ['Incremental rebuild, one file edited (freshness)', inc && inc.ms ? `${(inc.ms / 1000).toFixed(1)} s (${inc.changed} changed file)` : 'not measured'],
    ['Peak memory during the full build', `${b.full.maxRssMB} MB`],
    ['CPU time of the full build (user + system)', `${((b.full.userCpuMs + b.full.systemCpuMs) / 1000).toFixed(1)} s`],
    ['Symbols / files indexed', `${num(b.full.stats.symbols)} / ${num(b.full.stats.filesTotal)}`],
    ['Index size on disk', `${(b.diskBytes / 1048576).toFixed(1)} MB (${(b.diskBytes / f.bytes).toFixed(1)}x the source)`],
    ['Warm process: open store and vectors', `${fx(R.warm.openMs)} ms`],
    ['Warm process: first semantic query (model load)', `${fx(R.warm.modelLoadMs)} ms`],
    ['Warm process memory (idle, model loaded) / peak', `${R.warm.rssWarmMB} MB / ${R.warm.peakRssMB} MB`],
    ['Without the brain', 'nothing to build; no extra memory or disk']
  ]));
  L.push('');

  const groups = groupsOf(R);
  const roundSummary = [];
  for (const g of groups) {
    const sr = stratRows(R, g.test);
    if (!sr.length) continue;
    L.push(`## Round: ${g.key}`);
    L.push('');
    const tasks = R.tasks.filter(g.test);
    L.push(`${tasks.length} tasks: ${tasks.map((t) => t.id).join(', ')}.`);
    L.push('');
    const withAgg = sr.map((x) => ({ ...x, agg: aggregate(x.rows) }));
    L.push('**Core**');
    L.push('');
    L.push(table(['Method', 'Solved', 'hit@1', 'hit@3', 'Recall', 'Tool calls', 'Tokens delivered', 'Tokens to first answer', 'Latency cold (median)', 'Latency warm'],
      withAgg.map(({ s, side, agg }) => {
        const w = warmMedian(R, g.test, s);
        const nm = side === 'with' ? `**${s}**` : s;
        return [nm, `${agg.solvedN}/${agg.n}`, pct(agg.hit1), pct(agg.hit3), pct(agg.recall), fx(agg.calls, 1), num(agg.tokens), num(agg.tokensToFirst), `${num(agg.ms)} ms`, w === null ? 'n/a' : `${fx(w)} ms`];
      })));
    L.push('');
    L.push('**Advanced**');
    L.push('');
    L.push(table(['Method', 'nDCG@5', 'P@5', 'Relevant share', 'Tokens per correct file', 'Cost per task', 'Cost per solved task', 'Latency p95', 'Jitter', 'Context budget used', 'Truncated'],
      withAgg.map(({ s, side, agg }) => [side === 'with' ? `**${s}**` : s, fx(agg.ndcg5, 2), pct(agg.p5), pct(agg.relevantShare), num(agg.tokensPerCorrectFile), usd(agg.cost), usd(agg.costPerSolved),
        `${num(agg.msP95)} ms`, `+/-${num(agg.msStd)} ms`, pct(agg.budgetUsed), pct(agg.truncated)])));
    L.push('');

    const wb = best(withAgg.filter((x) => x.side === 'without'));
    const br = best(withAgg.filter((x) => x.side === 'with'));
    if (wb && br) {
      const verdict = br.agg.solved > wb.agg.solved ? 'brain ahead on answers' : br.agg.solved < wb.agg.solved ? 'grep ahead on answers' : 'tied on answers';
      L.push(`**Side by side:** best without = \`${wb.s}\` (${wb.agg.solvedN}/${wb.agg.n} solved, ${num(wb.agg.tokens)} tokens, ${num(wb.agg.ms)} ms); best with = \`${br.s}\` (${br.agg.solvedN}/${br.agg.n} solved, ${num(br.agg.tokens)} tokens, ${num(br.agg.ms)} ms cold). Verdict: ${verdict}.`);
      L.push('');
      roundSummary.push({ key: g.key, wb, br, warm: warmMedian(R, g.test, br.s) });
    }

    const cols = ['grep+read', 'grep+snippets', 'grep', 'brain-search', 'brain-context', 'brain-check'].filter((c) => R.results.some((r) => g.test(r.task) && r.strategies[c]));
    L.push('Per task: tokens delivered, rank of the first required file, recall.');
    L.push('');
    L.push(table(['Task', ...cols], R.results.filter((r) => g.test(r.task)).map((r) => [r.task.id, ...cols.map((c) => {
      const s = r.strategies[c];
      return s ? `${num(s.tokens)} t, ${s.rank ? `#${s.rank}` : 'miss'}, ${pct(s.recall)}` : '-';
    })])));
    L.push('');
  }

  if (roundSummary.length > 1) {
    L.push('## Rounds side by side');
    L.push('');
    L.push(table(['Round', 'Best without', 'Solved', 'Tokens', 'Cold latency', 'Best with', 'Solved', 'Tokens', 'Cold / warm latency'],
      roundSummary.map(({ key, wb, br, warm }) => [key, `\`${wb.s}\``, `${wb.agg.solvedN}/${wb.agg.n}`, num(wb.agg.tokens), `${num(wb.agg.ms)} ms`, `**\`${br.s}\`**`, `${br.agg.solvedN}/${br.agg.n}`, num(br.agg.tokens), `${num(br.agg.ms)} ms / ${warm === null ? 'n/a' : fx(warm) + ' ms'}`])));
    L.push('');
    L.push('Every method, per round (solved of n):');
    L.push('');
    const methods = STRATS.map(([s]) => s).filter((s) => R.results.some((r) => r.strategies[s]));
    L.push(table(['Method', ...groups.map((g) => g.key)], methods.map((m) => [m, ...groups.map((g) => {
      const rows = R.results.filter((r) => g.test(r.task) && r.strategies[m]).map((r) => r.strategies[m]);
      return rows.length ? `${rows.filter((x) => x.solved).length}/${rows.length}` : '-';
    })])));
    L.push('');
  }

  if (R.compare) {
    L.push(`## Before and after the fixes (${R.compare.label} -> ${R.label})`);
    L.push('');
    L.push('Same tasks, same machine, same repo commit. "Before" is the saved run named above.');
    L.push('');
    const rows = [];
    for (const m of ['brain-search', 'brain-context', 'brain-context-lean', 'brain-check']) {
      const ids = R.results.filter((r) => R.compare.byId.has(r.task.id) && r.strategies[m] && R.compare.byId.get(r.task.id).strategies[m]).map((r) => r.task.id);
      if (!ids.length) continue;
      const after = ids.map((id) => R.results.find((r) => r.task.id === id).strategies[m]);
      const before = ids.map((id) => R.compare.byId.get(id).strategies[m]);
      const A = aggregate(before), B = aggregate(after);
      rows.push([`**${m}**`, `${A.solvedN}/${A.n}`, `${B.solvedN}/${B.n}`, pct(A.hit1), pct(B.hit1), fx(A.ndcg5, 2), fx(B.ndcg5, 2), pct(A.recall), pct(B.recall), num(A.tokens), num(B.tokens), `${num(A.ms)} -> ${num(B.ms)} ms`]);
    }
    L.push(table(['Method', 'Solved before', 'after', 'hit@1 before', 'after', 'nDCG@5 before', 'after', 'Recall before', 'after', 'Tokens before', 'after', 'Cold latency'], rows));
    L.push('');
    L.push('Per task, rank of the first required file and recall (before -> after):');
    L.push('');
    L.push(table(['Task', 'brain-search', 'brain-context', 'brain-check'], R.results.filter((r) => R.compare.byId.has(r.task.id)).map((r) => {
      const prev = R.compare.byId.get(r.task.id);
      const cell = (m) => {
        if (!r.strategies[m] || !prev.strategies[m]) return '-';
        const f2 = (s) => (s.rank ? `#${s.rank}` : 'miss');
        return `${f2(prev.strategies[m])}/${pct(prev.strategies[m].recall)} -> ${f2(r.strategies[m])}/${pct(r.strategies[m].recall)}`;
      };
      return [r.task.id, cell('brain-search'), cell('brain-context'), cell('brain-check')];
    })));
    L.push('');
  }

  const misses = R.results.flatMap((r) => Object.entries(r.strategies).filter(([, s]) => !s.solved).map(([n, s]) => `${r.task.id}/${n} (recall ${pct(s.recall)}${n.startsWith('grep') && s.keywords ? `; keywords used: ${s.keywords}` : ''})`));
  L.push('## Where each method fell short');
  L.push('');
  L.push(misses.length ? misses.map((m) => `- ${m}`).join('\n') : 'No misses.');
  L.push('');
  L.push('## Limits of this benchmark');
  L.push('');
  L.push('- One repository (an Angular app) and a small number of tasks per round. The numbers are indicative, not a universal result; with 3 tasks per round a single task moves a round by 33 points.');
  L.push('- The without-brain agent is a fixed, mechanical strategy, not a model improvising. A smarter agent would choose better keywords; a weaker one, worse.');
  L.push('- Ground truth is my reading of the code. Required files drive recall; useful files are accepted extras.');
  L.push('- Latency excludes model time, which is driven by the token counts.');
  L.push('- Brain results come from a fresh index in a temporary folder; your real brain and the repo were not written to.');
  return L.join('\n');
}

/* ----------------------------------------------------------------- main */

(async () => {
  validateTasks();
  const facts = repoFacts();
  const brainHome = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-bench-'));
  const env = { BRAIN_HOME: brainHome };
  log(`[${LABEL}] repo ${REPO} @ ${facts.commit}; tasks ${path.basename(TASKS_FILE)} (${cfg.tasks.length})`);

  log('building index (full)...');
  const full = buildBrain(env, true);
  const diskBytes = dirSize(full.brainDir);
  log(`  ${(full.ms / 1000).toFixed(1)}s, ${full.stats.symbols} symbols, ${(diskBytes / 1048576).toFixed(1)} MB`);
  log('building index (no change)...');
  const noop = buildBrain(env, false);
  let incremental = null;
  if (!flag('--no-incremental')) {
    log('incremental update (one edited file, on a clone)...');
    incremental = incrementalUpdate();
  }

  log('warm process...');
  const w = run(process.execPath, [path.join(__dirname, 'warm-child.js'), REPO, TASKS_FILE, String(REPS_WARM)], { env, cwd: ROOT });
  if (w.code !== 0) throw new Error(`warm child failed: ${w.stderr}`);
  const warm = JSON.parse(w.stdout);
  const warmById = new Map(warm.tasks.map((t) => [t.id, t]));

  const results = [];
  for (const task of cfg.tasks) {
    log(`task ${task.id} (${task.stage || task.type})`);
    const strategies = { ...withoutBrain(task) };
    if (task.type === 'impact') {
      strategies['brain-check'] = brainCheck(task, env);
    } else {
      strategies['brain-search'] = brainSearch(task, env);
      strategies['brain-context'] = brainContext(task, env, []);
      strategies['brain-context-lean'] = brainContext(task, env, ['-k', '5', '--budget', '8000']);
    }
    results.push({ task: { id: task.id, type: task.type, stage: task.stage, query: task.query, must: task.must }, strategies, warm: warmById.get(task.id) });
  }

  let compare = null;
  if (COMPARE) {
    const prev = JSON.parse(fs.readFileSync(path.resolve(COMPARE), 'utf8'));
    compare = { label: prev.label || path.basename(COMPARE), results: prev.results, byId: new Map(prev.results.map((r) => [r.task.id, r])) };
  }

  const cpus = os.cpus();
  const R = {
    label: LABEL, stamp: STAMP, repo: REPO, tasksFile: TASKS_FILE, facts, tasks: cfg.tasks, results, warm, incremental,
    build: { full, noop, diskBytes },
    env: { cpu: cpus[0].model.trim(), cores: cpus.length, memGB: Math.round(os.totalmem() / 1073741824), node: process.version, platform: `${os.platform()} ${os.release()}` },
    assumptions: { charsPerToken: 4, pricePerMTokIn: PRICE_PER_MTOK_IN, repsCli: REPS_CLI, repsBaseline: REPS_BASE, repsWarm: REPS_WARM },
    compare
  };

  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const base = `bench-${LABEL}-${STAMP}`;
  fs.writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify({ ...R, compare: undefined }, null, 2));
  const md = buildReport(R);
  fs.writeFileSync(path.join(outDir, `${base}.md`), md);
  fs.rmSync(brainHome, { recursive: true, force: true });
  console.log(path.join(outDir, `${base}.md`));
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
