# Brain benchmark (stages-before): with the brain vs without it

Repo: `D:\monk-end-user-solution-ravikiran` @ `83725c9` (382 files under src/, 11.2 MB, about 2,934,850 tokens if read whole). Run 20261105T143809Z.
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
| Full index build (cold, includes loading the embedding model) | 21.0 s |
| Incremental rebuild, nothing changed | 1.0 s |
| Incremental rebuild, one file edited (freshness) | 2.5 s (1 changed file) |
| Peak memory during the full build | 527 MB |
| CPU time of the full build (user + system) | 232.7 s |
| Symbols / files indexed | 3,038 / 358 |
| Index size on disk | 10.4 MB (0.9x the source) |
| Warm process: open store and vectors | 30 ms |
| Warm process: first semantic query (model load) | 557 ms |
| Warm process memory (idle, model loaded) / peak | 191 MB / 205 MB |
| Without the brain | nothing to build; no extra memory or disk |

## Round: medium

3 tasks: M1, M2, M3.

**Core**

| Method | Solved | hit@1 | hit@3 | Recall | Tool calls | Tokens delivered | Tokens to first answer | Latency cold (median) | Latency warm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 2/3 | 0% | 67% | 67% | 12.7 | 35,696 | 15,128 | 2,029 ms | n/a |
| grep+snippets | 2/3 | 0% | 67% | 67% | 8.7 | 6,775 | 5,126 | 2,496 ms | n/a |
| **brain-search** | 3/3 | 33% | 100% | 100% | 1.0 | 484 | 1,103 | 1,113 ms | 15 ms |
| **brain-context** | 3/3 | 67% | 100% | 100% | 1.0 | 5,867 | 5,867 | 1,088 ms | 35 ms |
| **brain-context-lean** | 3/3 | 67% | 100% | 100% | 1.0 | 2,471 | 2,471 | 1,132 ms | 27 ms |

**Advanced**

| Method | nDCG@5 | P@5 | Relevant share | Tokens per correct file | Cost per task | Cost per solved task | Latency p95 | Jitter | Context budget used | Truncated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 0.29 | 13% | 1% | 28,655 | $0.107 | $0.161 | 2,309 ms | +/-72 ms | n/a | n/a |
| grep+snippets | 0.29 | 13% | 7% | 6,276 | $0.020 | $0.030 | 2,588 ms | +/-108 ms | n/a | n/a |
| **brain-search** | 0.63 | 25% | 25% | 484 | $0.0015 | $0.0015 | 1,471 ms | +/-81 ms | n/a | n/a |
| **brain-context** | 0.83 | 20% | 7% | 5,867 | $0.018 | $0.018 | 1,359 ms | +/-52 ms | 98% | 67% |
| **brain-context-lean** | 0.83 | 22% | 17% | 2,471 | $0.0074 | $0.0074 | 1,249 ms | +/-63 ms | 123% | 100% |

**Side by side:** best without = `grep+snippets` (2/3 solved, 6,775 tokens, 2,496 ms); best with = `brain-context-lean` (3/3 solved, 2,471 tokens, 1,132 ms cold). Verdict: brain ahead on answers.

Per task: tokens delivered, rank of the first required file, recall.

| Task | grep+read | grep+snippets | brain-search | brain-context |
| --- | --- | --- | --- | --- |
| M1 | 17,327 t, #3, 100% | 4,966 t, #3, 100% | 498 t, #3, 100% | 6,909 t, #2, 100% |
| M2 | 39,983 t, #3, 100% | 7,585 t, #3, 100% | 462 t, #1, 100% | 7,267 t, #1, 100% |
| M3 | 49,777 t, #125, 0% | 7,775 t, #125, 0% | 491 t, #3, 100% | 3,426 t, #1, 100% |

## Round: hard

3 tasks: H1, H2, H3.

**Core**

| Method | Solved | hit@1 | hit@3 | Recall | Tool calls | Tokens delivered | Tokens to first answer | Latency cold (median) | Latency warm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 0/3 | 0% | 0% | 0% | 12.7 | 35,619 | n/a | 2,153 ms | n/a |
| grep+snippets | 0/3 | 0% | 0% | 0% | 8.7 | 9,515 | n/a | 2,234 ms | n/a |
| **brain-search** | 0/3 | 0% | 0% | 0% | 1.0 | 550 | n/a | 1,230 ms | 25 ms |
| **brain-context** | 1/3 | 0% | 33% | 33% | 1.0 | 5,049 | 3,490 | 1,186 ms | 41 ms |
| **brain-context-lean** | 0/3 | 0% | 0% | 0% | 1.0 | 2,599 | n/a | 1,304 ms | 36 ms |

