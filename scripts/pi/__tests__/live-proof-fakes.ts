import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import type {
  LiveProofCommandOutput,
  LiveProofPathKind,
  LiveProofProcess,
  LiveProofSpawnInput,
  LiveProofSystem,
  LiveProofSystemFailure,
} from "../child-stream-live-proof-system.js";
import { systemFailure } from "../child-stream-live-proof-system.js";

export interface FakeProcessScript {
  /** Lines the process emits on stdout, in order. */
  readonly lines: readonly string[];
  /** When true, `spawn` fails instead of returning a process. */
  readonly spawnFails?: boolean;
  /** When true, the line iterator never completes within the test deadline. */
  readonly hang?: boolean;
  /** When true, `running()` still reports true after `terminate()`. */
  readonly survivesTermination?: boolean;
}

export interface FakeProcessRecord {
  readonly input: LiveProofSpawnInput;
  readonly written: string[];
  terminations: number;
  alive: boolean;
}

export interface FakeSystemOptions {
  readonly processes?: readonly FakeProcessScript[];
  readonly files?: ReadonlyMap<string, Uint8Array>;
  readonly kinds?: ReadonlyMap<string, LiveProofPathKind>;
  readonly runOutput?: LiveProofCommandOutput;
  readonly runFails?: boolean;
  readonly failCreatePrivateFile?: boolean;
  readonly failWriteBytes?: boolean;
  readonly failRename?: boolean;
  readonly failRemove?: boolean;
}

export interface FakeSystem {
  readonly system: LiveProofSystem;
  readonly files: Map<string, Uint8Array>;
  readonly privateFiles: Set<string>;
  readonly removed: string[];
  readonly renames: { from: string; to: string }[];
  readonly spawns: FakeProcessRecord[];
  readonly runs: (readonly string[])[];
}

const encoder = new TextEncoder();

export function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function text(value: Uint8Array | undefined): string {
  return value === undefined ? "" : new TextDecoder().decode(value);
}

export function createFakeSystem(options: FakeSystemOptions = {}): FakeSystem {
  const files = new Map<string, Uint8Array>(options.files ?? []);
  const kinds = new Map<string, LiveProofPathKind>(options.kinds ?? []);
  const privateFiles = new Set<string>();
  const removed: string[] = [];
  const renames: { from: string; to: string }[] = [];
  const spawns: FakeProcessRecord[] = [];
  const runs: (readonly string[])[] = [];
  const scripts = [...(options.processes ?? [])];
  let clock = 1_000;
  let token = 0;

  const pathKindOf = (path: string): LiveProofPathKind => {
    const declared = kinds.get(path);
    if (declared !== undefined) return declared;
    return files.has(path) ? "file" : "missing";
  };

  const system: LiveProofSystem = {
    now: () => {
      clock += 1;
      return clock;
    },
    environment: () => ({ PATH: "/usr/bin", OPENAI_API_KEY: "secret" }),
    temporaryRoot: () => "/tmp",
    uniqueToken: () => {
      token += 1;
      return `token-${token}`;
    },
    spawn: (input): Result<LiveProofProcess, LiveProofSystemFailure> => {
      const script = scripts.shift() ?? { lines: [] };
      if (script.spawnFails === true) {
        return err(systemFailure("spawn-failed"));
      }
      const record: FakeProcessRecord = {
        input,
        written: [],
        terminations: 0,
        alive: true,
      };
      spawns.push(record);
      const process: LiveProofProcess = {
        writeLine: (line) => {
          record.written.push(line);
          return ok(undefined);
        },
        lines: () =>
          (async function* iterate(): AsyncIterable<string> {
            for (const line of script.lines) yield line;
            if (script.hang === true) {
              await new Promise<void>((resolveHang) =>
                setTimeout(resolveHang, 50),
              );
              yield "";
            }
          })(),
        terminate: () => {
          record.terminations += 1;
          if (script.survivesTermination !== true) record.alive = false;
          return okAsync(undefined);
        },
        running: () => record.alive,
      };
      return ok(process);
    },
    run: (input) => {
      runs.push(input.cmd);
      if (options.runFails === true) {
        return errAsync(systemFailure("cleanup-failed"));
      }
      return okAsync(
        options.runOutput ?? { exitCode: 0, stdout: "  No active lease.\n" },
      );
    },
    makeDirectory: () => okAsync(undefined),
    writeText: (path, value) => {
      files.set(path, bytes(value));
      return okAsync(undefined);
    },
    readBytes: (path) => {
      const value = files.get(path);
      return value === undefined
        ? errAsync(systemFailure("cleanup-failed"))
        : okAsync(value);
    },
    writeBytes: (path, value) => {
      if (options.failWriteBytes === true) {
        return errAsync(systemFailure("report-invalid"));
      }
      files.set(path, value);
      return okAsync(undefined);
    },
    createPrivateFile: (path) => {
      if (options.failCreatePrivateFile === true) {
        return errAsync(systemFailure("report-invalid"));
      }
      if (pathKindOf(path) !== "missing") {
        return errAsync(systemFailure("report-invalid"));
      }
      files.set(path, new Uint8Array());
      privateFiles.add(path);
      return okAsync(undefined);
    },
    renamePath: (from, to) => {
      if (options.failRename === true) {
        return errAsync(systemFailure("report-invalid"));
      }
      const value = files.get(from);
      if (value === undefined) {
        return errAsync(systemFailure("report-invalid"));
      }
      files.delete(from);
      files.set(to, value);
      renames.push({ from, to });
      return okAsync(undefined);
    },
    removePath: (path) => {
      removed.push(path);
      if (options.failRemove === true) {
        return errAsync(systemFailure("cleanup-failed"));
      }
      files.delete(path);
      privateFiles.delete(path);
      return okAsync(undefined);
    },
    pathKind: (path) => okAsync(pathKindOf(path)),
    delay: () => ResultAsync.fromSafePromise(Promise.resolve(undefined)),
  };

  return { system, files, privateFiles, removed, renames, spawns, runs };
}
