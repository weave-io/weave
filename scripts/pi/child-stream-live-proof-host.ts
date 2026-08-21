import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { err, errAsync, okAsync, Result, ResultAsync } from "neverthrow";
import { runBoundedProcess } from "./child-stream-live-proof-bounded-runner.js";
import { readProcessLines } from "./child-stream-live-proof-bounded-stream.js";
import type { LiveProofFailureCode } from "./child-stream-live-proof-contract.js";
import { terminateBoundedProcess } from "./child-stream-live-proof-process-control.js";
import {
  DEFAULT_BOUNDED_PROCESS_LIMITS,
  type LiveProofProcess,
  type LiveProofSpawnInput,
  type LiveProofSystem,
  type LiveProofSystemFailure,
  systemFailure,
} from "./child-stream-live-proof-system-contract.js";

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
          terminateBoundedProcess(child, DEFAULT_BOUNDED_PROCESS_LIMITS),
          (): LiveProofSystemFailure => systemFailure("cleanup-failed"),
        ).andThen((terminated) =>
          terminated
            ? okAsync<void, LiveProofSystemFailure>(undefined)
            : errAsync(systemFailure("cleanup-failed")),
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
    setTimer: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      let cancelled = false;
      return {
        cancel: () => {
          if (cancelled) return;
          cancelled = true;
          clearTimeout(handle);
        },
      };
    },
    environment: () => currentEnvironment(),
    temporaryRoot: () => tmpdir(),
    uniqueToken: () => crypto.randomUUID(),
    spawn: bunSpawn,
    run: (input) =>
      runBoundedProcess({
        cmd: input.cmd,
        cwd: input.cwd,
        env: safeProofEnvironment(currentEnvironment()),
      }).map(({ exitCode, stdout }) => ({ exitCode, stdout })),
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
      runBoundedProcess({
        cmd: [
          "/bin/sh",
          "-c",
          'umask 077; set -C; : > "$1"; chmod 600 "$1"',
          "sh",
          path,
        ],
        cwd: ".",
        env: safeProofEnvironment(currentEnvironment()),
      }).andThen(({ exitCode }) =>
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
