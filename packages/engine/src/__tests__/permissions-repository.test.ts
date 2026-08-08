import { describe, expect, test } from "bun:test";
import {
  cloneDurableGrant,
  grantIdentitiesEqual,
  grantIdentityKey,
  hydrateDurableGrant,
  InMemoryPermissionApprovalRepository,
  summarizeDurableGrant,
  validateDurableGrantRecordResult,
  validateGrantIdentityResult,
} from "../permissions/repository.js";
import type {
  DurablePermissionGrantRecord,
  GrantIdentityEnvelope,
} from "../permissions/types.js";

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
const record = (grantId = "grant"): DurablePermissionGrantRecord => ({
  grantId,
  identity,
  scope: "durable",
  display: { summary: "summary" },
  createdAt: 1,
  state: "active",
});
const IDENTITY_FIELDS = [
  "projectIdentity",
  "agentName",
  "registrationOwner",
  "toolIdentity",
  "registrationRevision",
  "policyFingerprint",
  "requestSchemaVersion",
  "requestDigest",
] as const;

describe("permission repository helpers", () => {
  test("grantIdentityKey is Result-safe, order-independent, and collision-free", () => {
    const left = grantIdentityKey(identity);
    const reversed = Object.fromEntries(
      [...IDENTITY_FIELDS].reverse().map((field) => [field, identity[field]]),
    ) as unknown as GrantIdentityEnvelope;
    const right = grantIdentityKey(reversed);
    expect(left.isOk()).toBe(true);
    expect(right.isOk()).toBe(true);
    expect(left._unsafeUnwrap()).toBe(right._unsafeUnwrap());
    expect(left._unsafeUnwrap().length).toBeGreaterThan(0);
    expect(left._unsafeUnwrap()).not.toContain("project");
    expect(left._unsafeUnwrap()).not.toContain("digest");

    const delimiterLeft = grantIdentityKey({
      ...identity,
      agentName: "a|b",
      toolIdentity: "c",
    });
    const delimiterRight = grantIdentityKey({
      ...identity,
      agentName: "a",
      toolIdentity: "b|c",
    });
    expect(delimiterLeft.isOk() && delimiterRight.isOk()).toBe(true);
    expect(delimiterLeft._unsafeUnwrap()).not.toBe(
      delimiterRight._unsafeUnwrap(),
    );

    const equal = grantIdentitiesEqual(identity, { ...identity });
    expect(equal._unsafeUnwrap()).toBe(true);
    expect(
      grantIdentitiesEqual(identity, {
        ...identity,
        requestDigest: "other",
      })._unsafeUnwrap(),
    ).toBe(false);
  });

  test("helpers reject hostile proxies without fabricating fallbacks or throwing", () => {
    const traps = [
      "getOwnPropertyDescriptor",
      "ownKeys",
      "getPrototypeOf",
    ] as const;
    for (const trap of traps) {
      const hostileIdentity = new Proxy(identity, {
        [trap]: () => {
          throw new Error(`TOP_SECRET_${trap}`);
        },
      });
      const key = grantIdentityKey(hostileIdentity as never);
      expect(key.isErr()).toBe(true);
      expect(key._unsafeUnwrapErr().type).toBe("invalid_output");
      expect(key.isOk() ? key.value : "").toBe("");
      expect(JSON.stringify(key._unsafeUnwrapErr())).not.toContain(
        "TOP_SECRET",
      );

      const equal = grantIdentitiesEqual(identity, hostileIdentity as never);
      expect(equal.isErr()).toBe(true);
      expect(equal._unsafeUnwrapErr().type).toBe("invalid_output");
    }

    // Accessor-only identities are rejected (no data-property descriptors).
    const accessorIdentity = new Proxy(identity, {
      getOwnPropertyDescriptor: (target, prop) => {
        if (typeof prop !== "string" || !(prop in target)) return undefined;
        return {
          enumerable: true,
          configurable: true,
          get: () => {
            throw new Error("TOP_SECRET_accessor");
          },
        };
      },
    });
    const accessorKey = grantIdentityKey(accessorIdentity as never);
    expect(accessorKey.isErr()).toBe(true);
    expect(accessorKey._unsafeUnwrapErr().type).toBe("invalid_output");

    const hostileRecord = new Proxy(record(), {
      getOwnPropertyDescriptor: () => {
        throw new Error("TOP_SECRET_record");
      },
    });
    const cloned = cloneDurableGrant(hostileRecord as never);
    const summarized = summarizeDurableGrant(hostileRecord as never);
    expect(cloned.isErr()).toBe(true);
    expect(summarized.isErr()).toBe(true);
    expect(cloned._unsafeUnwrapErr().type).toBe("invalid_output");
    expect(summarized._unsafeUnwrapErr().type).toBe("invalid_output");
    // No fabricated empty success objects.
    expect(cloned.isOk()).toBe(false);
    expect(summarized.isOk()).toBe(false);

    const validSummary = summarizeDurableGrant(record());
    expect(validSummary.isOk()).toBe(true);
    expect(Object.isFrozen(validSummary._unsafeUnwrap())).toBe(true);
    expect(Object.keys(validSummary._unsafeUnwrap()).sort()).toEqual([
      "agentName",
      "createdAt",
      "display",
      "grantId",
      "project",
      "scope",
      "state",
      "toolIdentity",
    ]);
  });

  test("hydration rejects accessor traps and incomplete rows without empty objects", () => {
    const row = {
      grant_id: "grant",
      project_identity: "project",
      agent_name: "agent",
      registration_owner: "owner",
      tool_identity: "tool",
      registration_revision: "1",
      policy_fingerprint: "policy",
      request_schema_version: "1",
      request_digest: "digest",
      display_summary: "summary",
      display_details: null,
      created_at: 1,
      expires_at: null,
      revoked_at: null,
      state: "active",
    };
    expect(hydrateDurableGrant(row).isOk()).toBe(true);

    const accessorRow = new Proxy(row, {
      getOwnPropertyDescriptor: (target, prop) => {
        if (typeof prop !== "string" || !(prop in target)) return undefined;
        return {
          enumerable: true,
          configurable: true,
          get: () => {
            throw new Error("TOP_SECRET_accessor");
          },
        };
      },
    });
    const accessorResult = hydrateDurableGrant(accessorRow);
    expect(accessorResult.isErr()).toBe(true);
    expect(accessorResult._unsafeUnwrapErr().type).toBe("invalid_output");
    expect(JSON.stringify(accessorResult._unsafeUnwrapErr())).not.toContain(
      "TOP_SECRET",
    );

    const trapRow = new Proxy(row, {
      getOwnPropertyDescriptor() {
        throw new Error("TOP_SECRET_hydrate");
      },
    });
    const trapped = hydrateDurableGrant(trapRow);
    expect(trapped._unsafeUnwrapErr().type).toBe("invalid_output");
    expect(JSON.stringify(trapped._unsafeUnwrapErr())).not.toContain(
      "TOP_SECRET",
    );

    const incomplete = { ...row } as Record<string, unknown>;
    delete incomplete.request_digest;
    expect(hydrateDurableGrant(incomplete)._unsafeUnwrapErr().type).toBe(
      "invalid_output",
    );

    const badState = { ...row, state: "future" };
    expect(hydrateDurableGrant(badState)._unsafeUnwrapErr().type).toBe(
      "invalid_output",
    );
  });
});

