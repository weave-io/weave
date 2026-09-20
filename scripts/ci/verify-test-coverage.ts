/**
 * Guard: every workspace package runs its tests in CI.
 *
 * `bun run test` fans out with `bun run --filter '*' test`, which silently
 * skips any package that has no `test` script. That is how
 * `@weaveio/weave-adapter-opencode2` (149 cases) and
 * `@weaveio/weave-adapter-claude-code` (76 cases) ran only in the local
 * pre-commit hook, which uses `bun test --recursive`, and never in CI.
 *
 * A no-op script is the same failure wearing a disguise, so a `test` script
 * that cannot run a test file is rejected too. Packages that genuinely have no
 * tests to run are listed in `EXEMPT` with the reason, so the exemption is a
 * decision on the record rather than an omission nobody notices.
 *
 * Run with `bun run verify:test-coverage`.
 */

import { err, ok, type Result } from "neverthrow";

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Packages allowed to ship without a real `test` script, and why.
 *
 * Adding an entry here is a deliberate choice. Removing a package's tests
 * without adding it here fails the guard.
 */
const EXEMPT: Record<string, string> = {
  "@weaveio/weave-docs":
    "Astro documentation site; covered by `bun run docs:build` and `docs:check-links`.",
  "@weaveio/weave-adapter-pi":
    "No source in this repository — only the published declaration contract, which `bun run validate:declarations` checks.",
};

/** A `test` script matching any of these runs nothing. */
const NO_OP_PATTERNS: readonly RegExp[] = [
  /^echo\b/,
  /\bprocess\.exit\(0\)/,
  /^(true|exit 0)$/,
];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TestCoverageError =
  | { type: "MissingTestScript"; packageName: string; path: string }
  | {
      type: "NoOpTestScript";
      packageName: string;
      path: string;
      script: string;
    }
  | { type: "MissingBunfig"; packageName: string; path: string }
  | { type: "BunfigMissingPreload"; packageName: string; path: string }
  | { type: "StaleExemption"; packageName: string }
  | { type: "WorkspaceReadFailure"; path: string };

export function describeTestCoverageError(error: TestCoverageError): string {
  switch (error.type) {
    case "MissingTestScript":
      return `${error.packageName} (${error.path}) has no "test" script, so \`bun run --filter '*' test\` skips it. Add one, or add the package to EXEMPT with a reason.`;
    case "NoOpTestScript":
      return `${error.packageName} (${error.path}) has a "test" script that runs nothing: ${error.script}. Make it run tests, or add the package to EXEMPT with a reason.`;
    case "MissingBunfig":
      return `${error.packageName} (${error.path}) has no bunfig.toml. Bun reads only the one in the current working directory, so its tests would run without the shared preload — pino logs leak into output and WEAVE_GLOBAL_CONFIG_DIR is unset, letting tests read the developer's real global config.`;
    case "BunfigMissingPreload":
      return `${error.packageName} (${error.path}) has a bunfig.toml whose [test] section does not preload scripts/test-setup.ts. Add it, or its tests run non-hermetically.`;
    case "StaleExemption":
      return `${error.packageName} is listed in EXEMPT but is not a workspace package. Remove the stale entry.`;
    case "WorkspaceReadFailure":
      return `Could not read ${error.path}.`;
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

interface WorkspacePackage {
  name: string;
  path: string;
  testScript: string | undefined;
  /** Contents of the package's own `bunfig.toml`, or undefined when absent. */
  bunfig: string | undefined;
}

/** The preload every package's `[test]` section must pull in. */
const REQUIRED_PRELOAD = "scripts/test-setup.ts";

/**
 * True when a bunfig declares the shared preload inside its `[test]` section.
 *
 * A top-level `preload` key is the *runtime* preload and does not apply to
 * `bun test`, so the key must appear after the `[test]` header.
 */
export function bunfigPreloadsTestSetup(bunfig: string): boolean {
  const testSection = bunfig.split(/^\[test\]$/m)[1];
  if (testSection === undefined) return false;
  const untilNextSection = testSection.split(/^\[/m)[0] ?? "";
  return untilNextSection.includes(REQUIRED_PRELOAD);
}

/** True when a `test` script is present but demonstrably runs no tests. */
export function isNoOpTestScript(script: string): boolean {
  const trimmed = script.trim();
  return NO_OP_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Applies the policy to an already-read set of workspace packages. */
export function checkTestCoverage(
  packages: readonly WorkspacePackage[],
): Result<void, TestCoverageError[]> {
  const errors: TestCoverageError[] = [];

  for (const pkg of packages) {
    if (pkg.name in EXEMPT) continue;
    if (pkg.testScript === undefined) {
      errors.push({
        type: "MissingTestScript",
        packageName: pkg.name,
        path: pkg.path,
      });
      continue;
    }
    if (isNoOpTestScript(pkg.testScript)) {
      errors.push({
        type: "NoOpTestScript",
        packageName: pkg.name,
        path: pkg.path,
        script: pkg.testScript,
      });
      continue;
    }
    if (pkg.bunfig === undefined) {
      errors.push({
        type: "MissingBunfig",
        packageName: pkg.name,
        path: pkg.path,
      });
      continue;
    }
    if (!bunfigPreloadsTestSetup(pkg.bunfig)) {
      errors.push({
        type: "BunfigMissingPreload",
        packageName: pkg.name,
        path: pkg.path,
      });
    }
  }

  const names = new Set(packages.map((pkg) => pkg.name));
  for (const exempt of Object.keys(EXEMPT)) {
    if (names.has(exempt)) continue;
    errors.push({ type: "StaleExemption", packageName: exempt });
  }

  if (errors.length > 0) return err(errors);
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** Expands the root `workspaces` globs into concrete package directories. */
async function workspaceDirs(rootPackageJson: string): Promise<string[]> {
  const root = JSON.parse(await Bun.file(rootPackageJson).text()) as {
    workspaces?: string[];
  };
  const dirs: string[] = [];

  for (const pattern of root.workspaces ?? []) {
    if (!pattern.endsWith("/*")) {
      dirs.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    const glob = new Bun.Glob("*/package.json");
    for await (const match of glob.scan({ cwd: parent })) {
      dirs.push(`${parent}/${match.replace("/package.json", "")}`);
    }
  }

  return dirs.sort();
}

/** Reads every workspace package's name and `test` script. */
export async function readWorkspacePackages(): Promise<WorkspacePackage[]> {
  const dirs = await workspaceDirs("package.json");
  const packages: WorkspacePackage[] = [];

  for (const dir of dirs) {
    const path = `${dir}/package.json`;
    const parsed = JSON.parse(await Bun.file(path).text()) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    const bunfigFile = Bun.file(`${dir}/bunfig.toml`);
    packages.push({
      name: parsed.name ?? dir,
      path: dir,
      testScript: parsed.scripts?.test,
      bunfig: (await bunfigFile.exists()) ? await bunfigFile.text() : undefined,
    });
  }

  return packages;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const packages = await readWorkspacePackages();
  checkTestCoverage(packages).match(
    () => {
      console.log(
        `✔ every workspace package runs tests (${packages.length} packages, ${Object.keys(EXEMPT).length} exempt)`,
      );
    },
    (errors) => {
      process.exitCode = 1;
      console.error("✖ test coverage guard failed:\n");
      for (const error of errors) {
        console.error(`  - ${describeTestCoverageError(error)}`);
      }
    },
  );
}
