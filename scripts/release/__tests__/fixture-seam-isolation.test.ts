/**
 * Production-unreachability proof for the test-only local-registry seam.
 *
 * Root construction is semantic: inventory, package fields, host metadata,
 * build entries, production scripts, and workflow command graphs. Test-only
 * roots are excluded. Each of the fourteen leak classes has a failing
 * fixture that the detector must catch.
 */
import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { PUBLIC_PACKAGE_BUILDS, PUBLIC_PACKAGES } from "../constants.js";
import {
  classifyDiscoveredReleaseEntrypoint,
  discoverProductionReleaseEntrypoints,
  discoverProductionRoots,
  inventoriedPaths,
  isTestOnlyRoot,
  MODULE_GRAPH_WALK_BOUND,
  PRODUCTION_ENTRYPOINTS,
  PRODUCTION_ROOT_CLASSES,
  type ProductionRoot,
  type ProductionRootClass,
  rootsFromBuildEntries,
  rootsFromPackageManifest,
  rootsFromWorkflowText,
  scriptCommandPaths,
} from "../entrypoint-inventory.js";
import { publishablePackageNames } from "../package-policy.js";
import { expectedPublicPackageInventory } from "../tar-inspector.js";

const ROOT = resolve(import.meta.dir, "../../..");
const SEAM =
  "scripts/release/__tests__/fixtures/local-registry/deprecation-seam.ts";
const INTEGRATION =
  "scripts/release/__tests__/incident-recovery.integration.test.ts";
const LOCAL_REGISTRY_FIXTURE_DIR =
  "scripts/release/__tests__/fixtures/local-registry";
const SEAM_LEAK_FIXTURE_DIR = "scripts/release/__tests__/fixtures/seam-leaks";

const IMPORT_SPEC =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"\n]+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
const SPAWN_SPEC = /(?:Bun\.spawn(?:Sync)?|spawn(?:Sync)?)\(\s*\[([^\]]+)\]/g;

const LEAK_FIXTURE_FILES = {
  exports: "exports.package.json",
  bin: "bin.package.json",
  main: "main.package.json",
  module: "module.package.json",
  types: "types.package.json",
  "host-metadata": "host-metadata.package.json",
  "build-entry": "build-entry.json",
  inventory: "inventory.json",
  "root-script": "root-script.package.json",
  "package-script": "package-script.package.json",
  "workflow-run": "workflow-run.yml",
  "workflow-uses": "workflow-uses.yml",
  "dynamic-import": "dynamic-import.ts",
  spawn: "spawn.ts",
} as const satisfies Record<ProductionRootClass, string>;

