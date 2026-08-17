/**
 * Impure host-module loader edge (Pi adapter contract).
 *
 * Discovers the proven host package, registers exact-path `Bun.plugin`
 * `onLoad` overrides for nested copies, and imports the host namespaces.
 * Every I/O and plugin call goes through `PiHostModuleEnvironmentPort` so
 * tests never touch Bun's real plugin registry or the filesystem.
 *
 * This module never imports a Pi host package and never logs: the caller
 * decides what surfaces. Redirect failure is always fail-open.
 */
import { dirname, join } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  hostEntrySpecifierFor,
  isSafeAbsoluteHostPath,
  PI_HOST_MODULE_SPECIFIERS,
  type PiHostModuleRedirectInput,
  type PiHostModuleSpecifier,
  type PiHostRedirectReason,
  planHostModuleRedirect,
  renderHostReexportStub,
} from "./host-module-redirect.js";
import { safelyAwaitPortResult } from "./port-safety.js";

/** Operator escape hatch and Task 5 negative control. Honor only the value `1`. */
export const WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT_ENV =
  "WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT";

/** Opt-in proof line. Honor only the value `1`; it contains absolute paths. */
export const WEAVE_PI_HOST_MODULE_PROOF_ENV = "WEAVE_PI_HOST_MODULE_PROOF";

/** Single-line JSON budget for the opt-in proof record. */
export const MAX_HOST_MODULE_PROOF_LINE_LENGTH = 32_768;

/**
 * Dedicated skip reason when the operator disables the redirect. Not part of
 * the planner's closed reason union: the loader never asks the planner.
 */
export const PI_HOST_MODULE_REDIRECT_DISABLED_REASON = "redirect-disabled";

export type PiHostModuleSkipReason =
  | PiHostRedirectReason
  | typeof PI_HOST_MODULE_REDIRECT_DISABLED_REASON;

export type PiHostModuleEnvironmentError =
  | { readonly type: "MainModuleUnavailable" }
  | { readonly type: "JsonReadFailed"; readonly path: string }
  | { readonly type: "ResolveFailed"; readonly specifier: string }
  | { readonly type: "RegisterOverrideFailed"; readonly path: string }
  | { readonly type: "ImportFailed"; readonly path: string }
  | { readonly type: "PortThrew" };

/**
 * Injectable I/O and plugin surface. Every member is fallible so a missing
 * host, unreadable package, or plugin gap becomes a skip rather than a throw.
 */
export interface PiHostModuleEnvironmentPort {
  mainModulePath(): ResultAsync<string, PiHostModuleEnvironmentError>;
  readJsonFile(
    path: string,
  ): ResultAsync<unknown, PiHostModuleEnvironmentError>;
  resolveFrom(
    specifier: string,
    fromDir: string,
  ): ResultAsync<string, PiHostModuleEnvironmentError>;
  resolveLocal(
    specifier: string,
  ): ResultAsync<string, PiHostModuleEnvironmentError>;
  registerLoadOverride(
    exactPath: string,
    contents: string,
  ): ResultAsync<void, PiHostModuleEnvironmentError>;
  importAbsolute(
    path: string,
  ): ResultAsync<unknown, PiHostModuleEnvironmentError>;
}

export interface ResolveHostModulesOptions {
  /** When omitted, production reads `Bun.env`. Tests pass an isolated table. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam for the opt-in proof line. Production writes to stderr. */
  readonly proofWrite?: (line: string) => void;
}

export interface PiHostModuleProofLineSpecifier {
  readonly specifier: PiHostModuleSpecifier;
  readonly bareResolution?: string;
  readonly loadedFrom?: string;
  readonly redirected: boolean;
}

/** Machine-readable proof payload. Absolute paths are allowed only here. */
export interface PiHostModuleProofLine {
  readonly weaveHostModuleProof: {
    readonly hostRoot?: string;
    readonly hostVersion?: string;
    readonly specifiers: readonly PiHostModuleProofLineSpecifier[];
  };
}

export type PiHostLocalResolutions = {
  readonly [K in PiHostModuleSpecifier]: string | undefined;
};

export interface PiHostModuleSkippedSpecifier {
  readonly specifier: PiHostModuleSpecifier;
  readonly reason: PiHostModuleSkipReason;
}

