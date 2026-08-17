/**
 * Real-process proof that a Bun-hosted Pi loads one copy of the three host
 * packages — the installed host's — when Weave's extension entry is attached.
 *
 * Adapter package tests must never spawn a harness. This script is the
 * real-process seam: it starts `pi --mode rpc`, reads the opt-in proof
 * line, inspects OS mappings, and repeats with the redirect disabled so
 * the detector must see the duplicate.
 */
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { logger } from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  MAX_HOST_MODULE_PROOF_LINE_LENGTH,
  type PiHostModuleProofLineSpecifier,
  WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT_ENV,
  WEAVE_PI_HOST_MODULE_PROOF_ENV,
} from "../../packages/adapters/pi/src/host-module-loader.js";

const log = logger.child({ module: "verify-pi-host-singleton" });

export const HOST_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_HOST_CLI_ENV = "PI_HOST_CLI";
export const ALLOW_SKIP_FLAG = "--allow-skip";

const EXTENSION_RELATIVE_PATH = join(
  "packages",
  "adapters",
  "pi",
  "dist",
  "extension.js",
);
const HOST_BUILD_COMMAND = [
  "bun",
  "run",
  "--filter",
  "@weaveio/weave-adapter-pi",
  "build",
] as const;

const CHILD_ENV_OMIT = [
  "WEAVE_CHILD_SECRET",
  "WEAVE_CHILD_ID",
  "WEAVE_CONTROLLER_GENERATION",
  "WEAVE_CHILD_AGENT_NAME",
  "WEAVE_CHILD_DEPTH",
  "WEAVE_CHILD_PARENT_ID",
  WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT_ENV,
  "PI_CODING_AGENT_DIR",
] as const;

const CHECKOUT_COPY_MARKERS = [
  "node_modules/@earendil-works/pi-coding-agent",
  "node_modules/@earendil-works/pi-ai",
  "node_modules/@earendil-works/pi-tui",
  "node_modules/.bun/@earendil-works+pi-coding-agent@",
  "node_modules/.bun/@earendil-works+pi-ai@",
  "node_modules/.bun/@earendil-works+pi-tui@",
] as const;

export const PROOF_WAIT_MS = 20_000;
export const MAPPING_SETTLE_MS = 5_000;
export const KILL_WAIT_MS = 2_000;
const MAX_CAPTURED_OUTPUT_CHARS = 65_536;
const MAX_ERROR_OUTPUT_CHARS = 2_048;
const HOST_PACKAGE_SUFFIX = "/@earendil-works/pi-coding-agent";

const EXPECTED_HOST_PACKAGE_JSON = join(
  "install",
  "global",
  "node_modules",
  HOST_PACKAGE_NAME,
  "package.json",
);

export type VerifyArgs = {
  readonly allowSkip: boolean;
};

export type HostPresence =
  | { readonly status: "missing"; readonly reason: string }
  | { readonly status: "invalid"; readonly reason: string }
  | {
      readonly status: "found";
      readonly cliPath: string;
      readonly hostRoot: string;
      readonly hostVersion: string;
    };

export type SkipDecision =
  | { readonly action: "skip"; readonly reason: string }
  | { readonly action: "fail"; readonly reason: string }
  | { readonly action: "run" };

export type ParsedHostModuleProof = {
  readonly hostRoot?: string;
  readonly hostVersion?: string;
  readonly specifiers: readonly PiHostModuleProofLineSpecifier[];
};

export type MappedPathClassification = {
  readonly checkoutEarendilPaths: readonly string[];
  readonly nativePackageRoots: readonly string[];
};

export type SingletonVerdict =
  | "single-copy"
  | "duplicate"
  | "redirect-not-observed"
  | "host-version-mismatch"
  | "loaded-from-outside-host"
  | "checkout-earendil-mapped"
  | "multiple-native-package-roots"
  | "proof-incomplete";

export type SingletonEvaluation = {
  readonly verdict: SingletonVerdict;
  readonly reasons: readonly string[];
};

export type VerifySuccess =
  | { readonly kind: "skip"; readonly reason: string }
  | {
      readonly kind: "pass";
      readonly artifactSha256: string;
      readonly hostVersion: string;
      readonly hostRoot: string;
      readonly positive: "single-copy";
      readonly negative: "duplicate-detected";
    };

export type VerifyFailure = {
  readonly type:
    | "InvalidArgs"
    | "HostMissing"
    | "HostInvalid"
    | "ExtensionMissing"
    | "BuildFailed"
    | "SpawnFailed"
    | "ProofTimeout"
    | "ProofMissing"
    | "ProofInvalid"
    | "PositiveFailed"
    | "NegativeNotDistinguished"
    | "CleanupFailed"
    | "Unexpected";
  readonly message: string;
  readonly artifactSha256?: string;
  readonly hostVersion?: string;
  readonly positive?: string;
  readonly negative?: string;
};