describe("in-memory permission approval repository", () => {
  test("matches the complete identity and returns a sanitized immutable summary", async () => {
    const repo = new InMemoryPermissionApprovalRepository();
    expect((await repo.saveMany([record()])).isOk()).toBe(true);
    const result = await repo.match(identity);
    expect(result._unsafeUnwrap()).toEqual({
      project: "project",
      grantId: "grant",
      agentName: "agent",
      toolIdentity: "tool",
      scope: "durable",
      display: { summary: "summary" },
      createdAt: 1,
      state: "active",
    });
    expect(Object.isFrozen(result._unsafeUnwrap())).toBe(true);
    expect(
      (await repo.match({ ...identity, agentName: "other" }))._unsafeUnwrap(),
    ).toBeUndefined();
  });
  test("isolates projects, expires at the boundary, and revokes idempotently", async () => {
    const repo = new InMemoryPermissionApprovalRepository({}, () => 10);
    await repo.saveMany([
      { ...record(), expiresAt: 10 },
      {
        ...record("other"),
        identity: { ...identity, projectIdentity: "other" },
      },
    ]);
    expect((await repo.list("project"))._unsafeUnwrap()).toHaveLength(1);
    expect((await repo.match(identity, 10))._unsafeUnwrap()).toBeUndefined();
    expect((await repo.revoke("project", "grant")).isOk()).toBe(true);
    expect((await repo.revoke("project", "grant")).isOk()).toBe(true);
    expect(
      (await repo.revoke("project", "missing"))._unsafeUnwrapErr().type,
    ).toBe("unknown_grant");
  });
  test("returns closed errors for hostile validation and preserves the mutation queue", async () => {
    const hostile = new Proxy(record(), {
      getPrototypeOf: () => {
        throw new Error("TOP_SECRET_prototype");
      },
    });
    expect(validateDurableGrantRecordResult(hostile).isErr()).toBe(true);
    expect(
      validateGrantIdentityResult(
        new Proxy(identity, {
          ownKeys: () => {
            throw new Error("TOP_SECRET_keys");
          },
        }),
      )._unsafeUnwrapErr().type,
    ).toBe("invalid_output");
    const repo = new InMemoryPermissionApprovalRepository();
    const rejected = await repo.saveMany([hostile as never]);
    expect(rejected._unsafeUnwrapErr().type).toBe("invalid_output");
    expect(JSON.stringify(rejected._unsafeUnwrapErr())).not.toContain(
      "TOP_SECRET",
    );
    // No partial write and the queue stays usable after hostile rejection.
    expect((await repo.list("project"))._unsafeUnwrap()).toHaveLength(0);
    expect((await repo.saveMany([record()])).isOk()).toBe(true);
    expect((await repo.list("project"))._unsafeUnwrap()).toHaveLength(1);
    expect(
      (
        await repo.match(
          new Proxy(identity, {
            getOwnPropertyDescriptor: () => {
              throw new Error("TOP_SECRET_descriptor");
            },
          }) as never,
        )
      )._unsafeUnwrapErr().type,
    ).toBe("invalid_output");
    // Prior successful write is still matchable after hostile match rejection.
    expect((await repo.match(identity))._unsafeUnwrap()?.grantId).toBe("grant");
  });

  test("rejects empty batches and mixed batches without overwrite", async () => {
    const repo = new InMemoryPermissionApprovalRepository();
    expect((await repo.saveMany([]))._unsafeUnwrapErr().type).toBe(
      "invalid_output",
    );
    expect((await repo.saveMany([record()])).isOk()).toBe(true);
    const mixed = await repo.saveMany([
      record("second"),
      new Proxy(record("third"), {
        getPrototypeOf: () => {
          throw new Error("TOP_SECRET_mixed");
        },
      }) as never,
    ]);
    expect(mixed._unsafeUnwrapErr().type).toBe("invalid_output");
    expect(
      (await repo.list("project"))._unsafeUnwrap().map((x) => x.grantId),
    ).toEqual(["grant"]);
  });

  test("rejects invalid records atomically and supports injected failures", async () => {
    const repo = new InMemoryPermissionApprovalRepository({ save: true });
    expect((await repo.saveMany([record()]))._unsafeUnwrapErr().type).toBe(
      "repository_failure",
    );
    const valid = new InMemoryPermissionApprovalRepository();
    expect(
      (
        await valid.saveMany([
          record(),
          { ...record("bad"), scope: "once" as "durable" },
        ])
      ).isErr(),
    ).toBe(true);
    expect((await valid.list("project"))._unsafeUnwrap()).toHaveLength(0);
  });
});
