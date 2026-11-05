'use strict';

// Builds a brain for one repo in a child process so peak memory is this build's own.
// usage: BRAIN_HOME=<dir> node build-child.js <repo> [--force]
const path = require('path');
const { buildBrain } = require('../src/buildBrain');

(async () => {
  const repo = process.argv[2];
  const force = process.argv.includes('--force');
  const t0 = process.hrtime.bigint();
  const log = [];
  // instructions:false - never write BRAIN-INSTRUCTIONS.md into the repo being measured.
  const res = await buildBrain(path.resolve(repo), { force, instructions: false, onProgress: (m) => log.push(m) });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const ru = process.resourceUsage();
  process.stdout.write(JSON.stringify({
    ms, maxRssMB: Math.round(ru.maxRSS / 1024), userCpuMs: Math.round(ru.userCPUTime / 1000), systemCpuMs: Math.round(ru.systemCPUTime / 1000),
    stats: res.stats, brainDir: res.brainDir, log: log.slice(-6)
  }));
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
