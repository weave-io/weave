import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  AGENT_RECOVERY_EXHAUSTED_PRESENT,
  AGENT_RECOVERY_EXHAUSTED_UNSUPPORTED,
  probeAgentRecoveryExhaustedFeature,
} from "./capability-prober.js";
import {
  makeInvariantViolationFailure,
  type PiAdapterFailure,
} from "./errors.js";
import {
  type HostCapabilityGapDiagnostic,
  type HostCapabilityGapMode,
  UNKNOWN_HOST_VERSION,
} from "./host-compatibility.js";
import {
  PI_HOST_COMPATIBILITY_MATRIX,
  PI_HOST_SURFACE_IDS,
  type PiHostSurfaceId,
} from "./host-compatibility-matrix.js";
import type { PiCommandInfo, PiExtensionApi, PiUiPort } from "./types.js";

const PiSourceInfoSchema = z.object({
  path: z.string(),
  source: z.string(),
  scope: z.enum(["user", "project", "temporary"]),
  origin: z.enum(["package", "top-level"]),
  baseDir: z.string().optional(),
});
const PiCommandInfoSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  source: z.enum(["extension", "prompt", "skill"]),
  sourceInfo: PiSourceInfoSchema,
});

export function readValidatedCommands(
  api: Pick<PiExtensionApi, "getCommands">,
): Result<PiCommandInfo[], PiAdapterFailure> {
  const raw = Result.fromThrowable(
    () => api.getCommands(),
    () => makeInvariantViolationFailure("getCommands-threw"),
  )();
  if (raw.isErr()) return err(raw.error);
  const parsed = z.array(PiCommandInfoSchema).safeParse(raw.value);
  return parsed.success
    ? ok(parsed.data)
    : err(makeInvariantViolationFailure("getCommands-malformed"));
}

export {
  PI_HOST_SURFACE_IDS,
  type PiHostSurfaceId,
} from "./host-compatibility-matrix.js";
export type PiHostSurfaceStatus = "native" | "fallback" | "unavailable";
export interface PiHostSurfaceProbe {
  readonly surfaceId: PiHostSurfaceId;
  readonly status: PiHostSurfaceStatus;
  readonly details: string;
}
export interface PiHostSurfaceReport {
  readonly probes: readonly PiHostSurfaceProbe[];
  readonly requiredGaps: readonly PiHostSurfaceId[];
  /**
   * Overlay-only surfaces that are not natively available. These never force
   * health-only mode (Spec 33 §16); they select the existing custom-editor
   * child-inspection fallback (§7).
   */
  readonly overlayFallbackGaps: readonly PiHostSurfaceId[];
  /**
   * Feature-only surfaces that are not natively available. These never force
   * health-only mode and never select the overlay fallback.
   */
  readonly featureGaps: readonly PiHostSurfaceId[];
}
export interface PiHostSurfaceReadInput {
  readonly api: PiExtensionApi;
  readonly ui: PiUiPort;
  /** Public root exports imported by the extension loader. Never package.json. */
  readonly rootExports?: Readonly<Record<string, unknown>>;
}
export type PiHostSurfaceReadError =
  | { readonly type: "ReaderThrew" }
  | { readonly type: "ReaderRejected" }
  | { readonly type: "ReaderMalformed" };
export interface PiHostSurfaceReader {
  read(
    input: PiHostSurfaceReadInput,
  ): ResultAsync<readonly unknown[], PiHostSurfaceReadError>;
}

const MAX_DETAILS = 120;
const safeDetails = (value: unknown): string =>
  typeof value === "string" &&
  /^[\x20-\x7e]*$/.test(value) &&
  value.length <= MAX_DETAILS
    ? value
    : "surface-invalid";
const required = (id: PiHostSurfaceId): boolean =>
  PI_HOST_COMPATIBILITY_MATRIX.surfaces.find((surface) => surface.id === id)
    ?.required === true;
const overlayOnly = (id: PiHostSurfaceId): boolean =>
  PI_HOST_COMPATIBILITY_MATRIX.surfaces.find((surface) => surface.id === id)
    ?.severity === "overlay-only";
const featureOnly = (id: PiHostSurfaceId): boolean =>
  PI_HOST_COMPATIBILITY_MATRIX.surfaces.find((surface) => surface.id === id)
    ?.severity === "feature-only";
const fallbackDetails = (id: PiHostSurfaceId): string =>
  overlayOnly(id) ? "custom-editor-fallback" : "pi-default-fallback";
