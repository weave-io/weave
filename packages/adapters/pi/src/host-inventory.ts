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
  isSupportedHostVersion,
  UNKNOWN_HOST_VERSION,
} from "./host-compatibility.js";
import {
  PI_HOST_COMPATIBILITY_MATRIX,
  PI_HOST_SURFACE_IDS,
  type PiHostSurfaceId,
} from "./host-compatibility-matrix.js";
import type {
  PiCommandInfo,
  PiExtensionApi,
  PiSourceInfo,
  PiUiPort,
} from "./types.js";

const HOST_OBSERVED_VALUE_SCHEMA = z.unknown();
export type PiHostObservedValue = z.input<typeof HOST_OBSERVED_VALUE_SCHEMA>;

interface PiHostObjectReference {
  readonly piHostObjectMarker?: never;
}

const PI_HOST_OBJECT_SCHEMA = z.custom<PiHostObjectReference>((value) => {
  const checked = Result.fromThrowable(
    (): boolean => {
      if (value === null || Object(value) !== value) return false;
      if (Array.isArray(value)) return false;
      const prototype = Object.getPrototypeOf(value);
      if (prototype === Object.prototype || prototype === null) return true;

      // Bun may expose `import * as ...` through a module wrapper prototype.
      // Accept that exact namespace shape without accepting arbitrary classes.
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

const PI_HOST_REFERENCE_SCHEMA = z.custom<PiHostObjectReference>((value) =>
  Result.fromThrowable(
    (): boolean =>
      value !== null && Object(value) === value && !Array.isArray(value),
    (): boolean => false,
  )().unwrapOr(false),
);

export type PiHostCallable = (
  ...args: readonly PiHostObservedValue[]
) => PiHostObservedValue;

const PI_HOST_CALLABLE_SCHEMA = z.custom<PiHostCallable>((value) => {
  const checked = Result.fromThrowable(
    (): boolean => value instanceof Function,
    (): boolean => false,
  )();
  return checked.isOk() && checked.value;
});

/** Root exports are opaque at the import seam; known members are parsed before use. */
export interface PiHostRootExports {
  readonly VERSION?: PiHostObservedValue;
  readonly SessionManager?: PiHostObservedValue;
  readonly SettingsManager?: PiHostObservedValue;
  readonly DefaultPackageManager?: PiHostObservedValue;
  readonly getAgentDir?: PiHostObservedValue;
  readonly AssistantMessageComponent?: PiHostObservedValue;
  readonly ToolExecutionComponent?: PiHostObservedValue;
  readonly Markdown?: PiHostObservedValue;
  readonly Image?: PiHostObservedValue;
  readonly FooterComponent?: PiHostObservedValue;
  readonly BorderedLoader?: PiHostObservedValue;
  readonly CustomEditor?: PiHostObservedValue;
}

type HostDataRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: PiHostObservedValue };

function readHostData(value: PiHostObservedValue, key: string): HostDataRead {
  const record = PI_HOST_OBJECT_SCHEMA.safeParse(value);
  if (!record.success) return { kind: "invalid" };
  const descriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(record.data, key),
    (): PropertyDescriptor | undefined => undefined,
  )();
  if (descriptor.isErr()) return { kind: "invalid" };
  if (descriptor.value === undefined) return { kind: "missing" };
  if (!("value" in descriptor.value) || descriptor.value.enumerable !== true) {
    return { kind: "invalid" };
  }
  return { kind: "value", value: descriptor.value.value };
}

function hostReference(
  value: PiHostObservedValue,
): PiHostObjectReference | undefined {
  const parsed = PI_HOST_REFERENCE_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readHostMember(value: PiHostObservedValue, key: string): HostDataRead {
  let current = hostReference(value);
  const seen = new Set<PiHostObjectReference>();
  for (let depth = 0; current !== undefined && depth < 16; depth += 1) {
    if (seen.has(current)) return { kind: "invalid" };
    seen.add(current);
    const descriptor = Result.fromThrowable(
      () => Object.getOwnPropertyDescriptor(current, key),
      (): PropertyDescriptor | undefined => undefined,
    )();
    if (descriptor.isErr()) return { kind: "invalid" };
    if (descriptor.value !== undefined) {
      if (!("value" in descriptor.value)) return { kind: "invalid" };
      return { kind: "value", value: descriptor.value.value };
    }
    const prototype = Result.fromThrowable(
      () => Object.getPrototypeOf(current),
      (): object | null => null,
    )();
    if (prototype.isErr() || prototype.value === null) {
      return prototype.isErr() ? { kind: "invalid" } : { kind: "missing" };
    }
    const parsedPrototype = PI_HOST_REFERENCE_SCHEMA.safeParse(prototype.value);
    if (!parsedPrototype.success) return { kind: "invalid" };
    current = parsedPrototype.data;
  }
  return current === undefined ? { kind: "missing" } : { kind: "invalid" };
}

function readHostFunction(
  value: PiHostObservedValue,
  key: string,
): PiHostCallable | undefined {
  const member = readHostMember(value, key);
  if (member.kind !== "value") return undefined;
  const parsed = PI_HOST_CALLABLE_SCHEMA.safeParse(member.value);
  return parsed.success ? parsed.data : undefined;
}

function callHostFunction(
  target: PiHostObservedValue,
  call: PiHostCallable,
  args: readonly PiHostObservedValue[],
): PiHostObservedValue {
  return Result.fromThrowable(
    () => call.apply(target, [...args]),
    (): PiHostObservedValue => void 0,
  )().unwrapOr(void 0);
}

function readHostArray(
  value: PiHostObservedValue,
): readonly PiHostObservedValue[] | undefined {
  const arrayResult = Result.fromThrowable(
    () => Array.isArray(value),
    (): boolean => false,
  )();
  if (arrayResult.isErr() || !arrayResult.value) return undefined;
  const lengthDescriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(value, "length"),
    (): PropertyDescriptor | undefined => undefined,
  )();
  if (lengthDescriptor.isErr() || lengthDescriptor.value === undefined) {
    return undefined;
  }
  if (
    !("value" in lengthDescriptor.value) ||
    lengthDescriptor.value.enumerable === true
  ) {
    return undefined;
  }
  const parsedLength = z
    .number()
    .int()
    .min(0)
    .max(4096)
    .safeParse(lengthDescriptor.value.value);
  if (!parsedLength.success || !Number.isSafeInteger(parsedLength.data)) {
    return undefined;
  }
  const values: PiHostObservedValue[] = [];
  for (let index = 0; index < parsedLength.data; index += 1) {
    const descriptor = Result.fromThrowable(
      () => Object.getOwnPropertyDescriptor(value, String(index)),
      (): PropertyDescriptor | undefined => undefined,
    )();
    if (descriptor.isErr() || descriptor.value === undefined) return undefined;
    if (
      !("value" in descriptor.value) ||
      descriptor.value.enumerable !== true
    ) {
      return undefined;
    }
    values.push(descriptor.value.value);
  }
  return values;
}

function parseHostText(value: PiHostObservedValue): string | undefined {
  const parsed = z.string().safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

type MutableHostSourceInfo = {
  path: string;
  source: string;
  scope: PiSourceInfo["scope"];
  origin: PiSourceInfo["origin"];
  baseDir?: string;
};

type MutablePiCommandInfo = {
  name: string;
  source: PiCommandInfo["source"];
  sourceInfo: PiSourceInfo;
  description?: string;
};

function parseHostSourceInfo(
  value: PiHostObservedValue,
): PiSourceInfo | undefined {
  const path = readHostData(value, "path");
  const source = readHostData(value, "source");
  const scope = readHostData(value, "scope");
  const origin = readHostData(value, "origin");
  if (
    path.kind !== "value" ||
    source.kind !== "value" ||
    scope.kind !== "value" ||
    origin.kind !== "value"
  ) {
    return undefined;
  }
  const parsedPath = z.string().safeParse(path.value);
  const parsedSource = z.string().safeParse(source.value);
  const parsedScope = z
    .enum(["user", "project", "temporary"])
    .safeParse(scope.value);
  const parsedOrigin = z.enum(["package", "top-level"]).safeParse(origin.value);
  if (
    !parsedPath.success ||
    !parsedSource.success ||
    !parsedScope.success ||
    !parsedOrigin.success
  ) {
    return undefined;
  }
  const result: MutableHostSourceInfo = {
    path: parsedPath.data,
    source: parsedSource.data,
    scope: parsedScope.data,
    origin: parsedOrigin.data,
  };
  const baseDir = readHostData(value, "baseDir");
  if (baseDir.kind === "invalid") return undefined;
  if (baseDir.kind === "value") {
    const parsedBaseDir = z.string().safeParse(baseDir.value);
    if (!parsedBaseDir.success) return undefined;
    result.baseDir = parsedBaseDir.data;
  }
  return result;
}

function parseHostCommand(
  value: PiHostObservedValue,
): PiCommandInfo | undefined {
  const name = readHostData(value, "name");
  const source = readHostData(value, "source");
  const sourceInfo = readHostData(value, "sourceInfo");
  if (
    name.kind !== "value" ||
    source.kind !== "value" ||
    sourceInfo.kind !== "value"
  ) {
    return undefined;
  }
  const parsedName = z.string().min(1).safeParse(name.value);
  const parsedSource = z
    .enum(["extension", "prompt", "skill"])
    .safeParse(source.value);
  const parsedSourceInfo = parseHostSourceInfo(sourceInfo.value);
  if (
    !parsedName.success ||
    !parsedSource.success ||
    parsedSourceInfo === undefined
  ) {
    return undefined;
  }
  const command: MutablePiCommandInfo = {
    name: parsedName.data,
    source: parsedSource.data,
    sourceInfo: parsedSourceInfo,
  };
  const description = readHostData(value, "description");
  if (description.kind === "invalid") return undefined;
  if (description.kind === "value") {
    const parsedDescription = z.string().safeParse(description.value);
    if (!parsedDescription.success) return undefined;
    command.description = parsedDescription.data;
  }
  return command;
}

export function readValidatedCommands(
  api: Pick<PiExtensionApi, "getCommands">,
): Result<PiCommandInfo[], PiAdapterFailure> {
  const getCommands = readHostFunction(api, "getCommands");
  if (getCommands === undefined) {
    return err(makeInvariantViolationFailure("getCommands-malformed"));
  }
  const raw = Result.fromThrowable(
    () => callHostFunction(api, getCommands, []),
    () => makeInvariantViolationFailure("getCommands-threw"),
  )();
  if (raw.isErr()) return err(raw.error);
  const values = readHostArray(raw.value);
  if (values === undefined) {
    return err(makeInvariantViolationFailure("getCommands-malformed"));
  }
  const commands: PiCommandInfo[] = [];
  for (const value of values) {
    const command = parseHostCommand(value);
    if (command === undefined) {
      return err(makeInvariantViolationFailure("getCommands-malformed"));
    }
    commands.push(command);
  }
  return ok(commands);
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
  readonly rootExports?: PiHostRootExports;
}
export type PiHostSurfaceReadError =
  | { readonly type: "ReaderThrew" }
  | { readonly type: "ReaderRejected" }
  | { readonly type: "ReaderMalformed" };
export interface PiHostSurfaceReader {
  read(
    input: PiHostSurfaceReadInput,
  ): ResultAsync<readonly PiHostObservedValue[], PiHostSurfaceReadError>;
}

const MAX_DETAILS = 120;

function safeDetails(value: PiHostObservedValue): string {
  const text = parseHostText(value);
  return text !== undefined &&
    /^[\x20-\x7e]*$/.test(text) &&
    text.length <= MAX_DETAILS
    ? text
    : "surface-invalid";
}

function surfaceIdFor(value: string): PiHostSurfaceId | undefined {
  for (const id of PI_HOST_SURFACE_IDS) if (id === value) return id;
  return undefined;
}

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

function buildHostSurfaceReport(
  raw: readonly PiHostObservedValue[],
): PiHostSurfaceReport {
  const byId = new Map<string, PiHostSurfaceProbe[]>();
  for (const item of raw) {
    const surfaceIdValue = readHostData(item, "surfaceId");
    const statusValue = readHostData(item, "status");
    const detailsValue = readHostData(item, "details");
    if (surfaceIdValue.kind !== "value" || statusValue.kind !== "value")
      continue;
    const surfaceText = parseHostText(surfaceIdValue.value);
    const surfaceId =
      surfaceText === undefined ? undefined : surfaceIdFor(surfaceText);
    if (surfaceId === undefined) continue;
    const statusText = parseHostText(statusValue.value);
    const status: PiHostSurfaceStatus =
      statusText === "native" ||
      statusText === "fallback" ||
      statusText === "unavailable"
        ? statusText
        : "unavailable";
    const bucket = byId.get(surfaceId) ?? [];
    bucket.push(
      Object.freeze({
        surfaceId,
        status,
        details: safeDetails(
          detailsValue.kind === "value" ? detailsValue.value : void 0,
        ),
      }),
    );
    byId.set(surfaceId, bucket);
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

export function readHostSurfaceReport(
  raw: readonly PiHostObservedValue[],
): PiHostSurfaceReport {
  const result = Result.fromThrowable(
    () => buildHostSurfaceReport(raw),
    () => void 0,
  )();
  return result.isOk() ? result.value : buildHostSurfaceReport([]);
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
    async (): Promise<readonly PiHostObservedValue[]> => {
      const candidate = await reader.read(input);
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
    .orElse(() => okAsync(readHostSurfaceReport([])));
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
  const parsedHostVersion = parseHostText(hostVersion);
  const version =
    parsedHostVersion !== undefined && parsedHostVersion.trim().length > 0
      ? parsedHostVersion
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

function defaultSurfaceProbe(surfaceId: PiHostSurfaceId): PiHostSurfaceProbe {
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

function hostVersionIsValid(rootExports: PiHostRootExports): boolean {
  const versionValue = readHostData(rootExports, "VERSION");
  if (versionValue.kind !== "value") return false;
  const version = parseHostText(versionValue.value);
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
    return false;
  }
  return isSupportedHostVersion(version);
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

/**
 * Reads only concrete public surfaces of the installed host. Strictly
 * side-effect free: it inspects constructors and prototypes and never invokes
 * `create`, `open`, `getEntries`, `getTree`, or `appendEntry`.
 */
export function createDefaultPiHostProbePort(
  input: PiHostSurfaceReadInput,
): PiHostProbePort {
  const root = input.rootExports;
  const sessionManagerValue =
    root === undefined
      ? { kind: "missing" as const }
      : readHostData(root, "SessionManager");
  const sessionManager =
    sessionManagerValue.kind === "value"
      ? sessionManagerValue.value
      : undefined;
  const statik = (name: string): boolean =>
    sessionManager !== undefined &&
    readHostFunction(sessionManager, name) !== undefined;
  const instanceMethod = (name: string): boolean => {
    if (sessionManager === undefined) return false;
    const prototypeValue = readHostMember(sessionManager, "prototype");
    if (prototypeValue.kind !== "value") return false;
    const prototype = hostReference(prototypeValue.value);
    return (
      prototype !== undefined && readHostFunction(prototype, name) !== undefined
    );
  };
  const versionValid = root !== undefined && hostVersionIsValid(root);
  return Object.freeze({
    hasSessionCreate: () => statik("create"),
    hasSessionOpen: () => statik("open"),
    hasSessionGetEntries: () => instanceMethod("getEntries"),
    hasSessionGetTree: () => instanceMethod("getTree"),
    hasAppendEntry: () =>
      readHostFunction(input.api, "appendEntry") !== undefined,
    hasCustomSessionDirectoryContract: () =>
      statik("create") &&
      statik("open") &&
      instanceMethod("getSessionDir") &&
      instanceMethod("usesDefaultSessionDir") &&
      versionValid,
    hasOverlayLifecycle: () =>
      readHostFunction(input.ui, "custom") !== undefined &&
      readHostFunction(input.ui, "setEditorComponent") !== undefined &&
      readHostFunction(input.ui, "getEditorComponent") !== undefined,
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
  ): ResultAsync<readonly PiHostObservedValue[], PiHostSurfaceReadError> {
    return ResultAsync.fromThrowable(
      async () => {
        const root = input.rootExports;
        const port = this.probePortFactory(input);
        const versionValid = port.hasSupportedVersion();
        const has = (name: string): boolean => {
          if (root === undefined) return false;
          const value = readHostData(root, name);
          return (
            value.kind === "value" &&
            PI_HOST_CALLABLE_SCHEMA.safeParse(value.value).success
          );
        };
        const uiHas = (name: string): boolean =>
          readHostFunction(input.ui, name) !== undefined;
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
          native("status-rendering", uiHas("setStatus")),
          native(
            "editor-composition",
            uiHas("setEditorComponent") && has("CustomEditor"),
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
