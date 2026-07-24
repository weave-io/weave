import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import type { Result } from "neverthrow";
import { InMemoryPermissionApprovalRepository } from "../permissions/repository.js";
import { createPermissionService } from "../permissions/service.js";
import type {
  DurablePermissionGrantRecord,
  GrantIdentityEnvelope,
  PermissionApprovalRepository,
  PermissionError,
} from "../permissions/types.js";
import { createInMemoryRuntimeStore } from "../runtime/memory-store.js";
import { getPermissionApprovalRepository } from "../runtime/permission-repository.js";
import { BunSqliteDialect } from "../runtime/sqlite/kysely-bun-sqlite.js";
import { CURRENT_SCHEMA_VERSION } from "../runtime/sqlite/migrations.js";
import type { WeaveDatabase } from "../runtime/sqlite/schema.js";
import {
  createSqliteRuntimeStore,
  SqlitePermissionApprovalRepository,
} from "../runtime/sqlite/store.js";

const identity: GrantIdentityEnvelope = {
  projectIdentity: "project",
  agentName: "agent",
  registrationOwner: "owner",
  toolIdentity: "tool",
  registrationRevision: "1",
  policyFingerprint: "policy",
  requestSchemaVersion: "1",
  requestDigest: "digest",
};
const record = (
  id = "grant",
  changes: Partial<DurablePermissionGrantRecord> = {},
): DurablePermissionGrantRecord => ({
  grantId: id,
  identity,
  scope: "durable",
  display: { summary: "summary", details: "details" },
  createdAt: 1,
  state: "active",
  ...changes,
});
function ok<T>(result: { isOk(): boolean; value?: T }): T {
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) throw new Error("expected success");
  return result.value as T;
}
function temp(): string {
  const path = join(tmpdir(), `weave-permissions-${crypto.randomUUID()}`);
  Bun.spawnSync(["mkdir", "-p", path]);
  return path;
}
let dir: string;
beforeEach(() => {
  dir = temp();
});
afterEach(() => {
  Bun.spawnSync(["rm", "-rf", dir]);
});
function sqlite(clock = 10) {
  return createSqliteRuntimeStore({
    dbPath: join(dir, "runtime", "weave.db"),
    clock: () => new Date(clock),
  });
}
function permissionRepository(store: object): PermissionApprovalRepository {
  return getPermissionApprovalRepository(store)._unsafeUnwrap();
}
function repos(): Array<[string, () => PermissionApprovalRepository]> {
  return [
    ["memory", () => new InMemoryPermissionApprovalRepository({}, () => 10)],
    ["sqlite", () => permissionRepository(sqlite())],
  ];
}

for (const [name, make] of repos())
  describe(`${name} permission repository`, () => {
    it("saves, matches, lists deterministically, and keeps sanitized immutable summaries", async () => {
      const repo = make();
      ok(
        await repo.saveMany([
          record("z"),
          record("a", { identity: { ...identity, agentName: "other" } }),
        ]),
      );
      const list = ok(await repo.list("project", 2));
      expect(list.map((x) => x.grantId)).toEqual(["a", "z"]);
      expect(
        Object.isFrozen(list) &&
          Object.isFrozen(list[0]) &&
          Object.isFrozen(list[0].display),
      ).toBe(true);
      expect(list[1]).toEqual({
        project: "project",
        grantId: "z",
        agentName: "agent",
        toolIdentity: "tool",
        scope: "durable",
        display: { summary: "summary", details: "details" },
        createdAt: 1,
        state: "active",
      });
      expect(JSON.stringify(list[1])).not.toMatch(
        /owner|revision|policy|schema|requestDigest|input|raw|secret|token|constraint|canonical/i,
      );
    });
    it("matches only the complete identity, before expiry, and correct project", async () => {
      const repo = make();
      ok(await repo.saveMany([record("x", { expiresAt: 11 })]));
      expect((await repo.match(identity, 10)).isOk()).toBe(true);
      expect((await repo.match(identity, 11))._unsafeUnwrap()).toBeUndefined();
      for (const key of Object.keys(identity) as Array<
        keyof GrantIdentityEnvelope
      >)
        expect(
          (
            await repo.match(
              { ...identity, [key]: `${identity[key]}-changed` },
              2,
            )
          )._unsafeUnwrap(),
        ).toBeUndefined();
      expect(
        (
          await repo.match({ ...identity, projectIdentity: "other" }, 2)
        )._unsafeUnwrap(),
      ).toBeUndefined();
    });
    it("revokes, is idempotent, and rejects unknown projects", async () => {
      const repo = make();
      ok(await repo.saveMany([record()]));
      expect(
        (await repo.revoke("wrong", "grant"))._unsafeUnwrapErr().type,
      ).toBe("unknown_grant");
      ok(await repo.revoke("project", "grant"));
      ok(await repo.revoke("project", "grant"));
      const summary = ok(await repo.list("project", 2))[0];
      expect(summary.state).toBe("revoked");
      expect(summary.revokedAt).toBe(10);
      expect(
        (await repo.revoke("project", "missing"))._unsafeUnwrapErr().type,
      ).toBe("unknown_grant");
    });
    it("rejects empty batches and existing conflicts without overwriting", async () => {
      const repo = make();
      expect((await repo.saveMany([]))._unsafeUnwrapErr().type).toBe(
        "invalid_output",
      );
      ok(await repo.saveMany([record()]));
      const conflict = await repo.saveMany([
        record("grant", { display: { summary: "replacement" } }),
      ]);
      expect(conflict._unsafeUnwrapErr().type).toBe("invalid_output");
      ok(
        await repo.saveMany([
          record("other-project", {
            identity: { ...identity, projectIdentity: "other" },
          }),
        ]),
      );
      expect(ok(await repo.list("project"))[0].display.summary).toBe("summary");
      expect(ok(await repo.list("other"))).toHaveLength(1);
    });
  });

