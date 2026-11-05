# Brain benchmark (stages-after): with the brain vs without it

Repo: `D:\monk-end-user-solution-ravikiran` @ `83725c9` (382 files under src/, 11.2 MB, about 2,934,850 tokens if read whole). Run 20261105T151403Z.
Machine: Intel(R) Core(TM) Ultra 7 155H, 22 threads, 31 GB RAM, Node v24.21.0, win32 10.0.26300.
Tasks: 9 (3 medium, 3 hard, 3 expert) from `tasks-stages.json`. Ground truth was fixed by reading the code before either method was run.

## How to read this

- **Without the brain**: an agent with only grep and read-file. Keywords come mechanically from the task text; files are ranked by keyword rarity; the top 5 are read in full (`grep+read`) or as matching lines with 3 lines of context (`grep+snippets`). For "what depends on X" it is one word-match grep (`grep`). It skips `src/assets` and caps one read at about 25k tokens, which are generous to it.
- **With the brain**: the real CLI in a cold process per call, plus the same calls in one warm process (what the MCP server pays). `brain-search` = ranked symbols; `brain-context` = search + neighbours + code in one bundle (24k-char budget); `brain-context-lean` = `-k 5 --budget 8000`; `brain-check` = search then blast-radius report.
- **Tokens** = characters / 4 for both sides (a real tokenizer differs by about 20%, the same way for both). Cost lines assume $3.00 per million input tokens.
- **Solved** = every required file was in what the method delivered. **hit@k** = a required file is among the first k candidate files. **nDCG@5** scores the first 5 candidates (required = 2, useful = 1). **P@5** = share of the first 5 candidates that are required or useful. **Relevant share** = share of delivered tokens that sit in required or useful files (the rest is noise the model must read). **Tokens to first answer** counts only tasks the method found, so read it next to Solved.
- **Latency** is retrieval only (process time and file reads), not model time. p95 is over all repetitions; jitter is the run-to-run standard deviation.

## Standing costs of the brain

| Measure | Value |
| --- | --- |
| Full index build (cold, includes loading the embedding model) | 29.4 s |
| Incremental rebuild, nothing changed | 0.7 s |
| Incremental rebuild, one file edited (freshness) | 1.9 s (1 changed file) |
| Peak memory during the full build | 714 MB |
| CPU time of the full build (user + system) | 320.0 s |
| Symbols / files indexed | 3,038 / 358 |
| Index size on disk | 10.5 MB (0.9x the source) |
| Warm process: open store and vectors | 26 ms |
| Warm process: first semantic query (model load) | 435 ms |
| Warm process memory (idle, model loaded) / peak | 201 MB / 202 MB |
| Without the brain | nothing to build; no extra memory or disk |

## Round: medium

3 tasks: M1, M2, M3.

**Core**

| Method | Solved | hit@1 | hit@3 | Recall | Tool calls | Tokens delivered | Tokens to first answer | Latency cold (median) | Latency warm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 2/3 | 0% | 67% | 67% | 12.7 | 35,696 | 15,128 | 1,421 ms | n/a |
| grep+snippets | 2/3 | 0% | 67% | 67% | 8.7 | 6,775 | 5,126 | 1,557 ms | n/a |
| **brain-search** | 3/3 | 67% | 100% | 100% | 1.0 | 432 | 627 | 836 ms | 4 ms |
| **brain-context** | 3/3 | 67% | 100% | 100% | 1.0 | 7,101 | 7,101 | 837 ms | 17 ms |
| **brain-context-lean** | 3/3 | 67% | 100% | 100% | 1.0 | 2,684 | 2,684 | 831 ms | 12 ms |

**Advanced**

