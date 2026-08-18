import { describe, expect, it } from "bun:test";
import type { AgentDescriptor, DelegationTarget } from "@weaveio/weave-engine";
import { okAsync, type ResultAsync } from "neverthrow";
import type {
  PiDelegationController,
  PiDelegationRequest,
} from "../delegation-controller.js";
import {
  buildDelegationToolRegistration,
  type PiDelegationToolDeps,
} from "../delegation-tool.js";
import type { PiAdapterFailure } from "../errors.js";
import {
  delegationControllerGenerationsAgree,
  type PiDelegationInvocationSource,
  resolveDelegationInvocationContext,
} from "../extension-impl.js";
import { createOpenSessionMutationGate } from "../required-capability-gate.js";
import type { PiChildSettlement } from "../rpc-child.js";
import type { PiSessionContext } from "../types.js";

const GENERATION_ID = "gen-1";

function descriptor(
  name: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    name,
    description: `${name} description`,
    mode: "primary",
    composedPrompt: `# ${name}`,
    tools: [],
    skills: [],
    models: [],
    delegationTargets: [
      {
        name: `${name}-shuttle`,
        description: "shuttle",
        triggers: [],
        isCategory: true,
      },
    ],
    ...overrides,
  } as unknown as AgentDescriptor;
}

function source(
  overrides: Partial<PiDelegationInvocationSource> = {},
): PiDelegationInvocationSource {
  const loom = descriptor("loom");
  return {
    generationId: GENERATION_ID,
    activeDescriptor: undefined,
    pendingPrimaryName: "loom",
    descriptors: new Map([["loom", loom]]),
    primaryActivationAttempted: false,
    primaryActivationFailure: undefined,
    ...overrides,
  };
}

describe("resolveDelegationInvocationContext", () => {
  it("uses the active primary descriptor once one is activated", () => {
    const tapestry = descriptor("tapestry");
    const resolved = resolveDelegationInvocationContext(
      source({ activeDescriptor: tapestry }),
      GENERATION_ID,
    );
    expect(resolved).toEqual({
      parentAgentName: "tapestry",
      targets: tapestry.delegationTargets,
    });
  });

  it("keeps using the active descriptor even after a prior activation failure", () => {
    const tapestry = descriptor("tapestry");
    const resolved = resolveDelegationInvocationContext(
      source({
        activeDescriptor: tapestry,
        primaryActivationAttempted: true,
        primaryActivationFailure: { type: "NoPriorPrimary" },
      }),
      GENERATION_ID,
    );
    expect(resolved?.parentAgentName).toBe("tapestry");
  });

  // Regression: a resumed durable goal can execute `weave_delegate` before Pi
  // emits `before_agent_start`, so no primary is active yet even though the
  // generation activated healthily and the delegation controller is live.
  it("falls back to the configured pending primary before before_agent_start", () => {
    const resolved = resolveDelegationInvocationContext(
      source(),
      GENERATION_ID,
    );
    expect(resolved).toEqual({
      parentAgentName: "loom",
      targets: [
        {
          name: "loom-shuttle",
          description: "shuttle",
          triggers: [],
          isCategory: true,
        },
      ],
    });
  });

  it("never broadens the fallback targets to the static tool union", () => {
    const loom = descriptor("loom");
    const tapestry = descriptor("tapestry");
    const resolved = resolveDelegationInvocationContext(
      source({
        descriptors: new Map([
          ["loom", loom],
          ["tapestry", tapestry],
        ]),
      }),
      GENERATION_ID,
    );
    expect(resolved?.targets.map((target) => target.name)).toEqual([
      "loom-shuttle",
    ]);
  });

  it("fails closed for an active descriptor whose generation was superseded", () => {
    const tapestry = descriptor("tapestry");
    expect(
      resolveDelegationInvocationContext(
        source({ activeDescriptor: tapestry }),
        "gen-2",
      ),
    ).toBeUndefined();
  });

  it("fails closed for an active descriptor when there is no current generation", () => {
    const tapestry = descriptor("tapestry");
    expect(
      resolveDelegationInvocationContext(
        source({ activeDescriptor: tapestry }),
        undefined,
      ),
    ).toBeUndefined();
  });

  it("fails closed when there is no active session", () => {
    expect(
      resolveDelegationInvocationContext(undefined, GENERATION_ID),
    ).toBeUndefined();
  });

  it("fails closed when the session belongs to a superseded generation", () => {
    expect(
      resolveDelegationInvocationContext(source(), "gen-2"),
    ).toBeUndefined();
    expect(
      resolveDelegationInvocationContext(source(), undefined),
    ).toBeUndefined();
  });

  // Documented safe behavior: once activation has been attempted, its outcome
  // is authoritative. A missing active primary then means activation failed or
  // was declined, so the pending name must not resurrect delegation authority.
  it("fails closed once primary activation has been attempted without committing", () => {
    expect(
      resolveDelegationInvocationContext(
        source({ primaryActivationAttempted: true }),
        GENERATION_ID,
      ),
    ).toBeUndefined();
  });

  it("fails closed when primary activation recorded a failure", () => {
    expect(
      resolveDelegationInvocationContext(
        source({
          primaryActivationFailure: {
            type: "DescriptorNotFound",
            agentName: "loom",
          },
        }),
        GENERATION_ID,
      ),
    ).toBeUndefined();
  });

  it("fails closed when there is no pending primary name", () => {
    expect(
      resolveDelegationInvocationContext(
        source({ pendingPrimaryName: undefined }),
        GENERATION_ID,
      ),
    ).toBeUndefined();
  });

  it("fails closed when the pending primary descriptor is unavailable", () => {
    expect(
      resolveDelegationInvocationContext(
        source({ descriptors: new Map() }),
        GENERATION_ID,
      ),
    ).toBeUndefined();
  });

  it("fails closed when the pending primary is not eligible as a primary", () => {
    const shuttle = descriptor("loom", { mode: "subagent" });
    expect(
      resolveDelegationInvocationContext(
        source({ descriptors: new Map([["loom", shuttle]]) }),
        GENERATION_ID,
      ),
    ).toBeUndefined();
  });

  it("fails closed when the pending primary declares no delegation targets", () => {
    const loom = descriptor("loom", { delegationTargets: [] });
    expect(
      resolveDelegationInvocationContext(
        source({ descriptors: new Map([["loom", loom]]) }),
        GENERATION_ID,
      ),
    ).toBeUndefined();
  });
});