describe("sqlite permission persistence and schema", () => {
  it("uses the injected Date clock for default permission timestamps", async () => {
    const store = sqlite(1234);
    ok(
      await permissionRepository(store).saveMany([
        record("grant", { expiresAt: 1234 }),
      ]),
    );
    expect(
      (await permissionRepository(store).match(identity))._unsafeUnwrap(),
    ).toBeUndefined();
    ok(await permissionRepository(store).revoke("project", "grant"));
    expect(
      ok(await permissionRepository(store).list("project"))[0].revokedAt,
    ).toBe(1234);
    await store.close();
  });

  it("maps direct corrupt and future row fixtures to repository_failure", async () => {
    const store = sqlite();
    ok(
      await permissionRepository(store).saveMany([
        record("future"),
        record("negative", {
          identity: { ...identity, agentName: "other" },
        }),
      ]),
    );
    await store.close();

    const db = new Database(join(dir, "runtime", "weave.db"));
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare(
      "UPDATE permission_grants SET state = 'future' WHERE grant_id = ?",
    ).run("future");
    db.prepare(
      "UPDATE permission_grants SET created_at = -1 WHERE grant_id = ?",
    ).run("negative");
    db.close();

    const reopened = sqlite();
    expect(
      (await permissionRepository(reopened).list("project"))._unsafeUnwrapErr()
        .type,
    ).toBe("repository_failure");
    expect(
      (
        await permissionRepository(reopened).match(identity, 2)
      )._unsafeUnwrapErr().type,
    ).toBe("repository_failure");
    expect(
      (
        await permissionRepository(reopened).match(
          { ...identity, agentName: "other" },
          2,
        )
      )._unsafeUnwrapErr().type,
    ).toBe("repository_failure");
    expect(
      (
        await permissionRepository(reopened).revoke("project", "future")
      )._unsafeUnwrapErr().type,
    ).toBe("repository_failure");
    await reopened.close();
  });

  it("uses the exact permission-grant schema and persists across reopen", async () => {
    const store = sqlite();
    ok(await permissionRepository(store).saveMany([record()]));
    await store.close();
    const db = new Database(join(dir, "runtime", "weave.db"));
    const columns = (
      db.prepare("PRAGMA table_info(permission_grants)").all() as Array<{
        name: string;
      }>
    ).map((x) => x.name);
    expect(columns).toEqual([
      "grant_id",
      "project_identity",
      "agent_name",
      "registration_owner",
      "tool_identity",
      "registration_revision",
      "policy_fingerprint",
      "request_schema_version",
      "request_digest",
      "display_summary",
      "display_details",
      "created_at",
      "expires_at",
      "revoked_at",
      "state",
    ]);
    expect(
      columns.some((x) =>
        /input|raw|constraint|canonical|secret|token/i.test(x),
      ),
    ).toBe(false);
    expect(CURRENT_SCHEMA_VERSION).toBe(4);
    db.close();
    const reopened = sqlite();
    expect(
      ok(await permissionRepository(reopened).match(identity, 2))?.grantId,
    ).toBe("grant");
    await reopened.close();
  });

  it("fails store open when live permission_grants is dropped after v3 init", async () => {
    const store = sqlite();
    ok(await permissionRepository(store).saveMany([record()]));
    await store.close();

    const dbPath = join(dir, "runtime", "weave.db");
    const db = new Database(dbPath);
    const versionBefore = db
      .prepare(
        "SELECT value FROM runtime_metadata WHERE key = 'schema_version'",
      )
      .get();
    const ledgerBefore = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    db.exec("DROP TABLE permission_grants");
    db.close();

    const reopened = sqlite();
    const result = await reopened.instances.list();
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("initialization");
    if (error.type === "initialization") {
      expect(error.message).toBe("Invalid permission_grants schema");
    }
    await reopened.close();

    const verify = new Database(dbPath);
    expect(
      verify
        .prepare(
          "SELECT value FROM runtime_metadata WHERE key = 'schema_version'",
        )
        .get(),
    ).toEqual(versionBefore);
    expect(
      verify
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(ledgerBefore);
    expect(
      verify
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'permission_grants'",
        )
        .get(),
    ).toBeNull();
    verify.close();
  });

  it("fails store open before repository use when hostile triggers are attached", async () => {
    const store = sqlite();
    ok(await permissionRepository(store).saveMany([record()]));
    await store.close();

    const dbPath = join(dir, "runtime", "weave.db");
    const db = new Database(dbPath);
    const versionBefore = db
      .prepare(
        "SELECT value FROM runtime_metadata WHERE key = 'schema_version'",
      )
      .get();
    const ledgerBefore = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    // Trigger ignores fixed probe prefixes, exfiltrates, and rewrites grants.
    db.exec(`
      CREATE TABLE stolen_grants (grant_id TEXT, digest TEXT);
      CREATE TRIGGER permission_grants_after_insert
      AFTER INSERT ON permission_grants
      WHEN NEW.grant_id NOT LIKE '__wpg_%' AND NEW.grant_id NOT LIKE '__weave_probe_%'
      BEGIN
        INSERT INTO stolen_grants(grant_id, digest)
          VALUES (NEW.grant_id, NEW.request_digest);
        UPDATE permission_grants
          SET display_summary = 'exfiltrated'
          WHERE grant_id = NEW.grant_id;
      END;
      CREATE TRIGGER permission_grants_before_delete
      BEFORE DELETE ON permission_grants
      BEGIN
        SELECT RAISE(ABORT, 'hostile before delete');
      END;
    `);
    db.close();

    const reopened = sqlite();
    const result = await reopened.instances.list();
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("initialization");
    if (error.type === "initialization") {
      expect(error.message).toBe("Invalid runtime store schema");
    }
    await reopened.close();

    const verify = new Database(dbPath);
    expect(
      verify
        .prepare(
          "SELECT value FROM runtime_metadata WHERE key = 'schema_version'",
        )
        .get(),
    ).toEqual(versionBefore);
    expect(
      verify
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(ledgerBefore);
    expect(
      verify
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'permission_grants'",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      verify
        .prepare(
          "SELECT state, display_summary FROM permission_grants WHERE grant_id = ?",
        )
        .get("grant"),
    ).toEqual({ state: "active", display_summary: "summary" });
    expect(
      verify.prepare("SELECT COUNT(*) AS count FROM stolen_grants").get(),
    ).toEqual({ count: 0 });
    verify.close();
  });

  it("fails store open when cross-table triggers can reset high-water", async () => {
    const dbPath = join(dir, "runtime-cross-trigger", "weave.db");
    const first = createSqliteRuntimeStore({
      dbPath,
      clock: () => new Date(100),
    });
    ok(
      await permissionRepository(first).saveMany([
        record("expiring", { createdAt: 1, expiresAt: 50 }),
      ]),
    );
    expect(
      ok(await permissionRepository(first).match(identity, 50)),
    ).toBeUndefined();
    await first.close();

    const db = new Database(dbPath);
    const hwBefore = db
      .prepare(
        "SELECT value FROM runtime_metadata WHERE key = 'permission_wall_clock_high_water'",
      )
      .get();
    const versionBefore = db
      .prepare(
        "SELECT value FROM runtime_metadata WHERE key = 'schema_version'",
      )
      .get();
    // Trigger on an unrelated code-owned table that resets permission high-water.
    db.exec(`
      CREATE TRIGGER workflow_instances_after_insert_hw
      AFTER INSERT ON workflow_instances
      BEGIN
        INSERT OR REPLACE INTO runtime_metadata (key, value)
          VALUES ('permission_wall_clock_high_water', '0');
      END;
      CREATE TRIGGER workflow_instances_before_update_hw
      BEFORE UPDATE ON workflow_instances
      BEGIN
        UPDATE runtime_metadata SET value = '0'
          WHERE key = 'permission_wall_clock_high_water';
      END;
    `);
    db.close();

    const reopened = createSqliteRuntimeStore({
      dbPath,
      clock: () => new Date(1),
    });
    const result = await reopened.instances.list();
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("initialization");
    if (error.type === "initialization") {
      expect(error.message).toBe("Invalid runtime store schema");
    }
    const perm = await permissionRepository(reopened).match(identity, 1);
    expect(perm.isErr()).toBe(true);
    expect(perm._unsafeUnwrapErr().type).toBe("repository_failure");
    await reopened.close();

    const verify = new Database(dbPath);
    expect(
      verify
        .prepare(
          "SELECT value FROM runtime_metadata WHERE key = 'permission_wall_clock_high_water'",
        )
        .get(),
    ).toEqual(hwBefore);
    expect(
      verify
        .prepare(
          "SELECT value FROM runtime_metadata WHERE key = 'schema_version'",
        )
        .get(),
    ).toEqual(versionBefore);
    expect(
      verify
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger'",
        )
        .get(),
    ).toEqual({ count: 2 });
    verify.close();
  });

  it("fails store open when extra unique/partial/expression indexes exist on permission_grants", async () => {
    const extras = [
      `CREATE UNIQUE INDEX idx_permission_grants_extra_unique
         ON permission_grants (grant_id);`,
      `CREATE INDEX idx_permission_grants_extra_partial
         ON permission_grants (project_identity)
         WHERE state = 'active';`,
      `CREATE INDEX idx_permission_grants_extra_expr
         ON permission_grants ((lower(tool_identity)));`,
    ] as const;

    for (const [index, ddl] of extras.entries()) {
      const caseDir = join(dir, `extra-index-${index}`);
      Bun.spawnSync(["mkdir", "-p", caseDir]);
      const store = createSqliteRuntimeStore({
        dbPath: join(caseDir, "runtime", "weave.db"),
        clock: () => new Date(10),
      });
      ok(await permissionRepository(store).saveMany([record(`g-${index}`)]));
      await store.close();

      const dbPath = join(caseDir, "runtime", "weave.db");
      const db = new Database(dbPath);
      const versionBefore = db
        .prepare(
          "SELECT value FROM runtime_metadata WHERE key = 'schema_version'",
        )
        .get();
      const ledgerBefore = db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all();
      db.exec(ddl);
      db.close();

      const reopened = createSqliteRuntimeStore({
        dbPath,
        clock: () => new Date(10),
      });
      const result = await reopened.instances.list();
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.type).toBe("initialization");
      if (error.type === "initialization") {
        expect(error.message).toBe("Invalid permission_grants schema");
      }
      await reopened.close();

      const verify = new Database(dbPath);
      expect(
        verify
          .prepare(
            "SELECT value FROM runtime_metadata WHERE key = 'schema_version'",
          )
          .get(),
      ).toEqual(versionBefore);
      expect(
        verify
          .prepare(
            "SELECT version, name FROM schema_migrations ORDER BY version",
          )
          .all(),
      ).toEqual(ledgerBefore);
      verify.close();
    }
  });

  it("rejects direct revoked rows with null revoked_at at the SQL boundary", async () => {
    const store = sqlite();
    ok(await permissionRepository(store).saveMany([record()]));
    await store.close();

    const db = new Database(join(dir, "runtime", "weave.db"));
    const insert = db.prepare(`
      INSERT INTO permission_grants (
        grant_id, project_identity, agent_name, registration_owner,
        tool_identity, registration_revision, policy_fingerprint,
        request_schema_version, request_digest, display_summary,
        display_details, created_at, expires_at, revoked_at, state
      ) VALUES (?, 'project', 'agent', 'owner', 'tool', '1', 'policy',
        '1', ?, 'summary', NULL, ?, NULL, ?, ?)
    `);

    expect(() =>
      insert.run("revoked-null", "digest-2", 1, null, "revoked"),
    ).toThrow(/CHECK constraint failed/i);
    expect(() =>
      insert.run("active-revoked", "digest-3", 1, 2, "active"),
    ).toThrow(/CHECK constraint failed/i);
    expect(() =>
      insert.run("revoked-before", "digest-4", 5, 4, "revoked"),
    ).toThrow(/CHECK constraint failed/i);

    insert.run("revoked-ok", "digest-5", 5, 5, "revoked");
    expect(
      db
        .prepare(
          "SELECT state, revoked_at FROM permission_grants WHERE grant_id = ?",
        )
        .get("revoked-ok"),
    ).toEqual({ state: "revoked", revoked_at: 5 });
    db.close();
  });

  it("returns repository_failure after close", async () => {
    const store = sqlite();
    ok(await store.close());
    expect(
      (await permissionRepository(store).list("project"))._unsafeUnwrapErr()
        .type,
    ).toBe("repository_failure");
  });

  it("retries lazy permission repository init after a recoverable path failure", async () => {
    // Parent path is a file so mkdir of the DB directory fails.
    const blockedParent = join(dir, "blocked-parent");
    await Bun.write(blockedParent, "not-a-directory");
    const dbPath = join(blockedParent, "runtime", "weave.db");
    const store = createSqliteRuntimeStore({
      dbPath,
      clock: () => new Date(10),
    });
    const repo = permissionRepository(store);

    const first = repo.list("project");
    const firstSettled = await Promise.allSettled([first]);
    expect(firstSettled[0]?.status).toBe("fulfilled");
    const firstResult = await first;
    expect(firstResult.isErr()).toBe(true);
    expect(firstResult._unsafeUnwrapErr().type).toBe("repository_failure");

    // Repair the path without reconstructing the store or permission wrapper.
    Bun.spawnSync(["rm", "-f", blockedParent]);

    // Ordinary store repository init succeeds on the repaired path.
    ok(await store.instances.list());

    // Next permission operation reuses the same lazy wrapper and succeeds.
    const second = repo.list("project");
    const secondSettled = await Promise.allSettled([second]);
    expect(secondSettled[0]?.status).toBe("fulfilled");
    expect(ok(await second)).toEqual([]);

    ok(await repo.saveMany([record()]));
    expect(ok(await repo.list("project")).map((g) => g.grantId)).toEqual([
      "grant",
    ]);

    // Closed store stays failed and must not reopen.
    ok(await store.close());
    expect((await repo.list("project"))._unsafeUnwrapErr().type).toBe(
      "repository_failure",
    );
    expect((await store.instances.list()).isErr()).toBe(true);
  });

  it("shares one in-flight lazy permission init and retries together after failure", async () => {
    const blockedParent = join(dir, "blocked-concurrent");
    await Bun.write(blockedParent, "not-a-directory");
    const dbPath = join(blockedParent, "runtime", "weave.db");
    const store = createSqliteRuntimeStore({
      dbPath,
      clock: () => new Date(10),
    });
    const repo = permissionRepository(store);

    const failing = [
      repo.list("project"),
      repo.match(identity),
      repo.list("p"),
    ];
    const failedSettled = await Promise.allSettled(failing);
    for (const settled of failedSettled) {
      expect(settled.status).toBe("fulfilled");
      if (settled.status !== "fulfilled") continue;
      expect(settled.value.isErr()).toBe(true);
      expect(settled.value._unsafeUnwrapErr().type).toBe("repository_failure");
    }

    Bun.spawnSync(["rm", "-f", blockedParent]);

    const retrying = [
      repo.list("project"),
      repo.match(identity),
      repo.saveMany([record()]),
    ];
    const retrySettled = await Promise.allSettled(retrying);
    for (const settled of retrySettled) {
      expect(settled.status).toBe("fulfilled");
      if (settled.status !== "fulfilled") continue;
      expect(settled.value.isOk()).toBe(true);
    }
    expect(ok(await repo.list("project")).map((g) => g.grantId)).toEqual([
      "grant",
    ]);
    await store.close();
  });

  it("maps throwing clocks on list/match/revoke to repository_failure without queue poison", async () => {
    let shouldThrow = true;
    const store = createSqliteRuntimeStore({
      dbPath: join(dir, "runtime", "weave.db"),
      clock: () => {
        if (shouldThrow) throw new Error("TOP_SECRET_clock");
        return new Date(10);
      },
    });
    // saveMany does not consult the clock — seed a grant while healthy.
    shouldThrow = false;
    ok(await permissionRepository(store).saveMany([record()]));

    shouldThrow = true;
    for (const op of [
      () => permissionRepository(store).list("project"),
      () => permissionRepository(store).match(identity),
      () => permissionRepository(store).revoke("project", "grant"),
    ]) {
      const result = await op();
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe("repository_failure");
      expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(
        "TOP_SECRET",
      );
    }

    // Recovery: a healthy clock leaves the queue usable.
    shouldThrow = false;
    expect(ok(await permissionRepository(store).list("project"))).toHaveLength(
      1,
    );
    expect(
      (await permissionRepository(store).match(identity))._unsafeUnwrap()
        ?.grantId,
    ).toBe("grant");
    ok(await permissionRepository(store).revoke("project", "grant"));
    expect(ok(await permissionRepository(store).list("project"))[0].state).toBe(
      "revoked",
    );
    await store.close();
  });

  it("concurrent duplicate saves across store instances yield one ok and one invalid_output", async () => {
    const dbPath = join(dir, "runtime", "weave.db");
    const bootstrap = createSqliteRuntimeStore({
      dbPath,
      clock: () => new Date(10),
    });
    ok(await bootstrap.ensureInitialized());
    await bootstrap.close();

    const attempts: Array<
      Promise<Result<readonly DurablePermissionGrantRecord[], PermissionError>>
    > = Array.from({ length: 12 }, async () => {
      const store = createSqliteRuntimeStore({
        dbPath,
        clock: () => new Date(10),
      });
      const result = await permissionRepository(store).saveMany([
        record("dup"),
      ]);
      await store.close();
      return result;
    });
    const results = await Promise.all(attempts);
    const oks = results.filter((result) => result.isOk());
    const errs = results.filter((result) => result.isErr());
    expect(oks).toHaveLength(1);
    expect(errs).toHaveLength(results.length - 1);
    for (const result of errs) {
      expect(result._unsafeUnwrapErr().type).toBe("invalid_output");
      expect(JSON.stringify(result._unsafeUnwrapErr())).not.toMatch(
        /UNIQUE|constraint|SQLITE/i,
      );
    }

    const verify = createSqliteRuntimeStore({
      dbPath,
      clock: () => new Date(10),
    });
    expect(ok(await permissionRepository(verify).list("project"))).toHaveLength(
      1,
    );
    await verify.close();
  });

  it("same-repository concurrent duplicate ids yield one ok and rest invalid_output", async () => {
    const store = sqlite();
    const repo = permissionRepository(store);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => repo.saveMany([record("dup")])),
    );
    const oks = results.filter((result) => result.isOk());
    const errs = results.filter((result) => result.isErr());
    expect(oks).toHaveLength(1);
    expect(errs).toHaveLength(11);
    for (const result of errs) {
      expect(result._unsafeUnwrapErr().type).toBe("invalid_output");
      expect(JSON.stringify(result._unsafeUnwrapErr())).not.toMatch(
        /UNIQUE|constraint|SQLITE|busy|transaction/i,
      );
    }
    expect(ok(await repo.list("project"))).toHaveLength(1);
    await store.close();
  });

  it("same-repository concurrent duplicate full envelopes yield one ok and rest invalid_output", async () => {
    const store = sqlite();
    const repo = permissionRepository(store);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        repo.saveMany([
          record(`id-${index}`, {
            identity: { ...identity },
          }),
        ]),
      ),
    );
    const oks = results.filter((result) => result.isOk());
    const errs = results.filter((result) => result.isErr());
    expect(oks).toHaveLength(1);
    expect(errs).toHaveLength(11);
    for (const result of errs) {
      expect(result._unsafeUnwrapErr().type).toBe("invalid_output");
      expect(JSON.stringify(result._unsafeUnwrapErr())).not.toMatch(
        /UNIQUE|constraint|SQLITE|busy|transaction/i,
      );
    }
    expect(ok(await repo.list("project"))).toHaveLength(1);
    await store.close();
  });

  it("same-repository concurrent distinct valid batches all succeed without lost writes", async () => {
    const store = sqlite();
    const repo = permissionRepository(store);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        repo.saveMany([
          record(`grant-${index}`, {
            identity: {
              ...identity,
              requestDigest: `digest-${index}`,
            },
          }),
        ]),
      ),
    );
    expect(results.every((result) => result.isOk())).toBe(true);
    const expectedIds = Array.from(
      { length: 12 },
      (_, index) => `grant-${index}`,
    ).sort((a, b) => a.localeCompare(b));
    expect(
      ok(await repo.list("project")).map((summary) => summary.grantId),
    ).toEqual(expectedIds);
    await store.close();
  });

  it("recovers the mutation queue after an injected failure then accepts a valid write", async () => {
    const store = sqlite();
    const repo = permissionRepository(store);
    const injected = await Promise.all([
      repo.saveMany([record("bad", { scope: "once" as "durable" })]),
      repo.saveMany([
        record("good", {
          identity: { ...identity, requestDigest: "good-digest" },
        }),
      ]),
    ]);
    expect(injected[0].isErr()).toBe(true);
    expect(injected[0]._unsafeUnwrapErr().type).toBe("invalid_output");
    expect(JSON.stringify(injected[0]._unsafeUnwrapErr())).not.toContain(
      "once",
    );
    expect(injected[1].isOk()).toBe(true);

    // Sequential recovery after a later failure still works.
    expect((await repo.saveMany([]))._unsafeUnwrapErr().type).toBe(
      "invalid_output",
    );
    ok(
      await repo.saveMany([
        record("after", {
          identity: { ...identity, requestDigest: "after-digest" },
        }),
      ]),
    );
    expect(
      ok(await repo.list("project")).map((summary) => summary.grantId),
    ).toEqual(["after", "good"]);
    await store.close();
  });

  it("concurrent revoke is idempotent and retains the first timestamp", async () => {
    let tick = 100;
    const store = createSqliteRuntimeStore({
      dbPath: join(dir, "runtime", "weave.db"),
      clock: () => new Date(tick++),
    });
    const repo = permissionRepository(store);
    ok(await repo.saveMany([record("grant", { createdAt: 1 })]));
    // saveMany observes the clock once for high-water; pin the first revoke tick.
    tick = 200;
    const results = await Promise.all(
      Array.from({ length: 12 }, () => repo.revoke("project", "grant")),
    );
    expect(results.every((result) => result.isOk())).toBe(true);
    const summary = ok(await repo.list("project"))[0];
    expect(summary.state).toBe("revoked");
    // First queued revoke owns the timestamp; later idempotent calls do not advance it.
    expect(summary.revokedAt).toBe(200);
    await store.close();
  });
});

