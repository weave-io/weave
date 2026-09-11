#!/usr/bin/env bun
/**
 * Convenience entry point for running the gated live-CLI Copilot adapter
 * smoke test (see `../src/__tests__/live-cli.test.ts`).
 *
 * The live test is skipped by default (`bun test` without env set). This
 * script sets `WEAVE_COPILOT_LIVE=1` and filters to tests matching "live" so
 * the gated E2E test actually executes, assuming a real `copilot` binary is
 * discoverable on `PATH`.
 *
 * Usage:
 *   bun run packages/adapters/copilot/scripts/test-live.ts
 */

const proc = Bun.spawn(
  ["bun", "test", "packages/adapters/copilot", "-t", "live"],
  {
    env: { ...process.env, WEAVE_COPILOT_LIVE: "1" },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  },
);

const exitCode = await proc.exited;
process.exit(exitCode);