| Method | nDCG@5 | P@5 | Relevant share | Tokens per correct file | Cost per task | Cost per solved task | Latency p95 | Jitter | Context budget used | Truncated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 0.29 | 13% | 1% | 28,655 | $0.107 | $0.161 | 1,532 ms | +/-84 ms | n/a | n/a |
| grep+snippets | 0.29 | 13% | 7% | 6,276 | $0.020 | $0.030 | 1,631 ms | +/-59 ms | n/a | n/a |
| **brain-search** | 0.95 | 40% | 48% | 432 | $0.0013 | $0.0013 | 847 ms | +/-8 ms | n/a | n/a |
| **brain-context** | 0.95 | 27% | 11% | 7,101 | $0.021 | $0.021 | 855 ms | +/-5 ms | 118% | 0% |
| **brain-context-lean** | 0.95 | 27% | 29% | 2,684 | $0.0081 | $0.0081 | 857 ms | +/-11 ms | 134% | 100% |

**Side by side:** best without = `grep+snippets` (2/3 solved, 6,775 tokens, 1,557 ms); best with = `brain-search` (3/3 solved, 432 tokens, 836 ms cold). Verdict: brain ahead on answers.

Per task: tokens delivered, rank of the first required file, recall.

| Task | grep+read | grep+snippets | brain-search | brain-context |
| --- | --- | --- | --- | --- |
| M1 | 17,327 t, #3, 100% | 4,966 t, #3, 100% | 431 t, #2, 100% | 6,986 t, #2, 100% |
| M2 | 39,983 t, #3, 100% | 7,585 t, #3, 100% | 430 t, #1, 100% | 7,444 t, #1, 100% |
| M3 | 49,777 t, #125, 0% | 7,775 t, #125, 0% | 434 t, #1, 100% | 6,872 t, #1, 100% |

## Round: hard

3 tasks: H1, H2, H3.

**Core**

| Method | Solved | hit@1 | hit@3 | Recall | Tool calls | Tokens delivered | Tokens to first answer | Latency cold (median) | Latency warm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 0/3 | 0% | 0% | 0% | 12.7 | 35,619 | n/a | 1,817 ms | n/a |
| grep+snippets | 0/3 | 0% | 0% | 0% | 8.7 | 9,515 | n/a | 1,742 ms | n/a |
| **brain-search** | 3/3 | 33% | 100% | 100% | 1.0 | 453 | 814 | 920 ms | 4 ms |
| **brain-context** | 3/3 | 33% | 100% | 100% | 1.0 | 6,709 | 6,709 | 948 ms | 24 ms |
| **brain-context-lean** | 3/3 | 33% | 100% | 100% | 1.0 | 2,559 | 2,559 | 934 ms | 15 ms |

**Advanced**

| Method | nDCG@5 | P@5 | Relevant share | Tokens per correct file | Cost per task | Cost per solved task | Latency p95 | Jitter | Context budget used | Truncated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 0.00 | 0% | 0% | n/a | $0.107 | n/a | 1,859 ms | +/-23 ms | n/a | n/a |
| grep+snippets | 0.00 | 0% | 0% | n/a | $0.029 | n/a | 2,002 ms | +/-70 ms | n/a | n/a |
| **brain-search** | 0.55 | 22% | 20% | 453 | $0.0014 | $0.0014 | 973 ms | +/-14 ms | n/a | n/a |
| **brain-context** | 0.55 | 20% | 10% | 6,709 | $0.020 | $0.020 | 963 ms | +/-8 ms | 112% | 0% |
| **brain-context-lean** | 0.55 | 20% | 15% | 2,559 | $0.0077 | $0.0077 | 977 ms | +/-13 ms | 128% | 67% |

**Side by side:** best without = `grep+snippets` (0/3 solved, 9,515 tokens, 1,742 ms); best with = `brain-search` (3/3 solved, 453 tokens, 920 ms cold). Verdict: brain ahead on answers.

Per task: tokens delivered, rank of the first required file, recall.

| Task | grep+read | grep+snippets | brain-search | brain-context |
| --- | --- | --- | --- | --- |
| H1 | 30,666 t, #42, 0% | 11,490 t, #42, 0% | 411 t, #3, 100% | 6,029 t, #3, 100% |
| H2 | 35,292 t, #68, 0% | 9,510 t, #68, 0% | 449 t, #3, 100% | 7,102 t, #3, 100% |
| H3 | 40,900 t, #24, 0% | 7,544 t, #24, 0% | 498 t, #1, 100% | 6,995 t, #1, 100% |