export interface PiHostModuleProofSpecifier {
  readonly specifier: PiHostModuleSpecifier;
  readonly hostSpecifier: string;
  readonly localEntryPath?: string;
  readonly hostEntryPath?: string;
  readonly redirected: boolean;
  readonly skipReason?: PiHostModuleSkipReason;
  readonly bareResolution?: string;
  readonly loadedFrom?: string;
}

/** Opt-in proof record. May carry absolute paths; never log this by default. */
export interface PiHostModuleProofRecord {
  readonly hostRoot?: string;
  readonly hostVersion?: string;
  readonly specifiers: readonly PiHostModuleProofSpecifier[];
}

export interface PiHostModuleOutcome {
  readonly redirected: readonly PiHostModuleSpecifier[];
  readonly skipped: readonly PiHostModuleSkippedSpecifier[];
  readonly hostVersion?: string;
  readonly hostRoot?: string;
  readonly localResolutions: PiHostLocalResolutions;
  readonly proofRecord: PiHostModuleProofRecord;
}

const BUNFS_MARKER = "$bunfs";
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

const registeredSpecifiersByEnv = new WeakMap<
  PiHostModuleEnvironmentPort,
  Set<PiHostModuleSpecifier>
>();

function registeredSpecifiersFor(
  env: PiHostModuleEnvironmentPort,
): Set<PiHostModuleSpecifier> {
  const existing = registeredSpecifiersByEnv.get(env);
  if (existing !== undefined) return existing;
  const created = new Set<PiHostModuleSpecifier>();
  registeredSpecifiersByEnv.set(env, created);
  return created;
}

function emptyLocalResolutions(): PiHostLocalResolutions {
  return {
    "@earendil-works/pi-coding-agent": undefined,
    "@earendil-works/pi-ai": undefined,
    "@earendil-works/pi-tui": undefined,
  };
}

function skipAllSpecifiers(
  reason: PiHostModuleSkipReason,
): readonly PiHostModuleSkippedSpecifier[] {
  return PI_HOST_MODULE_SPECIFIERS.map((specifier) => ({
    specifier,
    reason,
  }));
}

function skipAllProof(
  reason: PiHostModuleSkipReason,
  hostRoot: string | undefined,
  hostVersion: string | undefined,
  localResolutions: PiHostLocalResolutions,
): PiHostModuleProofRecord {
  return {
    ...(hostRoot === undefined ? {} : { hostRoot }),
    ...(hostVersion === undefined ? {} : { hostVersion }),
    specifiers: PI_HOST_MODULE_SPECIFIERS.map((specifier) => {
      const local = localResolutions[specifier];
      return {
        specifier,
        hostSpecifier: hostEntrySpecifierFor(specifier),
        redirected: false,
        skipReason: reason,
        ...(local === undefined ? {} : { bareResolution: local }),
      };
    }),
  };
}

function skipAllOutcome(input: {
  readonly reason: PiHostModuleSkipReason;
  readonly hostRoot?: string;
  readonly hostVersion?: string;
  readonly localResolutions?: PiHostLocalResolutions;
}): PiHostModuleOutcome {
  const localResolutions = input.localResolutions ?? emptyLocalResolutions();
  return {
    redirected: [],
    skipped: skipAllSpecifiers(input.reason),
    ...(input.hostVersion === undefined
      ? {}
      : { hostVersion: input.hostVersion }),
    ...(input.hostRoot === undefined ? {} : { hostRoot: input.hostRoot }),
    localResolutions,
    proofRecord: skipAllProof(
      input.reason,
      input.hostRoot,
      input.hostVersion,
      localResolutions,
    ),
  };
}

/**
 * Escape regex metacharacters so an `onLoad` filter matches one exact path.
 */
export function escapeExactPathRegExp(value: string): string {
  return value.replace(REGEXP_SPECIALS, "\\$&");
}

/** Exact-path `onLoad` filter for one resolved local entry. */
export function exactPathLoadFilter(exactPath: string): RegExp {
  return new RegExp(`^${escapeExactPathRegExp(exactPath)}$`);
}

/**
 * Host package root is the parent of the directory that contains the host
 * CLI entry. A compiled Bun binary's `$bunfs` path is unproven: do not
 * fabricate a filesystem root from it.
 */
