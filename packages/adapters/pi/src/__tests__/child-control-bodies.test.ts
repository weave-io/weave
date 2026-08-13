import { describe, expect, it } from "bun:test";
import {
  MAX_DELEGATION_TRIGGERS,
  MAX_SETTLEMENT_OUTPUT_BYTES,
  parseControlBody,
  toModelIdentityBody,
} from "../child-control-bodies.js";
import { MAX_CONTROL_BODY_BYTES } from "../child-envelope.js";

// Half of the envelope's own 64KiB control-body byte cap - see the
// `MAX_COMPOSED_PROMPT_LENGTH` doc comment in child-control-bodies.ts for
// why this is the chosen bound (leaves headroom for every other bootstrap
// field plus JSON structural overhead within the same envelope).
const MAX_COMPOSED_PROMPT_LENGTH = MAX_CONTROL_BODY_BYTES / 2;

// The bounded correlation/context fields are required on every bootstrap
// body regardless of composedPrompt size.
const REQUIRED_BOOTSTRAP_FIELDS = {
  mode: "ordinary" as const,
  correlationId: "child-1",
  context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
};

describe("settled control body strict boundaries", () => {
  it("rejects legacy summary and accepts exact UTF-8 output boundaries", () => {
    expect(
      parseControlBody("settled", { outcome: "completed", summary: "legacy" })
        .ok,
    ).toBe(false);
    const ascii = "a".repeat(MAX_SETTLEMENT_OUTPUT_BYTES);
    const unicode = "🙂".repeat(MAX_SETTLEMENT_OUTPUT_BYTES / 4);
    expect(
      parseControlBody("settled", {
        outcome: "completed",
        assistantOutput: ascii,
      }).ok,
    ).toBe(true);
    expect(
      parseControlBody("settled", {
        outcome: "completed",
        completionCandidate: unicode,
      }).ok,
    ).toBe(true);
    expect(
      parseControlBody("settled", {
        outcome: "completed",
        assistantOutput: `${ascii}a`,
      }).ok,
    ).toBe(false);
    expect(
      parseControlBody("settled", {
        outcome: "completed",
        completionCandidate: `${unicode}a`,
      }).ok,
    ).toBe(false);
  });

  it("rejects malformed intervention counts and out-of-range transfer numbers", () => {
    for (const interventionCount of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1_000_001,
      "1",
    ]) {
      expect(
        parseControlBody("settled", { outcome: "completed", interventionCount })
          .ok,
      ).toBe(false);
    }
    for (const value of [-1, 1.5, 65_537, Number.POSITIVE_INFINITY]) {
      expect(
        parseControlBody("transfer-chunk", {
          channel: "output",
          transferId: "t",
          index: value,
          total: 1,
          data: "x",
        }).ok,
      ).toBe(false);
      expect(
        parseControlBody("transfer-chunk", {
          channel: "output",
          transferId: "t",
          index: 0,
          total: value,
          data: "x",
        }).ok,
      ).toBe(false);
    }
  });
});

function bootstrapBodyWithCanonicalByteLength(target: number) {
  const base = {
    agentName: "shuttle",
    composedPrompt: "",
    models: [],
    delegationTargets: Array.from({ length: 9 }, (_, index) => ({
      name: `target-${index}`,
      description: "x".repeat(256),
      triggers: Array.from(
        { length: 16 },
        (_unused, triggerIndex) =>
          `trigger-${index}-${triggerIndex}-${"x".repeat(230)}`,
      ),
      isCategory: false,
    })),
    ...REQUIRED_BOOTSTRAP_FIELDS,
  };
  const byteLength = new TextEncoder().encode(JSON.stringify(base)).byteLength;
  const delta = target - byteLength;
  if (delta < 0 || delta > MAX_COMPOSED_PROMPT_LENGTH) {
    throw new Error("test setup: canonical bootstrap target is unreachable");
  }
  return { ...base, composedPrompt: "x".repeat(delta) };
}