## Round: expert

3 tasks: E1, E2, E3.

**Core**

| Method | Solved | hit@1 | hit@3 | Recall | Tool calls | Tokens delivered | Tokens to first answer | Latency cold (median) | Latency warm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 0/2 | 0% | 0% | 17% | 13.0 | 33,054 | 27,571 | 1,964 ms | n/a |
| grep+snippets | 0/2 | 0% | 0% | 17% | 9.0 | 8,031 | 7,272 | 2,049 ms | n/a |
| grep | 1/1 | 0% | 100% | 100% | 1.0 | 1,078 | 1,078 | 241 ms | n/a |
| **brain-search** | 0/2 | 50% | 50% | 25% | 1.0 | 432 | 841 | 952 ms | 5 ms |
| **brain-context** | 0/2 | 50% | 50% | 58% | 1.0 | 5,920 | 5,920 | 987 ms | 22 ms |
| **brain-context-lean** | 0/2 | 50% | 50% | 25% | 1.0 | 2,694 | 2,688 | 1,018 ms | 14 ms |
| **brain-check** | 0/1 | 0% | 100% | 77% | 2.0 | 5,470 | 5,470 | 913 ms | 4 ms |

**Advanced**

| Method | nDCG@5 | P@5 | Relevant share | Tokens per correct file | Cost per task | Cost per solved task | Latency p95 | Jitter | Context budget used | Truncated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 0.17 | 30% | 22% | 27,571 | $0.099 | n/a | 2,061 ms | +/-34 ms | n/a | n/a |
| grep+snippets | 0.17 | 30% | 30% | 7,272 | $0.024 | n/a | 2,073 ms | +/-16 ms | n/a | n/a |
| grep | 0.72 | 100% | 100% | 83 | $0.0032 | $0.0032 | 251 ms | +/-10 ms | n/a | n/a |
| **brain-search** | 0.33 | 33% | 40% | 432 | $0.0013 | n/a | 986 ms | +/-24 ms | n/a | n/a |
| **brain-context** | 0.49 | 40% | 32% | 4,801 | $0.018 | n/a | 992 ms | +/-8 ms | 99% | 50% |
| **brain-context-lean** | 0.33 | 20% | 24% | 2,688 | $0.0081 | n/a | 1,038 ms | +/-20 ms | 135% | 100% |
| **brain-check** | 0.83 | 100% | 65% | 547 | $0.016 | n/a | 914 ms | +/-8 ms | n/a | n/a |

**Side by side:** best without = `grep` (1/1 solved, 1,078 tokens, 241 ms); best with = `brain-check` (0/1 solved, 5,470 tokens, 913 ms cold). Verdict: grep ahead on answers.

Per task: tokens delivered, rank of the first required file, recall.

| Task | grep+read | grep+snippets | grep | brain-search | brain-context | brain-check |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | 38,536 t, #8, 0% | 8,790 t, #8, 0% | - | 432 t, #1, 50% | 7,362 t, #1, 50% | - |
| E2 | 27,571 t, #5, 33% | 7,272 t, #5, 33% | - | 431 t, miss, 0% | 4,478 t, #4, 67% | - |
| E3 | - | - | 1,078 t, #3, 100% | - | - | 5,470 t, #2, 77% |

## Rounds side by side

| Round | Best without | Solved | Tokens | Cold latency | Best with | Solved | Tokens | Cold / warm latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| medium | `grep+snippets` | 2/3 | 6,775 | 1,557 ms | **`brain-search`** | 3/3 | 432 | 836 ms / 4 ms |
| hard | `grep+snippets` | 0/3 | 9,515 | 1,742 ms | **`brain-search`** | 3/3 | 453 | 920 ms / 4 ms |
| expert | `grep` | 1/1 | 1,078 | 241 ms | **`brain-check`** | 0/1 | 5,470 | 913 ms / 4 ms |

Every method, per round (solved of n):

