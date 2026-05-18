## Relevant Files

| File | Why It Is Relevant |
| --- | --- |
| `docs/specs/10-spec-builtin-prompt-defaults/10-spec-builtin-prompt-defaults.md` | Source spec for the implementation plan and acceptance boundaries. |
| `packages/config/prompts/loom.md` | Shipped builtin Loom prompt; must replace placeholder content. |
| `packages/config/prompts/tapestry.md` | Shipped builtin Tapestry prompt; must replace placeholder content. |
| `packages/config/prompts/shuttle.md` | Shipped builtin Shuttle prompt; must replace placeholder content. |
| `packages/config/prompts/pattern.md` | Shipped builtin Pattern prompt; must replace placeholder content. |
| `packages/config/prompts/thread.md` | Shipped builtin Thread prompt; must replace placeholder content. |
| `packages/config/prompts/spindle.md` | Shipped builtin Spindle prompt; must replace placeholder content. |
| `packages/config/prompts/weft.md` | Shipped builtin Weft prompt; must replace placeholder content. |
| `packages/config/prompts/warp.md` | Shipped builtin Warp prompt; must replace placeholder content. |
| `packages/config/src/builtins.ts` | Canonical shipped builtin DSL; add builtin `triggers` and keep builtin defaults authoritative here. |
| `packages/config/src/__tests__/builtins.test.ts` | Existing builtin-config coverage; likely place for trigger assertions and builtin-default checks. |
| `packages/config/src/__tests__/load_config.test.ts` | Existing load/merge coverage; likely place to prove zero-config builtin loading and delta-only override behavior. |
| `packages/config/src/__tests__/builtin-prompts.test.ts` | New focused test file for non-placeholder, non-leakage builtin prompt assertions if coverage should stay isolated from config-shape tests. |
| `packages/engine/src/compose.ts` | Current composed-prompt contract; use as the source of truth for delegation generation behavior. |
| `packages/engine/src/__tests__/compose.test.ts` | Existing composition coverage; may host or inspire additional prompt-composition assertions. |
| `packages/config/src/__tests__/builtin-compose-smoke.test.ts` | Preferred new integration-style smoke test using public config + engine APIs to compose builtin prompts without reimplementing path resolution. |
| `.weave/config.weave` | Local dogfood config; must shrink to delta-only overrides after builtins become authoritative. |
| `.weave/prompts/shuttle.md` | Intentional local Weave-repo Shuttle override that should remain as a true delta. |
| `.weave/prompts/weft.md` | Intentional local Weave-repo Weft override that should remain as a true delta. |
| `.weave/prompts/loom.md` | Mirror local prompt expected to be pruned once builtin defaults and builtin triggers are in place. |
| `.weave/prompts/tapestry.md` | Mirror local prompt expected to be pruned once builtin defaults are authoritative. |
| `.weave/prompts/pattern.md` | Mirror local prompt expected to be pruned once builtin defaults are authoritative. |
| `.weave/prompts/thread.md` | Mirror local prompt expected to be pruned once builtin defaults are authoritative. |
| `.weave/prompts/spindle.md` | Mirror local prompt expected to be pruned once builtin defaults are authoritative. |
| `.weave/prompts/warp.md` | Mirror local prompt expected to be pruned once builtin defaults are authoritative. |
| `docs/prompt-composition.md` | Existing prompt-composition contract doc; update if implementation details need confirmation or examples. |
| `docs/config-loading.md` | Existing canonical-source vs override-layer doc; update if implementation changes wording or examples. |
| `docs/system-architecture.md` | High-level composed-prompt wording; verify it still matches after implementation. |
| `CONTEXT.md` | Glossary source for `Composed Prompt`; verify terminology stays aligned. |

### Notes

- Unit tests should stay near the package they exercise; prefer focused assertions over brittle full prompt snapshots.
- Use repository-standard verification commands such as `bun run validate-config`, `bun test [path]`, `bun run typecheck`, and `bun run lint` as appropriate.
- Follow the current composed-prompt contract in `packages/engine/src/compose.ts`: prompt source + generated `## Delegation` + optional `prompt_append`.
- Do not encode OpenCode-only tool names or Weave-repo policy into shipped builtin prompts.

## Tasks

### [x] 1.0 Ship real product-level builtin prompt defaults

#### 1.0 Proof Artifact(s)

- Diff: `packages/config/prompts/*.md` replaces placeholder text with substantive Markdown prompts demonstrates shipped builtin defaults now exist.
- Test: `bun test packages/config/src/__tests__/builtins.test.ts [and/or builtin-prompts.test.ts]` passes demonstrates builtin prompt files are non-placeholder and free of banned repo/tool-specific leakage.
- File review: `packages/config/prompts/weft.md` and `packages/config/prompts/warp.md` show concise top-level `APPROVE` / `BLOCK` guidance demonstrates gate-style output shape is encoded in shipped defaults.

#### 1.0 Tasks

