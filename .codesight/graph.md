# Dependency Graph

## Most Imported Files (change these carefully)

- `packages/cli/src/evals/types.ts` — imported by **39** files
- `packages/engine/src/runtime/types.ts` — imported by **29** files
- `packages/adapters/pi/src/types.ts` — imported by **27** files
- `packages/cli/src/theme/colors.ts` — imported by **20** files
- `packages/cli/src/io/terminal.ts` — imported by **18** files
- `packages/cli/src/evals/openrouter-client.ts` — imported by **18** files
- `packages/cli/src/evals/report-schema.ts` — imported by **17** files
- `packages/engine/src/runtime/store.ts` — imported by **16** files
- `scripts/release/stable-train.ts` — imported by **16** files
- `scripts/release/npm-registry-client.ts` — imported by **15** files
- `packages/cli/src/args.ts` — imported by **14** files
- `packages/engine/src/tool-policy.ts` — imported by **14** files
- `scripts/release/model.ts` — imported by **14** files
- `packages/engine/src/logger.ts` — imported by **13** files
- `scripts/release/filesystem.ts` — imported by **13** files
- `scripts/release/clock.ts` — imported by **13** files
- `packages/adapters/pi/src/strict-json.ts` — imported by **12** files
- `packages/cli/src/fs/file-system.ts` — imported by **12** files
- `packages/engine/src/runtime/errors.ts` — imported by **12** files
- `packages/engine/src/compose.ts` — imported by **11** files

## Import Map (who imports what)

- `packages/cli/src/evals/types.ts` ← `packages/cli/src/evals/__tests__/case-loader.test.ts`, `packages/cli/src/evals/__tests__/case-loader.test.ts`, `packages/cli/src/evals/__tests__/dashboard-indexes.test.ts`, `packages/cli/src/evals/__tests__/github-contents-publisher.test.ts`, `packages/cli/src/evals/__tests__/input-validation.test.ts` +34 more
- `packages/engine/src/runtime/types.ts` ← `packages/engine/src/__tests__/runtime-command-operations.test.ts`, `packages/engine/src/__tests__/runtime-contract.test.ts`, `packages/engine/src/__tests__/runtime-contract.test.ts`, `packages/engine/src/__tests__/runtime-contract.test.ts`, `packages/engine/src/__tests__/runtime-contract.test.ts` +24 more
- `packages/adapters/pi/src/types.ts` ← `packages/adapters/pi/src/__tests__/capability-prober.test.ts`, `packages/adapters/pi/src/__tests__/child-runtime.test.ts`, `packages/adapters/pi/src/__tests__/controller.test.ts`, `packages/adapters/pi/src/__tests__/delegation-tool.test.ts`, `packages/adapters/pi/src/__tests__/extension-tool-governance.test.ts` +22 more
- `packages/cli/src/theme/colors.ts` ← `packages/cli/src/__tests__/theme.test.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/__tests__/eval.test.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/migrate-conversion.test.ts` +15 more
- `packages/cli/src/io/terminal.ts` ← `packages/cli/src/__tests__/routing.test.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/__tests__/eval.test.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/migrate-conversion.test.ts` +13 more
- `packages/cli/src/evals/openrouter-client.ts` ← `packages/cli/src/evals/__tests__/loom-routing-runner.test.ts`, `packages/cli/src/evals/__tests__/pattern-planning-runner.test.ts`, `packages/cli/src/evals/__tests__/runner.test.ts`, `packages/cli/src/evals/__tests__/shuttle-execution-runner.test.ts`, `packages/cli/src/evals/__tests__/spindle-tools-runner.test.ts` +13 more
- `packages/cli/src/evals/report-schema.ts` ← `packages/cli/src/evals/__tests__/artifact-bundle.test.ts`, `packages/cli/src/evals/__tests__/artifact-bundle.test.ts`, `packages/cli/src/evals/__tests__/artifact-bundle.test.ts`, `packages/cli/src/evals/__tests__/artifact-bundle.test.ts`, `packages/cli/src/evals/__tests__/artifact-bundle.test.ts` +12 more
- `packages/engine/src/runtime/store.ts` ← `packages/engine/src/__tests__/permission-service.test.ts`, `packages/engine/src/__tests__/runtime-journal.test.ts`, `packages/engine/src/execution-lifecycle/artifacts.ts`, `packages/engine/src/execution-lifecycle/dispatch.ts`, `packages/engine/src/execution-lifecycle/inspection.ts` +11 more
- `scripts/release/stable-train.ts` ← `scripts/release/__tests__/artifact-manifest.test.ts`, `scripts/release/__tests__/control-executable.test.ts`, `scripts/release/__tests__/github-client.test.ts`, `scripts/release/__tests__/metadata-replay.test.ts`, `scripts/release/__tests__/payload-layout.e2e.test.ts` +11 more
- `scripts/release/npm-registry-client.ts` ← `scripts/release/__tests__/github-client.test.ts`, `scripts/release/__tests__/nightly-plan.test.ts`, `scripts/release/__tests__/npm-registry-client.test.ts`, `scripts/release/__tests__/payload-layout.e2e.test.ts`, `scripts/release/__tests__/promotion-commands.test.ts` +10 more
