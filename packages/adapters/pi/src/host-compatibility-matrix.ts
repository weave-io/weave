import { err, ok, Result, type Result as ResultType } from "neverthrow";
import { z } from "zod";
import {
  HOST_PACKAGE_NAME,
  HOST_VERSION_FLOOR,
  isSupportedHostVersion,
} from "./host-compatibility.js";

export const PI_HOST_SURFACE_IDS = [
  "assistant-rendering",
  "tool-rendering",
  "markdown-rendering",
  "image-rendering",
  "usage-rendering",
  "queue-rendering",
  "status-rendering",
  "editor-composition",
  "rpc-steer",
  "rpc-follow-up",
  "rpc-get-entries",
  "session-restore",
  "extension-ui-response",
  "rpc-persistent-session",
  "rpc-append-entry",
  "rpc-session-tree-read",
  "custom-session-directory",
  "child-overlay-lifecycle",
  "runtime-model-fallback",
] as const;
export type PiHostSurfaceId = (typeof PI_HOST_SURFACE_IDS)[number];

/**
 * How a gap in one surface degrades the adapter (Spec 33 §16).
 *
 * - `required-for-delegation`: the adapter cannot run delegated children
 *   without it, so a gap enters health-only mode.
 * - `overlay-only`: only the native full-screen child overlay's own
 *   mount/unmount lifecycle needs it, so a gap routes to the existing
 *   custom-editor fallback (§7) and never forces health-only mode. Session
 *   *reads* are never overlay-only: delegation itself depends on them.
 * - `rendering-fallback`: Pi's own default rendering covers the gap.
 * - `feature-only`: an optional host feature. A gap must not enter
 *   health-only mode and must not select the overlay fallback; behavior
 *   stays on legacy visible/child settlement.
 */
export type PiHostSurfaceSeverity =
  | "required-for-delegation"
  | "overlay-only"
  | "rendering-fallback"
  | "feature-only";

export type PiHostSurfaceFallback = "pi-default" | "custom-editor";

export interface PiHostSurfaceDeclaration {
  readonly id: PiHostSurfaceId;
  readonly required: boolean;
  readonly nativeSupport: boolean;
  readonly minimumHostVersion: string;
  readonly severity: PiHostSurfaceSeverity;
  /** Human-readable contract this surface implements, used in diagnostics. */
  readonly contract: string;
  /** Operator-facing remediation used in health-only diagnostics. */
  readonly remediation: string;
  readonly fallback?: PiHostSurfaceFallback;
}

const rendering = (id: PiHostSurfaceId): PiHostSurfaceDeclaration => ({
  id,
  required: false,
  nativeSupport: false,
  minimumHostVersion: HOST_VERSION_FLOOR,
  severity: "rendering-fallback",
  contract: "Spec 33 §7 native rendering",
  remediation: "Pi default rendering is used; no operator action is required.",
  fallback: "pi-default",
});
const requiredNative = (
  id: PiHostSurfaceId,
  contract = "Spec 33 §16 required host surface",
  remediation = `Upgrade the Pi host to a version that provides ${id}, or disable Weave delegation.`,
): PiHostSurfaceDeclaration => ({
  id,
  required: true,
  nativeSupport: true,
  minimumHostVersion: HOST_VERSION_FLOOR,
  severity: "required-for-delegation",
  contract,
  remediation,
});
const overlayOnly = (
  id: PiHostSurfaceId,
  contract: string,
  remediation: string,
): PiHostSurfaceDeclaration => ({
  id,
  required: false,
  nativeSupport: true,
  minimumHostVersion: HOST_VERSION_FLOOR,
  severity: "overlay-only",
  contract,
  remediation,
  fallback: "custom-editor",
});
const featureOnly = (
  id: PiHostSurfaceId,
  contract: string,
  remediation: string,
): PiHostSurfaceDeclaration => ({
  id,
  required: false,
  nativeSupport: true,
  minimumHostVersion: HOST_VERSION_FLOOR,
  severity: "feature-only",
  contract,
  remediation,
});

/**
 * The one host version the release was actually tested against. It must be a
 * stable version inside the supported range, but it is deliberately not tied
 * to the floor's minor line: the floor states what the adapter supports, while
 * this states what was proved (Spec 33 §16).
 *
 * Task 15 must prove this pin on real Pi 0.84.2. Version alone is never
 * capability evidence; `runtime-model-fallback` is optional and feature-only.
 */
export const EXACT_TESTED_HOST_VERSION = "0.84.2";

export interface PiHostCompatibilityMatrix {
  readonly package: string;
  readonly supportedRange: string;
  readonly floorVersion: string;
  readonly exactTestedVersion: string;
  readonly surfaces: readonly PiHostSurfaceDeclaration[];
}