describe("BootstrapBodySchema composedPrompt and canonical body bounds", () => {
  it("accepts a composedPrompt exactly at the max bound", () => {
    const result = parseControlBody("bootstrap", {
      agentName: "shuttle",
      composedPrompt: "a".repeat(MAX_COMPOSED_PROMPT_LENGTH),
      models: [],
      ...REQUIRED_BOOTSTRAP_FIELDS,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a composedPrompt one character over the max bound", () => {
    const result = parseControlBody("bootstrap", {
      agentName: "shuttle",
      composedPrompt: "a".repeat(MAX_COMPOSED_PROMPT_LENGTH + 1),
      models: [],
      ...REQUIRED_BOOTSTRAP_FIELDS,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a composedPrompt so large it would otherwise dominate the entire 64KiB envelope body budget", () => {
    const result = parseControlBody("bootstrap", {
      agentName: "shuttle",
      composedPrompt: "a".repeat(MAX_CONTROL_BODY_BYTES),
      models: [],
    });
    expect(result.ok).toBe(false);
  });

  it("still rejects a missing composedPrompt (required field, unaffected by the new bound)", () => {
    const result = parseControlBody("bootstrap", {
      agentName: "shuttle",
      models: [],
    });
    expect(result.ok).toBe(false);
  });

  it("accepts exactly the canonical body byte bound and rejects one byte over it", () => {
    const exact = bootstrapBodyWithCanonicalByteLength(MAX_CONTROL_BODY_BYTES);
    const oversized = bootstrapBodyWithCanonicalByteLength(
      MAX_CONTROL_BODY_BYTES + 1,
    );

    expect(new TextEncoder().encode(JSON.stringify(exact))).toHaveLength(
      MAX_CONTROL_BODY_BYTES,
    );
    expect(parseControlBody("bootstrap", exact).ok).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(oversized))).toHaveLength(
      MAX_CONTROL_BODY_BYTES + 1,
    );
    expect(parseControlBody("bootstrap", oversized).ok).toBe(false);
  });
});

describe("BootstrapBodySchema delegation triggers", () => {
  function bootstrapWithTriggers(triggers: unknown) {
    return {
      agentName: "tapestry",
      composedPrompt: "Delegate every implementation task.",
      models: [],
      delegationTargets: [
        {
          name: "shuttle",
          description: "Shuttle (Domain Specialist)",
          triggers,
          isCategory: false,
        },
      ],
      ...REQUIRED_BOOTSTRAP_FIELDS,
    };
  }

  it("accepts ordered nonblank string triggers at their entry and count bounds", () => {
    const triggers = [
      "Plan work",
      "a".repeat(256),
      ...Array.from(
        { length: MAX_DELEGATION_TRIGGERS - 2 },
        (_, index) => `bounded-${index}`,
      ),
    ];
    const result = parseControlBody(
      "bootstrap",
      bootstrapWithTriggers(triggers),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.delegationTargets?.[0]?.triggers).toEqual(triggers);
    }
  });

  it.each([
    [
      "legacy structured trigger",
      [{ domain: "Implementation", trigger: "Code" }],
    ],
    ["empty trigger", [""]],
    ["blank trigger", [" \t\n"]],
    ["oversized trigger", ["x".repeat(257)]],
    [
      "too many triggers",
      Array.from(
        { length: MAX_DELEGATION_TRIGGERS + 1 },
        (_, index) => `trigger-${index}`,
      ),
    ],
  ])("rejects %s", (_label, triggers) => {
    expect(
      parseControlBody("bootstrap", bootstrapWithTriggers(triggers)).ok,
    ).toBe(false);
  });
});

describe("BootstrapBodySchema literal fast intent", () => {
  function ordinary(overrides: Record<string, unknown> = {}) {
    return {
      agentName: "shuttle",
      composedPrompt: "Do the work.",
      models: [],
      ...REQUIRED_BOOTSTRAP_FIELDS,
      ...overrides,
    };
  }

  function directStep(overrides: Record<string, unknown> = {}) {
    return {
      ...ordinary({ mode: "direct-step" }),
      workflowInstanceId: "workflow-1",
      leaseId: "lease-1",
      stepName: "implement",
      completionTool: "weave_complete_step",
      ...overrides,
    };
  }

  it.each([
    ["ordinary true", ordinary({ fast: true })],
    ["ordinary omission", ordinary()],
    ["direct-step true", directStep({ fast: true })],
    ["direct-step omission", directStep()],
  ])("accepts %s", (_label, body) => {
    expect(parseControlBody("bootstrap", body).ok).toBe(true);
  });

  it.each([
    ["ordinary false", ordinary({ fast: false })],
    ["ordinary string", ordinary({ fast: "true" })],
    ["ordinary numeric", ordinary({ fast: 1 })],
    ["ordinary service_class alias", ordinary({ service_class: "priority" })],
    ["ordinary speed alias", ordinary({ speed: true })],
    ["ordinary variant alias", ordinary({ variant: "fast" })],
    ["ordinary priority alias", ordinary({ priority: true })],
    ["ordinary unknown key", ordinary({ unexpected: true })],
    ["direct-step false", directStep({ fast: false })],
    ["direct-step string", directStep({ fast: "true" })],
    ["direct-step numeric", directStep({ fast: 1 })],
    [
      "direct-step service_class alias",
      directStep({ service_class: "priority" }),
    ],
    ["direct-step speed alias", directStep({ speed: true })],
    ["direct-step variant alias", directStep({ variant: "fast" })],
    ["direct-step priority alias", directStep({ priority: true })],
    ["direct-step unknown key", directStep({ unexpected: true })],
  ])("rejects %s", (_label, body) => {
    expect(parseControlBody("bootstrap", body).ok).toBe(false);
  });
});

describe("parseControlBody hostile bootstrap inputs", () => {
  it("rejects inherited, accessor, and callable data without executing getters", () => {
    let getterExecutions = 0;
    const inherited = Object.create({ fast: true }) as Record<string, unknown>;
    Object.assign(inherited, {
      agentName: "shuttle",
      composedPrompt: "Do the work.",
      models: [],
      ...REQUIRED_BOOTSTRAP_FIELDS,
    });

    const accessor: Record<string, unknown> = {
      agentName: "shuttle",
      composedPrompt: "Do the work.",
      models: [],
      ...REQUIRED_BOOTSTRAP_FIELDS,
    };
    Object.defineProperty(accessor, "fast", {
      enumerable: true,
      get() {
        getterExecutions += 1;
        return true;
      },
    });

    const callable = Object.assign(() => undefined, {
      agentName: "shuttle",
      composedPrompt: "Do the work.",
      models: [],
      ...REQUIRED_BOOTSTRAP_FIELDS,
    });

    for (const candidate of [inherited, accessor, callable]) {
      expect(() => parseControlBody("bootstrap", candidate)).not.toThrow();
      const result = parseControlBody("bootstrap", candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issueCount).toBeGreaterThan(0);
        expect(result.issueCount).toBeLessThanOrEqual(64);
      }
    }
    expect(getterExecutions).toBe(0);
  });
});

