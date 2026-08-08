import { describe, expect, it } from "bun:test";
import type { AgentDescriptor } from "@weaveio/weave-engine";
import {
  delegationControllerGenerationsAgree,
  type PiDelegationInvocationSource,
  resolveDelegationInvocationContext,
} from "../extension.js";

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
