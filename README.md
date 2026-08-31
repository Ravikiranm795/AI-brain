# Project Brain

A persistent, incremental code-intelligence "brain" for AI coding agents
(Claude Code, Amazon Q, or anyone driving from a terminal). It builds one
queryable symbol graph + local semantic index per repo, so an agent never
has to re-scan the whole project on every task.

- **One command** does the whole pipeline: walk → parse → graph → embed → vector index.
- **Incremental**: re-running only touches files that actually changed (hash-diff), so repeat builds on an already-indexed repo are near-instant.
- **Multi-repo**: every repo gets its own isolated brain folder in one central store — nothing leaks between projects.
- **Multi-agent**: it's a plain CLI, so Claude Code, Amazon Q, or anything else that can run a shell command can use it the same way.
- **Fully local**: parsing (tree-sitter), the graph (SQLite), and the vector search all run on your machine. No cloud API calls, no data leaves your computer. (The embedding model downloads once, ~90MB, on first use — after that it's fully offline too.)
- **Visual**: `brain visualize` produces a static HTML graph you can open in a browser, with a repo dropdown and a search box.

---

## 1. Install (do this once)

**Requirements:** Node.js 18+ (check with `node --version`).

1. Unzip this project anywhere permanent, e.g. `C:\tools\project-brain` on Windows, or `~/tools/project-brain` on Mac/Linux.
2. Open a terminal in that folder.
3. Install dependencies and register the global `brain` command:

```bash
cd project-brain
npm install
npm install -g .
```

4. Verify it's on your PATH:

```bash
brain --version
```

If `brain` isn't found after step 3 on Windows, close and reopen your terminal (PATH changes need a fresh shell), or use `npx brain <command>` from inside this folder as a fallback.

### Where the brain data lives

By default all repo brains are stored centrally at:

- Windows: `C:\Users\<you>\.brains`
- Mac/Linux: `~/.brains`

To use a specific drive/folder instead (e.g. your C: drive root as you mentioned), set an environment variable once:

```powershell
# Windows (PowerShell, run once as your user)
setx BRAIN_HOME C:\brains
```

```bash
# Mac/Linux (add to ~/.bashrc or ~/.zshrc)
export BRAIN_HOME=$HOME/brains
```

Nothing else changes — every repo still gets its own isolated subfolder inside `BRAIN_HOME`.

---

## 2. Use it on a repo

From inside any project's root folder:

```bash
brain build
```

This does everything in one pass:
1. Walks the project once (respects `.gitignore`, skips `node_modules`, `.git`, `dist`, `build`, etc.)
2. Hashes every file and diffs against the last build (first run = everything is "added")
3. Parses changed/new files with tree-sitter → extracts functions, classes, imports, call edges
4. Builds/updates the SQLite dependency graph
5. Generates local embeddings for new/changed symbols and updates the vector index
6. Writes `BRAIN-INSTRUCTIONS.md` into the repo root — this is what tells Claude Code / Amazon Q not to rescan the project and to use the brain commands instead

Run it again anytime after making changes — unchanged files are skipped automatically, so it's fast:

```bash
brain build
```

### Querying the brain directly

```bash
# Semantic search - find relevant code by describing the task
brain search "retry logic for payment webhook handling" -k 10

# Get callers/callees of a symbolId returned by search
brain expand 42 --hops 1

# Read an exact line range - no full-file or folder scan
brain read src/payments.js 12 30
```

All commands accept `--path <repo-dir>` if you're not running from inside the repo.

### Multi-repo

Just run `brain build` inside each repo separately — each gets its own isolated folder under `BRAIN_HOME`, keyed by that repo's path, so independent projects (like your separate front-end report repos) never mix data.

See everything currently indexed:

```bash
brain list
```

---

## 3. Wiring it into Claude Code / Amazon Q

After `brain build` runs once in a repo, it drops `BRAIN-INSTRUCTIONS.md` at
the repo root. Point your agent at it (most agents auto-read root-level
`.md` instruction files, or you can paste its contents into your system/
project prompt). It tells the agent:

- Don't `grep`/`readdir`/rescan the project.
- Use `brain search`, `brain expand`, `brain read` instead.
- Run `brain build` once after finishing edits, so the brain stays current for the next session.

Since it's a plain terminal command, this works identically whether it's
Claude Code or Amazon Q driving — whichever agent has shell access can call
`brain`. For an agent without file-system/shell access (e.g. a plain chat
model doing analysis only), run the query yourself and paste the JSON
output in.

---

## 4. Visualizing the graph

```bash
brain visualize --out brain-graph.html --open
```

Generates a single static HTML file covering **every** repo currently
indexed (not just the current one), with:
- A dropdown at the top to switch between repos
- Nodes = functions/classes/methods, colored by kind
- Edges = call relationships
- A search box that highlights matching nodes and their connections

Regenerate it (`brain visualize`) any time after a `brain build` to refresh it with the latest graph.

---

## 5. How the data is stored (for reference)

```
<BRAIN_HOME>/
  <repo-slug>-<hash>/        # one folder per repo, fully isolated
    manifest.json             # file hashes, used for incremental diffing
    graph.sqlite               # files, symbols, edges, chunks tables
    vectors.bin                 # flat Float32Array of symbol embeddings
    vectors.meta.json            # symbol ids matching vectors.bin order
```

Nothing is ever written back into your source repo except the one
`BRAIN-INSTRUCTIONS.md` file — the actual index lives entirely outside the
project.

## 6. Known simplifications (by design, upgradeable later)

- **Call-edge resolution is name-based**, not full scope/type resolution — if two files each have a function called `validate`, a call to `validate()` may link to both. Good enough for "what calls this / what does this call" style navigation; a real symbol resolver could replace this later without changing the storage schema.
- **Vector search is a flat, brute-force cosine index** (pure JS, no native ANN library) — chosen for zero install risk across OSes at the scale this targets (tens of thousands of symbols per repo). If a single repo grows past ~200k symbols, swap `src/vectorIndex.js` for a proper HNSW library (e.g. `usearch`) without touching anything else.
- **Languages supported today: JavaScript, JSX, TypeScript, TSX, Java.** Adding another language means adding its tree-sitter grammar package and a case in `src/parser.js`'s `languageFor()`.

## 7. Troubleshooting

- **`npm install` fails on `better-sqlite3` or `tree-sitter`** — these compile a small native addon. Make sure you have a C++ build toolchain: on Windows, `npm install -g windows-build-tools` (or install "Desktop development with C++" via Visual Studio Build Tools); on Mac, run `xcode-select --install`.
- **First `brain build` seems slow / needs internet** — that's the one-time ~90MB embedding model download. Subsequent runs are fully offline.
- **`brain` command not found after global install** — open a new terminal window (PATH refresh), or run via `npx brain <command>` from inside the project-brain folder.