export type VerifyEnv = Readonly<Record<string, string | undefined>>;

/**
 * Parse CLI flags. Only `--allow-skip` is recognized; anything else fails
 * closed so a mistyped invocation cannot silently skip the host check.
 */
export function parseVerifyArgs(
  argv: readonly string[],
): Result<VerifyArgs, VerifyFailure> {
  let allowSkip = false;
  for (const arg of argv) {
    if (arg === ALLOW_SKIP_FLAG) {
      allowSkip = true;
      continue;
    }
    return err({
      type: "InvalidArgs",
      message: `unknown argument: ${arg}`,
    });
  }
  return ok({ allowSkip });
}

/**
 * Missing host is skippable. A present CLI with a wrong or unreadable
 * package identity is always a failure.
 */
export function decideSkip(
  presence: HostPresence,
  allowSkip: boolean,
): SkipDecision {
  if (presence.status === "found") return { action: "run" };
  if (presence.status === "invalid") {
    return { action: "fail", reason: presence.reason };
  }
  if (allowSkip) return { action: "skip", reason: presence.reason };
  return { action: "fail", reason: presence.reason };
}

export function parseHostPackageIdentity(
  value: unknown,
): Result<
  { readonly name: string; readonly version: string },
  { readonly reason: "host-package-mismatch" }
> {
  if (typeof value !== "object" || value === null) {
    return err({ reason: "host-package-mismatch" });
  }
  if (!("name" in value) || !("version" in value)) {
    return err({ reason: "host-package-mismatch" });
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    return err({ reason: "host-package-mismatch" });
  }
  if (typeof value.version !== "string" || value.version.length === 0) {
    return err({ reason: "host-package-mismatch" });
  }
  return ok({ name: value.name, version: value.version });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProofSpecifier(
  value: unknown,
): Result<PiHostModuleProofLineSpecifier, VerifyFailure> {
  if (!isRecord(value)) {
    return err({
      type: "ProofInvalid",
      message: "specifier entry is not an object",
    });
  }
  if (typeof value.specifier !== "string" || value.specifier.length === 0) {
    return err({
      type: "ProofInvalid",
      message: "specifier entry is missing specifier",
    });
  }
  if (typeof value.redirected !== "boolean") {
    return err({
      type: "ProofInvalid",
      message: `specifier ${value.specifier} is missing redirected`,
    });
  }
  const bareResolution =
    typeof value.bareResolution === "string" ? value.bareResolution : undefined;
  const loadedFrom =
    typeof value.loadedFrom === "string" ? value.loadedFrom : undefined;
  return ok({
    specifier: value.specifier as PiHostModuleProofLineSpecifier["specifier"],
    redirected: value.redirected,
    ...(bareResolution === undefined ? {} : { bareResolution }),
    ...(loadedFrom === undefined ? {} : { loadedFrom }),
  });
}

/**
 * Parse one stderr line as the opt-in host-module proof payload.
 * Rejects multiline text, over-budget lines, and any JSON that is not
 * exactly the proof envelope.
 */
export function parseProofLine(
  line: string,
): Result<ParsedHostModuleProof, VerifyFailure> {
  if (line.includes("\n") || line.includes("\r")) {
    return err({
      type: "ProofInvalid",
      message: "proof line must be a single line",
    });
  }
  if (line.length === 0) {
    return err({ type: "ProofInvalid", message: "proof line is empty" });
  }
  if (line.length > MAX_HOST_MODULE_PROOF_LINE_LENGTH) {
    return err({
      type: "ProofInvalid",
      message: "proof line exceeds the bounded size",
    });
  }
  const parsed = Result.fromThrowable(
    () => JSON.parse(line) as unknown,
    (): VerifyFailure => ({
      type: "ProofInvalid",
      message: "proof line is not valid JSON",
    }),
  )();
  if (parsed.isErr()) return err(parsed.error);
  if (!isRecord(parsed.value) || !isRecord(parsed.value.weaveHostModuleProof)) {
    return err({
      type: "ProofInvalid",
      message: "JSON is not a weaveHostModuleProof line",
    });
  }
  const body = parsed.value.weaveHostModuleProof;
  if (!Array.isArray(body.specifiers)) {
    return err({
      type: "ProofInvalid",
      message: "proof specifiers must be an array",
    });
  }
  const specifiers: PiHostModuleProofLineSpecifier[] = [];
  for (const entry of body.specifiers) {
    const specifier = parseProofSpecifier(entry);
    if (specifier.isErr()) return err(specifier.error);
    specifiers.push(specifier.value);
  }
  const hostRoot =
    typeof body.hostRoot === "string" ? body.hostRoot : undefined;
  const hostVersion =
    typeof body.hostVersion === "string" ? body.hostVersion : undefined;
  return ok({
    ...(hostRoot === undefined ? {} : { hostRoot }),
    ...(hostVersion === undefined ? {} : { hostVersion }),
    specifiers,
  });
}

/** Scan captured stdout/stderr for the first valid proof line. */
export function extractProofLineFromOutput(
  output: string,
): Result<ParsedHostModuleProof, VerifyFailure> {
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("weaveHostModuleProof")) continue;
    const parsed = parseProofLine(line);
    if (parsed.isOk()) return parsed;
  }
  return err({
    type: "ProofMissing",
    message: "no weaveHostModuleProof line in process output",
  });
}