describe("in-memory store permission clock association", () => {
  it("revokes with the injected Date clock via createPermissionService association", async () => {
    const store = createInMemoryRuntimeStore({
      clock: () => new Date(4242),
    });
    // Prove the private association used by PermissionService carries the clock.
    expect(createPermissionService(store)).toBeDefined();
    const repo = getPermissionApprovalRepository(store)._unsafeUnwrap();
    ok(await repo.saveMany([record("grant", { createdAt: 1 })]));
    ok(await repo.revoke("project", "grant"));
    expect(ok(await repo.list("project"))[0].revokedAt).toBe(4242);
  });
});

describe("permission repository wall-clock high-water", () => {
  it("keeps expired durable grants ineligible after wall rollback (memory)", async () => {
    let now = 10;
    const repo = new InMemoryPermissionApprovalRepository({}, () => now);
    ok(
      await repo.saveMany([
        record("expiring", { createdAt: 1, expiresAt: 20 }),
      ]),
    );
    expect(ok(await repo.match(identity, 19))?.grantId).toBe("expiring");
    expect(ok(await repo.match(identity, 20))).toBeUndefined();
    now = 5;
    expect(ok(await repo.match(identity, 5))).toBeUndefined();
    expect(ok(await repo.match(identity))).toBeUndefined();
  });

  it("keeps expired durable grants ineligible after wall rollback (sqlite)", async () => {
    let now = 10;
    const store = createSqliteRuntimeStore({
      dbPath: join(dir, "runtime-hw", "weave.db"),
      clock: () => new Date(now),
    });
    const repo = permissionRepository(store);
    ok(
      await repo.saveMany([
        record("expiring", { createdAt: 1, expiresAt: 20 }),
      ]),
    );
    expect(ok(await repo.match(identity, 19))?.grantId).toBe("expiring");
    expect(ok(await repo.match(identity, 20))).toBeUndefined();
    now = 5;
    expect(ok(await repo.match(identity, 5))).toBeUndefined();
    expect(ok(await repo.match(identity))).toBeUndefined();
    await store.close();
  });

  it("persists high-water across SQLite close/reopen under a lower clock", async () => {
    const dbPath = join(dir, "runtime-reopen", "weave.db");
    const first = createSqliteRuntimeStore({
      dbPath,
      clock: () => new Date(100),
    });
    ok(
      await permissionRepository(first).saveMany([
        record("expiring", { createdAt: 1, expiresAt: 50 }),
      ]),
    );
    // Observe expiry at the boundary.
    expect(
      ok(await permissionRepository(first).match(identity, 50)),
    ).toBeUndefined();
    await first.close();

    const reopened = createSqliteRuntimeStore({
      dbPath,
      clock: () => new Date(1),
    });
    // Lower wall clock after reopen must not resurrect the grant.
    expect(
      ok(await permissionRepository(reopened).match(identity, 1)),
    ).toBeUndefined();
    expect(
      ok(await permissionRepository(reopened).match(identity)),
    ).toBeUndefined();
    await reopened.close();
  });

  it("fails open before high-water can reset when runtime_metadata triggers are attached", async () => {
    const dbPath = join(dir, "runtime-hw-trigger", "weave.db");
    const first = createSqliteRuntimeStore({
      dbPath,
      clock: () => new Date(100),
    });
    ok(
      await permissionRepository(first).saveMany([
        record("expiring", { createdAt: 1, expiresAt: 50 }),
      ]),
    );
    expect(
      ok(await permissionRepository(first).match(identity, 50)),
    ).toBeUndefined();
    await first.close();

    const db = new Database(dbPath);
    const hwBefore = db
      .prepare(
        "SELECT value FROM runtime_metadata WHERE key = 'permission_wall_clock_high_water'",
      )
      .get();
    const versionBefore = db
      .prepare(
        "SELECT value FROM runtime_metadata WHERE key = 'schema_version'",
      )
      .get();
    const ledgerBefore = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    // Hostile triggers that would zero high-water or rewrite the ledger.
    db.exec(`
      CREATE TRIGGER runtime_metadata_hw_reset
      AFTER UPDATE ON runtime_metadata
      WHEN NEW.key = 'permission_wall_clock_high_water'
      BEGIN
        UPDATE runtime_metadata SET value = '0'
          WHERE key = 'permission_wall_clock_high_water';
      END;
      CREATE TRIGGER runtime_metadata_before_update
      BEFORE UPDATE ON runtime_metadata
      WHEN NEW.key = 'permission_wall_clock_high_water'
      BEGIN
        SELECT RAISE(ABORT, 'hostile high-water reset');
      END;
      CREATE TRIGGER schema_migrations_tamper
      AFTER INSERT ON schema_migrations
      BEGIN
        DELETE FROM schema_migrations WHERE version = NEW.version;
      END;
    `);
    db.close();

    const reopened = createSqliteRuntimeStore({
      dbPath,
      clock: () => new Date(1),
    });
    const result = await reopened.instances.list();
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("initialization");
    if (error.type === "initialization") {
      expect(error.message).toBe("Invalid migration bootstrap schema");
    }
    const perm = await permissionRepository(reopened).match(identity, 1);
    expect(perm.isErr()).toBe(true);
    expect(perm._unsafeUnwrapErr().type).toBe("repository_failure");
    await reopened.close();

    const verify = new Database(dbPath);
    expect(
      verify
        .prepare(
          "SELECT value FROM runtime_metadata WHERE key = 'permission_wall_clock_high_water'",
        )
        .get(),
    ).toEqual(hwBefore);
    expect(
      verify
        .prepare(
          "SELECT value FROM runtime_metadata WHERE key = 'schema_version'",
        )
        .get(),
    ).toEqual(versionBefore);
    expect(
      verify
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all(),
    ).toEqual(ledgerBefore);
    expect(
      verify
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('runtime_metadata', 'schema_migrations')",
        )
        .get(),
    ).toEqual({ count: 3 });
    verify.close();
  });

  it("keeps no-expiry durable grants matchable after high-water advances", async () => {
    const repo = new InMemoryPermissionApprovalRepository({}, () => 10);
    ok(await repo.saveMany([record("forever", { createdAt: 1 })]));
    expect(ok(await repo.match(identity, 1_000_000))?.grantId).toBe("forever");
    expect(ok(await repo.match(identity, 1))?.grantId).toBe("forever");
  });

  it("does not expose high-water on the public repository surface", () => {
    const memory = new InMemoryPermissionApprovalRepository();
    expect(Object.keys(memory)).not.toContain("wallHighWater");
    expect(
      Object.getOwnPropertyNames(memory).filter((key) =>
        key.toLowerCase().includes("highwater"),
      ),
    ).toEqual([]);
    const store = sqlite();
    const repo = permissionRepository(store);
    expect(Object.keys(repo as object)).not.toContain("wallHighWater");
    expect(
      Object.getOwnPropertyNames(repo as object).filter((key) =>
        key.toLowerCase().includes("highwater"),
      ),
    ).toEqual([]);
  });

  it("idempotent revoke observes high-water before early return (memory + sqlite)", async () => {
    // Scenario: grant A already revoked; revoke again at 200; rollback to 50;
    // grant B with expiry 100 must remain ineligible. Unknown/wrong-project
    // revokes must NOT poison high-water.
    for (const backend of ["memory", "sqlite"] as const) {
      let now = 10;
      const clock = () => now;
      const store =
        backend === "sqlite"
          ? createSqliteRuntimeStore({
              dbPath: join(dir, `runtime-hw-revoke-${backend}`, "weave.db"),
              clock: () => new Date(now),
            })
          : null;
      const repo =
        backend === "memory"
          ? new InMemoryPermissionApprovalRepository({}, clock)
          : permissionRepository(store as NonNullable<typeof store>);

      ok(
        await repo.saveMany([
          record("grant-a", {
            createdAt: 1,
            identity: { ...identity, requestDigest: "digest-a" },
          }),
        ]),
      );
      now = 15;
      ok(await repo.revoke("project", "grant-a"));
      expect(ok(await repo.list("project"))[0].revokedAt).toBe(15);

      // Idempotent revoke at a later wall time must still advance high-water.
      now = 200;
      ok(await repo.revoke("project", "grant-a"));
      // First revoke timestamp is retained.
      expect(ok(await repo.list("project"))[0].revokedAt).toBe(15);

      // Unknown / wrong-project must not poison high-water after rollback.
      now = 50;
      expect(
        (await repo.revoke("wrong", "grant-a"))._unsafeUnwrapErr().type,
      ).toBe("unknown_grant");
      expect(
        (await repo.revoke("project", "missing"))._unsafeUnwrapErr().type,
      ).toBe("unknown_grant");

      ok(
        await repo.saveMany([
          record("grant-b", {
            createdAt: 1,
            expiresAt: 100,
            identity: { ...identity, requestDigest: "digest-b" },
          }),
        ]),
      );
      const bIdentity = { ...identity, requestDigest: "digest-b" };
      // High-water stayed at >=200 from the idempotent revoke; expiry 100 is dead.
      expect(ok(await repo.match(bIdentity, 50))).toBeUndefined();
      expect(ok(await repo.match(bIdentity))).toBeUndefined();

      if (store) {
        await store.close();
        // SQLite reopen under a lower clock must keep grant B ineligible.
        const reopened = createSqliteRuntimeStore({
          dbPath: join(dir, `runtime-hw-revoke-${backend}`, "weave.db"),
          clock: () => new Date(1),
        });
        expect(
          ok(await permissionRepository(reopened).match(bIdentity, 1)),
        ).toBeUndefined();
        expect(
          ok(await permissionRepository(reopened).match(bIdentity)),
        ).toBeUndefined();
        await reopened.close();
      }
    }
  });

  it("unknown revoke does not advance high-water before a real observation", async () => {
    for (const [, make] of repos()) {
      const repo = make();
      ok(
        await repo.saveMany([
          record("alive", { createdAt: 1, expiresAt: 100 }),
        ]),
      );
      // Baseline observation at 10 (repo clocks default to 10).
      expect(ok(await repo.match(identity, 10))?.grantId).toBe("alive");
      // Hostile unknown revokes with no path to a high wall time.
      expect(
        (await repo.revoke("wrong", "alive"))._unsafeUnwrapErr().type,
      ).toBe("unknown_grant");
      expect(
        (await repo.revoke("project", "nope"))._unsafeUnwrapErr().type,
      ).toBe("unknown_grant");
      // Grant must still match below expiry — high-water was not poisoned.
      expect(ok(await repo.match(identity, 10))?.grantId).toBe("alive");
      expect(ok(await repo.match(identity, 50))?.grantId).toBe("alive");
    }
  });

  it("concurrent multi-store high-water observations persist the global max", async () => {
    // Preinitialize 8 stores, concurrently observe mixed times (incl. max)
    // via match/list/revoke, close, reopen at a lower clock, and assert the
    // persisted mark equals max so expired grants never rematch. 20 rounds
    // catch lost-max races under multi-connection BEGIN IMMEDIATE contention.
    const rounds = 20;
    const storeCount = 8;
    const maxTs = 10_000;
    const mixed = [100, 50, maxTs, 250, 10, 999, 7, 500];
    expect(mixed).toHaveLength(storeCount);
    expect(Math.max(...mixed)).toBe(maxTs);

    for (let round = 0; round < rounds; round += 1) {
      const dbPath = join(dir, `runtime-hw-concurrent-${round}`, "weave.db");
      const bootstrap = createSqliteRuntimeStore({
        dbPath,
        clock: () => new Date(1),
      });
      ok(await bootstrap.ensureInitialized());
      ok(
        await permissionRepository(bootstrap).saveMany([
          record("expiring", { createdAt: 1, expiresAt: maxTs }),
          record("revocable", {
            createdAt: 1,
            identity: { ...identity, requestDigest: "revoke-digest" },
          }),
        ]),
      );
      await bootstrap.close();

      const stores = mixed.map((ts) =>
        createSqliteRuntimeStore({
          dbPath,
          clock: () => new Date(ts),
        }),
      );
      for (const store of stores) ok(await store.ensureInitialized());

      const results = await Promise.all(
        stores.map((store, index) => {
          const repo = permissionRepository(store);
          const ts = mixed[index] as number;
          const lane = index % 3;
          if (lane === 0) return repo.match(identity, ts);
          if (lane === 1) return repo.list("project", ts);
          return repo.revoke("project", "revocable");
        }),
      );
      // ResultAsync must never reject — Promise.all would throw otherwise.
      expect(results.every((result) => result.isOk())).toBe(true);

      await Promise.all(stores.map((store) => store.close()));

      const reopened = createSqliteRuntimeStore({
        dbPath,
        clock: () => new Date(1),
      });
      // Persisted high-water must be maxTs: grant expiring at max is dead.
      expect(
        ok(await permissionRepository(reopened).match(identity, 1)),
      ).toBeUndefined();
      expect(
        ok(await permissionRepository(reopened).match(identity)),
      ).toBeUndefined();
      // A fresh no-expiry grant remains matchable (high-water does not deny it).
      ok(
        await permissionRepository(reopened).saveMany([
          record("forever", {
            createdAt: 1,
            identity: { ...identity, requestDigest: "forever-digest" },
          }),
        ]),
      );
      expect(
        ok(
          await permissionRepository(reopened).match({
            ...identity,
            requestDigest: "forever-digest",
          }),
        )?.grantId,
      ).toBe("forever");
      await reopened.close();
    }
  });
});

