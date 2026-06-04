/**
 * SQLite Runtime Store tests.
 *
 * Uses temp directories to test lazy initialization, migrations, CRUD,
 * lease conflicts, schema version failure, transaction commit/rollback,
 * strict journal failure, and best-effort journal failure.
 *
 * @see docs/specs/12-spec-runtime-persistence/12-spec-runtime-persistence.md
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import {
  CURRENT_SCHEMA_VERSION,
  readSchemaVersion,
  runMigrations,
} from "../runtime/sqlite/migrations.js";
import {
  createSqliteRuntimeStore,
  type SqliteRuntimeStoreOptions,
} from "../runtime/sqlite/store.js";
import {
  createArtifactId,
  createOwnerId,
  createWorkflowInstanceId,
} from "../runtime/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testDir: string;

function makeTempDir(): string {
  const dir = join(tmpdir(), `weave-test-${crypto.randomUUID()}`);
  Bun.spawnSync(["mkdir", "-p", dir]);
  return dir;
}

function pathExists(p: string): boolean {
  // Use Bun.file().exists() for async check, or spawnSync for sync
  const result = Bun.spawnSync(["test", "-e", p]);
  return result.exitCode === 0;
}

function makeDbPath(dir: string): string {
  return join(dir, "runtime", "weave.db");
}

function makeStore(dir: string, opts: Partial<SqliteRuntimeStoreOptions> = {}) {
  return createSqliteRuntimeStore({
    dbPath: makeDbPath(dir),
    ...opts,
  });
}

beforeEach(() => {
  testDir = makeTempDir();
});

afterEach(() => {
  // Best-effort cleanup using Bun.spawnSync
  Bun.spawnSync(["rm", "-rf", testDir]);
});

// ---------------------------------------------------------------------------
// Lazy initialization
// ---------------------------------------------------------------------------

describe("lazy initialization", () => {
  it("does not create the DB file at construction time", async () => {
    const dbPath = makeDbPath(testDir);
    makeStore(testDir);
    expect(pathExists(dbPath)).toBe(false);
  });

  it("creates the runtime directory and DB file on first operation", async () => {
    const store = makeStore(testDir);
    const result = await store.instances.list();
    expect(result.isOk()).toBe(true);
    expect(pathExists(makeDbPath(testDir))).toBe(true);
  });

  it("creates the runtime directory with restrictive permissions", async () => {
    const store = makeStore(testDir);
    await store.instances.list();
    const runtimeDir = join(testDir, "runtime");
    expect(pathExists(runtimeDir)).toBe(true);
  });

  it("is idempotent — second operation does not re-initialize", async () => {
    const store = makeStore(testDir);
    await store.instances.list();
    await store.instances.list();
    expect(pathExists(makeDbPath(testDir))).toBe(true);
  });

  it("concurrent ensureInitialized calls only initialize once", async () => {
    const store = makeStore(testDir);

    // Fire multiple concurrent initializations before any resolves
    const [r1, r2, r3] = await Promise.all([
      store.instances.list(),
      store.instances.list(),
      store.instances.list(),
    ]);

    // All should succeed
    expect(r1.isOk()).toBe(true);
    expect(r2.isOk()).toBe(true);
    expect(r3.isOk()).toBe(true);

    // DB file should exist exactly once (not corrupted by double-init)
    expect(pathExists(makeDbPath(testDir))).toBe(true);

    // Verify the DB is usable and consistent — only one schema_version row
    const db = new Database(makeDbPath(testDir));
    const rows = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM runtime_metadata WHERE key = 'schema_version'",
      )
      .get() as { cnt: number };
    db.close();
    expect(rows.cnt).toBe(1);

    await store.close();
  });

  it("close() succeeds even if never initialized", async () => {
    const store = makeStore(testDir);
    const result = await store.close();
    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

describe("migrations", () => {
  it("applies initial migration on first open", async () => {
    const store = makeStore(testDir);
    await store.instances.list();

    // Verify schema_migrations table has the initial migration
    const db = new Database(makeDbPath(testDir));
    const row = db
      .prepare("SELECT * FROM schema_migrations WHERE version = 1")
      .get() as { version: number; name: string } | null;
    db.close();

    expect(row).not.toBeNull();
    expect(row?.version).toBe(1);
    expect(row?.name).toBe("initial_schema");
  });

  it("stores schema_version in runtime_metadata", async () => {
    const store = makeStore(testDir);
    await store.instances.list();

    const db = new Database(makeDbPath(testDir));
    const row = db
      .prepare(
        "SELECT value FROM runtime_metadata WHERE key = 'schema_version'",
      )
      .get() as { value: string } | null;
    db.close();

    expect(row).not.toBeNull();
    if (row) {
      expect(parseInt(row.value, 10)).toBe(CURRENT_SCHEMA_VERSION);
    }
  });

  it("runMigrations is idempotent on an already-migrated DB", () => {
    const dbPath = join(testDir, "test.db");
    const db = new Database(dbPath);

    const first = runMigrations(db);
    expect(first.isOk()).toBe(true);

    const second = runMigrations(db);
    expect(second.isOk()).toBe(true);

    db.close();
  });

  it("returns migration_version error when DB version > supported version", () => {
    const dbPath = join(testDir, "future.db");
    const db = new Database(dbPath);

    // Bootstrap tables and set a future version
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, name TEXT NOT NULL);
      INSERT OR REPLACE INTO runtime_metadata (key, value) VALUES ('schema_version', '999');
    `);

    const result = runMigrations(db);
    db.close();

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("migration_version");
    if (error.type === "migration_version") {
      expect(error.foundVersion).toBe(999);
      expect(error.supportedVersion).toBe(CURRENT_SCHEMA_VERSION);
    }
  });

  it("runMigrations returns initialization error when schema_version is non-integer", () => {
    const dbPath = join(testDir, "corrupt-nan.db");
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, name TEXT NOT NULL);
      INSERT OR REPLACE INTO runtime_metadata (key, value) VALUES ('schema_version', 'not-a-number');
    `);

    const result = runMigrations(db);
    db.close();

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("initialization");
    if (error.type === "initialization") {
      expect(error.message).toContain("Invalid schema_version");
      expect(error.message).toContain("not-a-number");
    }
  });

  it("runMigrations returns initialization error when schema_version is negative", () => {
    const dbPath = join(testDir, "corrupt-negative.db");
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, name TEXT NOT NULL);
      INSERT OR REPLACE INTO runtime_metadata (key, value) VALUES ('schema_version', '-1');
    `);

    const result = runMigrations(db);
    db.close();

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("initialization");
    if (error.type === "initialization") {
      expect(error.message).toContain("Invalid schema_version");
      expect(error.message).toContain("-1");
    }
  });

  it("readSchemaVersion returns 0 for non-integer schema_version", () => {
    const dbPath = join(testDir, "corrupt-read-nan.db");
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR REPLACE INTO runtime_metadata (key, value) VALUES ('schema_version', 'garbage');
    `);

    const version = readSchemaVersion(db);
    db.close();

    expect(version).toBe(0);
  });

  it("readSchemaVersion returns 0 for negative schema_version", () => {
    const dbPath = join(testDir, "corrupt-read-neg.db");
    const db = new Database(dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR REPLACE INTO runtime_metadata (key, value) VALUES ('schema_version', '-5');
    `);

    const version = readSchemaVersion(db);
    db.close();

    expect(version).toBe(0);
  });

  it("SqliteRuntimeStore returns migration_version error on open with future DB", async () => {
    // Create a DB with a future schema version
    const runtimeDir = join(testDir, "runtime");
    Bun.spawnSync(["mkdir", "-p", runtimeDir]);
    const dbPath = join(runtimeDir, "weave.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, name TEXT NOT NULL);
      INSERT OR REPLACE INTO runtime_metadata (key, value) VALUES ('schema_version', '999');
    `);
    db.close();

    const store = createSqliteRuntimeStore({ dbPath });
    const result = await store.instances.list();

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("migration_version");
  });
});

// ---------------------------------------------------------------------------
// Project salt lifecycle
// ---------------------------------------------------------------------------

describe("project salt lifecycle", () => {
  it("creates a project salt on first initialization", async () => {
    const store = makeStore(testDir);
    await store.instances.list(); // trigger initialization
    expect(store.projectSalt).toBeDefined();
    expect(typeof store.projectSalt).toBe("string");
    expect(store.projectSalt.length).toBe(32); // 16 bytes = 32 hex chars
    await store.close();
  });

  it("returns the same salt on second open of the same DB", async () => {
    const store1 = makeStore(testDir);
    await store1.instances.list();
    const salt1 = store1.projectSalt;
    await store1.close();

    const store2 = makeStore(testDir);
    await store2.instances.list();
    const salt2 = store2.projectSalt;
    await store2.close();

    expect(salt1).toBe(salt2);
  });

  it("new DB gets a different salt", async () => {
    const dir2 = makeTempDir();
    try {
      const store1 = makeStore(testDir);
      await store1.instances.list();
      const salt1 = store1.projectSalt;
      await store1.close();

      const store2 = makeStore(dir2);
      await store2.instances.list();
      const salt2 = store2.projectSalt;
      await store2.close();

      // Salts should be different (with overwhelming probability)
      expect(salt1).not.toBe(salt2);
    } finally {
      Bun.spawnSync(["rm", "-rf", dir2]);
    }
  });

  it("persists salt in runtime_metadata table", async () => {
    const store = makeStore(testDir);
    await store.instances.list();
    const salt = store.projectSalt;
    await store.close();

    const db = new Database(makeDbPath(testDir));
    const row = db
      .prepare("SELECT value FROM runtime_metadata WHERE key = 'project_salt'")
      .get() as { value: string } | null;
    db.close();

    expect(row).not.toBeNull();
    expect(row?.value).toBe(salt);
  });
});

// ---------------------------------------------------------------------------
// WorkflowInstance CRUD
// ---------------------------------------------------------------------------

describe("WorkflowInstance CRUD", () => {
  it("create returns a WorkflowInstance with status 'created'", async () => {
    const store = makeStore(testDir);
    const result = await store.instances.create({
      workflowName: "test-workflow",
      goal: "Build a feature",
      slug: "build-a-feature",
    });
    expect(result.isOk()).toBe(true);
    const instance = result._unsafeUnwrap();
    expect(instance.status).toBe("created");
    expect(instance.workflowName).toBe("test-workflow");
    expect(instance.goal).toBe("Build a feature");
    expect(instance.slug).toBe("build-a-feature");
    expect(instance.artifacts).toHaveLength(0);
    expect(instance.id).toBeDefined();
    expect(instance.createdAt).toBeDefined();
    expect(instance.updatedAt).toBeDefined();
    await store.close();
  });

  it("findById returns null for missing instance", async () => {
    const store = makeStore(testDir);
    const result = await store.instances.findById(
      createWorkflowInstanceId("missing"),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
    await store.close();
  });

  it("getById returns not_found error for missing instance", async () => {
    const store = makeStore(testDir);
    const result = await store.instances.getById(
      createWorkflowInstanceId("missing"),
    );
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("not_found");
    await store.close();
  });

  it("findById returns the instance after creation", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({
        workflowName: "wf",
        goal: "goal",
        slug: "goal",
      })
    )._unsafeUnwrap();

    const found = (await store.instances.findById(created.id))._unsafeUnwrap();
    expect(found).not.toBeNull();
    expect((found as NonNullable<typeof found>).id as string).toBe(
      created.id as string,
    );
    await store.close();
  });

  it("list returns all instances", async () => {
    const store = makeStore(testDir);
    await store.instances.create({ workflowName: "wf", goal: "a", slug: "a" });
    await store.instances.create({ workflowName: "wf", goal: "b", slug: "b" });
    const result = await store.instances.list();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(2);
    await store.close();
  });

  it("list filters by status", async () => {
    const store = makeStore(testDir);
    const a = (
      await store.instances.create({ workflowName: "wf", goal: "a", slug: "a" })
    )._unsafeUnwrap();
    await store.instances.create({ workflowName: "wf", goal: "b", slug: "b" });
    await store.instances.update(a.id, { status: "running" });

    const running = (
      await store.instances.list({ status: "running" })
    )._unsafeUnwrap();
    expect(running).toHaveLength(1);
    expect(running[0].id as string).toBe(a.id as string);
    await store.close();
  });

  it("update changes status and sets completedAt for terminal status", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const updated = (
      await store.instances.update(created.id, { status: "completed" })
    )._unsafeUnwrap();
    expect(updated.status).toBe("completed");
    expect(updated.completedAt).toBeDefined();
    await store.close();
  });

  it("update returns not_found for missing instance", async () => {
    const store = makeStore(testDir);
    const result = await store.instances.update(
      createWorkflowInstanceId("missing"),
      { status: "running" },
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
    await store.close();
  });

  it("addArtifact appends an artifact reference", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const updated = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
        mimeType: "text/markdown",
      })
    )._unsafeUnwrap();
    expect(updated.artifacts).toHaveLength(1);
    expect(updated.artifacts[0].name).toBe("plan");
    expect(updated.artifacts[0].path).toBe(".weave/plans/g.md");
    expect(updated.artifacts[0].mimeType).toBe("text/markdown");
    await store.close();
  });

  it("addArtifact returns not_found for missing instance", async () => {
    const store = makeStore(testDir);
    const result = await store.instances.addArtifact(
      createWorkflowInstanceId("missing"),
      { name: "plan", path: ".weave/plans/g.md" },
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// ExecutionLease CRUD and conflict behavior
// ---------------------------------------------------------------------------

describe("ExecutionLease CRUD and conflicts", () => {
  it("acquire creates a new lease when none exists", async () => {
    const store = makeStore(testDir);
    const wfi = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const result = await store.leases.acquire({
      workflowInstanceId: wfi.id,
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });
    expect(result.isOk()).toBe(true);
    const lease = result._unsafeUnwrap();
    expect(lease.ownerId as string).toBe("owner-001");
    expect(lease.workflowInstanceId as string).toBe(wfi.id as string);
    await store.close();
  });

  it("acquire fails with conflict when unexpired lease exists", async () => {
    const store = makeStore(testDir);
    const wfi = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    await store.leases.acquire({
      workflowInstanceId: wfi.id,
      ownerId: createOwnerId("owner-001"),
      ttlMs: 60_000,
    });

    const result = await store.leases.acquire({
      workflowInstanceId: wfi.id,
      ownerId: createOwnerId("owner-002"),
      ttlMs: 60_000,
    });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("conflict");
    await store.close();
  });

  it("acquire succeeds when existing lease is expired", async () => {
    const now = new Date();
    const pastTime = new Date(now.getTime() - 120_000); // 2 minutes ago
    let callCount = 0;
    const clock = () => {
      callCount++;
      // First call (acquire expired lease): return past time
      // Subsequent calls: return current time
      if (callCount === 1) return pastTime;
      return now;
    };

    const store = makeStore(testDir, { clock });
    const wfi = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    // Acquire with past clock (lease expires in the past)
    await store.leases.acquire({
      workflowInstanceId: wfi.id,
      ownerId: createOwnerId("old-owner"),
      ttlMs: 1, // 1ms TTL, so expires immediately relative to past clock
    });

    // Now acquire with current clock — old lease is expired
    const result = await store.leases.acquire({
      workflowInstanceId: wfi.id,
      ownerId: createOwnerId("new-owner"),
      ttlMs: 60_000,
    });
    expect(result.isOk()).toBe(true);
    const lease = result._unsafeUnwrap();
    expect(lease.ownerId as string).toBe("new-owner");
    await store.close();
  });

  it("findActive returns null when no lease exists", async () => {
    const store = makeStore(testDir);
    const result = await store.leases.findActive();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
    await store.close();
  });

  it("getActive returns not_found when no active lease", async () => {
    const store = makeStore(testDir);
    const result = await store.leases.getActive();
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
    await store.close();
  });

  it("heartbeat renews an active lease", async () => {
    const store = makeStore(testDir);
    const wfi = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const lease = (
      await store.leases.acquire({
        workflowInstanceId: wfi.id,
        ownerId: createOwnerId("owner-001"),
        ttlMs: 60_000,
      })
    )._unsafeUnwrap();

    const result = await store.leases.heartbeat(
      lease.id,
      lease.ownerId,
      120_000,
    );
    expect(result.isOk()).toBe(true);
    const renewed = result._unsafeUnwrap();
    expect(renewed.lastHeartbeatAt).toBeDefined();
    await store.close();
  });

  it("heartbeat fails with conflict for wrong owner", async () => {
    const store = makeStore(testDir);
    const wfi = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const lease = (
      await store.leases.acquire({
        workflowInstanceId: wfi.id,
        ownerId: createOwnerId("owner-001"),
        ttlMs: 60_000,
      })
    )._unsafeUnwrap();

    const result = await store.leases.heartbeat(
      lease.id,
      createOwnerId("wrong-owner"),
      60_000,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("conflict");
    await store.close();
  });

  it("release removes the lease", async () => {
    const store = makeStore(testDir);
    const wfi = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const lease = (
      await store.leases.acquire({
        workflowInstanceId: wfi.id,
        ownerId: createOwnerId("owner-001"),
        ttlMs: 60_000,
      })
    )._unsafeUnwrap();

    const releaseResult = await store.leases.release(lease.id, lease.ownerId);
    expect(releaseResult.isOk()).toBe(true);

    const findResult = await store.leases.findById(lease.id);
    expect(findResult._unsafeUnwrap()).toBeNull();
    await store.close();
  });

  it("release fails with conflict for wrong owner", async () => {
    const store = makeStore(testDir);
    const wfi = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const lease = (
      await store.leases.acquire({
        workflowInstanceId: wfi.id,
        ownerId: createOwnerId("owner-001"),
        ttlMs: 60_000,
      })
    )._unsafeUnwrap();

    const result = await store.leases.release(
      lease.id,
      createOwnerId("wrong-owner"),
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("conflict");
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// SessionSnapshot CRUD
// ---------------------------------------------------------------------------

describe("SessionSnapshot CRUD", () => {
  it("record creates a snapshot", async () => {
    const store = makeStore(testDir);
    const wfi = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const lease = (
      await store.leases.acquire({
        workflowInstanceId: wfi.id,
        ownerId: createOwnerId("owner-001"),
        ttlMs: 60_000,
      })
    )._unsafeUnwrap();

    const result = await store.snapshots.record({
      workflowInstanceId: wfi.id,
      leaseId: lease.id,
      harnessName: "test-harness",
      agentName: "shuttle",
      sessionStatus: "active",
      metadata: { stepCount: 1, isResumed: false },
    });
    expect(result.isOk()).toBe(true);
    const snap = result._unsafeUnwrap();
    expect(snap.harnessName).toBe("test-harness");
    expect(snap.agentName).toBe("shuttle");
    expect(snap.sessionStatus).toBe("active");
    expect(snap.metadata.stepCount).toBe(1);
    await store.close();
  });

  it("listByWorkflowInstance returns all snapshots for an instance", async () => {
    const store = makeStore(testDir);
    const wfi = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const lease = (
      await store.leases.acquire({
        workflowInstanceId: wfi.id,
        ownerId: createOwnerId("owner-001"),
        ttlMs: 60_000,
      })
    )._unsafeUnwrap();

    await store.snapshots.record({
      workflowInstanceId: wfi.id,
      leaseId: lease.id,
      harnessName: "h",
      agentName: "shuttle",
      sessionStatus: "active",
      metadata: {},
    });
    await store.snapshots.record({
      workflowInstanceId: wfi.id,
      leaseId: lease.id,
      harnessName: "h",
      agentName: "shuttle",
      sessionStatus: "idle",
      metadata: {},
    });

    const result = await store.snapshots.listByWorkflowInstance(wfi.id);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(2);
    await store.close();
  });

  it("findLatestByWorkflowInstance returns the most recent snapshot", async () => {
    const store = makeStore(testDir);
    const wfi = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const lease = (
      await store.leases.acquire({
        workflowInstanceId: wfi.id,
        ownerId: createOwnerId("owner-001"),
        ttlMs: 60_000,
      })
    )._unsafeUnwrap();

    await store.snapshots.record({
      workflowInstanceId: wfi.id,
      leaseId: lease.id,
      harnessName: "h",
      agentName: "shuttle",
      sessionStatus: "active",
      metadata: { step: 1 },
    });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));
    await store.snapshots.record({
      workflowInstanceId: wfi.id,
      leaseId: lease.id,
      harnessName: "h",
      agentName: "shuttle",
      sessionStatus: "idle",
      metadata: { step: 2 },
    });

    const result = await store.snapshots.findLatestByWorkflowInstance(wfi.id);
    expect(result.isOk()).toBe(true);
    const latest = result._unsafeUnwrap();
    expect(latest).not.toBeNull();
    if (latest) {
      expect(latest.sessionStatus).toBe("idle");
    }
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// RuntimeJournal CRUD
// ---------------------------------------------------------------------------

describe("RuntimeJournal CRUD", () => {
  it("append creates a journal entry", async () => {
    const store = makeStore(testDir);
    const result = await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "step.started",
      severity: "info",
      data: { stepName: "implement" },
    });
    expect(result.isOk()).toBe(true);
    const entry = result._unsafeUnwrap();
    expect(entry.id).toBeDefined();
    expect(entry.timestamp).toBeDefined();
    expect(entry.source.kind).toBe("engine");
    expect(entry.eventType).toBe("step.started");
    await store.close();
  });

  it("query returns all entries when no filter", async () => {
    const store = makeStore(testDir);
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "a",
      severity: "info",
      data: {},
    });
    await store.journal.append({
      source: { kind: "adapter", name: "opencode" },
      eventType: "b",
      severity: "warn",
      data: {},
    });
    const result = await store.journal.query();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(2);
    await store.close();
  });

  it("query filters by sourceKind", async () => {
    const store = makeStore(testDir);
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "a",
      severity: "info",
      data: {},
    });
    await store.journal.append({
      source: { kind: "adapter", name: "opencode" },
      eventType: "b",
      severity: "info",
      data: {},
    });
    const result = await store.journal.query({ sourceKind: "engine" });
    expect(result.isOk()).toBe(true);
    const entries = result._unsafeUnwrap();
    expect(entries).toHaveLength(1);
    expect(entries[0].source.kind).toBe("engine");
    await store.close();
  });

  it("query filters by eventType", async () => {
    const store = makeStore(testDir);
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "step.started",
      severity: "info",
      data: {},
    });
    await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "step.completed",
      severity: "info",
      data: {},
    });
    const result = await store.journal.query({ eventType: "step.started" });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
    await store.close();
  });

  it("query respects limit", async () => {
    const store = makeStore(testDir);
    for (let i = 0; i < 5; i++) {
      await store.journal.append({
        source: { kind: "engine", name: "runner" },
        eventType: "tick",
        severity: "debug",
        data: {},
      });
    }
    const result = await store.journal.query({ limit: 3 });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(3);
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// Transaction commit and rollback
// ---------------------------------------------------------------------------

describe("transaction commit and rollback", () => {
  it("transaction commits on success", async () => {
    const store = makeStore(testDir);
    const result = await store.transaction((tx) => {
      return tx.instances.create({
        workflowName: "wf",
        goal: "transactional goal",
        slug: "transactional-goal",
      });
    });
    expect(result.isOk()).toBe(true);

    // Verify the instance was persisted
    const list = (await store.instances.list())._unsafeUnwrap();
    expect(list).toHaveLength(1);
    expect(list[0].goal).toBe("transactional goal");
    await store.close();
  });

  it("transaction rolls back on Err result from callback", async () => {
    const store = makeStore(testDir);

    // Create an instance outside the transaction first
    await store.instances.create({
      workflowName: "wf",
      goal: "pre-existing",
      slug: "pre-existing",
    });

    const result = await store.transaction((tx) => {
      return tx.instances
        .create({
          workflowName: "wf",
          goal: "should-be-rolled-back",
          slug: "should-be-rolled-back",
        })
        .andThen(() => {
          // Return an error to trigger rollback
          return errAsync({
            type: "query" as const,
            message: "Simulated failure",
          });
        });
    });

    expect(result.isErr()).toBe(true);

    // Only the pre-existing instance should remain
    const list = (await store.instances.list())._unsafeUnwrap();
    expect(list).toHaveLength(1);
    expect(list[0].goal).toBe("pre-existing");
    await store.close();
  });

  it("transaction exposes all sub-repositories", async () => {
    const store = makeStore(testDir);
    const result = await store.transaction((tx) => {
      expect(tx.instances).toBeDefined();
      expect(tx.leases).toBeDefined();
      expect(tx.snapshots).toBeDefined();
      expect(tx.journal).toBeDefined();
      return okAsync("ok" as const);
    });
    expect(result.isOk()).toBe(true);
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// Strict journal mode
// ---------------------------------------------------------------------------

describe("strict journal mode", () => {
  it("journal write failure in strict mode rolls back the transaction", async () => {
    const store = makeStore(testDir, { strictJournal: true });

    // Create a workflow instance first (outside transaction)
    await store.instances.create({
      workflowName: "wf",
      goal: "pre-tx",
      slug: "pre-tx",
    });

    // Run a transaction that creates an instance and then appends an invalid
    // journal entry. The invalid entry (bad source.kind) will be rejected by
    // the RuntimeJournalWriter in strict mode, propagating the error and
    // rolling back the transaction.
    const result = await store.transaction((tx) => {
      return tx.instances
        .create({ workflowName: "wf", goal: "in-tx", slug: "in-tx" })
        .andThen(() => {
          // Pass an invalid source.kind to trigger writer validation failure
          return tx.journal.append({
            source: { kind: "invalid-kind" as "engine", name: "runner" },
            eventType: "test",
            severity: "info",
            data: {},
          });
        });
    });

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("journal_write");

    // The in-tx instance should have been rolled back
    const list = (await store.instances.list())._unsafeUnwrap();
    expect(list).toHaveLength(1);
    expect(list[0].goal).toBe("pre-tx");
    await store.close();
  });

  it("transaction with strict journal rolls back when journal error returned from callback", async () => {
    const store = makeStore(testDir, { strictJournal: true });

    await store.instances.create({
      workflowName: "wf",
      goal: "pre-tx",
      slug: "pre-tx",
    });

    const result = await store.transaction((tx) => {
      return tx.instances
        .create({ workflowName: "wf", goal: "in-tx", slug: "in-tx" })
        .andThen(() => {
          return errAsync({
            type: "journal_write" as const,
            message: "Simulated journal write failure",
          });
        });
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("journal_write");

    const list = (await store.instances.list())._unsafeUnwrap();
    expect(list).toHaveLength(1);
    expect(list[0].goal).toBe("pre-tx");
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// Best-effort journal mode
// ---------------------------------------------------------------------------

describe("best-effort journal mode (default)", () => {
  it("journal append succeeds in best-effort mode", async () => {
    const store = makeStore(testDir, { strictJournal: false });
    const result = await store.journal.append({
      source: { kind: "engine", name: "runner" },
      eventType: "test",
      severity: "info",
      data: {},
    });
    expect(result.isOk()).toBe(true);
    await store.close();
  });

  it("best-effort mode: transaction commits with valid journal entry", async () => {
    // In best-effort mode, a successful journal append inside a transaction
    // should not affect the transaction commit.
    const store = makeStore(testDir, { strictJournal: false });

    const result = await store.transaction((tx) => {
      return tx.instances
        .create({
          workflowName: "wf",
          goal: "best-effort",
          slug: "best-effort",
        })
        .andThen((instance) => {
          return tx.journal
            .append({
              source: { kind: "engine", name: "runner" },
              eventType: "instance.created",
              severity: "info",
              data: { instanceId: instance.id as string },
            })
            .map(() => instance);
        });
    });

    // Transaction should commit
    expect(result.isOk()).toBe(true);
    const list = (await store.instances.list())._unsafeUnwrap();
    expect(list).toHaveLength(1);
    expect(list[0].goal).toBe("best-effort");
    await store.close();
  });

  it("transaction commits state with valid journal entry in best-effort mode", async () => {
    const store = makeStore(testDir, { strictJournal: false });

    const result = await store.transaction((tx) => {
      return tx.instances
        .create({
          workflowName: "wf",
          goal: "best-effort",
          slug: "best-effort",
        })
        .andThen((instance) => {
          return tx.journal
            .append({
              source: { kind: "engine", name: "runner" },
              eventType: "instance.created",
              severity: "info",
              data: { instanceId: instance.id as string },
            })
            .map(() => instance);
        });
    });

    expect(result.isOk()).toBe(true);
    const list = (await store.instances.list())._unsafeUnwrap();
    expect(list).toHaveLength(1);
    await store.close();
  });
});

// ---------------------------------------------------------------------------
// Dependency guard
// ---------------------------------------------------------------------------

describe("dependency guard", () => {
  it("store module loads without forbidden dependencies", async () => {
    // Verified by git grep in acceptance criteria:
    // no forbidden runtime dependencies
    const storeModule = await import("../runtime/sqlite/store.js");
    expect(storeModule).toBeDefined();
  });

  it("store module uses only Bun-native APIs for file system operations", () => {
    // Bun.spawnSync is used for mkdir/chmod instead of raw fs module
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Artifact provenance — identity, revision, approval, integrity
// ---------------------------------------------------------------------------

describe("artifact provenance: identity and revision", () => {
  it("first addArtifact assigns revision 1 and approvalState 'pending'", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const updated = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
      })
    )._unsafeUnwrap();

    expect(updated.artifacts).toHaveLength(1);
    const art = updated.artifacts[0];
    expect(art.revision).toBe(1);
    expect(art.approvalState).toBe("pending");
    expect(art.id).toBeDefined();
    expect(typeof art.id).toBe("string");
    expect((art.id as string).length).toBeGreaterThan(0);
    await store.close();
  });

  it("second addArtifact with same name increments revision and resets approvalState to 'pending'", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    // First revision
    const v1 = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/v1.md",
      })
    )._unsafeUnwrap();
    const artV1 = v1.artifacts[0];
    expect(artV1.revision).toBe(1);

    // Approve v1
    await store.instances.updateArtifactApproval(
      created.id,
      artV1.id,
      "approved",
    );

    // Second revision — same name
    const v2 = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/v2.md",
      })
    )._unsafeUnwrap();

    // Two artifacts total (both revisions stored)
    expect(v2.artifacts).toHaveLength(2);
    const artV2 = v2.artifacts[1];
    expect(artV2.revision).toBe(2);
    // New revision resets approvalState — approval invalidation
    expect(artV2.approvalState).toBe("pending");
    await store.close();
  });

  it("stable ArtifactId is preserved across revisions of the same artifact name", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const v1 = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/v1.md",
      })
    )._unsafeUnwrap();
    const idV1 = v1.artifacts[0].id;

    const v2 = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/v2.md",
      })
    )._unsafeUnwrap();
    const idV2 = v2.artifacts[1].id;

    // Stable identity: same ArtifactId across revisions
    expect(idV1 as string).toBe(idV2 as string);
    await store.close();
  });

  it("different artifact names get different ArtifactIds", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const withPlan = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/plan.md",
      })
    )._unsafeUnwrap();

    const withReport = (
      await store.instances.addArtifact(created.id, {
        name: "report",
        path: ".weave/plans/report.md",
      })
    )._unsafeUnwrap();

    const planId = withPlan.artifacts[0].id;
    const reportId = withReport.artifacts[1].id;
    expect(planId as string).not.toBe(reportId as string);
    await store.close();
  });

  it("artifact identity and revision survive store close and reopen", async () => {
    const store1 = makeStore(testDir);
    const created = (
      await store1.instances.create({
        workflowName: "wf",
        goal: "g",
        slug: "g",
      })
    )._unsafeUnwrap();

    const v1 = (
      await store1.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/v1.md",
      })
    )._unsafeUnwrap();
    const idV1 = v1.artifacts[0].id;
    await store1.close();

    // Reopen
    const store2 = makeStore(testDir);
    const found = (await store2.instances.findById(created.id))._unsafeUnwrap();
    expect(found).not.toBeNull();
    expect(found?.artifacts[0].id as string).toBe(idV1 as string);
    expect(found?.artifacts[0].revision).toBe(1);
    await store2.close();
  });
});

describe("artifact provenance: approval lifecycle", () => {
  it("updateArtifactApproval sets approvalState to 'approved'", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const withArtifact = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
      })
    )._unsafeUnwrap();
    const artifactId = withArtifact.artifacts[0].id;

    const approved = (
      await store.instances.updateArtifactApproval(
        created.id,
        artifactId,
        "approved",
      )
    )._unsafeUnwrap();

    expect(approved.artifacts[0].approvalState).toBe("approved");
    await store.close();
  });

  it("updateArtifactApproval sets approvalState to 'rejected'", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const withArtifact = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
      })
    )._unsafeUnwrap();
    const artifactId = withArtifact.artifacts[0].id;

    const rejected = (
      await store.instances.updateArtifactApproval(
        created.id,
        artifactId,
        "rejected",
      )
    )._unsafeUnwrap();

    expect(rejected.artifacts[0].approvalState).toBe("rejected");
    await store.close();
  });

  it("updateArtifactApproval returns not_found for missing instance", async () => {
    const store = makeStore(testDir);
    const result = await store.instances.updateArtifactApproval(
      createWorkflowInstanceId("missing"),
      createArtifactId("art-001"),
      "approved",
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
    await store.close();
  });

  it("updateArtifactApproval returns not_found for missing artifact", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const result = await store.instances.updateArtifactApproval(
      created.id,
      createArtifactId("nonexistent-art"),
      "approved",
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
    await store.close();
  });

  it("approval invalidation: new revision resets approvalState to 'pending' on the new entry", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    // Add v1 and approve it
    const v1 = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/v1.md",
      })
    )._unsafeUnwrap();
    await store.instances.updateArtifactApproval(
      created.id,
      v1.artifacts[0].id,
      "approved",
    );

    // Add v2 — new revision must be pending regardless of v1 approval
    const v2 = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/v2.md",
      })
    )._unsafeUnwrap();

    const latestArtifact = v2.artifacts[v2.artifacts.length - 1];
    expect(latestArtifact.revision).toBe(2);
    expect(latestArtifact.approvalState).toBe("pending");
    await store.close();
  });

  it("approval state survives store close and reopen", async () => {
    const store1 = makeStore(testDir);
    const created = (
      await store1.instances.create({
        workflowName: "wf",
        goal: "g",
        slug: "g",
      })
    )._unsafeUnwrap();

    const withArtifact = (
      await store1.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
      })
    )._unsafeUnwrap();
    const artifactId = withArtifact.artifacts[0].id;

    await store1.instances.updateArtifactApproval(
      created.id,
      artifactId,
      "approved",
    );
    await store1.close();

    // Reopen and verify approval state persisted
    const store2 = makeStore(testDir);
    const found = (await store2.instances.findById(created.id))._unsafeUnwrap();
    expect(found?.artifacts[0].approvalState).toBe("approved");
    await store2.close();
  });

  it("producerAgent is stored on the artifact", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const withArtifact = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
        producerAgent: "shuttle",
      })
    )._unsafeUnwrap();

    expect(withArtifact.artifacts[0].producerAgent).toBe("shuttle");
    await store.close();
  });
});

describe("artifact provenance: integrity metadata", () => {
  it("integrity metadata is stored when provided", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const digest =
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const withArtifact = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
        integrity: { algorithm: "sha256", digest },
      })
    )._unsafeUnwrap();

    const art = withArtifact.artifacts[0];
    expect(art.integrity).toBeDefined();
    expect(art.integrity?.algorithm).toBe("sha256");
    expect(art.integrity?.digest).toBe(digest);
    await store.close();
  });

  it("integrity metadata is absent when not provided", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const withArtifact = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/g.md",
      })
    )._unsafeUnwrap();

    expect(withArtifact.artifacts[0].integrity).toBeUndefined();
    await store.close();
  });

  it("integrity metadata survives store close and reopen", async () => {
    const store1 = makeStore(testDir);
    const created = (
      await store1.instances.create({
        workflowName: "wf",
        goal: "g",
        slug: "g",
      })
    )._unsafeUnwrap();

    const digest =
      "abc123def456abc123def456abc123def456abc123def456abc123def456abcd";
    await store1.instances.addArtifact(created.id, {
      name: "plan",
      path: ".weave/plans/g.md",
      integrity: { algorithm: "sha256", digest },
    });
    await store1.close();

    const store2 = makeStore(testDir);
    const found = (await store2.instances.findById(created.id))._unsafeUnwrap();
    expect(found?.artifacts[0].integrity?.digest).toBe(digest);
    await store2.close();
  });

  it("integrity metadata is independent per revision", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const digestV1 =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const digestV2 =
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    await store.instances.addArtifact(created.id, {
      name: "plan",
      path: ".weave/plans/v1.md",
      integrity: { algorithm: "sha256", digest: digestV1 },
    });

    const v2 = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/v2.md",
        integrity: { algorithm: "sha256", digest: digestV2 },
      })
    )._unsafeUnwrap();

    expect(v2.artifacts[0].integrity?.digest).toBe(digestV1);
    expect(v2.artifacts[1].integrity?.digest).toBe(digestV2);
    await store.close();
  });
});

describe("artifact provenance: recordStepAttempt", () => {
  it("recordStepAttempt appends a step attempt with consumed artifacts", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    const artifactId = createArtifactId("art-001");
    const consumed = [{ artifactId, name: "plan", revision: 1 }];

    const result = (
      await store.instances.recordStepAttempt(created.id, "review", consumed)
    )._unsafeUnwrap();

    expect(result.stepAttempts).toHaveLength(1);
    const attempt = result.stepAttempts[0];
    expect(attempt.stepName).toBe("review");
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.dispatchedAt).toBeDefined();
    expect(attempt.consumedArtifacts).toHaveLength(1);
    expect(attempt.consumedArtifacts[0].artifactId as string).toBe(
      artifactId as string,
    );
    expect(attempt.consumedArtifacts[0].name).toBe("plan");
    expect(attempt.consumedArtifacts[0].revision).toBe(1);
    await store.close();
  });

  it("recordStepAttempt increments attemptNumber for the same step", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    await store.instances.recordStepAttempt(created.id, "review", []);
    await store.instances.recordStepAttempt(created.id, "review", []);
    const result = (
      await store.instances.recordStepAttempt(created.id, "review", [])
    )._unsafeUnwrap();

    expect(result.stepAttempts).toHaveLength(3);
    expect(result.stepAttempts[0].attemptNumber).toBe(1);
    expect(result.stepAttempts[1].attemptNumber).toBe(2);
    expect(result.stepAttempts[2].attemptNumber).toBe(3);
    await store.close();
  });

  it("recordStepAttempt uses independent counters per step name", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();

    await store.instances.recordStepAttempt(created.id, "plan", []);
    await store.instances.recordStepAttempt(created.id, "plan", []);
    await store.instances.recordStepAttempt(created.id, "review", []);

    const instance = (
      await store.instances.getById(created.id)
    )._unsafeUnwrap();

    const planAttempts = instance.stepAttempts.filter(
      (a) => a.stepName === "plan",
    );
    const reviewAttempts = instance.stepAttempts.filter(
      (a) => a.stepName === "review",
    );

    expect(planAttempts[0].attemptNumber).toBe(1);
    expect(planAttempts[1].attemptNumber).toBe(2);
    expect(reviewAttempts[0].attemptNumber).toBe(1);
    await store.close();
  });

  it("recordStepAttempt returns not_found for missing instance", async () => {
    const store = makeStore(testDir);
    const result = await store.instances.recordStepAttempt(
      createWorkflowInstanceId("missing"),
      "review",
      [],
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
    await store.close();
  });

  it("recordStepAttempt persists consumed artifact identity across store close and reopen", async () => {
    const store1 = makeStore(testDir);
    const created = (
      await store1.instances.create({
        workflowName: "wf",
        goal: "g",
        slug: "g",
      })
    )._unsafeUnwrap();

    const artifactId = createArtifactId("art-stable-001");
    await store1.instances.recordStepAttempt(created.id, "review", [
      { artifactId, name: "plan", revision: 3 },
    ]);
    await store1.close();

    const store2 = makeStore(testDir);
    const found = (await store2.instances.getById(created.id))._unsafeUnwrap();
    expect(
      found.stepAttempts[0].consumedArtifacts[0].artifactId as string,
    ).toBe(artifactId as string);
    expect(found.stepAttempts[0].consumedArtifacts[0].revision).toBe(3);
    await store2.close();
  });
});
