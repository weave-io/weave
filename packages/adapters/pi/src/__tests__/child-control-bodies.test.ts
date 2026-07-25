import { describe, expect, it } from "bun:test";
import {
  parseControlBody,
  toModelIdentityBody,
} from "../child-control-bodies.js";
import { MAX_CONTROL_BODY_BYTES } from "../child-envelope.js";
import { MAX_TASK_INPUT_CHARS } from "../delegation-limits.js";

// Half of the envelope's own 64KiB control-body byte cap - see the
// `MAX_COMPOSED_PROMPT_LENGTH` doc comment in child-control-bodies.ts for
// why this is the chosen bound (leaves headroom for every other bootstrap
// field plus JSON structural overhead within the same envelope).
const MAX_COMPOSED_PROMPT_LENGTH = MAX_CONTROL_BODY_BYTES / 2;

// The bounded correlation/context/active-tools fields (Spec 33 §11.2 Task
// 9) are required on every bootstrap body regardless of composedPrompt
// size - shared here so these composedPrompt-focused bound tests don't
// have to restate them.
const REQUIRED_BOOTSTRAP_FIELDS = {
  mode: "ordinary" as const,
  correlationId: "child-1",
  context: { parentAgentName: "loom", parentDepth: 0, cwd: "/project" },
  activeTools: [],
};

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

describe("DelegateRequestBodySchema.task bound (Spec 33 \u00a711.2 Task 9 unification)", () => {
  // A live child relaying its own nested `delegate-request` must be held to
  // the exact same `MAX_TASK_INPUT_CHARS` bound enforced at tool parsing
  // (`delegation-tool.ts`), the controller (`delegation-controller.ts`),
  // and RPC prompt send (`rpc-child.ts`) - never a looser transport-schema
  // limit that would let a nested delegation smuggle a larger task through
  // than an ordinary top-level `weave_delegate` tool call ever could.
  it("accepts a task exactly at MAX_TASK_INPUT_CHARS", () => {
    const result = parseControlBody("delegate-request", {
      agentName: "shuttle",
      task: "a".repeat(MAX_TASK_INPUT_CHARS),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a task one character over MAX_TASK_INPUT_CHARS", () => {
    const result = parseControlBody("delegate-request", {
      agentName: "shuttle",
      task: "a".repeat(MAX_TASK_INPUT_CHARS + 1),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an empty task", () => {
    const result = parseControlBody("delegate-request", {
      agentName: "shuttle",
      task: "",
    });
    expect(result.ok).toBe(false);
  });
});

// Spec 33 §11.2 finding 2: a real host-supplied model object (`ctx.model`,
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
      activeTools: [],
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
      activeTools: [],
      resolvedModel: hostModel,
    });
    expect(result.ok).toBe(false);
  });
});
