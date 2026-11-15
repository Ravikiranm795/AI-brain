<!-- devsarathi-version: 1.0.1 | template: 1.0.0 | generated: 2026-11-10T16:50:51.754Z | source: template@1.0.0+graph@bb29283 -->
# DevSarathi core rules

- Before editing any method, function, component, service or API, run `devsarathi impact <symbol>` and consider every reference it returns. The list can be incomplete for dynamic patterns (reflection, DI by string, runtime lookups, dynamic imports). <!-- source:template@1.0.0 -->
- Follow the stack rules in `ds-stack-node.md` and the conventions in the other `ds-*` rule files. <!-- source:template@1.0.0 -->
- Keep changes minimal and scoped to the spec. Do not refactor beyond scope without asking. <!-- source:template@1.0.0 -->
- Never read secret values, never print them, and never hard-code credentials. <!-- source:template@1.0.0 -->
- New or changed logic requires tests that follow this repo's test conventions. <!-- source:template@1.0.0 -->
- Read the spec or Jira ticket first. It is the source of truth. If anything is unclear or conflicting, stop and ask. Never guess. <!-- source:template@1.0.0 -->
- Start from the workspace map in `.claude/rules/ds-index.md`: it lists the persona, rules, agents and commands and says when each loads. <!-- source:template@1.0.0 -->
- When the task is done, hand off to Tara (`ds-tester`, `/ds-test`). Before pushing, run `/ds-review`. <!-- source:template@1.0.0 -->
