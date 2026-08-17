/**
 * Adapter preference repository + Runtime Store migration v6.
 *
 * Covers fresh v6 initialization, v5 in-place upgrade without data loss,
 * set/get round-trip, overwrite `updated_at`, bounds, list-limit clamping,
 * removal, and in-memory/SQLite parity.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync } from "neverthrow";
import {
  ADAPTER_PREFERENCE_KEY_MAX_CHARS,
  ADAPTER_PREFERENCE_LIST_LIMIT,
  ADAPTER_PREFERENCE_NAMESPACE_MAX_CHARS,
  ADAPTER_PREFERENCE_VALUE_MAX_BYTES,
  CURRENT_SCHEMA_VERSION,
  createInMemoryRuntimeStore,
  createSqliteRuntimeStore,
  createWorkflowInstanceId,
  type RuntimeStore,
  readSchemaVersion,
  runMigrations,
} from "../index.js";

const VALUE_JSON = JSON.stringify({ mode: "explicit", entries: ["pi-vim"] });

function jsonStringOfByteLength(bytes: number): string {
  // JSON string quotes add 2 bytes.
  return `"${"a".repeat(bytes - 2)}"`;
}

async function expectPreferenceContract(
  store: RuntimeStore,
  clock: { now: Date },
): Promise<void> {
  const missing = await store.preferences.get("adapter-pi", "child-extensions");
  expect(missing.isOk()).toBe(true);
  expect(missing._unsafeUnwrap()).toBeNull();

  clock.now = new Date("2026-01-01T00:00:00.000Z");
  const written = await store.preferences.set(
    "adapter-pi",
    "child-extensions",
    VALUE_JSON,
  );
  expect(written.isOk()).toBe(true);
  expect(written._unsafeUnwrap()).toEqual({
    namespace: "adapter-pi",
    key: "child-extensions",
    valueJson: VALUE_JSON,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const roundTrip = await store.preferences.get(
    "adapter-pi",
    "child-extensions",
  );
  expect(roundTrip._unsafeUnwrap()).toEqual(written._unsafeUnwrap());

  clock.now = new Date("2026-01-01T00:00:05.000Z");
  const overwritten = await store.preferences.set(
    "adapter-pi",
    "child-extensions",
    JSON.stringify({ mode: "inherit-all" }),
  );
  expect(overwritten.isOk()).toBe(true);
  expect(overwritten._unsafeUnwrap().valueJson).toBe(
    JSON.stringify({ mode: "inherit-all" }),
  );
  expect(overwritten._unsafeUnwrap().updatedAt).toBe(
    "2026-01-01T00:00:05.000Z",
  );

  await store.preferences.set("adapter-pi", "a", "1");
  await store.preferences.set("adapter-pi", "c", "3");
  await store.preferences.set("adapter-pi", "b", "2");
  await store.preferences.set("other", "z", "9");

  const listed = await store.preferences.list("adapter-pi");
  expect(listed.isOk()).toBe(true);
  expect(listed._unsafeUnwrap().map((row) => row.key)).toEqual([
    "a",
    "b",
    "c",
    "child-extensions",
  ]);

  const limited = await store.preferences.list("adapter-pi", 2);
  expect(limited._unsafeUnwrap().map((row) => row.key)).toEqual(["a", "b"]);

  const removed = await store.preferences.remove(
    "adapter-pi",
    "child-extensions",
  );
  expect(removed.isOk()).toBe(true);
  expect(
    (
      await store.preferences.get("adapter-pi", "child-extensions")
    )._unsafeUnwrap(),
  ).toBeNull();

  const removeMissing = await store.preferences.remove(
    "adapter-pi",
    "child-extensions",
  );
  expect(removeMissing.isOk()).toBe(true);
}

/**
 * Cross-namespace enumeration: ordered by namespace then key with code-unit
 * comparison, bounded by the clamped limit, and identical in every store.
 */
async function expectListAllContract(store: RuntimeStore): Promise<void> {
  const empty = await store.preferences.listAll();
  expect(empty.isOk()).toBe(true);
  expect(empty._unsafeUnwrap()).toEqual([]);

  // Written out of order across three namespaces.
  await store.preferences.set("beta", "b", "2");
  await store.preferences.set("alpha", "z", "26");
  await store.preferences.set("Beta", "a", "1");
  await store.preferences.set("alpha", "a", "1");
  await store.preferences.set("beta", "a", "1");

  const all = await store.preferences.listAll();
  expect(all.isOk()).toBe(true);
  expect(
    all._unsafeUnwrap().map((row) => `${row.namespace}/${row.key}`),
  ).toEqual([
    // Uppercase sorts before lowercase under code-unit ordering.
    "Beta/a",
    "alpha/a",
    "alpha/z",
    "beta/a",
    "beta/b",
  ]);

  const limited = await store.preferences.listAll(2);
  expect(limited._unsafeUnwrap().map((row) => row.namespace)).toEqual([
    "Beta",
    "alpha",
  ]);

  const zero = await store.preferences.listAll(0);
  expect(zero._unsafeUnwrap()).toEqual([]);

  // A namespace-scoped list still sees only its own rows.
  const scoped = await store.preferences.list("alpha");
  expect(scoped._unsafeUnwrap().map((row) => row.key)).toEqual(["a", "z"]);
}