**Advanced**

| Method | nDCG@5 | P@5 | Relevant share | Tokens per correct file | Cost per task | Cost per solved task | Latency p95 | Jitter | Context budget used | Truncated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 0.00 | 0% | 0% | n/a | $0.107 | n/a | 2,334 ms | +/-105 ms | n/a | n/a |
| grep+snippets | 0.00 | 0% | 0% | n/a | $0.029 | n/a | 2,348 ms | +/-97 ms | n/a | n/a |
| **brain-search** | 0.00 | 0% | 0% | n/a | $0.0017 | n/a | 1,442 ms | +/-60 ms | n/a | n/a |
| **brain-context** | 0.16 | 7% | 4% | 3,490 | $0.015 | $0.045 | 1,250 ms | +/-31 ms | 84% | 0% |
| **brain-context-lean** | 0.16 | 13% | 3% | n/a | $0.0078 | n/a | 1,445 ms | +/-77 ms | 130% | 67% |

**Side by side:** best without = `grep+snippets` (0/3 solved, 9,515 tokens, 2,234 ms); best with = `brain-context` (1/3 solved, 5,049 tokens, 1,186 ms cold). Verdict: brain ahead on answers.

Per task: tokens delivered, rank of the first required file, recall.

| Task | grep+read | grep+snippets | brain-search | brain-context |
| --- | --- | --- | --- | --- |
| H1 | 30,666 t, #42, 0% | 11,490 t, #42, 0% | 537 t, miss, 0% | 3,490 t, #2, 100% |
| H2 | 35,292 t, #68, 0% | 9,510 t, #68, 0% | 584 t, miss, 0% | 5,436 t, miss, 0% |
| H3 | 40,900 t, #24, 0% | 7,544 t, #24, 0% | 530 t, miss, 0% | 6,220 t, miss, 0% |

## Round: expert

3 tasks: E1, E2, E3.

**Core**

| Method | Solved | hit@1 | hit@3 | Recall | Tool calls | Tokens delivered | Tokens to first answer | Latency cold (median) | Latency warm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 0/2 | 0% | 0% | 17% | 13.0 | 33,054 | 27,571 | 2,295 ms | n/a |
| grep+snippets | 0/2 | 0% | 0% | 17% | 9.0 | 8,031 | 7,272 | 2,395 ms | n/a |
| grep | 1/1 | 0% | 100% | 100% | 1.0 | 1,078 | 1,078 | 292 ms | n/a |
| **brain-search** | 0/2 | 0% | 50% | 25% | 1.0 | 462 | 5,390 | 1,154 ms | 23 ms |
| **brain-context** | 0/2 | 50% | 50% | 25% | 1.0 | 5,344 | 6,460 | 1,198 ms | 44 ms |
| **brain-context-lean** | 0/2 | 50% | 50% | 25% | 1.0 | 2,260 | 2,342 | 1,121 ms | 35 ms |
| **brain-check** | 0/1 | 0% | 100% | 77% | 2.0 | 5,470 | 5,470 | 1,373 ms | 2 ms |

**Advanced**

| Method | nDCG@5 | P@5 | Relevant share | Tokens per correct file | Cost per task | Cost per solved task | Latency p95 | Jitter | Context budget used | Truncated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 0.17 | 30% | 22% | 27,571 | $0.099 | n/a | 2,364 ms | +/-58 ms | n/a | n/a |
| grep+snippets | 0.17 | 30% | 30% | 7,272 | $0.024 | n/a | 2,568 ms | +/-98 ms | n/a | n/a |
| grep | 0.72 | 100% | 100% | 83 | $0.0032 | $0.0032 | 303 ms | +/-12 ms | n/a | n/a |
| **brain-search** | 0.18 | 29% | 20% | 450 | $0.0014 | n/a | 1,357 ms | +/-92 ms | n/a | n/a |
| **brain-context** | 0.30 | 23% | 23% | 6,460 | $0.016 | n/a | 1,277 ms | +/-80 ms | 89% | 50% |
| **brain-context-lean** | 0.31 | 23% | 19% | 2,342 | $0.0068 | n/a | 1,253 ms | +/-77 ms | 113% | 100% |
| **brain-check** | 0.83 | 100% | 65% | 547 | $0.016 | n/a | 1,421 ms | +/-25 ms | n/a | n/a |