describe("fixture-seam-isolation", () => {
  it("covers every required production root class without reaching the seam", async () => {
    const roots = await discoverProductionRoots(ROOT);
    expect(roots.isOk()).toBe(true);
    if (roots.isErr()) return;
    const kinds = new Set(roots.value.map((root) => root.kind));
    for (const leakClass of [
      "exports",
      "bin",
      "main",
      "module",
      "types",
      "host-metadata",
      "build-entry",
      "inventory",
      "root-script",
      "package-script",
      "workflow-run",
    ] as const)
      expect(kinds.has(leakClass)).toBe(true);
    const leaks = await findSeamLeaks(ROOT, roots.value);
    expect(leaks.isOk()).toBe(true);
    if (leaks.isErr()) return;
    expect(leaks.value).toEqual([]);
    expect(
      roots.value.some((root) =>
        isTestOnlyRoot(root.source.split("#")[0] ?? root.source),
      ),
    ).toBe(false);
  });

  it("excludes test-only roots and proves workflows never invoke the integration test", async () => {
    expect(isTestOnlyRoot(INTEGRATION)).toBe(true);
    expect(isTestOnlyRoot(SEAM)).toBe(true);
    const workflows = await readWorkflowTexts(ROOT);
    expect(workflows.isOk()).toBe(true);
    if (workflows.isErr()) return;
    for (const [file, text] of workflows.value) {
      expect(text.includes(SEAM)).toBe(false);
      expect(text.includes(INTEGRATION)).toBe(false);
      expect(text.includes(LOCAL_REGISTRY_FIXTURE_DIR)).toBe(false);
      void file;
    }
    const inventory = await discoverProductionReleaseEntrypoints(ROOT);
    expect(inventory.isOk()).toBe(true);
    if (inventory.isErr()) return;
    expect(
      inventory.value.discovered.some((item) =>
        item.path.includes("incident-recovery.integration.test.ts"),
      ),
    ).toBe(false);
    expect(inventory.value.classified.includes(SEAM)).toBe(false);
  });

  it("keeps the seam out of production builds and packed public tarball inventories", () => {
    for (const build of Object.values(PUBLIC_PACKAGE_BUILDS)) {
      for (const entry of build.entries) {
        expect(entry.source.includes(LOCAL_REGISTRY_FIXTURE_DIR)).toBe(false);
        expect(entry.output.includes(LOCAL_REGISTRY_FIXTURE_DIR)).toBe(false);
      }
    }
    for (const name of publishablePackageNames()) {
      expect(PUBLIC_PACKAGES[name].directory.startsWith("packages/")).toBe(
        true,
      );
      for (const path of expectedPublicPackageInventory(name))
        expect(path.includes("local-registry")).toBe(false);
    }
    expect(inventoriedPaths().includes(SEAM)).toBe(false);
    const productionPaths: readonly string[] = PRODUCTION_ENTRYPOINTS.map(
      (entry) => entry.path,
    );
    expect(productionPaths.includes(SEAM)).toBe(false);
  });

  it("fails a synthetic non-test production import of the seam", async () => {
    const fixture = join(tmpdirSafe(), `seam-import-${Bun.randomUUIDv7()}.ts`);
    const written = await ResultAsync.fromPromise(
      Bun.write(fixture, `import { setDeprecated } from "${SEAM}";\n`),
      () => ({ type: "WriteFailed" as const }),
    );
    expect(written.isOk()).toBe(true);
    const leaks = await findSeamLeaks(ROOT, [
      {
        kind: "inventory",
        path: relative(ROOT, fixture),
        source: "synthetic",
      },
    ]);
    const deleted = await ResultAsync.fromPromise(
      Bun.file(fixture).delete(),
      () => ({ type: "DeleteFailed" as const }),
    );
    expect(deleted.isOk()).toBe(true);
    expect(leaks.isOk()).toBe(true);
    if (leaks.isErr()) return;
    expect(leaks.value.length).toBeGreaterThan(0);
  });

  it("catches a renamed production entrypoint as UnknownProductionEntrypoint", () => {
    expect(
      classifyDiscoveredReleaseEntrypoint({
        path: "scripts/release/publish-root.ts",
        source: ".github/workflows/release-publish.yml:run",
      })._unsafeUnwrapErr().type,
    ).toBe("UnknownProductionEntrypoint");
  });

  it("detects the seam through every leak fixture class", async () => {
    expect(PRODUCTION_ROOT_CLASSES).toEqual(
      Object.keys(
        LEAK_FIXTURE_FILES,
      ) as unknown as typeof PRODUCTION_ROOT_CLASSES,
    );
    for (const leakClass of PRODUCTION_ROOT_CLASSES) {
      const roots = await discoverLeakFixtureRoots(ROOT, leakClass);
      expect(roots.isOk()).toBe(true);
      if (roots.isErr()) return;
      expect(roots.value.length).toBeGreaterThan(0);
      expect(roots.value.every((root) => root.kind === leakClass)).toBe(true);
      const leaks = await findSeamLeaks(ROOT, roots.value);
      expect(leaks.isOk()).toBe(true);
      if (leaks.isErr()) return;
      expect(leaks.value.length).toBeGreaterThan(0);
      expect(leaks.value.some((leak) => leak.kind === leakClass)).toBe(true);
    }
  });
});

interface SeamLeak extends ProductionRoot {
  reached: string;
}

type SeamWalkError =
  | { type: "FixtureUnreadable"; path: string }
  | { type: "InvalidFixture"; path: string; reason: string };

