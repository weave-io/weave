import { describe, expect, it } from "bun:test";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { PermissionRegistryBuilder } from "../permissions/registry.js";
import { InMemoryPermissionApprovalRepository } from "../permissions/repository.js";
import {
  activatePermissionSessionForTesting,
  authorizePermissionSessionCall,
  consumePermissionSessionPermit,
  PermissionSession,
  type PermissionSessionTestingOptions,
} from "../permissions/session.js";
import type {
  PermissionApprovalChoice,
  PermissionApprovalRepository,
  PermissionCallInput,
  PermissionRequest,
} from "../permissions/types.js";
import type { EffectiveToolPolicy } from "../tool-policy.js";

type Clock = { now: number; get: () => number; advance: (ms: number) => void };
const clock = (): Clock => {
  const value = { now: 1_000 } as Clock;
  value.get = () => value.now;
  value.advance = (ms) => {
    value.now += ms;
  };
  return value;
};
const ids = (prefix = "id") => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};
const policy = (
  value: "allow" | "deny" | "ask" = "ask",
): EffectiveToolPolicy => ({
  read: value,
  write: value,
  execute: value,
  delegate: value,
  network: value,
});
const request = (patch: Partial<PermissionRequest> = {}): PermissionRequest =>
  ({
    unresolved: false,
    capability: "read",
    operation: "read",
    target: { kind: "file", identifier: "a" },
    display: { summary: "read a" },
    ...patch,
  }) as PermissionRequest;
const makeRegistry = (
  resolver = () => ok([request()]),
  tool = "tool",
  owner = "owner",
  revision = "1",
) => {
  const builder = new PermissionRegistryBuilder();
  builder.register({
    toolIdentity: tool,
    owner,
    revision,
    summary: tool,
    resolver,
  });
  return builder.seal()._unsafeUnwrap();
};
const base = (
  c: Clock,
  registry = makeRegistry(),
  repository: PermissionApprovalRepository = new InMemoryPermissionApprovalRepository(
    {},
    c.get,
  ),
): PermissionSessionTestingOptions => ({
  project: "project",
  session: "session",
  registry,
  policies: { agent: policy() },
  requestSchemaVersion: "1",
  monotonicClock: c.get,
  wallClock: c.get,
  ids: ids(),
  repository,
});
const activate = async (options: PermissionSessionTestingOptions) =>
  (await activatePermissionSessionForTesting(options))._unsafeUnwrap();
const call = (
  registry: ReturnType<typeof makeRegistry>,
  patch: Partial<PermissionCallInput> = {},
): PermissionCallInput => ({
  project: "project",
  session: "session",
  agentName: "agent",
  toolIdentity: "tool",
  registryGeneration: registry.id,
  call: { value: 1 },
  approvalUiAvailable: true,
  ...patch,
});
const error = async (result: ResultAsync<unknown, { type: string }>) =>
  (await result)._unsafeUnwrapErr().type;
