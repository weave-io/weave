import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { err, errAsync, okAsync, Result, ResultAsync } from "neverthrow";
import type { LiveProofFailureCode } from "./child-stream-live-proof-contract.js";

/**
 * The production live proof touches processes, the filesystem, the clock, and
 * the environment. Every one of those effects crosses this boundary so the
 * command can be tested without a host, and so no host string can reach the
 * report: each method fails with a closed code only.
 */
export interface LiveProofSystemFailure {
  readonly code: LiveProofFailureCode;
}

export function systemFailure(
  code: LiveProofFailureCode,
): LiveProofSystemFailure {
  return { code };
}

export type LiveProofPathKind = "missing" | "file" | "symlink" | "other";

export interface LiveProofSpawnInput {
  readonly cmd: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * A started process. `lines` yields stdout/stderr text lines; the caller owns
 * the iteration deadline. No method returns host error text.
 */
export interface LiveProofProcess {
  readonly writeLine: (line: string) => Result<void, LiveProofSystemFailure>;
  readonly lines: () => AsyncIterable<string>;
  readonly terminate: () => ResultAsync<void, LiveProofSystemFailure>;
  readonly running: () => boolean;
}

export interface LiveProofCommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface LiveProofSystem {
  readonly now: () => number;
  readonly environment: () => Readonly<Record<string, string>>;
  readonly temporaryRoot: () => string;
  readonly uniqueToken: () => string;
  readonly spawn: (
    input: LiveProofSpawnInput,
  ) => Result<LiveProofProcess, LiveProofSystemFailure>;
  readonly run: (input: {
    readonly cmd: readonly string[];
    readonly cwd: string;
  }) => ResultAsync<LiveProofCommandOutput, LiveProofSystemFailure>;
  readonly makeDirectory: (
    path: string,
  ) => ResultAsync<void, LiveProofSystemFailure>;
  readonly writeText: (
    path: string,
    text: string,
  ) => ResultAsync<void, LiveProofSystemFailure>;
  readonly readBytes: (
    path: string,
  ) => ResultAsync<Uint8Array, LiveProofSystemFailure>;
  readonly writeBytes: (
    path: string,
    bytes: Uint8Array,
  ) => ResultAsync<void, LiveProofSystemFailure>;
  /** Create `path` only if it does not exist, with owner-only permissions. */
  readonly createPrivateFile: (
    path: string,
  ) => ResultAsync<void, LiveProofSystemFailure>;
  readonly renamePath: (
    from: string,
    to: string,
  ) => ResultAsync<void, LiveProofSystemFailure>;
  readonly removePath: (
    path: string,
  ) => ResultAsync<void, LiveProofSystemFailure>;
  readonly pathKind: (
    path: string,
  ) => ResultAsync<LiveProofPathKind, LiveProofSystemFailure>;
  readonly delay: (ms: number) => ResultAsync<void, LiveProofSystemFailure>;
}

const MAX_GUARDED_BYTES = 1024 * 1024;

/** Drop credential-shaped variables before any spawned proof process. */
export function safeProofEnvironment(
  source: Readonly<Record<string, string>>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)/iu.test(key)) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function currentEnvironment(): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (typeof value === "string") output[key] = value;
  }
  return output;
}

type ProcessByteStream = ReadableStream<Uint8Array<ArrayBuffer>>;

async function* readProcessLines(
  process: ReturnType<typeof Bun.spawn>,
): AsyncIterable<string> {
  const streams = [process.stdout, process.stderr].filter(
    (stream): stream is ProcessByteStream =>
      stream !== undefined && typeof stream !== "number",
  );
  if (streams.length === 0) return;
  const decoder = new TextDecoder();
  const queue: string[] = [];
  let buffer = "";
  let open = streams.length;
  let wake: (() => void) | undefined;

  const pump = async (stream: ProcessByteStream): Promise<void> => {
    const reader = stream.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          queue.push(part.endsWith("\r") ? part.slice(0, -1) : part);
        }
        wake?.();
      }
    } finally {
      reader.releaseLock();
      open -= 1;
      wake?.();
    }
  };
  for (const stream of streams) void pump(stream);

  while (true) {
    const next = queue.shift();
    if (next !== undefined) {
      yield next;
      continue;
    }
    if (open <= 0) return;
    await new Promise<void>((resolveWake) => {
      wake = () => {
        wake = undefined;
        resolveWake();
      };
    });
  }
}

