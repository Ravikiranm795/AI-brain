---
paths: ["src/**/*.js", "src/**/*.mjs", "src/**/*.ts", "lib/**/*.js", "bin/**/*.js"]
---
<!-- devsarathi-version: 0.1.0 | template: 1.0.0 | generated: 2026-11-10T15:19:40.008Z | source: template@1.0.0+graph@bb29283 -->
# Architecture

- Put new code where similar code already lives; do not create a new top-level folder without asking. <!-- source:template@1.0.0 topic:placement -->
- Respect module boundaries: do not import across feature areas unless the dependency already exists. <!-- source:template@1.0.0 topic:module-boundaries -->
- Source code lives under `src/` (14 of 16 source files). Put new code in the matching folder. <!-- source:graph@bb29283 topic:structure confidence:high evidence:src/buildBrain.js,src/config.js,src/embedder.js -->
- Keep business logic out of controllers, components and route handlers; put it in a service or domain layer. <!-- source:template@1.0.0 topic:layering -->
- Prefer extending an existing abstraction over adding a parallel one. <!-- source:template@1.0.0 topic:reuse -->