describe("DelegateRequestBodySchema.task", () => {
  // Nested delegation accepts the same non-empty task semantics as the
  // top-level tool; transport size is handled by prompt chunking.
  it("accepts a task larger than the former user-visible limit", () => {
    const result = parseControlBody("delegate-request", {
      agentName: "shuttle",
      task: "a".repeat(100_000),
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a chunked task far larger than one envelope body", () => {
    const result = parseControlBody("delegate-request", {
      agentName: "shuttle",
      task: `nested-\u{1F642}\n${"x".repeat(1_100_000)}`,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an empty task", () => {
    const result = parseControlBody("delegate-request", {
      agentName: "shuttle",
      task: "",
    });
    expect(result.ok).toBe(false);
  });
});

describe("BootstrapBodySchema thinking-level transport", () => {
  it("accepts a core-owned thinking level", () => {
    const result = parseControlBody("bootstrap", {
      agentName: "shuttle",
      composedPrompt: "hi",
      models: ["fake/model-x#high"],
      thinkingLevel: "high",
      ...REQUIRED_BOOTSTRAP_FIELDS,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a thinking level outside the shared closed vocabulary", () => {
    const result = parseControlBody("bootstrap", {
      agentName: "shuttle",
      composedPrompt: "hi",
      models: ["fake/model-x#turbo"],
      thinkingLevel: "turbo",
      ...REQUIRED_BOOTSTRAP_FIELDS,
    });
    expect(result.ok).toBe(false);
  });
});

// Pi adapter contract: a real host-supplied model object (`ctx.model`,
// an entry from `ctx.modelRegistry.getAvailable()`, or a `PiModelResolver`
// match drawn from either) may carry fields beyond provider/id/name -
// `ModelIdentityBodySchema` is `.strict()` and rejects any such body
// outright, which previously surfaced as `runTask`'s
// `bootstrap-body-invalid` failure the instant a real host model object
// carried an extra field.
describe("toModelIdentityBody", () => {
  it("projects a host model object down to exactly provider/id/name", () => {
    const projected = toModelIdentityBody({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    });
    expect(projected).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    });
  });

  it("drops every host extra field beyond provider/id/name", () => {
    const hostModel = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      contextWindow: 200000,
      pricing: { input: 3, output: 15 },
      capabilities: ["vision", "tools"],
    };
    const projected = toModelIdentityBody(hostModel);
    expect(Object.keys(projected).sort()).toEqual(["id", "name", "provider"]);
    expect(projected).not.toHaveProperty("contextWindow");
    expect(projected).not.toHaveProperty("pricing");
    expect(projected).not.toHaveProperty("capabilities");
  });

  it("omits the optional name key entirely when absent (never emits an undefined-valued key)", () => {
    const hostModel = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      contextWindow: 200000,
    };
    const projected = toModelIdentityBody(hostModel);
    expect(Object.keys(projected).sort()).toEqual(["id", "provider"]);
    expect("name" in projected).toBe(false);
  });

  it("produces a value that passes ModelIdentityBodySchema's strict validation inside a bootstrap body", () => {
    const hostModel = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      contextWindow: 200000,
      pricing: { input: 3, output: 15 },
    };
    const result = parseControlBody("bootstrap", {
      mode: "ordinary",
      agentName: "shuttle",
      composedPrompt: "hi",
      models: [],
      correlationId: "child-1",
      context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
      resolvedModel: toModelIdentityBody(hostModel),
    });
    expect(result.ok).toBe(true);
  });

  it("proves the raw host object (unprojected) is exactly what previously failed bootstrap-body-invalid", () => {
    const hostModel = {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      contextWindow: 200000,
    };
    const result = parseControlBody("bootstrap", {
      mode: "ordinary",
      agentName: "shuttle",
      composedPrompt: "hi",
      models: [],
      correlationId: "child-1",
      context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
      resolvedModel: hostModel,
    });
    expect(result.ok).toBe(false);
  });
});
