#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');

const { buildBrain } = require('../src/buildBrain');
const query = require('../src/query');
const { buildContext } = require('../src/context');
const { generateVisualizationHtml } = require('../src/visualize');
const { generateVisualizationHtml2 } = require('../src/visualize2');
const { generateVisualizationHtml3 } = require('../src/visualize3');
const { generateExploreHtml } = require('../src/visualizeExplore');
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
  .option('--precise', 'also resolve TS/JS calls via a real language server, if installed (slower, opt-in)', false)
  .option('--no-instructions', 'skip writing/updating BRAIN-INSTRUCTIONS.md at the repo root')
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
      precise: opts.precise,
      instructions: opts.instructions,
      onProgress: (msg) => console.log(msg)
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nBrain ready in ${secs}s -> ${result.brainDir}`);
    console.log(`Symbols: ${result.stats.symbols}  Vectors: ${result.stats.vectors}`);
    if (opts.instructions) console.log(`Wrote BRAIN-INSTRUCTIONS.md at repo root - point your agent at it.`);
  });

program
  .command('search <queryText>')
  .description('Semantic search over the current repo\'s brain')
  .option('-p, --path <dir>', 'repo root', '.')
  .option('-k, --top <n>', 'number of results', '10')
  .option('--kind <kind>', 'filter results by symbol kind (function, method, class, test, ...)')
  .option('--ext <ext>', 'filter results by file extension (e.g. .py)')
  .action(async (queryText, opts) => {
    const results = await query.search(path.resolve(opts.path), queryText, Number(opts.top), {
      kind: opts.kind,
      ext: opts.ext
    });
    console.log(JSON.stringify(results, null, 2));
  });

program
  .command('expand <symbolId>')
  .description('Get callers/callees of a symbol, N hops out')
  .option('-p, --path <dir>', 'repo root', '.')
  .option('--hops <n>', 'hop count', '1')
  .action((symbolId, opts) => {
    const results = query.expand(path.resolve(opts.path), symbolId, Number(opts.hops));
    if (!results) {
      console.error(`No symbol with id ${symbolId}`);
      process.exit(1);
    }
    console.log(JSON.stringify(results, null, 2));
  });

program
  .command('check <symbolId>')
  .description('Blast-radius + test-coverage report for a symbol, before you edit it')
  .option('-p, --path <dir>', 'repo root', '.')
  .option('--hops <n>', 'blast-radius hop depth', '3')
  .option('--test-hops <n>', 'max hops to search for covering tests', '6')
  .action((symbolId, opts) => {
    const result = query.check(path.resolve(opts.path), symbolId, {
      hops: Number(opts.hops),
      testHops: Number(opts.testHops)
    });
    if (!result) {
      console.error(`No symbol with id ${symbolId}`);
      process.exit(1);
    }
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('context <taskText>')
  .description('One-shot context assembly: search + expand + read, budget-bounded, in a single call')
  .option('-p, --path <dir>', 'repo root', '.')
  .option('-k, --top <n>', 'primary search hits', '8')
  .option('--hops <n>', 'expand hop count', '1')
  .option('--budget <chars>', 'char budget for included code', '24000')
  .option('--kind <kind>', 'filter primary hits by symbol kind')
  .option('--ext <ext>', 'filter primary hits by file extension')
  .action(async (taskText, opts) => {
    const result = await buildContext(path.resolve(opts.path), taskText, {
      k: Number(opts.top),
      hops: Number(opts.hops),
      budgetChars: Number(opts.budget),
      kind: opts.kind,
      ext: opts.ext
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('read <relPath> <startLine> <endLine>')
  .description('Read an exact line range from a file - no full-file or directory scan')
  .option('-p, --path <dir>', 'repo root', '.')
  .action((relPath, startLine, endLine, opts) => {
    try {
      const content = query.read(path.resolve(opts.path), relPath, startLine, endLine);
      console.log(content);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
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
  .command('explore')
  .description('Generate the focused-neighborhood graph viewer (search a symbol, see just its neighborhood)')
  .option('-o, --out <file>', 'output HTML path', path.join(process.cwd(), 'brain-explore.html'))
  .option('--open', 'open in default browser after generating', false)
  .action(async (opts) => {
    const outPath = generateExploreHtml(path.resolve(opts.out));
    console.log(`Wrote ${outPath}`);
    if (opts.open) {
      const open = (await import('open')).default;
      await open(outPath);
    }
  });

program
  .command('mcp')
  .description('Start the brain MCP server (stdio) - exposes search/expand/read/context/check/build/list as MCP tools')
  .action(() => {
    require('../src/mcpServer').start();
  });

program
  .command('list')
  .description('List every repo currently indexed in the central brains store')
  .action(() => {
    console.log(`Brains home: ${getBrainsHome()}\n`);
    const { repos, total } = listAllRepoBrains();
    if (!total) {
      console.log('No repos indexed yet. Run "brain build" inside a repo.');
      return;
    }
    for (const r of repos) {
      console.log(
        `- ${r.repoId}\n    root: ${r.rootDir || 'unknown'}\n    built: ${r.builtAt || 'unknown'}\n` +
        `    files: ${r.fileCount ?? 'unknown'}\n    dir:  ${r.dir}`
      );
    }
  });

program.parse(process.argv);
