#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');

const { buildBrain } = require('../src/buildBrain');
const query = require('../src/query');
const { generateVisualizationHtml } = require('../src/visualize');
const { generateVisualizationHtml2 } = require('../src/visualize2');
const { generateVisualizationHtml3 } = require('../src/visualize3');
const { listAllRepoBrains, getBrainsHome, getRepoBrainDir } = require('../src/config');

const program = new Command();

program
  .name('brain')
  .description('Persistent, incremental code-intelligence memory for AI coding agents')
  .version('1.0.0');

program
  .command('build')
  .description('Build/update the brain for the current repo in ONE pass (incremental after first run)')
  .option('-p, --path <dir>', 'repo root', '.')
  .option('-f, --force', 'ignore existing manifest and rebuild everything from scratch', false)
  .action(async (opts) => {
    const root = path.resolve(opts.path);
    if (!fs.existsSync(root)) {
      console.error(`No such directory: ${root}`);
      process.exit(1);
    }
    console.log(`Building brain for ${root} ...`);
    const t0 = Date.now();
    const result = await buildBrain(root, {
      force: opts.force,
      onProgress: (msg) => console.log(msg)
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nBrain ready in ${secs}s -> ${result.brainDir}`);
    console.log(`Symbols: ${result.stats.symbols}  Vectors: ${result.stats.vectors}`);
    console.log(`Wrote BRAIN-INSTRUCTIONS.md at repo root - point your agent at it.`);
  });

program
  .command('search <queryText>')
  .description('Semantic search over the current repo\'s brain')
  .option('-p, --path <dir>', 'repo root', '.')
  .option('-k, --top <n>', 'number of results', '10')
  .action(async (queryText, opts) => {
    const results = await query.search(path.resolve(opts.path), queryText, Number(opts.top));
    console.log(JSON.stringify(results, null, 2));
  });

program
  .command('expand <symbolId>')
  .description('Get callers/callees of a symbol, N hops out')
  .option('-p, --path <dir>', 'repo root', '.')
  .option('--hops <n>', 'hop count', '1')
  .action((symbolId, opts) => {
    const results = query.expand(path.resolve(opts.path), symbolId, Number(opts.hops));
    console.log(JSON.stringify(results, null, 2));
  });

program
  .command('read <relPath> <startLine> <endLine>')
  .description('Read an exact line range from a file - no full-file or directory scan')
  .option('-p, --path <dir>', 'repo root', '.')
  .action((relPath, startLine, endLine, opts) => {
    const content = query.read(path.resolve(opts.path), relPath, startLine, endLine);
    console.log(content);
  });

program
  .command('visualize')
  .description('Generate the HTML graph viewer covering all indexed repos')
  .option('-o, --out <file>', 'output HTML path', path.join(process.cwd(), 'brain-graph.html'))
  .option('--open', 'open in default browser after generating', false)
  .action(async (opts) => {
    const outPath = generateVisualizationHtml(path.resolve(opts.out));
    console.log(`Wrote ${outPath}`);
    if (opts.open) {
      const open = (await import('open')).default;
      await open(outPath);
    }
  });

program
  .command('visualize2')
  .description('Generate the galaxy-style HTML graph viewer covering all indexed repos')
  .option('-o, --out <file>', 'output HTML path', path.join(process.cwd(), 'brain-graph-galaxy.html'))
  .option('--open', 'open in default browser after generating', false)
  .action(async (opts) => {
    const outPath = generateVisualizationHtml2(path.resolve(opts.out));
    console.log(`Wrote ${outPath}`);
    if (opts.open) {
      const open = (await import('open')).default;
      await open(outPath);
    }
  });

program
  .command('visualize3')
  .description('Generate the radial graph analysis viewer covering all indexed repos')
  .option('-o, --out <file>', 'output HTML path', path.join(process.cwd(), 'brain-graph-radial.html'))
  .option('--open', 'open in default browser after generating', false)
  .action(async (opts) => {
    const outPath = generateVisualizationHtml3(path.resolve(opts.out));
    console.log(`Wrote ${outPath}`);
    if (opts.open) {
      const open = (await import('open')).default;
      await open(outPath);
    }
  });

program
  .command('list')
  .description('List every repo currently indexed in the central brains store')
  .action(() => {
    console.log(`Brains home: ${getBrainsHome()}\n`);
    const repos = listAllRepoBrains();
    if (!repos.length) {
      console.log('No repos indexed yet. Run "brain build" inside a repo.');
      return;
    }
    for (const r of repos) {
      const builtAt = r.manifest ? r.manifest.builtAt : 'unknown';
      const rootDir = r.manifest ? r.manifest.rootDir : 'unknown';
      console.log(`- ${r.repoId}\n    root: ${rootDir}\n    built: ${builtAt}\n    dir:  ${r.dir}`);
    }
  });

program.parse(process.argv);
