import {
  EXTENSION_BUILD_MANIFEST_FILENAME,
  MAX_EXTENSION_BUILD_OUTPUT_BYTES,
  MAX_EXTENSION_IN_FLIGHT_PINNED_BYTES,
  MAX_EXTENSION_IN_FLIGHT_PRELOADS,
} from "./extension-build-identity-types.js";
import {
  type ExtensionPreloaderRetentionSnapshot,
  type GlobalLoaderState,
  type LoadSlot,
  PIN_QUERY_PREFIX,
  type PinnedRuntime,
  type PreloaderFailureReason,
  type PreloadResult,
  RUNTIME_OUTPUTS,
  type RuntimeDigest,
} from "./extension-preloader-contract.js";
import { installPinnedModulePlugin } from "./extension-preloader-loader.js";
import {
  computeBuildBinding,
  digestBytes,
  isSafeAbsolutePath,
  modulePathFor,
  normalizedEntryDigest,
  readBytes,
  readPreloadManifest,
  runtimeModulePaths,
} from "./extension-preloader-manifest.js";

const GLOBAL_LOADER_STATE_KEY = Symbol.for(
  "weave.pi.trusted-extension-preloader.v2",
);

export function loaderState(): GlobalLoaderState {
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
  health: GlobalLoaderState["health"],
): void {
  state.health = health;
}

export function beginLoad(state: GlobalLoaderState): LoadSlot | undefined {
  if (state.inFlightLoads.size >= MAX_EXTENSION_IN_FLIGHT_PRELOADS) {
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
    state.inFlightPinnedBytes > MAX_EXTENSION_IN_FLIGHT_PINNED_BYTES - bytes
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

export function finishLoad(state: GlobalLoaderState, slot: LoadSlot): void {
  releaseSlotBytes(state, slot);
  state.inFlightLoads.delete(slot);
}

export function recordPreloaderFailure(
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

export function recordPreloaderLoaded(
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

async function readPinnedRuntimeBytes(
  path: string,
  state: GlobalLoaderState,
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

function registerPinnedRuntime(
  state: GlobalLoaderState,
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

/** Clear and release every byte and registry capability owned by one load. */
export function disposePinnedRuntime(
  state: GlobalLoaderState,
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

export async function pinRuntime(
  artifactPath: unknown,
  embeddedBinding: unknown,
  state: GlobalLoaderState,
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
    const modulePaths = runtimeModulePaths(entryPath);
    const paths = RUNTIME_OUTPUTS.map((output) => ({
      ...output,
      path: modulePaths.get(output.name),
    }));

    const loadedOutputs: RuntimeDigest[] = [];
    for (const output of paths) {
      if (output.path === undefined) {
        return { ok: false, reason: "runtime-read-failed" };
      }
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
      embeddedBinding,
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