function stripLsofNameSuffix(raw: string): string {
  return raw
    .replace(/ \(deleted\)$/u, "")
    .replace(/ \(stat: .+\)$/u, "")
    .trim();
}

/** Parse `lsof -Fn` name records into absolute paths. */
export function parseLsofFnOutput(output: string): readonly string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("n/")) continue;
    const path = stripLsofNameSuffix(line.slice(1));
    if (path.startsWith("/")) paths.push(path);
  }
  return paths;
}

/** Parse default columnar `lsof` output; last field must be an absolute path. */
export function parseLsofDefaultOutput(output: string): readonly string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("COMMAND") || line.length === 0) continue;
    const parts = line.trim().split(/\s+/u);
    const last = parts[parts.length - 1];
    if (last?.startsWith("/")) {
      paths.push(stripLsofNameSuffix(last));
    }
  }
  return paths;
}

/** Parse `/proc/<pid>/maps` pathnames. */
export function parseLinuxMapsOutput(output: string): readonly string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/u);
    const path = parts[5];
    if (path === undefined || !path.startsWith("/")) continue;
    paths.push(stripLsofNameSuffix(parts.slice(5).join(" ")));
  }
  return paths;
}

export function withTrailingSlash(root: string): string {
  if (root.endsWith("/")) return root;
  return `${root}/`;
}

export function isPathInside(path: string, root: string): boolean {
  if (path === root) return true;
  return path.startsWith(withTrailingSlash(root));
}

/**
 * Directory that contains the host's three `@earendil-works` packages.
 * `pi-ai` and `pi-tui` are siblings of `pi-coding-agent`, not children.
 */
export function hostModulePrefix(hostRoot: string): string {
  if (hostRoot.endsWith(HOST_PACKAGE_SUFFIX)) {
    return hostRoot.slice(0, -"/pi-coding-agent".length);
  }
  return dirname(hostRoot);
}

export function isCheckoutEarendilPath(
  path: string,
  checkoutRoot: string,
): boolean {
  const nodeModules = `${withTrailingSlash(checkoutRoot)}node_modules/`;
  if (!path.startsWith(nodeModules)) return false;
  return (
    path.includes("/@earendil-works/") || path.includes("/@earendil-works+")
  );
}

export function nativePackageRootFromPath(path: string): string | undefined {
  if (!path.endsWith(".node")) return undefined;
  if (!path.includes("@earendil-works")) return undefined;
  const scoped = /^(.*\/node_modules\/@earendil-works\/[^/]+)/u.exec(path);
  return scoped?.[1];
}

export function classifyMappedPaths(input: {
  readonly paths: readonly string[];
  readonly checkoutRoot: string;
}): MappedPathClassification {
  const checkoutEarendilPaths: string[] = [];
  const nativeRoots = new Set<string>();
  for (const path of input.paths) {
    if (isCheckoutEarendilPath(path, input.checkoutRoot)) {
      checkoutEarendilPaths.push(path);
    }
    const nativeRoot = nativePackageRootFromPath(path);
    if (nativeRoot !== undefined) nativeRoots.add(nativeRoot);
  }
  return {
    checkoutEarendilPaths,
    nativePackageRoots: [...nativeRoots],
  };
}

export function isCheckoutHostCopyPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return CHECKOUT_COPY_MARKERS.some((marker) => normalized.includes(marker));
}

export function checkoutCopyExistsFromListing(
  relativePaths: readonly string[],
): boolean {
  return relativePaths.some(isCheckoutHostCopyPath);
}