async function expectPreferenceBounds(store: RuntimeStore): Promise<void> {
  const overNamespace = await store.preferences.set(
    "n".repeat(ADAPTER_PREFERENCE_NAMESPACE_MAX_CHARS + 1),
    "key",
    "1",
  );
  expect(overNamespace.isErr()).toBe(true);
  expect(overNamespace._unsafeUnwrapErr().type).toBe("validation");

  const overKey = await store.preferences.set(
    "ns",
    "k".repeat(ADAPTER_PREFERENCE_KEY_MAX_CHARS + 1),
    "1",
  );
  expect(overKey.isErr()).toBe(true);
  expect(overKey._unsafeUnwrapErr().type).toBe("validation");

  const exactNamespace = await store.preferences.set(
    "n".repeat(ADAPTER_PREFERENCE_NAMESPACE_MAX_CHARS),
    "key",
    "1",
  );
  expect(exactNamespace.isOk()).toBe(true);

  const exactKey = await store.preferences.set(
    "ns",
    "k".repeat(ADAPTER_PREFERENCE_KEY_MAX_CHARS),
    "1",
  );
  expect(exactKey.isOk()).toBe(true);

  const controlNamespace = await store.preferences.set("bad\nns", "key", "1");
  expect(controlNamespace.isErr()).toBe(true);
  expect(controlNamespace._unsafeUnwrapErr().type).toBe("validation");

  const nulKey = await store.preferences.set("ns", "bad\0key", "1");
  expect(nulKey.isErr()).toBe(true);
  expect(nulKey._unsafeUnwrapErr().type).toBe("validation");

  const invalidJson = await store.preferences.set("ns", "json", "{");
  expect(invalidJson.isErr()).toBe(true);
  expect(invalidJson._unsafeUnwrapErr().type).toBe("validation");

  const nulValue = await store.preferences.set("ns", "json", '"\0"');
  expect(nulValue.isErr()).toBe(true);
  expect(nulValue._unsafeUnwrapErr().type).toBe("validation");

  const tooBig = await store.preferences.set(
    "ns",
    "big",
    jsonStringOfByteLength(ADAPTER_PREFERENCE_VALUE_MAX_BYTES + 1),
  );
  expect(tooBig.isErr()).toBe(true);
  expect(tooBig._unsafeUnwrapErr().type).toBe("validation");

  const exactBytes = await store.preferences.set(
    "ns",
    "exact",
    jsonStringOfByteLength(ADAPTER_PREFERENCE_VALUE_MAX_BYTES),
  );
  expect(exactBytes.isOk()).toBe(true);
}