const fallback = (id: PiHostSurfaceId): boolean =>
  PI_HOST_COMPATIBILITY_MATRIX.surfaces.find((surface) => surface.id === id)
    ?.fallback === "pi-default";

export function readHostSurfaceReport(
  raw: readonly unknown[],
): PiHostSurfaceReport {
  const byId = new Map<string, PiHostSurfaceProbe[]>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const value = item as Record<string, unknown>;
    if (
      typeof value.surfaceId !== "string" ||
      !PI_HOST_SURFACE_IDS.includes(value.surfaceId as PiHostSurfaceId)
    )
      continue;
    const status =
      value.status === "native" ||
      value.status === "fallback" ||
      value.status === "unavailable"
        ? value.status
        : "unavailable";
    const bucket = byId.get(value.surfaceId) ?? [];
    bucket.push(
      Object.freeze({
        surfaceId: value.surfaceId as PiHostSurfaceId,
        status,
        details: safeDetails(value.details),
      }),
    );
    byId.set(value.surfaceId, bucket);
  }
  const makeProbe = (
    surfaceId: PiHostSurfaceId,
    status: PiHostSurfaceStatus,
    details: string,
  ): PiHostSurfaceProbe => Object.freeze({ surfaceId, status, details });
  const closedUnavailable = (surfaceId: PiHostSurfaceId): boolean =>
    required(surfaceId) || featureOnly(surfaceId);
  const missingDetails = (surfaceId: PiHostSurfaceId): string => {
    if (required(surfaceId)) return "surface-missing";
    if (featureOnly(surfaceId)) return AGENT_RECOVERY_EXHAUSTED_UNSUPPORTED;
    return fallbackDetails(surfaceId);
  };
  const probes = PI_HOST_SURFACE_IDS.map((surfaceId): PiHostSurfaceProbe => {
    const rows = byId.get(surfaceId);
    if (rows === undefined)
      return makeProbe(
        surfaceId,
        closedUnavailable(surfaceId) ? "unavailable" : "fallback",
        missingDetails(surfaceId),
      );
    if (rows.length !== 1)
      return makeProbe(
        surfaceId,
        closedUnavailable(surfaceId) ? "unavailable" : "fallback",
        "surface-duplicate",
      );
    const row = rows[0];
    if (row === undefined)
      return makeProbe(
        surfaceId,
        closedUnavailable(surfaceId) ? "unavailable" : "fallback",
        missingDetails(surfaceId),
      );
    if (featureOnly(surfaceId) && row.status !== "native")
      return makeProbe(
        surfaceId,
        "unavailable",
        row.details === "surface-invalid" ? "surface-invalid" : row.details,
      );
    if (
      !required(surfaceId) &&
      !featureOnly(surfaceId) &&
      row.status !== "native"
    )
      return makeProbe(surfaceId, "fallback", fallbackDetails(surfaceId));
    if (required(surfaceId) && row.status !== "native")
      return makeProbe(
        surfaceId,
        "unavailable",
        row.details === "surface-invalid" ? "surface-invalid" : row.details,
      );
    return makeProbe(surfaceId, row.status, row.details);
  });
  const requiredGaps = probes
    .filter(
      (probe) => required(probe.surfaceId) && probe.status === "unavailable",
    )
    .map((probe) => probe.surfaceId);
  const overlayFallbackGaps = probes
    .filter(
      (probe) => overlayOnly(probe.surfaceId) && probe.status !== "native",
    )
    .map((probe) => probe.surfaceId);
  const featureGaps = probes
    .filter(
      (probe) => featureOnly(probe.surfaceId) && probe.status === "unavailable",
    )
    .map((probe) => probe.surfaceId);
  return Object.freeze({
    probes: Object.freeze(probes),
    requiredGaps: Object.freeze(requiredGaps),
    overlayFallbackGaps: Object.freeze(overlayFallbackGaps),
    featureGaps: Object.freeze(featureGaps),
  });
}

/**
 * The trust boundary for host probes. A reader is extension-provided code, so
 * its synchronous throws, rejected results, typed errors, and malformed values
 * all become the same conservative report.
 */
