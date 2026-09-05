/**
 * Tests for `opencode-trajectory-runner-adapter.ts` — the thin CLI-side
 * bridge that constructs the production `TrajectoryRunner` and the
 * `--dry-run` sandbox image existence checker.
 *
 * `checkSandboxImageExists` is exercised directly here (it shells out to
 * `podman image inspect`, which is read-only and safe to run in CI even
 * without a real sandbox image built - a missing/absent podman binary or
 * image resolves to `false`, never a thrown exception or hung process).
 *
 * `createProductionTrajectoryRunner` is NOT invoked here with real Podman -
 * that would require a live sandbox image and defeats the purpose of an
 * isolated unit test. Its wiring is instead covered by
 * `loom-routing-runner.trajectory.test.ts`, which injects a stub
 * `TrajectoryRunner` in place of this bridge's production return value.
 */

import { describe, expect, it } from "bun:test";
import { checkSandboxImageExists } from "../opencode-trajectory-runner-adapter.js";

describe("checkSandboxImageExists", () => {
  it("resolves ok(false) for an unknown sandbox profile without spawning podman", async () => {
    const result = await checkSandboxImageExists("not-a-real-profile");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(false);
    }
  });

  it("resolves ok(boolean) - never rejects - for a known sandbox profile even when podman/the image is unavailable", async () => {
    const result = await checkSandboxImageExists("opencode-default");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(typeof result.value).toBe("boolean");
    }
  });
});
