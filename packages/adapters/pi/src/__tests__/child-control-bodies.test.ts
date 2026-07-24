import { describe, expect, it } from "bun:test";
import { parseControlBody } from "../child-control-bodies.js";
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
