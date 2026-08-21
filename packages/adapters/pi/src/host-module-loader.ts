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
import { z } from "zod";
import {
  CODEX_PROVIDER_SUBPATH_SPECIFIER,
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

const HOST_BOUNDARY_INPUT_SCHEMA = z.unknown();
export type PiHostModuleObservedValue = z.input<
  typeof HOST_BOUNDARY_INPUT_SCHEMA
>;
const HOST_STRING_SCHEMA = z.string();

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
export interface PiHostModuleObjectValue {
  readonly hostModuleObjectMarker?: never;
  readonly default?: PiHostModuleObservedValue;
}

export interface PiHostModuleEnvironmentPort {
  mainModulePath(): ResultAsync<string, PiHostModuleEnvironmentError>;
  readJsonFile(
    path: string,
  ): ResultAsync<PiHostModuleObservedValue, PiHostModuleEnvironmentError>;
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
  ): ResultAsync<PiHostModuleObservedValue, PiHostModuleEnvironmentError>;
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
    [CODEX_PROVIDER_SUBPATH_SPECIFIER]: undefined,
  };
}

/**
 * Whether one closed specifier is proven to load the host's own copy, and
 * how that was established.
 *
 * `redirected` means this process installed an exact-path override that
 * re-exports the host file; `already-host` means the local resolution *is*
 * the host file, so there was never a second copy to redirect. Everything
 * else is `unproven` with one bounded reason, and a consumer that needs the
 * host copy must fail closed on it rather than import and hope.
 */
export type PiHostModuleProvenance =
  | {
      readonly kind: "host";
      readonly outcome: "redirected" | "already-host";
    }
  | {
      readonly kind: "unproven";
      readonly reason: PiHostModuleProvenanceReason;
    };

export type PiHostModuleProvenanceReason =
  | PiHostModuleSkipReason
  /** No loader outcome was recorded in this process at all. */
  | "outcome-missing"
  /** The outcome listed the specifier as neither redirected nor skipped. */
  | "specifier-unknown";

/**
 * Decide one specifier's provenance from an already-gathered outcome. Pure:
 * it reads the recorded facts and never resolves, imports, or guesses.
 */
export function resolveHostModuleProvenance(
  specifier: PiHostModuleSpecifier,
  outcome: PiHostModuleOutcome | undefined,
): PiHostModuleProvenance {
  if (outcome === undefined) {
    return { kind: "unproven", reason: "outcome-missing" };
  }
  if (outcome.redirected.includes(specifier)) {
    return { kind: "host", outcome: "redirected" };
  }
  const skipped = outcome.skipped.find(
    (entry) => entry.specifier === specifier,
  );
  if (skipped === undefined) {
    return { kind: "unproven", reason: "specifier-unknown" };
  }
  if (skipped.reason === "already-host") {
    return { kind: "host", outcome: "already-host" };
  }
  return { kind: "unproven", reason: skipped.reason };
}

function skipAllSpecifiers(
  reason: PiHostModuleSkipReason,
): readonly PiHostModuleSkippedSpecifier[] {
  return PI_HOST_MODULE_SPECIFIERS.map((specifier) => ({
    specifier,
    reason,
  }));
}

type MutableHostModuleProofSpecifier = {
  specifier: PiHostModuleSpecifier;
  hostSpecifier: string;
  localEntryPath?: string;
  hostEntryPath?: string;
  redirected: boolean;
  skipReason?: PiHostModuleSkipReason;
  bareResolution?: string;
  loadedFrom?: string;
};

type MutableHostModuleProofRecord = {
  hostRoot?: string;
  hostVersion?: string;
  specifiers: MutableHostModuleProofSpecifier[];
};

type MutableHostSpecifierFacts = {
  localEntryPath?: string;
  hostEntryPath?: string;
};

type MutableHostSpecifiers = {
  -readonly [K in PiHostModuleSpecifier]: MutableHostSpecifierFacts;
};

type MutableHostLocalResolutions = {
  -readonly [K in PiHostModuleSpecifier]: string | undefined;
};