export function safeReadHostSurfaceReport(
  reader: PiHostSurfaceReader,
  input: PiHostSurfaceReadInput,
): ResultAsync<PiHostSurfaceReport, never> {
  const read = ResultAsync.fromThrowable(
    async (): Promise<readonly unknown[]> => {
      const candidate = (await reader.read(input)) as unknown;
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("isErr" in candidate) ||
        typeof candidate.isErr !== "function" ||
        !("value" in candidate)
      ) {
        throw new Error("host-surface-reader-malformed-result");
      }
      if (candidate.isErr()) throw new Error("host-surface-reader-error");
      if (!Array.isArray(candidate.value))
        throw new Error("host-surface-reader-malformed-value");
      return candidate.value;
    },
    () => ({ type: "ReaderMalformed" as const }),
  )();
  return read
    .andThen(
      (rows): ResultAsync<PiHostSurfaceReport, PiHostSurfaceReadError> => {
        const normalized = Result.fromThrowable(
          () => readHostSurfaceReport(rows),
          () => ({ type: "ReaderMalformed" as const }),
        )();
        return normalized.isOk()
          ? okAsync(normalized.value)
          : errAsync(normalized.error);
      },
    )
    .orElse(() => okAsync(emptyHostSurfaceReport()));
}

export const emptyHostSurfaceReport = (): PiHostSurfaceReport =>
  readHostSurfaceReport([]);

/**
 * Builds the strong-debug diagnostics for every host-surface gap (Spec 33
 * §16). Required gaps report `health-only`; overlay-only gaps report the
 * existing custom-editor fallback and never health-only; feature-only gaps
 * report `feature-unavailable` and never change those two modes. Pure and
 * read-only.
 */
export function buildHostSurfaceGapDiagnostics(
  report: PiHostSurfaceReport,
  hostVersion: string = UNKNOWN_HOST_VERSION,
): readonly HostCapabilityGapDiagnostic[] {
  const version =
    typeof hostVersion === "string" && hostVersion.trim().length > 0
      ? hostVersion
      : UNKNOWN_HOST_VERSION;
  const describe = (
    surfaceId: PiHostSurfaceId,
    mode: HostCapabilityGapMode,
  ): HostCapabilityGapDiagnostic | undefined => {
    const declaration = PI_HOST_COMPATIBILITY_MATRIX.surfaces.find(
      (surface) => surface.id === surfaceId,
    );
    if (declaration === undefined) return undefined;
    const probe = report.probes.find(
      (candidate) => candidate.surfaceId === surfaceId,
    );
    return Object.freeze({
      capability: surfaceId,
      hostVersion: version,
      contract: declaration.contract,
      probeResult: `${probe?.status ?? "unavailable"}:${probe?.details ?? "surface-missing"}`,
      mode,
      remediation: declaration.remediation,
    });
  };
  const diagnostics = [
    ...report.requiredGaps.map((surfaceId) =>
      describe(surfaceId, "health-only"),
    ),
    ...report.overlayFallbackGaps.map((surfaceId) =>
      describe(surfaceId, "custom-editor-fallback"),
    ),
    ...report.featureGaps.map((surfaceId) =>
      describe(surfaceId, "feature-unavailable"),
    ),
  ].filter(
    (diagnostic): diagnostic is HostCapabilityGapDiagnostic =>
      diagnostic !== undefined,
  );
  return Object.freeze(diagnostics);
}

/**
 * True when the only host-surface gaps are overlay-only ones, so child
 * inspection must use the existing custom-editor fallback while the adapter
 * stays out of health-only mode (Spec 33 §16).
 */
export function selectsCustomEditorFallback(
  report: PiHostSurfaceReport,
): boolean {
  return report.overlayFallbackGaps.length > 0;
}

function defaultSurfaceProbe(surfaceId: PiHostSurfaceId): {
  readonly surfaceId: PiHostSurfaceId;
  readonly status: PiHostSurfaceStatus;
  readonly details: string;
} {
  if (fallback(surfaceId)) {
    return {
      surfaceId,
      status: "fallback",
      details: "pi-default-fallback",
    };
  }
  if (featureOnly(surfaceId)) {
    return {
      surfaceId,
      status: "unavailable",
      details: AGENT_RECOVERY_EXHAUSTED_UNSUPPORTED,
    };
  }
  return {
    surfaceId,
    status: "native",
    details: "validated-native-host-surface",
  };
}

/** Conservative built-in contract used only when no reader was injected. */
export const defaultHostSurfaceReport = (): PiHostSurfaceReport =>
  readHostSurfaceReport(PI_HOST_SURFACE_IDS.map(defaultSurfaceProbe));

