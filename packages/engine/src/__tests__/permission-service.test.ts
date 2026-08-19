import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "neverthrow";
import {
  createPermissionService,
  PermissionRegistryBuilder,
} from "../index.js";
import { createInMemoryRuntimeStore } from "../runtime/memory-store.js";
import { createSqliteRuntimeStore } from "../runtime/sqlite/store.js";
import type { RuntimeStore } from "../runtime/store.js";

const policy = {
  read: "ask" as const,
  write: "deny" as const,
  execute: "deny" as const,
  delegate: "deny" as const,
  network: "deny" as const,
};

function registry() {
  const builder = new PermissionRegistryBuilder();
  builder.register({
    toolIdentity: "tool",
    owner: "test",
    revision: "1",
    summary: "test tool",
    resolver: () =>
      ok([
        {
          unresolved: false,
          capability: "read",
          operation: "read",
          target: { kind: "file", identifier: "a" },
          display: { summary: "read a" },
        },
      ]),
  });
  return builder.seal()._unsafeUnwrap();
}

const call = (generation: string) => ({
  project: "project",
  session: "controller",
  agentName: "agent",
  toolIdentity: "tool",
  registryGeneration: generation,
  call: { path: "a" },
  approvalUiAvailable: true,
});

const generation = registry();

async function activate(store: RuntimeStore) {
  const service = createPermissionService(store);
  const result = service.activate({
    project: "project",
    controllerSession: "controller",
    registry: generation,
    policies: { agent: policy },
    requestSchemaVersion: "1",
  });
  return (await result)._unsafeUnwrap();
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    Bun.spawnSync(["rm", "-rf", dir]);
  }
});

