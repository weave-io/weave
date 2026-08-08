/**
 * No-follow directory/file guard for the Runtime Store (Pi adapter contract).
 *
 * The engine Runtime Store under `.weave/runtime/**` may open only after
 * project trust. This guard acquires and *holds*, for the store's entire
 * lifetime, no-follow handles for both the canonical project root and the
 * runtime directory. It walks every path component between them with a
 * segment-by-segment `openat(..., O_NOFOLLOW)` (creating missing segments
 * with `mkdirat`, never a shelled-out `mkdir` process) so an attacker cannot
 * defeat containment by replacing an *intermediate* ancestor (e.g. `.weave`)
 * with a symlink — a single absolute-path `open(..., O_NOFOLLOW)` call only
 * proves the final path component isn't a symlink, not any ancestor, which
 * is why that shortcut is rejected here.
 *
 * ## The bun:sqlite handoff and why there is no path reopen at all
 *
 * Pi adapter contract forbids "a path check followed by an unrelated reopen".
 * `bun:sqlite`'s `Database` constructor only ever accepts a path *string*
 * or in-memory bytes (verified against `bun-types`/the compiled `bun:sqlite`
 * module — there is no fd-based or `O_NOFOLLOW`-aware constructor). Handing
 * it a path string after proving that path's identity through a completely
 * separate, held directory descriptor is exactly the forbidden pattern, and
 * two independent empirical checks (via `Bun.file()` and a raw libc
 * `open()` call) confirmed that neither `/proc/self/fd/<dirfd>/<name>`
 * (Linux-style magic-symlink aliasing) nor `/dev/fd/<filefd>` (Darwin) let
 * `bun:sqlite` resolve a path *relative to an already-held descriptor* —
 * `bun:sqlite` always fails to open through either alias.
 *
 * This guard therefore never hands `bun:sqlite` a path string for the
 * runtime DB at all. Instead:
 *
 *  - `readLeafBytes` reads the *entire* current contents of `weave.db`
 *    through one no-follow `openat` relative to the held runtime-directory
 *    descriptor. The caller (`SqliteRuntimeStore`) deserializes those bytes
 *    into an **in-memory** `bun:sqlite` `Database` (`new Database(bytes)`)
 *    — `bun:sqlite` never touches a path for the live database at all, so
 *    there is nothing to "reopen".
 *  - `writeLeafAtomic` persists a new snapshot (`Database#serialize()`)
 *    back to `weave.db` by writing to a fresh temp file *through the same
 *    held descriptor* (`openat` + `write` + `fsync`), then atomically
 *    replacing the leaf via `renameat` on that same descriptor, then
 *    `fsync`s the directory itself. The identity returned afterward is the
 *    new bound identity for subsequent revalidation.
 *
 * Because the live database is in-memory, `bun:sqlite`'s WAL mode and its
 * `-wal`/`-shm` sidecar files never come into existence — durability comes
 * entirely from `writeLeafAtomic`'s temp-file-then-rename sequence, which is
 * the standard POSIX atomic-replace pattern, performed exclusively through
 * the already no-follow-proven directory descriptor.
 *
 * @see docs/adapters/pi.md
 */