describe("delegationControllerGenerationsAgree", () => {
  it("permits delegation when all three generation views agree", () => {
    expect(
      delegationControllerGenerationsAgree(
        GENERATION_ID,
        GENERATION_ID,
        GENERATION_ID,
      ),
    ).toBe(true);
  });

  // Regression: a prior generation's controller must not keep answering
  // `weave_delegate` after a new session generation takes authority - most
  // importantly when the new generation is health-only or trust-withheld and
  // therefore constructs no controller of its own.
  it("fails closed when the held controller belongs to a superseded generation", () => {
    expect(
      delegationControllerGenerationsAgree("gen-1", "gen-2", "gen-2"),
    ).toBe(false);
  });

  it("fails closed when the active session lags the runtime's current generation", () => {
    expect(
      delegationControllerGenerationsAgree("gen-1", "gen-1", "gen-2"),
    ).toBe(false);
  });

  it("fails closed when the runtime reports no current generation", () => {
    expect(
      delegationControllerGenerationsAgree("gen-1", "gen-1", undefined),
    ).toBe(false);
  });

  it("fails closed when there is no active session", () => {
    expect(
      delegationControllerGenerationsAgree("gen-1", undefined, "gen-1"),
    ).toBe(false);
  });

  // A health-only or trust-withheld generation never constructs a controller,
  // so the cell's generation stays cleared and delegation stays denied.
  it("fails closed when no controller generation is held", () => {
    expect(
      delegationControllerGenerationsAgree(undefined, "gen-1", "gen-1"),
    ).toBe(false);
  });
});

/**
 * The resolved invocation context is the delegation tool's only target gate.
 * These tests connect the two units directly: whatever
 * `resolveDelegationInvocationContext` answers is exactly what the tool
 * authorizes, with no registration-time union able to widen or narrow it.
 */
