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
  radius (transitive callers) and whether any test covers it.
- \`brain build\` - re-run after making changes. It is incremental: only
  files whose content actually changed are re-parsed and re-embedded, so
  repeat runs on an already-indexed repo are fast. Add \`--force\` to rebuild
  from scratch, or \`--precise\` to also resolve TS/JS calls via a real
  language server if one is installed (see the project's README §7).

If you connect to this tool as an MCP server instead of a shell (\`brain mcp\`
/ \`brain-mcp\`), the same capabilities are available as \`brain_search\`,
\`brain_expand\`, \`brain_read\`, \`brain_context\`, \`brain_check\`, \`brain_build\`,
\`brain_list\` tools - use those directly rather than shelling out, if available.

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
  return outPath;
}

module.exports = { writeInstructions };
