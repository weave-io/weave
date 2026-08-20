import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import { runBoundedCommand } from "./command-runner.js";
import {
  ADAPTER_SOURCE_PROVEN_ENV,
  DEFAULT_COMMAND_TIMEOUT_MS,
  EXACT_PI_VERSION,
  EXPECTED_EXTENSION_SHA_ENV,
  EXPECTED_PACKAGE_ROOT_ENV,
  EXPECTED_PACKAGE_VERSION_ENV,
  FORBIDDEN_ENV_KEY_PATTERN,
  FORBIDDEN_PI_WEAVE_ENV_PATTERN,
  FORBIDDEN_RUNTIME_ENV_KEYS,
  failure,
  MAX_COMMAND_TIMEOUT_MS,
  PACKAGE_VERSION,
  PI_AGENT_DIR_ENV,
  PI_SESSION_DIR_ENV,
  SAFE_PATH_PREFIXES,
  SAFE_RUNTIME_ENV_KEYS,
  SAFE_SYSTEM_PATH,
  SHA256,
  SMOKE_CASES,
  type SmokeCase,
  type SmokeCliArgs,
  type SmokeFailure,
  safeDiagnostic,
  UNSAFE_PROVENANCE_ENV,
  XDG_CACHE_ENV,
  XDG_CONFIG_ENV,
  XDG_DATA_ENV,
  XDG_STATE_ENV,
} from "./contract.js";
export function isEphemeralPath(path: string): boolean {
  const absolute = resolve(path);
  const temp = resolve(tmpdir());
  if (absolute === temp || absolute.startsWith(`${temp}/`)) return true;
  return SAFE_PATH_PREFIXES.some((prefix) => absolute.startsWith(prefix));
}

export function containsPathControlCharacter(path: string): boolean {
  return path.split("").some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 0x20 || code === 0x7f);
  });
}

export function validateEphemeralReportPath(
  path: string,
): Result<string, SmokeFailure> {
  if (
    !path ||
    containsPathControlCharacter(path) ||
    !isAbsolute(path) ||
    !isEphemeralPath(path)
  ) {
    return err(
      failure(
        "InvalidReportPath",
        "report must be an absolute path below the operating-system temporary directory",
      ),
    );
  }
  return ok(resolve(path));
}

/** Reject symlink escapes before the report writer opens a staging file. */
export async function validateReportTargetPath(
  path: string,
): Promise<Result<string, SmokeFailure>> {
  const lexical = validateEphemeralReportPath(path);
  if (lexical.isErr()) return err(lexical.error);
  const target = lexical.value;
  const parentSymlink = await hasSymlinkAncestor(target);
  if (parentSymlink.isErr() || parentSymlink.value)
    return err(
      failure(
        "InvalidReportPath",
        "report path has a symlinked parent outside the temporary root",
      ),
    );
  const targetSymlink = await pathIsSymlink(target);
  if (targetSymlink.isErr() || targetSymlink.value)
    return err(
      failure("InvalidReportPath", "report path must not be a symlink"),
    );
  return ok(target);
}
export function pathWithin(path: string, parent: string): boolean {
  const child = resolve(path);
  const root = resolve(parent);
  return child === root || child.startsWith(`${root}/`);
}

export function safeAbsolutePath(path: string): boolean {
  return isAbsolute(path) && !containsPathControlCharacter(path);
}

export interface IsolatedPathPolicyInput {
  readonly root: string;
  readonly paths: Readonly<Record<string, string>>;
  readonly forbiddenPaths?: readonly string[];
}

/**
 * Validate the lexical part of the disposable-root boundary before any
 * directory is created. Realpath checks are repeated after creation, so a
 * symlink cannot turn a valid-looking path into a developer-owned path.
 */
export function validateIsolatedPathPolicy(
  input: IsolatedPathPolicyInput,
): Result<Readonly<Record<string, string>>, SmokeFailure> {
  if (!safeAbsolutePath(input.root) || !isEphemeralPath(input.root))
    return err(
      failure(
        "PathIsolationViolation",
        "the smoke root must be an absolute temporary path",
      ),
    );
  const root = resolve(input.root);
  const entries = Object.entries(input.paths);
  const seen = new Set<string>([root]);
  for (const [name, path] of entries) {
    if (!safeAbsolutePath(path) || !pathWithin(path, root))
      return err(
        failure(
          "PathIsolationViolation",
          `${name} is outside the disposable smoke root`,
        ),
      );
    const normalized = resolve(path);
    if (seen.has(normalized))
      return err(
        failure("PathIsolationViolation", "isolated paths alias each other"),
      );
    seen.add(normalized);
  }
  for (const forbidden of input.forbiddenPaths ?? []) {
    if (!safeAbsolutePath(forbidden)) continue;
    for (const [name, path] of entries) {
      if (pathWithin(path, forbidden))
        return err(
          failure(
            "PathIsolationViolation",
            `${name} aliases a forbidden developer path`,
          ),
        );
    }
  }
  return ok({ ...input.paths });
}

