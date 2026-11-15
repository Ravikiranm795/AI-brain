---
description: Run the tester: tests exist for changed logic, run them, map to acceptance criteria
allowed-tools: Bash(devsarathi *)
---
<!-- devsarathi-version: 0.1.0 | template: 1.0.0 | generated: 2026-11-10T15:19:40.013Z | source: template@1.0.0 -->
Delegate to the `ds-tester` agent. It runs `devsarathi test --json` and reports pass, fail or incomplete. Never report a pass for a run that did not complete.