function skipAllProof(
  reason: PiHostModuleSkipReason,
  hostRoot: string | undefined,
  hostVersion: string | undefined,
  localResolutions: PiHostLocalResolutions,
): PiHostModuleProofRecord {
  const record: MutableHostModuleProofRecord = { specifiers: [] };
  if (hostRoot !== undefined) record.hostRoot = hostRoot;
  if (hostVersion !== undefined) record.hostVersion = hostVersion;
  for (const specifier of PI_HOST_MODULE_SPECIFIERS) {
    const entry: MutableHostModuleProofSpecifier = {
      specifier,
      hostSpecifier: hostEntrySpecifierFor(specifier),
      redirected: false,
      skipReason: reason,
    };
    const local = localResolutions[specifier];
    if (local !== undefined) entry.bareResolution = local;
    record.specifiers.push(entry);
  }
  return record;
}

function skipAllOutcome(input: {
  readonly reason: PiHostModuleSkipReason;
  readonly hostRoot?: string;
  readonly hostVersion?: string;
  readonly localResolutions?: PiHostLocalResolutions;
}): PiHostModuleOutcome {
  const localResolutions = input.localResolutions ?? emptyLocalResolutions();
  const proofRecord = skipAllProof(
    input.reason,
    input.hostRoot,
    input.hostVersion,
    localResolutions,
  );
  const base = {
    redirected: [],
    skipped: skipAllSpecifiers(input.reason),
    localResolutions,
    proofRecord,
  };
  if (input.hostVersion !== undefined && input.hostRoot !== undefined) {
    return {
      ...base,
      hostVersion: input.hostVersion,
      hostRoot: input.hostRoot,
    };
  }
  if (input.hostVersion !== undefined) {
    return { ...base, hostVersion: input.hostVersion };
  }
  if (input.hostRoot !== undefined)
    return { ...base, hostRoot: input.hostRoot };
  return base;
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

type HostPackageIdentity = { readonly name: string; readonly version: string };
type HostPackageMismatch = { readonly reason: "host-package-mismatch" };
type HostModuleRecord = PiHostModuleObjectValue;

const HOST_MODULE_RECORD_SCHEMA = z.custom<HostModuleRecord>((value) => {
  const checked = Result.fromThrowable(
    (): boolean => {
      if (value === null || Object(value) !== value) return false;
      if (Array.isArray(value) || value instanceof Function) return false;
      const prototype = Object.getPrototypeOf(value);
      if (prototype === Object.prototype || prototype === null) return true;

      // Bun may expose imported namespaces through a module wrapper prototype.
      // Accept that exact shape without accepting arbitrary class instances.
      if (Object.getPrototypeOf(prototype) !== null) return false;
      const esModule = Object.getOwnPropertyDescriptor(prototype, "__esModule");
      if (esModule === undefined) return false;
      const tag = Object.getOwnPropertyDescriptor(value, Symbol.toStringTag);
      return "value" in (tag ?? {}) && tag?.value === "Module";
    },
    (): boolean => false,
  )();
  return checked.isOk() && checked.value;
});

function readHostModuleData(
  value: PiHostModuleObservedValue,
  key: string,
): PiHostModuleObservedValue | undefined {
  const record = HOST_MODULE_RECORD_SCHEMA.safeParse(value);
  if (!record.success) return undefined;
  const descriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(record.data, key),
    (): PropertyDescriptor | undefined => undefined,
  )();
  if (descriptor.isErr() || descriptor.value === undefined) return undefined;
  if (!("value" in descriptor.value) || descriptor.value.enumerable !== true) {
    return undefined;
  }
  return descriptor.value.value;
}

function parseHostPackageIdentity(
  value: PiHostModuleObservedValue,
): Result<HostPackageIdentity, HostPackageMismatch> {
  const nameValue = readHostModuleData(value, "name");
  const versionValue = readHostModuleData(value, "version");
  const name = HOST_STRING_SCHEMA.min(1).safeParse(nameValue);
  const version = HOST_STRING_SCHEMA.min(1).safeParse(versionValue);
  if (!name.success || !version.success) {
    return err({ reason: "host-package-mismatch" });
  }
  return ok({ name: name.data, version: version.data });
}