describe("permission validation and atomic batches", () => {
  it("rejects invalid records without writing", async () => {
    const repo = new InMemoryPermissionApprovalRepository();
    const invalid = [
      record("", {}),
      record("bad", { display: { summary: "\uD800" } }),
      record("extra", {
        ...({ extra: true } as unknown as DurablePermissionGrantRecord),
      }),
    ];
    for (const value of invalid)
      expect((await repo.saveMany([value])).isErr()).toBe(true);
    expect(ok(await repo.list("project"))).toHaveLength(0);
  });
  it("keeps mixed valid and invalid batches atomic in both repositories", async () => {
    for (const [, make] of repos()) {
      const repo = make();
      expect(
        (
          await repo.saveMany([
            record("valid"),
            record("invalid", { scope: "once" as "durable" }),
          ])
        ).isErr(),
      ).toBe(true);
      expect(ok(await repo.list("project"))).toHaveLength(0);
    }
  });
  it("rejects duplicate ids and identities atomically", async () => {
    const repo = new InMemoryPermissionApprovalRepository();
    expect((await repo.saveMany([record("a"), record("a")])).isErr()).toBe(
      true,
    );
    expect(
      (
        await repo.saveMany([
          record("a"),
          { ...record("b"), identity: { ...identity } },
        ])
      ).isErr(),
    ).toBe(true);
    expect(ok(await repo.list("project"))).toHaveLength(0);
    ok(await repo.saveMany([record("existing")]));
    expect(
      (
        await repo.saveMany([
          record("existing", { identity: { ...identity, agentName: "new" } }),
          record("new"),
        ])
      ).isErr(),
    ).toBe(true);
    expect(ok(await repo.list("project"))).toHaveLength(1);
  });
  it("maps hostile caller envelopes to invalid_output without queue poison", async () => {
    for (const [, make] of repos()) {
      const repo = make();
      ok(await repo.saveMany([record("kept")]));
      const hostileRecord = new Proxy(record("hostile"), {
        getOwnPropertyDescriptor: () => {
          throw new Error("TOP_SECRET_save");
        },
      });
      const save = await repo.saveMany([hostileRecord as never]);
      expect(save.isErr()).toBe(true);
      expect(save._unsafeUnwrapErr().type).toBe("invalid_output");
      expect(JSON.stringify(save._unsafeUnwrapErr())).not.toContain(
        "TOP_SECRET",
      );
      expect(ok(await repo.list("project")).map((x) => x.grantId)).toEqual([
        "kept",
      ]);

      const hostileIdentity = new Proxy(identity, {
        ownKeys: () => {
          throw new Error("TOP_SECRET_match");
        },
      });
      const match = await repo.match(hostileIdentity as never, 2);
      expect(match._unsafeUnwrapErr().type).toBe("invalid_output");
      expect(ok(await repo.match(identity, 2))?.grantId).toBe("kept");
      expect(ok(await repo.list("project"))).toHaveLength(1);
    }
  });
});

