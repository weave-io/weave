import { VERSION as PI_HOST_VERSION } from "@earendil-works/pi-coding-agent";
import {
  err,
  errAsync,
  ok,
  okAsync,
  Result,
  type ResultAsync,
  type Result as ResultType,
} from "neverthrow";
import { z } from "zod";
import {
  makeHostIdentityUnknownFailure,
  makeHostVersionUnsupportedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import {
  type ExtensionBuildIdentityHealth,
  renderExtensionBuildIdentityHealthLine,
} from "./extension-build-identity.js";

/** The one compatible host package. Upstream `@mariozechner/pi-coding-agent` is a different identity. */
export const HOST_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** Inclusive floor of the supported host version range (Pi adapter contract). */
export const HOST_VERSION_FLOOR = "0.81.1";

export const HostPackageInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});
export type HostPackageInfo = z.infer<typeof HostPackageInfoSchema>;

const HOST_COMPATIBILITY_INPUT_SCHEMA = z.unknown();
type HostCompatibilityInput = z.input<typeof HOST_COMPATIBILITY_INPUT_SCHEMA>;

interface HostCompatibilityObjectReference {
  readonly hostCompatibilityObjectMarker?: never;
}

const HOST_COMPATIBILITY_OBJECT_SCHEMA =
  z.custom<HostCompatibilityObjectReference>((value) => {
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

type HostCompatibilityDataRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: HostCompatibilityInput };

function readHostCompatibilityData(
  value: HostCompatibilityInput,
  key: string,
): HostCompatibilityDataRead {
  const record = HOST_COMPATIBILITY_OBJECT_SCHEMA.safeParse(value);
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

function parseHostPackageInfo(
  value: HostCompatibilityInput,
): ResultType<HostPackageInfo, void> {
  const name = readHostCompatibilityData(value, "name");
  const version = readHostCompatibilityData(value, "version");
  if (name.kind !== "value" || version.kind !== "value") {
    return err(void 0);
  }
  const parsedName = z.string().min(1).safeParse(name.value);
  const parsedVersion = z.string().min(1).safeParse(version.value);
  if (!parsedName.success || !parsedVersion.success) return err(void 0);
  return ok({ name: parsedName.data, version: parsedVersion.data });
}

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
}

const SEMVER_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(version: string): ResultType<ParsedVersion, void> {
  const match = SEMVER_PATTERN.exec(version);
  if (match === null) return err(void 0);
  const [, major, minor, patch, prerelease] = match;
  return ok({
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease,
  });
}

function compareCore(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

const FLOOR = { major: 0, minor: 81, patch: 1 };

/**
 * Minimum-only `>=0.81.1` range check. There is no maximum version and no
 * force/ignore override (Pi adapter contract): prereleases fail closed rather than
 * being coerced into the supported range.
 */
export function isSupportedHostVersion(version: string): boolean {
  const parsed = parseSemver(version);
  if (parsed.isErr()) return false;
  if (parsed.value.prerelease !== undefined) return false;
  return compareCore(parsed.value, FLOOR) >= 0;
}

/**
 * Verifies exact host identity and version range. Pure and read-only: does
 * not resolve, read, or spawn anything itself.
 */
export function checkHostCompatibility(
  info: HostPackageInfo | undefined,
): ResultType<HostPackageInfo, PiAdapterFailure> {
  if (info === undefined) {
    return err(makeHostIdentityUnknownFailure("missing-host-package-info"));
  }
  const parsed = parseHostPackageInfo(info);
  if (parsed.isErr()) {
    return err(makeHostIdentityUnknownFailure("host-package-malformed"));
  }
  if (parsed.value.name !== HOST_PACKAGE_NAME) {
    return err(makeHostIdentityUnknownFailure("unexpected-package-name"));
  }
  if (!isSupportedHostVersion(parsed.value.version)) {
    return err(
      makeHostVersionUnsupportedFailure(
        parsed.value.version,
        "outside-supported-range",
      ),
    );
  }
  return ok(parsed.value);
}

/**
 * Placeholder used when the host package could not be read at all, so a
 * diagnostic still names a version field instead of omitting it.
 */
export const UNKNOWN_HOST_VERSION = "unknown";

/** How one missing host capability degrades the adapter (Spec 33 §16). */
export type HostCapabilityGapMode =
  | "health-only"
  | "custom-editor-fallback"
  | "feature-unavailable";

/**
 * The strong-debug diagnostic shape for a missing host capability. Every
 * field is required, so a diagnostic can never omit the capability, the host
 * version, the contract, the probe result, the resulting mode, or the
 * remediation.
 */
export interface HostCapabilityGapDiagnostic {
  readonly capability: string;
  readonly hostVersion: string;
  readonly contract: string;
  readonly probeResult: string;
  readonly mode: HostCapabilityGapMode;
  readonly remediation: string;
}

/** Renders one diagnostic as a single plain, secret-free line. */
export function renderHostCapabilityGapDiagnostic(
  diagnostic: HostCapabilityGapDiagnostic,
): string {
  return [
    `capability: ${diagnostic.capability}`,
    `host version: ${diagnostic.hostVersion} (supported >=${HOST_VERSION_FLOOR}, no maximum)`,
    `contract: ${diagnostic.contract}`,
    `probe: ${diagnostic.probeResult}`,
    `mode: ${diagnostic.mode}`,
    `remediation: ${diagnostic.remediation}`,
  ].join("; ");
}

/** Read-only source of the installed host package's identity/version. */
export interface HostPackageReader {
  read(): ResultAsync<HostPackageInfo, PiAdapterFailure>;
}

/**
 * Production reader: obtains the host version from Pi's public root module.
 * Pi exposes that exact module through its extension loader even when the
 * peer package is absent from the extension's own node_modules tree.
 */
/** Closed diagnostic type for an imported VERSION that disagrees with the proven host. */
export const HOST_RUNTIME_DUPLICATE_REASON = "host-runtime-duplicate" as const;

const MAX_REPORTED_HOST_VERSION_LENGTH = 64;
/**
 * The health line can never truthfully report more redirects than the closed
 * host-module set has members: three package entries plus the codex provider
 * subpath. Kept as a literal so this module never imports the redirect
 * planner, and asserted against it in the tests.
 */
const MAX_REPORTED_REDIRECTED_COUNT = 4;

/**
 * Duplicate host-runtime detection is warning-only. It must not enter
 * health-only mode: a VERSION mismatch removes no declared capability, and
 * health-only would break users mid-upgrade while two copies still exist.
 */
export interface HostRuntimeDuplicateDiagnostic {
  readonly type: typeof HOST_RUNTIME_DUPLICATE_REASON;
  readonly importedVersion: string;
  readonly provenVersion: string;
  readonly mode: "warning";
}

export interface ReportedHostIdentity {
  readonly version: string;
  readonly diagnostic: HostRuntimeDuplicateDiagnostic | undefined;
}

export interface BunHostPackageReaderOptions {
  readonly importedVersion?: string;
  readonly provenVersion?: string;
  readonly onDuplicateDiagnostic?: (
    diagnostic: HostRuntimeDuplicateDiagnostic,
  ) => void;
}

function boundReportedHostVersion(value: string): string {
  if (value.length <= MAX_REPORTED_HOST_VERSION_LENGTH) return value;
  return value.slice(0, MAX_REPORTED_HOST_VERSION_LENGTH);
}

function boundRedirectedCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_REPORTED_REDIRECTED_COUNT);
}

