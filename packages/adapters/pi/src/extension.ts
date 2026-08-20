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
type RuntimeDigest = {
  readonly name: RuntimeOutputName;
  readonly sha256: string;
};

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
  readonly bytesByPath: ReadonlyMap<string, Uint8Array>;
  readonly token: string;
};

type LoaderState = {
  readonly pins: Map<string, Uint8Array>;
  preloadTail: Promise<void>;
  sequence: number;
};

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

interface GlobalLoaderState {
  readonly pins: Map<string, Uint8Array>;
  preloadTail: Promise<void>;
  sequence: number;
}

const GLOBAL_LOADER_STATE_KEY = Symbol.for(
  "weave.pi.trusted-extension-preloader.v1",
);

function loaderState(): LoaderState {
  const global = globalThis as typeof globalThis & {
    [GLOBAL_LOADER_STATE_KEY]?: GlobalLoaderState;
  };
  const existing = global[GLOBAL_LOADER_STATE_KEY];
  if (existing !== undefined) return existing;
  const created: GlobalLoaderState = {
    pins: new Map(),
    preloadTail: Promise.resolve(),
    sequence: 0,
  };
  global[GLOBAL_LOADER_STATE_KEY] = created;
  return created;
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

async function readBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    const contents = await Bun.file(path).arrayBuffer();
    if (contents.byteLength > MAX_EXTENSION_BUILD_OUTPUT_BYTES) {
      return undefined;
    }
    return new Uint8Array(contents).slice();
  } catch {
    return undefined;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
  state: LoaderState,
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
  return state.pins.has(pinnedPath) ? pinnedPath : undefined;
}

