/**
 * Internal Kysely dialect and driver over `bun:sqlite`.
 *
 * Bridges Kysely's synchronous/async interface to `bun:sqlite`'s
 * synchronous API. This module is engine-internal and must not be
 * exported from the public package entry point.
 *
 * @internal
 */

import type { SQLQueryBindings } from "bun:sqlite";
import { Database } from "bun:sqlite";
import type {
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
  QueryResult,
} from "kysely";
import {
  CompiledQuery,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import { z } from "zod";

// ---------------------------------------------------------------------------
// BunSqliteConnection
// ---------------------------------------------------------------------------

const sqliteBindingSchema = z.union([
  z.string(),
  z.number(),
  z.bigint(),
  z.boolean(),
  z.null(),
  z.instanceof(Uint8Array),
  z.instanceof(Int8Array),
  z.instanceof(Uint8ClampedArray),
  z.instanceof(Int16Array),
  z.instanceof(Uint16Array),
  z.instanceof(Int32Array),
  z.instanceof(Uint32Array),
  z.instanceof(Float32Array),
  z.instanceof(Float64Array),
]);

function parseSqliteParameters(
  parameters: readonly unknown[],
): SQLQueryBindings[] {
  const parsed = sqliteBindingSchema.array().safeParse(parameters);
  if (!parsed.success) {
    throw new TypeError("Kysely emitted an unsupported SQLite parameter");
  }
  return parsed.data;
}

/**
 * A single synchronous connection wrapping a `bun:sqlite` Database.
 */
class BunSqliteConnection implements DatabaseConnection {
  constructor(private readonly db: Database) {}

  executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    const stmt = this.db.prepare<R, SQLQueryBindings[]>(sql);
    const params = parseSqliteParameters(parameters);

    // Determine whether this is a SELECT-like query (returns rows) or
    // a DML/DDL statement (returns metadata only).
    // We detect by checking the SQL keyword prefix, and also by checking
    // for RETURNING clauses in DML statements (INSERT/UPDATE/DELETE ... RETURNING).
    const trimmed = sql.trimStart().toUpperCase();
    const isSelect =
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("WITH") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("EXPLAIN");

    // Row-returning DML: INSERT/UPDATE/DELETE with a RETURNING clause.
    // These start with a DML keyword but return rows, so must use stmt.all().
    const isReturningDml = !isSelect && /\bRETURNING\b/i.test(sql);

    if (isSelect || isReturningDml) {
      const rows = stmt.all(...params);
      return Promise.resolve({ rows });
    }

    // DML/DDL: use run() to get changes and lastInsertRowid
    const meta = stmt.run(...params);
    return Promise.resolve({
      rows: [],
      numAffectedRows: BigInt(meta.changes),
      insertId:
        meta.lastInsertRowid !== undefined
          ? BigInt(meta.lastInsertRowid)
          : undefined,
    });
  }

  // bun:sqlite does not support streaming; return an empty async iterable.
  // eslint-disable-next-line require-yield
  async *streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize: number,
  ): AsyncIterableIterator<QueryResult<R>> {
    // No streaming support
  }
}

// ---------------------------------------------------------------------------
// BunSqliteDriver
// ---------------------------------------------------------------------------

/**
 * Kysely Driver that manages a single `bun:sqlite` Database instance.
 */
