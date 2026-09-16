# Project Brain

A persistent, incremental code-intelligence "brain" for AI coding agents
(Claude Code, Amazon Q, or anyone driving from a terminal). It builds one
queryable symbol graph + local semantic index per repo, so an agent never
has to re-scan the whole project on every task — and it gives that agent
higher-level tools (one-shot context assembly, pre-edit safety checks, a
live MCP server) on top of the raw graph, not just search.

- **One command** does the whole pipeline: walk → parse → graph → embed → vector index.
- **Hybrid search**: `brain search` fuses semantic (embedding) search with a lexical FTS5 index over full symbol bodies, so an exact identifier or string literal buried inside a function still surfaces — see §10.
- **Incremental**: re-running only touches files that actually changed (hash-diff), so repeat builds on an already-indexed repo are near-instant. `--force` truly rebuilds from scratch.
- **Multi-repo**: every repo gets its own isolated brain folder in one central store — nothing leaks between projects.
- **Multi-agent**: it's a plain CLI, so Claude Code, Amazon Q, or anything else that can run a shell command can use it the same way — and it's also a live **MCP server** for agents that speak MCP natively.
- **Agent-native**: `brain context` does search → expand → read → budget-bounded assembly in one call, instead of an agent chaining three commands and reasoning about symbol IDs itself.
- **Safety-aware**: `brain check` reports a symbol's blast radius (transitive callers) and whether any test covers it, before you edit it.
- **Broad language support**: full function/class/call-graph parsing for JavaScript, TypeScript, Java, Python, C#, and PHP — covering Angular/React (JS/TS), Java, Python, .NET, and PHP projects at the same depth. Everything else (HTML, Go, Ruby, C/C++, Rust, Elixir, and ~40 more extensions, plus config/build files like `package.json`, `pom.xml`, `.csproj`, `application.properties`, `appsettings.json`) is still walked, hashed, and semantically searchable via a whole-file fallback — see §9 for the full list.
- **Optionally precise**: `brain build --precise` layers real go-to-definition resolution (via a language server) on top of the default name-based heuristic for TypeScript/JavaScript, when one is installed.
- **Fully local**: parsing (tree-sitter), the graph (SQLite), the vector search, and the MCP server all run on your machine. No cloud API calls, no data leaves your computer. (The embedding model downloads once, ~90MB, on first use — after that it's fully offline too. The one exception is an optional, separately-installed language server for `--precise` mode.)
- **Visual**: `brain explore` gives you a focused, click-to-walk neighborhood view of one function/file at a time; `brain visualize`/`visualize2`/`visualize3` give you three different whole-graph views.

---

## 1. Install (do this once)

**Requirements:** Node.js 18+ (check with `node --version`).

1. Unzip this project anywhere permanent, e.g. `C:\tools\project-brain` on Windows, or `~/tools/project-brain` on Mac/Linux.
2. Open a terminal in that folder.
3. Install dependencies and register the global `brain` (and `brain-mcp`) commands:

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
1. Walks the project once (respects `.gitignore`, skips `node_modules`, `.git`, `dist`, `build`, etc., and — see §9a — minified bundles and any single file over 300KB)
2. Hashes every file and diffs against the last build (first run = everything is "added")
3. Parses changed/new files with tree-sitter → extracts functions, classes, imports, call edges, and localStorage/sessionStorage key usage (full parsing for JS/TS/Java/Python/C#/PHP; a whole-file fallback for everything else supported — see §9)
4. Builds/updates the SQLite dependency graph and lexical (FTS5) index, including which files are tests and which calls happen inside a test/suite/hook
5. Generates local embeddings for new/changed symbols (batched per file) and updates the vector index
6. Writes `BRAIN-INSTRUCTIONS.md` into the repo root — this is what tells Claude Code / Amazon Q not to rescan the project and to use the brain commands instead (skip with `--no-instructions`)

Run it again anytime after making changes — unchanged files are skipped automatically, so it's fast:

```bash
brain build
```

Force a full rebuild from scratch (also cleans up any stale data left behind by files that were since renamed/removed):

```bash
brain build --force
```

Add real go-to-definition resolution for TypeScript/JavaScript on top of the default heuristic, if you have a language server installed (see §8):

```bash
brain build --precise
```

### Querying the brain directly

```bash
# Semantic search - find relevant code by describing the task
brain search "retry logic for payment webhook handling" -k 10

# ...optionally filtered by symbol kind or file extension
brain search "retry logic" --kind function --ext .py

# Get callers/callees of a symbolId returned by search
brain expand 42 --hops 1

# Read an exact line range - no full-file or folder scan
brain read src/payments.js 12 30

# One-shot: search + expand + read, assembled into one budget-bounded bundle
brain context "add retry logic to the payment webhook handler"

# Before editing a symbol: blast radius + test coverage
brain check 42
```

All commands accept `--path <repo-dir>` if you're not running from inside the repo.

### Overriding defaults with `brain.config.json`

Drop a `brain.config.json` at a repo's root (repo-specific) and/or at `BRAIN_HOME` (machine-wide) to override built-in defaults without touching code — repo-level wins when both exist:

```json
{
  "ignoreDirs": ["generated"],
  "extraExtensions": [".mts"],
  "defaultBudgetChars": 40000,
  "maxItems": 100,
  "minNeighborSimilarity": 0.2,
  "minGuaranteedNeighbors": 5,
  "maxOpen": 10,
  "rrfK": 60
}
```

All keys are optional. `ignoreDirs`/`extraExtensions` are *added* to the built-in lists (not a replacement), so a typo can't accidentally un-ignore `node_modules`. `maxOpen` (StoreCache's LRU cap on open repos) only makes sense machine-wide, so it's only read from `BRAIN_HOME`'s config, not a repo-level one. `minNeighborSimilarity` tunes how aggressively `brain context` filters graph-adjacent-but-topically-unrelated neighbors (see §3); set it to `-1` to disable that filtering entirely and go back to including every graph-adjacent neighbor up to `maxItems`. `minGuaranteedNeighbors` (default 5) is a backstop on top of that floor — the top N neighbors by similarity are always kept regardless of `minNeighborSimilarity`, so a task whose whole neighborhood happens to embed poorly doesn't lose its graph context entirely. See `src/userConfig.js` for the full list.

### Multi-repo

Just run `brain build` inside each repo separately — each gets its own isolated folder under `BRAIN_HOME`, keyed by that repo's path, so independent projects (like your separate front-end report repos) never mix data.

See everything currently indexed:

```bash
brain list
```

---

## 3. `brain context` — one-shot context assembly

Instead of an agent calling `search`, then `expand` on the results, then `read` for exact code — three separate commands and three rounds of reasoning about symbol IDs — `brain context` does all three in one call and hands back a single, ready-to-use bundle:

```bash
brain context "add retry logic to the payment webhook handler" -k 8 --hops 1 --budget 24000
```

Returns JSON shaped like:

```json
{
  "task": "...",
  "budget": { "limitChars": 24000, "usedChars": 18342, "truncated": false },
  "primary": [ { "symbolId": 42, "name": "chargeCard", "kind": "function", "path": "src/payments.js", "startLine": 12, "endLine": 40, "score": 0.81, "signature": "...", "code": "..." } ],
  "neighbors": [ { "symbolId": 51, "relation": "caller", "via": 42, "name": "...", "path": "...", "code": null, "similarity": 0.34 } ],
  "filesTouched": ["src/payments.js", "src/webhook.js"],
  "notes": []
}
```

- The most relevant hits (by semantic search) get **real source code** (read from the file, not the ~160-char truncated signature stored for search preview), up to `budget.limitChars` (default 24,000 ≈ 6k tokens, tune with `--budget`) — which bounds the **entire response**, not just code text. If it's still too big once neighbors' metadata is accounted for, the lowest-priority neighbors are dropped first; if it's *still* over (e.g. a single large primary hit's own metadata already approaches the budget), primary code is shrunk further rather than dropped outright, until it fits or there's nothing left to shrink. Either way, `budget.usedChars` always reflects the true final size and `notes` explains what happened.
- Their immediate callers/callees come along as `neighbors`, prioritized by distance and, within a distance tier, by **relevance to the task text** — a graph-adjacent neighbor whose embedding similarity to the task falls below a floor (default 0.1, tune via `brain.config.json`'s `minNeighborSimilarity`) is dropped rather than riding along just because it's structurally adjacent (this is what keeps an unrelated `*.spec.ts`/`*.scss` neighbor out). Two exceptions, so this can't zero out a context bundle's graph entirely: a `"shares-storage-key"` neighbor (see §4) is never dropped (that relation is itself an explicit relevance signal), and the top `minGuaranteedNeighbors` (default 5) by similarity are always kept regardless of the floor.
- `--kind`/`--ext` filter the primary hits the same way `brain search` does.

This is the recommended default entry point for a new task — use the raw `search`/`expand`/`read` primitives when you need finer control instead.

## 4. `brain check` — before you edit something

```bash
brain check 42 --hops 3 --test-hops 6
```

Reports, for symbol `42`:

```json
{
  "symbol": { "name": "chargeCard", "path": "src/payments.js", "startLine": 12, "endLine": 40 },
  "blastRadius": [ { "name": "processOrder", "path": "src/orders.js", "hops": 1 } ],
  "testsCovering": [ { "name": "charges the card", "kind": "test", "path": "src/payments.test.js", "hops": 1 } ],
  "risk": "covered"
}
```

- **`blastRadius`**: every symbol that transitively calls this one, up to `--hops` deep — "what breaks if I change this." Also includes (flat, not hop-chained) any symbol that reads/writes the same `localStorage`/`sessionStorage` key, tagged `relation: "shares-storage-key"` with a `sharedKey` field — coupling the call graph alone can't see, since there's no function call between the writer and the reader.
- **`testsCovering`**: which tests (Jest/Mocha-style `it`/`test`/`describe` blocks in JS/TS, `def test_*` functions in Python, `@Test` methods in Java, all detected automatically during `brain build`) actually exercise this symbol.
- **`risk`**: `"covered"` if any test does, `"untested"` otherwise.

Run this on a search/context result's `symbolId` before making a risky change, so you know upfront whether you're touching untested code and what else depends on it.

---

## 5. Wiring it into Claude Code / Amazon Q

After `brain build` runs once in a repo, it drops `BRAIN-INSTRUCTIONS.md` at
the repo root. Point your agent at it (most agents auto-read root-level
`.md` instruction files, or you can paste its contents into your system/
project prompt). It tells the agent:

- Don't `grep`/`readdir`/rescan the project.
- Start a task with `brain context "<task>"`; use `brain search`/`brain expand`/`brain read` directly when finer control is needed.
- Run `brain check <symbolId>` before editing something risky.
- Run `brain build` once after finishing edits, so the brain stays current for the next session.

Since it's a plain terminal command, this works identically whether it's
Claude Code or Amazon Q driving — whichever agent has shell access can call
`brain`. For an agent without file-system/shell access (e.g. a plain chat
model doing analysis only), run the query yourself and paste the JSON
output in.

### Or: connect as a live MCP server instead

If your agent speaks MCP (Claude Code does), you can skip shelling out entirely and register `brain` as a native tool server:

```bash
claude mcp add --scope user brain-mcp -- brain-mcp
```

(`--scope user` registers it once, machine-wide, matching the "one global install, many repos" model — every tool call still takes an explicit `path` argument for which repo to use.) For a project-shared setup instead, commit a `.mcp.json`:

```json
{ "mcpServers": { "brain": { "type": "stdio", "command": "brain-mcp", "args": [] } } }
```

This exposes 7 tools with the exact same behavior as the CLI commands above — `brain_search`, `brain_expand`, `brain_read`, `brain_context`, `brain_check`, `brain_build`, `brain_list` — as typed tool calls instead of shell-and-parse-JSON. It also keeps the graph/vector index open across calls (faster than the CLI's per-invocation open/close) and remembers within the session what code it's already shown you, so a repeated `brain_read`/`brain_context` on the same lines comes back flagged `alreadyShown` instead of resending the same text.

**A note on latency, so you don't benchmark the wrong number**: every CLI invocation (`brain search`, `brain context`, ...) is a fresh Node process, and most of what it pays for is loading the local embedding model (ONNX runtime) from scratch — typically 1.5-4+ seconds depending on the machine, dominating whatever the actual query took. The MCP server pays that cost exactly **once**, on its first tool call after starting, and every call after that is warm — typically tens to a couple hundred milliseconds. If you're evaluating how fast this is, benchmark repeated calls through `brain mcp`/`brain-mcp`, not a single `brain search` invocation — the latter will make it look ~10-50x slower than it actually is in normal (server) use.

**This is purely additive** — every CLI command above keeps working exactly as documented, with or without the MCP server running. `brain mcp` (equivalent to the standalone `brain-mcp` binary) is just a second way to reach the same logic.

You can also start it manually to see it running:

```bash
brain mcp
# or, equivalently:
brain-mcp
```

(Ctrl+C to stop it.)

---

## 6. Visualizing the graph

### `brain explore` — start from one function, walk outward

```bash
brain explore --open
```

The other three visualizers below render the *entire* graph as one force-directed layout, which gets unreadable fast on a real-sized repo. `brain explore` instead starts from nothing: search for a function/class/file (or pick one of the suggested most-connected symbols), and it renders only that symbol's immediate neighborhood (1-2 hops, your choice). Click any neighbor to re-center the view on it, with a Back button to retrace your steps. This is the one to reach for on anything past a small repo.

### `brain visualize` / `visualize2` / `visualize3` — whole-graph views

```bash
brain visualize --out brain-graph.html --open
```

Generates a single static HTML file covering **every** repo currently
indexed (not just the current one), with:
- A dropdown at the top to switch between repos
- Nodes = functions/classes/methods, colored by kind
- Edges = call relationships
- A search box that highlights matching nodes and their connections

`visualize2` is a galaxy-style layout of the same data; `visualize3` is a radial graph-analysis view. Regenerate any of them after a `brain build` to refresh with the latest graph.

---

## 7. `brain build --precise` — real go-to-definition resolution (TS/JS)

By default, call-graph edges are resolved **by name**: a call to `validate()` links to every symbol named `validate` anywhere in the repo, which can over-match when multiple files define same-named functions (see §11). `--precise` layers a second pass on top that asks a real language server for the actual definition at each call site, for TypeScript/JavaScript specifically:

```bash
npm i -g typescript-language-server typescript   # one-time, separate from this tool
brain build --precise
```

- **Opt-in and additive**: the default heuristic pass always runs first and is never removed; precise edges are added alongside it (visible via the `edges.resolution` column: `'heuristic'` vs `'lsp'`), so nothing regresses if the language server isn't available or doesn't cover a particular call.
- **Graceful by design**: if `typescript-language-server` isn't installed, isn't found, or doesn't respond, `brain build` logs one warning line and continues with the heuristic result — it will never hang or abort the build over this.
- **Known limitation**: it uses one project root (your repo root) for the whole build. In a monorepo where the actual TypeScript project lives in a subfolder (e.g. `frontend/` with its own `node_modules/typescript`), the language server may not find a valid TypeScript install and this pass will fall back for the whole build. Per-subdirectory project detection isn't implemented in v1.
- Only TypeScript/JavaScript are wired up today; the registry in `src/lsp/servers.js` is designed so adding another language (e.g. `pyright` for Python) later is a config entry, not an architecture change.
- Available from the MCP server too: `brain_build`'s `precise` argument does the same thing as the CLI's `--precise` flag.

---

## 8. How the data is stored (for reference)

```
<BRAIN_HOME>/
  brain.config.json           # optional, machine-wide overrides - see §2
  <repo-slug>-<hash>/          # one folder per repo, fully isolated
    manifest.json               # file hashes + content-format version, used for incremental diffing
    graph.sqlite                 # files, symbols, edges, string_literals, chunks tables + chunks_fts (FTS5 lexical index)
    vectors.bin                   # flat Float32Array of symbol embeddings
    vectors.meta.json              # symbol ids matching vectors.bin order
```

A repo can also have its own `brain.config.json` at its root (repo-specific overrides — see §2).

Nothing is ever written back into your source repo except the one
`BRAIN-INSTRUCTIONS.md` file — the actual index lives entirely outside the
project.

## 9. Language support

**Full parsing** (functions/classes/methods, imports, call graph, test detection): JavaScript, JSX, TypeScript, TSX (Angular, React, Vue-via-script-blocks), Java, Python, C# (.NET), PHP.

Test-file/test-symbol detection covers each ecosystem's own convention: `*.test.*`/`*.spec.*` and `describe`/`it`/`test`/hooks (JS/TS - including Angular's `.spec.ts` and Jasmine/Jest/Mocha), `test_*.py`/`*_test.py` (Python), `*Test.java`/`Test*.java` (JUnit), `*Tests.cs` (xUnit/NUnit/MSTest), `*Test.php` (PHPUnit).

**Everything else walked and semantically searchable, via a whole-file fallback** (no fine-grained symbols, but still hashed/embedded/searchable):
- **Other languages**: HTML, CSS/SCSS/Sass/Less, Vue SFC files, Svelte, Elixir, Ruby, Go, Rust, C/C++, Kotlin, Swift, Scala, Dart, shell scripts, SQL, Perl, Lua, Objective-C, Groovy, Haskell, Clojure, GraphQL, Terraform, F#, VB, R, Elm, and more.
- **Config/build/project files** across all of the above ecosystems: `.json` (`package.json`, `appsettings.json`, `tsconfig.json`, ...), `.xml` (`pom.xml`, `web.config`, ...), `.yml`/`.yaml`, `.toml`, `.ini`/`.cfg`, `.properties` (Spring Boot config), `.gradle`, `.env`, `.csproj`/`.sln` (.NET project files), `.razor`/`.cshtml` (Blazor/Razor views).

See `FULLY_PARSED_EXTENSIONS`/`GENERICALLY_PARSED_EXTENSIONS` in `src/config.js` for the exact, current lists.

Adding full parsing for another language means adding its tree-sitter grammar package and a case in `src/parser.js`'s language/visitor setup — most languages need very little new code, since call/import node-type patterns tend to be shared across C-family and dynamic languages (e.g. C# and PHP's class/method declarations reuse the exact same visitor cases already written for Java).