describe("the resolved context is the delegation tool's only target gate", () => {
  /** A registration-time target set that names none of the runtime targets. */
  const STALE_REGISTRATION_TARGETS: readonly DelegationTarget[] = [
    {
      name: "stale-shuttle",
      description: "known when the tool was registered",
      triggers: [],
      isCategory: false,
    },
  ];

  function ctx(): PiSessionContext {
    return {
      mode: "tui",
      cwd: "/project",
      isProjectTrusted: () => true,
      isIdle: () => true,
      ui: {
        notify: () => {},
        setStatus: () => {},
        setWidget: () => {},
        select: async () => undefined,
        confirm: async () => false,
      },
      hasUI: true,
      model: undefined,
      modelRegistry: { getAvailable: () => [] },
    } as unknown as PiSessionContext;
  }

  function toolFor(
    resolvedSource: PiDelegationInvocationSource | undefined,
    onDelegate: (request: PiDelegationRequest) => void,
  ) {
    const controller = {
      delegate: (
        request: PiDelegationRequest,
      ): ResultAsync<PiChildSettlement, PiAdapterFailure> => {
        onDelegate(request);
        return okAsync({ outcome: "completed", assistantOutput: "done" });
      },
      threadStatus: () => undefined,
    } as unknown as PiDelegationController;
    const deps: PiDelegationToolDeps = {
      targets: STALE_REGISTRATION_TARGETS,
      getInvocationContext: () =>
        resolveDelegationInvocationContext(resolvedSource, GENERATION_ID),
      getController: () => controller,
      parentId: "root",
      parentDepth: 0,
      parentAgentName: "loom",
      idGenerator: { next: () => "child-1" },
      buildBootstrap: () => ({}),
      buildEnv: () => ({}),
      getParentSessionState: () => ({
        persistence: "persistent",
        sessionId: "session-test",
        runtimeSessionId: "session-test",
        identitySource: "session-header",
        sessionFile: "/sessions/test.jsonl",
      }),
      sessionMutationGate: createOpenSessionMutationGate(),
    };
    return buildDelegationToolRegistration(deps);
  }

  async function delegateTo(
    registration: ReturnType<typeof buildDelegationToolRegistration>,
    agent: string,
  ): Promise<{ readonly ok: boolean; readonly error?: string }> {
    const result = await registration.execute(
      "call-1",
      { agent, task: "do it" },
      undefined,
      undefined,
      ctx(),
    );
    return JSON.parse((result.content[0] as { text: string }).text) as {
      ok: boolean;
      error?: string;
    };
  }

  it("dispatches a target the registration never knew, taken only from the resolved context", async () => {
    const tapestry = descriptor("tapestry");
    let dispatched: PiDelegationRequest | undefined;
    const registration = toolFor(
      source({ activeDescriptor: tapestry }),
      (request) => {
        dispatched = request;
      },
    );
    expect(
      STALE_REGISTRATION_TARGETS.some(
        (target) => target.name === "tapestry-shuttle",
      ),
    ).toBe(false);

    expect(await delegateTo(registration, "tapestry-shuttle")).toEqual({
      ok: true,
      settlement: {
        outcome: "completed",
        finalOutput: "done",
        interventionCount: 0,
      },
    } as never);
    expect(dispatched?.agentName).toBe("tapestry-shuttle");
    expect(dispatched?.parentAgentName).toBe("tapestry");
  });

  it("still refuses the registration-time name the resolved context does not carry", async () => {
    let dispatched = false;
    const registration = toolFor(
      source({ activeDescriptor: descriptor("tapestry") }),
      () => {
        dispatched = true;
      },
    );
    expect(await delegateTo(registration, "stale-shuttle")).toEqual({
      ok: false,
      error: "invalid-delegation-target",
    });
    expect(dispatched).toBe(false);
  });

  it("fails closed for every name once the context resolves to nothing", async () => {
    let dispatched = false;
    const registration = toolFor(undefined, () => {
      dispatched = true;
    });
    for (const agent of ["tapestry-shuttle", "stale-shuttle"]) {
      expect(await delegateTo(registration, agent)).toEqual({
        ok: false,
        error: "delegation-transport-unavailable",
      });
    }
    expect(dispatched).toBe(false);
  });
});