function hostVersionIsValid(
  rootExports: Readonly<Record<string, unknown>>,
): boolean {
  const version = rootExports.VERSION;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
    return false;
  const [major, minor, patch] = version.split(".").map(Number);
  const [floorMajor, floorMinor, floorPatch] =
    PI_HOST_COMPATIBILITY_MATRIX.floorVersion.split(".").map(Number);
  return (
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    Number.isInteger(patch) &&
    (major > floorMajor ||
      (major === floorMajor &&
        (minor > floorMinor || (minor === floorMinor && patch >= floorPatch))))
  );
}

/**
 * The typed probe boundary for the concrete public host surfaces Spec 33 §16
 * depends on. Every member answers one question about *presence of a
 * documented public surface*; no member creates, opens, or writes a session.
 *
 * Tests substitute this port to toggle each capability independently.
 */
export interface PiHostProbePort {
  /** `SessionManager.create(cwd, sessionDir?, options?)` is publicly callable. */
  hasSessionCreate(): boolean;
  /** `SessionManager.open(path, sessionDir?, cwdOverride?)` is publicly callable. */
  hasSessionOpen(): boolean;
  /** Instance `getEntries()` is present on the session prototype. */
  hasSessionGetEntries(): boolean;
  /** Instance `getTree()` is present on the session prototype. */
  hasSessionGetTree(): boolean;
  /** `api.appendEntry(type, data)` is present on the extension API. */
  hasAppendEntry(): boolean;
  /**
   * The documented custom-session-directory contract holds.
   *
   * JavaScript cannot reliably introspect TypeScript's optional `sessionDir`
   * parameter (optional parameters are indistinguishable from required ones
   * at runtime, and `Function.length` is not a stable contract). This member
   * therefore validates the contract through the concrete public methods that
   * carry it - `SessionManager.create`, `SessionManager.open`, instance
   * `getSessionDir()` and `usesDefaultSessionDir()` - combined with the
   * supported-version contract. Callers surface that explicitly in
   * `probeResult`.
   */
  hasCustomSessionDirectoryContract(): boolean;
  /** Pi's overlay UI boundary plus the editor-restore lifecycle are present. */
  hasOverlayLifecycle(): boolean;
  /** The installed host version satisfies the supported-version contract. */
  hasSupportedVersion(): boolean;
}

const isFn = (value: unknown): boolean => typeof value === "function";

/**
 * Reads only concrete public surfaces of the installed host. Strictly
 * side-effect free: it inspects constructors and prototypes and never invokes
 * `create`, `open`, `getEntries`, `getTree`, or `appendEntry`.
 */
export function createDefaultPiHostProbePort(
  input: PiHostSurfaceReadInput,
): PiHostProbePort {
  const root = input.rootExports ?? {};
  const sessionManager = root.SessionManager;
  const statik = (name: string): boolean =>
    isFn(sessionManager) &&
    isFn((sessionManager as unknown as Record<string, unknown>)[name]);
  const instanceMethod = (name: string): boolean => {
    if (!isFn(sessionManager)) return false;
    const proto = (sessionManager as { prototype?: unknown }).prototype;
    if (typeof proto !== "object" || proto === null) return false;
    return isFn((proto as Record<string, unknown>)[name]);
  };
  const versionValid = hostVersionIsValid(root);
  return Object.freeze({
    hasSessionCreate: () => statik("create"),
    hasSessionOpen: () => statik("open"),
    hasSessionGetEntries: () => instanceMethod("getEntries"),
    hasSessionGetTree: () => instanceMethod("getTree"),
    hasAppendEntry: () => isFn(input.api.appendEntry),
    hasCustomSessionDirectoryContract: () =>
      statik("create") &&
      statik("open") &&
      instanceMethod("getSessionDir") &&
      instanceMethod("usesDefaultSessionDir") &&
      versionValid,
    hasOverlayLifecycle: () =>
      isFn(input.ui.custom) &&
      isFn(input.ui.setEditorComponent) &&
      isFn(input.ui.getEditorComponent),
    hasSupportedVersion: () => versionValid,
  });
}

/** Builds the probe port for one read. Overridable so tests can inject a fake. */
export type PiHostProbePortFactory = (
  input: PiHostSurfaceReadInput,
) => PiHostProbePort;

/**
 * Why one Spec 33 §16 session surface was accepted or rejected. Kept short,
 * printable-ASCII, and free of paths, versions, and any host payload.
 */
const SESSION_DIR_CONTRACT_VERIFIED =
  "session-dir-contract-verified-via-method-presence-and-version";
