import { expect, test } from "bun:test";
import { join } from "node:path";

test("nightly harness exits nonzero when its result is forced to deviate", async () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const child = Bun.spawn(["bun", "run", "release:dry:nightly"], {
    cwd: root,
    env: {
      PATH: Bun.env.PATH,
      WEAVE_RELEASE_FORCE_SCENARIO_FAILURE: "same-sha",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).not.toBe(0);
});

test("stable harness exits nonzero when its result is forced to deviate", async () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const child = Bun.spawn(["bun", "run", "release:dry:stable"], {
    cwd: root,
    env: {
      PATH: Bun.env.PATH,
      WEAVE_RELEASE_FORCE_SCENARIO_FAILURE: "normal-cut",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).not.toBe(0);
});
