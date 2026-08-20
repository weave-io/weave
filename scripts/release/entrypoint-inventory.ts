/**
 * Checked-in production entrypoint inventory for release controllers.
 *
 * Discovery is semantic: package `exports`/`bin`/`main`/`module`/`types`,
 * host metadata, `PUBLIC_PACKAGE_BUILDS`, root and package production
 * scripts, and workflow `run:`/`uses:` graphs. Filename patterns such as
 * `*-main.ts` are never used. An executable release entrypoint reachable
 * from production but absent from this inventory fails typed
 * `UnknownProductionEntrypoint`.
 *
 * Task 14 registers the one pre-existing new-pipeline root,
 * `publish-main.ts`; Task 15 adds the read-only `doctor.ts` root; Task 22 adds
 * the CI API report controller; Task 23 adds the stable preparation
 * controller; Task 24 adds the automatic regeneration controller; Task 25
 * registers every stable publish and independent-attestation workflow root;
 * Task 26 adds the guarded `next` prerelease controller; Task 27 adds the
 * guarded manual `nightly` controller; Task 28 adds the CI policy controller;
 * Task 30 adds the immutable-main docs-audit workflow controllers; Task 35
 * removes every legacy executable entry deleted at cutover and positively
 * retains every new-pipeline entry. Later tasks add, rename, or remove
 * entries in the same change.
 * Test-only roots are never inventoried as production.
 */

import { dirname, join, relative, resolve } from "node:path";
import { logger } from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import { PUBLIC_PACKAGE_BUILDS } from "./constants.js";

const log = logger.child({ module: "entrypoint-inventory" });

export const ENTRYPOINT_INVENTORY_SCHEMA_VERSION = 1 as const;
export const MODULE_GRAPH_WALK_BOUND = 256 as const;
export const DISCOVERY_BOUNDS = {
  packageManifests: 32,
  workflowFiles: 64,
  scriptDepth: 8,
  usesDepth: 8,
  discoveredRoots: 512,
} as const;

export const PRODUCTION_ROOT_CLASSES = [
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
  "workflow-uses",
  "dynamic-import",
  "spawn",
] as const;

export type ProductionRootClass = (typeof PRODUCTION_ROOT_CLASSES)[number];

export const PRODUCTION_ENTRYPOINT_ROLES = ["oidc-publish", "legacy"] as const;

export type ProductionEntrypointRole =
  (typeof PRODUCTION_ENTRYPOINT_ROLES)[number];

export interface ProductionEntrypoint {
  path: string;
  role: ProductionEntrypointRole;
  rationale: string;
}

export interface ProductionRoot {
  kind: ProductionRootClass;
  path: string;
  source: string;
}