export const PI_HOST_COMPATIBILITY_MATRIX: PiHostCompatibilityMatrix = {
  package: HOST_PACKAGE_NAME,
  supportedRange: `>=${HOST_VERSION_FLOOR}`,
  floorVersion: HOST_VERSION_FLOOR,
  exactTestedVersion: EXACT_TESTED_HOST_VERSION,
  surfaces: Object.freeze([
    rendering("assistant-rendering"),
    rendering("tool-rendering"),
    rendering("markdown-rendering"),
    rendering("image-rendering"),
    rendering("usage-rendering"),
    rendering("queue-rendering"),
    rendering("status-rendering"),
    requiredNative("editor-composition"),
    requiredNative("rpc-steer"),
    requiredNative("rpc-follow-up"),
    requiredNative("rpc-get-entries"),
    requiredNative("session-restore"),
    requiredNative("extension-ui-response"),
    requiredNative(
      "rpc-persistent-session",
      "Spec 33 §16 persistent RPC session and restore",
      "Upgrade the Pi host to one that keeps RPC child sessions across restore, or disable Weave delegation.",
    ),
    requiredNative(
      "rpc-append-entry",
      "Spec 33 §16 appendEntry",
      "Upgrade the Pi host to one that exposes pi.appendEntry, or disable Weave delegation.",
    ),
    requiredNative(
      "rpc-session-tree-read",
      "Spec 33 §16 get_entries/get_tree",
      "Upgrade the Pi host to one that answers get_entries/get_tree, or disable Weave delegation.",
    ),
    requiredNative(
      "custom-session-directory",
      "Spec 33 §16 custom session directory support",
      "Upgrade the Pi host to one that accepts a custom session directory, or disable Weave delegation.",
    ),
    overlayOnly(
      "child-overlay-lifecycle",
      "Spec 33 §7 native full-screen child overlay mount and editor restore",
      "Upgrade the Pi host to one that exposes the overlay UI and editor-restore lifecycle; until then the custom-editor child inspection fallback is used.",
    ),
    featureOnly(
      "runtime-model-fallback",
      "Public Pi surfaces for optional runtime model fallback: agent_settled registration, terminal message_end, replacement-returning context, message_start, model_select, callable setModel, fire-and-forget sendMessage, and callable idle/pending helpers. Surface presence is not lifecycle proof.",
      "Missing or unproven public fallback surfaces keep ready health and legacy visible/child settlement. Exact-tested behavior is claimed only for Pi 0.84.2 after live proof.",
    ),
  ]),
} as const;
export type HostCompatibilityMatrixError =
  | { type: "PackageMismatch"; expected: string; actual: string }
  | { type: "RangeDrift"; expected: string; actual: string }
  | { type: "FloorDrift"; expected: string; actual: string }
  | { type: "ExactVersionMalformed"; version: string }
  | { type: "ExactVersionOutOfRange"; version: string }
  | { type: "SurfaceDrift"; reason: string }
  | { type: "Malformed"; field: string };

const EXACT_TESTED_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const MATRIX_INPUT_SCHEMA = z.unknown();
type MatrixInput = z.input<typeof MATRIX_INPUT_SCHEMA>;

interface MatrixObjectReference {
  readonly matrixObjectMarker?: never;
}

const MATRIX_OBJECT_SCHEMA = z.custom<MatrixObjectReference>((value) => {
  const checked = Result.fromThrowable(
    (): boolean => {
      if (value === null || Object(value) !== value) return false;
      if (Array.isArray(value)) return false;
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    },
    (): boolean => false,
  )();
  return checked.isOk() && checked.value;
});

type MatrixDataRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: MatrixInput };