function namespaceHasDefaultExport(
  namespace: PiHostModuleObservedValue,
): boolean {
  const record = HOST_MODULE_RECORD_SCHEMA.safeParse(namespace);
  if (!record.success) return false;
  const descriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(record.data, "default"),
    (): PropertyDescriptor | undefined => undefined,
  )();
  if (descriptor.isErr() || descriptor.value === undefined) return false;
  return "value" in descriptor.value && descriptor.value.enumerable === true;
}

function environmentFlagRequested(
  options: ResolveHostModulesOptions | undefined,
  name: string,
): boolean {
  const source = options?.env ?? Bun.env;
  const value = readHostModuleData(source, name);
  const parsed = HOST_STRING_SCHEMA.safeParse(value);
  return parsed.success && parsed.data === "1";
}

function disableRedirectRequested(
  options: ResolveHostModulesOptions | undefined,
): boolean {
  return environmentFlagRequested(
    options,
    WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT_ENV,
  );
}

function hostModuleProofRequested(
  options: ResolveHostModulesOptions | undefined,
): boolean {
  return environmentFlagRequested(options, WEAVE_PI_HOST_MODULE_PROOF_ENV);
}

function boundProofPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isSafeAbsoluteHostPath(value)) return undefined;
  return value;
}

const PROOF_VERSION_SCHEMA = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\x20-\x7e]*$/);

function boundProofVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = PROOF_VERSION_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : void 0;
}

function writeProofLineToStderr(line: string): void {
  Result.fromThrowable(
    (): void => {
      const written = Bun.stderr.write(`${line}\n`);
      if (written instanceof Promise) {
        void written;
      }
    },
    () => void 0,
  )();
}

/**
 * Project the detailed proof record to the opt-in stderr JSON shape.
 * One line, valid JSON, bounded, with absolute paths only.
 */
type RenderedHostModuleProofSpecifier = {
  specifier: PiHostModuleSpecifier;
  bareResolution?: string;
  loadedFrom?: string;
  redirected: boolean;
};

type RenderedHostModuleProofBody = {
  hostRoot?: string;
  hostVersion?: string;
  specifiers: RenderedHostModuleProofSpecifier[];
};