**Side by side:** best without = `grep` (1/1 solved, 1,078 tokens, 292 ms); best with = `brain-check` (0/1 solved, 5,470 tokens, 1,373 ms cold). Verdict: grep ahead on answers.

Per task: tokens delivered, rank of the first required file, recall.

| Task | grep+read | grep+snippets | grep | brain-search | brain-context | brain-check |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | 38,536 t, #8, 0% | 8,790 t, #8, 0% | - | 450 t, #3, 50% | 6,460 t, #1, 50% | - |
| E2 | 27,571 t, #5, 33% | 7,272 t, #5, 33% | - | 473 t, miss, 0% | 4,228 t, #10, 0% | - |
| E3 | - | - | 1,078 t, #3, 100% | - | - | 5,470 t, #2, 77% |

## Rounds side by side

| Round | Best without | Solved | Tokens | Cold latency | Best with | Solved | Tokens | Cold / warm latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| medium | `grep+snippets` | 2/3 | 6,775 | 2,496 ms | **`brain-context-lean`** | 3/3 | 2,471 | 1,132 ms / 27 ms |
| hard | `grep+snippets` | 0/3 | 9,515 | 2,234 ms | **`brain-context`** | 1/3 | 5,049 | 1,186 ms / 41 ms |
| expert | `grep` | 1/1 | 1,078 | 292 ms | **`brain-check`** | 0/1 | 5,470 | 1,373 ms / 2 ms |

Every method, per round (solved of n):

| Method | medium | hard | expert |
| --- | --- | --- | --- |
| grep+read | 2/3 | 0/3 | 0/2 |
| grep+snippets | 2/3 | 0/3 | 0/2 |
| grep | - | - | 1/1 |
| brain-search | 3/3 | 0/3 | 0/2 |
| brain-context | 3/3 | 1/3 | 0/2 |
| brain-context-lean | 3/3 | 0/3 | 0/2 |
| brain-check | - | - | 0/1 |

## Where each method fell short

- M3/grep+read (recall 0%; keywords used: server base front relative paths urls skip)
- M3/grep+snippets (recall 0%; keywords used: server base front relative paths urls skip)
- H1/grep+read (recall 0%; keywords used: route protection sends visitor logged back home page)
- H1/grep+snippets (recall 0%; keywords used: route protection sends visitor logged back home page)
- H1/brain-search (recall 0%)
- H1/brain-context-lean (recall 0%)
- H2/grep+read (recall 0%; keywords used: request fails waits short moment tries once error)
- H2/grep+snippets (recall 0%; keywords used: request fails waits short moment tries once error)
- H2/brain-search (recall 0%)
- H2/brain-context (recall 0%)
- H2/brain-context-lean (recall 0%)
- H3/grep+read (recall 0%; keywords used: robot shrink narrow container actually drawn page)
- H3/grep+snippets (recall 0%; keywords used: robot shrink narrow container actually drawn page)
- H3/brain-search (recall 0%)
- H3/brain-context (recall 0%)
- H3/brain-context-lean (recall 0%)
- E1/grep+read (recall 0%; keywords used: want idle logout time come tenant settings instead)
- E1/grep+snippets (recall 0%; keywords used: want idle logout time come tenant settings instead)
- E1/brain-search (recall 50%)
- E1/brain-context (recall 50%)
- E1/brain-context-lean (recall 50%)
- E2/grep+read (recall 33%; keywords used: want rename browser storage records user last interacted)
- E2/grep+snippets (recall 33%; keywords used: want rename browser storage records user last interacted)
- E2/brain-search (recall 0%)
- E2/brain-context (recall 0%)
- E2/brain-context-lean (recall 0%)
- E3/brain-check (recall 77%)

## Limits of this benchmark

- One repository (an Angular app) and a small number of tasks per round. The numbers are indicative, not a universal result; with 3 tasks per round a single task moves a round by 33 points.
- The without-brain agent is a fixed, mechanical strategy, not a model improvising. A smarter agent would choose better keywords; a weaker one, worse.
- Ground truth is my reading of the code. Required files drive recall; useful files are accepted extras.
- Latency excludes model time, which is driven by the token counts.
- Brain results come from a fresh index in a temporary folder; your real brain and the repo were not written to.