export const PRODUCTION_ENTRYPOINTS = [
  {
    path: "scripts/release/publish-main.ts",
    role: "oidc-publish",
    rationale:
      "Task 11 standalone OIDC publication entry. The only new-pipeline executable root that exists when Task 14 creates the inventory.",
  },
  {
    path: "scripts/release/doctor.ts",
    role: "legacy",
    rationale:
      "Task 15 read-only release setup verifier. It performs no publication mutation and is classified so production reachability cannot hide it.",
  },
  {
    path: "scripts/release/api-reports.ts",
    role: "legacy",
    rationale:
      "Task 22 CI API compatibility controller. It runs API Extractor and the checked-in surface-map gate; it performs no publication mutation.",
  },
  {
    path: "scripts/release/release-policy-check.ts",
    role: "legacy",
    rationale:
      "Task 28 required CI release-policy check. It validates changeset, ledger, release-surface, freshness, and cleanup policy; it never mutates a release.",
  },
  {
    path: "scripts/release/prepare-main.ts",
    role: "legacy",
    rationale:
      "Task 23 stable release-PR preparation controller. It validates the maintainer request and delegates marker ownership/finalization to Task 9; it never publishes.",
  },
  {
    path: "scripts/release/regenerate-main.ts",
    role: "legacy",
    rationale:
      "Task 24 automatic main-advance regeneration controller. It delegates only compare-and-swap updates to Task 9 and never creates a pull request.",
  },
  {
    path: "scripts/release/attest-main.ts",
    role: "legacy",
    rationale:
      "Task 25 independent non-reusable artifact-attestation controller. It validates nonsecret identity and cannot reach the publish executor.",
  },
  {
    path: "scripts/release/release-route-main.ts",
    role: "legacy",
    rationale:
      "Task 25 stable route gate. It validates event lineage, rollout topology, and best-effort marker cleanup before downstream work.",
  },
  {
    path: "scripts/release/rollout-gate.ts",
    role: "legacy",
    rationale:
      "Task 25 executable rollout tuple verifier. It performs no build, proof, OIDC, registry, or GitHub mutation.",
  },
  {
    path: "scripts/release/next-main.ts",
    role: "legacy",
    rationale:
      "Task 26 guarded next prerelease controller. It computes closure, stages scratch versions and notes without source mutation, and gates prerelease refs after the shared proof chain.",
  },
  {
    path: "scripts/release/nightly-main.ts",
    role: "legacy",
    rationale:
      "Task 27 guarded manual nightly controller. It computes the affected-since-last-nightly closure, stages deterministic scratch versions and notes, and never consumes changesets or creates Git refs.",
  },
  {
    path: "scripts/release/resume-main.ts",
    role: "legacy",
    rationale:
      "Task 25 stable-resume boundary over the Task 14 state machine. Authority is reread by injected transition ports.",
  },
  {
    path: "scripts/release/incident-main.ts",
    role: "legacy",
    rationale:
      "Task 25 authorized incident generate/readback boundary. It never executes deprecate, unpublish, publish, or latest mutation.",
  },
  {
    path: "scripts/release/build-bind-main.ts",
    role: "legacy",
    rationale:
      "Task 25 build-bind chain step. It validates the released SHA and plan binding before independent attestation.",
  },
  {
    path: "scripts/release/await-attest-main.ts",
    role: "legacy",
    rationale:
      "Task 25 attestation gate chain step. Missing, pending, failed, or foreign digest results block proof and publish.",
  },
  {
    path: "scripts/release/consumer-proof-main.ts",
    role: "legacy",
    rationale:
      "Task 25 clean-consumer proof chain step over exact bound tarball digests.",
  },
  {
    path: "scripts/release/harness-proof-main.ts",
    role: "legacy",
    rationale:
      "Task 25 changed-adapter harness proof chain step over all five required stages.",
  },
  {
    path: "scripts/release/registry-verify-main.ts",
    role: "legacy",
    rationale: "Task 25 post-publish registry digest verification chain step.",
  },
  {
    path: "scripts/release/refs-cleanup-main.ts",
    role: "legacy",
    rationale:
      "Task 25 refs and changeset-cleanup chain boundary. It runs only after registry verification.",
  },
  {
    path: "scripts/release/publish-reachability.ts",
    role: "legacy",
    rationale:
      "Task 25 semantic workflow, script, module, permission, and deprecate-free reachability lint.",
  },
  {
    path: "scripts/release/docs-audit/audit-main.ts",
    role: "legacy",
    rationale:
      "Task 30 deterministic and protected same-repository docs-audit phase adapter.",
  },
  {
    path: "scripts/release/docs-audit/followup-main.ts",
    role: "legacy",
    rationale:
      "Task 30 immutable-main fork follow-up and approval-gated docs proposal adapter.",
  },
  {
    path: "scripts/release/docs-audit/gate-main.ts",
    role: "legacy",
    rationale:
      "Task 30 protected controller for the single terminal docs-audit check.",
  },
] as const satisfies readonly ProductionEntrypoint[];

/**
 * Retained non-publishing executables that production scripts still reach.
 * They are classified so they cannot be mistaken for an unknown new-pipeline
 * root. Task 35 deleted every entry whose file, script, or workflow the
 * cutover removed; what remains supports the new pipeline or a retained
 * non-publishing release helper.
 */
export const LEGACY_ENTRYPOINTS = [
  "scripts/release/changeset-policy.ts",
  "scripts/release/packager.ts",
  "scripts/release/write-artifact-manifest.ts",
  "scripts/release/bind-artifacts.ts",
] as const;

