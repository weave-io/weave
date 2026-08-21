/**
 * Trusted Pi extension preloader.
 *
 * Keep this entry self-contained. Pi evaluates the entry module before it
 * invokes the extension callback, so a static import here would evaluate an
 * attested runtime module before the loader can pin its bytes. The preloader
 * reads and hashes the complete local runtime graph first, verifies the
 * build's embedded binding, and installs a Bun loader that serves those exact
 * bytes for the subsequent imports.
 *
 * The build replaces this fixed-width value after it has emitted the other
 * runtime outputs. Keeping the value in the entry binds an already-running
 * entry module to the build that produced its sibling files: an old entry
 * cannot accept a newer sidecar.
 */
const WEAVE_PI_EMBEDDED_BUILD_BINDING =
  "0000000000000000000000000000000000000000000000000000000000000000";
const WEAVE_PI_BUILD_BINDING_PLACEHOLDER =
  "0000000000000000000000000000000000000000000000000000000000000000";
const EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION = 1;
const EXTENSION_BUILD_MANIFEST_FILENAME = "extension-build-identity.json";
const MAX_EXTENSION_BUILD_MANIFEST_BYTES = 32 * 1024;
const MAX_EXTENSION_BUILD_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_EXTENSION_BUILD_OUTPUTS = 64;
const MAX_EXTENSION_BUILD_INPUTS = 4_096;
const MAX_EXTENSION_BUILD_SUBJECT_LENGTH = 128;
const MAX_EXTENSION_ENTRY_PATH_LENGTH = 4_096;
/** Keep one complete graph in memory, and reject the next attempt closed. */
const MAX_IN_FLIGHT_PRELOADS = 1;
const MAX_IN_FLIGHT_PINNED_BYTES = 16 * 1024 * 1024;
const PINNED_PRELOADER_PLUGIN_NAME = "weave-pi-trusted-runtime-preloader-v2";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SUBJECT_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_OUTPUT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PIN_QUERY_PREFIX = "?weave=";
const RUNTIME_OUTPUTS = [
  { name: "extension", fileName: "extension.js" },
  {
    name: "extension-build-identity",
    fileName: "extension-build-identity.js",
  },
  { name: "extension-impl", fileName: "extension-impl.js" },
  { name: "host-module-loader", fileName: "host-module-loader.js" },
] as const;

type RuntimeOutputName = (typeof RUNTIME_OUTPUTS)[number]["name"];
export interface ExtensionPreloaderDigest {
  readonly name: RuntimeOutputName;
  readonly sha256: string;
}

type RuntimeDigest = ExtensionPreloaderDigest;

type PreloadManifest = {
  readonly buildBinding: string;
  readonly buildCompletedAt: string;
  readonly buildInputs: readonly string[];
  readonly dirty: boolean;
  readonly outputs: ReadonlyMap<string, string>;
  readonly subject: string;
};

type PinnedRuntime = {
  readonly ok: true;
  readonly artifactPath: string;
  readonly buildBinding: string;
  readonly loadedOutputs: readonly RuntimeDigest[];
  readonly modulePaths: ReadonlyMap<RuntimeOutputName, string>;
  readonly token: string;
};

type PreloaderFailureReason =
  | PreloadFailure["reason"]
  | "load-cap-exceeded"
  | "module-path-missing"
  | "module-evaluation-failed"
  | "extension-start-failed";
type PreloaderHealthStatus =
  | "idle"
  | "loading"
  | "loaded"
  | "failed"
  | "rejected";
type PreloaderHealth = {
  readonly status: PreloaderHealthStatus;
  readonly lastAttemptAtMs?: number;
  readonly lastSettledAtMs?: number;
  readonly buildBinding?: string;
  readonly loadedOutputs?: readonly RuntimeDigest[];
  readonly reason?: PreloaderFailureReason;
};
type LoadSlot = {
  bytes: number;
};
type LoaderRegistration = {
  readonly pinnedPaths: Set<string>;
};