const SESSION_DIR_CONTRACT_UNVERIFIED =
  "session-dir-contract-unverified-method-or-version-missing";

/** Read-only production probe. Required protocol surfaces come from the validated root VERSION and matrix, never from look-alike public methods. */
export class DefaultPiHostSurfaceReader implements PiHostSurfaceReader {
  constructor(
    private readonly probePortFactory: PiHostProbePortFactory = createDefaultPiHostProbePort,
  ) {}

  read(
    input: PiHostSurfaceReadInput,
  ): ResultAsync<readonly unknown[], PiHostSurfaceReadError> {
    return ResultAsync.fromThrowable(
      async () => {
        const root = input.rootExports ?? {};
        const port = this.probePortFactory(input);
        const versionValid = port.hasSupportedVersion();
        const has = (name: string): boolean => typeof root[name] === "function";
        const native = (
          id: PiHostSurfaceId,
          supported: boolean,
          presentDetails = "validated-native-host-surface",
          missingDetails = "required-surface-missing",
        ): PiHostSurfaceProbe => {
          if (supported)
            return {
              surfaceId: id,
              status: "native",
              details: presentDetails,
            };
          if (required(id) || featureOnly(id))
            return {
              surfaceId: id,
              status: "unavailable",
              details: missingDetails,
            };
          return {
            surfaceId: id,
            status: "fallback",
            details: fallback(id)
              ? "pi-default-fallback"
              : "custom-editor-fallback",
          };
        };
        return [
          native("assistant-rendering", has("AssistantMessageComponent")),
          native("tool-rendering", has("ToolExecutionComponent")),
          native("markdown-rendering", has("Markdown")),
          native("image-rendering", has("Image")),
          native("usage-rendering", has("FooterComponent")),
          native("queue-rendering", has("BorderedLoader")),
          native("status-rendering", typeof input.ui.setStatus === "function"),
          native(
            "editor-composition",
            typeof input.ui.setEditorComponent === "function" &&
              has("CustomEditor"),
          ),
          native("rpc-steer", versionValid && matrixNative("rpc-steer")),
          native(
            "rpc-follow-up",
            versionValid && matrixNative("rpc-follow-up"),
          ),
          native(
            "rpc-get-entries",
            versionValid && matrixNative("rpc-get-entries"),
          ),
          native(
            "session-restore",
            versionValid && matrixNative("session-restore"),
          ),
          native(
            "extension-ui-response",
            versionValid && matrixNative("extension-ui-response"),
          ),
          native(
            "rpc-persistent-session",
            versionValid &&
              matrixNative("rpc-persistent-session") &&
              port.hasSessionCreate() &&
              port.hasSessionOpen(),
            "session-create-and-open-present",
            "session-create-or-open-missing",
          ),
          native(
            "rpc-append-entry",
            versionValid &&
              matrixNative("rpc-append-entry") &&
              port.hasAppendEntry(),
            "append-entry-present",
            "append-entry-missing",
          ),
          native(
            "custom-session-directory",
            versionValid &&
              matrixNative("custom-session-directory") &&
              port.hasCustomSessionDirectoryContract(),
            SESSION_DIR_CONTRACT_VERIFIED,
            SESSION_DIR_CONTRACT_UNVERIFIED,
          ),
          native(
            "rpc-session-tree-read",
            versionValid &&
              matrixNative("rpc-session-tree-read") &&
              port.hasSessionGetEntries() &&
              port.hasSessionGetTree(),
            "get-entries-and-get-tree-present",
            "get-entries-or-get-tree-missing",
          ),
          native(
            "child-overlay-lifecycle",
            versionValid &&
              matrixNative("child-overlay-lifecycle") &&
              port.hasOverlayLifecycle(),
            "overlay-and-editor-restore-present",
            "overlay-or-editor-restore-missing",
          ),
          native(
            "post-recovery-model-switch",
            probeAgentRecoveryExhaustedFeature(input.api).match(
              (supported) => supported,
              () => false,
            ),
            AGENT_RECOVERY_EXHAUSTED_PRESENT,
            AGENT_RECOVERY_EXHAUSTED_UNSUPPORTED,
          ),
        ];
      },
      () => ({ type: "ReaderThrew" as const }),
    )();
  }
}

function matrixNative(id: PiHostSurfaceId): boolean {
  return (
    PI_HOST_COMPATIBILITY_MATRIX.surfaces.find((surface) => surface.id === id)
      ?.nativeSupport === true
  );
}