export const TEST_ONLY_ROOT_MARKERS = [
  "scripts/release/__tests__/incident-recovery.integration.test.ts",
  "scripts/release/__tests__/fixture-seam-isolation.test.ts",
  "scripts/release/__tests__/fixtures/local-registry/deprecation-seam.ts",
] as const;

export const LOCAL_REGISTRY_FIXTURE_DIR =
  "scripts/release/__tests__/fixtures/local-registry" as const;

export const SEAM_LEAK_FIXTURE_DIR =
  "scripts/release/__tests__/fixtures/seam-leaks" as const;

export type EntrypointInventoryError =
  | {
      type: "UnknownProductionEntrypoint";
      path: string;
      discoveredFrom: string;
    }
  | { type: "InventoriedEntrypointMissing"; path: string }
  | { type: "TestOnlyInventoriedAsProduction"; path: string }
  | { type: "InvalidInventoryEntry"; issues: readonly string[] }
  | { type: "DiscoveryBoundExceeded"; bound: string };

const EntrypointSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(256)
      .regex(/^scripts\/release\/[A-Za-z0-9._/-]+\.ts$/),
    role: z.enum(PRODUCTION_ENTRYPOINT_ROLES),
    rationale: z.string().min(1).max(512),
  })
  .strict();

export function validateEntrypointInventory(
  entries: readonly ProductionEntrypoint[] = PRODUCTION_ENTRYPOINTS,
): Result<readonly ProductionEntrypoint[], EntrypointInventoryError> {
  const issues: string[] = [];
  for (const entry of entries) {
    const parsed = EntrypointSchema.safeParse(entry);
    if (!parsed.success)
      issues.push(
        ...parsed.error.issues.map(
          (issue) => `${entry.path}: ${issue.message}`,
        ),
      );
    if (isTestOnlyRoot(entry.path))
      return err({
        type: "TestOnlyInventoriedAsProduction",
        path: entry.path,
      });
  }
  if (issues.length > 0) return err({ type: "InvalidInventoryEntry", issues });
  return ok(entries);
}

export function inventoriedPaths(
  entries: readonly ProductionEntrypoint[] = PRODUCTION_ENTRYPOINTS,
): readonly string[] {
  return [
    ...registeredProductionPaths(entries),
    ...LEGACY_ENTRYPOINTS.map((path) => posixPath(path)),
  ];
}

export function registeredProductionPaths(
  entries: readonly ProductionEntrypoint[] = PRODUCTION_ENTRYPOINTS,
): readonly string[] {
  return entries.map((entry) => posixPath(entry.path));
}

export function isTestOnlyRoot(path: string): boolean {
  const normalized = posixPath(path);
  if (
    TEST_ONLY_ROOT_MARKERS.some(
      (marker) => normalized === marker || normalized.endsWith(`/${marker}`),
    )
  )
    return true;
  if (
    normalized.includes("/__tests__/") ||
    normalized.includes("/__fixtures__/")
  )
    return true;
  if (/\.(test|spec)\.ts$/.test(normalized)) return true;
  if (normalized.includes("/fixtures/local-registry/")) return true;
  if (normalized.includes("/fixtures/seam-leaks/")) return true;
  return false;
}

export function isClassifiedReleaseEntrypoint(path: string): boolean {
  const normalized = posixPath(path);
  return inventoriedPaths().some((entry) => entry === normalized);
}

export function isRegisteredProductionEntrypoint(path: string): boolean {
  const normalized = posixPath(path);
  return registeredProductionPaths().some((entry) => entry === normalized);
}

export function isReleaseExecutable(path: string): boolean {
  const normalized = posixPath(path);
  return (
    normalized.startsWith("scripts/release/") &&
    normalized.endsWith(".ts") &&
    !isTestOnlyRoot(normalized)
  );
}

export interface DiscoveredCommand {
  path: string;
  source: string;
}

export interface InventoryValidation {
  classified: readonly string[];
  discovered: readonly DiscoveredCommand[];
  roots: readonly ProductionRoot[];
}