export interface ExtensionPreloaderRetentionSnapshot {
  readonly retainedPinnedBytes: number;
  readonly retainedPinnedEntries: number;
  readonly inFlightLoadCount: number;
  readonly inFlightPinnedBytes: number;
  readonly activeLoaderRegistrations: number;
  readonly pluginInstalled: boolean;
  readonly status: PreloaderHealthStatus;
  readonly lastAttemptAtMs?: number;
  readonly lastSettledAtMs?: number;
  readonly buildBinding?: string;
  readonly loadedOutputs?: readonly ExtensionPreloaderDigest[];
  readonly reason?: PreloaderFailureReason;
}

interface GlobalLoaderState {
  readonly pins: Map<string, Uint8Array>;
  readonly registrations: Map<string, LoaderRegistration>;
  readonly inFlightLoads: Set<LoadSlot>;
  pluginInstalled: boolean;
  inFlightPinnedBytes: number;
  sequence: number;
  health: PreloaderHealth;
}

type LoaderState = GlobalLoaderState;

type TrustedModuleLoader = {
  readonly extensionProcessStartMs: () => number;
  readonly maybeWriteExtensionBuildIdentityProofLine: (
    identity: unknown,
  ) => boolean;
  readonly recordHostModuleOutcome: (outcome: unknown) => void;
  readonly recordPiExtensionEntryPath: (path: unknown) => void;
  readonly resolveHostModules: (environment: unknown) => Promise<unknown>;
  readonly BunPiHostModuleEnvironment: new () => unknown;
};

type TrustedIdentityModule = {
  readonly maybeWriteExtensionBuildIdentityProofLine: (
    identity: unknown,
  ) => boolean;
  readonly extensionProcessStartMs: () => number;
};

type TrustedImplementationModule = {
  readonly default: (pi: unknown) => void;
  readonly setLoadedPiExtensionIdentity?: (identity: unknown) => void;
};

type PreloadFailure = {
  readonly ok: false;
  readonly reason:
    | "entry-path-missing"
    | "manifest-invalid"
    | "runtime-read-failed"
    | "runtime-digest-mismatch"
    | "binding-mismatch"
    | "pinned-loader-unavailable";
};

type PreloadResult = PinnedRuntime | PreloadFailure;

const GLOBAL_LOADER_STATE_KEY = Symbol.for(
  "weave.pi.trusted-extension-preloader.v2",
);

function loaderState(): GlobalLoaderState {
  const global = globalThis as typeof globalThis & {
    [GLOBAL_LOADER_STATE_KEY]?: GlobalLoaderState;
  };
  const existing = global[GLOBAL_LOADER_STATE_KEY];
  if (existing !== undefined) return existing;
  const created: GlobalLoaderState = {
    pins: new Map(),
    registrations: new Map(),
    inFlightLoads: new Set(),
    pluginInstalled: false,
    inFlightPinnedBytes: 0,
    sequence: 0,
    health: { status: "idle" },
  };
  global[GLOBAL_LOADER_STATE_KEY] = created;
  return created;
}

function retainedPinnedBytes(state: GlobalLoaderState): number {
  let bytes = 0;
  for (const value of state.pins.values()) bytes += value.byteLength;
  return bytes;
}

/**
 * Test-only, content-free retention seam. It reports bounded facts only; it
 * never exposes a pinned path, source string, or byte array.
 */
export function readExtensionPreloaderRetentionForTesting(): ExtensionPreloaderRetentionSnapshot {
  const state = loaderState();
  return {
    retainedPinnedBytes: retainedPinnedBytes(state),
    retainedPinnedEntries: state.pins.size,
    inFlightLoadCount: state.inFlightLoads.size,
    inFlightPinnedBytes: state.inFlightPinnedBytes,
    activeLoaderRegistrations: state.registrations.size,
    pluginInstalled: state.pluginInstalled,
    ...state.health,
  };
}

