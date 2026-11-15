---
paths: ["test/**/*.js", "test/**/*.ts", "**/*.test.js", "**/*.test.ts", "**/*.spec.js", "**/*.spec.ts"]
---
<!-- devsarathi-version: 0.1.0 | template: 1.0.0 | generated: 2026-11-10T15:19:40.008Z | source: template@1.0.0+graph@bb29283 -->
# Testing

- Every new or changed behaviour gets a test; map tests to the spec's acceptance criteria. <!-- source:template@1.0.0 topic:test-required -->
- Follow the existing test style and location in this repo. <!-- source:template@1.0.0 topic:test-style -->
- Run the tests with `npm test` and report the real result; never claim a pass without running them. <!-- source:template@1.0.0 topic:test-run -->
- No test files were found in the graph. Ask before adding the first test, and match the stack's standard test location. <!-- source:graph@bb29283 topic:test-coverage-gap confidence:low evidence:bin/brain.js -->
- Tests must not depend on network access, wall-clock time or execution order. <!-- source:template@1.0.0 topic:test-isolation -->
