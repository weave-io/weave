import { describe, expect, it } from "bun:test";
import {
  bunfigPreloadsTestSetup,
  checkTestCoverage,
  describeTestCoverageError,
  isNoOpTestScript,
  readWorkspacePackages,
} from "../verify-test-coverage.js";

const REAL = "bun test ./src";

const GOOD_BUNFIG = `[test]
timeout = 5000
preload = ["../../scripts/test-setup.ts", "@opentui/solid/preload"]
`;

/** A package that satisfies the bunfig requirement. */
function pkg(name: string, testScript: string | undefined) {
  return { name, path: `packages/${name}`, testScript, bunfig: GOOD_BUNFIG };
}

/**
 * A package with a specific bunfig — `undefined` meaning none at all.
 *
 * Kept separate from `pkg` because a default parameter would swallow an
 * explicitly passed `undefined` and silently hand back the good bunfig.
 */
function pkgWithBunfig(
  name: string,
  testScript: string | undefined,
  bunfig: string | undefined,
) {
  return { name, path: `packages/${name}`, testScript, bunfig };
}

/** The two packages the real policy exempts, so fixtures do not trip it. */
const EXEMPT_PACKAGES = [
  pkgWithBunfig("@weaveio/weave-docs", "echo 'No tests'", undefined),
  pkgWithBunfig(
    "@weaveio/weave-adapter-pi",
    "bun -e 'process.exit(0)'",
    undefined,
  ),
];

function withExempt(packages: ReturnType<typeof pkgWithBunfig>[]) {
  return [...packages, ...EXEMPT_PACKAGES];
}

describe("isNoOpTestScript", () => {
  it.each([
    ["echo form", "echo 'No tests for @weaveio/weave-docs'"],
    ["bun exit form", "bun -e 'process.exit(0)'"],
    ["bare true", "true"],
    ["bare exit", "exit 0"],
    ["leading whitespace", "  echo nothing  "],
  ])("treats the %s as running nothing", (_label, script) => {
    expect(isNoOpTestScript(script)).toBe(true);
  });

  it.each([
    ["package glob", "bun test ./src"],
    ["explicit dirs", "bun test ./src/__tests__ ./src/commands/__tests__"],
    ["recursive", "bun test --recursive"],
  ])("accepts the %s as a real test run", (_label, script) => {
    expect(isNoOpTestScript(script)).toBe(false);
  });
});

describe("checkTestCoverage", () => {
  it("passes when every non-exempt package runs tests", () => {
    const result = checkTestCoverage(
      withExempt([pkg("core", REAL), pkg("engine", REAL)]),
    );

    expect(result.isOk()).toBe(true);
  });

  it("fails a package with no test script — the gap that hid opencode2 and claude-code from CI", () => {
    const result = checkTestCoverage(
      withExempt([pkg("core", REAL), pkg("adapter-new", undefined)]),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual([
      {
        type: "MissingTestScript",
        packageName: "adapter-new",
        path: "packages/adapter-new",
      },
    ]);
  });

  it("fails a test script that only pretends to run tests", () => {
    const result = checkTestCoverage(
      withExempt([pkg("adapter-new", "bun -e 'process.exit(0)'")]),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()[0]).toMatchObject({
      type: "NoOpTestScript",
      packageName: "adapter-new",
    });
  });

  it("reports every offending package rather than stopping at the first", () => {
    const result = checkTestCoverage(
      withExempt([
        pkg("a", undefined),
        pkg("b", "echo nope"),
        pkg("c", REAL),
        pkg("d", undefined),
      ]),
    );

    const names = result
      ._unsafeUnwrapErr()
      .filter((e) => e.type !== "WorkspaceReadFailure")
      .map((e) => e.packageName);
    expect(names).toEqual(["a", "b", "d"]);
  });

  it("flags an exemption left behind after its package is gone", () => {
    const result = checkTestCoverage([pkg("core", REAL)]);

    const stale = result
      ._unsafeUnwrapErr()
      .filter((e) => e.type === "StaleExemption")
      .map((e) => e.packageName);
    expect(stale).toEqual(["@weaveio/weave-docs", "@weaveio/weave-adapter-pi"]);
  });

  it("explains each failure in terms a contributor can act on", () => {
    const result = checkTestCoverage(
      withExempt([pkg("adapter-new", undefined)]),
    );
    const message = describeTestCoverageError(result._unsafeUnwrapErr()[0]!);

    expect(message).toContain("adapter-new");
    expect(message).toContain("EXEMPT");
  });
});

describe("bunfigPreloadsTestSetup", () => {
  it("accepts a [test] section that preloads the shared setup", () => {
    expect(bunfigPreloadsTestSetup(GOOD_BUNFIG)).toBe(true);
  });

  it("accepts the deeper relative path adapters need", () => {
    const bunfig = `[test]\npreload = ["../../../scripts/test-setup.ts"]\n`;
    expect(bunfigPreloadsTestSetup(bunfig)).toBe(true);
  });

  it("rejects a bunfig with no [test] section", () => {
    expect(bunfigPreloadsTestSetup("[install]\nexact = false\n")).toBe(false);
  });

  it("rejects a top-level preload, which bun test ignores", () => {
    const bunfig = `preload = ["../../scripts/test-setup.ts"]\n\n[test]\ntimeout = 5000\n`;
    expect(bunfigPreloadsTestSetup(bunfig)).toBe(false);
  });

  it("rejects a preload declared under a later, unrelated section", () => {
    const bunfig = `[test]\ntimeout = 5000\n\n[install]\npreload = ["../../scripts/test-setup.ts"]\n`;
    expect(bunfigPreloadsTestSetup(bunfig)).toBe(false);
  });
});

describe("checkTestCoverage — hermetic preload", () => {
  it("fails a package with no bunfig, whose tests would skip the shared preload", () => {
    const result = checkTestCoverage(
      withExempt([pkgWithBunfig("adapter-new", REAL, undefined)]),
    );

    expect(result._unsafeUnwrapErr()[0]).toMatchObject({
      type: "MissingBunfig",
      packageName: "adapter-new",
    });
  });

  it("fails a bunfig that exists but does not preload the shared setup", () => {
    const result = checkTestCoverage(
      withExempt([
        pkgWithBunfig("adapter-new", REAL, "[test]\ntimeout = 5000\n"),
      ]),
    );

    expect(result._unsafeUnwrapErr()[0]).toMatchObject({
      type: "BunfigMissingPreload",
      packageName: "adapter-new",
    });
  });

  it("explains why the missing preload matters", () => {
    const result = checkTestCoverage(
      withExempt([pkgWithBunfig("adapter-new", REAL, undefined)]),
    );
    const message = describeTestCoverageError(result._unsafeUnwrapErr()[0]!);

    expect(message).toContain("WEAVE_GLOBAL_CONFIG_DIR");
  });
});

describe("the repository itself", () => {
  it("satisfies the guard", async () => {
    const result = checkTestCoverage(await readWorkspacePackages());

    const failures = result.isErr()
      ? result.error.map(describeTestCoverageError)
      : [];
    expect(failures).toEqual([]);
  });

  it("has no workspace package without a name", async () => {
    const packages = await readWorkspacePackages();

    expect(packages.length).toBeGreaterThan(0);
    for (const entry of packages) {
      expect(entry.name.startsWith("@weaveio/")).toBe(true);
    }
  });
});