export function evaluateSingletonProof(input: {
  readonly proof: ParsedHostModuleProof;
  readonly expectedHostVersion: string;
  readonly expectedHostRoot: string;
  readonly checkoutCopyExists: boolean;
  readonly mappedPaths: readonly string[];
  readonly checkoutRoot: string;
}): SingletonEvaluation {
  const reasons: string[] = [];
  let verdict: SingletonVerdict = "single-copy";
  const hostPrefix = hostModulePrefix(input.expectedHostRoot);

  const fail = (next: SingletonVerdict, reason: string): void => {
    reasons.push(reason);
    if (verdict === "single-copy") verdict = next;
  };

  if (input.proof.hostVersion !== input.expectedHostVersion) {
    fail(
      "host-version-mismatch",
      `hostVersion ${input.proof.hostVersion ?? "<missing>"} != ${input.expectedHostVersion}`,
    );
  }
  if (
    input.proof.hostRoot !== undefined &&
    !isPathInside(input.proof.hostRoot, input.expectedHostRoot) &&
    !isPathInside(input.expectedHostRoot, input.proof.hostRoot)
  ) {
    fail(
      "loaded-from-outside-host",
      `hostRoot ${input.proof.hostRoot} is not the proven host package`,
    );
  }

  let sawRedirectPair = false;
  for (const specifier of input.proof.specifiers) {
    if (specifier.loadedFrom === undefined) continue;
    if (!isPathInside(specifier.loadedFrom, hostPrefix)) {
      fail(
        "loaded-from-outside-host",
        `${specifier.specifier} loadedFrom is outside the host root`,
      );
    }
    if (
      specifier.bareResolution !== undefined &&
      specifier.bareResolution !== specifier.loadedFrom
    ) {
      sawRedirectPair = true;
    }
  }
  if (input.proof.specifiers.length === 0) {
    fail("proof-incomplete", "proof line listed no specifiers");
  }
  if (input.checkoutCopyExists && !sawRedirectPair) {
    fail(
      "redirect-not-observed",
      "checkout host copy exists but no specifier redirected away from it",
    );
  }

  const classified = classifyMappedPaths({
    paths: input.mappedPaths,
    checkoutRoot: input.checkoutRoot,
  });
  if (classified.checkoutEarendilPaths.length > 0) {
    fail(
      "checkout-earendil-mapped",
      `mapped ${classified.checkoutEarendilPaths.length} checkout @earendil-works path(s)`,
    );
  }
  if (classified.nativePackageRoots.length > 1) {
    fail(
      "multiple-native-package-roots",
      `mapped ${classified.nativePackageRoots.length} distinct @earendil-works .node package roots`,
    );
  }

  if (verdict !== "single-copy" && verdict !== "redirect-not-observed") {
    if (
      classified.checkoutEarendilPaths.length > 0 ||
      classified.nativePackageRoots.length > 1 ||
      input.proof.hostVersion !== input.expectedHostVersion
    ) {
      if (verdict !== "host-version-mismatch") {
        verdict = "duplicate";
      }
    }
  }

  return { verdict, reasons };
}

