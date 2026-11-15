---
description: Turn a short request plus the spec or Jira ticket into an accurate, ordered prompt
argument-hint: "<request>" [--spec <path> | --jira <KEY>]
allowed-tools: Bash(devsarathi *)
---
<!-- devsarathi-version: 0.1.0 | template: 1.0.0 | generated: 2026-11-10T15:19:40.013Z | source: template@1.0.0 -->
Run `devsarathi enhance $ARGUMENTS --json`. If it lists problems with the spec, show them and stop for the developer; never fill the gaps. If a Jira ticket could not be fetched, ask for a paste and pass it with `--paste`. Otherwise show the enhanced prompt as a preview and ask the developer to accept, edit or reject it, then record the answer with `devsarathi enhance --outcome accepted|edited|rejected` and carry out the accepted prompt.