export async function canonicalExistingPath(
  path: string,
): Promise<Result<string, SmokeFailure>> {
  if (!safeAbsolutePath(path))
    return err(
      failure("PathIsolationViolation", "isolated path is not absolute"),
    );
  const executable = Bun.which("realpath") ?? "/bin/realpath";
  const result = await runBoundedCommand([executable, path], {
    cwd: tmpdir(),
    env: { PATH: SAFE_SYSTEM_PATH },
    timeoutMs: 2_000,
  });
  if (result.isErr() || result.value.stdout.trim().includes("\n"))
    return err(
      failure(
        "PathIsolationViolation",
        "isolated path could not be canonicalized",
      ),
    );
  const canonical = result.value.stdout.trim();
  if (!safeAbsolutePath(canonical))
    return err(
      failure("PathIsolationViolation", "canonical isolated path is invalid"),
    );
  return ok(resolve(canonical));
}

/**
 * Repeat the disposable-root check after paths exist. This catches a
 * symlinked parent or package directory that lexical checks cannot see.
 */
export async function validateCreatedIsolatedPathPolicy(
  input: IsolatedPathPolicyInput,
): Promise<Result<Readonly<Record<string, string>>, SmokeFailure>> {
  const lexical = validateIsolatedPathPolicy(input);
  if (lexical.isErr()) return err(lexical.error);
  const root = await canonicalExistingPath(input.root);
  if (root.isErr()) return err(root.error);
  const seen = new Set<string>([root.value]);
  const canonicalEntries = new Map<string, string>();
  for (const [name, path] of Object.entries(input.paths)) {
    const canonical = await canonicalExistingPath(path);
    if (canonical.isErr()) return err(canonical.error);
    if (!pathWithin(canonical.value, root.value))
      return err(
        failure(
          "PathIsolationViolation",
          `${name} resolves outside the disposable smoke root`,
        ),
      );
    if (seen.has(canonical.value))
      return err(
        failure("PathIsolationViolation", "isolated paths resolve to aliases"),
      );
    seen.add(canonical.value);
    canonicalEntries.set(name, canonical.value);
  }
  for (const forbidden of input.forbiddenPaths ?? []) {
    if (!safeAbsolutePath(forbidden)) continue;
    const exists = await ResultAsync.fromThrowable(
      () => Bun.file(forbidden).exists(),
      () => false,
    )();
    if (exists.isErr() || !exists.value) continue;
    const canonicalForbidden = await canonicalExistingPath(forbidden);
    if (canonicalForbidden.isErr()) return err(canonicalForbidden.error);
    for (const [name, canonical] of canonicalEntries) {
      if (pathWithin(canonical, canonicalForbidden.value))
        return err(
          failure(
            "PathIsolationViolation",
            `${name} resolves to a forbidden developer path`,
          ),
        );
    }
  }
  return ok({ ...input.paths });
}

function isForbiddenInheritedEnvironmentKey(key: string): boolean {
  if (FORBIDDEN_RUNTIME_ENV_KEYS.has(key)) return true;
  if (FORBIDDEN_ENV_KEY_PATTERN.test(key)) return true;
  return FORBIDDEN_PI_WEAVE_ENV_PATTERN.test(key);
}

