import { describe, expect, it } from "bun:test";
import {
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

describe("BootstrapBodySchema composedPrompt bound", () => {
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
});

describe("BootstrapBodySchema delegation trigger metadata", () => {
  it("accepts the engine's optional routing_hint on a delegation target trigger", () => {
    const result = parseControlBody("bootstrap", {
      agentName: "tapestry",
      composedPrompt: "Delegate every implementation task.",
      models: [],
      delegationTargets: [
        {
          name: "shuttle",
          description: "Shuttle (Domain Specialist)",
          triggers: [
            {
              domain: "Implementation",
              trigger: "Bounded coding tasks",
              routing_hint: "Use for clearly scoped implementation tasks",
            },
          ],
          isCategory: false,
        },
      ],
      ...REQUIRED_BOOTSTRAP_FIELDS,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a routing_hint over the private-control bound", () => {
    const result = parseControlBody("bootstrap", {
      agentName: "tapestry",
      composedPrompt: "Delegate every implementation task.",
      models: [],
      delegationTargets: [
        {
          name: "shuttle",
          triggers: [
            {
              domain: "Implementation",
              trigger: "Bounded coding tasks",
              routing_hint: "x".repeat(1_025),
            },
          ],
          isCategory: false,
        },
      ],
      ...REQUIRED_BOOTSTRAP_FIELDS,
    });
    expect(result.ok).toBe(false);
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