export function discoverProductionReleaseEntrypoints(
  root: string,
): ResultAsync<InventoryValidation, EntrypointInventoryError> {
  return validateEntrypointInventory().asyncAndThen(() =>
    discoverProductionRoots(root).andThen((roots) => {
      for (const item of roots) {
        if (!isReleaseExecutable(item.path)) continue;
        if (!isClassifiedReleaseEntrypoint(item.path))
          return errAsync({
            type: "UnknownProductionEntrypoint" as const,
            path: item.path,
            discoveredFrom: item.source,
          });
      }
      return assertInventoriedFilesExist(root).map(() => ({
        classified: inventoriedPaths(),
        discovered: roots
          .filter(
            (item) =>
              isReleaseExecutable(item.path) &&
              !isRegisteredProductionEntrypoint(item.path),
          )
          .map((item) => ({ path: item.path, source: item.source })),
        roots,
      }));
    }),
  );
}

export function classifyDiscoveredReleaseEntrypoint(input: {
  path: string;
  source: string;
  inventory?: readonly string[];
}): Result<string, EntrypointInventoryError> {
  const inventory = input.inventory ?? inventoriedPaths();
  const path = posixPath(input.path);
  if (isTestOnlyRoot(path)) return ok(path);
  if (!inventory.includes(path))
    return err({
      type: "UnknownProductionEntrypoint",
      path,
      discoveredFrom: input.source,
    });
  return ok(path);
}

export function discoverProductionRoots(
  root: string,
): ResultAsync<readonly ProductionRoot[], EntrypointInventoryError> {
  return collectWorkspaceManifests(root).andThen((manifests) =>
    collectManifestRoots(root, manifests).andThen((manifestRoots) =>
      collectWorkflowRoots(root).map((workflowRoots) => {
        const roots = [
          ...inventoryRoots(),
          ...buildRoots(),
          ...manifestRoots,
          ...workflowRoots,
        ];
        const bounded = roots.slice(0, DISCOVERY_BOUNDS.discoveredRoots);
        const production = bounded.filter(
          (item) => !isTestOnlySource(item.source),
        );
        return uniqueRoots([
          ...production,
          ...dynamicAndSpawnRoots(production),
        ]);
      }),
    ),
  );
}

export function rootsFromPackageManifest(input: {
  manifest: Record<string, unknown>;
  directory: string;
  root: string;
  source: string;
  scriptKind: "root-script" | "package-script";
}): readonly ProductionRoot[] {
  const roots: ProductionRoot[] = [];
  pushField(roots, "main", input, input.manifest.main);
  pushField(roots, "module", input, input.manifest.module);
  pushField(roots, "types", input, input.manifest.types);
  collectBinTargets(roots, input, input.manifest.bin);
  collectExportTargets(roots, input, input.manifest.exports);
  collectHostMetadata(roots, input, input.manifest.pi);
  const scripts = stringRecord(input.manifest.scripts);
  if (scripts !== undefined)
    roots.push(
      ...collectScriptRootsFromRecord(scripts, {
        kind: input.scriptKind,
        root: input.root,
        directory: input.directory,
        sourcePrefix: input.source,
      }),
    );
  return roots;
}

export function rootsFromWorkflowText(input: {
  text: string;
  source: string;
}): readonly ProductionRoot[] {
  const roots: ProductionRoot[] = [];
  for (const path of workflowCommandPaths(input.text))
    roots.push({
      kind: "workflow-run",
      path,
      source: `${input.source}:run`,
    });
  for (const path of workflowLocalUses(input.text))
    roots.push({
      kind: "workflow-uses",
      path,
      source: `${input.source}:uses`,
    });
  return roots;
}

export function rootsFromBuildEntries(
  entries: readonly { source: string }[],
  source: string,
): readonly ProductionRoot[] {
  return entries.map((entry) => ({
    kind: "build-entry" as const,
    path: posixPath(entry.source),
    source,
  }));
}

export function scriptCommandPaths(command: string): readonly string[] {
  const paths: string[] = [];
  const bunFile =
    /\bbun(?:x)?(?:\s+run)?\s+(?:--[A-Za-z0-9-]+\s+)*((?:\.\.\/|\.\/)*(?:scripts|packages)\/[A-Za-z0-9._/-]+\.ts)/g;
  for (const match of command.matchAll(bunFile)) {
    const path = match[1];
    if (path !== undefined) paths.push(path);
  }
  return unique(paths);
}

