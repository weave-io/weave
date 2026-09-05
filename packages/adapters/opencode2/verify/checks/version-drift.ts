#!/usr/bin/env bun
// biome-ignore-all lint/suspicious/noConsole: verification CLI writes to stdout/stderr
/**
 * Version-drift check (Task E1, layer 8).
 *
 * Reads `packages/adapters/opencode2/package.json` and asserts that each of
 * the four pinned V2 SDK packages resolves to the exact approved version:
 *
 *   @opencode-ai/cli, @opencode-ai/plugin, @opencode-ai/sdk, @opencode-ai/client
 *   == 0.0.0-beta-19151
 *
 * Fails loudly (non-zero exit, explicit diff of expected vs actual) if any
 * pin has drifted, is missing, or uses a range specifier instead of an exact
 * version. `@opencode-ai/cli` is optional in `package.json` (it may only be
 * present in the verify harness's own manifest) — if absent from the
 * adapter's `package.json`, this check does not fail on that account, but
 * DOES fail if present with a mismatched version.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const PINNED_VERSION = "0.0.0-beta-19151";

const TRACKED_PACKAGES = [
  "@opencode-ai/cli",
  "@opencode-ai/plugin",
  "@opencode-ai/sdk",
  "@opencode-ai/client",
] as const;

const REQUIRED_PACKAGES = new Set<string>([
  "@opencode-ai/plugin",
  "@opencode-ai/sdk",
  "@opencode-ai/client",
]);

const ADAPTER_PACKAGE_JSON = join(import.meta.dir, "..", "..", "package.json");

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function main(): Promise<number> {
  const raw = await readFile(ADAPTER_PACKAGE_JSON, "utf8");
  const pkg = JSON.parse(raw) as PackageJsonShape;
  const allDeps: Record<string, string> = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  const failures: string[] = [];

  for (const name of TRACKED_PACKAGES) {
    const resolved = allDeps[name];
    if (resolved === undefined) {
      if (REQUIRED_PACKAGES.has(name)) {
        failures.push(`${name}: MISSING (expected exact "${PINNED_VERSION}")`);
      }
      continue;
    }
    if (resolved !== PINNED_VERSION) {
      failures.push(
        `${name}: drifted — expected exact "${PINNED_VERSION}", found "${resolved}"`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("FAIL: version-drift check found pin mismatches:");
    for (const f of failures) console.error(`  ${f}`);
    return 1;
  }

  console.log(
    `OK: version-drift check passed — all tracked V2 packages pinned to exact ${PINNED_VERSION}`,
  );
  return 0;
}

const code = await main();
process.exit(code);
