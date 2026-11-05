# Brain benchmark (original-before): with the brain vs without it

Repo: `D:\monk-end-user-solution-ravikiran` @ `83725c9` (382 files under src/, 11.2 MB, about 2,934,850 tokens if read whole). Run 20261105T144407Z.
Machine: Intel(R) Core(TM) Ultra 7 155H, 22 threads, 31 GB RAM, Node v24.21.0, win32 10.0.26300.
Tasks: 19 (10 locate, 2 feature, 4 identifier, 3 impact) from `tasks.json`. Ground truth was fixed by reading the code before either method was run.

## How to read this

- **Without the brain**: an agent with only grep and read-file. Keywords come mechanically from the task text; files are ranked by keyword rarity; the top 5 are read in full (`grep+read`) or as matching lines with 3 lines of context (`grep+snippets`). For "what depends on X" it is one word-match grep (`grep`). It skips `src/assets` and caps one read at about 25k tokens, which are generous to it.
- **With the brain**: the real CLI in a cold process per call, plus the same calls in one warm process (what the MCP server pays). `brain-search` = ranked symbols; `brain-context` = search + neighbours + code in one bundle (24k-char budget); `brain-context-lean` = `-k 5 --budget 8000`; `brain-check` = search then blast-radius report.
- **Tokens** = characters / 4 for both sides (a real tokenizer differs by about 20%, the same way for both). Cost lines assume $3.00 per million input tokens.
- **Solved** = every required file was in what the method delivered. **hit@k** = a required file is among the first k candidate files. **nDCG@5** scores the first 5 candidates (required = 2, useful = 1). **P@5** = share of the first 5 candidates that are required or useful. **Relevant share** = share of delivered tokens that sit in required or useful files (the rest is noise the model must read). **Tokens to first answer** counts only tasks the method found, so read it next to Solved.
- **Latency** is retrieval only (process time and file reads), not model time. p95 is over all repetitions; jitter is the run-to-run standard deviation.

## Standing costs of the brain

| Measure | Value |
| --- | --- |
| Full index build (cold, includes loading the embedding model) | 30.4 s |
| Incremental rebuild, nothing changed | 1.1 s |
| Incremental rebuild, one file edited (freshness) | not measured |
| Peak memory during the full build | 527 MB |
| CPU time of the full build (user + system) | 346.7 s |
| Symbols / files indexed | 3,038 / 358 |
| Index size on disk | 10.4 MB (0.9x the source) |
| Warm process: open store and vectors | 32 ms |
| Warm process: first semantic query (model load) | 641 ms |
| Warm process memory (idle, model loaded) / peak | 189 MB / 207 MB |
| Without the brain | nothing to build; no extra memory or disk |

## Round: locate

10 tasks: L1, L2, L3, L4, L5, L6, L7, L8, L9, L10.

**Core**

| Method | Solved | hit@1 | hit@3 | Recall | Tool calls | Tokens delivered | Tokens to first answer | Latency cold (median) | Latency warm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 2/10 | 20% | 20% | 25% | 12.2 | 24,058 | 13,580 | 1,931 ms | n/a |
| grep+snippets | 2/10 | 20% | 20% | 25% | 8.2 | 7,751 | 6,249 | 2,085 ms | n/a |
| **brain-search** | 6/10 | 20% | 60% | 60% | 1.0 | 477 | 948 | 1,169 ms | 20 ms |
| **brain-context** | 6/10 | 50% | 70% | 60% | 1.0 | 5,571 | 5,894 | 1,188 ms | 35 ms |
| **brain-context-lean** | 6/10 | 50% | 70% | 60% | 1.0 | 2,184 | 2,360 | 1,116 ms | 31 ms |

**Advanced**

| Method | nDCG@5 | P@5 | Relevant share | Tokens per correct file | Cost per task | Cost per solved task | Latency p95 | Jitter | Context budget used | Truncated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 0.24 | 12% | 9% | 22,615 | $0.072 | $0.361 | 2,754 ms | +/-114 ms | n/a | n/a |
| grep+snippets | 0.24 | 12% | 11% | 8,414 | $0.023 | $0.116 | 2,893 ms | +/-111 ms | n/a | n/a |
| **brain-search** | 0.36 | 25% | 23% | 429 | $0.0014 | $0.0024 | 1,374 ms | +/-92 ms | n/a | n/a |
| **brain-context** | 0.55 | 26% | 13% | 5,440 | $0.017 | $0.028 | 2,540 ms | +/-202 ms | 93% | 40% |
| **brain-context-lean** | 0.52 | 27% | 26% | 2,211 | $0.0066 | $0.011 | 1,490 ms | +/-185 ms | 109% | 70% |