export function workflowCommandPaths(source: string): readonly string[] {
  const paths: string[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith("run:")) continue;
    const command = trimmed.slice("run:".length).trim();
    if (command === "|" || command === ">" || command.length === 0) {
      const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
      const block: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const body = lines[next];
        if (body === undefined) break;
        const bodyIndent = body.match(/^\s*/)?.[0]?.length ?? 0;
        if (body.trim().length === 0) continue;
        if (bodyIndent <= indent) break;
        block.push(body.trim());
      }
      paths.push(...scriptCommandPaths(block.join("\n")));
      continue;
    }
    paths.push(...scriptCommandPaths(command));
  }
  for (const match of source.matchAll(
    /bun(?:\s+run)?\s+((?:scripts|packages)\/[A-Za-z0-9._/-]+\.ts)/g,
  )) {
    const path = match[1];
    if (path !== undefined) paths.push(path);
  }
  return unique(paths);
}

export function workflowLocalUses(source: string): readonly string[] {
  const paths: string[] = [];
  for (const match of source.matchAll(/uses:\s*(\.\/[A-Za-z0-9._/-]+)/g)) {
    const path = match[1];
    if (path !== undefined) paths.push(path.slice(2));
  }
  return unique(paths);
}

export function scriptAliases(command: string): readonly string[] {
  const aliases: string[] = [];
  for (const match of command.matchAll(/\bbun\s+run\s+([^\n;&]+)/g)) {
    const tokens = (match[1] ?? "").split(/\s+/).filter(Boolean);
    const name = tokens.find((token) => !token.startsWith("-"));
    if (name !== undefined && !name.includes("/") && !name.endsWith(".ts"))
      aliases.push(name);
  }
  return unique(aliases);
}

function inventoryRoots(): readonly ProductionRoot[] {
  return PRODUCTION_ENTRYPOINTS.map((entry) => ({
    kind: "inventory" as const,
    path: entry.path,
    source: "entrypoint-inventory",
  }));
}

function buildRoots(): readonly ProductionRoot[] {
  const roots: ProductionRoot[] = [];
  for (const [packageName, build] of Object.entries(PUBLIC_PACKAGE_BUILDS))
    roots.push(
      ...rootsFromBuildEntries(
        build.entries,
        `PUBLIC_PACKAGE_BUILDS.${packageName}`,
      ),
    );
  return roots;
}

function collectManifestRoots(
  root: string,
  manifests: readonly string[],
): ResultAsync<ProductionRoot[], EntrypointInventoryError> {
  return manifests.reduce<
    ResultAsync<ProductionRoot[], EntrypointInventoryError>
  >(
    (chain, manifest) =>
      chain.andThen((found) =>
        readOptionalJson(manifest).map((parsed) => {
          if (parsed === undefined) return found;
          const relativeManifest = posixPath(relative(root, manifest));
          const directory = posixPath(dirname(relativeManifest));
          const scriptKind =
            relativeManifest === "package.json"
              ? ("root-script" as const)
              : ("package-script" as const);
          return [
            ...found,
            ...rootsFromPackageManifest({
              manifest: parsed,
              directory: directory === "." ? "" : directory,
              root,
              source: relativeManifest,
              scriptKind,
            }),
          ];
        }),
      ),
    okAsync([]),
  );
}

function collectWorkflowRoots(
  root: string,
): ResultAsync<ProductionRoot[], EntrypointInventoryError> {
  return listWorkflowFiles(root).andThen((files) =>
    walkWorkflowGraph(root, files, new Set(), 0),
  );
}

