/**
 * MANUAL-RUN LIVE TEST — not part of normal CI.
 *
 * This test spawns a real Podman container running the OpenCode harness
 * against a real OpenRouter model. It exists to catch regressions when the
 * OpenCode log format changes (see `log-parser.ts`), since the unit tests in
 * `opencode-trajectory-runner.test.ts` only exercise canned/fixture stderr.
 *
 * How to run:
 *
 *   WEAVE_EVAL_LIVE_TRAJECTORY=1 OPENROUTER_API_KEY=sk-or-... \
 *     bun test packages/adapters/opencode/src/trajectory/__tests__/opencode-trajectory-runner.live.test.ts
 *
 * Prerequisites:
 *   - Podman installed and the `weave-sandbox-opencode-default` image built
 *     (see `sandboxes/opencode/README.md`).
 *   - A valid `OPENROUTER_API_KEY` with access to `openai/gpt-4o-mini`.
 *
 * Expected runtime: ~2 minutes (bounded by the case's
 * `max_duration_seconds: 120`).
 *
 * When `WEAVE_EVAL_LIVE_TRAJECTORY` is unset, this test skips cleanly via
 * `it.skipIf` and performs no I/O.
 */

import { describe, expect, it } from "bun:test";
import type { TrajectoryCase } from "@weaveio/weave-core";
import { okAsync } from "neverthrow";
import {
  DefaultLogParser,
  EphemeralWorkspaceFactory,
  OpenCodeTrajectoryRunner,
  type PromptProvider,
} from "../opencode-trajectory-runner.js";
import { BunPodmanClient } from "../podman-client.js";

const CASE_ID = "loom-route-shuttle-implement-utility-trajectory";
const MODEL = "openai/gpt-4o-mini";

const isLive = process.env.WEAVE_EVAL_LIVE_TRAJECTORY === "1";
const apiKey = process.env.OPENROUTER_API_KEY;
const shouldRun = isLive && apiKey !== undefined && apiKey.length > 0;

class CaseFilePromptProvider implements PromptProvider {
  getPrompt(testCase: TrajectoryCase): ReturnType<PromptProvider["getPrompt"]> {
    void testCase;
    // The case's `description` field doubles as the harness prompt for
    // harness-trajectory eval cases.
    return okAsync(
      "Choose the primary implementation route for this text-only task: add a debounce utility function to the shared frontend utils module and wire it into the search input handler.",
    );
  }
}

describe("OpenCodeTrajectoryRunner (live)", () => {
  it.skipIf(!shouldRun)(
    "exercises the full pipeline against a real Podman sandbox and OpenRouter model",
    async () => {
      const testCase: TrajectoryCase = {
        testCaseId: CASE_ID,
        expectedSpawns: ["shuttle"],
        expectedTools: ["edit"],
        maxDurationSeconds: 120,
        sandboxProfile: "opencode-default",
      };

      const runner = new OpenCodeTrajectoryRunner({
        podmanClient: new BunPodmanClient(),
        logParser: new DefaultLogParser(),
        promptProvider: new CaseFilePromptProvider(),
        workspaceFactory: new EphemeralWorkspaceFactory(),
        openRouterApiKey: apiKey ?? "",
        repoRoot: process.cwd(),
      });

      const start = Date.now();
      const result = await runner.run(testCase, MODEL, {
        root: "unused-placeholder-root",
        artifactsDir: "unused-placeholder-artifacts",
      });
      const elapsedSeconds = (Date.now() - start) / 1000;

      result.match(
        (trajectoryResult) => {
          const { summary } = trajectoryResult;
          expect(summary.harnessDelegatedCorrectly).toBe(true);
          expect(summary.observedSpawns).toContain("shuttle");
          expect(summary.observedToolCalls).toBeGreaterThanOrEqual(1);
          expect(summary.harnessCompletedWithoutError).toBe(true);
        },
        (error) => {
          throw new Error(
            `live trajectory run failed: ${JSON.stringify(error)}`,
          );
        },
      );

      expect(elapsedSeconds).toBeLessThan(120);
    },
    150_000,
  );
});