**Side by side:** best without = `grep+snippets` (2/10 solved, 7,751 tokens, 2,085 ms); best with = `brain-context` (6/10 solved, 5,571 tokens, 1,188 ms cold). Verdict: brain ahead on answers.

Per task: tokens delivered, rank of the first required file, recall.

| Task | grep+read | grep+snippets | brain-search | brain-context |
| --- | --- | --- | --- | --- |
| L1 | 19,923 t, #15, 0% | 4,035 t, #15, 0% | 464 t, #1, 100% | 6,420 t, #1, 100% |
| L2 | 35,934 t, miss, 0% | 6,607 t, miss, 0% | 526 t, miss, 0% | 3,486 t, #11, 0% |
| L3 | 25,561 t, #17, 0% | 7,191 t, #17, 0% | 458 t, miss, 0% | 6,705 t, miss, 0% |
| L4 | 24,044 t, #1, 100% | 10,460 t, #1, 100% | 444 t, #2, 100% | 6,545 t, #1, 100% |
| L5 | 15,711 t, #1, 100% | 7,869 t, #1, 100% | 481 t, #1, 100% | 5,156 t, #1, 100% |
| L6 | 20,901 t, #107, 0% | 6,222 t, #107, 0% | 419 t, #3, 100% | 5,442 t, #2, 100% |
| L7 | 28,090 t, #5, 50% | 6,913 t, #5, 50% | 570 t, miss, 0% | 2,345 t, #2, 0% |
| L8 | 25,046 t, #14, 0% | 13,680 t, #14, 0% | 546 t, #3, 100% | 5,219 t, #1, 100% |
| L9 | 13,835 t, #32, 0% | 5,535 t, #32, 0% | 434 t, miss, 0% | 7,810 t, miss, 0% |
| L10 | 31,537 t, #83, 0% | 8,998 t, #83, 0% | 430 t, #3, 100% | 6,579 t, #1, 100% |

## Round: feature

2 tasks: F1, F2.

**Core**

| Method | Solved | hit@1 | hit@3 | Recall | Tool calls | Tokens delivered | Tokens to first answer | Latency cold (median) | Latency warm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 0/2 | 0% | 0% | 0% | 13.0 | 38,317 | n/a | 736 ms | n/a |
| grep+snippets | 0/2 | 0% | 0% | 0% | 9.0 | 10,951 | n/a | 891 ms | n/a |
| **brain-search** | 0/2 | 0% | 0% | 0% | 1.0 | 501 | n/a | 842 ms | 45 ms |
| **brain-context** | 0/2 | 0% | 0% | 0% | 1.0 | 6,615 | n/a | 897 ms | 55 ms |
| **brain-context-lean** | 0/2 | 0% | 0% | 0% | 1.0 | 2,258 | n/a | 892 ms | 45 ms |

**Advanced**

| Method | nDCG@5 | P@5 | Relevant share | Tokens per correct file | Cost per task | Cost per solved task | Latency p95 | Jitter | Context budget used | Truncated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 0.11 | 20% | 6% | n/a | $0.115 | n/a | 830 ms | +/-43 ms | n/a | n/a |
| grep+snippets | 0.11 | 20% | 13% | n/a | $0.033 | n/a | 1,103 ms | +/-51 ms | n/a | n/a |
| **brain-search** | 0.14 | 10% | 8% | n/a | $0.0015 | n/a | 1,155 ms | +/-142 ms | n/a | n/a |
| **brain-context** | 0.20 | 20% | 30% | n/a | $0.020 | n/a | 1,151 ms | +/-89 ms | 110% | 100% |
| **brain-context-lean** | 0.14 | 10% | 7% | n/a | $0.0068 | n/a | 1,111 ms | +/-88 ms | 113% | 100% |

**Side by side:** best without = `grep+snippets` (0/2 solved, 10,951 tokens, 891 ms); best with = `brain-context` (0/2 solved, 6,615 tokens, 897 ms cold). Verdict: tied on answers.

Per task: tokens delivered, rank of the first required file, recall.

| Task | grep+read | grep+snippets | brain-search | brain-context |
| --- | --- | --- | --- | --- |
| F1 | 37,391 t, #69, 0% | 11,737 t, #69, 0% | 505 t, miss, 0% | 6,579 t, miss, 0% |
| F2 | 39,242 t, #67, 0% | 10,164 t, #67, 0% | 497 t, miss, 0% | 6,651 t, miss, 0% |

