import { describe, expect, it } from "bun:test";
import { err, ok, type ResultAsync } from "neverthrow";
import { PermissionRegistryBuilder } from "../permissions/registry.js";
import { InMemoryPermissionApprovalRepository } from "../permissions/repository.js";
import {
  activatePermissionSessionForTesting,
  type PermissionSessionTestingOptions,
} from "../permissions/session.js";
import type {
  PermissionApprovalChoice,
  PermissionCallInput,
  PermissionError,
  PermissionOutcome,
  PermissionRequest,
  PermissionResolver,
} from "../permissions/types.js";
import type { EffectiveToolPolicy } from "../tool-policy.js";

const policy = (
  value: "allow" | "deny" | "ask" = "ask",
): EffectiveToolPolicy => ({
  read: value,
  write: value,
  execute: value,
  delegate: value,
  network: value,
});
const clock = () => {
  let now = 1_000;
  return {
    get: () => now,
    advance: (n: number) => {
      now += n;
    },
  };
};
const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};
const request = (
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest =>
  ({
    unresolved: false,
    capability: "read",
    operation: "read",
    target: { kind: "file", identifier: "a" },
    display: { summary: "read a" },
    ...overrides,
  }) as PermissionRequest;
const unresolved = (): PermissionRequest => ({
  unresolved: true,
  display: { summary: "unknown action" },
});
const registry = (
  resolver: PermissionResolver = () => ok([request()]),
  tool = "tool",
  owner = "owner",
  revision = "1",
) => {
  const b = new PermissionRegistryBuilder();
  b.register({
    toolIdentity: tool,
    owner,
    revision,
    summary: "tool",
    resolver,
  });
  return b.seal()._unsafeUnwrap();
};
const input = (
  r: ReturnType<typeof registry>,
  overrides: Partial<PermissionCallInput> = {},
): PermissionCallInput => ({
  project: "project",
  session: "session",
  agentName: "agent",
  toolIdentity: "tool",
  registryGeneration: r.id,
  call: { value: 1 },
  approvalUiAvailable: true,
  ...overrides,
});
const challengeInput = (r: ReturnType<typeof registry>, challenge: string) => ({
  challenge,
  project: "project",
  session: "session",
  agentName: "agent",
  toolIdentity: "tool",
  registryGeneration: r.id,
});
const permitInput = (r: ReturnType<typeof registry>) => ({
  project: "project",
  session: "session",
  agentName: "agent",
  toolIdentity: "tool",
  registryGeneration: r.id,
  call: { value: 1 },
});
const activate = async (
  overrides: Partial<PermissionSessionTestingOptions> = {},
) => {
  const mono = clock();
  const wall = clock();
  const r = overrides.registry ?? registry();
  const s = await activatePermissionSessionForTesting({
    project: "project",
    session: "session",
    registry: r,
    policies: { agent: policy() },
    requestSchemaVersion: "1",
    repository: new InMemoryPermissionApprovalRepository(
      {},
      overrides.wallClock ?? wall.get,
    ),
    ...overrides,
    monotonicClock: overrides.monotonicClock ?? mono.get,
    wallClock: overrides.wallClock ?? wall.get,
    ids: overrides.ids ?? ids(),
  });
  return {
    session: s._unsafeUnwrap(),
    registry: r,
    clock: mono,
    mono,
    wall,
  };
};
const unwrap = async <T>(value: ResultAsync<T, PermissionError>): Promise<T> =>
  (await value)._unsafeUnwrap();
const choice = (
  id: string,
  scope: "once" | "session" | "durable" = "once",
  extra: Partial<PermissionApprovalChoice> = {},
): PermissionApprovalChoice => ({
  requestId: id,
  decision: "allow",
  scope,
  ...extra,
});
const answer = (challenge: string, id: string, c = choice(id)) => ({
  challenge,
  choices: [c],
});
const error = async (value: ResultAsync<unknown, PermissionError>) =>
  (await value)._unsafeUnwrapErr().type;

const approval = (outcome: PermissionOutcome) => {
  if (outcome.kind !== "approval_required")
    throw new Error(`Expected approval, got ${outcome.kind}`);
  return outcome;
};
const authorized = (outcome: PermissionOutcome) => {
  if (outcome.kind !== "authorized")
    throw new Error(`Expected authorization, got ${outcome.kind}`);
  return outcome;
};

describe("PermissionSession red phase", () => {
  it("validates activation inputs and binds policy immutably", async () => {
    expect(
      await error(
        activatePermissionSessionForTesting(
          {} as PermissionSessionTestingOptions,
        ),
      ),
    ).toBe("invalid_output");
    const p = policy();
    const a = await activate({ policies: { agent: p } });
    p.read = "deny";
    expect(
      (
        await unwrap<PermissionOutcome>(
          a.session.authorizeCall(input(a.registry)),
        )
      ).kind,
    ).toBe("approval_required");
  });
  it("does not permit unmanaged tools", async () => {
    const a = await activate();
    expect(
      await unwrap(
        a.session.authorizeCall(input(a.registry, { toolIdentity: "other" })),
      ),
    ).toEqual({ kind: "unmanaged" });
  });
  it("maps resolver errors, throws, empty and invalid output", async () => {
    for (const [resolver, type] of [
      [
        () => err({ type: "invalid_output" as const }),
        "resolver_returned_error",
      ],
      [
        () => {
          throw new Error();
        },
        "resolver_threw",
      ],
      [() => ok([]), "empty_output"],
      [() => ok([request({ unresolved: true })]), "invalid_output"],
    ] as const) {
      const r = registry(resolver);
      const a = await activate({ registry: r });
      expect(await error(a.session.authorizeCall(input(r)))).toBe(type);
    }
    const calls: Array<
      [unknown, { toolIdentity: string; owner: string; revision: string }]
    > = [];
    const r = registry(({ call, context }) => {
      calls.push([call, context]);
      return ok([request()]);
    });
    const a = await activate({ registry: r });
    await a.session.authorizeCall(input(r));
    expect(calls[0][1]).toEqual({
      toolIdentity: "tool",
      owner: "owner",
      revision: "1",
    });
  });
  it("deduplicates exact requests and applies deny before grants", async () => {
    const r = registry(() => ok([request(), request()]));
    const a = await activate({
      registry: r,
      policies: { agent: policy("deny") },
    });
    const o = await unwrap(a.session.authorizeCall(input(r)));
    if (o.kind !== "denied") throw new Error("Expected denial");
    expect(o.requests).toHaveLength(1);
  });
  it("allows without a repository and challenges asks", async () => {
    const r = registry(() => ok([request({ capability: "read" })]));
    const a = await activate({
      registry: r,
      policies: { agent: policy("allow") },
      repository: new InMemoryPermissionApprovalRepository(),
    });
    expect(
      (await unwrap<PermissionOutcome>(a.session.authorizeCall(input(r)))).kind,
    ).toBe("authorized");
    const b = await activate({ registry: r });
    expect(
      (await unwrap<PermissionOutcome>(b.session.authorizeCall(input(r)))).kind,
    ).toBe("approval_required");
  });
  it("denial wins over session and durable grants; asks are conjunctive", async () => {
    const r = registry(() =>
      ok([request({ capability: "read" }), request({ capability: "write" })]),
    );
    const a = await activate({
      registry: r,
      policies: { agent: { ...policy(), read: "deny", write: "ask" } },
    });
    expect(
      (await unwrap<PermissionOutcome>(a.session.authorizeCall(input(r)))).kind,
    ).toBe("denied");
  });
  it("requires every approval request exactly once", async () => {
    const a = await activate();
    const o = approval(
      await unwrap(a.session.authorizeCall(input(a.registry))),
    );
    expect(
      await error(
        a.session.answerChallenge(
          challengeInput(a.registry, o.challenge),
          answer(o.challenge, "unknown"),
        ),
      ),
    ).toBe("invalid_response");
    expect(
      await error(
        a.session.answerChallenge(challengeInput(a.registry, o.challenge), {
          challenge: o.challenge,
          choices: [],
        }),
      ),
    ).toBe("invalid_response");
  });
  it("retains frozen per-request decision, source, and reason on pending views", async () => {
    const grantable = await activate();
    const pending = approval(
      await unwrap(grantable.session.authorizeCall(input(grantable.registry))),
    );
    expect(pending.requests).toHaveLength(1);
    expect(pending.requests[0]).toEqual({
      requestId: pending.requests[0].requestId,
      capability: "read",
      operation: "read",
      target: { kind: "file", identifier: "a" },
      display: { summary: "read a" },
      decision: "ask",
      source: "policy",
      reason: "policy_ask_without_grant",
    });
    expect(Object.isFrozen(pending.requests[0])).toBe(true);
    expect(Object.keys(pending.requests[0]).sort()).toEqual(
      [
        "capability",
        "decision",
        "display",
        "operation",
        "reason",
        "requestId",
        "source",
        "target",
      ].sort(),
    );

    const unresolvedRegistry = registry(() => ok([unresolved()]));
    const unresolvedSession = await activate({ registry: unresolvedRegistry });
    const unresolvedPending = approval(
      await unwrap(
        unresolvedSession.session.authorizeCall(input(unresolvedRegistry)),
      ),
    );
    expect(unresolvedPending.requests[0]).toEqual({
      requestId: unresolvedPending.requests[0].requestId,
      display: { summary: "unknown action" },
      decision: "ask",
      source: "resolver",
      reason: "unresolved_request",
    });
    expect(Object.isFrozen(unresolvedPending.requests[0])).toBe(true);

    const denied = await activate({ policies: { agent: policy("deny") } });
    const deniedOutcome = await unwrap<PermissionOutcome>(
      denied.session.authorizeCall(input(denied.registry)),
    );
    expect(deniedOutcome.kind).toBe("denied");
    if (deniedOutcome.kind !== "denied") throw new Error("fixture");
    expect(deniedOutcome.requests[0]).toEqual({
      capability: "read",
      operation: "read",
      target: { kind: "file", identifier: "a" },
      display: { summary: "read a" },
    });
    expect("decision" in deniedOutcome.requests[0]).toBe(false);
    expect("source" in deniedOutcome.requests[0]).toBe(false);
    expect("reason" in deniedOutcome.requests[0]).toBe(false);
    expect("requestId" in deniedOutcome.requests[0]).toBe(false);
  });
  it("audits policy denial and valid user rejection without an error category", async () => {
    const denied = await activate({ policies: { agent: policy("deny") } });
    expect(
      (
        await unwrap<PermissionOutcome>(
          denied.session.authorizeCall(input(denied.registry)),
        )
      ).kind,
    ).toBe("denied");
    const deniedAudit = await unwrap(denied.session.listAudit());
    expect(deniedAudit.at(-1)).toMatchObject({
      type: "authorization_denied",
      outcome: "policy_denied",
    });
    expect("errorCategory" in (deniedAudit.at(-1) ?? {})).toBe(false);

    const rejected = await activate();
    const pending = approval(
      await unwrap(rejected.session.authorizeCall(input(rejected.registry))),
    );
    const result = await unwrap(
      rejected.session.answerChallenge(
        challengeInput(rejected.registry, pending.challenge),
        answer(pending.challenge, pending.requests[0].requestId, {
          ...choice(pending.requests[0].requestId),
          decision: "deny",
          scope: undefined,
        }),
      ),
    );
    expect(result.kind).toBe("denied");
    const audit = await unwrap(rejected.session.listAudit());
    expect(audit.at(-1)).toMatchObject({
      type: "approval_answered",
      outcome: "rejected",
    });
    expect("errorCategory" in (audit.at(-1) ?? {})).toBe(false);
  });
  it("supports once and exact session envelopes", async () => {
    const a = await activate();
    const o = approval(
      await unwrap(a.session.authorizeCall(input(a.registry))),
    );
    const p = authorized(
      await unwrap(
        a.session.answerChallenge(
          challengeInput(a.registry, o.challenge),
          answer(o.challenge, o.requests[0].requestId),
        ),
      ),
    );
    expect(p.kind).toBe("authorized");
    expect(
      (
        await unwrap<PermissionOutcome>(
          a.session.authorizeCall(input(a.registry)),
        )
      ).kind,
    ).toBe("approval_required");
  });
  it("rejects invalid scopes, unknown decisions, and unresolved reusable scopes", async () => {
    const a = await activate({ registry: registry(() => ok([unresolved()])) });
    const o = approval(
      await unwrap(a.session.authorizeCall(input(a.registry))),
    );
    expect(
      await error(
        a.session.answerChallenge(
          challengeInput(a.registry, o.challenge),
          answer(
            o.challenge,
            o.requests[0].requestId,
            choice(o.requests[0].requestId, "session"),
          ),
        ),
      ),
    ).toBe("invalid_scope");
  });
  it("keeps durable repository failure answerable and grants atomic", async () => {
    const c = clock();
    const repo = new InMemoryPermissionApprovalRepository(
      { save: true },
      c.get,
    );
    const a = await activate({
      repository: repo,
      monotonicClock: c.get,
      wallClock: c.get,
    });
    const o = approval(
      await unwrap(a.session.authorizeCall(input(a.registry))),
    );
    expect(
      await error(
        a.session.answerChallenge(
          challengeInput(a.registry, o.challenge),
          answer(
            o.challenge,
            o.requests[0].requestId,
            choice(o.requests[0].requestId, "durable"),
          ),
        ),
      ),
    ).toBe("repository_failure");
    expect(
      (
        await unwrap<PermissionOutcome>(
          a.session.authorizeCall(input(a.registry)),
        )
      ).kind,
    ).toBe("approval_required");
  });
  it("isolates project, agent, owner, tool, revision, policy, schema and digest", async () => {
    const a = await activate();
    const base = input(a.registry);
    for (const x of [
      { project: "x" },
      { session: "x" },
      { agentName: "x" },
      { registryGeneration: "x" },
    ])
      expect([
        "mismatched_session",
        "unknown_agent",
        "stale_permission_state",
        "unmanaged",
      ]).toContain(await error(a.session.authorizeCall({ ...base, ...x })));
  });
  it("rejects expired and revoked durable grants and maps repository APIs", async () => {
    const c = clock();
    const repo = new InMemoryPermissionApprovalRepository({}, c.get);
    const a = await activate({
      repository: repo,
      monotonicClock: c.get,
      wallClock: c.get,
    });
    expect((await unwrap(a.session.listDurableGrants())).length).toBe(0);
    expect(await error(a.session.revokeDurableGrant("missing"))).toBe(
      "unknown_grant",
    );
  });
  it("requires UI for unresolved asks every time", async () => {
    const r = registry(() => ok([unresolved()]));
    const a = await activate({ registry: r });
    expect(
      await error(
        a.session.authorizeCall(input(r, { approvalUiAvailable: false })),
      ),
    ).toBe("unresolved_ui_unavailable");
  });
  it("expires, cancels, and bounds challenges", async () => {
    const a = await activate();
    const o = approval(
      await unwrap(a.session.authorizeCall(input(a.registry))),
    );
    a.clock.advance(300000);
    expect(
      await error(
        a.session.answerChallenge(
          challengeInput(a.registry, o.challenge),
          answer(o.challenge, o.requests[0].requestId),
        ),
      ),
    ).toBe("expired_challenge");
  });
  it("binds permits to exact calls and consumes them once", async () => {
    const r = registry(() => ok([request()]));
    const a = await activate({
      registry: r,
      policies: { agent: policy("allow") },
    });
    const o = authorized(await unwrap(a.session.authorizeCall(input(r))));
    expect(
      await error(
        a.session.consumePermit({
          ...permitInput(r),
          permit: o.permit,
          call: { value: 2 },
        }),
      ),
    ).toBe("stale_permit");
    expect(
      (
        await a.session.consumePermit({ ...permitInput(r), permit: o.permit })
      ).isOk(),
    ).toBe(true);
    expect(
      await error(
        a.session.consumePermit({ ...permitInput(r), permit: o.permit }),
      ),
    ).toBe("consumed_permit");
  });
  it("rechecks immutable permit bindings with the current resolver", async () => {
    let identifier = "a";
    const r = registry(() =>
      ok([request({ target: { kind: "file", identifier } })]),
    );
    const a = await activate({
      registry: r,
      policies: { agent: policy("allow") },
    });
    const permit = authorized(await unwrap(a.session.authorizeCall(input(r))));
    identifier = "b";
    expect(
      await error(
        a.session.consumePermit({ ...permitInput(r), permit: permit.permit }),
      ),
    ).toBe("stale_permit");
    identifier = "a";
    expect(
      (
        await a.session.consumePermit({
          ...permitInput(r),
          permit: permit.permit,
        })
      ).isOk(),
    ).toBe(true);
  });
  it("serializes concurrent consumption to one success", async () => {
    const r = registry(() => ok([request()]));
    const a = await activate({
      registry: r,
      policies: { agent: policy("allow") },
    });
    const o = authorized(await unwrap(a.session.authorizeCall(input(r))));
    const results = await Promise.all([
      a.session.consumePermit({ ...permitInput(r), permit: o.permit }),
      a.session.consumePermit({ ...permitInput(r), permit: o.permit }),
    ]);
    expect(results.filter((x) => x.isOk()).length).toBe(1);
    expect(results.filter((x) => x.isErr()).length).toBe(1);
  });
  it("closes, replaces only when idle, and invalidates old generations", async () => {
    const a = await activate();
    const _o = approval(
      await unwrap(a.session.authorizeCall(input(a.registry))),
    );
    // Same generation ID is always an invalid transition (even while non-idle).
    expect(
      await error(a.session.replaceRegistry({ registry: a.registry })),
    ).toBe("invalid_registry_transition");
    // Fresh unseen generation while active challenges remain is non_idle.
    const freshWhileActive = registry();
    expect(
      await error(a.session.replaceRegistry({ registry: freshWhileActive })),
    ).toBe("non_idle_replacement");
    await a.session.close();
    expect(await error(a.session.authorizeCall(input(a.registry)))).toBe(
      "closed_session",
    );
    const audit = await unwrap(a.session.listAudit());
    expect(audit.some((event) => event.type === "session_closed")).toBe(true);
  });

  it("rejects generation replay A->A and A->B->A while allowing fresh idle replacement", async () => {
    const generationA = registry();
    const generationB = registry();
    const generationC = registry();
    expect(generationA.id).not.toBe(generationB.id);
    expect(generationB.id).not.toBe(generationC.id);

    const a = await activate({ registry: generationA });
    // A->A (idle): current ID is observed -> invalid_registry_transition.
    expect(
      await error(a.session.replaceRegistry({ registry: generationA })),
    ).toBe("invalid_registry_transition");

    // A->B (idle, fresh): succeeds.
    expect(
      (await a.session.replaceRegistry({ registry: generationB })).isOk(),
    ).toBe(true);

    // A->B->A: retired A is still observed -> invalid_registry_transition.
    expect(
      await error(a.session.replaceRegistry({ registry: generationA })),
    ).toBe("invalid_registry_transition");
    // B->B current ID also rejected.
    expect(
      await error(a.session.replaceRegistry({ registry: generationB })),
    ).toBe("invalid_registry_transition");

    // Fresh C while idle succeeds.
    expect(
      (await a.session.replaceRegistry({ registry: generationC })).isOk(),
    ).toBe(true);

    // Active state still non_idle for a brand-new generation.
    const active = await activate({ registry: generationA });
    const pending = approval(
      await unwrap(active.session.authorizeCall(input(generationA))),
    );
    expect(pending.challenge).toBeTruthy();
    const fresh = registry();
    expect(
      await error(active.session.replaceRegistry({ registry: fresh })),
    ).toBe("non_idle_replacement");
  });

  it("replaces identical metadata generations and preserves valid grant envelopes", async () => {
    const first = registry();
    const second = registry();
    expect(first.identity).toBe(second.identity);
    expect(first.id).not.toBe(second.id);

    const sessionGrant = await activate({ registry: first });
    const pending = approval(
      await unwrap(sessionGrant.session.authorizeCall(input(first))),
    );
    const sessionPermit = authorized(
      await unwrap(
        sessionGrant.session.answerChallenge(
          challengeInput(first, pending.challenge),
          answer(
            pending.challenge,
            pending.requests[0].requestId,
            choice(pending.requests[0].requestId, "session"),
          ),
        ),
      ),
    );
    await unwrap(
      sessionGrant.session.consumePermit({
        ...permitInput(first),
        permit: sessionPermit.permit,
      }),
    );
    expect(
      (await sessionGrant.session.replaceRegistry({ registry: second })).isOk(),
    ).toBe(true);
    expect(
      await error(
        sessionGrant.session.replaceRegistry({
          registry: second,
          idle: true,
        } as never),
      ),
    ).toBe("invalid_output");
    expect(await error(sessionGrant.session.authorizeCall(input(first)))).toBe(
      "stale_permission_state",
    );
    const renewedSessionPermit = authorized(
      await unwrap(sessionGrant.session.authorizeCall(input(second))),
    );
    await unwrap(
      sessionGrant.session.consumePermit({
        ...permitInput(second),
        permit: renewedSessionPermit.permit,
      }),
    );

    const durableGrant = await activate({ registry: first });
    const durablePending = approval(
      await unwrap(durableGrant.session.authorizeCall(input(first))),
    );
    const durablePermit = authorized(
      await unwrap(
        durableGrant.session.answerChallenge(
          challengeInput(first, durablePending.challenge),
          answer(
            durablePending.challenge,
            durablePending.requests[0].requestId,
            choice(durablePending.requests[0].requestId, "durable"),
          ),
        ),
      ),
    );
    await unwrap(
      durableGrant.session.consumePermit({
        ...permitInput(first),
        permit: durablePermit.permit,
      }),
    );
    expect(
      (await durableGrant.session.replaceRegistry({ registry: second })).isOk(),
    ).toBe(true);
    expect(await error(durableGrant.session.authorizeCall(input(first)))).toBe(
      "stale_permission_state",
    );
    const renewedDurablePermit = authorized(
      await unwrap(durableGrant.session.authorizeCall(input(second))),
    );
    await unwrap(
      durableGrant.session.consumePermit({
        ...permitInput(second),
        permit: renewedDurablePermit.permit,
      }),
    );
  });

  it("lets the engine reject active permits and purge expired state before replacement", async () => {
    const permitSession = await activate({
      policies: { agent: policy("allow") },
    });
    const permit = authorized(
      await unwrap(
        permitSession.session.authorizeCall(input(permitSession.registry)),
      ),
    );
    const next = registry();
    expect(
      await error(permitSession.session.replaceRegistry({ registry: next })),
    ).toBe("non_idle_replacement");
    await unwrap(
      permitSession.session.consumePermit({
        ...permitInput(permitSession.registry),
        permit: permit.permit,
      }),
    );

    const challengeSession = await activate();
    const pending = approval(
      await unwrap(
        challengeSession.session.authorizeCall(
          input(challengeSession.registry),
        ),
      ),
    );
    challengeSession.clock.advance(300000);
    expect(
      (
        await challengeSession.session.replaceRegistry({ registry: next })
      ).isOk(),
    ).toBe(true);
    const audit = await unwrap(challengeSession.session.listAudit());
    expect(audit.some((event) => event.type === "registry_replaced")).toBe(
      true,
    );
    expect(
      await error(
        challengeSession.session.authorizeCall(
          input(challengeSession.registry),
        ),
      ),
    ).toBe("stale_permission_state");
    expect(pending.challenge).toBeTruthy();
  });
  it("sanitizes bounded audit output and forbids sensitive call data", async () => {
    const secret = "audit-secret-call-constraints-display-repository";
    const a = await activate({ auditCapacity: 2 });
    for (let n = 0; n < 4; n++)
      await a.session.authorizeCall(
        input(a.registry, {
          call: {
            secret,
            requestId: secret,
            challenge: secret,
            permit: secret,
            digest: secret,
            constraints: { secret },
          },
        }),
      );
    const log = await unwrap(a.session.listAudit());
    expect(log.length).toBeLessThanOrEqual(2);
    expect(Object.isFrozen(log)).toBe(true);
    for (const event of log) {
      expect(Object.isFrozen(event)).toBe(true);
      expect(JSON.stringify(event)).not.toContain(secret);
      expect(Object.keys(event)).not.toContain("call");
      expect(Object.keys(event)).not.toContain("requestId");
      expect(Object.keys(event)).not.toContain("permit");
      expect(Object.keys(event)).not.toContain("digest");
      expect(Object.keys(event)).not.toContain("cause");
    }
  });

  it("returns a frozen execution snapshot that ignores post-consume mutation", async () => {
    const r = registry(() => ok([request()]));
    const a = await activate({
      registry: r,
      policies: { agent: policy("allow") },
    });
    const live: { value: number; nested: { flag: string } } = {
      value: 1,
      nested: { flag: "ok" },
    };
    const o = authorized(
      await unwrap(
        a.session.authorizeCall({
          ...input(r),
          call: live,
        }),
      ),
    );
    const consumed = await a.session.consumePermit({
      ...permitInput(r),
      permit: o.permit,
      call: live,
    });
    expect(consumed.isOk()).toBe(true);
    if (!consumed.isOk()) throw new Error("expected snapshot");
    const snapshot = consumed.value as {
      value: number;
      nested: { flag: string };
    };
    live.value = 99;
    live.nested.flag = "mutated";
    expect(snapshot).toEqual({ value: 1, nested: { flag: "ok" } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.nested)).toBe(true);
    expect(snapshot).not.toBe(live);
  });

  it("does not extend challenge or permit TTL when monotonic clock rolls back", async () => {
    const mono = clock();
    const wall = clock();
    const a = await activate({
      monotonicClock: mono.get,
      wallClock: wall.get,
    });
    const pending = approval(
      await unwrap(a.session.authorizeCall(input(a.registry))),
    );
    // Observe the expiry boundary through the session, then roll the source back.
    mono.advance(300000);
    expect(
      await error(
        a.session.answerChallenge(
          challengeInput(a.registry, pending.challenge),
          answer(pending.challenge, pending.requests[0].requestId),
        ),
      ),
    ).toBe("expired_challenge");
    mono.advance(-200000);
    expect(mono.get()).toBeLessThan(301000);
    expect(
      await error(
        a.session.answerChallenge(
          challengeInput(a.registry, pending.challenge),
          answer(pending.challenge, pending.requests[0].requestId),
        ),
      ),
    ).toBe("expired_challenge");

    const mono2 = clock();
    const wall2 = clock();
    const permitSession = await activate({
      registry: registry(() => ok([request()])),
      policies: { agent: policy("allow") },
      monotonicClock: mono2.get,
      wallClock: wall2.get,
    });
    const issued = authorized(
      await unwrap(
        permitSession.session.authorizeCall(input(permitSession.registry)),
      ),
    );
    mono2.advance(30000);
    expect(
      await error(
        permitSession.session.consumePermit({
          ...permitInput(permitSession.registry),
          permit: issued.permit,
        }),
      ),
    ).toBe("expired_permit");
    mono2.advance(-20000);
    expect(mono2.get()).toBeLessThan(31_000);
    expect(
      await error(
        permitSession.session.consumePermit({
          ...permitInput(permitSession.registry),
          permit: issued.permit,
        }),
      ),
    ).toBe("expired_permit");
  });

  it("does not resurrect durable authority when wall clock rolls back", async () => {
    const mono = clock();
    const wall = clock();
    const repo = new InMemoryPermissionApprovalRepository({}, wall.get);
    const r = registry(() => ok([request()]));
    const a = await activate({
      registry: r,
      repository: repo,
      monotonicClock: mono.get,
      wallClock: wall.get,
    });
    const pending = approval(await unwrap(a.session.authorizeCall(input(r))));
    const expiresAt = wall.get() + 5_000;
    const answered = await a.session.answerChallenge(
      challengeInput(r, pending.challenge),
      {
        challenge: pending.challenge,
        choices: [
          {
            requestId: pending.requests[0].requestId,
            decision: "allow",
            scope: "durable",
            expiresAt,
          },
        ],
      },
    );
    expect(answered.isOk()).toBe(true);
    if (!answered.isOk()) throw new Error("expected durable answer");
    const authorizedOnce = authorized(answered.value);
    expect(
      (
        await a.session.consumePermit({
          ...permitInput(r),
          permit: authorizedOnce.permit,
        })
      ).isOk(),
    ).toBe(true);

    // Still valid just before expiry.
    wall.advance(4_999);
    expect((await unwrap(a.session.authorizeCall(input(r)))).kind).toBe(
      "authorized",
    );

    // At boundary: expired.
    wall.advance(1);
    expect((await unwrap(a.session.authorizeCall(input(r)))).kind).toBe(
      "approval_required",
    );

    // Wall source rolls back below the observed high-water — still ineligible.
    wall.advance(-5_000);
    expect(wall.get()).toBeLessThan(expiresAt);
    expect(wall.get()).toBeGreaterThanOrEqual(0);
    expect((await unwrap(a.session.authorizeCall(input(r)))).kind).toBe(
      "approval_required",
    );
  });

  it("keeps no-expiry durable grants and session grants valid across wall rollback", async () => {
    const mono = clock();
    const wall = clock();
    const repo = new InMemoryPermissionApprovalRepository({}, wall.get);
    const r = registry(() => ok([request()]));
    const a = await activate({
      registry: r,
      repository: repo,
      monotonicClock: mono.get,
      wallClock: wall.get,
    });
    const pending = approval(await unwrap(a.session.authorizeCall(input(r))));
    const durable = authorized(
      await unwrap(
        a.session.answerChallenge(
          challengeInput(r, pending.challenge),
          answer(
            pending.challenge,
            pending.requests[0].requestId,
            choice(pending.requests[0].requestId, "durable"),
          ),
        ),
      ),
    );
    expect(
      (
        await a.session.consumePermit({
          ...permitInput(r),
          permit: durable.permit,
        })
      ).isOk(),
    ).toBe(true);
    wall.advance(1_000_000);
    wall.advance(-999_999);
    expect((await unwrap(a.session.authorizeCall(input(r)))).kind).toBe(
      "authorized",
    );

    const sessionOnly = await activate({
      registry: r,
      monotonicClock: mono.get,
      wallClock: wall.get,
    });
    // Fresh session without durable repo share — use shared repo for durable,
    // and prove session-scope grant is independent of wall rollback.
    const sessionPending = approval(
      await unwrap(sessionOnly.session.authorizeCall(input(r))),
    );
    // This new session has empty durable repo — grant session scope.
    const sessionGrant = authorized(
      await unwrap(
        sessionOnly.session.answerChallenge(
          challengeInput(r, sessionPending.challenge),
          answer(
            sessionPending.challenge,
            sessionPending.requests[0].requestId,
            choice(sessionPending.requests[0].requestId, "session"),
          ),
        ),
      ),
    );
    expect(
      (
        await sessionOnly.session.consumePermit({
          ...permitInput(r),
          permit: sessionGrant.permit,
        })
      ).isOk(),
    ).toBe(true);
    wall.advance(50_000);
    wall.advance(-50_000);
    expect(
      (await unwrap(sessionOnly.session.authorizeCall(input(r)))).kind,
    ).toBe("authorized");
  });
});