describe("PermissionService", () => {
  it("owns repository activation and preserves durable grants across sessions", async () => {
    const store = createInMemoryRuntimeStore();
    const first = await activate(store);
    const pendingOutcome = (
      await first.authorizeCall(call(generation.id))
    )._unsafeUnwrap();
    if (pendingOutcome.kind !== "approval_required") throw new Error("fixture");
    const pending = pendingOutcome;
    const authorized = await first.answerChallenge(
      {
        challenge: pending.challenge,
        project: "project",
        session: "controller",
        agentName: "agent",
        toolIdentity: "tool",
        registryGeneration: generation.id,
      },
      {
        challenge: pending.challenge,
        choices: [
          {
            requestId: pending.requests[0].requestId,
            decision: "allow",
            scope: "durable",
          },
        ],
      },
    );
    expect((await authorized)._unsafeUnwrap().kind).toBe("authorized");

    const second = await activate(store);
    expect(
      (await second.authorizeCall(call(generation.id)))._unsafeUnwrap().kind,
    ).toBe("authorized");
  });

  it("does not expose permission mutation through RuntimeStore", () => {
    const store = createInMemoryRuntimeStore();
    expect("permissions" in store).toBe(false);
  });

  it("snapshots activate input once and never invokes getters or TOCTOU mutations", async () => {
    const store = createInMemoryRuntimeStore();
    const service = createPermissionService(store);

    let projectGets = 0;
    const withGetter = {
      project: "project",
      controllerSession: "controller",
      registry: generation,
      policies: { agent: policy },
      requestSchemaVersion: "1",
    };
    Object.defineProperty(withGetter, "project", {
      enumerable: true,
      configurable: true,
      get: () => {
        projectGets += 1;
        return "project";
      },
    });
    const getterResult = await service.activate(withGetter);
    expect(getterResult.isErr()).toBe(true);
    expect(getterResult._unsafeUnwrapErr().type).toBe("invalid_output");
    expect(projectGets).toBe(0);

    // Descriptor capture never uses [[Get]]: a transparent data-property proxy
    // may pass structural checks, but its get trap must not run.
    let getTrapHits = 0;
    const transparent = new Proxy(
      {
        project: "project",
        controllerSession: "controller",
        registry: generation,
        policies: { agent: policy },
        requestSchemaVersion: "1",
      },
      {
        get() {
          getTrapHits += 1;
          return void 0;
        },
      },
    );
    const transparentResult = await service.activate(transparent);
    expect(transparentResult.isOk()).toBe(true);
    expect(getTrapHits).toBe(0);

    // Hostile reflection traps throw → closed PermissionError; ResultAsync
    // settles as Err and never rejects the promise.
    const hostile = new Proxy(
      {
        project: "project",
        controllerSession: "controller",
        registry: generation,
        policies: { agent: policy },
        requestSchemaVersion: "1",
      },
      {
        ownKeys() {
          throw new Error("ownKeys trap");
        },
        getOwnPropertyDescriptor() {
          throw new Error("descriptor trap");
        },
        get() {
          throw new Error("get trap");
        },
      },
    );
    const settled = await Promise.allSettled([
      Promise.resolve(service.activate(hostile)),
    ]);
    expect(settled[0]?.status).toBe("fulfilled");
    if (settled[0]?.status !== "fulfilled") throw new Error("fixture");
    expect(settled[0].value.isErr()).toBe(true);
    expect(settled[0].value._unsafeUnwrapErr().type).toBe("invalid_output");

    const extra = {
      project: "project",
      controllerSession: "controller",
      registry: generation,
      policies: { agent: policy },
      requestSchemaVersion: "1",
      repository: { forged: true },
    };
    expect((await service.activate(extra)).isErr()).toBe(true);

    const omitted = {
      project: "project",
      controllerSession: "controller",
      registry: generation,
      policies: { agent: policy },
    };
    expect((await service.activate(omitted)).isErr()).toBe(true);

    // One-shot data-descriptor capture: mutating the input object after the
    // snapshot begins cannot change the values the session binds.
    const mutable = {
      project: "project",
      controllerSession: "controller",
      registry: generation,
      policies: { agent: { ...policy } },
      requestSchemaVersion: "1",
    };
    const activate = service.activate(mutable);
    mutable.project = "mutated-project";
    mutable.controllerSession = "mutated-session";
    mutable.requestSchemaVersion = "mutated";
    const session = (await activate)._unsafeUnwrap();
    const outcome = (
      await session.authorizeCall({
        project: "project",
        session: "controller",
        agentName: "agent",
        toolIdentity: "tool",
        registryGeneration: generation.id,
        call: { path: "a" },
        approvalUiAvailable: true,
      })
    )._unsafeUnwrap();
    expect(outcome.kind).toBe("approval_required");
    expect(
      (
        await session.authorizeCall({
          project: "mutated-project",
          session: "mutated-session",
          agentName: "agent",
          toolIdentity: "tool",
          registryGeneration: generation.id,
          call: { path: "a" },
          approvalUiAvailable: true,
        })
      )._unsafeUnwrapErr().type,
    ).toBe("mismatched_session");
  });

  it("retries authorizeCall after lazy sqlite permission repository init recovers", async () => {
    const dir = join(
      tmpdir(),
      `weave-permission-service-${crypto.randomUUID()}`,
    );
    tempDirs.push(dir);
    Bun.spawnSync(["mkdir", "-p", dir]);

    const blockedParent = join(dir, "blocked-parent");
    await Bun.write(blockedParent, "not-a-directory");
    const store = createSqliteRuntimeStore({
      dbPath: join(blockedParent, "runtime", "weave.db"),
    });
    const session = await activate(store);

    const first = session.authorizeCall(call(generation.id));
    const firstSettled = await Promise.allSettled([first]);
    expect(firstSettled[0]?.status).toBe("fulfilled");
    const firstResult = await first;
    expect(firstResult.isErr()).toBe(true);
    expect(firstResult._unsafeUnwrapErr().type).toBe("repository_failure");

    Bun.spawnSync(["rm", "-f", blockedParent]);

    // Ordinary store repo succeeds on the repaired path without a new store.
    expect((await store.instances.list()).isOk()).toBe(true);

    const second = session.authorizeCall(call(generation.id));
    const secondSettled = await Promise.allSettled([second]);
    expect(secondSettled[0]?.status).toBe("fulfilled");
    const outcome = (await second)._unsafeUnwrap();
    expect(outcome.kind).toBe("approval_required");
    if (outcome.kind === "approval_required") {
      expect(outcome.requests[0]).toMatchObject({
        decision: "ask",
        source: "policy",
        reason: "policy_ask_without_grant",
      });
      expect(Object.isFrozen(outcome.requests[0])).toBe(true);
    }

    await store.close();
    expect(
      (await session.authorizeCall(call(generation.id)))._unsafeUnwrapErr()
        .type,
    ).toBe("repository_failure");
  });
});