import { ResultAsync } from "neverthrow";
import { type FdIdentity } from "../nofollow-ffi.js";
export type RuntimeDirectoryGuardError = {
    readonly type: "unavailable";
    readonly message: string;
} | {
    readonly type: "symlink-rejected";
    readonly message: string;
    readonly cause?: string;
} | {
    readonly type: "identity-changed";
    readonly message: string;
    readonly cause?: string;
} | {
    readonly type: "io";
    readonly message: string;
    readonly cause?: string;
} | {
    readonly type: "locked";
    readonly message: string;
    readonly cause?: string;
};
/** Stable identity (dev/ino) of a held directory or file descriptor. */
export type RuntimeFileIdentity = FdIdentity;
export interface VerifyLeafOptions {
    readonly create: boolean;
    readonly mode: number;
}
export interface RuntimeDirectoryHandle {
    /** Absolute path of the held runtime directory. Diagnostics only — never re-derived for an open. */
    readonly path: string;
    /**
     * Re-verifies the held project-root and runtime-directory descriptors
     * still refer to the identity captured when they were opened. Used to
     * revalidate stable parent/target identity across migration and every
     * subsequent transaction commit (Pi adapter contract).
     */
    identity(): ResultAsync<RuntimeFileIdentity, RuntimeDirectoryGuardError>;
    /**
     * Opens (creating if `create` is true and it is missing) `fileName`
     * relative to the held runtime directory descriptor via a no-follow
     * `openat`, applies `mode`, and returns its identity. Never re-derives a
     * path string for this operation.
     */
    verifyLeaf(fileName: string, options: VerifyLeafOptions): ResultAsync<RuntimeFileIdentity, RuntimeDirectoryGuardError>;
    /**
     * Reads the full contents of `fileName` through one no-follow `openat`
     * relative to the held runtime directory descriptor. Returns an empty
     * `Uint8Array` if the file does not exist yet (a brand-new store).
     */
    readLeafBytes(fileName: string): ResultAsync<Uint8Array, RuntimeDirectoryGuardError>;
    /**
     * Atomically replaces `fileName`'s contents with `bytes`: writes to a
     * fresh temp file created via `openat` relative to the held descriptor,
     * `fsync`s it, `renameat`s it over `fileName` (still relative to the same
     * held descriptor — never a path string), then `fsync`s the directory.
     * Returns the newly-bound identity.
     */
    writeLeafAtomic(fileName: string, bytes: Uint8Array, mode: number): ResultAsync<RuntimeFileIdentity, RuntimeDirectoryGuardError>;
    /**
     * Acquires a process/host-wide exclusive advisory lock (`flock`) scoped
     * to `fileName`, opening (and thereafter holding, like the runtime
     * directory fd itself) a dedicated no-follow lock leaf on first use.
     * Every other `RuntimeDirectoryHandle` — in this process or another —
     * that opens the same directory and the same `fileName` contends on the
     * same OS-level lock. Bounded, non-blocking retries with backoff; never
     * blocks the event loop. Must be paired with `unlockLeaf`.
     */
    lockLeaf(fileName: string): ResultAsync<void, RuntimeDirectoryGuardError>;
    /** Releases a previously acquired exclusive lock for `fileName`. Idempotent (unlocking an already-unlocked leaf is not an error). */
    unlockLeaf(fileName: string): ResultAsync<void, RuntimeDirectoryGuardError>;
    /** Closes every held descriptor, including any lock leaves opened by `lockLeaf` (which also releases their locks). Idempotent. */
    close(): void;
}
export interface RuntimeDirectoryGuard {
    /**
     * Establishes a held, no-follow chain from `projectRoot` (assumed to
     * already exist — it is the harness-established trust boundary) down
     * through `segments` (each created via `mkdirat` if missing, each proven
     * via no-follow `openat`), applying `mode` to every segment this guard
     * creates or owns.
     */
    ensureRuntimeDirectory(projectRoot: string, segments: readonly string[], mode: number): ResultAsync<RuntimeDirectoryHandle, RuntimeDirectoryGuardError>;
}
/** Convenience: the leaf file name for a `weave.db`-style absolute path. */
export declare function runtimeLeafName(dbPath: string): string;
/** Compares two identities by `dev`+`ino` only (size/mtime are observational). */
export declare function directoryIdentitiesMatch(a: RuntimeFileIdentity, b: RuntimeFileIdentity): boolean;
export declare class BunRuntimeDirectoryGuard implements RuntimeDirectoryGuard {
    ensureRuntimeDirectory(projectRoot: string, segments: readonly string[], mode: number): ResultAsync<RuntimeDirectoryHandle, RuntimeDirectoryGuardError>;
    private openChain;
    /** Opens (creating missing components via `mkdirat`) every segment in order, holding only the current and final descriptors — every intermediate hop is closed once the next is open. Returns the final segment's held fd. */
    private walkSegments;
}
export declare class MemoryRuntimeDirectoryGuard implements RuntimeDirectoryGuard {
    private directorySymlink;
    private readonly leafLocks;
    private runtimeIdentity;
    private readonly leaves;
    /** Simulates the runtime directory (or an ancestor) being a symlink: every open through it fails closed. */
    simulateDirectorySymlink(): void;
    /** Simulates the runtime directory's own identity changing after it was opened. */
    swapDirectoryIdentity(): void;
    /** Simulates `fileName` being a symlink instead of a plain file. */
    simulateLeafSymlink(fileName: string): void;
    /** Simulates `fileName`'s identity changing out from under an already-verified leaf. */
    swapLeafIdentity(fileName: string): void;
    ensureRuntimeDirectory(projectRoot: string, segments: readonly string[], _mode: number): ResultAsync<RuntimeDirectoryHandle, RuntimeDirectoryGuardError>;
}