function installPinnedModulePlugin(
  state: LoaderState,
  token: string,
  pinnedPaths: readonly string[],
): boolean {
  try {
    const exactFilter = new RegExp(
      `^(?:${pinnedPaths.map((path) => escapeRegex(path)).join("|")})$`,
      "u",
    );
    Bun.plugin({
      name: `weave-pi-trusted-runtime-preloader-${token}`,
      setup(build) {
        build.onResolve({ filter: /.*/u }, (args) => {
          if (queryToken(args.importer) !== token) return undefined;
          if (!isLocalModuleSpecifier(args.path)) return undefined;
          const pinnedPath = pinnedPathForLocalImport(
            args.importer,
            args.path,
            token,
            state,
          );
          return pinnedPath === undefined
            ? {
                path: args.path,
                errors: [{ message: "unverified pinned module graph" }],
              }
            : { path: pinnedPath };
        });
        build.onLoad({ filter: exactFilter }, (args) => {
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
    return true;
  } catch {
    return false;
  }
}

async function pinRuntime(
  artifactPath: unknown,
  state: LoaderState,
): Promise<PreloadResult> {
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
  const bytes = await Promise.all(
    paths.map((output) => readBytes(output.path)),
  );
  if (bytes.some((value) => value === undefined)) {
    return { ok: false, reason: "runtime-read-failed" };
  }

  const loadedOutputs: RuntimeDigest[] = [];
  const bytesByPath = new Map<string, Uint8Array>();
  for (const [index, output] of paths.entries()) {
    const value = bytes[index];
    if (value === undefined)
      return { ok: false, reason: "runtime-read-failed" };
    const sha256 = digestBytes(value);
    if (sha256 === undefined)
      return { ok: false, reason: "runtime-read-failed" };
    loadedOutputs.push({ name: output.name, sha256 });
    bytesByPath.set(output.path, value);
  }

  const manifestPath = modulePathFor(
    entryPath,
    EXTENSION_BUILD_MANIFEST_FILENAME,
  );
  const manifestBytes = await readBytes(manifestPath);
  if (manifestBytes === undefined) {
    return { ok: false, reason: "manifest-invalid" };
  }
  const manifest = parseManifest(manifestBytes);
  if (manifest === undefined) return { ok: false, reason: "manifest-invalid" };

  const entryBytes = bytesByPath.get(entryPath);
  if (entryBytes === undefined)
    return { ok: false, reason: "runtime-read-failed" };
  const entrySource = decodeUtf8(entryBytes);
  if (entrySource === undefined) {
    return { ok: false, reason: "runtime-digest-mismatch" };
  }
  if (
    !isSha256(WEAVE_PI_EMBEDDED_BUILD_BINDING) ||
    WEAVE_PI_EMBEDDED_BUILD_BINDING === WEAVE_PI_BUILD_BINDING_PLACEHOLDER ||
    WEAVE_PI_EMBEDDED_BUILD_BINDING !== manifest.buildBinding
  ) {
    return { ok: false, reason: "binding-mismatch" };
  }
  const embedded = embeddedBindingFromSource(entrySource);
  if (
    embedded === undefined ||
    embedded.binding !== manifest.buildBinding ||
    embedded.binding !== WEAVE_PI_EMBEDDED_BUILD_BINDING
  ) {
    return { ok: false, reason: "binding-mismatch" };
  }
  const normalizedEntryBytes = encodeUtf8(embedded.normalized);
  if (normalizedEntryBytes === undefined) {
    return { ok: false, reason: "runtime-digest-mismatch" };
  }
  const normalizedEntryDigest = digestBytes(normalizedEntryBytes);
  if (normalizedEntryDigest === undefined) {
    return { ok: false, reason: "runtime-digest-mismatch" };
  }
  const bindingOutputs = loadedOutputs.map((output) =>
    output.name === "extension"
      ? { ...output, sha256: normalizedEntryDigest }
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

  state.sequence += 1;
  const token = `${state.sequence.toString(36)}-${manifest.buildBinding}`;
  const pinnedKeys: string[] = [];
  for (const [path, value] of bytesByPath) {
    const pinnedPath = `${path}${PIN_QUERY_PREFIX}${token}`;
    state.pins.set(pinnedPath, value);
    pinnedKeys.push(pinnedPath);
  }
  if (!installPinnedModulePlugin(state, token, pinnedKeys)) {
    for (const path of pinnedKeys) state.pins.delete(path);
    return { ok: false, reason: "pinned-loader-unavailable" };
  }
  return {
    ok: true,
    artifactPath: entryPath,
    buildBinding: manifest.buildBinding,
    loadedOutputs,
    modulePaths,
    bytesByPath,
    token,
  };
}

function schedulePreload(
  state: LoaderState,
  work: () => Promise<void>,
): Promise<void> {
  const next = state.preloadTail.catch(() => undefined).then(work);
  state.preloadTail = next.catch(() => undefined);
  return next;
}

async function runExtensionLoad(pi: unknown): Promise<void> {
  try {
    const state = loaderState();
    const pinned = await pinRuntime(import.meta.path as unknown, state);
    if (!pinned.ok) return;

    const identityPath = pinned.modulePaths.get("extension-build-identity");
    const hostLoaderPath = pinned.modulePaths.get("host-module-loader");
    const implementationPath = pinned.modulePaths.get("extension-impl");
    if (
      identityPath === undefined ||
      hostLoaderPath === undefined ||
      implementationPath === undefined
    ) {
      return;
    }

    const identityModule = (await import(
      `${identityPath}${PIN_QUERY_PREFIX}${pinned.token}`
    )) as unknown as TrustedIdentityModule;
    const hostModule = (await import(
      `${hostLoaderPath}${PIN_QUERY_PREFIX}${pinned.token}`
    )) as unknown as TrustedModuleLoader;

    const processStartMs = identityModule.extensionProcessStartMs();
    if (!Number.isSafeInteger(processStartMs) || processStartMs < 0) return;
    const loadedIdentity = {
      artifactPath: pinned.artifactPath,
      artifactSha256: runtimeOutputDigest(pinned.loadedOutputs, "extension"),
      loadedOutputs: pinned.loadedOutputs,
      buildBinding: pinned.buildBinding,
      loadTimeMs: Date.now(),
      processStartMs,
    };
    identityModule.maybeWriteExtensionBuildIdentityProofLine(loadedIdentity);
    hostModule.recordPiExtensionEntryPath(import.meta.path as unknown);

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

    const implementation = (await import(
      `${implementationPath}${PIN_QUERY_PREFIX}${pinned.token}`
    )) as unknown as TrustedImplementationModule;
    if (typeof implementation.default !== "function") return;
    implementation.setLoadedPiExtensionIdentity?.(loadedIdentity);
    await implementation.default(pi);
  } catch {
    return;
  }
}

export default function weaveAdapterExtension(pi: unknown): Promise<void> {
  return schedulePreload(loaderState(), () => runExtensionLoad(pi));
}