export function deriveHostPackageRoot(
  cliEntryPath: string,
): Result<string, { readonly reason: "host-root-unproven" }> {
  if (cliEntryPath.includes(BUNFS_MARKER)) {
    return err({ reason: "host-root-unproven" });
  }
  if (!isSafeAbsoluteHostPath(cliEntryPath)) {
    return err({ reason: "host-root-unproven" });
  }
  const hostRoot = dirname(dirname(cliEntryPath));
  if (!isSafeAbsoluteHostPath(hostRoot)) {
    return err({ reason: "host-root-unproven" });
  }
  return ok(hostRoot);
}

function parseHostPackageIdentity(
  value: unknown,
): Result<
  { readonly name: string; readonly version: string },
  { readonly reason: "host-package-mismatch" }
> {
  if (typeof value !== "object" || value === null) {
    return err({ reason: "host-package-mismatch" });
  }
  if (!("name" in value) || !("version" in value)) {
    return err({ reason: "host-package-mismatch" });
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    return err({ reason: "host-package-mismatch" });
  }
  if (typeof value.version !== "string" || value.version.length === 0) {
    return err({ reason: "host-package-mismatch" });
  }
  return ok({ name: value.name, version: value.version });
}

function namespaceHasDefaultExport(namespace: unknown): boolean {
  return (
    typeof namespace === "object" &&
    namespace !== null &&
    "default" in namespace
  );
}

function disableRedirectRequested(
  options: ResolveHostModulesOptions | undefined,
): boolean {
  const source = options?.env ?? Bun.env;
  return source[WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT_ENV] === "1";
}

function hostModuleProofRequested(
  options: ResolveHostModulesOptions | undefined,
): boolean {
  const source = options?.env ?? Bun.env;
  return source[WEAVE_PI_HOST_MODULE_PROOF_ENV] === "1";
}

function boundProofPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isSafeAbsoluteHostPath(value)) return undefined;
  return value;
}

function boundProofVersion(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.length <= 64) return value;
  return value.slice(0, 64);
}

function writeProofLineToStderr(line: string): void {
  Result.fromThrowable(
    (): void => {
      const written = Bun.stderr.write(`${line}\n`);
      if (written instanceof Promise) {
        void written;
      }
    },
    () => undefined,
  )();
}

/**
 * Project the detailed proof record to the opt-in stderr JSON shape.
 * One line, valid JSON, bounded, with absolute paths only.
 */
export function renderHostModuleProofLine(
  outcome: PiHostModuleOutcome,
): string {
  const proof: PiHostModuleProofLine = {
    weaveHostModuleProof: {
      ...(boundProofPath(outcome.proofRecord.hostRoot) === undefined
        ? {}
        : { hostRoot: boundProofPath(outcome.proofRecord.hostRoot) }),
      ...(boundProofVersion(outcome.proofRecord.hostVersion) === undefined
        ? {}
        : { hostVersion: boundProofVersion(outcome.proofRecord.hostVersion) }),
      specifiers: outcome.proofRecord.specifiers.map((entry) => ({
        specifier: entry.specifier,
        ...(boundProofPath(entry.bareResolution) === undefined
          ? {}
          : { bareResolution: boundProofPath(entry.bareResolution) }),
        ...(boundProofPath(entry.loadedFrom) === undefined
          ? {}
          : { loadedFrom: boundProofPath(entry.loadedFrom) }),
        redirected: entry.redirected,
      })),
    },
  };
  const json = JSON.stringify(proof);
  if (
    json.length <= MAX_HOST_MODULE_PROOF_LINE_LENGTH &&
    !json.includes("\n")
  ) {
    return json;
  }
  return JSON.stringify({
    weaveHostModuleProof: {
      ...(boundProofVersion(outcome.proofRecord.hostVersion) === undefined
        ? {}
        : { hostVersion: boundProofVersion(outcome.proofRecord.hostVersion) }),
      specifiers: [],
    },
  });
}

/**
 * Write exactly one proof line to the writer when the env var is strictly
 * `1`. Never logs. Returns whether a line was written.
 */
export function maybeWriteHostModuleProofLine(
  outcome: PiHostModuleOutcome,
  options?: ResolveHostModulesOptions,
): boolean {
  if (!hostModuleProofRequested(options)) return false;
  const write = options?.proofWrite ?? writeProofLineToStderr;
  write(renderHostModuleProofLine(outcome));
  return true;
}