describe("sqlite match exact identity defense", () => {
  it("does not authorize collation-mismatched rows after hydration", async () => {
    // Bypass migration open checks: build a NOCASE permission_grants table so
    // SQLite equality would match Tool.Case to tool.case, then prove match()
    // still refuses via exact JavaScript identity equality.
    const dbPath = join(dir, "nocase-match-defense", "weave.db");
    Bun.spawnSync(["mkdir", "-p", join(dir, "nocase-match-defense")]);
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE runtime_metadata (
        key TEXT NOT NULL PRIMARY KEY,
        value TEXT NOT NULL
      );
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
      INSERT INTO permission_grants (
        grant_id, project_identity, agent_name, registration_owner,
        tool_identity, registration_revision, policy_fingerprint,
        request_schema_version, request_digest, display_summary,
        display_details, created_at, expires_at, revoked_at, state
      ) VALUES (
        'grant-case', 'project', 'agent', 'owner',
        'Tool.Case', '1', 'policy',
        '1', 'digest', 'summary',
        NULL, 1, NULL, NULL, 'active'
      );
    `);
    // SQLite NOCASE would treat these as equal at the SQL layer.
    expect(
      seed
        .prepare(
          "SELECT grant_id FROM permission_grants WHERE tool_identity = ?",
        )
        .get("tool.case"),
    ).toEqual({ grant_id: "grant-case" });
    seed.close();

    const dialect = new BunSqliteDialect(dbPath);
    const db = new Kysely<WeaveDatabase>({ dialect });
    const repo = new SqlitePermissionApprovalRepository(db, () => 10);

    const mismatched: GrantIdentityEnvelope = {
      ...identity,
      toolIdentity: "tool.case",
    };
    const matched = await repo.match(mismatched, 2);
    expect(matched.isOk()).toBe(true);
    expect(matched._unsafeUnwrap()).toBeUndefined();

    // Exact identity still authorizes.
    const exact: GrantIdentityEnvelope = {
      ...identity,
      toolIdentity: "Tool.Case",
    };
    expect(ok(await repo.match(exact, 2))?.grantId).toBe("grant-case");

    await db.destroy();
  });
});
