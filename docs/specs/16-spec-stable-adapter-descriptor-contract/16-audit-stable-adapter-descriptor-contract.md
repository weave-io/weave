# 16-audit-stable-adapter-descriptor-contract.md

## Executive Summary

- Overall Status: PASS
- Required Gate Failures: 0
- Flagged Risks: 0

## Gateboard

| Gate | Status | Why it failed (<=10 words) | Exact fix target |
| --- | --- | --- | --- |
| Requirement-to-test traceability | PASS | n/a | n/a |
| Proof artifact verifiability | PASS | n/a | n/a |
| Repository standards consistency | PASS | n/a | n/a |
| Open question resolution | PASS | n/a | n/a |
| Regression-risk blind spots | PASS | n/a | n/a |
| Non-goal leakage | PASS | n/a | n/a |

## Standards Evidence Table (Required)

| Source File | Read | Standards Extracted | Conflicts |
| --- | --- | --- | --- |
| `AGENTS.md` | yes | Bun-only runtime; engine/adapter boundary must follow `docs/adapter-boundary.md`; use `neverthrow`, isolated mock tests, and living docs | none |
| `README.md` | yes | TypeScript-first harness-agnostic API; `@weaveio/weave-engine` owns pure composition APIs; use `bun run build`, `bun run typecheck`, `bun run test` | none |
| `docs/adapter-boundary.md` | yes | Engine owns normalized descriptors; adapters own discovery/materialization; `AgentDescriptor` fields are adapter-facing and harness-neutral | none |
| `docs/product-vision.md` | yes | Weave returns normalized descriptors/prompts/policies; adapters own model lookup, skill discovery, concrete tool names, and display-name mapping | none |
| `package.json` | yes | Workspace scripts: `lint`, `typecheck`, `build`, `test`; lint-staged runs Biome check/write | none |
| `packages/engine/package.json` | yes | Engine scripts: `build`, `test`, `typecheck`; engine depends on `neverthrow`, `pino`, `zod`, `mustache` | none |
| `.github/workflows/ci.yml` | yes | CI installs with Bun 1.3.10 and runs lint, typecheck, build, test | none |
| `biome.json` | yes | 2-space formatting; double quotes and semicolons; no explicit `any`, no console, no nested ternary, kebab/snake file names | none |
| `bunfig.toml` | yes | Bun test timeout 5000ms; smol mode; preload `scripts/test-setup.ts` | none |
| `tsconfig.json` | yes | Strict TypeScript; module resolution `bundler`; `bun-types`; source paths for `@weaveio/*` packages | none |
| `CONTRIBUTING.md` | not found | n/a | none |
| `.github/pull_request_template.md` | not found | n/a | none |
