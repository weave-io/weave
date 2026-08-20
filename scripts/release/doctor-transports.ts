/**
 * Bounded, read-only transports for the release doctor.
 *
 * Every outbound read the doctor performs is bounded three ways: a wall-clock
 * timeout, a maximum number of response bytes counted while the body streams,
 * and — for subprocesses — a maximum number of bytes counted while stdout and
 * stderr stream. A read that cannot be bounded is a failure, never a value.
 *
 * The GitHub API origin is validated before a credential is attached. The
 * doctor sends its token to exactly one origin: the official GitHub REST API.
 * A `GITHUB_API_URL` that names another host, another scheme, a nondefault
 * port, embedded userinfo, or any path, query, or fragment is refused rather
 * than normalized, because normalizing an attacker-chosen URL is how a token
 * leaves the machine.
 */
import { err, ok, Result } from "neverthrow";

/** A bounded external read failed. It never carries a credential value. */
export type DoctorPortError = {
  readonly type: "DoctorPortFailed";
  readonly operation: string;
  readonly message: string;
};

export function doctorPortError(
  operation: string,
  message: string,
): DoctorPortError {
  return { type: "DoctorPortFailed", operation, message };
}

export const DOCTOR_TRANSPORT_LIMITS = {
  /** Wall-clock bound for one HTTP read, including body streaming. */
  requestTimeoutMs: 10_000,
  /** Wall-clock bound for one npm subprocess, including output streaming. */
  processTimeoutMs: 60_000,
  /** JSON documents the doctor is willing to decode. */
  jsonResponseBytes: 512 * 1024,
  /** Registry tarballs the doctor is willing to digest. */
  tarballResponseBytes: 8 * 1024 * 1024,
  /** Attestation bundles the doctor is willing to decode. */
  attestationResponseBytes: 2 * 1024 * 1024,
  /** Bytes accepted from a subprocess stdout stream. */
  processStdoutBytes: 4 * 1024 * 1024,
  /** Bytes accepted from a subprocess stderr stream. */
  processStderrBytes: 64 * 1024,
} as const;

/** The one origin the doctor may send a GitHub credential to. */
export const OFFICIAL_GITHUB_API_ORIGIN = "https://api.github.com" as const;

const OFFICIAL_GITHUB_API_HOSTS: ReadonlySet<string> = new Set([
  "api.github.com",
]);

/**
 * Accepts only the exact official GitHub REST origin.
 *
 * The check is deliberately whole-URL, not host-prefix: `https://api.github.com.evil.tld`,
 * `https://user:token@api.github.com`, `https://api.github.com:8443`, and
 * `https://api.github.com/../evil` all fail. The returned value is the
 * canonical origin with no trailing slash, so no caller can append a path onto
 * an attacker-chosen base.
 */
export function validateGitHubApiUrl(
  value: string,
): Result<typeof OFFICIAL_GITHUB_API_ORIGIN, DoctorPortError> {
  const operation = "github.api-url";
  if (value.length === 0 || value.length > 2_048)
    return err(
      doctorPortError(operation, "GITHUB_API_URL has an unusable length"),
    );
  if (hasUnsafeUrlCharacter(value))
    return err(
      doctorPortError(operation, "GITHUB_API_URL contains control characters"),
    );
  const parsed = Result.fromThrowable(
    () => new URL(value),
    () => doctorPortError(operation, "GITHUB_API_URL is not a valid URL"),
  )();
  if (parsed.isErr()) return err(parsed.error);
  const url = parsed.value;
  if (url.protocol !== "https:")
    return err(doctorPortError(operation, "GITHUB_API_URL must use HTTPS"));
  if (url.username !== "" || url.password !== "")
    return err(
      doctorPortError(operation, "GITHUB_API_URL must not embed credentials"),
    );
  if (url.port !== "" && url.port !== "443")
    return err(
      doctorPortError(
        operation,
        "GITHUB_API_URL must use the default HTTPS port",
      ),
    );
  if (url.search !== "" || url.hash !== "")
    return err(
      doctorPortError(
        operation,
        "GITHUB_API_URL must not carry a query or fragment",
      ),
    );
  if (url.pathname !== "" && url.pathname !== "/")
    return err(
      doctorPortError(operation, "GITHUB_API_URL must not carry a path"),
    );
  if (!OFFICIAL_GITHUB_API_HOSTS.has(url.hostname))
    return err(
      doctorPortError(
        operation,
        `GITHUB_API_URL host ${url.hostname} is not the official GitHub API host`,
      ),
    );
  if (url.origin !== OFFICIAL_GITHUB_API_ORIGIN)
    return err(
      doctorPortError(
        operation,
        "GITHUB_API_URL origin is not the official GitHub API origin",
      ),
    );
  return ok(OFFICIAL_GITHUB_API_ORIGIN);
}