function callEnv<T>(
  call: () => ResultAsync<T, PiHostModuleEnvironmentError>,
): ResultAsync<T, PiHostModuleEnvironmentError> {
  return safelyAwaitPortResult(
    call,
    (): PiHostModuleEnvironmentError => ({ type: "PortThrew" }),
  );
}

function optionalEnvString(
  call: () => ResultAsync<string, PiHostModuleEnvironmentError>,
): ResultAsync<string | undefined, never> {
  return callEnv(call)
    .map((value): string | undefined => value)
    .orElse(() => okAsync(undefined));
}

function liftResult<T, E>(result: Result<T, E>): ResultAsync<T, E> {
  return result.match(
    (value) => okAsync(value),
    (error) => errAsync(error),
  );
}

function toFilesystemPath(resolved: string): string {
  if (!resolved.startsWith("file:")) return resolved;
  return Bun.fileURLToPath(resolved);
}

async function gatherSpecifierFacts(
  env: PiHostModuleEnvironmentPort,
  hostRoot: string,
): Promise<{
  readonly specifiers: PiHostModuleRedirectInput["specifiers"];
  readonly localResolutions: PiHostLocalResolutions;
}> {
  const localResolutions = { ...emptyLocalResolutions() };
  const specifiers = {
    "@earendil-works/pi-coding-agent": {},
    "@earendil-works/pi-ai": {},
    "@earendil-works/pi-tui": {},
  } as {
    [K in PiHostModuleSpecifier]: {
      localEntryPath?: string;
      hostEntryPath?: string;
    };
  };

  for (const specifier of PI_HOST_MODULE_SPECIFIERS) {
    const hostSpecifier = hostEntrySpecifierFor(specifier);
    const hostEntry = await optionalEnvString(() =>
      env.resolveFrom(hostSpecifier, hostRoot),
    );
    const localEntry = await optionalEnvString(() =>
      env.resolveLocal(specifier),
    );
    const hostEntryPath = hostEntry.isOk() ? hostEntry.value : undefined;
    const localEntryPath = localEntry.isOk() ? localEntry.value : undefined;
    localResolutions[specifier] = localEntryPath;
    specifiers[specifier] = {
      ...(localEntryPath === undefined ? {} : { localEntryPath }),
      ...(hostEntryPath === undefined ? {} : { hostEntryPath }),
    };
  }

  return { specifiers, localResolutions };
}

function proofFromAppliedPlan(input: {
  readonly hostRoot: string;
  readonly hostVersion: string;
  readonly planned: ReturnType<typeof planHostModuleRedirect>;
  readonly redirected: readonly PiHostModuleSpecifier[];
  readonly skipped: readonly PiHostModuleSkippedSpecifier[];
  readonly localResolutions: PiHostLocalResolutions;
}): PiHostModuleProofRecord {
  const redirectedSet = new Set(input.redirected);
  const skipBySpecifier = new Map(
    input.skipped.map((entry) => [entry.specifier, entry]),
  );
  const plannedProof = input.planned.isOk()
    ? input.planned.value.proof
    : undefined;

  return {
    hostRoot: input.hostRoot,
    hostVersion: input.hostVersion,
    specifiers: PI_HOST_MODULE_SPECIFIERS.map((specifier) => {
      const plannedEntry = plannedProof?.specifiers.find(
        (entry) => entry.specifier === specifier,
      );
      const skipped = skipBySpecifier.get(specifier);
      const local = input.localResolutions[specifier];
      const hostEntryPath = plannedEntry?.hostEntryPath;
      const redirected = redirectedSet.has(specifier);
      return {
        specifier,
        hostSpecifier: hostEntrySpecifierFor(specifier),
        ...(plannedEntry?.localEntryPath === undefined
          ? {}
          : { localEntryPath: plannedEntry.localEntryPath }),
        ...(hostEntryPath === undefined ? {} : { hostEntryPath }),
        redirected,
        ...(skipped === undefined ? {} : { skipReason: skipped.reason }),
        ...(local === undefined ? {} : { bareResolution: local }),
        ...(redirected && hostEntryPath !== undefined
          ? { loadedFrom: hostEntryPath }
          : {}),
      };
    }),
  };
}