function walkWorkflowGraph(
  root: string,
  files: readonly string[],
  seen: Set<string>,
  depth: number,
): ResultAsync<ProductionRoot[], EntrypointInventoryError> {
  if (depth >= DISCOVERY_BOUNDS.usesDepth) return okAsync([]);
  return files.reduce<ResultAsync<ProductionRoot[], EntrypointInventoryError>>(
    (chain, file) =>
      chain.andThen((found) => {
        const normalized = posixPath(relative(root, file));
        if (seen.has(normalized)) return okAsync(found);
        seen.add(normalized);
        if (seen.size > DISCOVERY_BOUNDS.workflowFiles)
          return errAsync({
            type: "DiscoveryBoundExceeded" as const,
            bound: "workflowFiles",
          });
        return readOptionalText(file).andThen((text) => {
          if (text === undefined) return okAsync(found);
          const roots = rootsFromWorkflowText({
            text,
            source: normalized,
          });
          const nested = roots
            .filter((item) => item.kind === "workflow-uses")
            .map((item) => join(root, item.path));
          return expandUsesFiles(root, nested).andThen((nextFiles) =>
            walkWorkflowGraph(root, nextFiles, seen, depth + 1).map((child) => [
              ...found,
              ...roots,
              ...child,
            ]),
          );
        });
      }),
    okAsync([]),
  );
}

function expandUsesFiles(
  _root: string,
  candidates: readonly string[],
): ResultAsync<readonly string[], EntrypointInventoryError> {
  return candidates.reduce<ResultAsync<string[], EntrypointInventoryError>>(
    (chain, candidate) =>
      chain.andThen((found) =>
        fileExists(candidate).andThen((present) => {
          if (present) return okAsync([...found, candidate]);
          const actionYml = join(candidate, "action.yml");
          const actionYaml = join(candidate, "action.yaml");
          return fileExists(actionYml).andThen((yml) =>
            fileExists(actionYaml).map((yaml) => {
              if (yml) found.push(actionYml);
              if (yaml) found.push(actionYaml);
              return found;
            }),
          );
        }),
      ),
    okAsync([]),
  );
}

function collectWorkspaceManifests(
  root: string,
): ResultAsync<readonly string[], EntrypointInventoryError> {
  const rootManifest = join(root, "package.json");
  return readOptionalJson(rootManifest).andThen((parsed) => {
    const workspaces = workspacePatterns(parsed);
    return expandWorkspaceGlobs(root, workspaces).map((expanded) =>
      unique([rootManifest, ...expanded]).slice(
        0,
        DISCOVERY_BOUNDS.packageManifests,
      ),
    );
  });
}

function expandWorkspaceGlobs(
  root: string,
  workspaces: readonly string[],
): ResultAsync<string[], EntrypointInventoryError> {
  return workspaces.reduce<ResultAsync<string[], EntrypointInventoryError>>(
    (chain, workspace) =>
      chain.andThen((found) => {
        if (found.length >= DISCOVERY_BOUNDS.packageManifests)
          return okAsync(found);
        if (!workspace.includes("*"))
          return okAsync([...found, join(root, workspace, "package.json")]);
        return ResultAsync.fromPromise(
          Array.fromAsync(
            new Bun.Glob(`${workspace}/package.json`).scan({
              cwd: root,
              onlyFiles: true,
            }),
          ),
          (): EntrypointInventoryError => ({
            type: "InvalidInventoryEntry",
            issues: [`workspace glob ${workspace} is unreadable`],
          }),
        ).map((matches) => [
          ...found,
          ...matches.map((match) => join(root, match)),
        ]);
      }),
    okAsync([]),
  );
}

function workspacePatterns(
  manifest: Record<string, unknown> | undefined,
): readonly string[] {
  if (manifest === undefined) return [];
  const value = manifest.workspaces;
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  if (value !== null && typeof value === "object") {
    const packages = (value as { packages?: unknown }).packages;
    if (Array.isArray(packages))
      return packages.filter(
        (entry): entry is string => typeof entry === "string",
      );
  }
  return [];
}

function collectScriptRootsFromRecord(
  scripts: Record<string, string>,
  input: {
    kind: "root-script" | "package-script";
    root: string;
    directory: string;
    sourcePrefix: string;
  },
): readonly ProductionRoot[] {
  const roots: ProductionRoot[] = [];
  const seen = new Set<string>();
  for (const [name, command] of Object.entries(scripts)) {
    if (isTestScript(name, command)) continue;
    for (const path of expandScriptCommand(command, scripts, 0, input)) {
      const key = `${input.kind}:${path}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push({
        kind: input.kind,
        path,
        source: `${input.sourcePrefix}#scripts.${name}`,
      });
    }
  }
  return roots;
}