function createV5Fixture(db: Database): void {
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
      step_attempts_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      error_message TEXT
    );
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
    INSERT INTO runtime_metadata (key, value) VALUES ('schema_version', '5');
    INSERT INTO schema_migrations (version, applied_at, name) VALUES
      (1, '2025-01-01T00:00:00.000Z', 'initial_schema'),
      (2, '2025-01-01T00:00:01.000Z', 'add_step_attempts_json'),
      (3, '2025-01-01T00:00:02.000Z', 'permission_grants'),
      (4, '2025-01-01T00:00:03.000Z', 'usage_observations_and_rollups'),
      (5, '2025-01-01T00:00:04.000Z', 'session_snapshots_lease_set_null');
    INSERT INTO workflow_instances (
      id, workflow_name, goal, slug, status, current_step_name,
      artifacts_json, step_attempts_json, created_at, updated_at,
      completed_at, error_message
    ) VALUES (
      'v5-instance', 'legacy-workflow', 'keep me', 'keep-me',
      'created', NULL, '[]', '[]',
      '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z',
      NULL, NULL
    );
    INSERT INTO permission_grants (
      grant_id, project_identity, agent_name, registration_owner,
      tool_identity, registration_revision, policy_fingerprint,
      request_schema_version, request_digest, display_summary,
      display_details, created_at, expires_at, revoked_at, state
    ) VALUES (
      'v5-grant', 'project', 'agent', 'owner',
      'tool', '1', 'policy',
      '1', 'digest', 'Allow tool',
      NULL, 10, NULL, NULL, 'active'
    );
  `);
}

describe("adapter preferences — memory store", () => {
  it("round-trips, overwrites updated_at, lists, and removes", async () => {
    const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
    const store = createInMemoryRuntimeStore({
      clock: () => clock.now,
    });
    await expectPreferenceContract(store, clock);
  });

  it("rejects out-of-bounds identities, control characters, NUL, and invalid JSON", async () => {
    const store = createInMemoryRuntimeStore();
    await expectPreferenceBounds(store);
  });

  it("clamps list limits to the documented default maximum", async () => {
    const store = createInMemoryRuntimeStore();
    for (let index = 0; index < ADAPTER_PREFERENCE_LIST_LIMIT + 1; index += 1) {
      const key = `k${String(index).padStart(3, "0")}`;
      const result = await store.preferences.set("ns", key, "1");
      expect(result.isOk()).toBe(true);
    }
    const defaultList = await store.preferences.list("ns");
    expect(defaultList._unsafeUnwrap()).toHaveLength(
      ADAPTER_PREFERENCE_LIST_LIMIT,
    );
    const clamped = await store.preferences.list("ns", 10_000);
    expect(clamped._unsafeUnwrap()).toHaveLength(ADAPTER_PREFERENCE_LIST_LIMIT);
    const zero = await store.preferences.list("ns", 0);
    expect(zero._unsafeUnwrap()).toHaveLength(0);
  });

  it("lists across namespaces in deterministic order with a clamped limit", async () => {
    const store = createInMemoryRuntimeStore();
    await expectListAllContract(store);
  });

  it("clamps listAll to the documented default maximum", async () => {
    const store = createInMemoryRuntimeStore();
    for (let index = 0; index < ADAPTER_PREFERENCE_LIST_LIMIT + 1; index += 1) {
      const namespace = `ns${String(index).padStart(3, "0")}`;
      const result = await store.preferences.set(namespace, "k", "1");
      expect(result.isOk()).toBe(true);
    }
    const defaultList = await store.preferences.listAll();
    expect(defaultList._unsafeUnwrap()).toHaveLength(
      ADAPTER_PREFERENCE_LIST_LIMIT,
    );
    const clamped = await store.preferences.listAll(10_000);
    expect(clamped._unsafeUnwrap()).toHaveLength(ADAPTER_PREFERENCE_LIST_LIMIT);
    const negative = await store.preferences.listAll(-5);
    expect(negative._unsafeUnwrap()).toHaveLength(0);
  });

  it("surfaces an injected list failure from listAll", async () => {
    const store = createInMemoryRuntimeStore({
      failOn: {
        preferenceList: { type: "query", message: "boom" },
      },
    });
    const failed = await store.preferences.listAll();
    expect(failed.isErr()).toBe(true);
    expect(failed._unsafeUnwrapErr().message).toBe("boom");
  });

  it("rolls back preference writes when a transaction fails", async () => {
    const store = createInMemoryRuntimeStore();
    const txResult = await store.transaction((tx) =>
      tx.preferences
        .set("ns", "tx-key", "1")
        .andThen(() =>
          errAsync({ type: "validation" as const, message: "force rollback" }),
        ),
    );
    expect(txResult.isErr()).toBe(true);
    expect((await store.preferences.get("ns", "tx-key"))._unsafeUnwrap()).toBe(
      null,
    );
  });
});

describe("adapter preferences — sqlite store", () => {
  it("matches the memory contract", async () => {
    const dir = join(tmpdir(), `weave-pref-${crypto.randomUUID()}`);
    Bun.spawnSync(["mkdir", "-p", dir]);
    const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
    const store = createSqliteRuntimeStore({
      dbPath: join(dir, "weave.db"),
      projectRoot: dir,
      clock: () => clock.now,
    });
    await expectPreferenceContract(store, clock);
    await expectPreferenceBounds(store);
    await store.close();
  });

  it("lists across namespaces in the same order as the memory store", async () => {
    const dir = join(tmpdir(), `weave-pref-all-${crypto.randomUUID()}`);
    Bun.spawnSync(["mkdir", "-p", dir]);
    const store = createSqliteRuntimeStore({
      dbPath: join(dir, "weave.db"),
      projectRoot: dir,
    });
    await expectListAllContract(store);

    // Byte-for-byte parity with the in-memory store for the same writes.
    const memory = createInMemoryRuntimeStore();
    await expectListAllContract(memory);
    const fromSqlite = await store.preferences.listAll();
    const fromMemory = await memory.preferences.listAll();
    expect(
      fromSqlite._unsafeUnwrap().map((row) => `${row.namespace}/${row.key}`),
    ).toEqual(
      fromMemory._unsafeUnwrap().map((row) => `${row.namespace}/${row.key}`),
    );
    await store.close();
  });

  it("clamps listAll to the documented default maximum", async () => {
    const dir = join(tmpdir(), `weave-pref-all-limit-${crypto.randomUUID()}`);
    Bun.spawnSync(["mkdir", "-p", dir]);
    const store = createSqliteRuntimeStore({
      dbPath: join(dir, "weave.db"),
      projectRoot: dir,
    });
    for (let index = 0; index < ADAPTER_PREFERENCE_LIST_LIMIT + 1; index += 1) {
      const namespace = `ns${String(index).padStart(3, "0")}`;
      const result = await store.preferences.set(namespace, "k", "1");
      expect(result.isOk()).toBe(true);
    }
    const defaultList = await store.preferences.listAll();
    expect(defaultList._unsafeUnwrap()).toHaveLength(
      ADAPTER_PREFERENCE_LIST_LIMIT,
    );
    const clamped = await store.preferences.listAll(10_000);
    expect(clamped._unsafeUnwrap()).toHaveLength(ADAPTER_PREFERENCE_LIST_LIMIT);
    await store.close();
  });

  it("clamps list limits to the documented default maximum", async () => {
    const dir = join(tmpdir(), `weave-pref-limit-${crypto.randomUUID()}`);
    Bun.spawnSync(["mkdir", "-p", dir]);
    const store = createSqliteRuntimeStore({
      dbPath: join(dir, "weave.db"),
      projectRoot: dir,
    });
    for (let index = 0; index < ADAPTER_PREFERENCE_LIST_LIMIT + 1; index += 1) {
      const key = `k${String(index).padStart(3, "0")}`;
      const result = await store.preferences.set("ns", key, "1");
      expect(result.isOk()).toBe(true);
    }
    const defaultList = await store.preferences.list("ns");
    expect(defaultList._unsafeUnwrap()).toHaveLength(
      ADAPTER_PREFERENCE_LIST_LIMIT,
    );
    const clamped = await store.preferences.list("ns", 10_000);
    expect(clamped._unsafeUnwrap()).toHaveLength(ADAPTER_PREFERENCE_LIST_LIMIT);
    await store.close();
  });
});

describe("adapter preferences — migration v6", () => {
  it("initializes a fresh database at schema version 6", () => {
    const db = new Database(":memory:");
    const result = runMigrations(db);
    expect(result.isOk()).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBe(6);
    expect(readSchemaVersion(db)).toBe(6);

    const columns = (
      db.prepare("PRAGMA table_info(adapter_preferences)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>
    ).map((column) => ({
      name: column.name,
      type: column.type,
      notnull: column.notnull,
      pk: column.pk,
    }));
    expect(columns).toEqual([
      { name: "namespace", type: "TEXT", notnull: 1, pk: 1 },
      { name: "key", type: "TEXT", notnull: 1, pk: 2 },
      { name: "value_json", type: "TEXT", notnull: 1, pk: 0 },
      { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
    ]);
    db.close();
  });

  it("upgrades a v5 database in place without data loss", async () => {
    const dir = join(tmpdir(), `weave-pref-v5-${crypto.randomUUID()}`);
    const runtimeDir = join(dir, "runtime");
    Bun.spawnSync(["mkdir", "-p", runtimeDir]);
    const dbPath = join(runtimeDir, "weave.db");
    const legacy = new Database(dbPath);
    createV5Fixture(legacy);
    expect(readSchemaVersion(legacy)).toBe(5);
    expect(
      legacy
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'adapter_preferences'",
        )
        .get(),
    ).toBeNull();
    legacy.close();

    const store = createSqliteRuntimeStore({ dbPath, projectRoot: dir });
    const instance = await store.instances.findById(
      createWorkflowInstanceId("v5-instance"),
    );
    expect(instance.isOk()).toBe(true);
    expect(instance._unsafeUnwrap()?.goal).toBe("keep me");

    const written = await store.preferences.set(
      "adapter-pi",
      "child-extensions",
      VALUE_JSON,
    );
    expect(written.isOk()).toBe(true);
    await store.close();

    const upgraded = new Database(dbPath);
    expect(readSchemaVersion(upgraded)).toBe(6);
    expect(
      upgraded
        .prepare(
          "SELECT version, name FROM schema_migrations WHERE version = 6",
        )
        .get(),
    ).toEqual({ version: 6, name: "adapter_preferences" });
    expect(
      upgraded
        .prepare("SELECT goal FROM workflow_instances WHERE id = ?")
        .get("v5-instance"),
    ).toEqual({ goal: "keep me" });
    expect(
      upgraded
        .prepare("SELECT grant_id FROM permission_grants WHERE grant_id = ?")
        .get("v5-grant"),
    ).toEqual({ grant_id: "v5-grant" });
    expect(
      upgraded
        .prepare(
          "SELECT value_json FROM adapter_preferences WHERE namespace = ? AND key = ?",
        )
        .get("adapter-pi", "child-extensions"),
    ).toEqual({ value_json: VALUE_JSON });
    upgraded.close();
  });
});
