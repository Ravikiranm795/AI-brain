'use strict';

const fs = require('fs');
const path = require('path');

function writeInstructions(rootDir, brainDir, repoId) {
  const content = `# Brain Instructions (auto-generated - do not hand-edit)

This repo has a pre-built code-intelligence index ("the brain") stored outside
this repo at:

\`\`\`
${brainDir}
\`\`\`

## Rule for any AI coding agent working in this repo

**Do not re-scan, \`grep\`, or \`readdir\` this project's files and folders to find
code.** The brain already has the file list, every function/class location,
the import/call dependency graph, and a semantic vector index. Query it
instead - it is faster and always current after a rebuild.

## Commands

Run these from a terminal at the root of this repo (or any subfolder):

- \`brain context "<task description>"\` - the recommended starting point.
  Does search + expand + read in one call and returns a ready-to-use,
  budget-bounded bundle of the most relevant code plus its callers/callees.
- \`brain search "<what you're looking for>"\` - semantic search over
  functions/classes, returns exact file + line ranges (use this directly,
  instead of \`context\`, when you want to control expansion/budget yourself).
- \`brain expand <symbolId> --hops 1\` - get callers/callees of a symbol
  returned by search.
- \`brain read <path> <startLine> <endLine>\` - read only that exact slice of
  a file, instead of opening the whole file.
- \`brain check <symbolId>\` - before editing something: reports its blast
  radius (transitive callers) and whether any test covers it. \`risk\` is one of:
  - \`covered\` - a test reaches it through high-confidence edges.
  - \`untested\` - the walk ran and genuinely found none.
  - \`incomplete\` - a file that mentions this symbol isn't fully indexed
    (see \`indexGaps\`), so callers are **missing** from this answer. Grep
    those files directly.
  - \`unresolved\` - a class/interface with no discoverable members; the walk
    never ran at all.

  **Only \`covered\` and \`untested\` are findings. \`incomplete\` and
  \`unresolved\` mean "unknown" and must never be read as "safe to change".**
  Each blast-radius entry also carries \`confidence\`: \`high\` (the call was
  resolved through the receiver's type, a repo-unique name, or a language
  server) or \`low\` (matched only by a shared method name - a lead to verify,
  not a fact).
- **Check the build's "Index health" line before trusting a negative
  answer.** If it reports degraded files (parse failures or size skips),
  those files are not in the symbol graph, and an empty search/blast-radius
  result may simply mean "brain couldn't see it". \`brain check\` flags this
  per-symbol as \`risk: "incomplete"\`, but a plain \`brain search\` miss won't.
- \`brain build\` - re-run after making changes. It is incremental: only
  files whose content actually changed are re-parsed and re-embedded, so
  repeat runs on an already-indexed repo are fast. Add \`--force\` to rebuild
  from scratch, or \`--precise\` to also resolve TS/JS calls via a real
  language server if one is installed (see the project's README §7).

If you connect to this tool as an MCP server instead of a shell (\`brain mcp\`
/ \`brain-mcp\`), the same capabilities are available as \`brain_search\`,
\`brain_expand\`, \`brain_read\`, \`brain_context\`, \`brain_check\`, \`brain_build\`,
\`brain_list\` tools - use those directly rather than shelling out, if available.

**Latency note**: each CLI invocation above is a fresh process that pays a
one-time cost (~1.5-4+s) to load the local embedding model before it does
anything else. The MCP server pays that cost once on its first call, then
serves everything after in tens/low hundreds of milliseconds - prefer it
over shelling out when you're calling this more than once or twice.

## Recommended agent workflow

1. \`brain context "<task description>"\` to gather relevant code + its
   immediate neighborhood in one call. Fall back to \`brain search\` +
   \`brain expand\` + \`brain read\` individually when you need finer control.
2. Before editing a symbol found this way, run \`brain check <symbolId>\` to
   see what depends on it and whether it's tested.
3. After making edits, run \`brain build\` once before finishing the task so
   the brain reflects the new state of the repo for the next session.

Repo id: \`${repoId}\`
`;

  const outPath = path.join(rootDir, 'BRAIN-INSTRUCTIONS.md');
  fs.writeFileSync(outPath, content);
  ensureGitignoreEntry(rootDir);
  return outPath;
}

/**
 * BRAIN-INSTRUCTIONS.md is regenerated on every build and isn't meant to be
 * committed - if the target repo already has a .gitignore, add an entry for
 * it automatically so a `brain build` doesn't leave untracked-file noise in
 * `git status` for every client repo it touches. Never creates a
 * .gitignore that didn't already exist - that's a bigger decision than this
 * tool should make on a client's behalf.
 */
function ensureGitignoreEntry(rootDir) {
  const gitignorePath = path.join(rootDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return;

  const existing = fs.readFileSync(gitignorePath, 'utf8');
  const alreadyIgnored = existing
    .split('\n')
    .map((l) => l.trim())
    .includes('BRAIN-INSTRUCTIONS.md');
  if (alreadyIgnored) return;

  const separator = existing.length && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(gitignorePath, `${separator}\n# Auto-generated by \`brain build\` - see project-brain\nBRAIN-INSTRUCTIONS.md\n`);
}

module.exports = { writeInstructions };