export function validateStrictProvenanceEnvironment(
  env: Readonly<Record<string, string>>,
): Result<Readonly<Record<string, string>>, SmokeFailure> {
  if (env[UNSAFE_PROVENANCE_ENV] !== undefined) {
    return err(
      failure(
        "StrictProvenanceViolation",
        `${UNSAFE_PROVENANCE_ENV} must be absent`,
      ),
    );
  }
  const requiredPaths = [
    "HOME",
    XDG_CONFIG_ENV,
    XDG_DATA_ENV,
    XDG_CACHE_ENV,
    XDG_STATE_ENV,
    PI_AGENT_DIR_ENV,
    PI_SESSION_DIR_ENV,
    "PI_MODEL_SMOKE_CAPTURE_DIR",
    EXPECTED_PACKAGE_ROOT_ENV,
  ];
  for (const key of requiredPaths) {
    const value = env[key];
    if (value === undefined || !safeAbsolutePath(value))
      return err(
        failure(
          "StrictProvenanceViolation",
          `isolated environment value ${key} is missing`,
        ),
      );
  }
  if (!SHA256.test(env[EXPECTED_EXTENSION_SHA_ENV] ?? ""))
    return err(
      failure(
        "StrictProvenanceViolation",
        "isolated adapter extension digest is missing",
      ),
    );
  if (env[EXPECTED_PACKAGE_VERSION_ENV] !== PACKAGE_VERSION)
    return err(
      failure(
        "StrictProvenanceViolation",
        "isolated adapter version is invalid",
      ),
    );
  if (env[ADAPTER_SOURCE_PROVEN_ENV] !== "1")
    return err(
      failure(
        "StrictProvenanceViolation",
        "adapter source proof is not enabled",
      ),
    );
  for (const [key, value] of Object.entries(env)) {
    if (value.length === 0 && key !== "PATH")
      return err(
        failure(
          "StrictProvenanceViolation",
          "isolated environment has an empty value",
        ),
      );
    const isPiOrWeaveKey = /^(?:PI|WEAVE)_/iu.test(key);
    if (
      !SAFE_RUNTIME_ENV_KEYS.has(key) &&
      (isForbiddenInheritedEnvironmentKey(key) || isPiOrWeaveKey)
    )
      return err(
        failure(
          "StrictProvenanceViolation",
          "inherited Pi, Weave, or credential environment is present",
        ),
      );
  }
  const distinctPaths = [
    env.HOME,
    env[XDG_CONFIG_ENV],
    env[XDG_DATA_ENV],
    env[XDG_CACHE_ENV],
    env[XDG_STATE_ENV],
    env[PI_AGENT_DIR_ENV],
    env[PI_SESSION_DIR_ENV],
    env.PI_MODEL_SMOKE_CAPTURE_DIR,
  ];
  if (new Set(distinctPaths).size !== distinctPaths.length)
    return err(
      failure("PathIsolationViolation", "isolated home paths alias each other"),
    );
  return ok({ ...env });
}

export function validateExpectedPiVersion(
  expected: string,
): Result<typeof EXACT_PI_VERSION, SmokeFailure> {
  if (expected !== EXACT_PI_VERSION)
    return err(
      failure(
        "WrongExpectedPiVersion",
        `only ${EXACT_PI_VERSION} is supported`,
      ),
    );
  return ok(EXACT_PI_VERSION);
}

export function buildPiLaunchCommand(input: {
  readonly bunCli: string;
  readonly piCli: string;
  readonly launcher?: string;
}): readonly string[] {
  return input.launcher === undefined
    ? [input.bunCli, input.piCli, "--offline"]
    : [input.launcher, "--offline"];
}

/** Compatibility alias used by release callers and focused tests. */
export const buildPiCommand = buildPiLaunchCommand;

export function buildExpectDriver(input: {
  readonly command: readonly string[];
  readonly doneMarker: string;
  /** Legacy startup synchronization. It has no synthetic default. */
  readonly readyMarker?: string;
  /** A real TUI command to run before the smoke task. */
  readonly healthCommand?: string;
  readonly healthMarker?: string;
  readonly task: string;
  readonly timeoutSeconds: number;
}): string {
  const quote = (value: string): string =>
    value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const shellQuote = (value: string): string =>
    `'${value.replaceAll("'", "'\\\\''")}'`;
  const command = input.command.map(shellQuote).join(" ");
  const lines = [
    `set timeout ${Math.max(1, Math.floor(input.timeoutSeconds))}`,
    "log_user 1",
    `spawn /bin/sh -c "exec ${command}"`,
  ];
  if (input.readyMarker !== undefined) {
    lines.push(
      "expect {",
      `  -re "${quote(input.readyMarker)}" {}`,
      `  timeout { send "\\003"; exit 124 }`,
      "}",
    );
  }
  if (input.healthCommand !== undefined) {
    lines.push(
      `send "${quote(input.healthCommand)}\\r"`,
      "expect {",
      `  -re "${quote(input.healthMarker ?? "Weave adapter mode: (ready|health-only)")}" {}`,
      `  timeout { send "\\003"; exit 124 }`,
      "}",
    );
  }
  lines.push(
    `send "${quote(input.task)}\\r"`,
    "expect {",
    `  -re "${quote(input.doneMarker)}" { send "/quit\\r" }`,
    `  timeout { send "\\003"; exit 124 }`,
    "}",
    "expect eof",
    "catch wait result",
    "exit [lindex $result 3]",
    "",
  );
  return lines.join("\n");
}

