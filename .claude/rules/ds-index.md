<!-- devsarathi-version: 1.0.1 | template: 1.0.0 | generated: 2026-11-10T16:50:51.842Z | source: template@1.0.0 -->
# DevSarathi workspace map

This repo is set up with DevSarathi. Everything below lives in `.claude/` and `.claude/devsarathi/` and stays on this machine. Read this file first: it says what exists, when each piece loads, and what to run.

## Who you are

You work as **Ravi, Node.js Developer**. The persona is defined in `.claude/rules/ds-persona.md` (always loaded) and is also available as the subagent `ds-developer`. If another persona file exists in this repo, follow the one the user addresses by name; the standards in the DevSarathi rules apply to all of them.

## Stack

**Node.js**: frameworks MCP SDK, Commander CLI; tests node:test; build npm scripts.

Commands for this repo: test `npm test`; lint `npm run lint`; build `npm run build`.

## How to work on a task

1. Run `/ds-status`. It shows how fresh the graph is, whether your branch is behind the baseline, and any rule changes waiting for approval.
2. Read the spec or Jira ticket. It is the source of truth. If it is vague or conflicts with the code, stop and ask. For a short request, run `/ds-enhance "<request>" --spec <path>` to turn it into an ordered prompt with real files, symbols and acceptance criteria.
3. Before you edit any method, function, component, service or API, run `/ds-impact <symbol>` and consider every reference it returns, plus the confidence grade and the reasons for it. The list can miss reflection, DI by string, runtime lookups and dynamic imports.
4. Make the smallest change that satisfies the spec. Follow the stack rules and the conventions below.
5. Add or update tests that follow this repo's test conventions, then hand off to Tara (`ds-tester`, `/ds-test`).
6. Before you push, run `/ds-review`. It is the same review the pre-push hook runs. Hooks warn and never block.

## Rule files in `.claude/rules/`

| File | Loads | Covers |
|------|-------|--------|
| `ds-core.md` | always | The short, strict rules: spec first, impact before edits, minimal scope, tests, no secrets |
| `ds-architecture.md` | on demand: src/**/*.js, src/**/*.mjs, src/**/*.ts, lib/**/*.js, bin/**/*.js | Structure, module boundaries, layering, dependency injection, routes seen in the graph |
| `ds-naming-style.md` | on demand: src/**/*.js, src/**/*.mjs, src/**/*.ts, lib/**/*.js, bin/**/*.js | File and symbol naming observed in this repo, lint and style |
| `ds-testing.md` | on demand: test/**/*.js, test/**/*.ts, **/*.test.js, **/*.test.ts, **/*.spec.js, **/*.spec.ts | Where tests live, how they are named, how to run them |
| `ds-stack-node.md` | on demand: src/**/*.js, src/**/*.mjs, src/**/*.ts, lib/**/*.js, bin/**/*.js, test/**/*.js, test/**/*.ts, **/*.test.js, **/*.test.ts, **/*.spec.js, **/*.spec.ts | Strict node rules: dependency injection, layering, security, tests |
| `ds-index.md` | always | This map: what exists, when it loads, what to run |
| `ds-persona.md` | always | Who you are in this repo, principles and hand-offs |

Rules marked "on demand" load when you read or edit a file that matches their paths. Each graph-derived rule carries `source`, `confidence` and `evidence` comments: a rule with low confidence is a hint, not a law, and the developer's own edits always win.

## Subagents in `.claude/agents/`

| Name | Agent | Use it when |
|------|-------|-------------|
| Ravi | `ds-developer` | Implements a spec or ticket with the persona, impact lookup before every edit, then hands off to ds-tester |
| Tara | `ds-tester` | Checks changed logic has tests, runs the stack test command, maps results to acceptance criteria. Read-only |
| Raksha | `ds-security` | Reviews the staged and unpushed diff for secrets, injection, unsafe configuration and risky dependency changes. Read-only |
| Mitra | `ds-peer-review` | Reviews the diff against the spec, the rules and the impact list; checks every caller was considered. Read-only |
| Lekha | `ds-auditor` | Audits these generated files for contradictions, duplicates, vague rules, missing evidence and broken references. Never edits |

## Slash commands in `.claude/commands/`

| Command | What it does |
|---------|--------------|
| `/ds-status` | DevSarathi status: graph age, baseline commit, branch drift, pending rule changes |
| `/ds-impact <symbol> | --file <path>` | Impact lookup before editing a symbol or file |
| `/ds-review` | Full review of the current changes: security, impact, tests and spec. Same command the pre-push hook runs |
| `/ds-test` | Run the tester: tests exist for changed logic, run them, map to acceptance criteria |
| `/ds-enhance "<request>" [--spec <path> | --jira <KEY>]` | Turn a short request plus the spec or Jira ticket into an accurate, ordered prompt |
| `/ds-refresh` | Incrementally refresh the graph and propose rule updates |
| `/ds-graph-build [--full] [--current]` | Build the Drishti graph (baseline by default) |
| `/ds-rules pending | approve <id> | reject <id>` | List and decide pending rule changes |
| `/ds-metrics [--report]` | Show local metrics and regenerate the reports |
| `/ds-dashboard` | Open the local dashboard |
| `/ds-selftest` | Run the planted-problem self-test |
| `/ds-skills` | Optional: research and install Claude skills for this stack |
| `/ds-migrate` | Bring generated files up to the installed DevSarathi version |
| `/ds-disable` | Kill switch: turn off all DevSarathi hooks and automatic behavior |
| `/ds-enable` | Turn DevSarathi hooks and automatic behavior back on |

## Where DevSarathi keeps its state

| Path | What it holds |
|------|---------------|
| `.claude/devsarathi/config.json` | Baseline branch, persona, thresholds, kill switch, the list of files DevSarathi owns |
| `.claude/devsarathi/graph/` | The Drishti graph and `build-record.json` (branch, commit, time, coverage) |
| `.claude/devsarathi/reviews/` | Results of every review, test run and audit |
| `.claude/devsarathi/metrics/` | Local metrics (counts and timings only) |
| `.claude/devsarathi/changelog.md` | Every automatic or approved rule change, with its reason |
| `.claude/devsarathi/notices.jsonl` | Notices from hooks and background runs |

## Never

1. Read, print or hard-code secret values. `.env` and key files are never read; only their path is known.
2. Edit a file under `.claude/` that carries a DevSarathi stamp without asking: the developer's edits win, and generated files are refreshed with `devsarathi migrate`.
3. Treat a review, test run or audit that did not complete as a pass. Report "did not run" and why.
4. Work around the kill switch. `devsarathi disable` turns every hook and automatic behavior off; `devsarathi enable` turns them back on.
