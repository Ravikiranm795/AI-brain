'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BRAIN_BIN = path.join(ROOT, 'bin', 'brain.js');

// One estimator for every method, so ratios between them are fair. Real
// tokenizers differ by roughly +/-20% on code and JSON, but they differ the
// same way for both sides of each comparison.
const CHARS_PER_TOKEN = 4;
const tokens = (text) => Math.ceil(String(text).length / CHARS_PER_TOKEN);

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);
function percentile(a, p) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
}
const median = (a) => percentile(a, 0.5);

/** Runs a command and returns wall time with its output. */
function run(cmd, args, opts = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

function runBrain(args, env) {
  return run(process.execPath, [BRAIN_BIN, ...args], { env, cwd: ROOT });
}

module.exports = { ROOT, BRAIN_BIN, CHARS_PER_TOKEN, tokens, norm, sum, mean, median, percentile, run, runBrain };