### 9a. Files excluded from the index

Beyond `.gitignore` and `DEFAULT_IGNORE_DIRS` (`node_modules`, `.git`, `dist`, `build`, ...): any `*.min.js`/`*.min.css` file, and any single file over 300KB (`MAX_FILE_SIZE_BYTES` in `src/config.js`) — both are cheap-to-hit cases (a vendored bundle checked in outside `dist/`, a generated file) that are expensive to parse/embed and have no meaningful symbol boundaries anyway. Extend the size/ignore-dir list via `brain.config.json` (see §2).

## 10. `brain search` result scoring

Each result's `score` is a [reciprocal-rank-fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) score combining three independent rankings:
1. `vectorIndex.js`'s **semantic** search (embedding cosine similarity).
2. A **lexical**/substring search over full symbol bodies via SQLite FTS5 (`chunks_fts` in `graph.sqlite`) — so an exact identifier or string literal that only appears inside a function body (not just its first line) still surfaces, even with zero semantic similarity to the query text.
3. A **name-match** search (`graphStore.js`'s `searchByNameMatch`) over symbol names and file paths/basenames — so a file whose name is a near-exact match for the query (e.g. `generic-filter.component.ts` for "filter flow") is a reliable hit even when its body content isn't semantically/lexically close to the query wording.

- `score` is **not** a raw cosine similarity — it has no fixed range and isn't meaningful on its own; only its relative ordering matters. (The raw cosine range *is* documented, in `vectorIndex.js`'s `search()` doc comment, for anyone working with that module directly.)
- `confidence` buckets it into something actionable: `"high"` means at least two of the three signals agreed on this result; `"medium"`/`"low"` mean only one did, based on how high it ranked there.
- A generic-parsed file (`.scss`/`.html`/`.json`/... — see §9, no real logic granularity) has its score discounted relative to a real code file (`.ts`/`.js`/...) **unless** it earned a genuine lexical hit against its actual body content — otherwise a stylesheet named `theme.scss` could outrank a real `ThemeService` class for a "theme" query purely on filename coincidence (the name-match signal discounts itself at the source too; a config file that genuinely contains what you're searching for, e.g. `appsettings.json` for "database connection string", is never discounted).
- Tune the fusion via `brain.config.json`'s `rrfK` (see §2) if needed — the default (60) is a standard, untuned choice; RRF's whole appeal is low sensitivity to this constant.

## 11. Known simplifications (by design, upgradeable later)

- **Default call-edge resolution is name-based**, not full scope/type resolution — if two files each have a function called `validate`, a call to `validate()` may link to both. Good enough for "what calls this / what does this call" style navigation; `--precise` (§7) layers real resolution on top for TS/JS when a language server is available.
- **Vector search is a flat, brute-force cosine index** (pure JS, no native ANN library) — chosen for zero install risk across OSes at the scale this targets (tens of thousands of symbols per repo). `brain build` logs a warning once a repo's vector index passes 150k symbols, ahead of the ~200k design ceiling. If a single repo grows past that, swap `src/vectorIndex.js` for a proper HNSW library (e.g. `usearch`) without touching anything else.
- **`brain search`'s lexical half only covers full-parsed languages' function/method bodies** (JS/TS/Java/Python/C#/PHP - see §9) plus whatever fits in a whole-file fallback chunk (capped at 20,000 characters per symbol, `MAX_CHUNK_CHARS` in `src/parser.js`) — a match past that cap in a single pathologically large function/file won't be found lexically (semantic search over the signature still applies).
- **Test-coverage detection is call-graph-based, not execution-based** — `brain check`'s `testsCovering` means "a test transitively calls this," not "this line was hit by a passing test run." A test that exists but is skipped, or that calls the symbol without meaningfully asserting on it, still counts as "covered."
- **`--precise` resolves one project root per repo** — see the monorepo limitation in §7.

## 12. Troubleshooting

- **`npm install` fails on `better-sqlite3` or `tree-sitter`** — these compile a small native addon. Make sure you have a C++ build toolchain: on Windows, `npm install -g windows-build-tools` (or install "Desktop development with C++" via Visual Studio Build Tools); on Mac, run `xcode-select --install`.
- **First `brain build` seems slow / needs internet** — that's the one-time ~90MB embedding model download. Subsequent runs are fully offline.
- **`brain` command not found after global install** — open a new terminal window (PATH refresh), or run via `npx brain <command>` from inside the project-brain folder.
- **`brain build --precise` says "not found or unresponsive"** — either `typescript-language-server` isn't installed (`npm i -g typescript-language-server typescript`), or your repo is a monorepo where TypeScript lives in a subfolder rather than the repo root (see §7's known limitation). Either way, the build still completes normally using the default heuristic.
- **`brain mcp` / `brain-mcp` doesn't show up as a tool in Claude Code** — confirm it's registered (`claude mcp list`) and that you used `claude mcp add --scope user brain-mcp -- brain-mcp` (or the `.mcp.json` form) exactly, then restart your Claude Code session.