function expandScriptCommand(
  command: string,
  scripts: Record<string, string>,
  depth: number,
  input: { root: string; directory: string },
): readonly string[] {
  if (depth >= DISCOVERY_BOUNDS.scriptDepth) return [];
  const paths = resolveCommandFilePaths(command, input);
  const nested: string[] = [];
  for (const alias of scriptAliases(command)) {
    const next = scripts[alias];
    if (next === undefined || isTestScript(alias, next)) continue;
    nested.push(...expandScriptCommand(next, scripts, depth + 1, input));
  }
  return unique([...paths, ...nested]);
}

function resolveCommandFilePaths(
  command: string,
  input: { root: string; directory: string },
): readonly string[] {
  const paths: string[] = [];
  for (const path of scriptCommandPaths(command)) {
    const resolved = resolveDiscoveredPath(input.root, input.directory, path);
    if (resolved !== undefined) paths.push(resolved);
  }
  return paths;
}

function collectBinTargets(
  roots: ProductionRoot[],
  input: {
    directory: string;
    root: string;
    source: string;
  },
  bin: unknown,
): void {
  if (typeof bin === "string") {
    pushField(roots, "bin", input, bin);
    return;
  }
  if (bin === null || typeof bin !== "object") return;
  for (const target of Object.values(bin))
    if (typeof target === "string") pushField(roots, "bin", input, target);
}

function collectExportTargets(
  roots: ProductionRoot[],
  input: {
    directory: string;
    root: string;
    source: string;
  },
  exportsField: unknown,
): void {
  if (typeof exportsField === "string") {
    pushField(roots, "exports", input, exportsField);
    return;
  }
  if (exportsField === null || typeof exportsField !== "object") return;
  for (const value of Object.values(exportsField))
    collectExportTargets(roots, input, value);
}