/**
 * Resolves the API origin a credentialed read may use.
 *
 * An unset or empty value means "use the official origin". Any other value
 * must prove itself; it is never silently replaced with the default, because
 * silently ignoring a hostile override hides a misconfigured runner.
 */
export function resolveGitHubApiUrl(
  value: string | undefined,
): Result<typeof OFFICIAL_GITHUB_API_ORIGIN, DoctorPortError> {
  if (value === undefined || value.length === 0)
    return ok(OFFICIAL_GITHUB_API_ORIGIN);
  return validateGitHubApiUrl(value);
}

/** True when a URL string carries whitespace or a control character. */
function hasUnsafeUrlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Races an operation against a wall clock and always clears its timer. */
export async function withDoctorTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`read timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Reads a response body, counting bytes as they arrive.
 *
 * A declared `content-length` over the bound is refused before a byte is read,
 * and a body that lies about its length is cancelled the moment the running
 * total crosses the bound.
 */
export async function boundedResponseBytes(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes)
      throw new Error(`response exceeds ${maxBytes} bytes`);
  }
  return withDoctorTimeout(async () => {
    if (response.body === null) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes)
        throw new Error(`response exceeds ${maxBytes} bytes`);
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`response exceeds ${maxBytes} bytes`);
      }
      chunks.push(next.value);
    }
    return concat(chunks, total);
  }, timeoutMs);
}

export type DoctorFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface BoundedJsonFetchResult {
  readonly status: number;
  readonly ok: boolean;
  readonly value: unknown | undefined;
}

/** Bounded JSON GET. A non-2xx status is reported, never decoded. */
export async function boundedJsonFetch(
  url: string,
  fetchImpl: DoctorFetch,
  maxBytes: number,
  timeoutMs: number = DOCTOR_TRANSPORT_LIMITS.requestTimeoutMs,
): Promise<BoundedJsonFetchResult> {
  const response = await withDoctorTimeout(
    () =>
      fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
      }),
    timeoutMs,
  );
  const bytes = await boundedResponseBytes(response, maxBytes, timeoutMs);
  if (!response.ok)
    return { status: response.status, ok: false, value: undefined };
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as unknown;
  return { status: response.status, ok: true, value };
}

export interface BoundedBytesFetchResult {
  readonly status: number;
  readonly ok: boolean;
  readonly bytes: Uint8Array;
}

/** Bounded binary GET used for registry tarballs. */
export async function boundedBytesFetch(
  url: string,
  fetchImpl: DoctorFetch,
  maxBytes: number,
  timeoutMs: number = DOCTOR_TRANSPORT_LIMITS.requestTimeoutMs,
): Promise<BoundedBytesFetchResult> {
  const response = await withDoctorTimeout(
    () => fetchImpl(url, { method: "GET" }),
    timeoutMs,
  );
  const bytes = await boundedResponseBytes(response, maxBytes, timeoutMs);
  return { status: response.status, ok: response.ok, bytes };
}

export interface BoundedProcessOptions {
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly spawn?: BoundedSpawn;
}

/** The exact subset of `Bun.spawn` the bounded runner needs. */
export type BoundedSpawn = (
  argv: readonly string[],
  options: { stdout: "pipe"; stderr: "pipe"; stdin: "ignore" },
) => BoundedChildProcess;

export interface BoundedChildProcess {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface BoundedProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs one subprocess under a wall clock with streaming output bounds.
 *
 * The previous doctor buffered `npm` output with `Response.text()`, which has
 * no upper bound and no clock: a hung or chatty registry could pin the doctor
 * open and grow the heap without limit. Here each stream is drained chunk by
 * chunk, the running totals are checked before a chunk is kept, and crossing
 * either bound or the deadline kills the child and fails the read.
 */
export function runBoundedProcess(
  argv: readonly string[],
  options: BoundedProcessOptions = {},
): Promise<Result<BoundedProcessResult, DoctorPortError>> {
  const operation = argv.join(" ");
  if (argv.length === 0)
    return Promise.resolve(
      err(doctorPortError("process", "no command was given")),
    );
  const timeoutMs =
    options.timeoutMs ?? DOCTOR_TRANSPORT_LIMITS.processTimeoutMs;
  const maxStdoutBytes =
    options.maxStdoutBytes ?? DOCTOR_TRANSPORT_LIMITS.processStdoutBytes;
  const maxStderrBytes =
    options.maxStderrBytes ?? DOCTOR_TRANSPORT_LIMITS.processStderrBytes;
  const spawn = options.spawn ?? defaultSpawn;
  return runBounded(
    argv,
    operation,
    spawn,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
  );
}

async function runBounded(
  argv: readonly string[],
  operation: string,
  spawn: BoundedSpawn,
  timeoutMs: number,
  maxStdoutBytes: number,
  maxStderrBytes: number,
): Promise<Result<BoundedProcessResult, DoctorPortError>> {
  let child: BoundedChildProcess;
  try {
    child = spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (cause) {
    return err(
      doctorPortError(
        operation,
        cause instanceof Error ? cause.message : String(cause),
      ),
    );
  }
  const kill = () => {
    try {
      child.kill();
    } catch {
      // The child already exited; there is nothing to terminate.
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      kill();
      resolve("timeout");
    }, timeoutMs);
  });
  try {
    const work = Promise.all([
      child.exited,
      drainBounded(child.stdout, maxStdoutBytes),
      drainBounded(child.stderr, maxStderrBytes),
    ]);
    const settled = await Promise.race([work, deadline]);
    if (settled === "timeout" || timedOut) {
      await settleQuietly(child.exited);
      return err(
        doctorPortError(operation, `command timed out after ${timeoutMs}ms`),
      );
    }
    const [exitCode, stdout, stderr] = settled;
    if (stdout.overflowed)
      return err(
        doctorPortError(
          operation,
          `command stdout exceeded ${maxStdoutBytes} bytes`,
        ),
      );
    if (stderr.overflowed)
      return err(
        doctorPortError(
          operation,
          `command stderr exceeded ${maxStderrBytes} bytes`,
        ),
      );
    if (exitCode !== 0)
      return err(
        doctorPortError(
          operation,
          stderr.text.length > 0 ? stderr.text : `command exited ${exitCode}`,
        ),
      );
    return ok({ exitCode, stdout: stdout.text, stderr: stderr.text });
  } catch (cause) {
    kill();
    return err(
      doctorPortError(
        operation,
        cause instanceof Error ? cause.message : String(cause),
      ),
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!timedOut) kill();
  }
}

interface DrainedStream {
  readonly text: string;
  readonly overflowed: boolean;
}

async function drainBounded(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<DrainedStream> {
  if (stream === null) return { text: "", overflowed: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (total + next.value.byteLength > maxBytes) {
        await reader.cancel();
        return { text: "", overflowed: true };
      }
      total += next.value.byteLength;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return {
    text: new TextDecoder("utf-8").decode(concat(chunks, total)),
    overflowed: false,
  };
}

async function settleQuietly(exited: Promise<number>): Promise<void> {
  try {
    await exited;
  } catch {
    // A killed child's exit status carries no information the caller needs.
  }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const defaultSpawn: BoundedSpawn = (argv, options) =>
  Bun.spawn([...argv], options) as unknown as BoundedChildProcess;
