'use strict';

const path = require('path');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const query = require('./query');
const { buildContext } = require('./context');
const { buildBrain } = require('./buildBrain');
const { getRepoBrainDir, getRepoId, listAllRepoBrains, summarizeManifest, getBrainsHome } = require('./config');
const { StoreCache } = require('./storeCache');
const { SessionState } = require('./session');

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function resolveRoot(p) {
  return path.resolve(p || process.cwd());
}

/**
 * Exposes the same capabilities the CLI has (search/expand/read/context/
 * check/build/list) as MCP tools over stdio, plus session memory so a
 * repeated read of the same code isn't resent. Purely additive - the CLI
 * commands in bin/brain.js are untouched and work identically whether or
 * not this server is running.
 */
function createServer() {
  const server = new McpServer({ name: 'project-brain', version: '1.0.0' });
  const storeCache = new StoreCache();
  const session = new SessionState();

  server.registerTool(
    'brain_search',
    {
      title: 'Semantic search',
      description: "Semantic search over a repo's brain. Returns symbols (functions/classes/etc) ranked by relevance.",
      inputSchema: {
        path: z.string().optional().describe('Repo root (default: current directory)'),
        query: z.string().describe('What you are looking for, in plain language'),
        k: z.number().int().positive().optional().describe('Number of results (default 10)'),
        kind: z.string().optional().describe('Filter by symbol kind (function, method, class, test, ...)'),
        ext: z.string().optional().describe('Filter by file extension, e.g. .py')
      }
    },
    async ({ path: p, query: q, k, kind, ext }) => {
      const rootDir = resolveRoot(p);
      const { store, vectorIndex } = storeCache.get(getRepoBrainDir(rootDir));
      const results = await query.search(rootDir, q, k || 10, { kind, ext }, { store, vectorIndex });
      return textResult({ results });
    }
  );

  server.registerTool(
    'brain_expand',
    {
      title: 'Expand callers/callees',
      description: 'Get callers/callees of a symbol, N hops out. For a class/interface, results are unioned across its member methods (a call almost never attributes to the class itself) - check classAggregation.unresolved before trusting an empty result: true means there were zero discoverable members (e.g. a TS interface) and nothing was actually resolved, not that the class has no callers.',
      inputSchema: {
        path: z.string().optional(),
        symbolId: z.number().int().describe('Symbol id from a brain_search/brain_context result'),
        hops: z.number().int().positive().optional().describe('Hop count (default 1)'),
        limit: z.number().int().positive().optional().describe('Max related symbols to return (default 60)'),
        offset: z.number().int().nonnegative().optional().describe('Pagination offset into the related list (default 0)')
      }
    },
    async ({ path: p, symbolId, hops, limit, offset }) => {
      const rootDir = resolveRoot(p);
      const { store } = storeCache.get(getRepoBrainDir(rootDir));
      const result = query.expand(rootDir, symbolId, hops || 1, { store });
      if (!result) return textResult({ error: `No symbol with id ${symbolId}` });
      const { related, classAggregation } = result;
      // Paged for the same reason brain_check's blast radius is: a 2-hop
      // expand on a busy symbol has come back at ~300KB, which no caller can
      // use and every caller pays for.
      const start = offset || 0;
      const max = limit || 60;
      const page = related.slice(start, start + max);
      return textResult({
        related: page,
        total: related.length,
        returned: page.length,
        offset: start,
        truncated: related.length > start + page.length,
        ...(classAggregation ? { classAggregation } : {})
      });
    }
  );

  server.registerTool(
    'brain_read',
    {
      title: 'Read exact line range',
      description: 'Read an exact line range from a file - no full-file or directory scan.',
      inputSchema: {
        path: z.string().optional(),
        relPath: z.string().describe('File path relative to the repo root'),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        force: z.boolean().optional().describe('Resend content even if already shown this session'),
        dedupe: z.boolean().optional().describe('Suppress content already returned this session (default false - see the server note on shared sessions)')
      }
    },
    async ({ path: p, relPath, startLine, endLine, force, dedupe }) => {
      const rootDir = resolveRoot(p);
      // Dedup is OPT-IN. One stdio server process is shared by every agent on
      // the other end - subagents included - but SessionState is per process,
      // so "already shown" was being answered for a different agent than the
      // one asking. A parallel subagent would get `content: null,
      // alreadyShown: true` for a range it had never seen and had no way to
      // know it was being lied to. A duplicate read wastes tokens; a false
      // alreadyShown silently removes code from an agent's view, which is
      // strictly worse.
      const alreadyShown = !!dedupe && !force && session.isRangeShown(relPath, startLine, endLine);
      if (alreadyShown) {
        return textResult({ content: null, alreadyShown: true, relPath, startLine, endLine });
      }
      let content;
      try {
        content = query.read(rootDir, relPath, startLine, endLine);
      } catch (err) {
        // Path-traversal / invalid-range rejections from query.read() - see
        // its guard clauses - surfaced as a clean tool error instead of an
        // uncaught exception.
        return textResult({ error: err.message });
      }
      session.markRangeShown(relPath, startLine, endLine);
      return textResult({ content, alreadyShown: false, relPath, startLine, endLine });
    }
  );

  server.registerTool(
    'brain_context',
    {
      title: 'One-shot context assembly',
      description: 'search + expand + read, budget-bounded, assembled into one ready-to-use bundle for a task.',
      inputSchema: {
        path: z.string().optional(),
        task: z.string().describe('The task you are working on, in plain language'),
        k: z.number().int().positive().optional(),
        hops: z.number().int().positive().optional(),
        budgetChars: z.number().int().positive().optional(),
        kind: z.string().optional(),
        ext: z.string().optional(),
        dedupe: z.boolean().optional().describe('Suppress code already returned this session (default false - see the server note on shared sessions)')
      }
    },
    async ({ path: p, task, k, hops, budgetChars, kind, ext, dedupe }) => {
      const rootDir = resolveRoot(p);
      const { store, vectorIndex } = storeCache.get(getRepoBrainDir(rootDir));
      const result = await buildContext(rootDir, task, { k, hops, budgetChars, kind, ext }, { store, vectorIndex });

      // Already-shown items are demoted to signature-only first, ahead of
      // hop distance, since re-sending code the agent already has is the
      // most wasteful use of the char budget.
      // Opt-in for the same reason brain_read's is - see the note there. One
      // server process serves every agent on the connection, so suppressing
      // code "already shown" can blank out code the asking agent has never
      // seen.
      if (dedupe) {
        for (const item of [...result.primary, ...result.neighbors]) {
          if (item.symbolId && session.isSymbolShown(item.symbolId) && item.code) {
            item.code = null;
            item.alreadyShown = true;
          } else {
            item.alreadyShown = false;
          }
        }
        for (const item of [...result.primary, ...result.neighbors]) {
          if (item.symbolId) session.markSymbolShown(item.symbolId);
          if (item.path && item.startLine && item.endLine) session.markRangeShown(item.path, item.startLine, item.endLine);
        }
      }

      return textResult(result);
    }
  );

  server.registerTool(
    'brain_check',
    {
      title: 'Pre-edit impact + test-coverage check',
      description:
        "Blast radius (transitive callers) and test coverage for a symbol, before editing it. risk is one of: 'covered' (a test " +
        "reaches it through high-confidence edges), 'untested' (the walk ran and found none), 'incomplete' (some file that " +
        "mentions this symbol is not fully indexed - see indexGaps; the answer is MISSING callers, so grep those files), or " +
        "'unresolved' (a class/interface with zero discoverable members - the walk never ran). Only 'covered' and 'untested' " +
        'are actual findings; the other two mean "unknown", never "safe". Each blastRadius entry carries confidence: high ' +
        '(receiver-type-resolved, uniquely-named, or LSP-resolved) or low (matched only by a shared method name - treat as a lead, not a fact).',
      inputSchema: {
        path: z.string().optional(),
        symbolId: z.number().int(),
        hops: z.number().int().positive().optional(),
        testHops: z.number().int().positive().optional(),
        maxCallers: z.number().int().positive().optional().describe('Max blast-radius entries to return (default 40; the summary always reports full totals)')
      }
    },
    async ({ path: p, symbolId, hops, testHops, maxCallers }) => {
      const rootDir = resolveRoot(p);
      const { store } = storeCache.get(getRepoBrainDir(rootDir));
      const result = query.check(rootDir, symbolId, { hops, testHops, maxCallers }, { store });
      if (!result) return textResult({ error: `No symbol with id ${symbolId}` });
      return textResult(result);
    }
  );

  server.registerTool(
    'brain_build',
    {
      title: 'Build/update the brain',
      description: 'Build/update the brain for a repo in one incremental pass.',
      inputSchema: {
        path: z.string().optional(),
        force: z.boolean().optional(),
        precise: z.boolean().optional().describe('Also resolve TS/JS calls via a real language server, if installed (slower, opt-in)'),
        instructions: z.boolean().optional().describe('Write/update BRAIN-INSTRUCTIONS.md at the repo root (default true)')
      }
    },
    async ({ path: p, force, precise, instructions }) => {
      const rootDir = resolveRoot(p);
      const log = [];
      const result = await buildBrain(rootDir, {
        force: !!force,
        precise: !!precise,
        instructions: instructions !== false,
        onProgress: (msg) => log.push(msg)
      });
      // Must evict: buildBrain opens its own GraphStore/VectorIndex
      // internally, independent of whatever this server has cached - a
      // stale cached VectorIndex would otherwise keep serving pre-build
      // data to every brain_search/brain_context call for this repo.
      storeCache.evict(result.brainDir);
      return textResult({ ...result, log });
    }
  );

  server.registerTool(
    'brain_list',
    {
      title: 'List indexed repos',
      description:
        "By default, summarizes just THIS repo's own brain (path defaults to the current directory) - not every repo ever " +
        'indexed on the machine. Pass all:true to list every indexed repo instead, paginated via limit/offset. Every entry ' +
        'is a lightweight summary (rootDir/builtAt/fileCount/stats), never the full per-file manifest.',
      inputSchema: {
        path: z.string().optional().describe('Repo root to summarize (default: current directory). Ignored when all is true.'),
        all: z.boolean().optional().describe('List every repo indexed on this machine instead of just this one'),
        limit: z.number().int().positive().optional().describe('Max repos to return when all is true (default 20)'),
        offset: z.number().int().nonnegative().optional().describe('Pagination offset when all is true (default 0)')
      }
    },
    async ({ path: p, all, limit, offset }) => {
      const brainsHome = getBrainsHome();
      if (!all) {
        const rootDir = resolveRoot(p);
        const repoId = getRepoId(rootDir);
        const brainDir = getRepoBrainDir(rootDir);
        const summary = summarizeManifest(path.join(brainDir, 'manifest.json'));
        const { total } = listAllRepoBrains({ limit: 0 });
        return textResult({
          brainsHome,
          repo: summary
            ? { repoId, dir: brainDir, built: true, ...summary }
            : { repoId, dir: brainDir, built: false, note: 'No brain built yet for this path - run brain_build first.' },
          otherReposIndexedOnThisMachine: Math.max(0, total - (summary ? 1 : 0)),
          note: 'Pass all:true to list every repo indexed on this machine (paginated).'
        });
      }
      const { repos, total } = listAllRepoBrains({ limit: limit || 20, offset: offset || 0 });
      return textResult({ brainsHome, repos, total, returned: repos.length, offset: offset || 0 });
    }
  );

  const closeAll = () => storeCache.closeAll();
  process.on('exit', closeAll);
  process.on('SIGINT', () => { closeAll(); process.exit(0); });
  process.on('SIGTERM', () => { closeAll(); process.exit(0); });

  return server;
}

async function start() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

module.exports = { createServer, start };