export function buildProofEnv(
  source: VerifyEnv,
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const omitted = new Set<string>(CHILD_ENV_OMIT);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (omitted.has(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    env[key] = value;
  }
  return env;
}

export function formatSummary(input: {
  readonly kind: "PASS" | "FAIL" | "SKIP";
  readonly artifactSha256?: string;
  readonly hostVersion?: string;
  readonly positive?: string;
  readonly negative?: string;
  readonly reason?: string;
}): string {
  const parts: string[] = [input.kind];
  if (input.hostVersion !== undefined) {
    parts.push(`hostVersion=${input.hostVersion}`);
  }
  if (input.artifactSha256 !== undefined) {
    parts.push(`artifactSha256=${input.artifactSha256}`);
  }
  if (input.positive !== undefined) parts.push(`positive=${input.positive}`);
  if (input.negative !== undefined) parts.push(`negative=${input.negative}`);
  if (input.reason !== undefined) parts.push(`reason=${input.reason}`);
  return parts.join(" ");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function hostPackageJsonCandidates(
  cliPath: string,
  env: VerifyEnv,
): readonly string[] {
  const candidates: string[] = [];
  const cliDir = dirname(cliPath);
  candidates.push(join(cliDir, "package.json"));
  candidates.push(join(dirname(cliDir), "package.json"));
  let current = cliDir;
  for (let index = 0; index < 6; index += 1) {
    candidates.push(join(current, "package.json"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const bunRoot = env.BUN_INSTALL ?? join(env.HOME ?? homedir(), ".bun");
  if (bunRoot.length > 0) {
    candidates.push(join(bunRoot, EXPECTED_HOST_PACKAGE_JSON));
  }
  return unique(candidates.filter((path) => isAbsolute(path)));
}

function resolveDeclaredCliPath(
  raw: string | undefined,
  cwd: string,
): string | undefined {
  if (raw !== undefined && raw.length > 0) {
    if (raw.includes("/") || raw.startsWith(".")) {
      return resolve(cwd, raw);
    }
    return Bun.which(raw) ?? undefined;
  }
  return Bun.which("pi") ?? undefined;
}

async function pathExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

function readJsonFile(
  path: string,
): ResultAsync<
  unknown,
  { readonly type: "JsonReadFailed"; readonly path: string }
> {
  return ResultAsync.fromThrowable(
    () => Bun.file(path).json(),
    (): { readonly type: "JsonReadFailed"; readonly path: string } => ({
      type: "JsonReadFailed",
      path,
    }),
  )();
}

async function resolveHostPresence(
  env: VerifyEnv,
  cwd: string,
): Promise<HostPresence> {
  const cliPath = resolveDeclaredCliPath(env[PI_HOST_CLI_ENV], cwd);
  if (cliPath === undefined) {
    return {
      status: "missing",
      reason: "Pi host CLI not found (set PI_HOST_CLI or install pi on PATH)",
    };
  }
  if (!(await pathExists(cliPath))) {
    return {
      status: "missing",
      reason: `Pi host CLI does not exist: ${cliPath}`,
    };
  }
  for (const packagePath of hostPackageJsonCandidates(cliPath, env)) {
    if (!(await pathExists(packagePath))) continue;
    const json = await readJsonFile(packagePath);
    if (json.isErr()) continue;
    const identity = parseHostPackageIdentity(json.value);
    if (identity.isErr()) continue;
    if (identity.value.name !== HOST_PACKAGE_NAME) continue;
    return {
      status: "found",
      cliPath,
      hostRoot: dirname(packagePath),
      hostVersion: identity.value.version,
    };
  }
  return {
    status: "invalid",
    reason: `Pi host CLI ${cliPath} is not package ${HOST_PACKAGE_NAME}`,
  };
}

function sha256File(path: string): ResultAsync<string, VerifyFailure> {
  return ResultAsync.fromThrowable(
    async () => {
      const bytes = await Bun.file(path).arrayBuffer();
      return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    },
    (): VerifyFailure => ({
      type: "ExtensionMissing",
      message: `failed to hash ${path}`,
    }),
  )();
}

function spawnCaptured(
  cmd: readonly string[],
  options?: { readonly cwd?: string },
): ResultAsync<
  {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  VerifyFailure
> {
  return ResultAsync.fromThrowable(
    async () => {
      const child = Bun.spawn({
        cmd: [...cmd],
        cwd: options?.cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    },
    (cause): VerifyFailure => ({
      type: "SpawnFailed",
      message: `failed to spawn ${cmd[0]}: ${String(cause)}`,
    }),
  )();
}

async function ensureExtensionArtifact(
  repoRoot: string,
): Promise<
  Result<{ readonly path: string; readonly sha256: string }, VerifyFailure>
> {
  const path = join(repoRoot, EXTENSION_RELATIVE_PATH);
  if (!(await pathExists(path))) {
    const built = await spawnCaptured(HOST_BUILD_COMMAND, { cwd: repoRoot });
    if (built.isErr()) return err(built.error);
    if (built.value.exitCode !== 0) {
      return err({
        type: "BuildFailed",
        message: `adapter build failed with exit ${built.value.exitCode}`,
      });
    }
  }
  if (!(await pathExists(path))) {
    return err({
      type: "ExtensionMissing",
      message: `${EXTENSION_RELATIVE_PATH} is missing after build`,
    });
  }
  const digest = await sha256File(path);
  if (digest.isErr()) return err(digest.error);
  return ok({ path, sha256: digest.value });
}

async function listCheckoutCopyPaths(repoRoot: string): Promise<string[]> {
  const found: string[] = [];
  const direct = [
    "node_modules/@earendil-works/pi-coding-agent",
    "node_modules/@earendil-works/pi-ai",
    "node_modules/@earendil-works/pi-tui",
  ];
  for (const relative of direct) {
    if (await pathExists(join(repoRoot, relative, "package.json"))) {
      found.push(relative);
    }
  }
  const bunStore = join(repoRoot, "node_modules", ".bun");
  const glob = ResultAsync.fromThrowable(
    async () => {
      const names: string[] = [];
      for await (const name of new Bun.Glob(
        "@earendil-works+pi-{coding-agent,ai,tui}@*",
      ).scan({ cwd: bunStore, onlyFiles: false })) {
        names.push(join("node_modules", ".bun", name));
      }
      return names;
    },
    () => [] as string[],
  );
  const isolated = await glob();
  if (isolated.isOk()) found.push(...isolated.value);
  return found;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function appendBounded(current: string, chunk: string): string {
  const next = `${current}${chunk}`;
  if (next.length <= MAX_CAPTURED_OUTPUT_CHARS) return next;
  return next.slice(next.length - MAX_CAPTURED_OUTPUT_CHARS);
}

function signalPid(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  Result.fromThrowable(
    () => {
      process.kill(pid, signal);
    },
    () => undefined,
  )();
}

async function inspectMappedPaths(
  pid: number,
): Promise<Result<readonly string[], VerifyFailure>> {
  const lsof = await spawnCaptured(["lsof", "-nP", "-p", String(pid), "-Fn"]);
  if (lsof.isOk() && lsof.value.exitCode === 0) {
    const parsed = parseLsofFnOutput(lsof.value.stdout);
    if (parsed.length > 0) return ok(parsed);
    return ok(parseLsofDefaultOutput(lsof.value.stdout));
  }
  const mapsPath = `/proc/${pid}/maps`;
  if (await pathExists(mapsPath)) {
    const maps = await ResultAsync.fromThrowable(
      () => Bun.file(mapsPath).text(),
      (): VerifyFailure => ({
        type: "SpawnFailed",
        message: `failed to read ${mapsPath}`,
      }),
    )();
    if (maps.isErr()) return err(maps.error);
    return ok(parseLinuxMapsOutput(maps.value));
  }
  return err({
    type: "SpawnFailed",
    message: lsof.isErr()
      ? lsof.error.message
      : `lsof failed with exit ${lsof.value.exitCode}`,
  });
}

async function inspectMappedPathsWithSettle(
  pid: number,
): Promise<Result<readonly string[], VerifyFailure>> {
  const deadline = Date.now() + MAPPING_SETTLE_MS;
  let last: readonly string[] = [];
  while (Date.now() < deadline) {
    const mapped = await inspectMappedPaths(pid);
    if (mapped.isErr()) return mapped;
    last = mapped.value;
    if (last.some((path) => path.includes("@earendil-works"))) {
      await delay(200);
      const again = await inspectMappedPaths(pid);
      if (again.isOk()) return again;
      return ok(last);
    }
    await delay(100);
  }
  return ok(last);
}

type SpawnedProof = {
  readonly subprocess: ReturnType<typeof Bun.spawn>;
  readonly pid: number;
  output: string;
};

async function terminateSpawned(
  spawned: SpawnedProof | undefined,
): Promise<Result<{ readonly exitCode: number }, VerifyFailure>> {
  if (spawned === undefined) return ok({ exitCode: 0 });
  const { subprocess, pid } = spawned;
  if (subprocess.killed || subprocess.exitCode !== null) {
    return ok({ exitCode: subprocess.exitCode ?? 0 });
  }
  subprocess.kill("SIGTERM");
  signalPid(pid, "SIGTERM");
  const term = await Promise.race([
    subprocess.exited.then((exitCode) => ({ exitCode })),
    delay(KILL_WAIT_MS).then(() => undefined),
  ]);
  if (term !== undefined) return ok(term);
  subprocess.kill("SIGKILL");
  signalPid(pid, "SIGKILL");
  const killed = await Promise.race([
    subprocess.exited.then((exitCode) => ({ exitCode })),
    delay(KILL_WAIT_MS).then(() => undefined),
  ]);
  if (killed === undefined) {
    return err({
      type: "CleanupFailed",
      message: `child pid ${pid} did not exit after SIGKILL`,
    });
  }
  return ok(killed);
}

async function removeDir(path: string): Promise<Result<void, VerifyFailure>> {
  const removed = await spawnCaptured(["rm", "-rf", path]);
  if (removed.isErr()) return err(removed.error);
  if (removed.value.exitCode !== 0) {
    return err({
      type: "CleanupFailed",
      message: `failed to remove ${path}`,
    });
  }
  return ok(undefined);
}

async function createTempCwd(): Promise<Result<string, VerifyFailure>> {
  const path = join(tmpdir(), `weave-pi-host-singleton-${crypto.randomUUID()}`);
  const written = await ResultAsync.fromThrowable(
    () => Bun.write(join(path, ".keep"), ""),
    (): VerifyFailure => ({
      type: "SpawnFailed",
      message: `failed to create temp cwd ${path}`,
    }),
  )();
  if (written.isErr()) return err(written.error);
  return ok(path);
}

async function readUntilProof(
  spawned: SpawnedProof,
  timeoutMs: number,
): Promise<Result<ParsedHostModuleProof, VerifyFailure>> {
  const decoder = new TextDecoder();
  const stdout = spawned.subprocess.stdout;
  const stderr = spawned.subprocess.stderr;
  if (
    stdout === undefined ||
    stderr === undefined ||
    typeof stdout === "number" ||
    typeof stderr === "number"
  ) {
    return err({
      type: "SpawnFailed",
      message: "spawned process is missing stdio pipes",
    });
  }
  const stdoutReader = stdout.getReader();
  const stderrReader = stderr.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void stdoutReader.cancel();
    void stderrReader.cancel();
  }, timeoutMs);

  const absorb = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<void> => {
    while (true) {
      const chunk = await ResultAsync.fromPromise(
        reader.read(),
        () => undefined,
      );
      if (chunk.isErr() || chunk.value.done) return;
      spawned.output = appendBounded(
        spawned.output,
        decoder.decode(chunk.value.value, { stream: true }),
      );
    }
  };

  const wait = (async (): Promise<
    Result<ParsedHostModuleProof, VerifyFailure>
  > => {
    void Promise.all([absorb(stdoutReader), absorb(stderrReader)]);
    while (true) {
      const extracted = extractProofLineFromOutput(spawned.output);
      if (extracted.isOk()) return extracted;
      if (timedOut) {
        return err({
          type: "ProofTimeout",
          message: `proof line not seen within ${timeoutMs}ms`,
        });
      }
      if (spawned.subprocess.exitCode !== null) {
        const late = extractProofLineFromOutput(spawned.output);
        if (late.isOk()) return late;
        return err({
          type: "ProofMissing",
          message: `host exited ${spawned.subprocess.exitCode} before emitting a proof line`,
        });
      }
      await delay(50);
    }
  })();

  const result = await wait;
  clearTimeout(timer);
  return result;
}

async function runOneProofProcess(input: {
  readonly hostCli: string;
  readonly extensionPath: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
}): Promise<
  Result<
    {
      readonly proof: ParsedHostModuleProof;
      readonly mappedPaths: readonly string[];
      readonly exitCode: number;
    },
    VerifyFailure
  >
> {
  let spawned: SpawnedProof | undefined;
  try {
    const created = Result.fromThrowable(
      () =>
        Bun.spawn({
          cmd: [
            input.hostCli,
            "--mode",
            "rpc",
            "--no-session",
            "--no-extensions",
            "-e",
            input.extensionPath,
          ],
          cwd: input.cwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: input.env,
        }),
      (cause): VerifyFailure => ({
        type: "SpawnFailed",
        message: `failed to spawn host CLI: ${String(cause)}`,
      }),
    )();
    if (created.isErr()) return err(created.error);
    const subprocess = created.value;
    const pid = subprocess.pid;
    if (pid === undefined) {
      subprocess.kill("SIGKILL");
      return err({
        type: "SpawnFailed",
        message: "host CLI spawned without a pid",
      });
    }
    spawned = { subprocess, pid, output: "" };
    const proof = await readUntilProof(spawned, PROOF_WAIT_MS);
    if (proof.isErr()) return err(proof.error);
    const mapped = await inspectMappedPathsWithSettle(pid);
    if (mapped.isErr()) return err(mapped.error);
    return ok({
      proof: proof.value,
      mappedPaths: mapped.value,
      exitCode: subprocess.exitCode ?? 0,
    });
  } finally {
    const terminated = await terminateSpawned(spawned);
    if (terminated.isErr()) {
      log.error({ err: terminated.error }, "failed to terminate proof child");
    }
  }
}

export function runVerifyHostSingleton(input: {
  readonly argv: readonly string[];
  readonly env: VerifyEnv;
  readonly cwd: string;
}): ResultAsync<VerifySuccess, VerifyFailure> {
  return ResultAsync.fromPromise(
    executeVerify(input),
    (cause): VerifyFailure => ({
      type: "Unexpected",
      message: String(cause),
    }),
  ).andThen((result) =>
    result.isOk() ? okAsync(result.value) : errAsync(result.error),
  );
}

async function executeVerify(input: {
  readonly argv: readonly string[];
  readonly env: VerifyEnv;
  readonly cwd: string;
}): Promise<Result<VerifySuccess, VerifyFailure>> {
  const args = parseVerifyArgs(input.argv);
  if (args.isErr()) return err(args.error);

  const presence = await resolveHostPresence(input.env, input.cwd);
  const skip = decideSkip(presence, args.value.allowSkip);
  if (skip.action === "skip") {
    return ok({ kind: "skip", reason: skip.reason });
  }
  if (skip.action === "fail") {
    return err({
      type: presence.status === "invalid" ? "HostInvalid" : "HostMissing",
      message: skip.reason,
    });
  }
  if (presence.status !== "found") {
    return err({ type: "HostMissing", message: "host presence is not found" });
  }

  const artifact = await ensureExtensionArtifact(input.cwd);
  if (artifact.isErr()) return err(artifact.error);

  const checkoutCopies = await listCheckoutCopyPaths(input.cwd);
  const checkoutCopyExists = checkoutCopyExistsFromListing(checkoutCopies);
  const tempCwd = await createTempCwd();
  if (tempCwd.isErr()) return err(tempCwd.error);

  const commonEnv = {
    [WEAVE_PI_HOST_MODULE_PROOF_ENV]: "1",
    PI_OFFLINE: "1",
  } as const;

  try {
    const positive = await runOneProofProcess({
      hostCli: presence.cliPath,
      extensionPath: artifact.value.path,
      cwd: tempCwd.value,
      env: buildProofEnv(input.env, { ...commonEnv }),
    });
    if (positive.isErr()) {
      return err({
        ...positive.error,
        artifactSha256: artifact.value.sha256,
        hostVersion: presence.hostVersion,
        positive: "error",
      });
    }
    const positiveEval = evaluateSingletonProof({
      proof: positive.value.proof,
      expectedHostVersion: presence.hostVersion,
      expectedHostRoot: presence.hostRoot,
      checkoutCopyExists,
      mappedPaths: positive.value.mappedPaths,
      checkoutRoot: input.cwd,
    });
    if (positiveEval.verdict !== "single-copy") {
      return err({
        type: "PositiveFailed",
        message: positiveEval.reasons.join("; ") || positiveEval.verdict,
        artifactSha256: artifact.value.sha256,
        hostVersion: presence.hostVersion,
        positive: positiveEval.verdict,
      });
    }

    const negative = await runOneProofProcess({
      hostCli: presence.cliPath,
      extensionPath: artifact.value.path,
      cwd: tempCwd.value,
      env: buildProofEnv(input.env, {
        ...commonEnv,
        [WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT_ENV]: "1",
      }),
    });
    if (negative.isErr()) {
      return err({
        ...negative.error,
        artifactSha256: artifact.value.sha256,
        hostVersion: presence.hostVersion,
        positive: "single-copy",
        negative: "error",
      });
    }
    const negativeEval = evaluateSingletonProof({
      proof: negative.value.proof,
      expectedHostVersion: presence.hostVersion,
      expectedHostRoot: presence.hostRoot,
      checkoutCopyExists,
      mappedPaths: negative.value.mappedPaths,
      checkoutRoot: input.cwd,
    });
    if (negativeEval.verdict === "single-copy") {
      return err({
        type: "NegativeNotDistinguished",
        message:
          "disable-redirect run still looked like a single host copy; detector cannot see the duplicate",
        artifactSha256: artifact.value.sha256,
        hostVersion: presence.hostVersion,
        positive: "single-copy",
        negative: "not-distinguished",
      });
    }

    return ok({
      kind: "pass",
      artifactSha256: artifact.value.sha256,
      hostVersion: presence.hostVersion,
      hostRoot: presence.hostRoot,
      positive: "single-copy",
      negative: "duplicate-detected",
    });
  } finally {
    const removed = await removeDir(tempCwd.value);
    if (removed.isErr()) {
      log.error({ err: removed.error }, "failed to remove proof temp dir");
    }
  }
}

function boundFailureOutput(message: string): string {
  if (message.length <= MAX_ERROR_OUTPUT_CHARS) return message;
  return message.slice(0, MAX_ERROR_OUTPUT_CHARS);
}

if (import.meta.main) {
  const result = await runVerifyHostSingleton({
    argv: Bun.argv.slice(2),
    env: Bun.env,
    cwd: process.cwd(),
  });
  result.match(
    (success) => {
      if (success.kind === "skip") {
        const summary = formatSummary({
          kind: "SKIP",
          reason: success.reason,
        });
        log.info({ reason: success.reason, summary }, "SKIP");
        process.exitCode = 0;
        return;
      }
      const summary = formatSummary({
        kind: "PASS",
        artifactSha256: success.artifactSha256,
        hostVersion: success.hostVersion,
        positive: success.positive,
        negative: success.negative,
      });
      log.info(
        {
          artifactSha256: success.artifactSha256,
          hostVersion: success.hostVersion,
          hostRoot: success.hostRoot,
          positive: success.positive,
          negative: success.negative,
          summary,
        },
        "PASS",
      );
      process.exitCode = 0;
    },
    (failure) => {
      const summary = formatSummary({
        kind: "FAIL",
        artifactSha256: failure.artifactSha256,
        hostVersion: failure.hostVersion,
        positive: failure.positive,
        negative: failure.negative,
        reason: boundFailureOutput(failure.message),
      });
      log.error(
        {
          type: failure.type,
          message: boundFailureOutput(failure.message),
          artifactSha256: failure.artifactSha256,
          hostVersion: failure.hostVersion,
          positive: failure.positive,
          negative: failure.negative,
          summary,
        },
        "FAIL",
      );
      process.exitCode = 1;
    },
  );
}