class BunSqliteDriver implements Driver {
  private readonly db: Database;
  private readonly connection: BunSqliteConnection;
  private closed = false;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // Enable WAL mode for better concurrent read performance
    this.db.exec("PRAGMA journal_mode=WAL;");
    // Enable foreign key enforcement
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.connection = new BunSqliteConnection(this.db);
  }

  async init(): Promise<void> {
    // Already initialized in constructor
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("BEGIN"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("COMMIT"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("ROLLBACK"));
  }

  async releaseConnection(_connection: DatabaseConnection): Promise<void> {
    // Single connection — nothing to release
  }

  async destroy(): Promise<void> {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  /** Expose the raw Database for direct exec (migrations, PRAGMA). */
  getDatabase(): Database {
    return this.db;
  }
}

// ---------------------------------------------------------------------------
// BunSqliteDialect
// ---------------------------------------------------------------------------

/**
 * Kysely Dialect that uses `bun:sqlite` as the underlying database engine.
 *
 * Usage:
 * ```ts
 * const db = new Kysely<WeaveDatabase>({
 *   dialect: new BunSqliteDialect("/path/to/weave.db"),
 * });
 * ```
 */
export class BunSqliteDialect implements Dialect {
  private readonly driver: BunSqliteDriver;

  constructor(dbPath: string) {
    this.driver = new BunSqliteDriver(dbPath);
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return this.driver;
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }

  /** Expose the raw Database for direct exec (migrations, PRAGMA). */
  getDatabase(): Database {
    return this.driver.getDatabase();
  }
}

// ---------------------------------------------------------------------------
// BunSqliteMemoryDriver / BunSqliteMemoryDialect
// ---------------------------------------------------------------------------

/**
 * Cross-store/cross-process coordination for the in-memory dialect
 * (Pi adapter contract concurrency hardening). Every distinct `SqliteRuntimeStore`
 * instance over the same `weave.db` path owns an entirely independent
 * in-memory `bun:sqlite` `Database`; without a real, OS-level exclusive
 * lock plus a fresh reload immediately before every outside-transaction
 * operation, two concurrent stores would each mutate their own stale
 * snapshot and the last one to flush would silently discard the other's
 * already-committed writes (last-write-wins data loss). `acquire` /
 * `commit` / `discard` are implemented by `SqliteRuntimeStore` on top of
 * the held `RuntimeDirectoryHandle` (`lockLeaf` / `readLeafBytes` /
 * `writeLeafAtomic` / `unlockLeaf`) so this dialect module stays agnostic
 * of the no-follow directory machinery — it only ever sees bytes in and
 * bytes out, never a path string.
 */
export interface MemoryStoreCoordinator {
  /**
   * Acquires the exclusive lock for the leaf and returns its latest
   * on-disk bytes, to be deserialized into a fresh, replaceable
   * `Database`. Must always be paired with exactly one later call to
   * `commit` or `discard`. Throws on failure (nothing was acquired, so
   * nothing needs to be released).
   */
  acquire(): Promise<Uint8Array>;

  /**
   * Persists `bytes` atomically and releases the lock acquired by the
   * paired `acquire()`. Always attempts to release the lock even if
   * persistence itself throws, so a flush failure never wedges the lock
   * for every other store sharing this leaf.
   */
  commit(bytes: Uint8Array): Promise<void>;

  /**
   * Releases the lock acquired by the paired `acquire()` without
   * persisting anything — used after a pure read (nothing to write back)
   * and after a statement failure (an autocommit statement that throws
   * leaves `bun:sqlite`'s own implicit transaction rolled back, so there
   * is nothing new relative to the reload to flush).
   */
  discard(): Promise<void>;
}

class BunSqliteMemoryConnection implements DatabaseConnection {
  private db: Database;
  /**
   * Serializes every statement — and every explicit transaction span as a
   * single unit — issued through this connection. Instance-owned (a plain
   * private field on this connection), never a module-global coordinator,
   * so each store's connection has its own independent queue.
   */
  private queueTail: Promise<void> = Promise.resolve();

  constructor(
    initialBytes: Uint8Array,
    private readonly coordinator: MemoryStoreCoordinator,
  ) {
    this.db = BunSqliteMemoryConnection.deserialize(initialBytes);
  }

  private static deserialize(bytes: Uint8Array): Database {
    const db =
      bytes.length > 0 ? Database.deserialize(bytes) : new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON;");
    return db;
  }

  /** Replaces the live, replaceable `Database` with a fresh deserialization of `bytes`, closing the superseded instance to avoid leaking native resources. */
  private replace(bytes: Uint8Array): void {
    const next = BunSqliteMemoryConnection.deserialize(bytes);
    const previous = this.db;
    this.db = next;
    previous.close();
  }

  /** Exposes the live `Database` for direct exec (migrations, PRAGMA) — used only before any query traffic flows through this connection. */
  getDatabase(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const started = this.queueTail.then(() => this.runQuery<R>(compiledQuery));
    // The tail always recovers (success or failure) so one failed statement
    // never poisons every later statement queued on this connection.
    this.queueTail = started.then(
      () => {},
      () => {},
    );
    return started;
  }

  private async runQuery<R>(
    compiledQuery: CompiledQuery,
  ): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;

    // `bun:sqlite`'s own `inTransaction` flag already distinguishes "a
    // fresh outside-transaction operation" (acquire+reload happens here)
    // from "a statement inside an already-open explicit transaction" (the
    // lock/reload from the `BEGIN` that opened it is still held, so this
    // statement runs against it untouched). Both the Driver's synthetic
    // `BEGIN`/`COMMIT`/`ROLLBACK` transaction-control calls and any raw SQL
    // `BEGIN IMMEDIATE` issued directly by a repository funnel through this
    // same method, so this one check correctly holds the lock/reload across
    // an entire `BEGIN` → `COMMIT`/`ROLLBACK` span regardless of which API
    // opened it.
    const wasInTransaction = this.db.inTransaction;
    if (!wasInTransaction) {
      this.replace(await this.coordinator.acquire());
    }

    const trimmed = sql.trimStart().toUpperCase();
    const isSelect =
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("WITH") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("EXPLAIN");
    const isReturningDml = !isSelect && /\bRETURNING\b/i.test(sql);
    const isRollback = trimmed.startsWith("ROLLBACK");

    let result: QueryResult<R>;
    try {
      const stmt = this.db.prepare<R, SQLQueryBindings[]>(sql);
      const params = parseSqliteParameters(parameters);
      if (isSelect || isReturningDml) {
        result = { rows: stmt.all(...params) };
      } else {
        const meta = stmt.run(...params);
        result = {
          rows: [],
          numAffectedRows: BigInt(meta.changes),
          insertId:
            meta.lastInsertRowid !== undefined
              ? BigInt(meta.lastInsertRowid)
              : undefined,
        };
      }
    } catch (cause) {
      if (!wasInTransaction) await this.coordinator.discard();
      throw cause;
    }

    const nowInTransaction = this.db.inTransaction;
    if (!nowInTransaction) {
      if (isSelect || isRollback) {
        // Bare reads and rolled-back transactions have no durable mutation:
        // release the lock without rewriting unchanged bytes.
        await this.coordinator.discard();
      } else {
        // Covers plain autocommit DML/DDL, RETURNING DML, and the `COMMIT`
        // statement that just closed an explicit transaction.
        await this.coordinator.commit(this.db.serialize());
      }
    }
    return result;
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize: number,
  ): AsyncIterableIterator<QueryResult<R>> {
    // No streaming support
  }
}