function recordPreloaderHealth(
  state: GlobalLoaderState,
  health: PreloaderHealth,
): void {
  state.health = health;
}

function beginLoad(state: GlobalLoaderState): LoadSlot | undefined {
  if (state.inFlightLoads.size >= MAX_IN_FLIGHT_PRELOADS) {
    const now = Date.now();
    recordPreloaderHealth(state, {
      status: "rejected",
      lastAttemptAtMs: now,
      lastSettledAtMs: now,
      reason: "load-cap-exceeded",
    });
    return undefined;
  }
  const slot: LoadSlot = { bytes: 0 };
  state.inFlightLoads.add(slot);
  recordPreloaderHealth(state, {
    status: "loading",
    lastAttemptAtMs: Date.now(),
  });
  return slot;
}

function reservePinnedBytes(
  state: GlobalLoaderState,
  slot: LoadSlot,
  bytes: number,
): boolean {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    state.inFlightPinnedBytes > MAX_IN_FLIGHT_PINNED_BYTES - bytes
  ) {
    return false;
  }
  slot.bytes += bytes;
  state.inFlightPinnedBytes += bytes;
  return true;
}

function releaseSlotBytes(state: GlobalLoaderState, slot: LoadSlot): void {
  state.inFlightPinnedBytes = Math.max(
    0,
    state.inFlightPinnedBytes - slot.bytes,
  );
  slot.bytes = 0;
}

function finishLoad(state: GlobalLoaderState, slot: LoadSlot): void {
  releaseSlotBytes(state, slot);
  state.inFlightLoads.delete(slot);
}

function recordPreloaderFailure(
  state: GlobalLoaderState,
  reason: PreloaderFailureReason,
): void {
  const now = Date.now();
  recordPreloaderHealth(state, {
    status: "failed",
    lastAttemptAtMs: state.health.lastAttemptAtMs ?? now,
    lastSettledAtMs: now,
    reason,
  });
}

function recordPreloaderLoaded(
  state: GlobalLoaderState,
  pinned: PinnedRuntime,
): void {
  const now = Date.now();
  recordPreloaderHealth(state, {
    status: "loaded",
    lastAttemptAtMs: state.health.lastAttemptAtMs ?? now,
    lastSettledAtMs: now,
    buildBinding: pinned.buildBinding,
    loadedOutputs: Object.freeze(
      pinned.loadedOutputs.map((output) => ({ ...output })),
    ),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    return false;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return false;
    }
  }
  return true;
}

function isSafeTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isSafeAbsolutePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EXTENSION_ENTRY_PATH_LENGTH ||
    !value.startsWith("/") ||
    value.includes("\u0000") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return false;
  }
  const components = value.split("/");
  return !components.some(
    (component, index) =>
      index > 0 && (component === "." || component === ".."),
  );
}

function isSortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous >= current
    ) {
      return false;
    }
  }
  return true;
}

function stripQuery(value: string): string {
  const queryIndex = value.indexOf("?");
  return queryIndex < 0 ? value : value.slice(0, queryIndex);
}

function queryToken(value: string): string | undefined {
  const queryIndex = value.indexOf(PIN_QUERY_PREFIX);
  if (queryIndex < 0) return undefined;
  const token = value.slice(queryIndex + PIN_QUERY_PREFIX.length);
  return token.length > 0 && !token.includes("&") ? token : undefined;
}

function modulePathFor(artifactPath: string, fileName: string): string {
  const slash = artifactPath.lastIndexOf("/");
  return `${artifactPath.slice(0, slash + 1)}${fileName}`;
}

