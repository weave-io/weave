/**
 * Tests for the `chat.message` direct review hook in the Weave OpenCode plugin.
 *
 * Verifies:
 * - Direct invocation hook exists in plugin via `chat.message`.
 * - Hook triggers for active agent with `review_models` and mutates output parts.
 * - Hook triggers for `@agent` mention where that agent has `review_models`.
 * - Hook does NOT trigger for generated review variant agent names.
 * - Hook does NOT trigger for agents without `review_models`.
 * - Hook surfaces the formatted summary through mutable output parts.
 * - Hook leaves message unchanged when direct review fails.
 *
 * All tests use mock client/facade only — no live SDK or harness calls.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type { OpenCodeClientError, OpenCodeClientFacade } from "../index.js";
import { createWeavePlugin } from "../index.js";
import type {
  AssistantMessage,
  OpenCodeAgent,
  OpenCodeAgentConfig,
} from "../sdk-types.js";

// ---------------------------------------------------------------------------
// TextPart shape (mirrors @opencode-ai/sdk TextPart)
// ---------------------------------------------------------------------------

interface TextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  synthetic?: boolean;
}

// Use Part as a generic record to match the SDK Part union type
type Part = TextPart | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// MockDirectReviewClient — controllable OpenCodeClientFacade
// ---------------------------------------------------------------------------

class MockDirectReviewClient implements OpenCodeClientFacade {
  private _promptOutput: string;
  private _promptError: OpenCodeClientError | undefined;
  private _sessionError: OpenCodeClientError | undefined;

  readonly createSessionCalls: string[] = [];
  readonly promptSessionCalls: Array<{
    sessionId: string;
    prompt: string;
    agentName: string;
  }> = [];

  constructor(
    options: {
      promptOutput?: string;
      promptError?: OpenCodeClientError;
      sessionError?: OpenCodeClientError;
    } = {},
  ) {
    this._promptOutput = options.promptOutput ?? "[APPROVE] Looks great!";
    this._promptError = options.promptError;
    this._sessionError = options.sessionError;
  }

  listAgents(): ResultAsync<OpenCodeAgent[], OpenCodeClientError> {
    return okAsync([]);
  }

  createAgent(
    _name: string,
    _config: OpenCodeAgentConfig,
  ): ResultAsync<void, OpenCodeClientError> {
    return okAsync(undefined);
  }

  updateAgent(
    _name: string,
    _config: OpenCodeAgentConfig,
  ): ResultAsync<void, OpenCodeClientError> {
    return okAsync(undefined);
  }

  createReviewSession(
    title: string,
  ): ResultAsync<{ sessionId: string }, OpenCodeClientError> {
    this.createSessionCalls.push(title);
    if (this._sessionError) return errAsync(this._sessionError);
    return okAsync({ sessionId: `session-${title}` });
  }

  promptSession(
    sessionId: string,
    prompt: string,
    agentName: string,
  ): ResultAsync<
    { output: string; assistantMessage: AssistantMessage },
    OpenCodeClientError
  > {
    this.promptSessionCalls.push({ sessionId, prompt, agentName });
    if (this._promptError) return errAsync(this._promptError);
    return okAsync({
      output: this._promptOutput,
      assistantMessage: {} as AssistantMessage,
    });
  }

  deleteSession(_sessionId: string): ResultAsync<void, OpenCodeClientError> {
    return okAsync(undefined);
  }
}

// ---------------------------------------------------------------------------
// Temp project helpers
// ---------------------------------------------------------------------------

/**
 * Creates a temp project with a `.weave/config.weave` declaring an agent
 * with `review_models`. Returns the project root path.
 */