/** Kysely `Driver` over an in-memory `bun:sqlite` `Database`, coordinating every outside-transaction operation (and every explicit transaction span) through an injected `MemoryStoreCoordinator` instead of ever opening a path. */
class BunSqliteMemoryDriver implements Driver {
  private readonly connection: BunSqliteMemoryConnection;
  private closed = false;

  constructor(initialBytes: Uint8Array, coordinator: MemoryStoreCoordinator) {
    this.connection = new BunSqliteMemoryConnection(initialBytes, coordinator);
  }

  async init(): Promise<void> {
    // Already initialized in constructor
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("BEGIN"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("COMMIT"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("ROLLBACK"));
  }

  async releaseConnection(_connection: DatabaseConnection): Promise<void> {
    // Single connection — nothing to release
  }

  async destroy(): Promise<void> {
    if (!this.closed) {
      this.connection.close();
      this.closed = true;
    }
  }

  /** Expose the live Database for direct exec (migrations, PRAGMA). */
  getDatabase(): Database {
    return this.connection.getDatabase();
  }
}

/**
 * Kysely `Dialect` that runs `bun:sqlite` entirely in-memory, deserializing
 * `initialBytes` (read by the caller through a no-follow-proven directory
 * descriptor) and coordinating every persisted mutation through `coordinator`
 * (implemented by the caller on top of the same no-follow descriptor).
 * Never opens a path.
 */
export class BunSqliteMemoryDialect implements Dialect {
  private readonly driver: BunSqliteMemoryDriver;

  constructor(initialBytes: Uint8Array, coordinator: MemoryStoreCoordinator) {
    this.driver = new BunSqliteMemoryDriver(initialBytes, coordinator);
  }

  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return this.driver;
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }

  /** Expose the raw Database for direct exec (migrations, PRAGMA). */
  getDatabase(): Database {
    return this.driver.getDatabase();
  }
}