function bunSpawn(
  input: LiveProofSpawnInput,
): Result<LiveProofProcess, LiveProofSystemFailure> {
  const spawned = Result.fromThrowable(
    () =>
      Bun.spawn({
        cmd: [...input.cmd],
        cwd: input.cwd,
        env: { ...input.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    (): LiveProofSystemFailure => systemFailure("spawn-failed"),
  )();
  if (spawned.isErr()) return err(spawned.error);
  const child = spawned.value;
  return Result.fromThrowable(
    (): LiveProofProcess => ({
      writeLine: (line) =>
        Result.fromThrowable(
          () => {
            const stdin = child.stdin;
            if (stdin === undefined || typeof stdin === "number") {
              throw new Error("no stdin");
            }
            stdin.write(`${line}\n`);
            stdin.flush();
          },
          (): LiveProofSystemFailure => systemFailure("spawn-failed"),
        )(),
      lines: () => readProcessLines(child),
      terminate: () =>
        ResultAsync.fromPromise(
          (async () => {
            Result.fromThrowable(
              () => child.kill("SIGTERM"),
              () => undefined,
            )();
            await Promise.race([
              child.exited,
              new Promise<void>((resolveDelay) =>
                setTimeout(resolveDelay, 1_000),
              ),
            ]);
            if (child.exitCode === null) {
              Result.fromThrowable(
                () => child.kill("SIGKILL"),
                () => undefined,
              )();
              await Promise.race([
                child.exited,
                new Promise<void>((resolveDelay) =>
                  setTimeout(resolveDelay, 1_000),
                ),
              ]);
            }
          })(),
          (): LiveProofSystemFailure => systemFailure("cleanup-failed"),
        ),
      running: () => child.exitCode === null && child.signalCode === null,
    }),
    (): LiveProofSystemFailure => systemFailure("spawn-failed"),
  )();
}

function shell(
  operation: () => Promise<unknown>,
  code: LiveProofFailureCode,
): ResultAsync<void, LiveProofSystemFailure> {
  return ResultAsync.fromPromise(operation(), () => systemFailure(code)).map(
    () => undefined,
  );
}

/** Bun-backed system used by the real command. */
export function createLiveProofSystem(): LiveProofSystem {
  return {
    now: () => Date.now(),
    environment: () => currentEnvironment(),
    temporaryRoot: () => tmpdir(),
    uniqueToken: () => crypto.randomUUID(),
    spawn: bunSpawn,
    run: (input) => {
      const spawned = Result.fromThrowable(
        () =>
          Bun.spawn({
            cmd: [...input.cmd],
            cwd: input.cwd,
            env: safeProofEnvironment(currentEnvironment()),
            stdout: "pipe",
            stderr: "pipe",
          }),
        (): LiveProofSystemFailure => systemFailure("spawn-failed"),
      )();
      if (spawned.isErr()) return errAsync(spawned.error);
      return ResultAsync.fromPromise(
        Promise.all([
          spawned.value.exited,
          new Response(spawned.value.stdout).text(),
        ]),
        (): LiveProofSystemFailure => systemFailure("spawn-failed"),
      ).map(([exitCode, stdout]) => ({ exitCode, stdout }));
    },
    makeDirectory: (path) =>
      shell(() => $`mkdir -p ${path}`.quiet(), "spawn-failed"),
    writeText: (path, text) =>
      shell(() => Bun.write(path, text), "spawn-failed"),
    readBytes: (path) =>
      ResultAsync.fromPromise(
        Bun.file(path).arrayBuffer(),
        (): LiveProofSystemFailure => systemFailure("cleanup-failed"),
      ).andThen((bytes) =>
        bytes.byteLength > MAX_GUARDED_BYTES
          ? errAsync(systemFailure("cleanup-failed"))
          : okAsync(new Uint8Array(bytes)),
      ),
    writeBytes: (path, bytes) =>
      shell(() => Bun.write(path, bytes), "cleanup-failed"),
    // `set -C` plus `umask 077` is the portable owner-only exclusive create.
    // Bun's shell has no noclobber, so this runs in a real POSIX shell.
    createPrivateFile: (path) =>
      ResultAsync.fromPromise(
        (async () => {
          const created = Bun.spawn({
            cmd: [
              "/bin/sh",
              "-c",
              'umask 077; set -C; : > "$1"; chmod 600 "$1"',
              "sh",
              path,
            ],
            stdout: "ignore",
            stderr: "ignore",
          });
          return await created.exited;
        })(),
        (): LiveProofSystemFailure => systemFailure("report-invalid"),
      ).andThen((exitCode) =>
        exitCode === 0
          ? okAsync<void, LiveProofSystemFailure>(undefined)
          : errAsync(systemFailure("report-invalid")),
      ),
    renamePath: (from, to) =>
      shell(() => $`mv -f ${from} ${to}`.quiet(), "report-invalid"),
    removePath: (path) =>
      shell(() => $`rm -rf ${path}`.quiet(), "cleanup-failed"),
    pathKind: (path) =>
      ResultAsync.fromPromise(
        (async () => {
          const link = await $`test -L ${path}`.quiet().nothrow();
          if (link.exitCode === 0) return "symlink" as const;
          const file = await $`test -f ${path}`.quiet().nothrow();
          if (file.exitCode === 0) return "file" as const;
          const exists = await $`test -e ${path}`.quiet().nothrow();
          return exists.exitCode === 0
            ? ("other" as const)
            : ("missing" as const);
        })(),
        (): LiveProofSystemFailure => systemFailure("report-invalid"),
      ),
    delay: (ms) =>
      ResultAsync.fromPromise(
        new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms)),
        (): LiveProofSystemFailure => systemFailure("timeout"),
      ),
  };
}

/** Join a workspace-relative name onto a live-proof temporary root. */
export function workspacePath(root: string, name: string): string {
  return join(root, name);
}
