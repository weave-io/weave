import { describe, expect, it } from "bun:test";
import {
  makeCancelBody,
  makeErrorBody,
  MAX_DELEGATION_TRIGGERS,
  MAX_SETTLEMENT_OUTPUT_BYTES,
  MODEL_TRANSITION_SCHEMA_VERSION,
  parseControlBody,
  toModelIdentityBody,
} from "../child-control-bodies.js";
import {
  DIAGNOSTIC_TRUNCATION_MARKER,
  fitsDiagnosticBudget,
  MAX_DIAGNOSTIC_REASON_BYTES,
  projectDiagnosticText,
} from "../child-diagnostic-projection.js";
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

const MODEL_TRANSITION_ID = "123e4567-e89b-42d3-a456-426614174000";

function modelTransitionBody(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: MODEL_TRANSITION_SCHEMA_VERSION,
    transitionId: MODEL_TRANSITION_ID,
    failureClass: "provider_unavailable",
    from: { provider: "origin", id: "model-a", name: "Origin" },
    to: { provider: "fallback", id: "model-b", name: "Fallback" },
    phase: "applied",
    ...overrides,
  };
}

describe("model-transition control body strict boundaries", () => {
  it("accepts the exact applied and recovery-confirmed shapes", () => {
    const applied = parseControlBody("model-transition", modelTransitionBody());
    expect(applied.ok).toBe(true);
    const confirmed = parseControlBody(
      "model-transition",
      modelTransitionBody({ phase: "recovery-confirmed" }),
    );
    expect(confirmed.ok).toBe(true);
  });

  it("rejects extra, malformed, and oversized identity data", () => {
    expect(
      parseControlBody("model-transition", modelTransitionBody({ token: "x" }))
        .ok,
    ).toBe(false);
    expect(
      parseControlBody(
        "model-transition",
        modelTransitionBody({ schemaVersion: 2 }),
      ).ok,
    ).toBe(false);
    expect(
      parseControlBody(
        "model-transition",
        modelTransitionBody({ failureClass: "provider-secret" }),
      ).ok,
    ).toBe(false);
    expect(
      parseControlBody(
        "model-transition",
        modelTransitionBody({ transitionId: "" }),
      ).ok,
    ).toBe(false);
    expect(
      parseControlBody(
        "model-transition",
        modelTransitionBody({
          to: { provider: "x".repeat(257), id: "model-b" },
        }),
      ).ok,
    ).toBe(false);
  });

  it("rejects accessor-backed bodies before schema validation", () => {
    const body = modelTransitionBody();
    Object.defineProperty(body, "phase", {
      enumerable: true,
      get: () => {
        throw new Error("accessor must not run");
      },
    });
    expect(parseControlBody("model-transition", body).ok).toBe(false);
  });
});

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

describe("shared diagnostic projection policy", () => {
  const OVERSIZED = MAX_DIAGNOSTIC_REASON_BYTES + 4_096;

  it("accepts ordinary 2,001-character cancel and error reasons", () => {
    // The old cap was 2,000 UTF-16 characters, so this exact input was
    // rejected before any projection could shorten it.
    const reason = "x".repeat(2_001);
    expect(parseControlBody("cancel", { reason }).ok).toBe(true);
    expect(parseControlBody("error", { reason }).ok).toBe(true);
  });

  it("accepts cancel and error reasons at the exact byte boundary and refuses one byte past it", () => {
    const exact = "a".repeat(MAX_DIAGNOSTIC_REASON_BYTES);
    for (const kind of ["cancel", "error"] as const) {
      expect(parseControlBody(kind, { reason: exact }).ok).toBe(true);
      expect(parseControlBody(kind, { reason: `${exact}a` }).ok).toBe(false);
    }
  });

  it("measures multibyte reasons in UTF-8 bytes, not UTF-16 units", () => {
    // 8,192 code points, 32,768 UTF-8 bytes: exactly the budget.
    const exact = "🙂".repeat(MAX_DIAGNOSTIC_REASON_BYTES / 4);
    expect(exact.length).toBeLessThan(MAX_DIAGNOSTIC_REASON_BYTES);
    expect(parseControlBody("cancel", { reason: exact }).ok).toBe(true);
    expect(parseControlBody("error", { reason: `${exact}🙂` }).ok).toBe(false);
  });

  it("projects oversized cancel and error reasons into a body the schema accepts", () => {
    const body = makeCancelBody("é".repeat(OVERSIZED));
    expect(parseControlBody("cancel", body).ok).toBe(true);
    expect(body.reason).toEndWith(DIAGNOSTIC_TRUNCATION_MARKER);
    const errorBody = makeErrorBody("é".repeat(OVERSIZED));
    expect(parseControlBody("error", errorBody).ok).toBe(true);
    expect(errorBody.reason).toEndWith(DIAGNOSTIC_TRUNCATION_MARKER);
  });

  it("never splits a multibyte code point and never overflows the budget", () => {
    // 3-byte and 4-byte code points, so a naive byte cut lands mid-character
    // at nearly every offset.
    for (const glyph of ["🙂", "→", "é"]) {
      const projected = projectDiagnosticText(glyph.repeat(OVERSIZED));
      const bytes = new TextEncoder().encode(projected);
      expect(bytes.byteLength).toBeLessThanOrEqual(
        MAX_DIAGNOSTIC_REASON_BYTES,
      );
      expect(projected).not.toInclude("\uFFFD");
      expect(projected).toEndWith(DIAGNOSTIC_TRUNCATION_MARKER);
      // The kept prefix is a whole number of the original code points.
      const kept = projected.slice(0, -DIAGNOSTIC_TRUNCATION_MARKER.length);
      expect(kept).toBe(glyph.repeat([...kept].length));
    }
  });

  it("returns input unchanged when it already fits, at the exact boundary", () => {
    const exact = "🙂".repeat(MAX_DIAGNOSTIC_REASON_BYTES / 4);
    expect(projectDiagnosticText(exact)).toBe(exact);
    expect(fitsDiagnosticBudget(exact)).toBe(true);
    expect(fitsDiagnosticBudget(`${exact}🙂`)).toBe(false);
    expect(projectDiagnosticText(`${exact}🙂`)).not.toBe(`${exact}🙂`);
  });

  it("preserves the typed failure code when settlement prose is oversized", () => {
    const parsed = parseControlBody("settled", {
      outcome: "failed",
      reason: projectDiagnosticText("🙂".repeat(OVERSIZED)),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.outcome).toBe("failed");
  });
});