function readMatrixData(value: MatrixInput, key: string): MatrixDataRead {
  const record = MATRIX_OBJECT_SCHEMA.safeParse(value);
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

function readMatrixArray(
  value: MatrixInput,
): readonly MatrixInput[] | undefined {
  const isArray = Result.fromThrowable(
    () => Array.isArray(value),
    (): boolean => false,
  )();
  if (isArray.isErr() || !isArray.value) return undefined;
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
    .max(PI_HOST_SURFACE_IDS.length)
    .safeParse(lengthDescriptor.value.value);
  if (!parsedLength.success || !Number.isSafeInteger(parsedLength.data)) {
    return undefined;
  }
  const values: MatrixInput[] = [];
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

function parseMatrixString(
  value: MatrixInput,
  field: string,
): ResultType<string, HostCompatibilityMatrixError> {
  const parsed = z.string().safeParse(value);
  return parsed.success ? ok(parsed.data) : err({ type: "Malformed", field });
}

function parseMatrixBoolean(
  value: MatrixInput,
  field: string,
): ResultType<boolean, HostCompatibilityMatrixError> {
  const parsed = z.boolean().safeParse(value);
  return parsed.success ? ok(parsed.data) : err({ type: "Malformed", field });
}

type MutableSurfaceDeclaration = {
  id: PiHostSurfaceId;
  required: boolean;
  nativeSupport: boolean;
  minimumHostVersion: string;
  severity: PiHostSurfaceSeverity;
  contract: string;
  remediation: string;
  fallback?: PiHostSurfaceFallback;
};

function parseSurface(
  value: MatrixInput,
  index: number,
): ResultType<PiHostSurfaceDeclaration, HostCompatibilityMatrixError> {
  const idValue = readMatrixData(value, "id");
  const requiredValue = readMatrixData(value, "required");
  const nativeValue = readMatrixData(value, "nativeSupport");
  const minimumValue = readMatrixData(value, "minimumHostVersion");
  const severityValue = readMatrixData(value, "severity");
  const contractValue = readMatrixData(value, "contract");
  const remediationValue = readMatrixData(value, "remediation");
  if (
    idValue.kind !== "value" ||
    requiredValue.kind !== "value" ||
    nativeValue.kind !== "value" ||
    minimumValue.kind !== "value" ||
    severityValue.kind !== "value" ||
    contractValue.kind !== "value" ||
    remediationValue.kind !== "value"
  ) {
    return err({ type: "Malformed", field: `surfaces[${index}]` });
  }
  const id = parseMatrixString(idValue.value, `surfaces.id[${index}]`);
  const required = parseMatrixBoolean(
    requiredValue.value,
    `surfaces.required[${index}]`,
  );
  const nativeSupport = parseMatrixBoolean(
    nativeValue.value,
    `surfaces.nativeSupport[${index}]`,
  );
  const minimumHostVersion = parseMatrixString(
    minimumValue.value,
    `surfaces.minimumHostVersion[${index}]`,
  );
  const severity = z
    .enum([
      "required-for-delegation",
      "overlay-only",
      "rendering-fallback",
      "feature-only",
    ])
    .safeParse(severityValue.value);
  const contract = parseMatrixString(
    contractValue.value,
    `surfaces.contract[${index}]`,
  );
  const remediation = parseMatrixString(
    remediationValue.value,
    `surfaces.remediation[${index}]`,
  );
  if (
    id.isErr() ||
    required.isErr() ||
    nativeSupport.isErr() ||
    minimumHostVersion.isErr() ||
    !severity.success ||
    contract.isErr() ||
    remediation.isErr()
  ) {
    return err({ type: "Malformed", field: `surfaces[${index}]` });
  }
  const surfaceId = PI_HOST_SURFACE_IDS.find(
    (candidate) => candidate === id.value,
  );
  if (surfaceId === undefined) {
    return err({
      type: "SurfaceDrift",
      reason: "surface-unknown-or-duplicate",
    });
  }
  const fallbackValue = readMatrixData(value, "fallback");
  if (fallbackValue.kind === "invalid") {
    return err({ type: "Malformed", field: `surfaces.fallback[${index}]` });
  }
  let fallback: PiHostSurfaceFallback | undefined;
  if (fallbackValue.kind === "value") {
    const parsedFallback = z
      .enum(["pi-default", "custom-editor"])
      .optional()
      .safeParse(fallbackValue.value);
    if (!parsedFallback.success) {
      return err({ type: "Malformed", field: `surfaces.fallback[${index}]` });
    }
    fallback = parsedFallback.data;
  }
  const declaration: MutableSurfaceDeclaration = {
    id: surfaceId,
    required: required.value,
    nativeSupport: nativeSupport.value,
    minimumHostVersion: minimumHostVersion.value,
    severity: severity.data,
    contract: contract.value,
    remediation: remediation.value,
  };
  if (fallback !== undefined) declaration.fallback = fallback;
  return ok(declaration);
}

function parseMatrix(
  value: MatrixInput,
): ResultType<PiHostCompatibilityMatrix, HostCompatibilityMatrixError> {
  const packageField = readMatrixData(value, "package");
  const rangeField = readMatrixData(value, "supportedRange");
  const floorField = readMatrixData(value, "floorVersion");
  const exactField = readMatrixData(value, "exactTestedVersion");
  const surfacesField = readMatrixData(value, "surfaces");
  if (
    packageField.kind !== "value" ||
    rangeField.kind !== "value" ||
    floorField.kind !== "value" ||
    exactField.kind !== "value" ||
    surfacesField.kind !== "value"
  ) {
    return err({ type: "Malformed", field: "matrix" });
  }
  const packageValue = parseMatrixString(packageField.value, "package");
  const rangeValue = parseMatrixString(rangeField.value, "supportedRange");
  const floorValue = parseMatrixString(floorField.value, "floorVersion");
  const exactValue = parseMatrixString(exactField.value, "exactTestedVersion");
  const rawSurfaces = readMatrixArray(surfacesField.value);
  if (
    packageValue.isErr() ||
    rangeValue.isErr() ||
    floorValue.isErr() ||
    exactValue.isErr() ||
    rawSurfaces === undefined
  ) {
    return err({ type: "Malformed", field: "matrix" });
  }
  const surfaces: PiHostSurfaceDeclaration[] = [];
  for (const [index, surfaceValue] of rawSurfaces.entries()) {
    const surface = parseSurface(surfaceValue, index);
    if (surface.isErr()) return err(surface.error);
    surfaces.push(surface.value);
  }
  return ok({
    package: packageValue.value,
    supportedRange: rangeValue.value,
    floorVersion: floorValue.value,
    exactTestedVersion: exactValue.value,
    surfaces,
  });
}

export function validateHostCompatibilityMatrix(
  matrix: PiHostCompatibilityMatrix,
): Result<PiHostCompatibilityMatrix, HostCompatibilityMatrixError> {
  const parsed = parseMatrix(matrix);
  if (parsed.isErr()) return err(parsed.error);
  const candidate = parsed.value;
  if (candidate.package !== HOST_PACKAGE_NAME)
    return err({
      type: "PackageMismatch",
      expected: HOST_PACKAGE_NAME,
      actual: candidate.package,
    });
  const expectedRange = `>=${HOST_VERSION_FLOOR}`;
  if (candidate.supportedRange !== expectedRange)
    return err({
      type: "RangeDrift",
      expected: expectedRange,
      actual: candidate.supportedRange,
    });
  if (candidate.floorVersion !== HOST_VERSION_FLOOR)
    return err({
      type: "FloorDrift",
      expected: HOST_VERSION_FLOOR,
      actual: candidate.floorVersion,
    });
  if (!EXACT_TESTED_VERSION_PATTERN.test(candidate.exactTestedVersion))
    return err({
      type: "ExactVersionMalformed",
      version: candidate.exactTestedVersion,
    });
  if (!isSupportedHostVersion(candidate.exactTestedVersion))
    return err({
      type: "ExactVersionOutOfRange",
      version: candidate.exactTestedVersion,
    });
  if (candidate.surfaces.length !== PI_HOST_SURFACE_IDS.length)
    return err({ type: "SurfaceDrift", reason: "surface-count" });
  const seen = new Set<string>();
  for (const surface of candidate.surfaces) {
    if (seen.has(surface.id))
      return err({
        type: "SurfaceDrift",
        reason: "surface-unknown-or-duplicate",
      });
    seen.add(surface.id);
    if (
      !EXACT_TESTED_VERSION_PATTERN.test(surface.minimumHostVersion) ||
      !isSupportedHostVersion(surface.minimumHostVersion)
    )
      return err({
        type: "SurfaceDrift",
        reason: `surface-min-version:${surface.id}`,
      });
    const renderingSurface = surface.severity === "rendering-fallback";
    const overlaySurface = surface.severity === "overlay-only";
    const featureSurface = surface.severity === "feature-only";
    const knownSeverity =
      surface.severity === "required-for-delegation" ||
      overlaySurface ||
      renderingSurface ||
      featureSurface;
    const expectedFallback = ((): PiHostSurfaceFallback | undefined => {
      if (renderingSurface) return "pi-default";
      if (overlaySurface) return "custom-editor";
      return void 0;
    })();
    if (
      !knownSeverity ||
      renderingSurface !== surface.id.endsWith("-rendering") ||
      surface.required !== (surface.severity === "required-for-delegation") ||
      surface.fallback !== expectedFallback ||
      surface.nativeSupport !== !renderingSurface ||
      (featureSurface && surface.fallback !== undefined) ||
      surface.contract.trim().length === 0 ||
      surface.remediation.trim().length === 0
    )
      return err({
        type: "SurfaceDrift",
        reason: `surface-policy:${surface.id}`,
      });
    if (surface.minimumHostVersion !== HOST_VERSION_FLOOR)
      return err({
        type: "SurfaceDrift",
        reason: `surface-min-version-drift:${surface.id}`,
      });
  }
  if (seen.size !== PI_HOST_SURFACE_IDS.length)
    return err({ type: "SurfaceDrift", reason: "surface-missing" });
  return ok(candidate);
}
