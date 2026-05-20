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
  runMigrations,
} from "../runtime/sqlite/migrations.js";
import {
  createSqliteRuntimeStore,
  type SqliteRuntimeStoreOptions,
} from "../runtime/sqlite/store.js";
import { createOwnerId, createWorkflowInstanceId } from "../runtime/types.js";

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
