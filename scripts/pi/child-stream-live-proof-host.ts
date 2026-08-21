import { platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  cstr,
  ERRNO_EEXIST,
  ERRNO_ENOENT,
  type LoadedLibc,
  loadLibc,
  type PlatformFlags,
  platformFlags,
  withRestrictiveCreateMask,
} from "../../packages/engine/src/runtime/nofollow-ffi.js";
import {
  runBoundedProcess,
  spawnBoundedInteractiveProcess,
} from "./child-stream-live-proof-bounded-runner.js";
import {
  MAX_LIVE_PROOF_LINE_BYTES,
  readProcessLines,
} from "./child-stream-live-proof-bounded-stream.js";
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
const MAX_INTERACTIVE_INPUT_BYTES = MAX_LIVE_PROOF_LINE_BYTES;

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

/**
 * Interactive proof process seam. Its two pipes are consumed by the bounded
 * line iterator, and termination uses the same TERM/KILL deadlines as the
 * non-interactive runner. Non-interactive host commands must use runHostCommand.
 */
function bunSpawn(
  input: LiveProofSpawnInput,
): Result<LiveProofProcess, LiveProofSystemFailure> {
  const spawned = spawnBoundedInteractiveProcess(input);
  if (spawned.isErr()) return err(spawned.error);
  const child = spawned.value;
  return Result.fromThrowable(
    (): LiveProofProcess => ({
      writeLine: (line) =>
        Result.fromThrowable(
          () => {
            const stdin = child.stdin;
            if (
              stdin === undefined ||
              stdin === null ||
              typeof stdin === "number"
            ) {
              throw new Error("no stdin");
            }
            if (line.length > MAX_INTERACTIVE_INPUT_BYTES) {
              throw new Error("interactive input too large");
            }
            const encoded = new TextEncoder().encode(`${line}\n`);
            if (encoded.byteLength > MAX_INTERACTIVE_INPUT_BYTES) {
              throw new Error("interactive input too large");
            }
            const written = stdin.write(`${line}\n`);
            if (written !== undefined) {
              void Promise.resolve(written).catch(() => undefined);
            }
            const flushed = stdin.flush?.();
            if (flushed !== undefined) {
              void Promise.resolve(flushed).catch(() => undefined);
            }
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

function runHostCommand(
  cmd: readonly string[],
  code: LiveProofFailureCode,
): ResultAsync<
  { readonly exitCode: number; readonly stdout: string },
  LiveProofSystemFailure
> {
  return runBoundedProcess({
    cmd,
    cwd: ".",
    env: safeProofEnvironment(currentEnvironment()),
    limits: DEFAULT_BOUNDED_PROCESS_LIMITS,
  })
    .map(({ exitCode, stdout }) => ({ exitCode, stdout }))
    .mapErr(() => systemFailure(code));
}

type HostPathKind = "missing" | "file" | "symlink" | "other";

interface HostLibc {
  readonly loaded: LoadedLibc;
  readonly flags: PlatformFlags;
}

interface HostParentDirectory {
  readonly fd: number;
  readonly leaf: string;
}

const OWNER_FILE_MODE = 0o600;
const OWNER_DIRECTORY_MODE = 0o700;
const ERRNO_ELOOP = platform() === "darwin" ? 62 : 40;

/** O_NONBLOCK keeps path classification from opening a FIFO indefinitely. */
function hostNonBlockingFlag(): number {
  if (platform() === "darwin") return 0x0004;
  if (platform() === "linux") return 0x0800;
  return 0;
}

function loadHostLibc(
  code: LiveProofFailureCode,
): Result<HostLibc, LiveProofSystemFailure> {
  const flags = Result.fromThrowable(
    () => platformFlags(),
    () => undefined,
  )();
  if (flags.isErr() || flags.value === undefined) {
    return err(systemFailure(code));
  }
  const loaded = loadLibc();
  return loaded.isOk()
    ? ok({ loaded: loaded.value, flags: flags.value })
    : err(systemFailure(code));
}

function closeHostLibc(host: HostLibc): void {
  Result.fromThrowable(
    () => host.loaded.library.close(),
    () => undefined,
  )();
}

function closeHostFd(host: HostLibc, fd: number): void {
  Result.fromThrowable(
    () => host.loaded.symbols.close(fd),
    () => undefined,
  )();
}

function absoluteHostPath(path: string): string {
  if (path.includes("\0")) throw new Error("invalid host path");
  const normalized = resolve(path);
  // macOS exposes the system temporary directory through the `/var` and
  // `/tmp` compatibility symlinks. Use their stable physical prefixes before
  // the no-follow walk so the walk still rejects every caller-controlled hop.
  if (platform() === "darwin") {
    if (normalized === "/var" || normalized.startsWith("/var/")) {
      return `/private${normalized}`;
    }
    if (normalized === "/tmp" || normalized.startsWith("/tmp/")) {
      return `/private${normalized}`;
    }
  }
  return normalized;
}

function failHostFilesystem(): never {
  throw new Error("host filesystem operation failed");
}

function hostErrno(host: HostLibc): number {
  return Result.fromThrowable(
    () => host.loaded.readErrno(),
    () => -1,
  )().unwrapOr(-1);
}

function openDirectoryPath(host: HostLibc, path: string): number {
  const normalized = absoluteHostPath(path);
  const { flags, loaded } = host;
  const { symbols } = loaded;
  const directoryFlags =
    flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW | flags.O_CLOEXEC;
  const rootFd = symbols.open(cstr("/"), directoryFlags, 0);
  if (rootFd < 0) failHostFilesystem();
  let currentFd = rootFd;
  try {
    const segments = normalized.slice(1).split("/").filter(Boolean);
    for (const segment of segments) {
      let childFd = symbols.openat(currentFd, cstr(segment), directoryFlags, 0);
      let created = false;
      if (childFd < 0) {
        const errno = hostErrno(host);
        if (errno !== ERRNO_ENOENT) failHostFilesystem();
        const made = symbols.mkdirat(
          currentFd,
          cstr(segment),
          OWNER_DIRECTORY_MODE,
        );
        if (made !== 0 && hostErrno(host) !== ERRNO_EEXIST) {
          failHostFilesystem();
        }
        childFd = symbols.openat(currentFd, cstr(segment), directoryFlags, 0);
        if (childFd < 0) failHostFilesystem();
        created = made === 0;
      }
      if (created && symbols.fchmod(childFd, OWNER_DIRECTORY_MODE) !== 0) {
        closeHostFd(host, childFd);
        failHostFilesystem();
      }
      closeHostFd(host, currentFd);
      currentFd = childFd;
    }
    return currentFd;
  } catch (cause) {
    closeHostFd(host, currentFd);
    throw cause;
  }
}

function openParentDirectory(
  host: HostLibc,
  path: string,
): HostParentDirectory {
  const normalized = absoluteHostPath(path);
  const leaf = basename(normalized);
  if (leaf.length === 0 || leaf === "." || leaf === "..") {
    failHostFilesystem();
  }
  return { fd: openDirectoryPath(host, dirname(normalized)), leaf };
}

function openLeafNoFollow(
  host: HostLibc,
  path: string,
  flags: number,
  mode: number,
  exclusive: boolean,
): { readonly fd: number; readonly parent: HostParentDirectory } {
  const parent = openParentDirectory(host, path);
  const { symbols } = host.loaded;
  let fd: number;
  try {
    fd = exclusive
      ? withRestrictiveCreateMask(symbols, () =>
          symbols.openat(parent.fd, cstr(parent.leaf), flags, mode),
        )
      : symbols.openat(parent.fd, cstr(parent.leaf), flags, mode);
  } catch (cause) {
    closeHostFd(host, parent.fd);
    throw cause;
  }
  if (fd < 0) {
    closeHostFd(host, parent.fd);
    failHostFilesystem();
  }
  return { fd, parent };
}

async function inspectPathNoFollow(
  host: HostLibc,
  path: string,
): Promise<HostPathKind> {
  const { flags, loaded } = host;
  const openedParent = openParentDirectory(host, path);
  let fd: number | undefined;
  try {
    fd = loaded.symbols.openat(
      openedParent.fd,
      cstr(openedParent.leaf),
      flags.O_RDONLY |
        flags.O_NOFOLLOW |
        flags.O_CLOEXEC |
        hostNonBlockingFlag(),
      0,
    );
    if (fd < 0) {
      const errno = hostErrno(host);
      if (errno === ERRNO_ENOENT) return "missing";
      if (errno === ERRNO_ELOOP) return "symlink";
      return "other";
    }
    const stat = await Bun.file(fd).stat();
    return stat.isFile() ? "file" : "other";
  } finally {
    if (fd !== undefined) closeHostFd(host, fd);
    closeHostFd(host, openedParent.fd);
  }
}

function pathKindHost(
  path: string,
): ResultAsync<HostPathKind, LiveProofSystemFailure> {
  const host = loadHostLibc("report-invalid");
  if (host.isErr()) return errAsync(host.error);
  return ResultAsync.fromThrowable(
    async () => {
      try {
        return await inspectPathNoFollow(host.value, path);
      } finally {
        closeHostLibc(host.value);
      }
    },
    (): LiveProofSystemFailure => systemFailure("report-invalid"),
  )();
}

function createPrivateFileHost(
  path: string,
): ResultAsync<void, LiveProofSystemFailure> {
  const host = loadHostLibc("report-invalid");
  if (host.isErr()) return errAsync(host.error);
  return ResultAsync.fromThrowable(
    async () => {
      let opened: ReturnType<typeof openLeafNoFollow> | undefined;
      let verified = false;
      try {
        opened = openLeafNoFollow(
          host.value,
          path,
          host.value.flags.O_RDWR |
            host.value.flags.O_CREAT |
            host.value.flags.O_EXCL |
            host.value.flags.O_NOFOLLOW |
            host.value.flags.O_CLOEXEC,
          OWNER_FILE_MODE,
          true,
        );
        if (
          host.value.loaded.symbols.fchmod(opened.fd, OWNER_FILE_MODE) !== 0
        ) {
          failHostFilesystem();
        }
        const stat = await Bun.file(opened.fd).stat();
        if (!stat.isFile() || (stat.mode & 0o7777) !== OWNER_FILE_MODE) {
          failHostFilesystem();
        }
        verified = true;
      } finally {
        const created = opened;
        if (created !== undefined) {
          closeHostFd(host.value, created.fd);
          if (!verified) {
            Result.fromThrowable(
              () =>
                host.value.loaded.symbols.unlinkat(
                  created.parent.fd,
                  cstr(created.parent.leaf),
                  0,
                ),
              () => undefined,
            )();
          }
          closeHostFd(host.value, created.parent.fd);
        }
        closeHostLibc(host.value);
      }
    },
    (): LiveProofSystemFailure => systemFailure("report-invalid"),
  )().map(() => undefined);
}

function readBytesHost(
  path: string,
): ResultAsync<Uint8Array, LiveProofSystemFailure> {
  const host = loadHostLibc("cleanup-failed");
  if (host.isErr()) return errAsync(host.error);
  return ResultAsync.fromThrowable(
    async () => {
      let opened: ReturnType<typeof openLeafNoFollow> | undefined;
      try {
        opened = openLeafNoFollow(
          host.value,
          path,
          host.value.flags.O_RDONLY |
            host.value.flags.O_NOFOLLOW |
            host.value.flags.O_CLOEXEC |
            hostNonBlockingFlag(),
          0,
          false,
        );
        const file = Bun.file(opened.fd);
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_GUARDED_BYTES) {
          failHostFilesystem();
        }
        const bytes = await file.slice(0, MAX_GUARDED_BYTES + 1).arrayBuffer();
        if (bytes.byteLength > MAX_GUARDED_BYTES) failHostFilesystem();
        return new Uint8Array(bytes);
      } finally {
        if (opened !== undefined) {
          closeHostFd(host.value, opened.fd);
          closeHostFd(host.value, opened.parent.fd);
        }
        closeHostLibc(host.value);
      }
    },
    (): LiveProofSystemFailure => systemFailure("cleanup-failed"),
  )();
}

function writeAllHost(host: HostLibc, fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = host.loaded.symbols.write(
      fd,
      bytes.subarray(offset),
      bytes.byteLength - offset,
    );
    if (written <= 0) failHostFilesystem();
    offset += written;
  }
}

async function writeAtomicNoFollow(
  host: HostLibc,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const parent = openParentDirectory(host, path);
  const { flags, loaded } = host;
  let temporary: string | undefined;
  let tempFd: number | undefined;
  let tempCreated = false;
  let tempClosed = false;
  let renamed = false;
  try {
    const generatedTemporary = `.${parent.leaf}.${crypto.randomUUID()}.tmp`;
    temporary = generatedTemporary;
    tempFd = withRestrictiveCreateMask(loaded.symbols, () =>
      loaded.symbols.openat(
        parent.fd,
        cstr(generatedTemporary),
        flags.O_RDWR |
          flags.O_CREAT |
          flags.O_EXCL |
          flags.O_TRUNC |
          flags.O_NOFOLLOW |
          flags.O_CLOEXEC,
        OWNER_FILE_MODE,
      ),
    );
    if (tempFd < 0) failHostFilesystem();
    tempCreated = true;
    if (loaded.symbols.fchmod(tempFd, OWNER_FILE_MODE) !== 0) {
      failHostFilesystem();
    }
    const stat = await Bun.file(tempFd).stat();
    if (!stat.isFile() || (stat.mode & 0o7777) !== OWNER_FILE_MODE) {
      failHostFilesystem();
    }
    writeAllHost(host, tempFd, bytes);
    if (loaded.symbols.fsync(tempFd) !== 0) failHostFilesystem();
    closeHostFd(host, tempFd);
    tempClosed = true;
    if (
      loaded.symbols.renameat(
        parent.fd,
        cstr(temporary),
        parent.fd,
        cstr(parent.leaf),
      ) !== 0
    ) {
      failHostFilesystem();
    }
    renamed = true;
  } finally {
    if (!tempClosed && tempFd !== undefined) closeHostFd(host, tempFd);
    const cleanupTemporary = temporary;
    if (tempCreated && !renamed && cleanupTemporary !== undefined) {
      Result.fromThrowable(
        () => loaded.symbols.unlinkat(parent.fd, cstr(cleanupTemporary), 0),
        () => undefined,
      )();
    }
    closeHostFd(host, parent.fd);
  }
}

function writeFileHost(
  path: string,
  bytes: Uint8Array,
  code: LiveProofFailureCode,
): ResultAsync<void, LiveProofSystemFailure> {
  if (bytes.byteLength > MAX_GUARDED_BYTES) {
    return errAsync(systemFailure(code));
  }
  return pathKindHost(path)
    .andThen((kind) =>
      kind === "missing" || kind === "file"
        ? okAsync<void, LiveProofSystemFailure>(undefined)
        : errAsync(systemFailure(code)),
    )
    .andThen(() => {
      const host = loadHostLibc(code);
      if (host.isErr()) return errAsync(host.error);
      return ResultAsync.fromThrowable(
        async () => {
          try {
            await writeAtomicNoFollow(host.value, path, bytes);
          } finally {
            closeHostLibc(host.value);
          }
        },
        (): LiveProofSystemFailure => systemFailure(code),
      )().map(() => undefined);
    });
}

function encodeBoundedText(
  text: string,
  code: LiveProofFailureCode,
): Result<Uint8Array, LiveProofSystemFailure> {
  if (text.length > MAX_GUARDED_BYTES) return err(systemFailure(code));
  const target = new Uint8Array(MAX_GUARDED_BYTES + 1);
  const encoded = Result.fromThrowable(
    () => new TextEncoder().encodeInto(text, target),
    (): LiveProofSystemFailure => systemFailure(code),
  )();
  if (
    encoded.isErr() ||
    encoded.value.read !== text.length ||
    encoded.value.written > MAX_GUARDED_BYTES
  ) {
    return err(systemFailure(code));
  }
  return ok(target.slice(0, encoded.value.written));
}

function writeTextHost(
  path: string,
  text: string,
  code: LiveProofFailureCode,
): ResultAsync<void, LiveProofSystemFailure> {
  const encoded = encodeBoundedText(text, code);
  return encoded.isErr()
    ? errAsync(encoded.error)
    : writeFileHost(path, encoded.value, code);
}

function makeDirectoryHost(
  path: string,
): ResultAsync<void, LiveProofSystemFailure> {
  const host = loadHostLibc("spawn-failed");
  if (host.isErr()) return errAsync(host.error);
  return ResultAsync.fromThrowable(
    async () => {
      try {
        const fd = openDirectoryPath(host.value, path);
        closeHostFd(host.value, fd);
      } finally {
        closeHostLibc(host.value);
      }
    },
    (): LiveProofSystemFailure => systemFailure("spawn-failed"),
  )().map(() => undefined);
}

function renamePathHost(
  from: string,
  to: string,
): ResultAsync<void, LiveProofSystemFailure> {
  const host = loadHostLibc("report-invalid");
  if (host.isErr()) return errAsync(host.error);
  return ResultAsync.fromThrowable(
    async () => {
      try {
        const source = openParentDirectory(host.value, from);
        let destination: HostParentDirectory | undefined;
        try {
          destination = openParentDirectory(host.value, to);
          if (
            host.value.loaded.symbols.renameat(
              source.fd,
              cstr(source.leaf),
              destination.fd,
              cstr(destination.leaf),
            ) !== 0
          ) {
            failHostFilesystem();
          }
        } finally {
          closeHostFd(host.value, source.fd);
          if (destination !== undefined) {
            closeHostFd(host.value, destination.fd);
          }
        }
      } finally {
        closeHostLibc(host.value);
      }
    },
    (): LiveProofSystemFailure => systemFailure("report-invalid"),
  )().map(() => undefined);
}

function unlinkPathHost(
  path: string,
): ResultAsync<void, LiveProofSystemFailure> {
  const host = loadHostLibc("cleanup-failed");
  if (host.isErr()) return errAsync(host.error);
  return ResultAsync.fromThrowable(
    async () => {
      try {
        const parent = openParentDirectory(host.value, path);
        try {
          const removed = host.value.loaded.symbols.unlinkat(
            parent.fd,
            cstr(parent.leaf),
            0,
          );
          if (removed !== 0 && hostErrno(host.value) !== ERRNO_ENOENT) {
            failHostFilesystem();
          }
        } finally {
          closeHostFd(host.value, parent.fd);
        }
      } finally {
        closeHostLibc(host.value);
      }
    },
    (): LiveProofSystemFailure => systemFailure("cleanup-failed"),
  )().map(() => undefined);
}

function removePathHost(
  path: string,
): ResultAsync<void, LiveProofSystemFailure> {
  return pathKindHost(path).andThen((kind) => {
    if (kind === "missing") {
      return okAsync<void, LiveProofSystemFailure>(undefined);
    }
    if (kind === "file" || kind === "symlink") return unlinkPathHost(path);
    // Recursive directory removal has no Bun descriptor API. Keep this one
    // fallback behind the same bounded runner; the argv form does not invoke a
    // shell and `rm` never follows a symlink passed as its final argument.
    return runHostCommand(
      ["/bin/rm", "-rf", "--", path],
      "cleanup-failed",
    ).andThen(({ exitCode }) =>
      exitCode === 0
        ? okAsync<void, LiveProofSystemFailure>(undefined)
        : errAsync(systemFailure("cleanup-failed")),
    );
  });
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
    makeDirectory: makeDirectoryHost,
    writeText: (path, text) => writeTextHost(path, text, "spawn-failed"),
    readBytes: readBytesHost,
    writeBytes: (path, bytes) => writeFileHost(path, bytes, "cleanup-failed"),
    createPrivateFile: createPrivateFileHost,
    renamePath: renamePathHost,
    removePath: removePathHost,
    pathKind: pathKindHost,
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