function collectHostMetadata(
  roots: ProductionRoot[],
  input: {
    directory: string;
    root: string;
    source: string;
  },
  value: unknown,
): void {
  if (typeof value === "string") {
    if (looksLikePath(value)) pushField(roots, "host-metadata", input, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectHostMetadata(roots, input, entry);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const entry of Object.values(value))
    collectHostMetadata(roots, input, entry);
}

function pushField(
  roots: ProductionRoot[],
  kind: ProductionRootClass,
  input: { directory: string; root: string; source: string },
  value: unknown,
): void {
  if (typeof value !== "string") return;
  const path = resolveDiscoveredPath(input.root, input.directory, value);
  if (path === undefined) return;
  roots.push({ kind, path, source: input.source });
}

function resolveDiscoveredPath(
  root: string,
  directory: string,
  value: string,
): string | undefined {
  const normalized = posixPath(value.replace(/^\.\//, ""));
  if (
    normalized.startsWith("scripts/") ||
    normalized.startsWith("packages/") ||
    normalized.startsWith(".github/")
  )
    return normalized;
  const from = directory.length === 0 ? root : join(root, directory);
  const resolved = posixPath(relative(root, resolve(from, value)));
  if (resolved.startsWith("..")) return undefined;
  return resolved;
}

function looksLikePath(value: string): boolean {
  return (
    value.startsWith(".") ||
    value.startsWith("scripts/") ||
    value.startsWith("packages/") ||
    value.includes("/")
  );
}

function dynamicAndSpawnRoots(
  roots: readonly ProductionRoot[],
): readonly ProductionRoot[] {
  const extra: ProductionRoot[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root.path) || !/\.(ts|js|mjs|cjs)$/.test(root.path)) continue;
    seen.add(root.path);
    extra.push({
      kind: "dynamic-import",
      path: root.path,
      source: `${root.source}:dynamic-import-scan`,
    });
    extra.push({
      kind: "spawn",
      path: root.path,
      source: `${root.source}:spawn-scan`,
    });
  }
  return extra;
}

function isTestOnlySource(source: string): boolean {
  const origin = posixPath(source.split("#")[0] ?? source);
  return isTestOnlyRoot(origin);
}

function isTestScript(name: string, command: string): boolean {
  if (name === "test" || name.startsWith("test:")) return true;
  if (/\bbun\s+test\b/.test(command)) return true;
  if (/\*\.(test|spec)\.ts/.test(command)) return true;
  return false;
}

function listWorkflowFiles(
  root: string,
): ResultAsync<readonly string[], EntrypointInventoryError> {
  const workflows = join(root, ".github/workflows");
  return ResultAsync.fromPromise(
    Array.fromAsync(
      new Bun.Glob("*.{yml,yaml}").scan({
        cwd: workflows,
        onlyFiles: true,
      }),
    ),
    (): EntrypointInventoryError => ({
      type: "InvalidInventoryEntry",
      issues: ["workflow directory is unreadable"],
    }),
  ).map((files) =>
    files
      .slice(0, DISCOVERY_BOUNDS.workflowFiles)
      .map((file) => join(workflows, file)),
  );
}

function assertInventoriedFilesExist(
  root: string,
): ResultAsync<void, EntrypointInventoryError> {
  return PRODUCTION_ENTRYPOINTS.map((entry) => entry.path).reduce<
    ResultAsync<void, EntrypointInventoryError>
  >(
    (chain, path) =>
      chain.andThen(() => {
        if (isTestOnlyRoot(path))
          return errAsync({
            type: "TestOnlyInventoriedAsProduction" as const,
            path,
          });
        return fileExists(join(root, path)).andThen((present) =>
          present
            ? okAsync(undefined)
            : errAsync({
                type: "InventoriedEntrypointMissing" as const,
                path,
              }),
        );
      }),
    okAsync(undefined),
  );
}

function readOptionalJson(
  path: string,
): ResultAsync<Record<string, unknown> | undefined, EntrypointInventoryError> {
  return readOptionalText(path).map((text) => {
    if (text === undefined) return undefined;
    return parseJsonObject(text);
  });
}

function readOptionalText(
  path: string,
): ResultAsync<string | undefined, EntrypointInventoryError> {
  return fileExists(path).andThen((present) => {
    if (!present) return okAsync(undefined);
    return ResultAsync.fromPromise(
      Bun.file(path).text(),
      (): EntrypointInventoryError => ({
        type: "InvalidInventoryEntry",
        issues: [`${path} is unreadable`],
      }),
    );
  });
}

function fileExists(
  path: string,
): ResultAsync<boolean, EntrypointInventoryError> {
  return ResultAsync.fromPromise(
    Bun.file(path).exists(),
    (): EntrypointInventoryError => ({
      type: "InvalidInventoryEntry",
      issues: [`${path} is unreadable`],
    }),
  );
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const parsed = Result.fromThrowable(
    () => JSON.parse(text) as unknown,
    () => undefined,
  )();
  if (parsed.isErr()) return undefined;
  if (
    parsed.value === null ||
    typeof parsed.value !== "object" ||
    Array.isArray(parsed.value)
  )
    return undefined;
  return parsed.value as Record<string, unknown>;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value))
    if (typeof entry === "string") record[key] = entry;
  return record;
}

function posixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function uniqueRoots(
  roots: readonly ProductionRoot[],
): readonly ProductionRoot[] {
  const seen = new Set<string>();
  const uniqueItems: ProductionRoot[] = [];
  for (const root of roots) {
    const key = `${root.kind}:${root.path}:${root.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueItems.push(root);
  }
  return uniqueItems;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../..");
  const inventory = validateEntrypointInventory();
  if (inventory.isErr()) {
    log.error({ error: inventory.error }, "entrypoint inventory is invalid");
    process.exitCode = 2;
  } else {
    const discovered = await discoverProductionReleaseEntrypoints(root);
    if (discovered.isErr()) {
      log.error(
        { error: discovered.error },
        "unknown or missing production entrypoint",
      );
      process.exitCode = 1;
    } else {
      log.info(
        {
          classified: discovered.value.classified.length,
          discovered: discovered.value.discovered.length,
        },
        "entrypoint inventory classified",
      );
    }
  }
}
