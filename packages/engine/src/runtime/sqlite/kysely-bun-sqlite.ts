/**
 * Internal Kysely dialect and driver over `bun:sqlite`.
 *
 * Bridges Kysely's synchronous/async interface to `bun:sqlite`'s
 * synchronous API. This module is engine-internal and must not be
 * exported from the public package entry point.
 *
 * @internal
 */

import { Database } from "bun:sqlite";
import type {
  CompiledQuery,
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  QueryCompiler,
  QueryResult,
} from "kysely";
import { SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from "kysely";

// ---------------------------------------------------------------------------
// BunSqliteConnection
// ---------------------------------------------------------------------------

/**
 * A single synchronous connection wrapping a `bun:sqlite` Database.
 */
class BunSqliteConnection implements DatabaseConnection {
  constructor(private readonly db: Database) {}

  executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    const stmt = this.db.prepare(sql);
    const params = parameters as Parameters<typeof stmt.all>;

    // Determine whether this is a SELECT-like query (returns rows) or
    // a DML/DDL statement (returns metadata only).
    // We detect by checking the SQL keyword prefix.
    const trimmed = sql.trimStart().toUpperCase();
    const isSelect =
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("WITH") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("EXPLAIN");

    if (isSelect) {
      const rows = stmt.all(...params) as R[];
      return Promise.resolve({ rows });
    }

    // DML/DDL: use run() to get changes and lastInsertRowid
    const meta = stmt.run(...params);
    return Promise.resolve({
      rows: [] as R[],
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
    await connection.executeQuery({
      sql: "BEGIN",
      parameters: [],
      query: {
        kind: "RawNode",
        sqlFragments: ["BEGIN"],
        parameters: [],
      } as never,
    });
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery({
      sql: "COMMIT",
      parameters: [],
      query: {
        kind: "RawNode",
        sqlFragments: ["COMMIT"],
        parameters: [],
      } as never,
    });
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery({
      sql: "ROLLBACK",
      parameters: [],
      query: {
        kind: "RawNode",
        sqlFragments: ["ROLLBACK"],
        parameters: [],
      } as never,
    });
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