function digestBytes(bytes: Uint8Array): string | undefined {
  try {
    const digest = new Bun.CryptoHasher("sha256");
    digest.update(bytes);
    const value = digest.digest("hex");
    return isSha256(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function encodeUtf8(value: string): Uint8Array | undefined {
  try {
    return new TextEncoder().encode(value);
  } catch {
    return undefined;
  }
}

function parseManifest(bytes: Uint8Array): PreloadManifest | undefined {
  if (bytes.byteLength > MAX_EXTENSION_BUILD_MANIFEST_BYTES) return undefined;
  const text = decodeUtf8(bytes);
  if (text === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.schemaVersion !== EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION) {
    return undefined;
  }
  const git = parsed.git;
  if (!isRecord(git)) return undefined;
  if (
    !isBoundedString(git.subject, MAX_EXTENSION_BUILD_SUBJECT_LENGTH) ||
    !GIT_SUBJECT_PATTERN.test(git.subject) ||
    typeof git.dirty !== "boolean"
  ) {
    return undefined;
  }
  const buildInputs = parsed.buildInputs;
  if (
    !Array.isArray(buildInputs) ||
    buildInputs.length === 0 ||
    buildInputs.length > MAX_EXTENSION_BUILD_INPUTS ||
    buildInputs.some((value) => !isSha256(value)) ||
    !isSortedUnique(buildInputs)
  ) {
    return undefined;
  }
  if (!isSafeTimestamp(parsed.buildCompletedAt)) return undefined;
  if (!isSha256(parsed.buildBinding)) return undefined;

  const rawOutputs = parsed.outputs;
  if (
    !Array.isArray(rawOutputs) ||
    rawOutputs.length === 0 ||
    rawOutputs.length > MAX_EXTENSION_BUILD_OUTPUTS
  ) {
    return undefined;
  }
  const outputs = new Map<string, string>();
  let previousName = "";
  for (const rawOutput of rawOutputs) {
    if (!isRecord(rawOutput)) return undefined;
    const name = rawOutput.name;
    if (
      typeof name !== "string" ||
      !SAFE_OUTPUT_NAME_PATTERN.test(name) ||
      outputs.has(name) ||
      name <= previousName ||
      !isSha256(rawOutput.sha256)
    ) {
      return undefined;
    }
    previousName = name;
    outputs.set(name, rawOutput.sha256);
  }
  for (const output of RUNTIME_OUTPUTS) {
    if (!outputs.has(output.name)) return undefined;
  }
  return {
    buildBinding: parsed.buildBinding,
    buildCompletedAt: parsed.buildCompletedAt,
    buildInputs: [...buildInputs],
    dirty: git.dirty,
    outputs,
    subject: git.subject,
  };
}

function embeddedBindingFromSource(
  source: string,
): { readonly binding: string; readonly normalized: string } | undefined {
  const pattern =
    /const\s+WEAVE_PI_EMBEDDED_BUILD_BINDING\s*=\s*"([0-9a-f]{64})"\s*;/gu;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const binding = match?.[1];
  if (
    binding === undefined ||
    binding === WEAVE_PI_BUILD_BINDING_PLACEHOLDER ||
    match.index === undefined
  ) {
    return undefined;
  }
  const whole = match[0];
  const bindingOffset = whole.indexOf(binding);
  if (bindingOffset < 0) return undefined;
  const normalizedMatch = `${whole.slice(0, bindingOffset)}${WEAVE_PI_BUILD_BINDING_PLACEHOLDER}${whole.slice(bindingOffset + binding.length)}`;
  const normalized =
    source.slice(0, match.index) +
    normalizedMatch +
    source.slice(match.index + whole.length);
  return { binding, normalized };
}

function runtimeOutputDigest(
  outputs: readonly RuntimeDigest[],
  name: RuntimeOutputName,
): string | undefined {
  return outputs.find((output) => output.name === name)?.sha256;
}

function canonicalBuildBindingInput(input: {
  readonly buildCompletedAt: string;
  readonly buildInputs: readonly string[];
  readonly dirty: boolean;
  readonly runtimeOutputs: readonly RuntimeDigest[];
  readonly subject: string;
}): string {
  return JSON.stringify({
    schemaVersion: EXTENSION_BUILD_IDENTITY_SCHEMA_VERSION,
    git: { subject: input.subject, dirty: input.dirty },
    buildInputs: [...input.buildInputs],
    buildCompletedAt: input.buildCompletedAt,
    runtimeOutputs: RUNTIME_OUTPUTS.map((output) => ({
      name: output.name,
      sha256: runtimeOutputDigest(input.runtimeOutputs, output.name),
    })),
  });
}

function computeBuildBinding(input: {
  readonly buildCompletedAt: string;
  readonly buildInputs: readonly string[];
  readonly dirty: boolean;
  readonly runtimeOutputs: readonly RuntimeDigest[];
  readonly subject: string;
}): string | undefined {
  if (
    input.runtimeOutputs.length !== RUNTIME_OUTPUTS.length ||
    input.runtimeOutputs.some(
      (output, index) =>
        output.name !== RUNTIME_OUTPUTS[index]?.name ||
        !isSha256(output.sha256),
    )
  ) {
    return undefined;
  }
  const canonical = canonicalBuildBindingInput(input);
  const encoded = encodeUtf8(canonical);
  return encoded === undefined ? undefined : digestBytes(encoded);
}

async function readBytes(
  path: string,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  try {
    const file = Bun.file(path);
    const expectedBytes = file.size;
    if (
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 0 ||
      expectedBytes > maxBytes
    ) {
      return undefined;
    }
    // Limit the Blob read as well as the preflight size check. A file can be
    // replaced between those operations; never allocate an unbounded result.
    const contents = await file.slice(0, maxBytes).arrayBuffer();
    if (contents.byteLength !== expectedBytes || file.size !== expectedBytes) {
      return undefined;
    }
    return new Uint8Array(contents);
  } catch {
    return undefined;
  }
}

function isLocalModuleSpecifier(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.startsWith("file:") ||
    value.includes("\\") ||
    value.includes("\u0000")
  );
}

function pinnedPathForLocalImport(
  importer: string,
  specifier: string,
  token: string,
  registration: LoaderRegistration,
): string | undefined {
  let target: string | undefined;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const importerPath = stripQuery(importer);
    const slash = importerPath.lastIndexOf("/");
    if (slash < 0 || specifier.includes("?") || specifier.includes("#")) {
      return undefined;
    }
    // Keep the path exact. A traversal component cannot accidentally resolve
    // to a mutable file because only the canonical pinned key is accepted.
    target = `${importerPath.slice(0, slash + 1)}${specifier}`;
    if (specifier.startsWith("./")) {
      target = `${importerPath.slice(0, slash + 1)}${specifier.slice(2)}`;
    }
  } else if (specifier.startsWith("/")) {
    target = specifier;
  }
  if (target === undefined) return undefined;
  const pinnedPath = `${target}${PIN_QUERY_PREFIX}${token}`;
  return registration.pinnedPaths.has(pinnedPath) ? pinnedPath : undefined;
}

/**
 * Install one process-wide, content-free plugin. Bun has no unregister API;
 * the plugin therefore owns only the global registry and looks up a live
 * registration for each callback. Per-load registrations and byte maps are
 * removed by disposePinnedRuntime.
 */
function installPinnedModulePlugin(state: LoaderState): boolean {
  if (state.pluginInstalled) return true;
  try {
    Bun.plugin({
      name: PINNED_PRELOADER_PLUGIN_NAME,
      setup(build) {
        build.onResolve({ filter: /.*/u }, (args) => {
          const token = queryToken(args.importer);
          if (token === undefined || !isLocalModuleSpecifier(args.path)) {
            return undefined;
          }
          const registration = state.registrations.get(token);
          if (registration === undefined) {
            return {
              path: args.path,
              errors: [{ message: "disposed pinned module graph" }],
            };
          }
          const pinnedPath = pinnedPathForLocalImport(
            args.importer,
            args.path,
            token,
            registration,
          );
          return pinnedPath === undefined
            ? {
                path: args.path,
                errors: [{ message: "unverified pinned module graph" }],
              }
            : { path: pinnedPath };
        });
        build.onLoad({ filter: /\\?weave=/u }, (args) => {
          const token = queryToken(args.path);
          if (token === undefined) return undefined;
          const registration = state.registrations.get(token);
          if (
            registration === undefined ||
            !registration.pinnedPaths.has(args.path)
          ) {
            return {
              contents: "",
              loader: "js",
              errors: [{ message: "disposed pinned module bytes" }],
            };
          }
          const contents = state.pins.get(args.path);
          return contents === undefined
            ? {
                contents: "",
                loader: "js",
                errors: [{ message: "missing pinned module bytes" }],
              }
            : { contents, loader: "js" };
        });
      },
    });
    state.pluginInstalled = true;
    return true;
  } catch {
    return false;
  }
}

async function readPinnedRuntimeBytes(
  path: string,
  state: LoaderState,
  slot: LoadSlot,
): Promise<Uint8Array | undefined> {
  try {
    const expectedBytes = Bun.file(path).size;
    if (
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 0 ||
      expectedBytes > MAX_EXTENSION_BUILD_OUTPUT_BYTES ||
      !reservePinnedBytes(state, slot, expectedBytes)
    ) {
      return undefined;
    }
    const value = await readBytes(path, expectedBytes);
    if (value === undefined || value.byteLength !== expectedBytes) {
      state.inFlightPinnedBytes = Math.max(
        0,
        state.inFlightPinnedBytes - expectedBytes,
      );
      slot.bytes = Math.max(0, slot.bytes - expectedBytes);
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

async function readPreloadManifest(
  path: string,
): Promise<PreloadManifest | undefined> {
  const bytes = await readBytes(path, MAX_EXTENSION_BUILD_MANIFEST_BYTES);
  return bytes === undefined ? undefined : parseManifest(bytes);
}

function normalizedEntryDigest(
  entryBytes: Uint8Array | undefined,
  manifest: PreloadManifest,
): string | undefined {
  if (entryBytes === undefined) return undefined;
  const entrySource = decodeUtf8(entryBytes);
  if (entrySource === undefined) return undefined;
  if (
    !isSha256(WEAVE_PI_EMBEDDED_BUILD_BINDING) ||
    WEAVE_PI_EMBEDDED_BUILD_BINDING === WEAVE_PI_BUILD_BINDING_PLACEHOLDER ||
    WEAVE_PI_EMBEDDED_BUILD_BINDING !== manifest.buildBinding
  ) {
    return undefined;
  }
  const embedded = embeddedBindingFromSource(entrySource);
  if (
    embedded === undefined ||
    embedded.binding !== manifest.buildBinding ||
    embedded.binding !== WEAVE_PI_EMBEDDED_BUILD_BINDING
  ) {
    return undefined;
  }
  const normalizedEntryBytes = encodeUtf8(embedded.normalized);
  return normalizedEntryBytes === undefined
    ? undefined
    : digestBytes(normalizedEntryBytes);
}

function registerPinnedRuntime(
  state: LoaderState,
  token: string,
  pinnedKeys: readonly string[],
): boolean {
  try {
    if (state.registrations.has(token)) return false;
    state.registrations.set(token, {
      pinnedPaths: new Set(pinnedKeys),
    });
    return true;
  } catch {
    return false;
  }
}

function disposePinnedRuntime(
  state: LoaderState,
  token: string,
  slot: LoadSlot,
  extraPinnedKeys: readonly string[] = [],
): void {
  const registration = state.registrations.get(token);
  state.registrations.delete(token);
  const paths = new Set([
    ...extraPinnedKeys,
    ...(registration?.pinnedPaths ?? []),
  ]);
  for (const path of paths) {
    const bytes = state.pins.get(path);
    // Clear the content before dropping the map entry. This also protects
    // against a late host/plugin reference that outlives our registry entry.
    bytes?.fill(0);
    state.pins.delete(path);
  }
  registration?.pinnedPaths.clear();
  releaseSlotBytes(state, slot);
}

async function pinRuntime(
  artifactPath: unknown,
  state: LoaderState,
  slot: LoadSlot,
): Promise<PreloadResult> {
  const bytesByPath = new Map<string, Uint8Array>();
  let committed = false;
  let token: string | undefined;
  const pinnedKeys: string[] = [];
  try {
    if (!isSafeAbsolutePath(artifactPath)) {
      return { ok: false, reason: "entry-path-missing" };
    }
    const entryPath = artifactPath;
    const modulePaths = new Map<RuntimeOutputName, string>();
    const paths = RUNTIME_OUTPUTS.map((output) => {
      const path =
        output.name === "extension"
          ? entryPath
          : modulePathFor(entryPath, output.fileName);
      modulePaths.set(output.name, path);
      return { ...output, path };
    });

    const loadedOutputs: RuntimeDigest[] = [];
    for (const output of paths) {
      const value = await readPinnedRuntimeBytes(output.path, state, slot);
      if (value === undefined) {
        return { ok: false, reason: "runtime-read-failed" };
      }
      const sha256 = digestBytes(value);
      if (sha256 === undefined) {
        return { ok: false, reason: "runtime-read-failed" };
      }
      loadedOutputs.push({ name: output.name, sha256 });
      bytesByPath.set(output.path, value);
    }

    const manifest = await readPreloadManifest(
      modulePathFor(entryPath, EXTENSION_BUILD_MANIFEST_FILENAME),
    );
    if (manifest === undefined) {
      return { ok: false, reason: "manifest-invalid" };
    }

    const normalizedDigest = normalizedEntryDigest(
      bytesByPath.get(entryPath),
      manifest,
    );
    if (normalizedDigest === undefined) {
      return { ok: false, reason: "binding-mismatch" };
    }
    const bindingOutputs = loadedOutputs.map((output) =>
      output.name === "extension"
        ? { ...output, sha256: normalizedDigest }
        : output,
    );
    const recomputedBinding = computeBuildBinding({
      buildCompletedAt: manifest.buildCompletedAt,
      buildInputs: manifest.buildInputs,
      dirty: manifest.dirty,
      runtimeOutputs: bindingOutputs,
      subject: manifest.subject,
    });
    if (
      recomputedBinding === undefined ||
      recomputedBinding !== manifest.buildBinding
    ) {
      return { ok: false, reason: "binding-mismatch" };
    }
    for (const output of loadedOutputs) {
      if (manifest.outputs.get(output.name) !== output.sha256) {
        return { ok: false, reason: "runtime-digest-mismatch" };
      }
    }
    if (!installPinnedModulePlugin(state)) {
      return { ok: false, reason: "pinned-loader-unavailable" };
    }

    state.sequence += 1;
    token = `${state.sequence.toString(36)}-${manifest.buildBinding}`;
    for (const [path, value] of bytesByPath) {
      const pinnedPath = `${path}${PIN_QUERY_PREFIX}${token}`;
      state.pins.set(pinnedPath, value);
      pinnedKeys.push(pinnedPath);
    }
    if (!registerPinnedRuntime(state, token, pinnedKeys)) {
      return { ok: false, reason: "pinned-loader-unavailable" };
    }
    committed = true;
    return {
      ok: true,
      artifactPath: entryPath,
      buildBinding: manifest.buildBinding,
      loadedOutputs,
      modulePaths,
      token,
    };
  } finally {
    // The map is only the hand-off between verification and the loader. Once
    // the registry owns the values, no local container may keep another strong
    // reference. On every failed path release the in-flight byte reservation.
    bytesByPath.clear();
    if (!committed) {
      if (token === undefined) {
        releaseSlotBytes(state, slot);
      } else {
        disposePinnedRuntime(state, token, slot, pinnedKeys);
      }
    }
  }
}

async function runExtensionLoad(
  pi: unknown,
  state: LoaderState,
  slot: LoadSlot,
): Promise<void> {
  let pinned: PinnedRuntime | undefined;
  try {
    const preload = await pinRuntime(import.meta.path as unknown, state, slot);
    if (!preload.ok) {
      recordPreloaderFailure(state, preload.reason);
      return;
    }
    pinned = preload;

    const identityPath = pinned.modulePaths.get("extension-build-identity");
    const hostLoaderPath = pinned.modulePaths.get("host-module-loader");
    const implementationPath = pinned.modulePaths.get("extension-impl");
    if (
      identityPath === undefined ||
      hostLoaderPath === undefined ||
      implementationPath === undefined
    ) {
      disposePinnedRuntime(state, pinned.token, slot);
      pinned = undefined;
      recordPreloaderFailure(state, "module-path-missing");
      return;
    }

    const identityModule = (await import(
      `${identityPath}${PIN_QUERY_PREFIX}${pinned.token}`
    )) as unknown as TrustedIdentityModule;
    const hostModule = (await import(
      `${hostLoaderPath}${PIN_QUERY_PREFIX}${pinned.token}`
    )) as unknown as TrustedModuleLoader;

    const processStartMs = identityModule.extensionProcessStartMs();
    if (!Number.isSafeInteger(processStartMs) || processStartMs < 0) {
      disposePinnedRuntime(state, pinned.token, slot);
      pinned = undefined;
      recordPreloaderFailure(state, "extension-start-failed");
      return;
    }
    const loadedIdentity = {
      artifactPath: preload.artifactPath,
      artifactSha256: runtimeOutputDigest(preload.loadedOutputs, "extension"),
      loadedOutputs: preload.loadedOutputs,
      buildBinding: preload.buildBinding,
      loadTimeMs: Date.now(),
      processStartMs,
    };
    identityModule.maybeWriteExtensionBuildIdentityProofLine(loadedIdentity);
    hostModule.recordPiExtensionEntryPath(import.meta.path as unknown);

    // Host resolution imports the host's own absolute modules. Keep the
    // verified registry live until that host graph and the attested graph have
    // both settled; disposal still happens before extension activation.
    const hostOutcome = await hostModule.resolveHostModules(
      new hostModule.BunPiHostModuleEnvironment(),
    );
    const outcome = isRecord(hostOutcome)
      ? (hostOutcome as {
          readonly isOk?: () => boolean;
          readonly value?: unknown;
        })
      : undefined;
    if (outcome?.isOk?.() === true) {
      hostModule.recordHostModuleOutcome(outcome.value);
    }

    let implementation: TrustedImplementationModule;
    try {
      implementation = (await import(
        `${implementationPath}${PIN_QUERY_PREFIX}${pinned.token}`
      )) as unknown as TrustedImplementationModule;
    } catch {
      disposePinnedRuntime(state, pinned.token, slot);
      pinned = undefined;
      recordPreloaderFailure(state, "module-evaluation-failed");
      return;
    }

    // All static module evaluation has settled. The module objects are now
    // sufficient for activation; release every pinned byte and registry entry
    // before calling any exported function.
    disposePinnedRuntime(state, pinned.token, slot);
    recordPreloaderLoaded(state, pinned);
    pinned = undefined;

    if (typeof implementation.default !== "function") {
      recordPreloaderFailure(state, "module-evaluation-failed");
      return;
    }
    implementation.setLoadedPiExtensionIdentity?.(loadedIdentity);
    await implementation.default(pi);
  } catch {
    if (pinned !== undefined) {
      disposePinnedRuntime(state, pinned.token, slot);
      pinned = undefined;
    }
    recordPreloaderFailure(state, "module-evaluation-failed");
    return;
  }
}

export default function weaveAdapterExtension(pi: unknown): Promise<void> {
  const state = loaderState();
  const slot = beginLoad(state);
  if (slot === undefined) return Promise.resolve();
  return runExtensionLoad(pi, state, slot).finally(() => {
    finishLoad(state, slot);
  });
}