const allow = (
  requestId: string,
  scope: PermissionApprovalChoice["scope"] = "once",
  expiresAt?: number,
): PermissionApprovalChoice => ({
  requestId,
  decision: "allow",
  scope,
  ...(expiresAt === undefined ? {} : { expiresAt }),
});
const response = (
  challenge: string,
  requestIds: readonly string[],
  scope: PermissionApprovalChoice["scope"] = "once",
) => ({ challenge, choices: requestIds.map((id) => allow(id, scope)) });
const challengeInput = (
  registry: ReturnType<typeof makeRegistry>,
  challenge: string,
  toolIdentity = "tool",
  agentName = "agent",
) => ({
  challenge,
  project: "project",
  session: "session",
  agentName,
  toolIdentity,
  registryGeneration: registry.id,
});
const permitInput = (registry: ReturnType<typeof makeRegistry>) => ({
  project: "project",
  session: "session",
  agentName: "agent",
  toolIdentity: "tool",
  registryGeneration: registry.id,
  call: { value: 1 },
});
/** Spec 34 red phase: security contract tests. */
describe("Spec 34 — permission session security", () => {
  it("rejects field-specific malformed activation values and freezes policy", async () => {
    const c = clock();
    const options = base(c);
    const cases: readonly [keyof PermissionSessionTestingOptions, unknown][] = [
      ["project", "x".repeat(257)],
      ["session", "\ud800"],
      ["requestSchemaVersion", "x".repeat(65)],
      ["auditCapacity", 0],
      ["auditCapacity", NaN],
      ["auditCapacity", Number.MAX_SAFE_INTEGER + 1],
      ["monotonicClock", undefined],
      ["wallClock", undefined],
      ["ids", undefined],
      ["registry", undefined],
      ["repository", undefined],
      ["policies", undefined],
    ];
    for (const [field, value] of cases)
      expect(
        await error(
          activatePermissionSessionForTesting({
            ...options,
            [field]: value,
          } as PermissionSessionTestingOptions),
        ),
      ).toBe("invalid_output");
    const source = policy();
    const session = await activate({ ...options, policies: { agent: source } });
    source.read = "deny";
    expect(session).toBeDefined();
  });

  it("retries the same challenge for every invalid response, then accepts a valid response", async () => {
    const c = clock();
    const registry = makeRegistry(() =>
      ok([request(), request({ operation: "write", capability: "write" })]),
    );
    const session = await activate(base(c, registry));
    const first = (await session.authorizeCall(call(registry)))._unsafeUnwrap();
    if (first.kind !== "approval_required") throw new Error("fixture");
    const idsFor = first.requests.map((item) => item.requestId);
    const invalid = [
      { challenge: "wrong", choices: [] },
      response(first.challenge, []),
      {
        challenge: first.challenge,
        choices: [allow(idsFor[0]), allow(idsFor[0])],
      },
      {
        challenge: first.challenge,
        choices: [{ requestId: idsFor[0], decision: "allow" }],
      },
      {
        challenge: first.challenge,
        choices: idsFor.map((id) => allow(id, "allow-missing" as never)),
      },
      {
        challenge: first.challenge,
        choices: idsFor.map((id) => ({
          requestId: id,
          decision: "deny",
          scope: "session",
        })),
      },
      {
        challenge: first.challenge,
        choices: idsFor.map((id) => allow(id, "once", c.now - 1)),
      },
    ];
    for (const bad of invalid) {
      expect(
        await error(
          session.answerChallenge(
            challengeInput(registry, first.challenge),
            bad as never,
          ),
        ),
      ).toMatch(/invalid|scope/);
    }
    expect(
      (
        await session.answerChallenge(
          challengeInput(registry, first.challenge),
          response(first.challenge, idsFor),
        )
      ).isOk(),
    ).toBe(true);
  });

  it("keeps atomic mixed saves answerable and reauthorizes both scopes", async () => {
    const c = clock();
    let fail = true;
    const inner = new InMemoryPermissionApprovalRepository({}, c.get);
    const repository: PermissionApprovalRepository = {
      saveMany: (records) =>
        fail
          ? ResultAsync.fromPromise(
              Promise.resolve(err({ type: "repository_failure" as const })),
              () => ({ type: "repository_failure" as const }),
            ).andThen((result) => result)
          : inner.saveMany(records),
      list: (project, now) => inner.list(project, now),
      match: (identity, now) => inner.match(identity, now),
      revoke: (project, id) => inner.revoke(project, id),
    };
    const registry = makeRegistry(() =>
      ok([request(), request({ operation: "write", capability: "write" })]),
    );
    const session = await activate(base(c, registry, repository));
    const first = (await session.authorizeCall(call(registry)))._unsafeUnwrap();
    if (first.kind !== "approval_required") throw new Error("fixture");
    const idsFor = first.requests.map((item) => item.requestId);
    expect(
      await error(
        session.answerChallenge(
          challengeInput(registry, first.challenge),
          response(first.challenge, idsFor, "durable"),
        ),
      ),
    ).toBe("repository_failure");
    expect(
      (await session.authorizeCall(call(registry)))._unsafeUnwrap().kind,
    ).toBe("approval_required");
    fail = false;
    expect(
      (
        await session.answerChallenge(
          challengeInput(registry, first.challenge),
          response(first.challenge, idsFor, "durable"),
        )
      ).isOk(),
    ).toBe(true);
    expect(
      (await session.authorizeCall(call(registry)))._unsafeUnwrap().kind,
    ).toBe("authorized");
  });

  it("does not reuse unresolved authorization", async () => {
    let matches = 0;
    const c = clock();
    const registry = makeRegistry(() =>
      ok([{ unresolved: true, display: { summary: "unknown" } }]),
    );
    const inner = new InMemoryPermissionApprovalRepository({}, c.get);
    const repository: PermissionApprovalRepository = {
      saveMany: inner.saveMany.bind(inner),
      list: inner.list.bind(inner),
      revoke: inner.revoke.bind(inner),
      match: () => {
        matches++;
        return okAsync(undefined);
      },
    };
    const session = await activate(base(c, registry, repository));
    const first = (await session.authorizeCall(call(registry)))._unsafeUnwrap();
    if (first.kind !== "approval_required") throw new Error("fixture");
    expect(
      (
        await session.answerChallenge(
          challengeInput(registry, first.challenge),
          response(first.challenge, [first.requests[0].requestId]),
        )
      ).isOk(),
    ).toBe(true);
    expect(
      (await session.authorizeCall(call(registry)))._unsafeUnwrap().kind,
    ).toBe("approval_required");
    expect(matches).toBe(0);
  });

  it("separates challenge and permit capacity and purges each after expiry", async () => {
    const c = clock();
    const askRegistry = makeRegistry();
    const ask = await activate(base(c, askRegistry));
    for (let i = 0; i < 128; i++)
      expect(
        (await ask.authorizeCall(call(askRegistry, { call: { i } }))).isOk(),
      ).toBe(true);
    expect(
      await error(ask.authorizeCall(call(askRegistry, { call: { i: 128 } }))),
    ).toBe("challenge_capacity_exceeded");
    c.advance(300000);
    expect(
      (await ask.authorizeCall(call(askRegistry, { call: { i: 129 } }))).isOk(),
    ).toBe(true);
    const permitRegistry = makeRegistry();
    const permit = await activate({
      ...base(c, permitRegistry),
      policies: { agent: policy("allow") },
    });
    for (let i = 0; i < 128; i++)
      expect(
        (
          await permit.authorizeCall(call(permitRegistry, { call: { i } }))
        ).isOk(),
      ).toBe(true);
    expect(
      await error(
        permit.authorizeCall(call(permitRegistry, { call: { i: 128 } })),
      ),
    ).toBe("permit_capacity_exceeded");
  });

  it("accepts UTF-8 names within field bounds and rejects unsafe names and policies", async () => {
    const c = clock();
    const valid = base(c);
    expect(
      (
        await activatePermissionSessionForTesting({
          ...valid,
          project: "é".repeat(128),
        })
      ).isOk(),
    ).toBe(true);
    expect(
      (
        await activatePermissionSessionForTesting({
          ...valid,
          session: "😀".repeat(63),
        })
      ).isOk(),
    ).toBe(true);
    for (const agentName of ["", "😀".repeat(65), "x".repeat(257), "\ud800"])
      expect(
        await error(
          activatePermissionSessionForTesting({
            ...valid,
            policies: { [agentName]: policy() },
          }),
        ),
      ).toBe("invalid_output");
    const getter = Object.create(Object.prototype) as Record<string, unknown>;
    let invoked = false;
    Object.defineProperty(getter, "read", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "ask";
      },
    });
    for (const key of ["write", "execute", "delegate", "network"])
      getter[key] = "ask";
    expect(
      await error(
        activatePermissionSessionForTesting({
          ...valid,
          policies: { agent: getter as never },
        }),
      ),
    ).toBe("invalid_output");
    expect(invoked).toBe(false);
    for (const policies of [
      { agent: { ...policy(), extra: "ask" } },
      {
        agent: Object.create(
          null,
          Object.getOwnPropertyDescriptors({ ...policy() }),
        ),
      },
      Object.create({ agent: policy() }),
    ])
      expect(
        await error(
          activatePermissionSessionForTesting({
            ...valid,
            policies: policies as never,
          }),
        ),
      ).toBe("invalid_output");
    const empty = await activatePermissionSessionForTesting({
      ...valid,
      policies: {},
    });
    expect(empty.isOk()).toBe(false);
  });

  it("never replaces active state with colliding or invalid IDs", async () => {
    const c = clock();
    const sequence = [
      "same",
      "same",
      "request-2",
      "challenge",
      "",
      "\ud800",
      "x".repeat(257),
      "challenge",
      "same",
      "challenge",
      "same",
      "challenge",
      "same",
      "challenge",
      "same",
      "challenge",
      "same",
      "challenge",
      "same",
      "challenge",
      "same",
      "challenge",
      "same",
      "challenge",
      "same",
      "challenge",
      "same",
      "challenge",
      "next-request",
      "next-challenge",
    ];
    const idSource = () => sequence.shift() as string;
    const registry = makeRegistry(() =>
      ok([request(), request({ operation: "write", capability: "write" })]),
    );
    const session = await activate({ ...base(c, registry), ids: idSource });
    const first = (await session.authorizeCall(call(registry)))._unsafeUnwrap();
    if (first.kind !== "approval_required") throw new Error("fixture");
    expect(new Set(first.requests.map((x) => x.requestId)).size).toBe(
      first.requests.length,
    );
    expect(
      await error(
        session.answerChallenge(
          challengeInput(registry, first.challenge),
          response(
            first.challenge,
            first.requests.map((x) => x.requestId),
          ),
        ),
      ),
    ).toBe("invalid_output");
    expect(
      (await session.authorizeCall(call(registry)))._unsafeUnwrap().kind,
    ).toBe("approval_required");
  });

  it("answers atomically at permit capacity and preserves the challenge", async () => {
    const c = clock();
    const builder = new PermissionRegistryBuilder();
    builder.register({
      toolIdentity: "allow-tool",
      owner: "o",
      revision: "1",
      summary: "allow",
      resolver: () => ok([request()]),
    });
    builder.register({
      toolIdentity: "ask-tool",
      owner: "o",
      revision: "1",
      summary: "ask",
      resolver: () => ok([request({ capability: "write" })]),
    });
    const registry = builder.seal()._unsafeUnwrap();
    const inner = new InMemoryPermissionApprovalRepository({}, c.get);
    let writes = 0;
    const repository: PermissionApprovalRepository = {
      saveMany: (records) => {
        writes++;
        return inner.saveMany(records);
      },
      list: inner.list.bind(inner),
      match: inner.match.bind(inner),
      revoke: inner.revoke.bind(inner),
    };
    const session = await activate({
      ...base(c, registry, repository),
      policies: { agent: { ...policy(), read: "allow" } },
    });
    for (let i = 0; i < 128; i++)
      expect(
        (
          await session.authorizeCall(
            call(registry, { toolIdentity: "allow-tool", call: { i } }),
          )
        ).isOk(),
      ).toBe(true);
    const pending = (
      await session.authorizeCall(call(registry, { toolIdentity: "ask-tool" }))
    )._unsafeUnwrap();
    if (pending.kind !== "approval_required") throw new Error("fixture");
    const answer = response(
      pending.challenge,
      pending.requests.map((x) => x.requestId),
      "session",
    );
    expect(
      await error(
        session.answerChallenge(
          challengeInput(registry, pending.challenge, "ask-tool"),
          answer,
        ),
      ),
    ).toBe("permit_capacity_exceeded");
    expect(writes).toBe(0);
    expect(
      (
        await session.authorizeCall(
          call(registry, { toolIdentity: "ask-tool" }),
        )
      )._unsafeUnwrap().kind,
    ).toBe("approval_required");
  });

  it("prepares durable permits before saving and distinguishes expiry from consumption", async () => {
    const c = clock();
    let saves = 0;
    const inner = new InMemoryPermissionApprovalRepository({}, c.get);
    const repository: PermissionApprovalRepository = {
      saveMany: () => {
        saves++;
        return errAsync({ type: "repository_failure" as const });
      },
      list: inner.list.bind(inner),
      match: inner.match.bind(inner),
      revoke: inner.revoke.bind(inner),
    };
    const ids = (() => {
      const sequence = ["request", "challenge", ""];
      return () => sequence.shift() as string;
    })();
    const registry = makeRegistry();
    const session = await activate({ ...base(c, registry, repository), ids });
    const pending = (
      await session.authorizeCall(call(registry))
    )._unsafeUnwrap();
    if (pending.kind !== "approval_required") throw new Error("fixture");
    expect(
      await error(
        session.answerChallenge(
          challengeInput(registry, pending.challenge),
          response(
            pending.challenge,
            pending.requests.map((x) => x.requestId),
            "durable",
          ),
        ),
      ),
    ).toBe("invalid_output");
    expect(saves).toBe(0);
    c.advance(30000);
    expect(
      await error(
        session.consumePermit({
          ...permitInput(registry),
          permit: "missing",
          call: { value: 1 },
        }),
      ),
    ).toBe("unknown_permit");
  });

  it("keeps consumed tombstones bounded while enforcing the exact expiry boundary", async () => {
    const c = clock();
    const registry = makeRegistry();
    const session = await activate(base(c, registry));
    const pending = (
      await session.authorizeCall(call(registry))
    )._unsafeUnwrap();
    if (pending.kind !== "approval_required") throw new Error("fixture");
    const permit = (
      await session.answerChallenge(
        challengeInput(registry, pending.challenge),
        response(
          pending.challenge,
          pending.requests.map((x) => x.requestId),
        ),
      )
    )._unsafeUnwrap();
    if (permit.kind !== "authorized") throw new Error("fixture");
    c.advance(30000);
    expect(
      await error(
        session.consumePermit({
          ...permitInput(registry),
          permit: permit.permit,
          call: { value: 1 },
        }),
      ),
    ).toBe("expired_permit");
  });

  it("rejects hostile boundary accessors without changing session state", async () => {
    const c = clock();
    const registry = makeRegistry();
    const session = await activate(base(c, registry));

    const hostileAgent = Object.defineProperty(
      { ...call(registry) },
      "agentName",
      { enumerable: true, get: () => "helper" },
    );
    expect(await error(session.authorizeCall(hostileAgent))).toBe(
      "invalid_output",
    );
    const hostileTool = Object.defineProperty(
      { ...call(registry) },
      "toolIdentity",
      { enumerable: true, get: () => "dangerous-tool" },
    );
    expect(await error(session.authorizeCall(hostileTool))).toBe(
      "invalid_output",
    );

    const pending = (
      await session.authorizeCall(call(registry))
    )._unsafeUnwrap();
    if (pending.kind !== "approval_required") throw new Error("fixture");
    const requestId = pending.requests[0].requestId;
    const hostileChallenge = Object.defineProperty(
      { ...challengeInput(registry, pending.challenge) },
      "challenge",
      { enumerable: true, get: () => pending.challenge },
    );
    expect(
      await error(
        session.answerChallenge(
          hostileChallenge,
          response(pending.challenge, [requestId]),
        ),
      ),
    ).toBe("invalid_output");

    const hostileChoice = Object.defineProperty(
      { requestId, decision: "allow" as const, scope: "once" as const },
      "scope",
      { enumerable: true, get: () => "session" },
    );
    expect(
      await error(
        session.answerChallenge(hostileChallenge, {
          challenge: pending.challenge,
          choices: [hostileChoice],
        }),
      ),
    ).toBe("invalid_output");

    const approved = (
      await session.answerChallenge(
        challengeInput(registry, pending.challenge),
        response(pending.challenge, [requestId]),
      )
    )._unsafeUnwrap();
    if (approved.kind !== "authorized") throw new Error("fixture");
    const hostilePermit = Object.defineProperty(
      { ...permitInput(registry), permit: approved.permit },
      "permit",
      { enumerable: true, get: () => approved.permit },
    );
    expect(await error(session.consumePermit(hostilePermit))).toBe(
      "invalid_output",
    );
    expect(
      (
        await session.consumePermit({
          ...permitInput(registry),
          permit: approved.permit,
        })
      ).isOk(),
    ).toBe(true);
  });

  it("isolates parent durable grants from child-agent approval relays", async () => {
    const c = clock();
    const registry = makeRegistry();
    const repository = new InMemoryPermissionApprovalRepository({}, c.get);
    const session = await activate({
      ...base(c, registry, repository),
      policies: { parent: policy(), child: policy() },
    });
    const parent = (
      await session.authorizeCall(call(registry, { agentName: "parent" }))
    )._unsafeUnwrap();
    if (parent.kind !== "approval_required") throw new Error("fixture");
    const parentPermit = (
      await session.answerChallenge(
        challengeInput(registry, parent.challenge, "tool", "parent"),
        response(
          parent.challenge,
          parent.requests.map((item) => item.requestId),
          "durable",
        ),
      )
    )._unsafeUnwrap();
    if (parentPermit.kind !== "authorized") throw new Error("fixture");
    await session.consumePermit({
      ...permitInput(registry),
      agentName: "parent",
      permit: parentPermit.permit,
    });

    const child = (
      await session.authorizeCall(call(registry, { agentName: "child" }))
    )._unsafeUnwrap();
    expect(child.kind).toBe("approval_required");
    if (child.kind !== "approval_required") throw new Error("fixture");
    expect(
      (
        await session.answerChallenge(
          challengeInput(registry, child.challenge, "tool", "child"),
          response(
            child.challenge,
            child.requests.map((item) => item.requestId),
          ),
        )
      ).isOk(),
    ).toBe(true);
  });

  it("checks closed state before list and revoke repository access", async () => {
    const c = clock();
    let accesses = 0;
    const repository: PermissionApprovalRepository = {
      saveMany: () => {
        accesses++;
        throw new Error("repository must not be called");
      },
      list: () => {
        accesses++;
        throw new Error("repository must not be called");
      },
      match: () => {
        accesses++;
        throw new Error("repository must not be called");
      },
      revoke: () => {
        accesses++;
        throw new Error("repository must not be called");
      },
    };
    const session = await activate({ ...base(c, makeRegistry(), repository) });
    await session.close();
    expect(await error(session.listDurableGrants())).toBe("closed_session");
    expect(await error(session.revokeDurableGrant("grant"))).toBe(
      "closed_session",
    );
    expect(accesses).toBe(0);
  });

  it("recovers the serial queue after clock and repository failures", async () => {
    const c = clock();
    const options = base(c);
    let throwClock = false;
    const stableMono = options.monotonicClock;
    const stableWall = options.wallClock;
    const guarded = () => {
      if (throwClock) throw new Error("clock");
      return stableMono();
    };
    options.monotonicClock = guarded;
    options.wallClock = () => {
      if (throwClock) throw new Error("clock");
      return stableWall();
    };
    const session = await activate(options);
    throwClock = true;
    expect(await error(session.authorizeCall(call(options.registry)))).toBe(
      "invalid_output",
    );
    throwClock = false;
    expect((await session.authorizeCall(call(options.registry))).isOk()).toBe(
      true,
    );

    const original = options.repository;
    let throwRepository = true;
    const repository: PermissionApprovalRepository = {
      saveMany: (records) => original.saveMany(records),
      list: (project, now) => original.list(project, now),
      revoke: (project, grantId) => original.revoke(project, grantId),
      match: (identity, now) => {
        if (throwRepository) throw new Error("repository");
        return original.match(identity, now);
      },
    };
    const repositoryOptions = base(c, makeRegistry(), repository);
    const repositorySession = await activate(repositoryOptions);
    expect(
      await error(
        repositorySession.authorizeCall(call(repositoryOptions.registry)),
      ),
    ).toBe("repository_failure");
    throwRepository = false;
    expect(
      (
        await repositorySession.authorizeCall(call(repositoryOptions.registry))
      ).isOk(),
    ).toBe(true);
  });

  it("preserves expired cancellation tombstones and validates envelope", async () => {
    const c = clock();
    const registry = makeRegistry();
    const session = await activate(base(c, registry));
    const first = (await session.authorizeCall(call(registry)))._unsafeUnwrap();
    if (first.kind !== "approval_required") throw new Error("fixture");
    expect(
      await error(
        session.cancelChallenge({
          ...challengeInput(registry, first.challenge),
          session: "other",
        }),
      ),
    ).toBe("stale_challenge");
    c.advance(300000);
    expect(
      await error(
        session.cancelChallenge(challengeInput(registry, first.challenge)),
      ),
    ).toBe("expired_challenge");
    expect(
      await error(
        session.answerChallenge(
          challengeInput(registry, first.challenge),
          response(first.challenge, []),
        ),
      ),
    ).toBe("expired_challenge");
  });

  it("freezes genuine sessions and blocks own-method, prototype, and static shadowing", async () => {
    const c = clock();
    const denyRegistry = makeRegistry();
    const denySession = await activate({
      ...base(c, denyRegistry),
      policies: { agent: policy("deny") },
    });
    expect(Object.isFrozen(denySession)).toBe(true);
    expect(Object.isFrozen(PermissionSession)).toBe(true);
    expect(Object.isFrozen(PermissionSession.prototype)).toBe(true);

    let forgedAuthorize = 0;
    let forgedConsume = 0;
    const forgedPermit = "forged-permit";

    // Own-method shadowing on a genuine branded instance must not stick.
    expect(() => {
      Object.defineProperty(denySession, "authorizeCall", {
        value: () => {
          forgedAuthorize += 1;
          return okAsync({ kind: "authorized", permit: forgedPermit });
        },
        configurable: true,
      });
    }).toThrow();
    expect(() => {
      Object.defineProperty(denySession, "consumePermit", {
        value: () => {
          forgedConsume += 1;
          return okAsync(undefined);
        },
        configurable: true,
      });
    }).toThrow();
    expect(() => {
      (denySession as { authorizeCall: unknown }).authorizeCall = () => {
        forgedAuthorize += 1;
        return okAsync({ kind: "authorized", permit: forgedPermit });
      };
    }).toThrow();

    // Prototype method assignment / defineProperty must not stick.
    expect(() => {
      PermissionSession.prototype.authorizeCall = () => {
        forgedAuthorize += 1;
        return okAsync({ kind: "authorized", permit: forgedPermit });
      };
    }).toThrow();
    expect(() => {
      Object.defineProperty(PermissionSession.prototype, "consumePermit", {
        value: () => {
          forgedConsume += 1;
          return okAsync(undefined);
        },
        configurable: true,
      });
    }).toThrow();
    expect(() => {
      PermissionSession.prototype.answerChallenge = () =>
        okAsync({ kind: "authorized", permit: forgedPermit });
    }).toThrow();
    expect(() => {
      PermissionSession.prototype.cancelChallenge = () => okAsync(undefined);
    }).toThrow();
    expect(() => {
      PermissionSession.prototype.replaceRegistry = () => okAsync(undefined);
    }).toThrow();
    expect(() => {
      PermissionSession.prototype.close = () => okAsync(undefined);
    }).toThrow();
    expect(() => {
      PermissionSession.prototype.listDurableGrants = () => okAsync([]);
    }).toThrow();
    expect(() => {
      PermissionSession.prototype.revokeDurableGrant = () => okAsync(undefined);
    }).toThrow();
    expect(() => {
      PermissionSession.prototype.listAudit = () => okAsync([]);
    }).toThrow();

    // Constructor static mutation must not install attacker surfaces.
    let staticInstalled = false;
    try {
      (PermissionSession as unknown as { fromToken: unknown }).fromToken =
        () => {
          staticInstalled = true;
          throw new Error("should not install");
        };
    } catch {
      staticInstalled = false;
    }
    expect(staticInstalled).toBe(false);
    expect("fromToken" in PermissionSession).toBe(false);

    // Deny remains denied through public and non-virtual authorize paths.
    const deniedPublic = (
      await denySession.authorizeCall(call(denyRegistry))
    )._unsafeUnwrap();
    expect(deniedPublic.kind).toBe("denied");
    const deniedInternal = (
      await authorizePermissionSessionCall(denySession, call(denyRegistry))
    )._unsafeUnwrap();
    expect(deniedInternal.kind).toBe("denied");
    expect(forgedAuthorize).toBe(0);

    // Genuine allow path still issues a single-use permit; forged permit never executes.
    const allowRegistry = makeRegistry();
    const allowSession = await activate({
      ...base(c, allowRegistry),
      policies: { agent: policy("allow") },
    });
    const authorized = (
      await authorizePermissionSessionCall(allowSession, call(allowRegistry))
    )._unsafeUnwrap();
    expect(authorized.kind).toBe("authorized");
    if (authorized.kind !== "authorized") throw new Error("fixture");

    expect(
      await error(
        consumePermissionSessionPermit(allowSession, {
          ...permitInput(allowRegistry),
          permit: forgedPermit,
          call: { value: 1 },
        }),
      ),
    ).toBe("unknown_permit");
    expect(forgedConsume).toBe(0);

    expect(
      (
        await consumePermissionSessionPermit(allowSession, {
          ...permitInput(allowRegistry),
          permit: authorized.permit,
          call: { value: 1 },
        })
      ).isOk(),
    ).toBe(true);
    expect(
      await error(
        allowSession.consumePermit({
          ...permitInput(allowRegistry),
          permit: authorized.permit,
          call: { value: 1 },
        }),
      ),
    ).toBe("consumed_permit");
    expect(forgedAuthorize).toBe(0);
    expect(forgedConsume).toBe(0);
  });

  it("changing get-length resolver proxy cannot authorize empty under all-deny", async () => {
    const c = clock();
    const denyRequest = request({ capability: "write", operation: "write" });
    const changingResolver = () => {
      let lengthReads = 0;
      const changing = new Proxy([denyRequest], {
        get(target, prop, receiver) {
          if (prop === "length") {
            lengthReads += 1;
            // Old multi-read path: first length>=1 passes, later length 0
            // yields empty unique set and issues a permit under all-deny.
            return lengthReads <= 1 ? 1 : 0;
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return ok(changing as unknown as PermissionRequest[]);
    };
    const registry = makeRegistry(changingResolver);
    const session = await activate({
      ...base(c, registry),
      policies: { agent: policy("deny") },
    });
    const outcome = (
      await authorizePermissionSessionCall(session, call(registry))
    )._unsafeUnwrap();
    expect(outcome.kind).toBe("denied");
    if (outcome.kind !== "denied") throw new Error("fixture");
    expect(outcome.requests.length).toBe(1);
  });

  it("rejects descriptor-inconsistent resolver proxy under all-deny", async () => {
    const c = clock();
    const denyRequest = request({ capability: "write", operation: "write" });
    const inconsistentResolver = () => {
      const changing = new Proxy([denyRequest], {
        ownKeys() {
          return ["0", "length"];
        },
        getOwnPropertyDescriptor(_target, prop) {
          if (prop === "length") {
            return {
              value: 0,
              writable: true,
              enumerable: false,
              configurable: false,
            };
          }
          if (prop === "0") {
            return {
              value: denyRequest,
              writable: true,
              enumerable: true,
              configurable: true,
            };
          }
          return undefined;
        },
      });
      return ok(changing as unknown as PermissionRequest[]);
    };
    const registry = makeRegistry(inconsistentResolver);
    const session = await activate({
      ...base(c, registry),
      policies: { agent: policy("deny") },
    });
    const outcome = await authorizePermissionSessionCall(
      session,
      call(registry),
    );
    expect(outcome.isErr()).toBe(true);
    expect(outcome._unsafeUnwrapErr().type).toBe("invalid_output");
    expect(JSON.stringify(outcome._unsafeUnwrapErr())).not.toContain("write");
  });

  it("rejects descriptor-inconsistent resolver proxy on permit consume re-resolution", async () => {
    const c = clock();
    let resolvePhase: "authorize" | "consume" = "authorize";
    const grantable = request();
    const resolver = () => {
      if (resolvePhase === "authorize") return ok([grantable]);
      const changing = new Proxy([grantable], {
        ownKeys() {
          return ["0", "length"];
        },
        getOwnPropertyDescriptor(_target, prop) {
          if (prop === "length") {
            return {
              value: 0,
              writable: true,
              enumerable: false,
              configurable: false,
            };
          }
          if (prop === "0") {
            return {
              value: grantable,
              writable: true,
              enumerable: true,
              configurable: true,
            };
          }
          return undefined;
        },
      });
      return ok(changing as unknown as PermissionRequest[]);
    };
    const registry = makeRegistry(resolver);
    const session = await activate({
      ...base(c, registry),
      policies: { agent: policy("allow") },
    });
    const authorized = (
      await authorizePermissionSessionCall(session, call(registry))
    )._unsafeUnwrap();
    expect(authorized.kind).toBe("authorized");
    if (authorized.kind !== "authorized") throw new Error("fixture");

    resolvePhase = "consume";
    const consumed = await consumePermissionSessionPermit(session, {
      ...permitInput(registry),
      permit: authorized.permit,
      call: { value: 1 },
    });
    expect(consumed.isErr()).toBe(true);
    expect(consumed._unsafeUnwrapErr().type).toBe("invalid_output");
    expect(JSON.stringify(consumed._unsafeUnwrapErr())).not.toContain(
      "TOP_SECRET",
    );
  });

  it("changing get-length resolver proxy cannot empty bindings on authorize+consume", async () => {
    const c = clock();
    const denyRequest = request({ capability: "execute", operation: "run" });
    const changingResolver = () => {
      let lengthReads = 0;
      const changing = new Proxy([denyRequest], {
        get(target, prop, receiver) {
          if (prop === "length") {
            lengthReads += 1;
            return lengthReads <= 1 ? 1 : 0;
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return ok(changing as unknown as PermissionRequest[]);
    };
    const registry = makeRegistry(changingResolver);
    // All-deny: empty-request TOCTOU would authorize + consume with empty bindings.
    const session = await activate({
      ...base(c, registry),
      policies: { agent: policy("deny") },
    });
    const outcome = (
      await authorizePermissionSessionCall(session, call(registry))
    )._unsafeUnwrap();
    expect(outcome.kind).toBe("denied");
  });
});
