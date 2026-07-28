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

/** Read-only source of the installed host package's identity/version. */
export interface HostPackageReader {
  read(): ResultAsync<HostPackageInfo, PiAdapterFailure>;
}

/**
 * Production reader: obtains the host version from Pi's public root module.
 * Pi exposes that exact module through its extension loader even when the
 * peer package is absent from the extension's own node_modules tree.
 */
export class BunHostPackageReader implements HostPackageReader {
  read(): ResultAsync<HostPackageInfo, PiAdapterFailure> {
    const parsed = HostPackageInfoSchema.safeParse({
      name: HOST_PACKAGE_NAME,
      version: PI_HOST_VERSION,
    });
    if (!parsed.success) {
      return errAsync(makeHostIdentityUnknownFailure("host-package-malformed"));
    }
    return okAsync(parsed.data);
  }
}
