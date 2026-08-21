import { isAbsolute, join } from "node:path";
import { err, ok, Result } from "neverthrow";
import { EXTENSION_BUILD_IDENTITY_PROOF_ENV } from "../../packages/adapters/pi/src/extension-build-identity.js";
import {
  blocked,
  type IdentityProbeIsolationPaths,
  type VerifyChildStreamingFailure,
} from "./child-stream-verify-types.js";

const MAX_IDENTITY_PROBE_ENV_VALUE_CHARS = 4_096;
const IDENTITY_PROBE_LOCALE = "C.UTF-8";

/**
 * Environment names that may reach the fresh Pi identity process.
 *
 * This is deliberately a positive list. The child receives no ambient
 * environment, including no user configuration, credentials, loader hooks, or
 * dynamic-library paths. HOME/XDG/Pi paths are replaced with the per-probe
 * temporary paths below; PATH and BUN_INSTALL preserve the requested Pi/Bun
 * executable resolution.
 */
export const IDENTITY_PROBE_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "BUN_INSTALL",
  "VOLTA_HOME",
  "HOME",
  "USERPROFILE",
  "PI_CODING_AGENT_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  EXTENSION_BUILD_IDENTITY_PROOF_ENV,
] as const);

function boundedIdentityProbeEnvironmentValue(
  value: unknown,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTITY_PROBE_ENV_VALUE_CHARS
  ) {
    return undefined;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return value;
}

function readIdentityProbeEnvironmentValue(
  source: Readonly<Record<string, unknown>>,
  name: string,
  required: boolean,
): Result<string | undefined, VerifyChildStreamingFailure> {
  const descriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(source, name),
    () => blocked("probe-failed"),
  )();
  if (descriptor.isErr()) return err(descriptor.error);
  if (descriptor.value === undefined) {
    return required ? err(blocked("probe-failed")) : ok(undefined);
  }
  if (!("value" in descriptor.value)) return err(blocked("probe-failed"));
  const value = boundedIdentityProbeEnvironmentValue(descriptor.value.value);
  if (value === undefined) return err(blocked("probe-failed"));
  return ok(value);
}

export function identityProbeIsolationPaths(
  root: string,
): Result<IdentityProbeIsolationPaths, VerifyChildStreamingFailure> {
  const boundedRoot = boundedIdentityProbeEnvironmentValue(root);
  if (boundedRoot === undefined || !isAbsolute(boundedRoot)) {
    return err(blocked("probe-failed"));
  }
  const paths = {
    root: boundedRoot,
    home: join(boundedRoot, "home"),
    agent: join(boundedRoot, "pi-agent"),
    config: join(boundedRoot, "xdg-config"),
    data: join(boundedRoot, "xdg-data"),
    cache: join(boundedRoot, "xdg-cache"),
    temporary: join(boundedRoot, "tmp"),
  };
  if (
    Object.values(paths).some(
      (path) => boundedIdentityProbeEnvironmentValue(path) === undefined,
    )
  ) {
    return err(blocked("probe-failed"));
  }
  return ok(paths);
}

/**
 * Build the identity child environment without enumerating or copying the
 * caller's environment. The parent runtime values are read through own data
 * descriptors, so accessors and hostile proxies fail closed without running.
 */
export function buildIdentityProbeEnvironment(
  source: Readonly<Record<string, unknown>>,
  isolationRoot: string,
): Result<Record<string, string>, VerifyChildStreamingFailure> {
  const path = readIdentityProbeEnvironmentValue(source, "PATH", true);
  if (path.isErr()) return err(path.error);
  if (path.value === undefined) return err(blocked("probe-failed"));
  const bunInstall = readIdentityProbeEnvironmentValue(
    source,
    "BUN_INSTALL",
    true,
  );
  if (bunInstall.isErr()) return err(bunInstall.error);
  if (bunInstall.value === undefined) return err(blocked("probe-failed"));
  const voltaHome = readIdentityProbeEnvironmentValue(
    source,
    "VOLTA_HOME",
    false,
  );
  if (voltaHome.isErr()) return err(voltaHome.error);
  const isolated = identityProbeIsolationPaths(isolationRoot);
  if (isolated.isErr()) return err(isolated.error);

  const env: Record<string, string> = {
    PATH: path.value,
    BUN_INSTALL: bunInstall.value,
    HOME: isolated.value.home,
    USERPROFILE: isolated.value.home,
    PI_CODING_AGENT_DIR: isolated.value.agent,
    XDG_CONFIG_HOME: isolated.value.config,
    XDG_DATA_HOME: isolated.value.data,
    XDG_CACHE_HOME: isolated.value.cache,
    TMPDIR: isolated.value.temporary,
    TMP: isolated.value.temporary,
    TEMP: isolated.value.temporary,
    LANG: IDENTITY_PROBE_LOCALE,
    LC_ALL: IDENTITY_PROBE_LOCALE,
    [EXTENSION_BUILD_IDENTITY_PROOF_ENV]: "1",
  };
  if (voltaHome.value !== undefined) env.VOLTA_HOME = voltaHome.value;
  return ok(env);
}