| Method | medium | hard | expert |
| --- | --- | --- | --- |
| grep+read | 2/3 | 0/3 | 0/2 |
| grep+snippets | 2/3 | 0/3 | 0/2 |
| grep | - | - | 1/1 |
| brain-search | 3/3 | 3/3 | 0/2 |
| brain-context | 3/3 | 3/3 | 0/2 |
| brain-context-lean | 3/3 | 3/3 | 0/2 |
| brain-check | - | - | 0/1 |

## Before and after the fixes (stages-before -> stages-after)

Same tasks, same machine, same repo commit. "Before" is the saved run named above.

| Method | Solved before | after | hit@1 before | after | nDCG@5 before | after | Recall before | after | Tokens before | after | Cold latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **brain-search** | 3/8 | 6/8 | 13% | 50% | 0.28 | 0.65 | 44% | 81% | 503 | 440 | 1,154 -> 920 ms |
| **brain-context** | 4/8 | 6/8 | 38% | 50% | 0.45 | 0.69 | 56% | 90% | 5,430 | 6,659 | 1,186 -> 948 ms |
| **brain-context-lean** | 3/8 | 6/8 | 38% | 50% | 0.45 | 0.65 | 44% | 81% | 2,466 | 2,640 | 1,148 -> 934 ms |
| **brain-check** | 0/1 | 0/1 | 0% | 0% | 0.83 | 0.83 | 77% | 77% | 5,470 | 5,470 | 1,373 -> 913 ms |

Per task, rank of the first required file and recall (before -> after):

| Task | brain-search | brain-context | brain-check |
| --- | --- | --- | --- |
| M1 | #3/100% -> #2/100% | #2/100% -> #2/100% | - |
| M2 | #1/100% -> #1/100% | #1/100% -> #1/100% | - |
| M3 | #3/100% -> #1/100% | #1/100% -> #1/100% | - |
| H1 | miss/0% -> #3/100% | #2/100% -> #3/100% | - |
| H2 | miss/0% -> #3/100% | miss/0% -> #3/100% | - |
| H3 | miss/0% -> #1/100% | miss/0% -> #1/100% | - |
| E1 | #3/50% -> #1/50% | #1/50% -> #1/50% | - |
| E2 | miss/0% -> miss/0% | #10/0% -> #4/67% | - |
| E3 | - | - | #2/77% -> #2/77% |

## Where each method fell short

- M3/grep+read (recall 0%; keywords used: server base front relative paths urls skip)
- M3/grep+snippets (recall 0%; keywords used: server base front relative paths urls skip)
- H1/grep+read (recall 0%; keywords used: route protection sends visitor logged back home page)
- H1/grep+snippets (recall 0%; keywords used: route protection sends visitor logged back home page)
- H2/grep+read (recall 0%; keywords used: request fails waits short moment tries once error)
- H2/grep+snippets (recall 0%; keywords used: request fails waits short moment tries once error)
- H3/grep+read (recall 0%; keywords used: robot shrink narrow container actually drawn page)
- H3/grep+snippets (recall 0%; keywords used: robot shrink narrow container actually drawn page)
- E1/grep+read (recall 0%; keywords used: want idle logout time come tenant settings instead)
- E1/grep+snippets (recall 0%; keywords used: want idle logout time come tenant settings instead)
- E1/brain-search (recall 50%)
- E1/brain-context (recall 50%)
- E1/brain-context-lean (recall 50%)
- E2/grep+read (recall 33%; keywords used: want rename browser storage records user last interacted)
- E2/grep+snippets (recall 33%; keywords used: want rename browser storage records user last interacted)
- E2/brain-search (recall 0%)
- E2/brain-context (recall 67%)
- E2/brain-context-lean (recall 0%)
- E3/brain-check (recall 77%)

## Limits of this benchmark

- One repository (an Angular app) and a small number of tasks per round. The numbers are indicative, not a universal result; with 3 tasks per round a single task moves a round by 33 points.
- The without-brain agent is a fixed, mechanical strategy, not a model improvising. A smarter agent would choose better keywords; a weaker one, worse.
- Ground truth is my reading of the code. Required files drive recall; useful files are accepted extras.
- Latency excludes model time, which is driven by the token counts.
- Brain results come from a fresh index in a temporary folder; your real brain and the repo were not written to.