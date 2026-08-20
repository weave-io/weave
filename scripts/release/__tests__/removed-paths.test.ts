/**
 * Task 35 cutover removal and keeper tests.
 *
 * The removal half proves the old stable-train, metadata-replay, dist-tag
 * promotion, and legacy release-ref system is gone: no denylisted path exists,
 * none survives in the entrypoint inventory, and no source file still
 * references a denylisted identifier.
 *
 * The keeper half proves the cutover did not overreach: the new
 * `release-refs.ts` from Task 12 is present, reachable from the publish chain,
 * and covered by its own passing test file.
 */
import { describe, expect, it } from "bun:test";
import { dirname, relative, resolve } from "node:path";
import {
  inventoriedPaths,
  registeredProductionPaths,
} from "../entrypoint-inventory.js";
import {
  LEGACY_DENYLIST_IDENTIFIERS,
  LEGACY_DENYLIST_PATHS,
  LEGACY_SCAN_ALLOWED_PREFIXES,
  LEGACY_SCAN_ALLOWLIST,
  LEGACY_SCAN_SELF_PATHS,
  RETAINED_PIPELINE_PATHS,
} from "./legacy-denylist.js";

const ROOT = resolve(import.meta.dir, "../../..");

const SCAN_GLOBS = [
  "scripts/**/*.ts",
  "packages/*/src/**/*.ts",
  "packages/adapters/*/src/**/*.ts",
  ".github/workflows/*.yml",
  "docs/**/*.md",
  "*.md",
  "package.json",
] as const;

async function scannedFiles(): Promise<readonly string[]> {
  const found: string[] = [];
  for (const pattern of SCAN_GLOBS)
    for await (const file of new Bun.Glob(pattern).scan({
      cwd: ROOT,
      onlyFiles: true,
      dot: true,
    }))
      found.push(file.replaceAll("\\", "/"));
  return [...new Set(found)].filter(
    (file) => !file.includes("node_modules/") && !file.includes("/dist/"),
  );
}

function scanExempt(path: string): boolean {
  if (LEGACY_SCAN_SELF_PATHS.some((self) => self === path)) return true;
  if (LEGACY_SCAN_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix)))
    return true;
  return LEGACY_SCAN_ALLOWLIST.some((entry) => entry.path === path);
}

async function referencedIdentifiers(path: string): Promise<readonly string[]> {
  const text = await Bun.file(resolve(ROOT, path)).text();
  return LEGACY_DENYLIST_IDENTIFIERS.filter((id) => text.includes(id));
}

describe("cutover removal", () => {
  it("deletes every denylisted legacy path", async () => {
    for (const path of LEGACY_DENYLIST_PATHS)
      expect(await Bun.file(resolve(ROOT, path)).exists(), path).toBe(false);
  });

  it("leaves no denylisted path in the entrypoint inventory", () => {
    const inventory = inventoriedPaths();
    for (const path of LEGACY_DENYLIST_PATHS)
      expect(inventory, path).not.toContain(path);
  });

  it("references no denylisted identifier in any scanned source file", async () => {
    const offenders: string[] = [];
    for (const path of await scannedFiles()) {
      if (scanExempt(path)) continue;
      for (const id of await referencedIdentifiers(path))
        offenders.push(`${path}: ${id}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the scan allowlist minimal and reasoned", async () => {
    for (const entry of LEGACY_SCAN_ALLOWLIST) {
      expect(await Bun.file(resolve(ROOT, entry.path)).exists()).toBe(true);
      // An allowlist entry that no longer needs the exemption must be removed.
      expect(await referencedIdentifiers(entry.path), entry.path).not.toEqual(
        [],
      );
      expect(entry.reason.length).toBeGreaterThan(32);
    }
  });

  it("drops the superseded root release scripts", async () => {
    const manifest = (await Bun.file(resolve(ROOT, "package.json")).json()) as {
      scripts: Record<string, string>;
    };
    for (const name of Object.keys(manifest.scripts)) {
      expect(name).not.toStartWith("release:dry");
      expect(name).not.toStartWith("release:control");
    }
    expect(manifest.scripts["release:doctor"]).toBe(
      "bun scripts/release/doctor.ts",
    );
  });

  it("does not denylist the new release-refs module or generic naming", () => {
    expect(LEGACY_DENYLIST_PATHS).not.toContain(
      "scripts/release/release-refs.ts",
    );
    expect(LEGACY_DENYLIST_IDENTIFIERS).not.toContain("release-refs");
    // `release-refs-main` is denylisted, and it must not match the keeper by
    // stem: only the exact legacy entrypoint goes.
    expect(LEGACY_DENYLIST_IDENTIFIERS).toContain("release-refs-main");
    expect("scripts/release/release-refs.ts").not.toContain(
      "release-refs-main",
    );
  });
});

describe("cutover keepers", () => {
  it("retains every new-pipeline path", async () => {
    for (const path of RETAINED_PIPELINE_PATHS)
      expect(await Bun.file(resolve(ROOT, path)).exists(), path).toBe(true);
  });

  it("positively retains the new-pipeline production entrypoints", () => {
    const registered = registeredProductionPaths();
    for (const path of RETAINED_PIPELINE_PATHS) {
      if (!path.startsWith("scripts/release/")) continue;
      if (path === "scripts/release/release-refs.ts") continue;
      if (path === "scripts/release/rollout-stage.ts") continue;
      expect(registered, path).toContain(path);
    }
  });

  it("keeps release-refs.ts reachable from the publish chain", async () => {
    // Walk imports from the workflow-invoked roots and prove release-refs.ts
    // is on the graph. Reachability is derived, never asserted by name.
    const target = "scripts/release/release-refs.ts";
    const workflow = await Bun.file(
      resolve(ROOT, ".github/workflows/release-publish.yml"),
    ).text();
    const roots = [
      ...new Set(
        [
          ...workflow.matchAll(
            /bun\s+(scripts\/release\/[A-Za-z0-9._/-]+\.ts)/g,
          ),
        ]
          .map((match) => match[1])
          .filter((path): path is string => path !== undefined),
      ),
    ];
    expect(roots.length).toBeGreaterThan(0);

    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      const file = Bun.file(resolve(ROOT, current));
      if (!(await file.exists())) continue;
      const text = await file.text();
      for (const match of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
        const specifier = (match[1] ?? "").replace(/\.js$/, ".ts");
        const resolved = relative(
          ROOT,
          resolve(dirname(resolve(ROOT, current)), specifier),
        ).replaceAll("\\", "/");
        queue.push(resolved);
      }
    }
    expect([...seen]).toContain(target);
  });

  it("keeps release-refs.test.ts running and passing after the removal", async () => {
    const testPath = "scripts/release/__tests__/release-refs.test.ts";
    expect(await Bun.file(resolve(ROOT, testPath)).exists()).toBe(true);
    const run = Bun.spawnSync(["bun", "test", testPath], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    expect(output).not.toContain(" 0 pass");
    expect(output).toMatch(/\n\s*0 fail/);
    expect(run.exitCode).toBe(0);
  });
});