export function renderHostModuleProofLine(
  outcome: PiHostModuleOutcome,
): string {
  const body: RenderedHostModuleProofBody = { specifiers: [] };
  const hostRoot = boundProofPath(outcome.proofRecord.hostRoot);
  const hostVersion = boundProofVersion(outcome.proofRecord.hostVersion);
  if (hostRoot !== undefined) body.hostRoot = hostRoot;
  if (hostVersion !== undefined) body.hostVersion = hostVersion;
  for (const entry of outcome.proofRecord.specifiers) {
    const projected: RenderedHostModuleProofSpecifier = {
      specifier: entry.specifier,
      redirected: entry.redirected,
    };
    const bareResolution = boundProofPath(entry.bareResolution);
    const loadedFrom = boundProofPath(entry.loadedFrom);
    if (bareResolution !== undefined) projected.bareResolution = bareResolution;
    if (loadedFrom !== undefined) projected.loadedFrom = loadedFrom;
    body.specifiers.push(projected);
  }
  const proof: PiHostModuleProofLine = { weaveHostModuleProof: body };
  const json = JSON.stringify(proof);
  if (
    json.length <= MAX_HOST_MODULE_PROOF_LINE_LENGTH &&
    !json.includes("\n")
  ) {
    return json;
  }
  const fallbackBody: RenderedHostModuleProofBody = { specifiers: [] };
  if (hostVersion !== undefined) fallbackBody.hostVersion = hostVersion;
  return JSON.stringify({ weaveHostModuleProof: fallbackBody });
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
    .map((value): string | undefined => {
      const parsed = HOST_STRING_SCHEMA.safeParse(value);
      return parsed.success ? parsed.data : void 0;
    })
    .orElse(() => okAsync(void 0));
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
  const localResolutions: MutableHostLocalResolutions = {
    ...emptyLocalResolutions(),
  };
  const specifiers: MutableHostSpecifiers = {
    "@earendil-works/pi-coding-agent": {},
    "@earendil-works/pi-ai": {},
    "@earendil-works/pi-tui": {},
    [CODEX_PROVIDER_SUBPATH_SPECIFIER]: {},
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
    const facts: MutableHostSpecifierFacts = {};
    if (localEntryPath !== undefined) facts.localEntryPath = localEntryPath;
    if (hostEntryPath !== undefined) facts.hostEntryPath = hostEntryPath;
    specifiers[specifier] = facts;
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

  const specifiers: PiHostModuleProofSpecifier[] = [];
  for (const specifier of PI_HOST_MODULE_SPECIFIERS) {
    const plannedEntry = plannedProof?.specifiers.find(
      (entry) => entry.specifier === specifier,
    );
    const skipped = skipBySpecifier.get(specifier);
    const local = input.localResolutions[specifier];
    const hostEntryPath = plannedEntry?.hostEntryPath;
    const redirected = redirectedSet.has(specifier);
    const entry: MutableHostModuleProofSpecifier = {
      specifier,
      hostSpecifier: hostEntrySpecifierFor(specifier),
      redirected,
    };
    if (plannedEntry?.localEntryPath !== undefined) {
      entry.localEntryPath = plannedEntry.localEntryPath;
    }
    if (hostEntryPath !== undefined) entry.hostEntryPath = hostEntryPath;
    if (skipped !== undefined) entry.skipReason = skipped.reason;
    if (local !== undefined) entry.bareResolution = local;
    if (redirected && hostEntryPath !== undefined) {
      entry.loadedFrom = hostEntryPath;
    }
    specifiers.push(entry);
  }
  return {
    hostRoot: input.hostRoot,
    hostVersion: input.hostVersion,
    specifiers,
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
          const mainPath = z.string().min(1).safeParse(Bun.main);
          if (mainPath.success) return mainPath.data;
          const argvPath = z.string().min(1).safeParse(process.argv[1]);
          if (argvPath.success) return argvPath.data;
          throw new Error("missing-main-module");
        },
        (): PiHostModuleEnvironmentError => ({ type: "MainModuleUnavailable" }),
      )(),
    );
  }

  readJsonFile(
    path: string,
  ): ResultAsync<PiHostModuleObservedValue, PiHostModuleEnvironmentError> {
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
  ): ResultAsync<PiHostModuleObservedValue, PiHostModuleEnvironmentError> {
    return ResultAsync.fromThrowable(
      () => import(path),
      (): PiHostModuleEnvironmentError => ({ type: "ImportFailed", path }),
    )();
  }
}

let recordedExtensionEntryPath: string | undefined;

/**
 * Set-once record of the loader entry's own absolute path.
 *
 * The thin entry is the only module that knows where Pi actually loaded this
 * adapter from, and it is the only caller. The fact is stored, never derived:
 * a caller that passes a non-string (a host whose module loader does not
 * expose one) or an unsafe path records nothing, and a later call can never
 * replace a fact already latched. Consumers treat an absent value as "no
 * loader fact", which is exactly how the inventory refuses to guess.
 *
 * The value is a filesystem path, so it must never reach health output or a
 * log line.
 */
export function recordPiExtensionEntryPath(
  path: z.input<typeof HOST_BOUNDARY_INPUT_SCHEMA>,
): void {
  if (recordedExtensionEntryPath !== undefined) return;
  const parsed = z.string().safeParse(path);
  if (!parsed.success) return;
  if (!isSafeAbsoluteHostPath(parsed.data)) return;
  recordedExtensionEntryPath = parsed.data;
}

/** The loader entry path recorded by the extension entry, if any. */
export function getPiExtensionEntryPath(): string | undefined {
  return recordedExtensionEntryPath;
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

/**
 * Provenance of one closed specifier in this process, from the recorded
 * outcome. Absent evidence is `unproven`, never an optimistic default.
 */
export function getHostModuleProvenance(
  specifier: PiHostModuleSpecifier,
): PiHostModuleProvenance {
  return resolveHostModuleProvenance(specifier, getHostModuleOutcome());
}