## Round: identifier

4 tasks: I1, I2, I3, I4.

**Core**

| Method | Solved | hit@1 | hit@3 | Recall | Tool calls | Tokens delivered | Tokens to first answer | Latency cold (median) | Latency warm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 4/4 | 0% | 50% | 100% | 5.0 | 9,965 | 9,722 | 99 ms | n/a |
| grep+snippets | 4/4 | 0% | 50% | 100% | 2.0 | 1,321 | 1,300 | 187 ms | n/a |
| **brain-search** | 3/4 | 0% | 75% | 75% | 1.0 | 470 | 826 | 332 ms | 1 ms |
| **brain-context** | 4/4 | 50% | 100% | 100% | 1.0 | 5,056 | 5,056 | 341 ms | 16 ms |
| **brain-context-lean** | 4/4 | 50% | 100% | 100% | 1.0 | 2,293 | 2,293 | 353 ms | 11 ms |

**Advanced**

| Method | nDCG@5 | P@5 | Relevant share | Tokens per correct file | Cost per task | Cost per solved task | Latency p95 | Jitter | Context budget used | Truncated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep+read | 0.45 | 27% | 8% | 9,965 | $0.030 | $0.030 | 145 ms | +/-14 ms | n/a | n/a |
| grep+snippets | 0.45 | 27% | 8% | 1,321 | $0.0040 | $0.0040 | 200 ms | +/-10 ms | n/a | n/a |
| **brain-search** | 0.47 | 33% | 19% | 477 | $0.0014 | $0.0019 | 836 ms | +/-31 ms | n/a | n/a |
| **brain-context** | 0.82 | 23% | 13% | 5,056 | $0.015 | $0.015 | 809 ms | +/-15 ms | 84% | 0% |
| **brain-context-lean** | 0.82 | 36% | 18% | 2,293 | $0.0069 | $0.0069 | 1,005 ms | +/-37 ms | 115% | 75% |

**Side by side:** best without = `grep+snippets` (4/4 solved, 1,321 tokens, 187 ms); best with = `brain-context-lean` (4/4 solved, 2,293 tokens, 353 ms cold). Verdict: tied on answers.

Per task: tokens delivered, rank of the first required file, recall.

| Task | grep+read | grep+snippets | brain-search | brain-context |
| --- | --- | --- | --- | --- |
| I1 | 13,232 t, #5, 100% | 1,807 t, #5, 100% | 448 t, miss, 0% | 7,221 t, #2, 100% |
| I2 | 3,577 t, #3, 100% | 1,018 t, #3, 100% | 455 t, #2, 100% | 3,649 t, #1, 100% |
| I3 | 19,242 t, #4, 100% | 1,685 t, #4, 100% | 430 t, #2, 100% | 5,413 t, #1, 100% |
| I4 | 3,810 t, #3, 100% | 772 t, #3, 100% | 547 t, #2, 100% | 3,940 t, #2, 100% |

## Round: impact

3 tasks: C1, C2, C3.

**Core**

| Method | Solved | hit@1 | hit@3 | Recall | Tool calls | Tokens delivered | Tokens to first answer | Latency cold (median) | Latency warm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep | 3/3 | 100% | 100% | 100% | 1.0 | 803 | 803 | 92 ms | n/a |
| **brain-check** | 3/3 | 100% | 100% | 100% | 2.0 | 3,531 | 3,531 | 574 ms | 2 ms |

**Advanced**

| Method | nDCG@5 | P@5 | Relevant share | Tokens per correct file | Cost per task | Cost per solved task | Latency p95 | Jitter | Context budget used | Truncated |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep | 0.90 | 93% | 79% | 223 | $0.0024 | $0.0024 | 102 ms | +/-5 ms | n/a | n/a |
| **brain-check** | 0.92 | 100% | 89% | 1,252 | $0.011 | $0.011 | 936 ms | +/-99 ms | n/a | n/a |

**Side by side:** best without = `grep` (3/3 solved, 803 tokens, 92 ms); best with = `brain-check` (3/3 solved, 3,531 tokens, 574 ms cold). Verdict: tied on answers.

Per task: tokens delivered, rank of the first required file, recall.

| Task | grep | brain-check |
| --- | --- | --- |
| C1 | 615 t, #1, 100% | 3,358 t, #1, 100% |
| C2 | 1,520 t, #1, 100% | 5,253 t, #1, 100% |
| C3 | 275 t, #1, 100% | 1,981 t, #1, 100% |

## Rounds side by side

