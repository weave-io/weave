# Dependency Graph

## Most Imported Files (change these carefully)

- `packages/adapters/pi/src/types.ts` — imported by **57** files
- `packages/cli/src/evals/types.ts` — imported by **39** files
- `packages/adapters/pi/src/strict-json.ts` — imported by **29** files
- `packages/engine/src/runtime/types.ts` — imported by **28** files
- `packages/adapters/pi/src/ui-paint.ts` — imported by **27** files
- `packages/adapters/pi/src/native-session-fs.ts` — imported by **25** files
- `packages/adapters/pi/src/child-timer.ts` — imported by **22** files
- `packages/adapters/pi/src/errors.ts` — imported by **22** files
- `packages/cli/src/theme/colors.ts` — imported by **22** files
- `scripts/release/constants.ts` — imported by **21** files
- `packages/cli/src/io/terminal.ts` — imported by **20** files
- `packages/adapters/pi/src/child-session-events.ts` — imported by **18** files
- `packages/adapters/pi/src/rpc-child.ts` — imported by **18** files
- `packages/adapters/pi/src/child-tree.ts` — imported by **18** files
- `packages/cli/src/evals/openrouter-client.ts` — imported by **18** files
- `scripts/release/errors.ts` — imported by **18** files
- `packages/cli/src/evals/report-schema.ts` — imported by **17** files
- `packages/adapters/pi/src/child-envelope.ts` — imported by **16** files
- `packages/adapters/pi/src/__tests__/fakes/test-only-session-storage-authority.ts` — imported by **16** files
- `scripts/release/stable-train.ts` — imported by **16** files

## Import Map (who imports what)

- `packages/adapters/pi/src/types.ts` ← `packages/adapters/pi/src/__tests__/agent-cycle.test.ts`, `packages/adapters/pi/src/__tests__/capability-prober.test.ts`, `packages/adapters/pi/src/__tests__/child-card-stream.test.ts`, `packages/adapters/pi/src/__tests__/child-env.test.ts`, `packages/adapters/pi/src/__tests__/child-inspection-runtime.test.ts` +52 more
- `packages/cli/src/evals/types.ts` ← `packages/cli/src/evals/__tests__/case-loader.test.ts`, `packages/cli/src/evals/__tests__/case-loader.test.ts`, `packages/cli/src/evals/__tests__/dashboard-indexes.test.ts`, `packages/cli/src/evals/__tests__/github-contents-publisher.test.ts`, `packages/cli/src/evals/__tests__/input-validation.test.ts` +34 more
- `packages/adapters/pi/src/strict-json.ts` ← `packages/adapters/pi/src/__tests__/child-compaction-settlement.test.ts`, `packages/adapters/pi/src/__tests__/child-diagnostic-wire-budget.test.ts`, `packages/adapters/pi/src/__tests__/child-envelope.test.ts`, `packages/adapters/pi/src/__tests__/child-inspection-integration.test.ts`, `packages/adapters/pi/src/__tests__/child-mode.test.ts` +24 more
- `packages/engine/src/runtime/types.ts` ← `packages/engine/src/__tests__/runtime-command-operations.test.ts`, `packages/engine/src/__tests__/runtime-contract.test.ts`, `packages/engine/src/__tests__/runtime-contract.test.ts`, `packages/engine/src/__tests__/runtime-contract.test.ts`, `packages/engine/src/__tests__/runtime-contract.test.ts` +23 more
- `packages/adapters/pi/src/ui-paint.ts` ← `packages/adapters/pi/src/__tests__/child-card-render.test.ts`, `packages/adapters/pi/src/__tests__/child-card-stream.test.ts`, `packages/adapters/pi/src/__tests__/child-overlay-internal-entry-suppression.test.ts`, `packages/adapters/pi/src/__tests__/child-overlay-layout.test.ts`, `packages/adapters/pi/src/__tests__/child-overlay-live-proof-regressions.test.ts` +22 more
- `packages/adapters/pi/src/native-session-fs.ts` ← `packages/adapters/pi/src/__tests__/adapter-cli-commands.test.ts`, `packages/adapters/pi/src/__tests__/adapter-cli-production-delete.test.ts`, `packages/adapters/pi/src/__tests__/child-historical-overlay-restart.test.ts`, `packages/adapters/pi/src/__tests__/child-native-session-bounded-reads.test.ts`, `packages/adapters/pi/src/__tests__/child-native-session-create.integration.test.ts` +20 more
- `packages/adapters/pi/src/child-timer.ts` ← `packages/adapters/pi/src/__tests__/child-card-stream.test.ts`, `packages/adapters/pi/src/__tests__/child-compaction-settlement.test.ts`, `packages/adapters/pi/src/__tests__/child-inspection-integration.test.ts`, `packages/adapters/pi/src/__tests__/child-mode.test.ts`, `packages/adapters/pi/src/__tests__/child-overlay-live-render-parity.test.ts` +17 more
- `packages/adapters/pi/src/errors.ts` ← `packages/adapters/pi/src/__tests__/child-mode.test.ts`, `packages/adapters/pi/src/__tests__/child-transfer.test.ts`, `packages/adapters/pi/src/__tests__/delegation-invocation-context.test.ts`, `packages/adapters/pi/src/__tests__/extension.test.ts`, `packages/adapters/pi/src/__tests__/plan-catalog.test.ts` +17 more
- `packages/cli/src/theme/colors.ts` ← `packages/cli/src/__tests__/theme.test.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/__tests__/adapter.test.ts`, `packages/cli/src/commands/__tests__/eval.test.ts`, `packages/cli/src/commands/__tests__/init.test.ts` +17 more
- `scripts/release/constants.ts` ← `scripts/build-public-packages-pi.ts`, `scripts/release/__tests__/changelog-format.test.ts`, `scripts/release/__tests__/changeset-consumption.test.ts`, `scripts/release/__tests__/channel-versions.test.ts`, `scripts/release/__tests__/consumption-ledger.test.ts` +16 more