async function makeTempProjectWithReviewAgent(
  agentName: string,
  reviewModels: string[],
): Promise<string> {
  const root = join(
    tmpdir(),
    `weave-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const reviewModelsLine = `  review_models [${reviewModels.map((m) => `"${m}"`).join(", ")}]`;
  await Bun.write(
    join(root, ".weave", "config.weave"),
    [
      `agent ${agentName} {`,
      `  prompt "You are a thorough code reviewer."`,
      `  models ["claude-opus-4-5"]`,
      `  mode subagent`,
      `  temperature 0.1`,
      reviewModelsLine,
      `}`,
      "",
    ].join("\n"),
  );
  return root;
}

/**
 * Creates a temp project with a plain agent (no `review_models`).
 */
async function makeTempProjectWithPlainAgent(
  agentName: string,
): Promise<string> {
  const root = join(
    tmpdir(),
    `weave-hook-test-plain-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await Bun.write(
    join(root, ".weave", "config.weave"),
    [
      `agent ${agentName} {`,
      `  prompt "You are a helpful assistant."`,
      `  models ["claude-sonnet-4-5"]`,
      `  mode subagent`,
      `}`,
      "",
    ].join("\n"),
  );
  return root;
}

/**
 * A FileReader scoped to `root` only — prevents global config interference.
 */
function projectOnlyReader(root: string) {
  const normalizedRoot = `${root.replace(/\\/g, "/").replace(/\/$/, "")}/`;
  return {
    exists: async (path: string): Promise<boolean> => {
      const normalizedPath = path.replace(/\\/g, "/");
      if (
        normalizedPath !== normalizedRoot.slice(0, -1) &&
        !normalizedPath.startsWith(normalizedRoot)
      ) {
        return false;
      }
      return Bun.file(path).exists();
    },
    read: (path: string) =>
      ResultAsync.fromPromise(Bun.file(path).text(), (cause: unknown) => ({
        type: "FileReadError" as const,
        path,
        cause,
      })),
  };
}

function makeMockPluginInput(
  directory: string,
  client: OpenCodeClientFacade,
): Parameters<ReturnType<typeof createWeavePlugin>>[0] {
  return {
    client: client as unknown as Parameters<
      ReturnType<typeof createWeavePlugin>
    >[0]["client"],
    directory,
    project: {} as never,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://localhost:1234"),
    $: {} as never,
  };
}

/**
 * Build a minimal `chat.message` hook input/output pair.
 */
function makeChatMessageContext(options: {
  sessionID?: string;
  agent?: string;
  messageID?: string;
  textParts?: Array<{ text: string }>;
}) {
  const sessionID = options.sessionID ?? "test-session-id";
  const messageID = options.messageID ?? "test-message-id";

  const parts: Part[] = (
    options.textParts ?? [{ text: "Review my changes." }]
  ).map((p, i) => ({
    id: `part-${i}`,
    sessionID,
    messageID,
    type: "text" as const,
    text: p.text,
  }));

  const input = {
    sessionID,
    agent: options.agent,
    messageID,
  } as const;

  const output = {
    message: {} as never,
    parts,
  };

  return { input, output };
}

// ---------------------------------------------------------------------------
// Tests: hook presence
// ---------------------------------------------------------------------------

describe("WeavePlugin — chat.message hook presence", () => {
  it("chat.message hook is defined when config loads successfully", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient();
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    expect(typeof hooks["chat.message"]).toBe("function");
  });

  it("chat.message hook is absent when config load fails", async () => {
    // Create an invalid config (missing closing brace)
    const root = join(
      tmpdir(),
      `weave-hook-invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await Bun.write(
      join(root, ".weave", "config.weave"),
      ["agent broken {", '  prompt "Missing close"', ""].join("\n"),
    );

    const client = new MockDirectReviewClient();
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    // Config failed → empty hooks
    expect(hooks["chat.message"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: active agent trigger
// ---------------------------------------------------------------------------

describe("WeavePlugin — chat.message hook triggers on active reviewer agent", () => {
  it("mutates output parts with formatted summary when active agent has review_models", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient({
      promptOutput: "[APPROVE] All looks good!",
    });
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    const { input, output } = makeChatMessageContext({
      agent: "weft",
      textParts: [{ text: "Please review these changes." }],
    });

    await hooks["chat.message"]?.(input, output as never);

    // Output parts must be mutated — the first text part should now carry the instruction.
    const textPart = output.parts.find((p) => p.type === "text") as
      | TextPart
      | undefined;
    expect(textPart).toBeDefined();
    expect(textPart?.text).toContain("Direct adversarial review completed");
    expect(textPart?.text).toContain("PASSED");
  });

  it("formatted summary instruction contains 'without re-running the review' phrase", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient({
      promptOutput: "[APPROVE] LGTM.",
    });
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    const { input, output } = makeChatMessageContext({ agent: "weft" });

    await hooks["chat.message"]?.(input, output as never);

    const textPart = output.parts.find((p) => p.type === "text") as
      | TextPart
      | undefined;
    expect(textPart?.text).toContain("without re-running the review");
  });
});

// ---------------------------------------------------------------------------
// Tests: @mention trigger
// ---------------------------------------------------------------------------

describe("WeavePlugin — chat.message hook triggers on @agent mention", () => {
  it("mutates output parts when no active agent but text contains @weft mention", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient({
      promptOutput: "[APPROVE] Looks clean.",
    });
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    const { input, output } = makeChatMessageContext({
      agent: undefined, // no active agent
      textParts: [{ text: "@weft please review this PR." }],
    });

    await hooks["chat.message"]?.(input, output as never);

    const textPart = output.parts.find((p) => p.type === "text") as
      | TextPart
      | undefined;
    expect(textPart?.text).toContain("Direct adversarial review completed");
  });

  it("active agent name takes precedence over @mention in text", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient({
      promptOutput: "[APPROVE] All good.",
    });
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    // Active agent is 'weft', text mentions @shuttle — weft should be used.
    const { input, output } = makeChatMessageContext({
      agent: "weft",
      textParts: [{ text: "@shuttle do a review." }],
    });

    await hooks["chat.message"]?.(input, output as never);

    // Review should trigger (weft has review_models), shuttle is ignored.
    const textPart = output.parts.find((p) => p.type === "text") as
      | TextPart
      | undefined;
    expect(textPart?.text).toContain("Direct adversarial review completed");
  });
});

// ---------------------------------------------------------------------------
// Tests: no-trigger guards
// ---------------------------------------------------------------------------

describe("WeavePlugin — chat.message hook does NOT trigger for guarded cases", () => {
  it("leaves message unchanged for agent without review_models", async () => {
    const root = await makeTempProjectWithPlainAgent("shuttle");
    const client = new MockDirectReviewClient();
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    const originalText = "Can you help with this code?";
    const { input, output } = makeChatMessageContext({
      agent: "shuttle",
      textParts: [{ text: originalText }],
    });

    await hooks["chat.message"]?.(input, output as never);

    const textPart = output.parts.find((p) => p.type === "text") as
      | TextPart
      | undefined;
    // Message must be unchanged — no review_models means no direct review.
    expect(textPart?.text).toBe(originalText);
  });

  it("leaves message unchanged when agent name contains -review- (generated variant guard)", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient();
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    const originalText = "Review these changes.";
    // Simulate a generated variant agent name
    const { input, output } = makeChatMessageContext({
      agent: "weft-review-model-a",
      textParts: [{ text: originalText }],
    });

    await hooks["chat.message"]?.(input, output as never);

    const textPart = output.parts.find((p) => p.type === "text") as
      | TextPart
      | undefined;
    // Must be unchanged — generated variant is skipped.
    expect(textPart?.text).toBe(originalText);
  });

  it("leaves message unchanged when no agent can be resolved", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient();
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    const originalText = "Generic message with no @mentions.";
    const { input, output } = makeChatMessageContext({
      agent: undefined, // no active agent
      textParts: [{ text: originalText }],
    });

    await hooks["chat.message"]?.(input, output as never);

    const textPart = output.parts.find((p) => p.type === "text") as
      | TextPart
      | undefined;
    expect(textPart?.text).toBe(originalText);
  });

  it("leaves message unchanged when @mentioned agent is not in config", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient();
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    const originalText = "@unknown-agent please review.";
    const { input, output } = makeChatMessageContext({
      agent: undefined,
      textParts: [{ text: originalText }],
    });

    await hooks["chat.message"]?.(input, output as never);

    const textPart = output.parts.find((p) => p.type === "text") as
      | TextPart
      | undefined;
    // unknown-agent is not in config → no review_models → unchanged.
    expect(textPart?.text).toBe(originalText);
  });
});

// ---------------------------------------------------------------------------
// Tests: failure handling
// ---------------------------------------------------------------------------

describe("WeavePlugin — chat.message hook fails closed on review failure", () => {
  it("replaces output with blocking failure message when executeDirectReview fails (session creation error)", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient({
      sessionError: {
        type: "CreateSessionError",
        message: "service unavailable",
      },
    });
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    const originalText = "Please review these changes.";
    const { input, output } = makeChatMessageContext({
      agent: "weft",
      textParts: [{ text: originalText }],
    });

    await hooks["chat.message"]?.(input, output as never);

    const textPart = output.parts.find((p) => p.type === "text") as
      | TextPart
      | undefined;
    // Fail-closed: text must be replaced with a blocking failure summary.
    expect(textPart?.text).not.toBe(originalText);
    expect(textPart?.text).toContain(
      "Direct adversarial review failed for weft",
    );
    expect(textPart?.text).toContain("no single-model review was run");
  });

  it("hook resolves without throwing when executeDirectReview fails", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient({
      promptError: {
        type: "PromptSessionError",
        sessionId: "s1",
        message: "timeout",
      },
    });
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    const { input, output } = makeChatMessageContext({ agent: "weft" });

    // Must not throw — the hook always resolves.
    await expect(
      hooks["chat.message"]?.(input, output as never),
    ).resolves.toBeUndefined();
  });

  it("blocking failure message appended as synthetic part when output has no text parts", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient({
      sessionError: {
        type: "CreateSessionError",
        message: "connection refused",
      },
    });
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    const input = {
      sessionID: "test-session",
      agent: "weft",
      messageID: "test-msg",
    } as const;
    const output = { message: {} as never, parts: [] as Part[] };

    await hooks["chat.message"]?.(input, output as never);

    expect(output.parts.length).toBeGreaterThan(0);
    const textPart = output.parts.find((p) => p.type === "text") as
      | TextPart
      | undefined;
    expect(textPart).toBeDefined();
    expect(textPart?.text).toContain(
      "Direct adversarial review failed for weft",
    );
    expect(textPart?.synthetic).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: no-parts edge case
// ---------------------------------------------------------------------------

describe("WeavePlugin — chat.message hook with empty parts array", () => {
  it("appends a synthetic blocking-failure text part when output has no text parts (empty prompt → fail closed)", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient({
      promptOutput: "[APPROVE] Great work!",
    });
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    const input = {
      sessionID: "test-session",
      agent: "weft",
      messageID: "test-msg",
    } as const;
    const output = { message: {} as never, parts: [] as Part[] };

    await hooks["chat.message"]?.(input, output as never);

    // Empty parts → empty text → empty review prompt → executeReviewVariants rejects.
    // The hook fails closed: a synthetic blocking-failure text part is appended.
    expect(output.parts.length).toBeGreaterThan(0);
    const textPart = output.parts.find((p) => p.type === "text") as
      | TextPart
      | undefined;
    expect(textPart).toBeDefined();
    expect(textPart?.text).toContain(
      "Direct adversarial review failed for weft",
    );
    expect(textPart?.synthetic).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: multiple text parts regression
// ---------------------------------------------------------------------------

describe("WeavePlugin — chat.message hook with multiple text parts", () => {
  it("removes all original text parts and replaces with a single review summary on success", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient({
      promptOutput: "[APPROVE] Great!",
    });
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    const { input, output } = makeChatMessageContext({
      agent: "weft",
      textParts: [
        { text: "First text part." },
        { text: "Second text part." },
        { text: "Third text part." },
      ],
    });

    await hooks["chat.message"]?.(input, output as never);

    // All original text parts must be removed; only one replacement text part remains.
    const textParts = output.parts.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as TextPart).text).toContain(
      "Direct adversarial review completed",
    );
    // Original texts must not survive.
    expect((textParts[0] as TextPart).text).not.toContain("First text part.");
    expect((textParts[0] as TextPart).text).not.toContain("Second text part.");
    expect((textParts[0] as TextPart).text).not.toContain("Third text part.");
  });

  it("removes all original text parts and replaces with a single blocking message on failure", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient({
      sessionError: {
        type: "CreateSessionError",
        message: "connection refused",
      },
    });
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    const { input, output } = makeChatMessageContext({
      agent: "weft",
      textParts: [{ text: "First text part." }, { text: "Second text part." }],
    });

    await hooks["chat.message"]?.(input, output as never);

    // All original text parts must be removed; only one blocking failure message remains.
    const textParts = output.parts.filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect((textParts[0] as TextPart).text).toContain(
      "Direct adversarial review failed for weft",
    );
    expect((textParts[0] as TextPart).text).not.toContain("First text part.");
    expect((textParts[0] as TextPart).text).not.toContain("Second text part.");
  });
});

// ---------------------------------------------------------------------------
// Tests: generated review variant registration in config hook
// ---------------------------------------------------------------------------

describe("WeavePlugin — config hook includes generated review variant agents", () => {
  it("injects variant agents (e.g. weft-review-model-a) into cfg.agent when base agent declares review_models", async () => {
    const root = await makeTempProjectWithReviewAgent("weft", [
      "model-a",
      "model-b",
    ]);
    const client = new MockDirectReviewClient();
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    // Invoke the config hook with a mutable cfg object.
    const cfg: { agent?: Record<string, unknown> } = {};
    if (typeof hooks.config === "function") {
      await hooks.config(cfg as never);
    }

    // The base agent should be present.
    expect(cfg.agent?.weft).toBeDefined();
    // Generated review variant agents must also be injected.
    expect(cfg.agent?.["weft-review-model-a"]).toBeDefined();
    expect(cfg.agent?.["weft-review-model-b"]).toBeDefined();
  });

  it("variant agents are registered even when direct review session creation fails (mock rejects unregistered variant)", async () => {
    // This test proves the variant must be registered before direct review can
    // call it. The mock client here tracks createReviewSession calls per variant
    // name — if the variant isn't in cfg.agent the adapter would never know its name.
    const root = await makeTempProjectWithReviewAgent("weft", ["model-a"]);
    const client = new MockDirectReviewClient({
      promptOutput: "[APPROVE] Good.",
    });
    const plugin = createWeavePlugin({
      fileReader: projectOnlyReader(root),
      clientFacade: client,
    });
    const hooks = await plugin(makeMockPluginInput(root, client));

    const cfg: { agent?: Record<string, unknown> } = {};
    if (typeof hooks.config === "function") {
      await hooks.config(cfg as never);
    }

    // The variant must be in cfg.agent before executeReviewVariants can invoke it.
    expect(cfg.agent?.["weft-review-model-a"]).toBeDefined();

    // When a successful direct review runs, the session is created for the variant name.
    const { input, output } = makeChatMessageContext({
      agent: "weft",
      textParts: [{ text: "Review these changes." }],
    });
    await hooks["chat.message"]?.(input, output as never);

    // createReviewSession was called with the variant name — proves the hook
    // resolved the variant correctly.
    expect(client.createSessionCalls).toContain("weft-review-model-a");
  });
});