async function registerPlannedRedirects(
  env: PiHostModuleEnvironmentPort,
  plannedRedirects: readonly {
    readonly specifier: PiHostModuleSpecifier;
    readonly localEntryPath: string;
    readonly hostEntryPath: string;
  }[],
): Promise<{
  readonly redirected: PiHostModuleSpecifier[];
  readonly pluginSkips: PiHostModuleSkippedSpecifier[];
}> {
  const alreadyRegistered = registeredSpecifiersFor(env);
  const redirected: PiHostModuleSpecifier[] = [];
  const pluginSkips: PiHostModuleSkippedSpecifier[] = [];
  const newlyRegistered: {
    readonly specifier: PiHostModuleSpecifier;
    readonly localEntryPath: string;
  }[] = [];

  for (const target of plannedRedirects) {
    if (alreadyRegistered.has(target.specifier)) {
      redirected.push(target.specifier);
      continue;
    }

    const importedHost = await callEnv(() =>
      env.importAbsolute(target.hostEntryPath),
    );
    const stub = renderHostReexportStub({
      hostEntryPath: target.hostEntryPath,
      hasDefaultExport:
        importedHost.isOk() && namespaceHasDefaultExport(importedHost.value),
    });
    const registered = await callEnv(() =>
      env.registerLoadOverride(target.localEntryPath, stub),
    );
    if (registered.isErr()) {
      pluginSkips.push({
        specifier: target.specifier,
        reason: "plugin-unavailable",
      });
      continue;
    }
    alreadyRegistered.add(target.specifier);
    redirected.push(target.specifier);
    newlyRegistered.push({
      specifier: target.specifier,
      localEntryPath: target.localEntryPath,
    });
  }

  for (const target of newlyRegistered) {
    await callEnv(() => env.importAbsolute(target.localEntryPath));
  }

  return { redirected, pluginSkips };
}

async function runResolveHostModules(
  env: PiHostModuleEnvironmentPort,
  options: ResolveHostModulesOptions | undefined,
): Promise<PiHostModuleOutcome> {
  if (disableRedirectRequested(options)) {
    return skipAllOutcome({ reason: PI_HOST_MODULE_REDIRECT_DISABLED_REASON });
  }

  const mainPath = await callEnv(() => env.mainModulePath());
  if (mainPath.isErr()) {
    return skipAllOutcome({ reason: "host-root-unproven" });
  }

  const hostRootResult = deriveHostPackageRoot(mainPath.value);
  if (hostRootResult.isErr()) {
    return skipAllOutcome({ reason: hostRootResult.error.reason });
  }
  const hostRoot = hostRootResult.value;
  const packageJsonPath = join(hostRoot, "package.json");
  if (!isSafeAbsoluteHostPath(packageJsonPath)) {
    return skipAllOutcome({ reason: "host-root-unproven", hostRoot });
  }

  const packageJson = await callEnv(() => env.readJsonFile(packageJsonPath));
  if (packageJson.isErr()) {
    return skipAllOutcome({ reason: "host-package-mismatch", hostRoot });
  }
  const identity = parseHostPackageIdentity(packageJson.value);
  if (identity.isErr()) {
    return skipAllOutcome({ reason: identity.error.reason, hostRoot });
  }

  const { specifiers, localResolutions } = await gatherSpecifierFacts(
    env,
    hostRoot,
  );
  const planned = planHostModuleRedirect({
    hostPackageRoot: hostRoot,
    hostPackage: identity.value,
    specifiers,
  });
  if (planned.isErr()) {
    return skipAllOutcome({
      reason: planned.error.reason,
      hostRoot,
      hostVersion: identity.value.version,
      localResolutions,
    });
  }

  const applied = await registerPlannedRedirects(env, planned.value.redirects);
  const skipped = [...planned.value.skipped, ...applied.pluginSkips];
  return {
    redirected: applied.redirected,
    skipped,
    hostVersion: identity.value.version,
    hostRoot,
    localResolutions,
    proofRecord: proofFromAppliedPlan({
      hostRoot,
      hostVersion: identity.value.version,
      planned,
      redirected: applied.redirected,
      skipped,
      localResolutions,
    }),
  };
}

/**
 * Discover host facts, register overrides, and import host namespaces.
 * Always resolves `Ok`; a failed redirect becomes a skip so the extension
 * keeps today's nested-copy behavior.
 */