function discoverLeakFixtureRoots(
  root: string,
  leakClass: ProductionRootClass,
): ResultAsync<readonly ProductionRoot[], SeamWalkError> {
  const relativeFile = `${SEAM_LEAK_FIXTURE_DIR}/${LEAK_FIXTURE_FILES[leakClass]}`;
  const file = join(root, relativeFile);
  if (leakClass === "dynamic-import" || leakClass === "spawn")
    return okAsyncResult([
      { kind: leakClass, path: relativeFile, source: relativeFile },
    ]);
  if (leakClass === "workflow-run" || leakClass === "workflow-uses")
    return readText(file).map((text) =>
      rootsFromWorkflowText({ text, source: relativeFile }).filter(
        (item) => item.kind === leakClass,
      ),
    );
  if (leakClass === "build-entry")
    return readJson(file).map((manifest) => {
      const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
      return rootsFromBuildEntries(
        entries.filter(
          (entry): entry is { source: string } =>
            entry !== null &&
            typeof entry === "object" &&
            typeof (entry as { source?: unknown }).source === "string",
        ),
        relativeFile,
      );
    });
  if (leakClass === "inventory")
    return readJson(file).map((manifest) => {
      if (typeof manifest.path !== "string") return [];
      return [
        {
          kind: "inventory" as const,
          path: manifest.path,
          source: relativeFile,
        },
      ];
    });
  return readJson(file).map((manifest) => {
    const scriptKind =
      leakClass === "root-script" ? "root-script" : "package-script";
    const roots = rootsFromPackageManifest({
      manifest,
      directory: dirname(relativeFile),
      root,
      source: relativeFile,
      scriptKind,
    });
    if (leakClass === "root-script" || leakClass === "package-script") {
      const scriptRoots = roots.filter((item) => item.kind === leakClass);
      if (scriptRoots.length > 0) return scriptRoots;
      return scriptRootsFromCommands(manifest, leakClass, relativeFile);
    }
    return roots.filter((item) => item.kind === leakClass);
  });
}

function scriptRootsFromCommands(
  manifest: Record<string, unknown>,
  kind: "root-script" | "package-script",
  source: string,
): readonly ProductionRoot[] {
  const scripts = manifest.scripts;
  if (scripts === null || typeof scripts !== "object") return [];
  const roots: ProductionRoot[] = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== "string") continue;
    for (const path of scriptCommandPaths(command))
      roots.push({
        kind,
        path,
        source: `${source}#scripts.${name}`,
      });
  }
  return roots;
}

function findSeamLeaks(
  root: string,
  roots: readonly ProductionRoot[],
): ResultAsync<readonly SeamLeak[], SeamWalkError> {
  const cache = new Map<string, string | undefined>();
  return roots
    .reduce<ResultAsync<SeamLeak[], SeamWalkError>>(
      (chain, entry) =>
        chain.andThen((leaks) => {
          const cached = cache.get(entry.path);
          if (cached !== undefined) {
            if (cached.length === 0) return okAsyncResult(leaks);
            return okAsyncResult([...leaks, { ...entry, reached: cached }]);
          }
          return moduleGraphReachesSeam(root, entry.path).map((reached) => {
            cache.set(entry.path, reached ?? "");
            if (reached === undefined) return leaks;
            return [...leaks, { ...entry, reached }];
          });
        }),
      okAsyncResult([]),
    )
    .map((leaks) => leaks);
}

function moduleGraphReachesSeam(
  root: string,
  entry: string,
): ResultAsync<string | undefined, SeamWalkError> {
  const pending = [resolve(root, entry)];
  const seen = new Set<string>();
  const seam = resolve(root, SEAM);
  const fixture = resolve(root, LOCAL_REGISTRY_FIXTURE_DIR);

  const walk = (): ResultAsync<string | undefined, SeamWalkError> => {
    if (pending.length === 0 || seen.size >= MODULE_GRAPH_WALK_BOUND)
      return okAsyncResult(undefined);
    const current = pending.pop();
    if (current === undefined || seen.has(current)) return walk();
    seen.add(current);
    if (reachesFixture(current, seam, fixture))
      return okAsyncResult(posix(relative(root, current)));
    return ResultAsync.fromPromise(
      Bun.file(current).exists(),
      (): SeamWalkError => ({ type: "FixtureUnreadable", path: current }),
    ).andThen((present) => {
      if (!present || !/\.(ts|js|mjs|cjs)$/.test(current)) return walk();
      return readText(current).andThen((text) => {
        if (!isFixturePolicyScanner(root, current) && mentionsSeam(text))
          return okAsyncResult(SEAM);
        for (const spec of importSpecs(text))
          pending.push(...resolveImportCandidates(current, spec));
        for (const spawned of spawnPaths(text)) {
          if (mentionsSeam(spawned)) return okAsyncResult(SEAM);
        }
        return walk();
      });
    });
  };

  return walk();
}