/**
 * Cross-check the imported host `VERSION` against the proven host package
 * version. The proven value wins on mismatch. The diagnostic is a warning;
 * callers must not map it to health-only mode.
 */
export function resolveReportedHostIdentity(input: {
  readonly importedVersion: string;
  readonly provenVersion?: string;
}): ReportedHostIdentity {
  const importedVersion = boundReportedHostVersion(input.importedVersion);
  if (input.provenVersion === undefined) {
    return { version: importedVersion, diagnostic: undefined };
  }
  const provenVersion = boundReportedHostVersion(input.provenVersion);
  if (provenVersion === importedVersion) {
    return { version: provenVersion, diagnostic: undefined };
  }
  return {
    version: provenVersion,
    diagnostic: {
      type: HOST_RUNTIME_DUPLICATE_REASON,
      importedVersion,
      provenVersion,
      mode: "warning",
    },
  };
}

/** Path-free `/weave:health` line for the host-module outcome. */
export function renderHostRuntimeHealthLine(input: {
  readonly importedVersion: string;
  readonly provenVersion?: string;
  readonly redirectedCount: number;
}): string {
  const redirected = boundRedirectedCount(input.redirectedCount);
  const identity = resolveReportedHostIdentity(input);
  if (identity.diagnostic === undefined) {
    return `host runtime: single-copy; redirected ${redirected}`;
  }
  return `host runtime: duplicate-detected (${identity.diagnostic.type}); redirected ${redirected}`;
}

/** Health line from the recorded loader outcome and the imported `VERSION`. */
export function hostRuntimeHealthLineFromOutcome(
  outcome:
    | {
        readonly hostVersion?: string;
        readonly redirected: readonly string[];
      }
    | undefined,
): string {
  return renderHostRuntimeHealthLine({
    importedVersion: PI_HOST_VERSION,
    provenVersion: outcome?.hostVersion,
    redirectedCount: outcome?.redirected.length ?? 0,
  });
}

/** Path-free identity health is rendered beside host-module health. */
export function renderExtensionIdentityHealthLine(
  health: ExtensionBuildIdentityHealth,
): string {
  return renderExtensionBuildIdentityHealthLine(health);
}

export class BunHostPackageReader implements HostPackageReader {
  private recordedDuplicate: HostRuntimeDuplicateDiagnostic | undefined;

  constructor(private readonly options: BunHostPackageReaderOptions = {}) {}

  /** Last `host-runtime-duplicate` diagnostic recorded by `read`, if any. */
  duplicateDiagnostic(): HostRuntimeDuplicateDiagnostic | undefined {
    return this.recordedDuplicate;
  }

  read(): ResultAsync<HostPackageInfo, PiAdapterFailure> {
    const identity = resolveReportedHostIdentity({
      importedVersion: this.options.importedVersion ?? PI_HOST_VERSION,
      provenVersion: this.options.provenVersion,
    });
    this.recordedDuplicate = identity.diagnostic;
    if (identity.diagnostic !== undefined) {
      this.options.onDuplicateDiagnostic?.(identity.diagnostic);
    }
    const parsed = HostPackageInfoSchema.safeParse({
      name: HOST_PACKAGE_NAME,
      version: identity.version,
    });
    if (!parsed.success) {
      return errAsync(makeHostIdentityUnknownFailure("host-package-malformed"));
    }
    return okAsync(parsed.data);
  }
}
