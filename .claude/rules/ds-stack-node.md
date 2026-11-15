---
paths: ["src/**/*.js", "src/**/*.mjs", "src/**/*.ts", "lib/**/*.js", "bin/**/*.js", "test/**/*.js", "test/**/*.ts", "**/*.test.js", "**/*.test.ts", "**/*.spec.js", "**/*.spec.ts"]
---
<!-- devsarathi-version: 0.1.0 | template: 1.0.0 | generated: 2026-11-10T15:19:40.008Z | source: template@1.0.0+graph@bb29283 -->
# Node.js rules

- Do not read `process.env` values into logs or error messages, and never hard-code credentials. <!-- source:template@1.0.0 topic:secrets -->
- Handle every rejected promise: no floating promises, and `await` inside `try`/`catch` where failure is expected. <!-- source:template@1.0.0 topic:async -->
- Never build a shell command from input: use `execFile`/`spawn` with an argument array, not `exec` with a template string. <!-- source:template@1.0.0 topic:shell -->
- Use `path.join`/`path.resolve` for file paths and reject paths that escape the intended folder. <!-- source:template@1.0.0 topic:paths -->
- Validate input at the boundary (CLI flags, request bodies, file contents) before it reaches the logic. <!-- source:template@1.0.0 topic:validation -->
- Keep modules small and single-purpose; share code through exports, not globals. <!-- source:template@1.0.0 topic:layering -->
- Put tests under `test/` next to the module name, using the repo's existing test runner. <!-- source:template@1.0.0 topic:test-location -->
