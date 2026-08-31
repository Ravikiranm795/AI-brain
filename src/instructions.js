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

- \`brain search "<what you're looking for>"\` - semantic search over
  functions/classes, returns exact file + line ranges.
- \`brain expand <symbolId> --hops 1\` - get callers/callees of a symbol
  returned by search.
- \`brain read <path> <startLine> <endLine>\` - read only that exact slice of
  a file, instead of opening the whole file.
- \`brain build\` - re-run after making changes. It is incremental: only
  files whose content actually changed are re-parsed and re-embedded, so
  repeat runs on an already-indexed repo are fast.

## Recommended agent workflow

1. \`brain search "<task description>"\` to find the relevant starting points.
2. \`brain expand <symbolId>\` on the top hits to see what calls them / what
   they call, for context before editing.
3. \`brain read <path> <start> <end>\` to pull only the exact code needed.
4. After making edits, run \`brain build\` once before finishing the task so
   the brain reflects the new state of the repo for the next session.

Repo id: \`${repoId}\`
`;

  const outPath = path.join(rootDir, 'BRAIN-INSTRUCTIONS.md');
  fs.writeFileSync(outPath, content);
  return outPath;
}

module.exports = { writeInstructions };
