import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  classifyDiscoveredReleaseEntrypoint,
  discoverProductionReleaseEntrypoints,
  discoverProductionRoots,
  inventoriedPaths,
  isReleaseExecutable,
  isTestOnlyRoot,
  PRODUCTION_ENTRYPOINTS,
  PRODUCTION_ROOT_CLASSES,
  rootsFromPackageManifest,
  rootsFromWorkflowText,
  scriptAliases,
  scriptCommandPaths,
  validateEntrypointInventory,
  workflowCommandPaths,
  workflowLocalUses,
} from "../entrypoint-inventory.js";

const ROOT = resolve(import.meta.dir, "../../..");

describe("entrypoint inventory", () => {
  it("registers the Task 14, 15, 22, 23, 24, and 25 production roots", () => {
    expect(PRODUCTION_ENTRYPOINTS.map((entry) => entry.path)).toEqual([
      "scripts/release/publish-main.ts",
      "scripts/release/doctor.ts",
      "scripts/release/api-reports.ts",
      "scripts/release/prepare-main.ts",
      "scripts/release/regenerate-main.ts",
      "scripts/release/attest-main.ts",
      "scripts/release/release-route-main.ts",
      "scripts/release/rollout-gate.ts",
      "scripts/release/resume-main.ts",
      "scripts/release/incident-main.ts",
      "scripts/release/build-bind-main.ts",
      "scripts/release/await-attest-main.ts",
      "scripts/release/consumer-proof-main.ts",
      "scripts/release/harness-proof-main.ts",
      "scripts/release/registry-verify-main.ts",
      "scripts/release/refs-cleanup-main.ts",
      "scripts/release/publish-reachability.ts",
    ]);
    expect(validateEntrypointInventory().isOk()).toBe(true);
    expect(inventoriedPaths()).toContain("scripts/release/publish-main.ts");
    expect(inventoriedPaths()).toContain("scripts/release/doctor.ts");
    expect(inventoriedPaths()).toContain("scripts/release/api-reports.ts");
    expect(inventoriedPaths()).toContain("scripts/release/prepare-main.ts");
    expect(inventoriedPaths()).toContain("scripts/release/regenerate-main.ts");
    expect(inventoriedPaths()).toContain("scripts/release/attest-main.ts");
    expect(inventoriedPaths()).toContain(
      "scripts/release/refs-cleanup-main.ts",
    );
    expect(inventoriedPaths()).toContain(
      "scripts/release/publish-reachability.ts",
    );
    expect(PRODUCTION_ROOT_CLASSES).toHaveLength(14);
  });

  it("classifies current production release commands and fails unknown ones", async () => {
    const discovered = await discoverProductionReleaseEntrypoints(ROOT);
    expect(discovered.isOk()).toBe(true);
    if (discovered.isErr()) return;
    expect(
      discovered.value.discovered.some(
        (item) => item.path === "scripts/release/publish-main.ts",
      ),
    ).toBe(false);
    expect(
      discovered.value.discovered.some(
        (item) => item.path === "scripts/release/changeset-policy.ts",
      ),
    ).toBe(true);
    expect(
      classifyDiscoveredReleaseEntrypoint({
        path: "scripts/release/nightly-plan.ts",
        source: ".github/workflows/publish.yml:run",
      }).isOk(),
    ).toBe(true);
    expect(
      classifyDiscoveredReleaseEntrypoint({
        path: "scripts/release/renamed-publish-main.ts",
        source: "package.json#scripts.release:publish",
      })._unsafeUnwrapErr(),
    ).toEqual({
      type: "UnknownProductionEntrypoint",
      path: "scripts/release/renamed-publish-main.ts",
      discoveredFrom: "package.json#scripts.release:publish",
    });
  });

  it("fails rename-evasion when a workflow run points at a new name", () => {
    const roots = rootsFromWorkflowText({
      text: "      - run: bun scripts/release/publish-root.ts\n",
      source: ".github/workflows/release-publish.yml",
    });
    expect(roots).toEqual([
      {
        kind: "workflow-run",
        path: "scripts/release/publish-root.ts",
        source: ".github/workflows/release-publish.yml:run",
      },
    ]);
    expect(
      classifyDiscoveredReleaseEntrypoint({
        path: roots[0]?.path ?? "",
        source: roots[0]?.source ?? "",
      })._unsafeUnwrapErr().type,
    ).toBe("UnknownProductionEntrypoint");
  });

  it("excludes test-only roots from production inventory", () => {
    expect(
      isTestOnlyRoot(
        "scripts/release/__tests__/incident-recovery.integration.test.ts",
      ),
    ).toBe(true);
    expect(
      isTestOnlyRoot(
        "scripts/release/__tests__/fixtures/local-registry/deprecation-seam.ts",
      ),
    ).toBe(true);
    expect(
      isReleaseExecutable(
        "scripts/release/__tests__/incident-recovery.integration.test.ts",
      ),
    ).toBe(false);
    expect(isTestOnlyRoot("scripts/release/publish-main.ts")).toBe(false);
    expect(
      validateEntrypointInventory([
        {
          path: "scripts/release/__tests__/incident-recovery.integration.test.ts",
          role: "oidc-publish",
          rationale: "must not be inventoried",
        },
      ])._unsafeUnwrapErr().type,
    ).toBe("TestOnlyInventoriedAsProduction");
  });

  it("discovers commands semantically from scripts and workflows, never filename patterns", () => {
    expect(
      scriptCommandPaths("bun scripts/release/publish-main.ts --help"),
    ).toEqual(["scripts/release/publish-main.ts"]);
    expect(
      workflowCommandPaths(
        "      - run: bun scripts/release/nightly-plan.ts\n",
      ),
    ).toEqual(["scripts/release/nightly-plan.ts"]);
    expect(workflowLocalUses("      - uses: ./scripts/ci/composite\n")).toEqual(
      ["scripts/ci/composite"],
    );
    expect(scriptCommandPaths("echo publish-main.ts && bun test")).toEqual([]);
    expect(scriptCommandPaths("ls scripts/release/*-main.ts")).toEqual([]);
    expect(scriptAliases("bun run changeset:check && bun run build")).toEqual([
      "changeset:check",
      "build",
    ]);
    expect(
      scriptCommandPaths("bun ../../../scripts/release/packager.ts"),
    ).toEqual(["../../../scripts/release/packager.ts"]);
  });

  it("discovers package fields and host metadata without filename globs", () => {
    const roots = rootsFromPackageManifest({
      manifest: {
        main: "./dist/index.js",
        module: "./dist/index.js",
        types: "./dist/index.d.ts",
        bin: { weave: "./dist/main.js" },
        exports: { ".": { import: "./dist/index.js" } },
        pi: { extensions: ["./dist/extension.js"] },
        scripts: {
          build: "bun ../../scripts/build-public-packages.ts",
          test: "bun test src",
        },
      },
      directory: "packages/cli",
      root: ROOT,
      source: "packages/cli/package.json",
      scriptKind: "package-script",
    });
    const kinds = new Set(roots.map((root) => root.kind));
    expect(kinds.has("main")).toBe(true);
    expect(kinds.has("module")).toBe(true);
    expect(kinds.has("types")).toBe(true);
    expect(kinds.has("bin")).toBe(true);
    expect(kinds.has("exports")).toBe(true);
    expect(kinds.has("host-metadata")).toBe(true);
    expect(kinds.has("package-script")).toBe(true);
    expect(
      roots.some((root) => root.path === "packages/cli/dist/main.js"),
    ).toBe(true);
    expect(
      roots.some((root) => root.path === "scripts/build-public-packages.ts"),
    ).toBe(true);
    expect(roots.some((root) => root.path.includes("__tests__"))).toBe(false);
  });

  it("discovers live production roots semantically from the repository", async () => {
    const roots = await discoverProductionRoots(ROOT);
    expect(roots.isOk()).toBe(true);
    if (roots.isErr()) return;
    const kinds = new Set(roots.value.map((root) => root.kind));
    expect(kinds.has("exports")).toBe(true);
    expect(kinds.has("bin")).toBe(true);
    expect(kinds.has("main")).toBe(true);
    expect(kinds.has("module")).toBe(true);
    expect(kinds.has("types")).toBe(true);
    expect(kinds.has("host-metadata")).toBe(true);
    expect(kinds.has("build-entry")).toBe(true);
    expect(kinds.has("inventory")).toBe(true);
    expect(kinds.has("root-script")).toBe(true);
    expect(kinds.has("package-script")).toBe(true);
    expect(kinds.has("workflow-run")).toBe(true);
    expect(
      roots.value.some(
        (root) =>
          root.kind === "bin" && root.path === "packages/cli/dist/main.js",
      ),
    ).toBe(true);
    expect(
      roots.value.some(
        (root) =>
          root.kind === "host-metadata" &&
          root.path === "packages/adapters/pi/dist/extension.js",
      ),
    ).toBe(true);
    expect(
      roots.value.some(
        (root) => root.path.endsWith("-main.ts") && root.kind === "inventory",
      ),
    ).toBe(true);
  });
});