function isFixturePolicyScanner(root: string, current: string): boolean {
  return current === resolve(root, "scripts/release/publish-reachability.ts");
}

function reachesFixture(
  current: string,
  seam: string,
  fixture: string,
): boolean {
  return (
    current === seam || current === fixture || current.startsWith(`${fixture}/`)
  );
}

function mentionsSeam(text: string): boolean {
  return (
    text.includes(SEAM) ||
    text.includes(LOCAL_REGISTRY_FIXTURE_DIR) ||
    text.includes("local-registry/deprecation-seam")
  );
}

function importSpecs(source: string): readonly string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(IMPORT_SPEC)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

function spawnPaths(source: string): readonly string[] {
  const paths: string[] = [];
  for (const match of source.matchAll(SPAWN_SPEC)) {
    const body = match[1] ?? "";
    for (const part of body.matchAll(/["']([^"']+)["']/g)) {
      const value = part[1];
      if (value !== undefined) paths.push(value);
    }
  }
  return paths;
}

function resolveImportCandidates(
  from: string,
  spec: string,
): readonly string[] {
  if (
    spec.startsWith("bun:") ||
    spec.startsWith("node:") ||
    spec.startsWith("http:") ||
    spec.startsWith("https:")
  )
    return [];
  if (spec === SEAM || spec.endsWith(SEAM) || mentionsSeam(spec))
    return [resolve(ROOT, SEAM)];
  if (!spec.startsWith(".")) return [];
  const base = resolve(dirname(from), spec);
  const withoutJs = base.replace(/\.js$/, ".ts");
  return [base, `${base}.ts`, `${base}.js`, withoutJs, join(base, "index.ts")];
}

function readWorkflowTexts(
  root: string,
): ResultAsync<readonly [string, string][], SeamWalkError> {
  return ResultAsync.fromPromise(
    Array.fromAsync(
      new Bun.Glob("*.{yml,yaml}").scan({
        cwd: join(root, ".github/workflows"),
        onlyFiles: true,
      }),
    ),
    (): SeamWalkError => ({
      type: "FixtureUnreadable",
      path: ".github/workflows",
    }),
  ).andThen((files) =>
    files.reduce<ResultAsync<[string, string][], SeamWalkError>>(
      (chain, file) =>
        chain.andThen((texts) => {
          const path = join(root, ".github/workflows", file);
          return readText(path).map((text): [string, string][] => [
            ...texts,
            [`.github/workflows/${file}`, text],
          ]);
        }),
      okAsyncResult<[string, string][]>([]),
    ),
  );
}

function readJson(
  path: string,
): ResultAsync<Record<string, unknown>, SeamWalkError> {
  return readText(path).andThen((text) => {
    const parsed = Result.fromThrowable(
      () => JSON.parse(text) as unknown,
      () => ({ type: "InvalidFixture" as const, path, reason: "json" }),
    )();
    if (parsed.isErr()) return err(parsed.error);
    if (
      parsed.value === null ||
      typeof parsed.value !== "object" ||
      Array.isArray(parsed.value)
    )
      return err({
        type: "InvalidFixture" as const,
        path,
        reason: "object",
      });
    return ok(parsed.value as Record<string, unknown>);
  });
}

function readText(path: string): ResultAsync<string, SeamWalkError> {
  return ResultAsync.fromPromise(
    Bun.file(path).text(),
    (): SeamWalkError => ({ type: "FixtureUnreadable", path }),
  );
}

function okAsyncResult<T>(value: T): ResultAsync<T, SeamWalkError> {
  return ResultAsync.fromSafePromise(Promise.resolve(value));
}

function posix(path: string): string {
  return path.replaceAll("\\", "/");
}

function tmpdirSafe(): string {
  return join(tmpdir(), "weave-seam-leaks");
}