export function parseSmokeArgs(
  argv: readonly string[],
): Result<SmokeCliArgs, SmokeFailure> {
  let artifact = "";
  let expectedArtifactSha256 = "";
  let expectedPiVersion: string = EXACT_PI_VERSION;
  let smokeCase: SmokeCase = "all";
  let reportPath = "";
  let timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--artifact" && value !== undefined) {
      artifact = value;
      index += 1;
    } else if (
      (key === "--artifact-sha256" ||
        key === "--expected-artifact-sha256" ||
        key === "--expected-adapter-sha256") &&
      value !== undefined
    ) {
      expectedArtifactSha256 = value;
      index += 1;
    } else if (key === "--expected-pi-version" && value !== undefined) {
      expectedPiVersion = value;
      index += 1;
    } else if (key === "--case" && value !== undefined) {
      if (!(SMOKE_CASES as readonly string[]).includes(value))
        return err(
          failure("InvalidInvocation", `unknown case ${safeDiagnostic(value)}`),
        );
      smokeCase = value as SmokeCase;
      index += 1;
    } else if (key === "--report" && value !== undefined) {
      reportPath = value;
      index += 1;
    } else if (key === "--timeout-ms" && value !== undefined) {
      const parsed = Number(value);
      if (
        !Number.isInteger(parsed) ||
        parsed < 1 ||
        parsed > MAX_COMMAND_TIMEOUT_MS
      )
        return err(
          failure("InvalidInvocation", "timeout is outside the bounded range"),
        );
      timeoutMs = parsed;
      index += 1;
    } else {
      return err(
        failure(
          "InvalidInvocation",
          `unknown or incomplete argument ${safeDiagnostic(key ?? "")}`,
        ),
      );
    }
  }

  if (!artifact || !expectedArtifactSha256 || !reportPath) {
    return err(
      failure(
        "InvalidInvocation",
        "usage: --artifact <packed-tarball> --artifact-sha256 <sha256> --expected-pi-version 0.84.2 --case <fallback|rollback|all> --report <ephemeral-path>",
      ),
    );
  }
  if (!safeAbsolutePath(artifact) || !artifact.endsWith(".tgz"))
    return err(
      failure(
        "InvalidInvocation",
        "artifact must be an absolute packed .tgz path",
      ),
    );
  if (!SHA256.test(expectedArtifactSha256))
    return err(failure("InvalidInvocation", "artifact digest must be sha256"));
  const version = validateExpectedPiVersion(expectedPiVersion);
  if (version.isErr()) return err(version.error);
  const report = validateEphemeralReportPath(reportPath);
  if (report.isErr()) return err(report.error);
  return ok({
    artifact,
    expectedArtifactSha256,
    expectedPiVersion: version.value,
    smokeCase,
    reportPath: report.value,
    timeoutMs,
  });
}
export const readlinkExecutable = (): string =>
  Bun.which("readlink") ??
  (process.platform === "win32" ? "" : "/bin/readlink");

export async function pathIsSymlink(
  path: string,
): Promise<Result<boolean, SmokeFailure>> {
  const executable = readlinkExecutable();
  if (!executable)
    return err(
      failure("ArtifactSourceRejected", "symlink inspection is unavailable"),
    );
  const result = await runBoundedCommand([executable, path], {
    cwd: tmpdir(),
    env: { PATH: SAFE_SYSTEM_PATH },
    timeoutMs: 2_000,
    allowExitCodes: [1],
  });
  if (result.isErr()) return err(result.error);
  return ok(result.value.code === 0);
}

const ALLOWED_SYSTEM_SYMLINKS = new Set([
  "/tmp",
  "/private",
  "/private/tmp",
  "/var",
]);

export async function hasSymlinkAncestor(
  path: string,
): Promise<Result<boolean, SmokeFailure>> {
  let current = dirname(resolve(path));
  while (current !== "/") {
    if (!ALLOWED_SYSTEM_SYMLINKS.has(current)) {
      const symlink = await pathIsSymlink(current);
      if (symlink.isErr()) return err(symlink.error);
      if (symlink.value) return ok(true);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ok(false);
}

export async function regularNonSymlinkFile(
  path: string,
  missing: SmokeFailure["type"],
  rejected:
    | "ArtifactSourceRejected"
    | "StrictProvenanceViolation" = "ArtifactSourceRejected",
): Promise<Result<void, SmokeFailure>> {
  const symlink = await pathIsSymlink(path);
  if (symlink.isErr()) return err(symlink.error);
  if (symlink.value)
    return err(failure(rejected, "symlink artifact paths are forbidden"));
  const stats = await ResultAsync.fromThrowable(
    () => Bun.file(path).stat(),
    () => failure(missing, "artifact does not exist"),
  )();
  if (stats.isErr()) return err(stats.error);
  if (!stats.value.isFile())
    return err(failure(rejected, "artifact must be a regular file"));
  return ok(undefined);
}
