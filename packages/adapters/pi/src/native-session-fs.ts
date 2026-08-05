/**
 * The production no-follow filesystem port for Weave-owned native Pi child
 * sessions.
 *
 * Native session storage is defined against the structural
 * {@link PiNativeSessionFsPort} so tests can supply an in-memory fake. This
 * module owns the one production implementation: real `openat(O_NOFOLLOW)`
 * directory handles with 0700 directories and 0600 files, plus the in-memory
 * fake used by tests.
 */

import { dlopen, ptr, read } from "bun:ffi";
import { platform } from "node:os";
import { isAbsolute } from "node:path";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import type {
  PiNativeSessionDirectory,
  PiNativeSessionFsError,
  PiNativeSessionFsPort,
} from "./child-native-sessions.js";

/** Device/inode/mode triple used to bind a handle to one filesystem node. */
interface NodeIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

const textEncoder = new TextEncoder();

function safeName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

function sameIdentity(left: NodeIdentity, right: NodeIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isFsError(value: unknown): value is PiNativeSessionFsError {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (
    type === "relative-xdg-data-home" ||
    type === "empty-home" ||
    type === "unsafe-path" ||
    type === "unavailable" ||
    type === "missing" ||
    type === "symlink-rejected" ||
    type === "identity-changed" ||
    type === "permissive-mode" ||
    type === "wrong-kind" ||
    type === "io"
  );
}

function mapThrownError(value: unknown): PiNativeSessionFsError {
  return isFsError(value) ? value : { type: "io" };
}

function fsErrAsync<T = never>(
  error: PiNativeSessionFsError,
): ResultAsync<T, PiNativeSessionFsError> {
  return errAsync<T, PiNativeSessionFsError>(error);
}

function fsVoidAsync(): ResultAsync<void, PiNativeSessionFsError> {
  return okAsync<void, PiNativeSessionFsError>(undefined);
}

async function unwrapResult<T, E>(result: ResultAsync<T, E>): Promise<T> {
  const settled = await result;
  if (settled.isErr()) throw settled.error;
  return settled.value;
}

interface NativeFlags {
  readonly O_RDONLY: number;
  readonly O_RDWR: number;
  readonly O_CREAT: number;
  readonly O_EXCL: number;
  readonly O_TRUNC: number;
  readonly O_APPEND: number;
  readonly O_DIRECTORY: number;
  readonly O_NOFOLLOW: number;
  readonly O_CLOEXEC: number;
  readonly AT_FDCWD: number;
}

interface NativeLibc {
  readonly flags: NativeFlags;
  readonly open: (path: Uint8Array, flags: number, mode: number) => number;
  readonly openat: (
    dir: number,
    path: Uint8Array,
    flags: number,
    mode: number,
  ) => number;
  readonly mkdirat: (dir: number, path: Uint8Array, mode: number) => number;
  readonly close: (fd: number) => number;
  readonly fchmod: (fd: number, mode: number) => number;
  readonly write: (fd: number, bytes: Uint8Array, count: number) => number;
  readonly fsync: (fd: number) => number;
  readonly renameat: (
    oldDir: number,
    oldName: Uint8Array,
    newDir: number,
    newName: Uint8Array,
  ) => number;
  readonly unlinkat: (dir: number, name: Uint8Array, flags: number) => number;
  readonly errno: () => number;
  readonly dispose: () => void;
}

const ERRNO_ENOENT = 2;
const ERRNO_EEXIST = 17;

function nativeFlags(): NativeFlags | undefined {
  if (platform() === "darwin") {
    return {
      O_RDONLY: 0,
      O_RDWR: 2,
      O_CREAT: 0x200,
      O_EXCL: 0x800,
      O_TRUNC: 0x400,
      O_APPEND: 8,
      O_DIRECTORY: 0x100000,
      O_NOFOLLOW: 0x100,
      O_CLOEXEC: 0x1000000,
      AT_FDCWD: -2,
    };
  }
  if (platform() === "linux") {
    return {
      O_RDONLY: 0,
      O_RDWR: 2,
      O_CREAT: 0x40,
      O_EXCL: 0x80,
      O_TRUNC: 0x200,
      O_APPEND: 0x400,
      O_DIRECTORY: 0x10000,
      O_NOFOLLOW: 0x20000,
      O_CLOEXEC: 0x80000,
      AT_FDCWD: -100,
    };
  }
  return undefined;
}

function loadNative(): Result<NativeLibc, PiNativeSessionFsError> {
  const flags = nativeFlags();
  let libraryPath: string | undefined;
  let errnoName: string | undefined;
  if (platform() === "darwin") {
    libraryPath = "/usr/lib/libSystem.B.dylib";
    errnoName = "__error";
  } else if (platform() === "linux") {
    libraryPath = "libc.so.6";
    errnoName = "__errno_location";
  }
  if (
    flags === undefined ||
    libraryPath === undefined ||
    errnoName === undefined
  ) {
    return err({ type: "unavailable", operation: "open" });
  }

  return Result.fromThrowable(
    () =>
      dlopen(libraryPath, {
        open: { args: ["ptr", "i32", "i32"], returns: "i32" },
        openat: { args: ["i32", "ptr", "i32", "i32"], returns: "i32" },
        mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
        close: { args: ["i32"], returns: "i32" },
        fchmod: { args: ["i32", "i32"], returns: "i32" },
        write: { args: ["i32", "ptr", "i32"], returns: "i32" },
        fsync: { args: ["i32"], returns: "i32" },
        renameat: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" },
        unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
        [errnoName]: { args: [], returns: "ptr" },
      }),
    () => ({ type: "unavailable", operation: "open" }) as const,
  )().map((library) => {
    const symbols = library.symbols as unknown as {
      open: (path: unknown, flags: number, mode: number) => number;
      openat: (
        dir: number,
        path: unknown,
        flags: number,
        mode: number,
      ) => number;
      mkdirat: (dir: number, path: unknown, mode: number) => number;
      close: (fd: number) => number;
      fchmod: (fd: number, mode: number) => number;
      write: (fd: number, bytes: unknown, count: number) => number;
      fsync: (fd: number) => number;
      renameat: (
        oldDir: number,
        oldName: unknown,
        newDir: number,
        newName: unknown,
      ) => number;
      unlinkat: (dir: number, name: unknown, flags: number) => number;
      [key: string]: unknown;
    };
    return {
      flags,
      open: (path: Uint8Array, openFlags: number, mode: number) =>
        symbols.open(ptr(path), openFlags, mode),
      openat: (
        dir: number,
        path: Uint8Array,
        openFlags: number,
        mode: number,
      ) => symbols.openat(dir, ptr(path), openFlags, mode),
      mkdirat: (dir: number, path: Uint8Array, mode: number) =>
        symbols.mkdirat(dir, ptr(path), mode),
      close: (fd: number) => symbols.close(fd),
      fchmod: (fd: number, mode: number) => symbols.fchmod(fd, mode),
      write: (fd: number, bytes: Uint8Array, count: number) =>
        symbols.write(fd, ptr(bytes), count),
      fsync: (fd: number) => symbols.fsync(fd),
      renameat: (
        oldDir: number,
        oldName: Uint8Array,
        newDir: number,
        newName: Uint8Array,
      ) => symbols.renameat(oldDir, ptr(oldName), newDir, ptr(newName)),
      unlinkat: (dir: number, name: Uint8Array, unlinkFlags: number) =>
        symbols.unlinkat(dir, ptr(name), unlinkFlags),
      errno: () =>
        read.i32((symbols[errnoName] as () => unknown)() as never, 0),
      dispose: () => library.close(),
    } satisfies NativeLibc;
  });
}

function cstr(value: string): Uint8Array {
  return textEncoder.encode(`${value}\0`);
}

function absoluteSegments(
  path: string,
): Result<readonly string[], PiNativeSessionFsError> {
  if (!isAbsolute(path)) return err({ type: "unsafe-path" });
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (
    segments.some(
      (segment) => segment === "." || segment === ".." || !safeName(segment),
    )
  ) {
    return err({ type: "unsafe-path" });
  }
  return ok(segments);
}

function statFd(
  fd: number,
  kind: "directory" | "file",
  expectedMode: number,
): ResultAsync<NodeIdentity, PiNativeSessionFsError> {
  return ResultAsync.fromThrowable(
    () => Bun.file(fd).stat(),
    () => ({ type: "io" }) as const,
  )().andThen((stat) => {
    if (
      (kind === "directory" && !stat.isDirectory()) ||
      (kind === "file" && !stat.isFile())
    ) {
      return errAsync<NodeIdentity, PiNativeSessionFsError>({
        type: "wrong-kind",
        kind,
      });
    }
    const mode = stat.mode & 0o7777;
    if (mode !== expectedMode) {
      return errAsync<NodeIdentity, PiNativeSessionFsError>({
        type: "permissive-mode",
        kind,
      });
    }
    return okAsync<NodeIdentity, PiNativeSessionFsError>({
      dev: stat.dev,
      ino: stat.ino,
      mode,
    });
  });
}

/**
 * Walks a path without following symlinks. Existing nodes are checked, never
 * repaired. Only a component created by this call is chmoded to 0700.
 */
function openDirectoryChain(
  libc: NativeLibc,
  path: string,
  create: boolean,
  mode: number,
): ResultAsync<number, PiNativeSessionFsError> {
  const segments = absoluteSegments(path);
  if (segments.isErr()) return errAsync(segments.error);

  return ResultAsync.fromThrowable(async () => {
    let current = libc.open(
      cstr("/"),
      libc.flags.O_RDONLY |
        libc.flags.O_DIRECTORY |
        libc.flags.O_NOFOLLOW |
        libc.flags.O_CLOEXEC,
      0,
    );
    if (current < 0) throw { type: "unavailable", operation: "open" };

    try {
      for (const segment of segments.value) {
        let created = false;
        let next = libc.openat(
          current,
          cstr(segment),
          libc.flags.O_RDONLY |
            libc.flags.O_DIRECTORY |
            libc.flags.O_NOFOLLOW |
            libc.flags.O_CLOEXEC,
          0,
        );
        if (next < 0 && create && libc.errno() === ERRNO_ENOENT) {
          const mkdirResult = libc.mkdirat(current, cstr(segment), mode);
          if (mkdirResult !== 0) {
            const mkdirError = libc.errno();
            if (mkdirError !== ERRNO_EEXIST) {
              throw { type: "io" };
            }
          } else {
            created = true;
          }
          next = libc.openat(
            current,
            cstr(segment),
            libc.flags.O_RDONLY |
              libc.flags.O_DIRECTORY |
              libc.flags.O_NOFOLLOW |
              libc.flags.O_CLOEXEC,
            0,
          );
        }
        if (next < 0) {
          throw {
            type:
              libc.errno() === ERRNO_ENOENT ? "missing" : "symlink-rejected",
          };
        }
        if (created && libc.fchmod(next, mode) !== 0) {
          libc.close(next);
          throw { type: "io" };
        }
        libc.close(current);
        current = next;
      }
      return current;
    } catch (cause) {
      libc.close(current);
      throw cause;
    }
  }, mapThrownError)();
}

class BunNativeSessionDirectory implements PiNativeSessionDirectory {
  constructor(
    readonly path: string,
    private readonly libc: NativeLibc,
    private readonly fd: number,
    private readonly bound: NodeIdentity,
  ) {}

  private readonly fileBounds = new Map<string, NodeIdentity>();

  private checkFileIdentity(
    name: string,
    identity: NodeIdentity | undefined,
  ): Result<NodeIdentity | undefined, PiNativeSessionFsError> {
    const bound = this.fileBounds.get(name);
    if (identity === undefined) {
      return bound === undefined
        ? ok(undefined)
        : err({ type: "identity-changed" });
    }
    if (bound !== undefined && !sameIdentity(bound, identity)) {
      return err({ type: "identity-changed" });
    }
    if (bound === undefined) this.fileBounds.set(name, identity);
    return ok(identity);
  }

  identity(): ResultAsync<NodeIdentity, PiNativeSessionFsError> {
    return statFd(this.fd, "directory", 0o700).andThen((held) => {
      if (!sameIdentity(held, this.bound)) {
        return errAsync<NodeIdentity, PiNativeSessionFsError>({
          type: "identity-changed",
        });
      }
      return openDirectoryChain(this.libc, this.path, false, 0o700).andThen(
        (fresh) =>
          statFd(fresh, "directory", 0o700)
            .map((identity) => {
              this.libc.close(fresh);
              return identity;
            })
            .mapErr((error) => {
              this.libc.close(fresh);
              return error;
            })
            .andThen((identity) =>
              sameIdentity(identity, held)
                ? okAsync<NodeIdentity, PiNativeSessionFsError>(held)
                : errAsync<NodeIdentity, PiNativeSessionFsError>({
                    type: "identity-changed",
                  }),
            ),
      );
    });
  }

  private name(name: string): Result<string, PiNativeSessionFsError> {
    return safeName(name) ? ok(name) : err({ type: "unsafe-path" });
  }

  private targetIdentity(
    name: string,
  ): ResultAsync<NodeIdentity | undefined, PiNativeSessionFsError> {
    const fd = this.libc.openat(
      this.fd,
      cstr(name),
      this.libc.flags.O_RDONLY |
        this.libc.flags.O_NOFOLLOW |
        this.libc.flags.O_CLOEXEC,
      0,
    );
    if (fd < 0) {
      return this.libc.errno() === ERRNO_ENOENT
        ? okAsync<NodeIdentity | undefined, PiNativeSessionFsError>(undefined)
        : errAsync({ type: "symlink-rejected" });
    }
    return statFd(fd, "file", 0o600)
      .map((identity) => {
        this.libc.close(fd);
        return identity;
      })
      .mapErr((error) => {
        this.libc.close(fd);
        return error;
      });
  }

  private checkedTargetIdentity(
    name: string,
  ): ResultAsync<NodeIdentity | undefined, PiNativeSessionFsError> {
    return this.targetIdentity(name).andThen((identity) => {
      const checked = this.checkFileIdentity(name, identity);
      return checked.isErr() ? errAsync(checked.error) : okAsync(checked.value);
    });
  }

  readFile(
    name: string,
  ): ResultAsync<Uint8Array | undefined, PiNativeSessionFsError> {
    const checked = this.name(name);
    if (checked.isErr()) return errAsync(checked.error);
    return this.identity().andThen(() => {
      const file = this.libc.openat(
        this.fd,
        cstr(checked.value),
        this.libc.flags.O_RDONLY |
          this.libc.flags.O_NOFOLLOW |
          this.libc.flags.O_CLOEXEC,
        0,
      );
      if (file < 0) {
        if (this.libc.errno() === ERRNO_ENOENT) {
          return okAsync<Uint8Array | undefined, PiNativeSessionFsError>(
            undefined,
          );
        }
        return fsErrAsync<Uint8Array | undefined>({
          type: "symlink-rejected",
        });
      }
      return statFd(file, "file", 0o600)
        .andThen((fileIdentity) =>
          ResultAsync.fromThrowable(
            () => Bun.file(file).bytes(),
            () => ({ type: "io" }) as const,
          )().map((bytes) => ({ bytes, fileIdentity })),
        )
        .map((result) => {
          this.libc.close(file);
          return result;
        })
        .mapErr((error) => {
          this.libc.close(file);
          return error;
        })
        .andThen(({ bytes, fileIdentity }) =>
          this.identity()
            .andThen(() => {
              const checkedFile = this.checkFileIdentity(
                checked.value,
                fileIdentity,
              );
              return checkedFile.isErr()
                ? errAsync(checkedFile.error)
                : okAsync(checkedFile.value);
            })
            .andThen(() => this.targetIdentity(checked.value))
            .andThen((current) =>
              current !== undefined && sameIdentity(fileIdentity, current)
                ? okAsync<Uint8Array, PiNativeSessionFsError>(bytes)
                : errAsync<Uint8Array, PiNativeSessionFsError>({
                    type: "identity-changed",
                  }),
            ),
        );
    });
  }

  private appendValidated(
    name: string,
    bytes: Uint8Array,
  ): ResultAsync<void, PiNativeSessionFsError> {
    return ResultAsync.fromThrowable(async () => {
      let fd = this.libc.openat(
        this.fd,
        cstr(name),
        this.libc.flags.O_RDWR |
          this.libc.flags.O_APPEND |
          this.libc.flags.O_NOFOLLOW |
          this.libc.flags.O_CLOEXEC,
        0,
      );
      let created = false;
      if (fd < 0) {
        if (this.libc.errno() !== ERRNO_ENOENT)
          throw { type: "symlink-rejected" };
        fd = this.libc.openat(
          this.fd,
          cstr(name),
          this.libc.flags.O_RDWR |
            this.libc.flags.O_CREAT |
            this.libc.flags.O_EXCL |
            this.libc.flags.O_APPEND |
            this.libc.flags.O_NOFOLLOW |
            this.libc.flags.O_CLOEXEC,
          0,
        );
        if (fd < 0) throw { type: "io" };
        created = true;
        if (this.libc.fchmod(fd, 0o600) !== 0) {
          this.libc.close(fd);
          this.libc.unlinkat(this.fd, cstr(name), 0);
          throw { type: "io" };
        }
      }

      let closed = false;
      try {
        const fileIdentity = await unwrapResult(statFd(fd, "file", 0o600));
        const checkedFile = this.checkFileIdentity(name, fileIdentity);
        if (checkedFile.isErr()) throw checkedFile.error;
        let offset = 0;
        while (offset < bytes.length) {
          const count = this.libc.write(
            fd,
            bytes.subarray(offset),
            bytes.length - offset,
          );
          if (count <= 0) throw { type: "io" };
          offset += count;
        }
        if (this.libc.fsync(fd) !== 0) throw { type: "io" };
        if (this.libc.close(fd) !== 0) throw { type: "io" };
        closed = true;

        await unwrapResult(this.identity());
        const current = await unwrapResult(this.targetIdentity(name));
        if (current === undefined || !sameIdentity(fileIdentity, current)) {
          throw { type: "identity-changed" };
        }
      } finally {
        if (!closed) this.libc.close(fd);
        if (created && !closed) this.libc.unlinkat(this.fd, cstr(name), 0);
      }
    }, mapThrownError)().map(() => undefined);
  }

  appendFile(
    name: string,
    bytes: Uint8Array,
    mode: number,
  ): ResultAsync<void, PiNativeSessionFsError> {
    const checked = this.name(name);
    if (checked.isErr()) return errAsync(checked.error);
    if (mode !== 0o600) {
      return errAsync({ type: "permissive-mode", kind: "file" });
    }
    return this.identity().andThen(() =>
      this.appendValidated(checked.value, bytes),
    );
  }

  deleteFile(name: string): ResultAsync<void, PiNativeSessionFsError> {
    const checked = this.name(name);
    if (checked.isErr()) return errAsync(checked.error);
    return this.identity()
      .andThen(() => this.checkedTargetIdentity(checked.value))
      .andThen((target) => {
        if (target === undefined) return fsVoidAsync();
        return this.identity()
          .andThen(() => this.targetIdentity(checked.value))
          .andThen((current) => {
            if (current === undefined || !sameIdentity(target, current)) {
              return fsErrAsync<void>({ type: "identity-changed" });
            }
            const result = this.libc.unlinkat(this.fd, cstr(checked.value), 0);
            if (result === 0 || this.libc.errno() === ERRNO_ENOENT) {
              this.fileBounds.delete(checked.value);
              return fsVoidAsync();
            }
            return fsErrAsync<void>({ type: "io" });
          });
      });
  }

  close(): void {
    this.libc.close(this.fd);
    this.libc.dispose();
  }
}

class BunPiNativeSessionFs implements PiNativeSessionFsPort {
  openDirectory(
    path: string,
    create: boolean,
  ): ResultAsync<PiNativeSessionDirectory, PiNativeSessionFsError> {
    const loaded = loadNative();
    if (loaded.isErr()) return errAsync(loaded.error);
    return openDirectoryChain(loaded.value, path, create, 0o700)
      .andThen((fd) =>
        statFd(fd, "directory", 0o700)
          .map(
            (identity) =>
              new BunNativeSessionDirectory(path, loaded.value, fd, identity),
          )
          .mapErr((error) => {
            loaded.value.close(fd);
            return error;
          }),
      )
      .mapErr((error) => {
        loaded.value.dispose();
        return error;
      });
  }
}

export { BunPiNativeSessionFs };

interface MemoryFileData {
  identity: NodeIdentity;
  mode: number;
  symlink: boolean;
  kind: "file" | "directory";
  bytes: Uint8Array;
}

interface MemoryDirectoryData {
  readonly path: string;
  identity: NodeIdentity;
  symlink: boolean;
  files: Map<string, MemoryFileData>;
}

let memoryInode = 10_000;
function nextMemoryIdentity(mode = 0o700): NodeIdentity {
  memoryInode += 1;
  return { dev: 1, ino: memoryInode, mode };
}

export class MemoryPiNativeSessionFs implements PiNativeSessionFsPort {
  private readonly directories = new Map<string, MemoryDirectoryData>();
  private readonly replaced = new Set<string>();

  openDirectory(
    path: string,
    create: boolean,
  ): ResultAsync<PiNativeSessionDirectory, PiNativeSessionFsError> {
    if (!isAbsolute(path)) return errAsync({ type: "unsafe-path" });
    let data = this.directories.get(path);
    if (data === undefined && create) {
      data = {
        path,
        identity: nextMemoryIdentity(),
        symlink: false,
        files: new Map(),
      };
      this.directories.set(path, data);
    }
    if (data === undefined) return errAsync({ type: "missing" });
    if (data.symlink) return errAsync({ type: "symlink-rejected" });
    const bound = data.identity;
    const fs = this;
    const fileBounds = new Map<string, NodeIdentity>();
    let closed = false;

    const checkFileIdentity = (
      name: string,
      identity: NodeIdentity | undefined,
    ): Result<NodeIdentity | undefined, PiNativeSessionFsError> => {
      const known = fileBounds.get(name);
      if (identity === undefined) {
        return known === undefined
          ? ok(undefined)
          : err({ type: "identity-changed" });
      }
      if (known !== undefined && !sameIdentity(known, identity)) {
        return err({ type: "identity-changed" });
      }
      if (known === undefined) fileBounds.set(name, identity);
      return ok(identity);
    };

    const handle: PiNativeSessionDirectory & {
      identity(): ResultAsync<NodeIdentity, PiNativeSessionFsError>;
    } = {
      path,
      identity(): ResultAsync<NodeIdentity, PiNativeSessionFsError> {
        if (closed) return errAsync({ type: "unavailable", operation: "open" });
        const current = fs.directories.get(path);
        if (current === undefined || current.symlink) {
          return errAsync({ type: "symlink-rejected" });
        }
        if (fs.replaced.has(path) || !sameIdentity(current.identity, bound)) {
          return errAsync({ type: "identity-changed" });
        }
        if (current.identity.mode !== 0o700) {
          return errAsync({ type: "permissive-mode", kind: "directory" });
        }
        return okAsync(current.identity);
      },
      readFile(
        name,
      ): ResultAsync<Uint8Array | undefined, PiNativeSessionFsError> {
        if (!safeName(name)) return errAsync({ type: "unsafe-path" });
        return this.identity().andThen(() => {
          const file = fs.directories.get(path)?.files.get(name);
          if (file === undefined) return okAsync(undefined);
          const checked = validateMemoryFile(file);
          if (checked.isErr()) return errAsync(checked.error);
          const identity = file.identity;
          const boundFile = checkFileIdentity(name, identity);
          if (boundFile.isErr()) return errAsync(boundFile.error);
          return this.identity().andThen(() => {
            const current = fs.directories.get(path)?.files.get(name);
            return current !== undefined &&
              sameIdentity(current.identity, identity)
              ? okAsync<Uint8Array, PiNativeSessionFsError>(
                  new Uint8Array(current.bytes),
                )
              : fsErrAsync<Uint8Array>({ type: "identity-changed" });
          });
        });
      },
      appendFile(name, bytes, mode) {
        if (!safeName(name)) return fsErrAsync<void>({ type: "unsafe-path" });
        if (mode !== 0o600) {
          return fsErrAsync<void>({
            type: "permissive-mode",
            kind: "file",
          });
        }
        return this.identity().andThen(() => {
          const current = fs.directories.get(path);
          if (current === undefined) {
            return fsErrAsync<void>({
              type: "unavailable",
              operation: "write",
            });
          }
          const existing = current.files.get(name);
          if (existing === undefined) {
            const created: MemoryFileData = {
              identity: nextMemoryIdentity(0o600),
              mode: 0o600,
              symlink: false,
              kind: "file",
              bytes: new Uint8Array(bytes),
            };
            current.files.set(name, created);
            fileBounds.set(name, created.identity);
          } else {
            const checked = validateMemoryFile(existing);
            if (checked.isErr()) return errAsync(checked.error);
            const known = checkFileIdentity(name, existing.identity);
            if (known.isErr()) return errAsync(known.error);
            const next = new Uint8Array(existing.bytes.length + bytes.length);
            next.set(existing.bytes);
            next.set(bytes, existing.bytes.length);
            existing.bytes = next;
          }
          return this.identity().map<void>(() => undefined);
        });
      },
      deleteFile(name) {
        if (!safeName(name)) return fsErrAsync<void>({ type: "unsafe-path" });
        return this.identity().andThen(() => {
          const current = fs.directories.get(path);
          if (current === undefined) {
            return fsErrAsync<void>({
              type: "unavailable",
              operation: "delete",
            });
          }
          const existing = current.files.get(name);
          if (existing === undefined) return fsVoidAsync();
          const checked = validateMemoryFile(existing);
          if (checked.isErr()) return errAsync(checked.error);
          const known = checkFileIdentity(name, existing.identity);
          if (known.isErr()) return errAsync(known.error);
          current.files.delete(name);
          fileBounds.delete(name);
          return fsVoidAsync();
        });
      },
      close() {
        closed = true;
      },
    };
    return okAsync(handle);
  }

  simulateDirectorySymlink(path: string): void {
    const directory = this.directories.get(path);
    if (directory) directory.symlink = true;
  }

  simulateDirectoryReplacement(path: string): void {
    this.replaced.add(path);
  }

  simulatePermissiveDirectory(path: string): void {
    const directory = this.directories.get(path);
    if (directory) {
      directory.identity = { ...directory.identity, mode: 0o755 };
    }
  }

  simulateFileSymlink(path: string, name: string): void {
    const directory = this.directories.get(path);
    if (directory) {
      directory.files.set(name, {
        identity: nextMemoryIdentity(0o600),
        mode: 0o600,
        symlink: true,
        kind: "file",
        bytes: new Uint8Array(),
      });
    }
  }

  simulateFileReplacement(path: string, name: string): void {
    const directory = this.directories.get(path);
    const existing = directory?.files.get(name);
    if (directory && existing) {
      existing.identity = nextMemoryIdentity(existing.mode);
    }
  }

  simulatePermissiveFile(path: string, name: string): void {
    const file = this.directories.get(path)?.files.get(name);
    if (file) {
      file.mode = 0o644;
      file.identity = { ...file.identity, mode: 0o644 };
    }
  }

  simulateDirectoryFile(path: string, name: string): void {
    const directory = this.directories.get(path);
    if (directory) {
      directory.files.set(name, {
        identity: nextMemoryIdentity(0o700),
        mode: 0o700,
        symlink: false,
        kind: "directory",
        bytes: new Uint8Array(),
      });
    }
  }

  files(path: string): ReadonlyMap<string, Uint8Array> {
    const files = this.directories.get(path)?.files;
    if (files === undefined) return new Map();
    return new Map(
      [...files.entries()]
        .filter(([, file]) => file.kind === "file" && !file.symlink)
        .map(([name, file]) => [name, new Uint8Array(file.bytes)]),
    );
  }
}

function validateMemoryFile(
  file: MemoryFileData,
): Result<MemoryFileData, PiNativeSessionFsError> {
  if (file.symlink) return err({ type: "symlink-rejected" });
  if (file.kind !== "file") return err({ type: "wrong-kind", kind: "file" });
  if (file.mode !== 0o600)
    return err({ type: "permissive-mode", kind: "file" });
  return ok(file);
}

/** The production no-follow filesystem port for native child sessions. */
export function createBunPiNativeSessionFs(): PiNativeSessionFsPort {
  return new BunPiNativeSessionFs();
}