| Round | Best without | Solved | Tokens | Cold latency | Best with | Solved | Tokens | Cold / warm latency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| locate | `grep+snippets` | 2/10 | 7,751 | 2,085 ms | **`brain-context`** | 6/10 | 5,571 | 1,188 ms / 35 ms |
| feature | `grep+snippets` | 0/2 | 10,951 | 891 ms | **`brain-context`** | 0/2 | 6,615 | 897 ms / 55 ms |
| identifier | `grep+snippets` | 4/4 | 1,321 | 187 ms | **`brain-context-lean`** | 4/4 | 2,293 | 353 ms / 11 ms |
| impact | `grep` | 3/3 | 803 | 92 ms | **`brain-check`** | 3/3 | 3,531 | 574 ms / 2 ms |

Every method, per round (solved of n):

| Method | locate | feature | identifier | impact |
| --- | --- | --- | --- | --- |
| grep+read | 2/10 | 0/2 | 4/4 | - |
| grep+snippets | 2/10 | 0/2 | 4/4 | - |
| grep | - | - | - | 3/3 |
| brain-search | 6/10 | 0/2 | 3/4 | - |
| brain-context | 6/10 | 0/2 | 4/4 | - |
| brain-context-lean | 6/10 | 0/2 | 4/4 | - |
| brain-check | - | - | - | 3/3 |

## Where each method fell short

- L1/grep+read (recall 0%; keywords used: bearer token chosen attached outgoing request including special)
- L1/grep+snippets (recall 0%; keywords used: bearer token chosen attached outgoing request including special)
- L2/grep+read (recall 0%; keywords used: notice user inactive long sign)
- L2/grep+snippets (recall 0%; keywords used: notice user inactive long sign)
- L2/brain-search (recall 0%)
- L2/brain-context (recall 0%)
- L2/brain-context-lean (recall 0%)
- L3/grep+read (recall 0%; keywords used: retry failed request exchanging refresh token access)
- L3/grep+snippets (recall 0%; keywords used: retry failed request exchanging refresh token access)
- L3/brain-search (recall 0%)
- L3/brain-context (recall 0%)
- L3/brain-context-lean (recall 0%)
- L6/grep+read (recall 0%; keywords used: tenant specific colour theme applied site loads)
- L6/grep+snippets (recall 0%; keywords used: tenant specific colour theme applied site loads)
- L7/grep+read (recall 50%; keywords used: cookie consent banner opened visitor choice saved)
- L7/grep+snippets (recall 50%; keywords used: cookie consent banner opened visitor choice saved)
- L7/brain-search (recall 0%)
- L7/brain-context (recall 0%)
- L7/brain-context-lean (recall 0%)
- L8/grep+read (recall 0%; keywords used: correct position item drag order assessment question checked)
- L8/grep+snippets (recall 0%; keywords used: correct position item drag order assessment question checked)
- L9/grep+read (recall 0%; keywords used: user activity sent analytics stream including operating system)
- L9/grep+snippets (recall 0%; keywords used: user activity sent analytics stream including operating system)
- L9/brain-search (recall 0%)
- L9/brain-context (recall 0%)
- L9/brain-context-lean (recall 0%)
- L10/grep+read (recall 0%; keywords used: service state tracked requests stop sent while backend)
- L10/grep+snippets (recall 0%; keywords used: service state tracked requests stop sent while backend)
- I1/brain-search (recall 0%)
- F1/grep+read (recall 0%; keywords used: refreshing session fails user forced show snackbar message)
- F1/grep+snippets (recall 0%; keywords used: refreshing session fails user forced show snackbar message)
- F1/brain-search (recall 0%)
- F1/brain-context (recall 0%)
- F1/brain-context-lean (recall 0%)
- F2/grep+read (recall 0%; keywords used: call global error handler existing access calls already)
- F2/grep+snippets (recall 0%; keywords used: call global error handler existing access calls already)
- F2/brain-search (recall 0%)
- F2/brain-context (recall 0%)
- F2/brain-context-lean (recall 0%)

## Limits of this benchmark

- One repository (an Angular app) and a small number of tasks per round. The numbers are indicative, not a universal result; with 3 tasks per round a single task moves a round by 33 points.
- The without-brain agent is a fixed, mechanical strategy, not a model improvising. A smarter agent would choose better keywords; a weaker one, worse.
- Ground truth is my reading of the code. Required files drive recall; useful files are accepted extras.
- Latency excludes model time, which is driven by the token counts.
- Brain results come from a fresh index in a temporary folder; your real brain and the repo were not written to.