export function resolveHostModules(
  env: PiHostModuleEnvironmentPort,
  options?: ResolveHostModulesOptions,
): ResultAsync<PiHostModuleOutcome, never> {
  return ResultAsync.fromPromise(
    runResolveHostModules(env, options),
    (): PiHostModuleOutcome => skipAllOutcome({ reason: "plugin-unavailable" }),
  )
    .orElse((fallback) => okAsync(fallback))
    .map((outcome) => {
      maybeWriteHostModuleProofLine(outcome, options);
      return outcome;
    });
}

/**
 * Production environment: Bun host discovery, JSON reads, resolution,
 * exact-path `onLoad` overrides, and absolute import.
 */
export class BunPiHostModuleEnvironment implements PiHostModuleEnvironmentPort {
  private static readonly registeredExactPaths = new Set<string>();

  mainModulePath(): ResultAsync<string, PiHostModuleEnvironmentError> {
    return liftResult(
      Result.fromThrowable(
        (): string => {
          if (typeof Bun.main === "string" && Bun.main.length > 0) {
            return Bun.main;
          }
          const argvPath = process.argv[1];
          if (typeof argvPath === "string" && argvPath.length > 0) {
            return argvPath;
          }
          throw new Error("missing-main-module");
        },
        (): PiHostModuleEnvironmentError => ({ type: "MainModuleUnavailable" }),
      )(),
    );
  }

  readJsonFile(
    path: string,
  ): ResultAsync<unknown, PiHostModuleEnvironmentError> {
    return ResultAsync.fromThrowable(
      () => Bun.file(path).json(),
      (): PiHostModuleEnvironmentError => ({ type: "JsonReadFailed", path }),
    )();
  }

  resolveFrom(
    specifier: string,
    fromDir: string,
  ): ResultAsync<string, PiHostModuleEnvironmentError> {
    return liftResult(
      Result.fromThrowable(
        () => Bun.resolveSync(specifier, fromDir),
        (): PiHostModuleEnvironmentError => ({
          type: "ResolveFailed",
          specifier,
        }),
      )(),
    );
  }

  resolveLocal(
    specifier: string,
  ): ResultAsync<string, PiHostModuleEnvironmentError> {
    return liftResult(
      Result.fromThrowable(
        () => toFilesystemPath(import.meta.resolve(specifier)),
        (): PiHostModuleEnvironmentError => ({
          type: "ResolveFailed",
          specifier,
        }),
      )(),
    );
  }

  registerLoadOverride(
    exactPath: string,
    contents: string,
  ): ResultAsync<void, PiHostModuleEnvironmentError> {
    return liftResult(
      Result.fromThrowable(
        (): void => {
          if (BunPiHostModuleEnvironment.registeredExactPaths.has(exactPath)) {
            return;
          }
          const filter = exactPathLoadFilter(exactPath);
          Bun.plugin({
            name: "weave-pi-host-module-redirect",
            setup(build) {
              build.onLoad({ filter }, () => ({
                contents,
                loader: "js",
              }));
            },
          });
          BunPiHostModuleEnvironment.registeredExactPaths.add(exactPath);
        },
        (): PiHostModuleEnvironmentError => ({
          type: "RegisterOverrideFailed",
          path: exactPath,
        }),
      )(),
    );
  }

  importAbsolute(
    path: string,
  ): ResultAsync<unknown, PiHostModuleEnvironmentError> {
    return ResultAsync.fromThrowable(
      () => import(path),
      (): PiHostModuleEnvironmentError => ({ type: "ImportFailed", path }),
    )();
  }
}

let recordedHostModuleOutcome: PiHostModuleOutcome | undefined;

/**
 * Set-once process accessor for the loader outcome. The thin extension
 * entry records after resolve; the implementation reads without importing
 * the loader entry. A later record is ignored.
 */
export function recordHostModuleOutcome(outcome: PiHostModuleOutcome): void {
  if (recordedHostModuleOutcome !== undefined) return;
  recordedHostModuleOutcome = outcome;
}

/** The outcome recorded by the extension entry, if any. */
export function getHostModuleOutcome(): PiHostModuleOutcome | undefined {
  return recordedHostModuleOutcome;
}
