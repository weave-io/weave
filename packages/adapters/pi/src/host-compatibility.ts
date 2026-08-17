import { VERSION as PI_HOST_VERSION } from "@earendil-works/pi-coding-agent";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import { z } from "zod";
import {
  makeHostIdentityUnknownFailure,
  makeHostVersionUnsupportedFailure,
  type PiAdapterFailure,
} from "./errors.js";

/** The one compatible host package. Upstream `@mariozechner/pi-coding-agent` is a different identity. */
export const HOST_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** Inclusive floor of the supported host version range (Pi adapter contract). */
export const HOST_VERSION_FLOOR = "0.81.1";

export const HostPackageInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});
export type HostPackageInfo = z.infer<typeof HostPackageInfoSchema>;

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
}

const SEMVER_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(version: string): Result<ParsedVersion, void> {
  const match = SEMVER_PATTERN.exec(version);
  if (match === null) return err(undefined);
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
): Result<HostPackageInfo, PiAdapterFailure> {
  if (info === undefined) {
    return err(makeHostIdentityUnknownFailure("missing-host-package-info"));
  }
  if (info.name !== HOST_PACKAGE_NAME) {
    return err(makeHostIdentityUnknownFailure("unexpected-package-name"));
  }
  if (!isSupportedHostVersion(info.version)) {
    return err(
      makeHostVersionUnsupportedFailure(
        info.version,
        "outside-supported-range",
      ),
    );
  }
  return ok(info);
}

/**
 * Placeholder used when the host package could not be read at all, so a
 * diagnostic still names a version field instead of omitting it.
 */
export const UNKNOWN_HOST_VERSION = "unknown";

/** How one missing host capability degrades the adapter (Spec 33 §16). */
export type HostCapabilityGapMode = "health-only" | "custom-editor-fallback";

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
const MAX_REPORTED_REDIRECTED_COUNT = 3;

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
        readonly redirected: readonly unknown[];
      }
    | undefined,
): string {
  return renderHostRuntimeHealthLine({
    importedVersion: PI_HOST_VERSION,
    provenVersion: outcome?.hostVersion,
    redirectedCount: outcome?.redirected.length ?? 0,
  });
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