- [x] 1.1 Replace the placeholder content in all eight `packages/config/prompts/*.md` files with real Markdown prompts aligned to each builtin role.
- [x] 1.2 Restate each agent's key abstract behavioral boundaries inside the shipped prompt text where the current composer does not inject them (for example: read-only, planning-only, review-only, security-audit-only, or no delegation).
- [x] 1.3 Keep shipped prompts product-level and skill-agnostic by removing or avoiding Weave-repo-only policy, harness-specific tool names, and legacy XML prompt structure.
- [x] 1.4 Ensure shipped Loom guidance allows small/simple/local work directly while steering multi-step, specialist, review, and security-sensitive work toward delegation.
- [x] 1.5 Add or extend config-package tests so shipped builtin prompts are asserted to be present, non-empty, non-placeholder, and free of banned tokens such as `AGENTS.md`, `bun run`, `neverthrow`, `Zod`, `Task`, and `TodoWrite`/`todowrite`.

### [ ] 2.0 Promote builtin delegation triggers and prove composition works end-to-end

#### 2.0 Proof Artifact(s)

- Diff: `packages/config/src/builtins.ts` includes builtin `triggers` for shipped agents demonstrates delegation inventory moved into canonical builtin config.
- Test: `bun test packages/config/src/__tests__/builtins.test.ts` passes demonstrates builtin trigger declarations are present where expected.
- Test: `bun test packages/config/src/__tests__/builtin-compose-smoke.test.ts` passes demonstrates zero-config builtin agents compose into non-empty prompts through public config + engine APIs.
- Test: builtin compose smoke shows generated `## Delegation` output for Loom and Tapestry demonstrates delegation is rendered by the composer from config instead of hand-maintained prompt tables.
- Test: builtin compose smoke shows no generated `## Delegation` output for non-delegating builtins such as `shuttle`, `pattern`, `thread`, `spindle`, `weft`, and `warp` demonstrates current composer delegation gating remains intact.

#### 2.0 Tasks

- [ ] 2.1 Add useful shipped `triggers` blocks to `BUILTIN_WEAVE_SOURCE` in `packages/config/src/builtins.ts` so zero-config users receive delegation guidance from canonical builtin config.
- [ ] 2.2 Keep prompt files free of hand-maintained delegation inventories and rely on composer-generated `## Delegation` output instead.
- [ ] 2.3 Extend builtin config tests to cover the presence and intent of shipped builtin `triggers` without snapshotting full generated prompt text.
- [ ] 2.4 Add a config-owned integration smoke test that loads builtins through the public config API and composes each builtin descriptor through the public engine API.
- [ ] 2.5 Assert in the smoke test that all builtins compose to non-empty prompts, that delegating agents with shipped triggers produce generated `## Delegation` output according to the current composer rules, and that non-delegating builtins do not emit delegation sections.

### [ ] 3.0 Reduce dogfood drift to true local overrides and refresh validation docs

#### 3.0 Proof Artifact(s)

- Diff: `.weave/config.weave` removes mirrored builtin fields and retains only intentional local deltas demonstrates repo config no longer duplicates shipped defaults.
- Diff: `.weave/prompts/` retains only `shuttle.md` and `weft.md` as local overrides demonstrates mirror prompts were pruned.
- Diff: `.weave/config.weave` retains `prompt_file` overrides for local `shuttle` and `weft` only demonstrates the remaining repo-local prompts are still wired into project config.
- CLI: `bun run validate-config` succeeds demonstrates the cleaned local config still parses and merges correctly.
- Test: `bun test packages/config/src/__tests__/load_config.test.ts` passes demonstrates builtin defaults and project-level delta overrides still merge as intended.
- Doc review: `docs/prompt-composition.md`, `docs/config-loading.md`, `docs/system-architecture.md`, and `CONTEXT.md` remain accurate after cleanup demonstrates the documented contract still matches implementation.

#### 3.0 Tasks

- [ ] 3.1 Delete local `.weave/prompts/*.md` files that only mirror shipped builtin behavior, keeping only true local overrides for Shuttle and Weft.
- [ ] 3.2 Rewrite `.weave/prompts/shuttle.md` and `.weave/prompts/weft.md` as concise repo-specific deltas that restate critical Weave standards inline instead of depending mainly on `AGENTS.md`.
- [ ] 3.3 Update the local Shuttle override so it defines done in abstract outcomes, discovers relevant validation commands from the repo, runs the checks appropriate to the change, and reports what it used.
- [ ] 3.4 Shrink `.weave/config.weave` to delta-only overrides by removing duplicated builtin descriptions, tool policies, mirrored prompt paths, and triggers once those triggers ship in builtin config, while explicitly retaining the intentional local `prompt_file` overrides for `shuttle` and `weft`.
- [ ] 3.5 Update or extend docs/tests as needed so canonical builtin defaults, composed-prompt terminology, and delta-only local overrides remain aligned with implementation.
