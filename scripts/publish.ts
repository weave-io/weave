#!/usr/bin/env bun
/**
 * Publish script for Weave packages.
 *
 * Uses `bun publish` which automatically resolves `workspace:*` dependencies
 * to actual version numbers before publishing to npm.
 *
 * Usage:
 *   bun scripts/publish.ts [--dry-run] [--tag <tag>]
 *
 * Options:
 *   --dry-run  Show what would be published without actually publishing
 *   --tag      npm dist-tag (e.g., "preview", "latest")
 */

import { $ } from "bun";
import { join } from "node:path";

// Packages in dependency order (dependencies must be published before dependents)
const PACKAGES = [
  "packages/core",
  "packages/engine",
  "packages/config",
  "packages/adapters/opencode",
] as const;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const tagIndex = args.indexOf("--tag");
  const tag = tagIndex !== -1 ? args[tagIndex + 1] : undefined;

  const root = import.meta.dir.replace(/[\\/]scripts$/, "");

  console.log("Publishing Weave packages...");
  console.log(`  Root: ${root}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log(`  Tag: ${tag ?? "(default)"}`);
  console.log();

  for (const pkg of PACKAGES) {
    const pkgPath = join(root, pkg);
    const pkgJson = await Bun.file(join(pkgPath, "package.json")).json();

    console.log(`Publishing ${pkgJson.name}@${pkgJson.version}...`);

    try {
      // Build the command dynamically based on options
      // Note: bun publish doesn't have --dry-run, so we just show what would be published
      if (dryRun) {
        const result = await $`bun publish --access public --dry-run`.cwd(pkgPath).nothrow();
        if (result.exitCode !== 0 && !result.stderr.toString().includes("authentication")) {
          throw new Error(result.stderr.toString());
        }
        // For dry-run, just show the package info
        console.log(`  [dry-run] Would publish ${pkgJson.name}@${pkgJson.version}`);
        continue;
      }

      const result = tag
        ? await $`bun publish --access public --tag ${tag}`.cwd(pkgPath).quiet()
        : await $`bun publish --access public`.cwd(pkgPath).quiet();
      console.log(`  ✓ Published ${pkgJson.name}@${pkgJson.version}`);
    } catch (error) {
      // Check if it's a "already published" error (which is fine)
      const stderr = error instanceof Error ? error.message : String(error);
      if (stderr.includes("already exists") || stderr.includes("previously published")) {
        console.log(`  ⊘ ${pkgJson.name}@${pkgJson.version} already published, skipping`);
      } else {
        console.error(`  ✗ Failed to publish ${pkgJson.name}:`, error);
        process.exit(1);
      }
    }
  }

  console.log();
  console.log("Done!");
}

main().catch((error) => {
  console.error("Publish failed:", error);
  process.exit(1);
});
