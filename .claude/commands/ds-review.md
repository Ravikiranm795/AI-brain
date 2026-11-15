---
description: Full review of the current changes: security, impact, tests and spec. Same command the pre-push hook runs
allowed-tools: Bash(devsarathi *)
---
<!-- devsarathi-version: 0.1.0 | template: 1.0.0 | generated: 2026-11-10T15:19:40.013Z | source: template@1.0.0 -->
Run `devsarathi review --json`. Print the numbered findings, red flags first. If any agent run shows status other than `completed`, print `<agent> did not run: <error>`; that is never a clean review. Then, acting as `ds-peer-review`, check each caller listed under untouched callers and add comments. Do not change code.
