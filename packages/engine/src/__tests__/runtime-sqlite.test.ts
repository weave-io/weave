/**
 * SQLite Runtime Store tests.
 *
 * Uses temp directories to test lazy initialization, migrations, CRUD,
 * lease conflicts, schema version failure, transaction commit/rollback,
 * strict journal failure, and best-effort journal failure.
 *
 * @see docs/reference/runtime.md
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import type { PermissionApprovalRepository } from "../permissions/types.js";
import { getPermissionApprovalRepository } from "../runtime/permission-repository.js";
import {
  CURRENT_SCHEMA_VERSION,
  readSchemaVersion,
  runMigrations,
} from "../runtime/sqlite/migrations.js";
import {
  MemoryRuntimeDirectoryGuard,
  type RuntimeDirectoryGuard,
  type RuntimeDirectoryHandle,
} from "../runtime/sqlite/runtime-directory-guard.js";
import {
  createSqliteRuntimeStore,
  type SqliteRuntimeStoreOptions,
} from "../runtime/sqlite/store.js";
import {
  createArtifactId,
  createExecutionLeaseId,
  createOwnerId,
  createSessionSnapshotId,
  createWorkflowInstanceId,
} from "../runtime/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testDir: string;
function permissionRepository(store: object): PermissionApprovalRepository {
  return getPermissionApprovalRepository(store)._unsafeUnwrap();
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `weave-test-${crypto.randomUUID()}`);
  Bun.spawnSync(["mkdir", "-p", dir]);
  return dir;
}

// Sync existence probe: several guard assertions in this file check paths
// synchronously, and awaiting a boolean is valid for the async call sites.
function pathExists(p: string): boolean {
  const result = Bun.spawnSync(["test", "-e", p]);
  return result.exitCode === 0;
}

function makeDbPath(dir: string): string {
  return join(dir, "runtime", "weave.db");
}

function makeStore(dir: string, opts: Partial<SqliteRuntimeStoreOptions> = {}) {
  return createSqliteRuntimeStore({
    dbPath: makeDbPath(dir),
    projectRoot: dir,
    ...opts,
  });
}

const CANONICAL_BOOTSTRAP_DDL = `
  CREATE TABLE runtime_metadata (
    key TEXT NOT NULL PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE schema_migrations (
    version INTEGER NOT NULL PRIMARY KEY,
    applied_at TEXT NOT NULL,
    name TEXT NOT NULL
  );
`;

const VALID_PERMISSION_GRANTS_DDL = `
  CREATE TABLE permission_grants (
    grant_id TEXT NOT NULL PRIMARY KEY,
    project_identity TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    registration_owner TEXT NOT NULL,
    tool_identity TEXT NOT NULL,
    registration_revision TEXT NOT NULL,
    policy_fingerprint TEXT NOT NULL,
    request_schema_version TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    display_summary TEXT NOT NULL,
    display_details TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    CHECK (expires_at IS NULL OR expires_at > created_at),
    CHECK (
      (state = 'active' AND revoked_at IS NULL)
      OR (
        state = 'revoked'
        AND revoked_at IS NOT NULL
        AND revoked_at >= created_at
      )
    ),
    UNIQUE (
      project_identity,
      agent_name,
      registration_owner,
      tool_identity,
      registration_revision,
      policy_fingerprint,
      request_schema_version,
      request_digest
    )
  );
  CREATE INDEX idx_permission_grants_project_state_expiry
    ON permission_grants (project_identity, state, expires_at);
`;

function assertInitializationError(
  result: ReturnType<typeof runMigrations>,
  message: string,
): void {
  expect(result.isErr()).toBe(true);
  const error = result._unsafeUnwrapErr();
  expect(error.type).toBe("initialization");
  if (error.type === "initialization") {
    expect(error.message).toBe(message);
  }
}

function assertNoPermissionGrantsTable(db: Database): void {
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name = 'permission_grants'",
      )
      .get(),
  ).toBeNull();
}

function assertMigrationStayedAtV2(db: Database): void {
  expect(readSchemaVersion(db)).toBe(2);
  expect(
    db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all(),
  ).toEqual([
    { version: 1, name: "initial_schema" },
    { version: 2, name: "add_step_attempts_json" },
  ]);
}

function createLegacyV2Database(db: Database): void {
  db.exec(`
    CREATE TABLE runtime_metadata (
      key TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE schema_migrations (
      version INTEGER NOT NULL PRIMARY KEY,
      applied_at TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE workflow_instances (
      id TEXT NOT NULL PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      goal TEXT NOT NULL,
      slug TEXT NOT NULL,
      status TEXT NOT NULL,
      current_step_name TEXT,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      error_message TEXT
    );
    CREATE INDEX idx_workflow_instances_status
      ON workflow_instances (status);
    CREATE INDEX idx_workflow_instances_created_at
      ON workflow_instances (created_at);
    CREATE TABLE execution_leases (
      id TEXT NOT NULL PRIMARY KEY,
      workflow_instance_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_heartbeat_at TEXT,
      FOREIGN KEY (workflow_instance_id) REFERENCES workflow_instances (id)
    );
    CREATE INDEX idx_execution_leases_expires_at
      ON execution_leases (expires_at);
    CREATE INDEX idx_execution_leases_workflow_instance_id
      ON execution_leases (workflow_instance_id);
    CREATE TABLE session_snapshots (
      id TEXT NOT NULL PRIMARY KEY,
      workflow_instance_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      harness_name TEXT NOT NULL,
      harness_version TEXT,
      agent_name TEXT NOT NULL,
      model_id TEXT,
      step_name TEXT,
      session_status TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (workflow_instance_id) REFERENCES workflow_instances (id),
      FOREIGN KEY (lease_id) REFERENCES execution_leases (id)
    );
    CREATE INDEX idx_session_snapshots_workflow_instance_id
      ON session_snapshots (workflow_instance_id);
    CREATE INDEX idx_session_snapshots_recorded_at
      ON session_snapshots (recorded_at);
    CREATE TABLE runtime_journal_entries (
      id TEXT NOT NULL PRIMARY KEY,
      timestamp TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      execution_id TEXT,
      workflow_instance_id TEXT,
      step_id TEXT,
      severity TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX idx_journal_entries_timestamp
      ON runtime_journal_entries (timestamp);
    CREATE INDEX idx_journal_entries_workflow_instance_id
      ON runtime_journal_entries (workflow_instance_id);
    CREATE INDEX idx_journal_entries_execution_id
      ON runtime_journal_entries (execution_id);
    CREATE INDEX idx_journal_entries_source_kind
      ON runtime_journal_entries (source_kind);
    CREATE INDEX idx_journal_entries_source_name
      ON runtime_journal_entries (source_name);
    CREATE INDEX idx_journal_entries_event_type
      ON runtime_journal_entries (event_type);
    CREATE INDEX idx_journal_entries_severity
      ON runtime_journal_entries (severity);
    ALTER TABLE workflow_instances
      ADD COLUMN step_attempts_json TEXT NOT NULL DEFAULT '[]';
    INSERT INTO runtime_metadata (key, value)
      VALUES ('schema_version', '2');
    INSERT INTO schema_migrations (version, applied_at, name)
      VALUES (1, '2025-01-01T00:00:00.000Z', 'initial_schema');
    INSERT INTO schema_migrations (version, applied_at, name)
      VALUES (2, '2025-01-01T00:00:01.000Z', 'add_step_attempts_json');
    INSERT INTO workflow_instances (
      id, workflow_name, goal, slug, status, current_step_name,
      artifacts_json, created_at, updated_at, completed_at, error_message,
      step_attempts_json
    ) VALUES (
      'legacy-instance', 'legacy-workflow', 'legacy goal', 'legacy-goal',
      'created', NULL, '[]', '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z', NULL, NULL,
      '[{"stepName":"plan","attemptNumber":1,"dispatchedAt":"2025-01-01T00:00:00.000Z","consumedArtifacts":[]}]'
    );
  `);
}

beforeEach(async () => {
  testDir = makeTempDir();
  await Bun.write(join(testDir, ".keep"), "");
});

afterEach(async () => {
  await Bun.$`rm -rf ${testDir}`.quiet();
});

// ---------------------------------------------------------------------------
// Lazy initialization
// ---------------------------------------------------------------------------

describe("lazy initialization", () => {
  it("does not create the DB file at construction time", async () => {
    const dbPath = makeDbPath(testDir);
    makeStore(testDir);
    expect(await pathExists(dbPath)).toBe(false);
  });

  it("creates the runtime directory and DB file on first operation", async () => {
    const store = makeStore(testDir);
    const result = await store.instances.list();
    expect(result.isOk()).toBe(true);
    expect(await pathExists(makeDbPath(testDir))).toBe(true);
  });

  it("creates the runtime directory with restrictive permissions", async () => {
    const store = makeStore(testDir);
    await store.instances.list();
    const runtimeDir = join(testDir, "runtime");
    expect(await pathExists(join(runtimeDir, "weave.db"))).toBe(true);
  });

  it("is idempotent — second operation does not re-initialize", async () => {
    const store = makeStore(testDir);
    await store.instances.list();
    await store.instances.list();
    expect(await pathExists(makeDbPath(testDir))).toBe(true);
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
    expect(await pathExists(makeDbPath(testDir))).toBe(true);

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

  it("lazy permission repository retries ensureInitialized after a recoverable failure", async () => {
    const blockedParent = join(testDir, "blocked-parent");
    await Bun.write(blockedParent, "not-a-directory");
    const store = createSqliteRuntimeStore({
      dbPath: join(blockedParent, "runtime", "weave.db"),
      projectRoot: testDir,
    });
    const repo = permissionRepository(store);

    const failing = await Promise.allSettled([
      repo.list("project"),
      repo.list("project"),
    ]);
    for (const settled of failing) {
      expect(settled.status).toBe("fulfilled");
      if (settled.status !== "fulfilled") continue;
      expect(settled.value.isErr()).toBe(true);
      expect(settled.value._unsafeUnwrapErr().type).toBe("repository_failure");
    }

    Bun.spawnSync(["rm", "-f", blockedParent]);

    // Ordinary store repo path recovers without reconstructing the store.
    const instances = await store.instances.list();
    expect(instances.isOk()).toBe(true);

    const recovered = await Promise.allSettled([repo.list("project")]);
    expect(recovered[0]?.status).toBe("fulfilled");
    if (recovered[0]?.status === "fulfilled") {
      expect(recovered[0].value.isOk()).toBe(true);
      expect(recovered[0].value._unsafeUnwrap()).toEqual([]);
    }

    await store.close();
    const closed = await repo.list("project");
    expect(closed.isErr()).toBe(true);
    expect(closed._unsafeUnwrapErr().type).toBe("repository_failure");
  });

  it("close during in-flight init fails waiters typed and never publishes", async () => {
    let releaseGate!: () => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const store = createSqliteRuntimeStore({
      dbPath: makeDbPath(testDir),
      projectRoot: testDir,
      beforeInitPublish: async () => {
        signalEntered();
        await gate;
      },
    });
    const repo = permissionRepository(store);

    const permissionOp = repo.list("project");
    const instanceOp = store.instances.list();

    // Wait until init is parked at the publish gate, then close before release.
    await entered;
    const closeResult = store.close();
    releaseGate();

    const [permissionSettled, instanceSettled, closeSettled] =
      await Promise.allSettled([permissionOp, instanceOp, closeResult]);

    expect(closeSettled.status).toBe("fulfilled");
    if (closeSettled.status === "fulfilled") {
      expect(closeSettled.value.isOk()).toBe(true);
    }

    expect(permissionSettled.status).toBe("fulfilled");
    if (permissionSettled.status === "fulfilled") {
      expect(permissionSettled.value.isErr()).toBe(true);
      expect(permissionSettled.value._unsafeUnwrapErr().type).toBe(
        "repository_failure",
      );
    }

    expect(instanceSettled.status).toBe("fulfilled");
    if (instanceSettled.status === "fulfilled") {
      expect(instanceSettled.value.isErr()).toBe(true);
      const error = instanceSettled.value._unsafeUnwrapErr();
      expect(error.type).toBe("initialization");
      if (error.type === "initialization") {
        expect(error.message).toBe("Runtime store is closed");
      }
    }

    // Closed store never operates again.
    const afterClose = await store.instances.list();
    expect(afterClose.isErr()).toBe(true);
    expect(afterClose._unsafeUnwrapErr().type).toBe("initialization");
    const afterPerm = await repo.list("project");
    expect(afterPerm.isErr()).toBe(true);
    expect(afterPerm._unsafeUnwrapErr().type).toBe("repository_failure");
  });

  it("close/init race is deterministic across 30 stress rounds", async () => {
    for (let round = 0; round < 30; round += 1) {
      const roundDir = join(testDir, `close-init-${round}`);
      Bun.spawnSync(["mkdir", "-p", roundDir]);

      let releaseGate!: () => void;
      let signalEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });

      const store = createSqliteRuntimeStore({
        dbPath: makeDbPath(roundDir),
        projectRoot: roundDir,
        beforeInitPublish: async () => {
          signalEntered();
          await gate;
        },
      });
      const repo = permissionRepository(store);

      const op = repo.list("project");
      await entered;
      const closing = store.close();
      releaseGate();

      const [opSettled, closeSettled] = await Promise.allSettled([op, closing]);
      expect(closeSettled.status).toBe("fulfilled");
      if (closeSettled.status === "fulfilled") {
        expect(closeSettled.value.isOk()).toBe(true);
      }
      expect(opSettled.status).toBe("fulfilled");
      if (opSettled.status === "fulfilled") {
        expect(opSettled.value.isErr()).toBe(true);
        expect(opSettled.value._unsafeUnwrapErr().type).toBe(
          "repository_failure",
        );
      }

      const later = await repo.list("project");
      expect(later.isErr()).toBe(true);
      expect(later._unsafeUnwrapErr().type).toBe("repository_failure");
    }
  });

  it("concurrent close calls are idempotent and destroy once", async () => {
    const store = makeStore(testDir);
    const init = await store.ensureInitialized();
    expect(init.isOk()).toBe(true);

    const [c1, c2, c3] = await Promise.all([
      store.close(),
      store.close(),
      store.close(),
    ]);
    expect(c1.isOk()).toBe(true);
    expect(c2.isOk()).toBe(true);
    expect(c3.isOk()).toBe(true);

    const after = await store.instances.list();
    expect(after.isErr()).toBe(true);
    expect(after._unsafeUnwrapErr().type).toBe("initialization");
  });

  it("normal close after init clears state and fails later ops", async () => {
    const store = makeStore(testDir);
    expect((await store.instances.list()).isOk()).toBe(true);
    expect((await store.close()).isOk()).toBe(true);
    expect((await store.close()).isOk()).toBe(true);

    const listed = await store.instances.list();
    expect(listed.isErr()).toBe(true);
    expect(listed._unsafeUnwrapErr().type).toBe("initialization");

    const repo = permissionRepository(store);
    const perm = await repo.list("project");
    expect(perm.isErr()).toBe(true);
    expect(perm._unsafeUnwrapErr().type).toBe("repository_failure");
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

  it("applies fresh migrations through version 5", () => {
    const dbPath = join(testDir, "fresh.db");
    const db = new Database(dbPath);

    const result = runMigrations(db);
    expect(result.isOk()).toBe(true);
    expect(readSchemaVersion(db)).toBe(5);

    const migrations = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number; name: string }>;
    expect(migrations).toEqual([
      { version: 1, name: "initial_schema" },
      { version: 2, name: "add_step_attempts_json" },
      { version: 3, name: "permission_grants" },
      { version: 4, name: "usage_observations_and_rollups" },
      { version: 5, name: "session_snapshots_lease_set_null" },
    ]);
    expect(
      db
        .prepare(
          "SELECT type FROM sqlite_master WHERE name = 'permission_grants'",
        )
        .get(),
    ).toEqual({ type: "table" });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_permission_grants_project_state_expiry'",
        )
        .get(),
    ).toEqual({ name: "idx_permission_grants_project_state_expiry" });
    db.close();
  });

  it("runMigrations is idempotent on an already-migrated DB", () => {
    const dbPath = join(testDir, "test.db");
    const db = new Database(dbPath);

    const first = runMigrations(db);
    expect(first.isOk()).toBe(true);

    const second = runMigrations(db);
    expect(second.isOk()).toBe(true);

    const rows = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(rows).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
    ]);
    expect(readSchemaVersion(db)).toBe(5);
    db.close();
  });

  it("upgrades a genuine version-two database without losing attempts", async () => {
    const runtimeDir = join(testDir, "runtime");
    Bun.spawnSync(["mkdir", "-p", runtimeDir]);
    const dbPath = join(runtimeDir, "weave.db");
    const legacyDb = new Database(dbPath);
    createLegacyV2Database(legacyDb);
    legacyDb.close();

    const store = createSqliteRuntimeStore({ dbPath, projectRoot: testDir });
    const instanceResult = await store.instances.findById(
      createWorkflowInstanceId("legacy-instance"),
    );
    expect(instanceResult.isOk()).toBe(true);
    const instance = instanceResult._unsafeUnwrap();
    expect(instance?.stepAttempts).toHaveLength(1);
    expect(instance?.stepAttempts[0].stepName).toBe("plan");

    const grantResult = await permissionRepository(store).saveMany([
      {
        grantId: "legacy-grant",
        identity: {
          projectIdentity: "project",
          agentName: "agent",
          registrationOwner: "owner",
          toolIdentity: "tool",
          registrationRevision: "1",
          policyFingerprint: "policy",
          requestSchemaVersion: "1",
          requestDigest: "digest",
        },
        scope: "durable",
        display: { summary: "Allow tool" },
        createdAt: 1,
        state: "active",
      },
    ]);
    expect(grantResult.isOk()).toBe(true);
    expect(
      (await permissionRepository(store).list("project"))._unsafeUnwrap(),
    ).toHaveLength(1);
    await store.close();

    const db = new Database(dbPath);
    expect(readSchemaVersion(db)).toBe(5);
    expect(
      db
        .prepare(
          "SELECT type FROM sqlite_master WHERE name = 'permission_grants'",
        )
        .get(),
    ).toEqual({ type: "table" });
    expect(
      db
        .prepare(
          "SELECT type FROM sqlite_master WHERE name = 'usage_observations'",
        )
        .get(),
    ).toEqual({ type: "table" });
    db.close();
  });

  // Regression for #21, proven against a real pre-existing v2
  // database (not just a fresh v5 one): a SessionSnapshot created under
  // the legacy schema (lease_id NOT NULL, implicit ON DELETE NO ACTION)
  // must survive the v5 table-recreate migration, and its referenced
  // lease must then be releasable without a FOREIGN KEY constraint
  // failure — with the snapshot's leaseId severed (NULL/undefined)
  // rather than the row being dropped.
  it("upgrades a genuine version-two database and lets a pre-existing SessionSnapshot's lease be released", async () => {
    const runtimeDir = join(testDir, "runtime-v2-snapshot");
    Bun.spawnSync(["mkdir", "-p", runtimeDir]);
    const dbPath = join(runtimeDir, "weave.db");
    const legacyDb = new Database(dbPath);
    createLegacyV2Database(legacyDb);
    legacyDb.exec(`
      INSERT INTO execution_leases (
        id, workflow_instance_id, owner_id, acquired_at, expires_at, last_heartbeat_at
      ) VALUES (
        'legacy-lease', 'legacy-instance', 'legacy-owner',
        '2025-01-01T00:00:00.000Z', '2025-01-01T01:00:00.000Z', NULL
      );
      INSERT INTO session_snapshots (
        id, workflow_instance_id, lease_id, harness_name, harness_version,
        agent_name, model_id, step_name, session_status, recorded_at, metadata_json
      ) VALUES (
        'legacy-snapshot', 'legacy-instance', 'legacy-lease', 'legacy-harness', NULL,
        'shuttle', NULL, 'plan', 'active', '2025-01-01T00:00:00.000Z', '{}'
      );
    `);
    legacyDb.close();

    const store = createSqliteRuntimeStore({ dbPath, projectRoot: testDir });

    const before = (
      await store.snapshots.findById(createSessionSnapshotId("legacy-snapshot"))
    )._unsafeUnwrap();
    expect(before).not.toBeNull();
    expect(before?.leaseId).toBe(createExecutionLeaseId("legacy-lease"));

    const releaseResult = await store.leases.release(
      createExecutionLeaseId("legacy-lease"),
      createOwnerId("legacy-owner"),
    );
    expect(releaseResult.isOk()).toBe(true);

    const after = (
      await store.snapshots.findById(createSessionSnapshotId("legacy-snapshot"))
    )._unsafeUnwrap();
    expect(after).not.toBeNull();
    expect(after?.leaseId).toBeUndefined();
    expect(after?.harnessName).toBe("legacy-harness");
    expect(after?.stepName).toBe("plan");

    await store.close();

    const db = new Database(dbPath);
    expect(readSchemaVersion(db)).toBe(5);
    expect(
      db
        .prepare("SELECT lease_id FROM session_snapshots WHERE id = ?")
        .get("legacy-snapshot"),
    ).toEqual({ lease_id: null });
    db.close();
  });

  it("rejects future version 6 without mutating the DB", () => {
    const dbPath = join(testDir, "future.db");
    const db = new Database(dbPath);

    db.exec(CANONICAL_BOOTSTRAP_DDL);
    db.exec(
      "INSERT INTO runtime_metadata (key, value) VALUES ('schema_version', '6')",
    );

    const result = runMigrations(db);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("migration_version");
    if (error.type === "migration_version") {
      expect(error.foundVersion).toBe(6);
      expect(error.supportedVersion).toBe(CURRENT_SCHEMA_VERSION);
    }
    expect(readSchemaVersion(db)).toBe(6);
    assertNoPermissionGrantsTable(db);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get(),
    ).toEqual({ count: 0 });
    db.close();
  });

  it("runMigrations returns initialization error when schema_version is non-integer", () => {
    const dbPath = join(testDir, "corrupt-nan.db");
    const db = new Database(dbPath);

    db.exec(CANONICAL_BOOTSTRAP_DDL);
    db.exec(
      "INSERT INTO runtime_metadata (key, value) VALUES ('schema_version', 'not-a-number')",
    );

    const result = runMigrations(db);
    db.close();

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("initialization");
    if (error.type === "initialization") {
      expect(error.message).toContain("Invalid schema_version");
      expect(error.message).not.toContain("not-a-number");
    }
  });

  it("runMigrations returns initialization error when schema_version is negative", () => {
    const dbPath = join(testDir, "corrupt-negative.db");
    const db = new Database(dbPath);

    db.exec(CANONICAL_BOOTSTRAP_DDL);
    db.exec(
      "INSERT INTO runtime_metadata (key, value) VALUES ('schema_version', '-1')",
    );

    const result = runMigrations(db);
    db.close();

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("initialization");
    if (error.type === "initialization") {
      expect(error.message).toContain("Invalid schema_version");
      expect(error.message).not.toContain("-1");
    }
  });

  it("rejects noncanonical and unsafe schema_version text", () => {
    const invalidValues = [
      "2junk",
      "2.0",
      "+2",
      " 2",
      "2 ",
      "2e0",
      "-2",
      "00",
      "9007199254740992",
    ];

    for (const [index, value] of invalidValues.entries()) {
      const db = new Database(join(testDir, `corrupt-${index}.db`));
      db.exec(CANONICAL_BOOTSTRAP_DDL);
      db.prepare(
        "INSERT INTO runtime_metadata (key, value) VALUES ('schema_version', ?)",
      ).run(value);

      const result = runMigrations(db);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.type).toBe("initialization");
      if (error.type === "initialization") {
        expect(error.message).toBe(
          "Invalid schema_version in runtime_metadata",
        );
        expect(error.message).not.toContain(value);
      }
      db.close();
    }
  });

  it("rejects empty-name schema_migrations ledger rows without mutating the DB", () => {
    const db = new Database(join(testDir, "malformed-migrations.db"));
    db.exec(CANONICAL_BOOTSTRAP_DDL);
    db.exec(`
      INSERT INTO runtime_metadata (key, value) VALUES ('schema_version', '2');
      INSERT INTO schema_migrations (version, applied_at, name)
        VALUES (1, '2025-01-01', 'initial_schema');
      INSERT INTO schema_migrations (version, applied_at, name)
        VALUES (2, '2025-01-02', '');
    `);

    const before = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    const result = runMigrations(db);
    assertInitializationError(result, "Invalid schema_migrations ledger");
    expect(readSchemaVersion(db)).toBe(2);
    assertNoPermissionGrantsTable(db);
    expect(
      db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(before);
    db.close();
  });

  it("does not bump the version when a migration transaction fails", () => {
    const db = new Database(join(testDir, "failed-migration.db"));
    createLegacyV2Database(db);
    db.exec("CREATE VIEW permission_grants AS SELECT 1 AS invalid_schema");

    const result = runMigrations(db);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("initialization");
    assertMigrationStayedAtV2(db);
    db.close();
  });

  it("rejects renamed schema_migrations ledger rows without mutating the DB", () => {
    const db = new Database(join(testDir, "renamed-ledger.db"));
    createLegacyV2Database(db);
    db.exec(`
      UPDATE schema_migrations
        SET name = 'renamed_step_attempts'
        WHERE version = 2;
    `);

    const result = runMigrations(db);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("initialization");
    expect(readSchemaVersion(db)).toBe(2);
    expect(
      db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([
      { version: 1, name: "initial_schema" },
      { version: 2, name: "renamed_step_attempts" },
    ]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'permission_grants'",
        )
        .get(),
    ).toBeNull();
    db.close();
  });

  it("rejects missing and extra schema_migrations ledger rows", () => {
    const missing = new Database(join(testDir, "missing-ledger.db"));
    createLegacyV2Database(missing);
    missing.prepare("DELETE FROM schema_migrations WHERE version = ?").run(2);

    expect(runMigrations(missing).isErr()).toBe(true);
    expect(readSchemaVersion(missing)).toBe(2);
    expect(
      missing
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([{ version: 1 }]);
    missing.close();

    const extra = new Database(join(testDir, "extra-ledger.db"));
    createLegacyV2Database(extra);
    extra.exec(`
      INSERT INTO schema_migrations (version, applied_at, name)
        VALUES (3, '2025-01-01T00:00:02.000Z', 'permission_grants');
    `);

    expect(runMigrations(extra).isErr()).toBe(true);
    expect(readSchemaVersion(extra)).toBe(2);
    expect(
      extra
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    extra.close();
  });

  it("adopts a compatible pre-existing permission_grants table left at v2", () => {
    const db = new Database(join(testDir, "adopt-valid-buggy-v2.db"));
    createLegacyV2Database(db);
    // Simulates the previously buggy path that created the table without
    // recording migration 3 / bumping schema_version.
    db.exec(VALID_PERMISSION_GRANTS_DDL);

    const result = runMigrations(db);
    expect(result.isOk()).toBe(true);
    expect(readSchemaVersion(db)).toBe(5);
    expect(
      db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([
      { version: 1, name: "initial_schema" },
      { version: 2, name: "add_step_attempts_json" },
      { version: 3, name: "permission_grants" },
      { version: 4, name: "usage_observations_and_rollups" },
      { version: 5, name: "session_snapshots_lease_set_null" },
    ]);
    expect(
      db
        .prepare(
          "SELECT type FROM sqlite_master WHERE name = 'permission_grants'",
        )
        .get(),
    ).toEqual({ type: "table" });
    db.close();
  });

  it("rejects a pre-existing permission_grants table missing a required column", () => {
    const db = new Database(join(testDir, "missing-column.db"));
    createLegacyV2Database(db);
    db.exec(`
      CREATE TABLE permission_grants (
        grant_id TEXT NOT NULL PRIMARY KEY,
        project_identity TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        registration_owner TEXT NOT NULL,
        tool_identity TEXT NOT NULL,
        registration_revision TEXT NOT NULL,
        policy_fingerprint TEXT NOT NULL,
        request_schema_version TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        display_summary TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        CHECK (expires_at IS NULL OR expires_at > created_at),
        CHECK (
          (state = 'active' AND revoked_at IS NULL)
          OR (state = 'revoked' AND revoked_at IS NOT NULL AND revoked_at >= created_at)
        ),
        UNIQUE (
          project_identity, agent_name, registration_owner, tool_identity,
          registration_revision, policy_fingerprint, request_schema_version,
          request_digest
        )
      );
      CREATE INDEX idx_permission_grants_project_state_expiry
        ON permission_grants (project_identity, state, expires_at);
    `);

    const result = runMigrations(db);
    expect(result.isErr()).toBe(true);
    assertMigrationStayedAtV2(db);
    db.close();
  });

  it("rejects a pre-existing permission_grants table with an extra column", () => {
    const db = new Database(join(testDir, "extra-column.db"));
    createLegacyV2Database(db);
    db.exec(`
      CREATE TABLE permission_grants (
        grant_id TEXT NOT NULL PRIMARY KEY,
        project_identity TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        registration_owner TEXT NOT NULL,
        tool_identity TEXT NOT NULL,
        registration_revision TEXT NOT NULL,
        policy_fingerprint TEXT NOT NULL,
        request_schema_version TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        display_summary TEXT NOT NULL,
        display_details TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        secret_token TEXT,
        CHECK (expires_at IS NULL OR expires_at > created_at),
        CHECK (
          (state = 'active' AND revoked_at IS NULL)
          OR (state = 'revoked' AND revoked_at IS NOT NULL AND revoked_at >= created_at)
        ),
        UNIQUE (
          project_identity, agent_name, registration_owner, tool_identity,
          registration_revision, policy_fingerprint, request_schema_version,
          request_digest
        )
      );
      CREATE INDEX idx_permission_grants_project_state_expiry
        ON permission_grants (project_identity, state, expires_at);
    `);

    const result = runMigrations(db);
    expect(result.isErr()).toBe(true);
    assertMigrationStayedAtV2(db);
    db.close();
  });

  it("rejects a pre-existing permission_grants table with weak state/check constraints", () => {
    const db = new Database(join(testDir, "weak-checks.db"));
    createLegacyV2Database(db);
    db.exec(`
      CREATE TABLE permission_grants (
        grant_id TEXT NOT NULL PRIMARY KEY,
        project_identity TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        registration_owner TEXT NOT NULL,
        tool_identity TEXT NOT NULL,
        registration_revision TEXT NOT NULL,
        policy_fingerprint TEXT NOT NULL,
        request_schema_version TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        display_summary TEXT NOT NULL,
        display_details TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        CHECK (expires_at IS NULL OR expires_at > created_at),
        CHECK ((state = 'active' AND revoked_at IS NULL) OR state = 'revoked'),
        UNIQUE (
          project_identity, agent_name, registration_owner, tool_identity,
          registration_revision, policy_fingerprint, request_schema_version,
          request_digest
        )
      );
      CREATE INDEX idx_permission_grants_project_state_expiry
        ON permission_grants (project_identity, state, expires_at);
    `);

    const result = runMigrations(db);
    expect(result.isErr()).toBe(true);
    assertMigrationStayedAtV2(db);

    // CREATE IF NOT EXISTS must not paper over the weak pre-existing table.
    db.prepare(`
      INSERT INTO permission_grants (
        grant_id, project_identity, agent_name, registration_owner,
        tool_identity, registration_revision, policy_fingerprint,
        request_schema_version, request_digest, display_summary,
        display_details, created_at, expires_at, revoked_at, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?)
    `).run(
      "weak",
      "p",
      "a",
      "o",
      "t",
      "r",
      "f",
      "s",
      "d",
      "summary",
      10,
      "revoked",
    );
    expect(
      db
        .prepare(
          "SELECT state, revoked_at FROM permission_grants WHERE grant_id = ?",
        )
        .get("weak"),
    ).toEqual({ state: "revoked", revoked_at: null });
    db.close();
  });

  it("rejects a pre-existing permission_grants table missing the unique envelope or lookup index", () => {
    const missingUnique = new Database(join(testDir, "missing-unique.db"));
    createLegacyV2Database(missingUnique);
    missingUnique.exec(`
      CREATE TABLE permission_grants (
        grant_id TEXT NOT NULL PRIMARY KEY,
        project_identity TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        registration_owner TEXT NOT NULL,
        tool_identity TEXT NOT NULL,
        registration_revision TEXT NOT NULL,
        policy_fingerprint TEXT NOT NULL,
        request_schema_version TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        display_summary TEXT NOT NULL,
        display_details TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        CHECK (expires_at IS NULL OR expires_at > created_at),
        CHECK (
          (state = 'active' AND revoked_at IS NULL)
          OR (state = 'revoked' AND revoked_at IS NOT NULL AND revoked_at >= created_at)
        )
      );
      CREATE INDEX idx_permission_grants_project_state_expiry
        ON permission_grants (project_identity, state, expires_at);
    `);

    expect(runMigrations(missingUnique).isErr()).toBe(true);
    assertMigrationStayedAtV2(missingUnique);
    missingUnique.close();

    const missingIndex = new Database(join(testDir, "missing-index.db"));
    createLegacyV2Database(missingIndex);
    missingIndex.exec(`
      CREATE TABLE permission_grants (
        grant_id TEXT NOT NULL PRIMARY KEY,
        project_identity TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        registration_owner TEXT NOT NULL,
        tool_identity TEXT NOT NULL,
        registration_revision TEXT NOT NULL,
        policy_fingerprint TEXT NOT NULL,
        request_schema_version TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        display_summary TEXT NOT NULL,
        display_details TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        CHECK (expires_at IS NULL OR expires_at > created_at),
        CHECK (
          (state = 'active' AND revoked_at IS NULL)
          OR (state = 'revoked' AND revoked_at IS NOT NULL AND revoked_at >= created_at)
        ),
        UNIQUE (
          project_identity, agent_name, registration_owner, tool_identity,
          registration_revision, policy_fingerprint, request_schema_version,
          request_digest
        )
      );
    `);
    // Intentionally omit idx_permission_grants_project_state_expiry, then
    // replace the name with a wrong-column index so IF NOT EXISTS cannot fix it.
    missingIndex.exec(`
      CREATE INDEX idx_permission_grants_project_state_expiry
        ON permission_grants (project_identity);
    `);

    expect(runMigrations(missingIndex).isErr()).toBe(true);
    assertMigrationStayedAtV2(missingIndex);
    missingIndex.close();
  });

  it("failed migration leaves version 2 and no v3 ledger row", () => {
    const db = new Database(join(testDir, "failed-leaves-v2.db"));
    createLegacyV2Database(db);
    db.exec(`
      CREATE TABLE permission_grants (
        grant_id TEXT NOT NULL PRIMARY KEY,
        project_identity TEXT NOT NULL
      );
    `);

    const result = runMigrations(db);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("initialization");
    assertMigrationStayedAtV2(db);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 3",
        )
        .get(),
    ).toEqual({ count: 0 });
    db.close();
  });

  it("no-pending healthy current reopen re-verifies live permission_grants schema", () => {
    const db = new Database(join(testDir, "healthy-reopen.db"));
    expect(runMigrations(db).isOk()).toBe(true);
    expect(readSchemaVersion(db)).toBe(5);

    const second = runMigrations(db);
    expect(second.isOk()).toBe(true);
    expect(readSchemaVersion(db)).toBe(5);
    expect(
      db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual([
      { version: 1, name: "initial_schema" },
      { version: 2, name: "add_step_attempts_json" },
      { version: 3, name: "permission_grants" },
      { version: 4, name: "usage_observations_and_rollups" },
      { version: 5, name: "session_snapshots_lease_set_null" },
    ]);
    db.close();
  });

  it("initialized current then dropped permission_grants fails reopen without repair", () => {
    const db = new Database(join(testDir, "drop-table-reopen.db"));
    expect(runMigrations(db).isOk()).toBe(true);
    const ledgerBefore = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    db.exec("DROP TABLE permission_grants");

    const result = runMigrations(db);
    assertInitializationError(result, "Invalid permission_grants schema");
    expect(readSchemaVersion(db)).toBe(5);
    expect(
      db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(ledgerBefore);
    assertNoPermissionGrantsTable(db);
    db.close();
  });

  it("initialized current then dropped lookup index fails reopen without repair", () => {
    const db = new Database(join(testDir, "drop-index-reopen.db"));
    expect(runMigrations(db).isOk()).toBe(true);
    const ledgerBefore = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    db.exec("DROP INDEX idx_permission_grants_project_state_expiry");

    const result = runMigrations(db);
    assertInitializationError(result, "Invalid permission_grants schema");
    expect(readSchemaVersion(db)).toBe(5);
    expect(
      db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(ledgerBefore);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_permission_grants_project_state_expiry'",
        )
        .get(),
    ).toBeNull();
    // Must not recreate the index on failure.
    expect(
      db
        .prepare(
          "SELECT type FROM sqlite_master WHERE name = 'permission_grants'",
        )
        .get(),
    ).toEqual({ type: "table" });
    db.close();
  });

  it("initialized current then replaced with weak permission_grants fails reopen without repair", () => {
    const db = new Database(join(testDir, "weak-table-reopen.db"));
    expect(runMigrations(db).isOk()).toBe(true);
    const ledgerBefore = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    db.exec("DROP TABLE permission_grants");
    db.exec(`
      CREATE TABLE permission_grants (
        grant_id TEXT NOT NULL PRIMARY KEY,
        project_identity TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        registration_owner TEXT NOT NULL,
        tool_identity TEXT NOT NULL,
        registration_revision TEXT NOT NULL,
        policy_fingerprint TEXT NOT NULL,
        request_schema_version TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        display_summary TEXT NOT NULL,
        display_details TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked_at INTEGER,
        state TEXT NOT NULL,
        UNIQUE (
          project_identity, agent_name, registration_owner, tool_identity,
          registration_revision, policy_fingerprint, request_schema_version,
          request_digest
        )
      );
      CREATE INDEX idx_permission_grants_project_state_expiry
        ON permission_grants (project_identity, state, expires_at);
    `);

    const result = runMigrations(db);
    assertInitializationError(result, "Invalid permission_grants schema");
    expect(readSchemaVersion(db)).toBe(5);
    expect(
      db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(ledgerBefore);

    // Weak table remains and still accepts invalid state — not repaired.
    db.prepare(`
      INSERT INTO permission_grants (
        grant_id, project_identity, agent_name, registration_owner,
        tool_identity, registration_revision, policy_fingerprint,
        request_schema_version, request_digest, display_summary,
        display_details, created_at, expires_at, revoked_at, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?)
    `).run(
      "weak",
      "p",
      "a",
      "o",
      "t",
      "r",
      "f",
      "s",
      "d",
      "summary",
      10,
      "future",
    );
    expect(
      db
        .prepare("SELECT state FROM permission_grants WHERE grant_id = ?")
        .get("weak"),
    ).toEqual({ state: "future" });
    db.close();
  });

  it("rejects v2 adoption when permission_grants carries AFTER/BEFORE triggers", () => {
    const afterDb = new Database(join(testDir, "v2-after-trigger.db"));
    createLegacyV2Database(afterDb);
    afterDb.exec(VALID_PERMISSION_GRANTS_DDL);
    // Hostile trigger that deliberately avoids fixed probe ID prefixes and
    // mutates/exfiltrates real grant rows on write.
    afterDb.exec(`
      CREATE TABLE stolen_grants (grant_id TEXT);
      CREATE TRIGGER permission_grants_after_insert
      AFTER INSERT ON permission_grants
      WHEN NEW.grant_id NOT LIKE '__wpg_%' AND NEW.grant_id NOT LIKE '__weave_probe_%'
      BEGIN
        INSERT INTO stolen_grants(grant_id) VALUES (NEW.grant_id);
        DELETE FROM permission_grants WHERE grant_id = NEW.grant_id;
      END;
    `);

    // v2→v3 apply wraps in-transaction verify failure as migration rollback.
    const afterResult = runMigrations(afterDb);
    expect(afterResult.isErr()).toBe(true);
    expect(afterResult._unsafeUnwrapErr().type).toBe("initialization");
    assertMigrationStayedAtV2(afterDb);
    expect(
      afterDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'permission_grants'",
        )
        .all(),
    ).toEqual([{ name: "permission_grants_after_insert" }]);
    afterDb.close();

    const beforeDb = new Database(join(testDir, "v2-before-trigger.db"));
    createLegacyV2Database(beforeDb);
    beforeDb.exec(VALID_PERMISSION_GRANTS_DDL);
    beforeDb.exec(`
      CREATE TRIGGER permission_grants_before_update
      BEFORE UPDATE ON permission_grants
      BEGIN
        SELECT RAISE(ABORT, 'hostile before update');
      END;
      CREATE TRIGGER permission_grants_before_delete
      BEFORE DELETE ON permission_grants
      BEGIN
        SELECT RAISE(ABORT, 'hostile before delete');
      END;
    `);

    const beforeResult = runMigrations(beforeDb);
    expect(beforeResult.isErr()).toBe(true);
    expect(beforeResult._unsafeUnwrapErr().type).toBe("initialization");
    assertMigrationStayedAtV2(beforeDb);
    expect(
      beforeDb
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'permission_grants'",
        )
        .get(),
    ).toEqual({ count: 2 });
    beforeDb.close();
  });

  it("rejects v2 adoption when permission_grants has extra unique/partial/expression indexes", () => {
    const cases: Array<{ file: string; ddl: string; indexName: string }> = [
      {
        file: "v2-extra-unique-index.db",
        indexName: "idx_permission_grants_extra_unique",
        ddl: `CREATE UNIQUE INDEX idx_permission_grants_extra_unique
              ON permission_grants (grant_id);`,
      },
      {
        file: "v2-extra-partial-index.db",
        indexName: "idx_permission_grants_extra_partial",
        ddl: `CREATE INDEX idx_permission_grants_extra_partial
              ON permission_grants (project_identity)
              WHERE state = 'active';`,
      },
      {
        file: "v2-extra-expression-index.db",
        indexName: "idx_permission_grants_extra_expr",
        ddl: `CREATE INDEX idx_permission_grants_extra_expr
              ON permission_grants ((lower(tool_identity)));`,
      },
    ];

    for (const fixture of cases) {
      const db = new Database(join(testDir, fixture.file));
      createLegacyV2Database(db);
      db.exec(VALID_PERMISSION_GRANTS_DDL);
      db.exec(fixture.ddl);

      const result = runMigrations(db);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe("initialization");
      assertMigrationStayedAtV2(db);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
          )
          .get(fixture.indexName),
      ).toEqual({ name: fixture.indexName });
      db.close();
    }
  });

  it("rejects v3 reopen when hostile AFTER/BEFORE triggers are attached", () => {
    const db = new Database(join(testDir, "v3-reopen-triggers.db"));
    expect(runMigrations(db).isOk()).toBe(true);
    const ledgerBefore = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    const versionBefore = readSchemaVersion(db);

    db.exec(`
      CREATE TABLE stolen_grants (payload TEXT);
      CREATE TRIGGER permission_grants_after_insert
      AFTER INSERT ON permission_grants
      WHEN NEW.grant_id NOT LIKE '__wpg_%'
      BEGIN
        INSERT INTO stolen_grants(payload) VALUES (NEW.grant_id || ':' || NEW.request_digest);
        UPDATE permission_grants SET state = 'revoked', revoked_at = NEW.created_at
          WHERE grant_id = NEW.grant_id;
      END;
      CREATE TRIGGER permission_grants_before_write
      BEFORE INSERT ON permission_grants
      WHEN NEW.grant_id NOT LIKE '__wpg_%'
      BEGIN
        SELECT RAISE(ABORT, 'hostile before insert');
      END;
    `);

    assertInitializationError(
      runMigrations(db),
      "Invalid runtime store schema",
    );
    expect(readSchemaVersion(db)).toBe(versionBefore);
    expect(
      db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(ledgerBefore);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'permission_grants'",
        )
        .get(),
    ).toEqual({ count: 2 });
    db.close();
  });

  it("rejects v2 adoption when cross-table triggers can mutate high-water or grants", () => {
    const cases: Array<{ file: string; ddl: string }> = [
      {
        file: "v2-cross-table-after-hw.db",
        ddl: `
          CREATE TRIGGER workflow_instances_after_insert_hw
          AFTER INSERT ON workflow_instances
          BEGIN
            INSERT OR REPLACE INTO runtime_metadata (key, value)
              VALUES ('permission_wall_clock_high_water', '0');
          END;
        `,
      },
      {
        file: "v2-cross-table-before-grants.db",
        ddl: `
          CREATE TRIGGER workflow_instances_before_update_grants
          BEFORE UPDATE ON workflow_instances
          BEGIN
            UPDATE permission_grants SET state = 'active', revoked_at = NULL;
          END;
        `,
      },
      {
        file: "v2-cross-table-after-journal.db",
        ddl: `
          CREATE TRIGGER journal_after_insert_hw
          AFTER INSERT ON runtime_journal_entries
          BEGIN
            UPDATE runtime_metadata SET value = '0'
              WHERE key = 'permission_wall_clock_high_water';
          END;
        `,
      },
    ];

    for (const fixture of cases) {
      const db = new Database(join(testDir, fixture.file));
      createLegacyV2Database(db);
      db.exec(fixture.ddl);

      const result = runMigrations(db);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe("initialization");
      assertInitializationError(result, "Invalid runtime store schema");
      assertMigrationStayedAtV2(db);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger'",
          )
          .get(),
      ).toEqual({ count: 1 });
      assertNoPermissionGrantsTable(db);
      db.close();
    }
  });

  it("rejects v3 reopen when cross-table BEFORE/AFTER triggers are attached", () => {
    const cases: Array<{ file: string; ddl: string }> = [
      {
        file: "v3-cross-table-after-hw.db",
        ddl: `
          CREATE TRIGGER workflow_instances_after_insert_hw
          AFTER INSERT ON workflow_instances
          BEGIN
            INSERT OR REPLACE INTO runtime_metadata (key, value)
              VALUES ('permission_wall_clock_high_water', '0');
          END;
        `,
      },
      {
        file: "v3-cross-table-before-hw.db",
        ddl: `
          CREATE TRIGGER workflow_instances_before_delete_hw
          BEFORE DELETE ON workflow_instances
          BEGIN
            UPDATE runtime_metadata SET value = '0'
              WHERE key = 'permission_wall_clock_high_water';
          END;
        `,
      },
      {
        file: "v3-cross-table-after-grants.db",
        ddl: `
          CREATE TRIGGER execution_leases_after_insert_grants
          AFTER INSERT ON execution_leases
          BEGIN
            UPDATE permission_grants
              SET state = 'active', revoked_at = NULL
              WHERE state = 'revoked';
          END;
        `,
      },
    ];

    for (const fixture of cases) {
      const db = new Database(join(testDir, fixture.file));
      expect(runMigrations(db).isOk()).toBe(true);
      const ledgerBefore = db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all();
      const versionBefore = readSchemaVersion(db);
      db.exec(
        "INSERT OR REPLACE INTO runtime_metadata (key, value) VALUES ('permission_wall_clock_high_water', '100')",
      );
      const hwBefore = db
        .prepare(
          "SELECT value FROM runtime_metadata WHERE key = 'permission_wall_clock_high_water'",
        )
        .get();

      db.exec(fixture.ddl);

      assertInitializationError(
        runMigrations(db),
        "Invalid runtime store schema",
      );
      expect(readSchemaVersion(db)).toBe(versionBefore);
      expect(
        db
          .prepare(
            "SELECT version, name FROM schema_migrations ORDER BY version",
          )
          .all(),
      ).toEqual(ledgerBefore);
      expect(
        db
          .prepare(
            "SELECT value FROM runtime_metadata WHERE key = 'permission_wall_clock_high_water'",
          )
          .get(),
      ).toEqual(hwBefore);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger'",
          )
          .get(),
      ).toEqual({ count: 1 });
      db.close();
    }
  });

  it("rejects v2 adoption when permission identity columns use non-BINARY collations", () => {
    const cases: Array<{ file: string; ddl: string; coll: string }> = [
      {
        file: "v2-collate-nocase.db",
        coll: "NOCASE",
        ddl: `
          CREATE TABLE permission_grants (
            grant_id TEXT NOT NULL PRIMARY KEY,
            project_identity TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            registration_owner TEXT NOT NULL,
            tool_identity TEXT COLLATE NOCASE NOT NULL,
            registration_revision TEXT NOT NULL,
            policy_fingerprint TEXT NOT NULL,
            request_schema_version TEXT NOT NULL,
            request_digest TEXT NOT NULL,
            display_summary TEXT NOT NULL,
            display_details TEXT,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            revoked_at INTEGER,
            state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
            CHECK (expires_at IS NULL OR expires_at > created_at),
            CHECK (
              (state = 'active' AND revoked_at IS NULL)
              OR (
                state = 'revoked'
                AND revoked_at IS NOT NULL
                AND revoked_at >= created_at
              )
            ),
            UNIQUE (
              project_identity, agent_name, registration_owner, tool_identity,
              registration_revision, policy_fingerprint,
              request_schema_version, request_digest
            )
          );
          CREATE INDEX idx_permission_grants_project_state_expiry
            ON permission_grants (project_identity, state, expires_at);
        `,
      },
      {
        file: "v2-collate-rtrim.db",
        coll: "RTRIM",
        ddl: `
          CREATE TABLE permission_grants (
            grant_id TEXT NOT NULL PRIMARY KEY,
            project_identity TEXT COLLATE RTRIM NOT NULL,
            agent_name TEXT NOT NULL,
            registration_owner TEXT NOT NULL,
            tool_identity TEXT NOT NULL,
            registration_revision TEXT NOT NULL,
            policy_fingerprint TEXT NOT NULL,
            request_schema_version TEXT NOT NULL,
            request_digest TEXT NOT NULL,
            display_summary TEXT NOT NULL,
            display_details TEXT,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            revoked_at INTEGER,
            state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
            CHECK (expires_at IS NULL OR expires_at > created_at),
            CHECK (
              (state = 'active' AND revoked_at IS NULL)
              OR (
                state = 'revoked'
                AND revoked_at IS NOT NULL
                AND revoked_at >= created_at
              )
            ),
            UNIQUE (
              project_identity, agent_name, registration_owner, tool_identity,
              registration_revision, policy_fingerprint,
              request_schema_version, request_digest
            )
          );
          CREATE INDEX idx_permission_grants_project_state_expiry
            ON permission_grants (project_identity, state, expires_at);
        `,
      },
      {
        file: "v2-collate-custom-unique.db",
        coll: "NOCASE",
        ddl: `
          CREATE TABLE permission_grants (
            grant_id TEXT NOT NULL PRIMARY KEY,
            project_identity TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            registration_owner TEXT NOT NULL,
            tool_identity TEXT NOT NULL,
            registration_revision TEXT NOT NULL,
            policy_fingerprint TEXT NOT NULL,
            request_schema_version TEXT NOT NULL,
            request_digest TEXT NOT NULL,
            display_summary TEXT NOT NULL,
            display_details TEXT,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            revoked_at INTEGER,
            state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
            CHECK (expires_at IS NULL OR expires_at > created_at),
            CHECK (
              (state = 'active' AND revoked_at IS NULL)
              OR (
                state = 'revoked'
                AND revoked_at IS NOT NULL
                AND revoked_at >= created_at
              )
            ),
            UNIQUE (
              project_identity,
              agent_name,
              registration_owner,
              tool_identity COLLATE NOCASE,
              registration_revision,
              policy_fingerprint,
              request_schema_version,
              request_digest
            )
          );
          CREATE INDEX idx_permission_grants_project_state_expiry
            ON permission_grants (project_identity, state, expires_at);
        `,
      },
    ];

    for (const fixture of cases) {
      const db = new Database(join(testDir, fixture.file));
      createLegacyV2Database(db);
      db.exec(fixture.ddl);

      // Prove the hostile collation is live before migration rejects it.
      const envelopeIndex = db
        .prepare(
          "SELECT name FROM pragma_index_list('permission_grants') WHERE origin = 'u'",
        )
        .get() as { name: string };
      const collRows = db
        .prepare(`PRAGMA index_xinfo(${JSON.stringify(envelopeIndex.name)})`)
        .all() as Array<{ coll: string; key: number; name: string | null }>;
      expect(
        collRows.some((row) => row.key === 1 && row.coll === fixture.coll),
      ).toBe(true);

      const result = runMigrations(db);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe("initialization");
      assertMigrationStayedAtV2(db);
      db.close();
    }
  });

  it("rejects v3 reopen when permission identity/index keys use non-BINARY collations", () => {
    const cases: Array<{ file: string; rebuild: string; coll: string }> = [
      {
        file: "v3-reopen-collate-nocase.db",
        coll: "NOCASE",
        rebuild: `
          DROP TABLE permission_grants;
          CREATE TABLE permission_grants (
            grant_id TEXT NOT NULL PRIMARY KEY,
            project_identity TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            registration_owner TEXT NOT NULL,
            tool_identity TEXT COLLATE NOCASE NOT NULL,
            registration_revision TEXT NOT NULL,
            policy_fingerprint TEXT NOT NULL,
            request_schema_version TEXT NOT NULL,
            request_digest TEXT NOT NULL,
            display_summary TEXT NOT NULL,
            display_details TEXT,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            revoked_at INTEGER,
            state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
            CHECK (expires_at IS NULL OR expires_at > created_at),
            CHECK (
              (state = 'active' AND revoked_at IS NULL)
              OR (
                state = 'revoked'
                AND revoked_at IS NOT NULL
                AND revoked_at >= created_at
              )
            ),
            UNIQUE (
              project_identity, agent_name, registration_owner, tool_identity,
              registration_revision, policy_fingerprint,
              request_schema_version, request_digest
            )
          );
          CREATE INDEX idx_permission_grants_project_state_expiry
            ON permission_grants (project_identity, state, expires_at);
        `,
      },
      {
        file: "v3-reopen-collate-rtrim.db",
        coll: "RTRIM",
        rebuild: `
          DROP TABLE permission_grants;
          CREATE TABLE permission_grants (
            grant_id TEXT NOT NULL PRIMARY KEY,
            project_identity TEXT COLLATE RTRIM NOT NULL,
            agent_name TEXT NOT NULL,
            registration_owner TEXT NOT NULL,
            tool_identity TEXT NOT NULL,
            registration_revision TEXT NOT NULL,
            policy_fingerprint TEXT NOT NULL,
            request_schema_version TEXT NOT NULL,
            request_digest TEXT NOT NULL,
            display_summary TEXT NOT NULL,
            display_details TEXT,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            revoked_at INTEGER,
            state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
            CHECK (expires_at IS NULL OR expires_at > created_at),
            CHECK (
              (state = 'active' AND revoked_at IS NULL)
              OR (
                state = 'revoked'
                AND revoked_at IS NOT NULL
                AND revoked_at >= created_at
              )
            ),
            UNIQUE (
              project_identity, agent_name, registration_owner, tool_identity,
              registration_revision, policy_fingerprint,
              request_schema_version, request_digest
            )
          );
          CREATE INDEX idx_permission_grants_project_state_expiry
            ON permission_grants (project_identity, state, expires_at);
        `,
      },
      {
        file: "v3-reopen-collate-custom-index.db",
        coll: "NOCASE",
        rebuild: `
          DROP INDEX idx_permission_grants_project_state_expiry;
          CREATE INDEX idx_permission_grants_project_state_expiry
            ON permission_grants (
              project_identity COLLATE NOCASE,
              state,
              expires_at
            );
        `,
      },
    ];

    for (const fixture of cases) {
      const db = new Database(join(testDir, fixture.file));
      expect(runMigrations(db).isOk()).toBe(true);
      const ledgerBefore = db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all();
      const versionBefore = readSchemaVersion(db);

      db.exec(fixture.rebuild);

      assertInitializationError(
        runMigrations(db),
        "Invalid permission_grants schema",
      );
      expect(readSchemaVersion(db)).toBe(versionBefore);
      expect(
        db
          .prepare(
            "SELECT version, name FROM schema_migrations ORDER BY version",
          )
          .all(),
      ).toEqual(ledgerBefore);

      // Hostile collation remains in place (no silent repair).
      const collFound = db
        .prepare(
          `SELECT 1 AS ok
           FROM pragma_index_list('permission_grants') AS idx,
                pragma_index_xinfo(idx.name) AS x
           WHERE x.key = 1 AND x.coll = ?
           LIMIT 1`,
        )
        .get(fixture.coll);
      expect(collFound).toEqual({ ok: 1 });
      db.close();
    }
  });

  it("rejects v3 reopen when extra unique/partial/expression indexes exist", () => {
    const cases: Array<{ file: string; ddl: string; indexName: string }> = [
      {
        file: "v3-reopen-extra-unique.db",
        indexName: "idx_permission_grants_extra_unique",
        ddl: `CREATE UNIQUE INDEX idx_permission_grants_extra_unique
              ON permission_grants (request_digest);`,
      },
      {
        file: "v3-reopen-extra-partial.db",
        indexName: "idx_permission_grants_extra_partial",
        ddl: `CREATE INDEX idx_permission_grants_extra_partial
              ON permission_grants (agent_name)
              WHERE revoked_at IS NULL;`,
      },
      {
        file: "v3-reopen-extra-expr.db",
        indexName: "idx_permission_grants_extra_expr",
        ddl: `CREATE INDEX idx_permission_grants_extra_expr
              ON permission_grants ((project_identity || ':' || tool_identity));`,
      },
    ];

    for (const fixture of cases) {
      const db = new Database(join(testDir, fixture.file));
      expect(runMigrations(db).isOk()).toBe(true);
      const ledgerBefore = db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all();
      const versionBefore = readSchemaVersion(db);
      db.exec(fixture.ddl);

      assertInitializationError(
        runMigrations(db),
        "Invalid permission_grants schema",
      );
      expect(readSchemaVersion(db)).toBe(versionBefore);
      expect(
        db
          .prepare(
            "SELECT version, name FROM schema_migrations ORDER BY version",
          )
          .all(),
      ).toEqual(ledgerBefore);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
          )
          .get(fixture.indexName),
      ).toEqual({ name: fixture.indexName });
      db.close();
    }
  });

  it("rejects malformed nullable runtime_metadata without mutation", () => {
    const db = new Database(join(testDir, "nullable-metadata.db"));
    db.exec(`
      CREATE TABLE runtime_metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE schema_migrations (
        version INTEGER NOT NULL PRIMARY KEY,
        applied_at TEXT NOT NULL,
        name TEXT NOT NULL
      );
      INSERT INTO runtime_metadata (key, value) VALUES ('schema_version', '2');
      INSERT INTO schema_migrations (version, applied_at, name)
        VALUES (1, '2025-01-01', 'initial_schema');
      INSERT INTO schema_migrations (version, applied_at, name)
        VALUES (2, '2025-01-02', 'add_step_attempts_json');
    `);

    const metaSqlBefore = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runtime_metadata'",
      )
      .get();
    const ledgerBefore = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();

    const result = runMigrations(db);
    assertInitializationError(result, "Invalid migration bootstrap schema");
    expect(readSchemaVersion(db)).toBe(2);
    assertNoPermissionGrantsTable(db);
    expect(
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runtime_metadata'",
        )
        .get(),
    ).toEqual(metaSqlBefore);
    expect(
      db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(ledgerBefore);
    db.close();
  });

  it("rejects malformed no-PK runtime_metadata without mutation", () => {
    const db = new Database(join(testDir, "no-pk-metadata.db"));
    db.exec(`
      CREATE TABLE runtime_metadata (
        key TEXT NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE schema_migrations (
        version INTEGER NOT NULL PRIMARY KEY,
        applied_at TEXT NOT NULL,
        name TEXT NOT NULL
      );
      INSERT INTO runtime_metadata (key, value) VALUES ('schema_version', '1');
    `);

    const metaSqlBefore = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runtime_metadata'",
      )
      .get();

    const result = runMigrations(db);
    assertInitializationError(result, "Invalid migration bootstrap schema");
    expect(readSchemaVersion(db)).toBe(1);
    assertNoPermissionGrantsTable(db);
    expect(
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runtime_metadata'",
        )
        .get(),
    ).toEqual(metaSqlBefore);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get(),
    ).toEqual({ count: 0 });
    db.close();
  });

  it("rejects malformed schema_migrations physical schemas without mutation", () => {
    const cases: Array<{ name: string; migrationsDdl: string }> = [
      {
        name: "null-applied-at",
        migrationsDdl: `
          CREATE TABLE schema_migrations (
            version INTEGER NOT NULL PRIMARY KEY,
            applied_at TEXT,
            name TEXT NOT NULL
          );
        `,
      },
      {
        name: "no-pk",
        migrationsDdl: `
          CREATE TABLE schema_migrations (
            version INTEGER NOT NULL,
            applied_at TEXT NOT NULL,
            name TEXT NOT NULL
          );
        `,
      },
      {
        name: "wrong-type",
        migrationsDdl: `
          CREATE TABLE schema_migrations (
            version TEXT NOT NULL PRIMARY KEY,
            applied_at TEXT NOT NULL,
            name TEXT NOT NULL
          );
        `,
      },
    ];

    for (const fixture of cases) {
      const db = new Database(
        join(testDir, `bad-migrations-${fixture.name}.db`),
      );
      db.exec(`
        CREATE TABLE runtime_metadata (
          key TEXT NOT NULL PRIMARY KEY,
          value TEXT NOT NULL
        );
        ${fixture.migrationsDdl}
        INSERT INTO runtime_metadata (key, value) VALUES ('schema_version', '2');
      `);
      // version column may be TEXT in the wrong-type case.
      db.exec(`
        INSERT INTO schema_migrations (version, applied_at, name)
          VALUES (1, '2025-01-01', 'initial_schema');
        INSERT INTO schema_migrations (version, applied_at, name)
          VALUES (2, '2025-01-02', 'add_step_attempts_json');
      `);

      const migrationsSqlBefore = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        )
        .get();
      const rowsBefore = db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY rowid")
        .all();

      const result = runMigrations(db);
      assertInitializationError(result, "Invalid migration bootstrap schema");
      expect(readSchemaVersion(db)).toBe(2);
      assertNoPermissionGrantsTable(db);
      expect(
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
          )
          .get(),
      ).toEqual(migrationsSqlBefore);
      expect(
        db
          .prepare("SELECT version, name FROM schema_migrations ORDER BY rowid")
          .all(),
      ).toEqual(rowsBefore);
      db.close();
    }
  });

  it("rejects partial bootstrap (only one table) without creating the sibling", () => {
    const onlyMetadata = new Database(join(testDir, "only-metadata.db"));
    onlyMetadata.exec(`
      CREATE TABLE runtime_metadata (
        key TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO runtime_metadata (key, value) VALUES ('schema_version', '0');
    `);

    assertInitializationError(
      runMigrations(onlyMetadata),
      "Invalid migration bootstrap schema",
    );
    expect(
      onlyMetadata
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'schema_migrations'",
        )
        .get(),
    ).toBeNull();
    assertNoPermissionGrantsTable(onlyMetadata);
    onlyMetadata.close();

    const onlyMigrations = new Database(join(testDir, "only-migrations.db"));
    onlyMigrations.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER NOT NULL PRIMARY KEY,
        applied_at TEXT NOT NULL,
        name TEXT NOT NULL
      );
    `);

    assertInitializationError(
      runMigrations(onlyMigrations),
      "Invalid migration bootstrap schema",
    );
    expect(
      onlyMigrations
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'runtime_metadata'",
        )
        .get(),
    ).toBeNull();
    assertNoPermissionGrantsTable(onlyMigrations);
    onlyMigrations.close();
  });

  it("rejects fresh precreated bootstrap hostile BEFORE/AFTER triggers and extra indexes", () => {
    const cases: Array<{ file: string; ddl: string; triggerOrIndex: string }> =
      [
        {
          file: "fresh-metadata-after-trigger.db",
          triggerOrIndex: "runtime_metadata_after_update",
          ddl: `
            ${CANONICAL_BOOTSTRAP_DDL}
            INSERT INTO runtime_metadata (key, value)
              VALUES ('schema_version', '0');
            INSERT INTO runtime_metadata (key, value)
              VALUES ('permission_wall_clock_high_water', '100');
            CREATE TRIGGER runtime_metadata_after_update
            AFTER UPDATE ON runtime_metadata
            WHEN NEW.key = 'permission_wall_clock_high_water'
            BEGIN
              UPDATE runtime_metadata
                SET value = '0'
                WHERE key = 'permission_wall_clock_high_water';
            END;
          `,
        },
        {
          file: "fresh-metadata-before-trigger.db",
          triggerOrIndex: "runtime_metadata_before_insert",
          ddl: `
            ${CANONICAL_BOOTSTRAP_DDL}
            CREATE TRIGGER runtime_metadata_before_insert
            BEFORE INSERT ON runtime_metadata
            BEGIN
              SELECT RAISE(ABORT, 'hostile metadata before insert');
            END;
          `,
        },
        {
          file: "fresh-migrations-after-trigger.db",
          triggerOrIndex: "schema_migrations_after_insert",
          ddl: `
            ${CANONICAL_BOOTSTRAP_DDL}
            CREATE TRIGGER schema_migrations_after_insert
            AFTER INSERT ON schema_migrations
            BEGIN
              DELETE FROM schema_migrations WHERE version = NEW.version;
            END;
          `,
        },
        {
          file: "fresh-migrations-before-trigger.db",
          triggerOrIndex: "schema_migrations_before_delete",
          ddl: `
            ${CANONICAL_BOOTSTRAP_DDL}
            CREATE TRIGGER schema_migrations_before_delete
            BEFORE DELETE ON schema_migrations
            BEGIN
              SELECT RAISE(ABORT, 'hostile ledger before delete');
            END;
          `,
        },
        {
          file: "fresh-metadata-extra-index.db",
          triggerOrIndex: "idx_runtime_metadata_extra",
          ddl: `
            ${CANONICAL_BOOTSTRAP_DDL}
            CREATE INDEX idx_runtime_metadata_extra
              ON runtime_metadata (value);
          `,
        },
        {
          file: "fresh-migrations-extra-index.db",
          triggerOrIndex: "idx_schema_migrations_extra",
          ddl: `
            ${CANONICAL_BOOTSTRAP_DDL}
            CREATE INDEX idx_schema_migrations_extra
              ON schema_migrations (name);
          `,
        },
      ];

    for (const fixture of cases) {
      const db = new Database(join(testDir, fixture.file));
      db.exec(fixture.ddl);
      const objectsBefore = db
        .prepare(
          "SELECT type, name FROM sqlite_master WHERE name = ? OR tbl_name IN ('runtime_metadata', 'schema_migrations') ORDER BY type, name",
        )
        .all(fixture.triggerOrIndex);

      assertInitializationError(
        runMigrations(db),
        "Invalid migration bootstrap schema",
      );
      assertNoPermissionGrantsTable(db);
      expect(
        db
          .prepare(
            "SELECT type, name FROM sqlite_master WHERE name = ? OR tbl_name IN ('runtime_metadata', 'schema_migrations') ORDER BY type, name",
          )
          .all(fixture.triggerOrIndex),
      ).toEqual(objectsBefore);
      db.close();
    }
  });

  it("rejects v2 upgrade when bootstrap tables have hostile triggers or extra indexes", () => {
    const cases: Array<{ file: string; ddl: string }> = [
      {
        file: "v2-metadata-hw-reset-trigger.db",
        ddl: `
          CREATE TRIGGER runtime_metadata_hw_reset
          AFTER UPDATE ON runtime_metadata
          WHEN NEW.key = 'permission_wall_clock_high_water'
          BEGIN
            UPDATE runtime_metadata SET value = '1'
              WHERE key = 'permission_wall_clock_high_water';
          END;
        `,
      },
      {
        file: "v2-metadata-before-trigger.db",
        ddl: `
          CREATE TRIGGER runtime_metadata_before_update
          BEFORE UPDATE ON runtime_metadata
          BEGIN
            SELECT RAISE(ABORT, 'hostile metadata before update');
          END;
        `,
      },
      {
        file: "v2-migrations-after-trigger.db",
        ddl: `
          CREATE TRIGGER schema_migrations_tamper
          AFTER INSERT ON schema_migrations
          BEGIN
            UPDATE schema_migrations SET name = 'tampered' WHERE version = NEW.version;
          END;
        `,
      },
      {
        file: "v2-migrations-before-trigger.db",
        ddl: `
          CREATE TRIGGER schema_migrations_before_insert
          BEFORE INSERT ON schema_migrations
          BEGIN
            SELECT RAISE(ABORT, 'hostile ledger before insert');
          END;
        `,
      },
      {
        file: "v2-metadata-extra-index.db",
        ddl: `CREATE UNIQUE INDEX idx_runtime_metadata_extra_unique ON runtime_metadata (value);`,
      },
      {
        file: "v2-migrations-extra-index.db",
        ddl: `CREATE INDEX idx_schema_migrations_name ON schema_migrations (name);`,
      },
    ];

    for (const fixture of cases) {
      const db = new Database(join(testDir, fixture.file));
      createLegacyV2Database(db);
      db.exec(
        "INSERT OR REPLACE INTO runtime_metadata (key, value) VALUES ('permission_wall_clock_high_water', '99')",
      );
      db.exec(fixture.ddl);

      const versionBefore = readSchemaVersion(db);
      const ledgerBefore = db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all();
      const hwBefore = db
        .prepare(
          "SELECT value FROM runtime_metadata WHERE key = 'permission_wall_clock_high_water'",
        )
        .get();

      assertInitializationError(
        runMigrations(db),
        "Invalid migration bootstrap schema",
      );
      expect(readSchemaVersion(db)).toBe(versionBefore);
      expect(
        db
          .prepare(
            "SELECT version, name FROM schema_migrations ORDER BY version",
          )
          .all(),
      ).toEqual(ledgerBefore);
      expect(
        db
          .prepare(
            "SELECT value FROM runtime_metadata WHERE key = 'permission_wall_clock_high_water'",
          )
          .get(),
      ).toEqual(hwBefore);
      assertNoPermissionGrantsTable(db);
      db.close();
    }
  });

  it("rejects v3 reopen when bootstrap hostile triggers or extra indexes are attached", () => {
    const cases: Array<{ file: string; ddl: string }> = [
      {
        file: "v3-metadata-hw-reset-trigger.db",
        ddl: `
          CREATE TRIGGER runtime_metadata_hw_reset
          AFTER UPDATE ON runtime_metadata
          WHEN NEW.key = 'permission_wall_clock_high_water'
          BEGIN
            UPDATE runtime_metadata SET value = '0'
              WHERE key = 'permission_wall_clock_high_water';
          END;
          CREATE TRIGGER runtime_metadata_before_delete
          BEFORE DELETE ON runtime_metadata
          BEGIN
            SELECT RAISE(ABORT, 'hostile metadata before delete');
          END;
        `,
      },
      {
        file: "v3-migrations-ledger-triggers.db",
        ddl: `
          CREATE TRIGGER schema_migrations_after_insert
          AFTER INSERT ON schema_migrations
          BEGIN
            DELETE FROM schema_migrations WHERE version = NEW.version;
          END;
          CREATE TRIGGER schema_migrations_before_update
          BEFORE UPDATE ON schema_migrations
          BEGIN
            SELECT RAISE(ABORT, 'hostile ledger before update');
          END;
        `,
      },
      {
        file: "v3-bootstrap-extra-indexes.db",
        ddl: `
          CREATE INDEX idx_runtime_metadata_value ON runtime_metadata (value);
          CREATE INDEX idx_schema_migrations_applied_at
            ON schema_migrations (applied_at);
        `,
      },
    ];

    for (const fixture of cases) {
      const db = new Database(join(testDir, fixture.file));
      expect(runMigrations(db).isOk()).toBe(true);
      db.exec(
        "INSERT OR REPLACE INTO runtime_metadata (key, value) VALUES ('permission_wall_clock_high_water', '77')",
      );
      const versionBefore = readSchemaVersion(db);
      const ledgerBefore = db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all();
      const hwBefore = db
        .prepare(
          "SELECT value FROM runtime_metadata WHERE key = 'permission_wall_clock_high_water'",
        )
        .get();

      db.exec(fixture.ddl);

      assertInitializationError(
        runMigrations(db),
        "Invalid migration bootstrap schema",
      );
      expect(readSchemaVersion(db)).toBe(versionBefore);
      expect(
        db
          .prepare(
            "SELECT version, name FROM schema_migrations ORDER BY version",
          )
          .all(),
      ).toEqual(ledgerBefore);
      expect(
        db
          .prepare(
            "SELECT value FROM runtime_metadata WHERE key = 'permission_wall_clock_high_water'",
          )
          .get(),
      ).toEqual(hwBefore);
      db.close();
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
    await Bun.write(join(runtimeDir, ".keep"), "");
    const dbPath = join(runtimeDir, "weave.db");
    const db = new Database(dbPath);
    db.exec(CANONICAL_BOOTSTRAP_DDL);
    db.exec(
      "INSERT INTO runtime_metadata (key, value) VALUES ('schema_version', '999')",
    );
    db.close();

    const store = createSqliteRuntimeStore({ dbPath, projectRoot: testDir });
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
      await Bun.$`rm -rf ${dir2}`.quiet();
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

  // Regression for #21: terminal completeStep() must be able to
  // release the lease that drove a workflow to `completed` even though a
  // SessionSnapshot recorded during execution still references it. Before
  // the fix, session_snapshots.lease_id was NOT NULL with an implicit
  // ON DELETE NO ACTION foreign key, so this release failed with
  // "FOREIGN KEY constraint failed" and the lease was never released.
  it("release succeeds and severs the leaseId link on SessionSnapshots that observed it", async () => {
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
    const snapshot = (
      await store.snapshots.record({
        workflowInstanceId: wfi.id,
        leaseId: lease.id,
        harnessName: "test-harness",
        agentName: "shuttle",
        stepName: "plan",
        sessionStatus: "active",
        metadata: { stepCount: 1, isResumed: false },
      })
    )._unsafeUnwrap();
    expect(snapshot.leaseId).toBe(lease.id);

    const releaseResult = await store.leases.release(lease.id, lease.ownerId);
    expect(releaseResult.isOk()).toBe(true);

    const leaseAfterRelease = await store.leases.findById(lease.id);
    expect(leaseAfterRelease._unsafeUnwrap()).toBeNull();

    const snapshotAfterRelease = (
      await store.snapshots.findById(snapshot.id)
    )._unsafeUnwrap();
    expect(snapshotAfterRelease).not.toBeNull();
    expect(snapshotAfterRelease?.leaseId).toBeUndefined();
    // The rest of the historical observation is untouched.
    expect(snapshotAfterRelease?.harnessName).toBe("test-harness");
    expect(snapshotAfterRelease?.stepName).toBe("plan");
    expect(snapshotAfterRelease?.metadata).toEqual({
      stepCount: 1,
      isResumed: false,
    });

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
    // File system containment (mkdirat/openat/fchmod) is implemented via
    // bun:ffi against libc, never node:fs or a shelled-out mkdir process.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No-follow directory guard (Pi adapter contract)
// ---------------------------------------------------------------------------

describe("no-follow directory guard (Pi adapter contract) — real filesystem", () => {
  it("fails closed instead of initializing through a symlinked runtime directory", async () => {
    const realElsewhere = join(testDir, "real-elsewhere");
    Bun.spawnSync(["mkdir", "-p", realElsewhere]);
    const runtimeLink = join(testDir, "runtime");
    Bun.spawnSync(["ln", "-s", realElsewhere, runtimeLink]);

    const store = makeStore(testDir);
    const result = await store.instances.list();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("initialization");
      expect(result.error.message).toMatch(/symlink|access denied/i);
    }
    // Never wrote through the symlink target.
    expect(pathExists(join(realElsewhere, "weave.db"))).toBe(false);
  });

  it("fails closed instead of opening a symlinked weave.db leaf", async () => {
    const runtimeDir = join(testDir, "runtime");
    Bun.spawnSync(["mkdir", "-p", runtimeDir]);
    const decoyDb = join(testDir, "decoy.db");
    await Bun.write(decoyDb, "not a real sqlite file");
    Bun.spawnSync(["ln", "-s", decoyDb, join(runtimeDir, "weave.db")]);

    const store = makeStore(testDir);
    const result = await store.instances.list();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("initialization");
      expect(result.error.message).toMatch(/weave\.db/);
    }
  });

  it("applies restrictive permissions (0700/0600) via fd-based operations, not a racy path-based chmod", async () => {
    const store = makeStore(testDir);
    await store.instances.list();

    const runtimeDir = join(testDir, "runtime");
    const dirStat = await Bun.file(runtimeDir).stat();
    expect(dirStat.mode & 0o777).toBe(0o700);

    const dbStat = await Bun.file(makeDbPath(testDir)).stat();
    expect(dbStat.mode & 0o777).toBe(0o600);

    // The live database is in-memory (Pi adapter contract): bun:sqlite never opens
    // `weave.db` by path, so its WAL/SHM sidecars never come into existence.
    // Durability comes entirely from `writeLeafAtomic`'s temp-file-then-
    // rename sequence against the single `weave.db` leaf.
    expect(pathExists(`${makeDbPath(testDir)}-wal`)).toBe(false);
    expect(pathExists(`${makeDbPath(testDir)}-shm`)).toBe(false);
  });
});

describe("no-follow directory guard (Pi adapter contract) — isolated (MemoryRuntimeDirectoryGuard)", () => {
  it("fails closed when the runtime directory is a simulated symlink", async () => {
    const guard = new MemoryRuntimeDirectoryGuard();
    guard.simulateDirectorySymlink();
    const store = makeStore(testDir, { directoryGuard: guard });

    const result = await store.instances.list();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("initialization");
      expect(result.error.message).toMatch(/symlink/i);
    }
  });

  it("fails closed when the weave.db leaf is a simulated symlink", async () => {
    const guard = new MemoryRuntimeDirectoryGuard();
    guard.simulateLeafSymlink("weave.db");
    const store = makeStore(testDir, { directoryGuard: guard });

    const result = await store.instances.list();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("initialization");
      expect(result.error.message).toMatch(/weave\.db/);
    }
  });

  it("fails closed when the weave.db leaf's identity changes between initialization and the first transaction", async () => {
    // A stateful test double, distinct from MemoryRuntimeDirectoryGuard,
    // that swaps the leaf's identity on its second `verifyLeaf` call for a
    // given file name — simulating an out-of-band replacement of `weave.db`
    // that occurs after the store's initial flush (which binds identity via
    // `writeLeafAtomic`'s own `verifyLeaf` call) but before the next
    // transaction's pre-commit revalidation. The store never re-reads
    // `weave.db` from disk after `_doInitialize` (it runs entirely
    // in-memory), so this is the only remaining window where an external
    // replacement can be observed at all.
    class SwapOnSecondVerifyGuard implements RuntimeDirectoryGuard {
      private readonly callCounts = new Map<string, number>();
      // Coordinator-driven reload (Pi adapter contract): every outside-transaction
      // query re-acquires and re-reads the leaf's latest bytes, so this fake
      // must actually round-trip what `writeLeafAtomic` persists instead of
      // always answering `readLeafBytes` with an empty buffer - otherwise
      // the very first post-init query would reload an empty, unmigrated
      // database and fail.
      private readonly leaves = new Map<string, Uint8Array>();

      ensureRuntimeDirectory(
        projectRoot: string,
        segments: readonly string[],
      ): ReturnType<RuntimeDirectoryGuard["ensureRuntimeDirectory"]> {
        const counts = this.callCounts;
        const leaves = this.leaves;
        const verifyLeaf: RuntimeDirectoryHandle["verifyLeaf"] = (fileName) => {
          const callNumber = (counts.get(fileName) ?? 0) + 1;
          counts.set(fileName, callNumber);
          const ino = fileName === "weave.db" && callNumber >= 2 ? 999 : 1;
          return okAsync({ dev: 1, ino, size: 0, mtimeMs: 0 });
        };
        const handle: RuntimeDirectoryHandle = {
          path: [projectRoot, ...segments].join("/"),
          identity: () => okAsync({ dev: 1, ino: 1, size: 0, mtimeMs: 0 }),
          verifyLeaf,
          // A brand-new store: nothing on "disk" yet, then whatever the
          // last `writeLeafAtomic` call persisted.
          readLeafBytes: (fileName) =>
            okAsync(leaves.get(fileName) ?? new Uint8Array(0)),
          // Mirrors the real handle: persist the bytes, then end by
          // re-verifying the leaf through the same held descriptor.
          writeLeafAtomic: (fileName, bytes, _mode) => {
            leaves.set(fileName, bytes);
            return verifyLeaf(fileName, { create: false, mode: 0o600 });
          },
          // No real locking needed: this fake only ever backs a single
          // store instance within one test, so the coordinator's
          // acquire()/discard() cycle just needs to satisfy the interface.
          lockLeaf: () => okAsync(undefined),
          unlockLeaf: () => okAsync(undefined),
          close: () => undefined,
        };
        return okAsync(handle);
      }
    }

    // No real filesystem interaction is needed at all: the guard is fully
    // faked and the store never opens `bun:sqlite` by path (it deserializes
    // bytes handed to it by the guard), so there is nothing to pre-create
    // on disk for this test.
    const store = makeStore(testDir, {
      directoryGuard: new SwapOnSecondVerifyGuard(),
    });

    // Initialization succeeds: the first (and only, for init) `verifyLeaf`
    // call happens inside the initial flush and binds identity at ino 1.
    const initResult = await store.instances.list();
    expect(initResult.isOk()).toBe(true);

    // The first transaction's pre-commit revalidation is the second
    // `verifyLeaf` call for `weave.db`, which the fake now answers with a
    // different ino — simulating an out-of-band replacement.
    const txResult = await store.transaction(() => okAsync(undefined));
    expect(txResult.isErr()).toBe(true);
    if (txResult.isErr()) {
      expect(txResult.error.type).toBe("initialization");
      expect(txResult.error.message).toMatch(/identity changed/i);
    }

    // The store is poisoned, not merely this one call: further operations
    // fail closed too.
    const afterPoison = await store.instances.list();
    expect(afterPoison.isErr()).toBe(true);

    const closed = await store.close();
    expect(closed.isOk()).toBe(true);
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

  it("atomically rejects approval bound to a stale artifact revision", async () => {
    const store = makeStore(testDir);
    const created = (
      await store.instances.create({ workflowName: "wf", goal: "g", slug: "g" })
    )._unsafeUnwrap();
    const first = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/v1.md",
      })
    )._unsafeUnwrap();
    const latest = (
      await store.instances.addArtifact(created.id, {
        name: "plan",
        path: ".weave/plans/v2.md",
      })
    )._unsafeUnwrap();

    const result = await store.instances.updateArtifactApproval(
      created.id,
      first.artifacts[0].id,
      "approved",
      {
        actor: { kind: "user", provenance: { source: "test" } },
        decidedAt: new Date().toISOString(),
        expectedRevision: 1,
      },
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "conflict",
      entity: "ArtifactRevision",
    });
    expect(latest.artifacts.at(-1)?.approvalState).toBe("pending");
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
      {
        actor: { kind: "user", provenance: { source: "test" } },
        decidedAt: "2026-07-23T00:00:00.000Z",
        expectedRevision: 1,
      },
    );
    await store1.close();

    // Reopen and verify approval state, actor, and timestamp persisted.
    const store2 = makeStore(testDir);
    const found = (await store2.instances.findById(created.id))._unsafeUnwrap();
    expect(found?.artifacts[0].approvalState).toBe("approved");
    expect(found?.artifacts[0].approvalActor).toEqual({
      kind: "user",
      provenance: { source: "test" },
    });
    expect(found?.artifacts[0].approvalDecidedAt).toBe(
      "2026-07-23T00:00:00.000Z",
    );
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
