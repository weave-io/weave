import { describe, expect, it } from "bun:test";
import {
  CHILD_OVERLAY_TELEMETRY_BOUNDS,
  type ChildOverlayView,
  createChildOverlayController,
  createMemoryChildOverlaySource,
  type MemoryOverlaySourceChild,
} from "../child-overlay.js";
import {
  MAX_CHILD_USAGE_MODEL_LENGTH,
  MAX_CHILD_USAGE_TOKENS,
  parsePiChildSessionEvent,
  parsePiChildUsageReport,
} from "../child-session-events.js";

/**
 * Bounded telemetry projection tests (plan Task 5).
 *
 * The mapped Pi 0.83 shapes under test are documented on
 * `parsePiChildUsageReport`: `Usage` (`input`, `output`, `cacheRead`,
 * `cacheWrite`, `reasoning`, `totalTokens`), `ContextUsage` (`tokens`,
 * `contextWindow`), and `AssistantMessage.model`.
 */

function liveChild(
  partial: Partial<MemoryOverlaySourceChild> &
    Pick<MemoryOverlaySourceChild, "childId">,
): MemoryOverlaySourceChild {
  return {
    childId: partial.childId,
    threadId: partial.threadId ?? partial.childId,
    status: partial.status ?? "live",
    title: partial.title,
    generationId: partial.generationId,
    parentChildId: partial.parentChildId,
    runs: partial.runs ?? [{ run: 1, action: "start" }],
    branchIds: partial.branchIds ?? ["main"],
    descendantChildIds: partial.descendantChildIds ?? [],
    entries: partial.entries ?? [],
  };
}

async function openController(
  children: readonly MemoryOverlaySourceChild[],
  childId: string,
): Promise<{
  controller: ReturnType<typeof createChildOverlayController>;
  view: ChildOverlayView;
}> {
  const controller = createChildOverlayController(
    createMemoryChildOverlaySource(children),
  );
  const opened = await controller.open(childId);
  expect(opened.isOk()).toBe(true);
  return { controller, view: opened._unsafeUnwrap() };
}

function apply(
  controller: ReturnType<typeof createChildOverlayController>,
  event: unknown,
): ChildOverlayView {
  const applied = controller.applyLiveEvent(event);
  expect(applied.isOk()).toBe(true);
  return applied._unsafeUnwrap();
}

const usageEvent = (usage: unknown, extra: Record<string, unknown> = {}) => ({
  type: "usage",
  usage,
  ...extra,
});

/**
 * A real Pi 0.83 / 0.84 `message_end` payload: `message` is the pi-ai
 * `AssistantMessage`, so the token accounting lives on `message.usage` and the
 * model label on `message.model` / `message.responseModel`.
 */
const messageEndEvent = (
  message: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  type: "message_end",
  message: {
    id: "msg_01HQ",
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    stopReason: "stop",
    content: [{ type: "text", text: "done" }],
    ...message,
  },
  ...extra,
});

/** A persisted native session entry holding the same assistant message. */
const nativeAssistantEntry = (
  id: string,
  message: Record<string, unknown>,
) => ({
  id,
  payload: {
    type: "message",
    id,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "historical answer" }],
      ...message,
    },
  },
});

describe("child overlay usage report parsing", () => {
  it("narrows a valid Pi 0.83 usage payload into bounded fields", () => {
    const parsed = parsePiChildSessionEvent(
      usageEvent(
        {
          input: 120,
          output: 40,
          cacheRead: 7,
          cacheWrite: 3,
          reasoning: 11,
          totalTokens: 170,
          context: { tokens: 5_000, contextWindow: 20_000, percent: 99 },
        },
        { model: "anthropic/claude-sonnet-5" },
      ),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const report = parsePiChildUsageReport(parsed.data);
    expect(report.isOk()).toBe(true);
    expect(report._unsafeUnwrap()).toEqual({
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 7,
      cacheWriteTokens: 3,
      reasoningTokens: 11,
      totalTokens: 170,
      contextTokens: 5_000,
      contextWindow: 20_000,
      model: "anthropic/claude-sonnet-5",
    });
  });

  it("returns a typed failure, never a throw, when no usage object exists", () => {
    const parsed = parsePiChildSessionEvent(usageEvent(undefined));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const report = parsePiChildUsageReport(parsed.data);
    expect(report.isErr()).toBe(true);
    expect(report._unsafeUnwrapErr()).toEqual({ type: "UsageUnavailable" });
  });

  it("returns a typed failure for an event that carries no usage", () => {
    const parsed = parsePiChildSessionEvent({ type: "text", text: "hi" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const report = parsePiChildUsageReport(parsed.data);
    expect(report.isErr()).toBe(true);
  });

  it("narrows a real Pi message_end assistant message into bounded fields", () => {
    const parsed = parsePiChildSessionEvent(
      messageEndEvent({
        model: "anthropic/claude-sonnet-5",
        responseModel: "claude-sonnet-5-20260101",
        usage: {
          input: 1_240,
          output: 310,
          cacheRead: 96,
          cacheWrite: 12,
          cacheWrite1h: 4,
          reasoning: 120,
          totalTokens: 1_682,
          cost: { input: 0.1, output: 0.2, total: 0.3 },
        },
        contextUsage: { tokens: 8_000, contextWindow: 200_000, percent: 77 },
      }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const report = parsePiChildUsageReport(parsed.data);
    expect(report.isOk()).toBe(true);
    expect(report._unsafeUnwrap()).toEqual({
      inputTokens: 1_240,
      outputTokens: 310,
      cacheReadTokens: 96,
      cacheWriteTokens: 12,
      reasoningTokens: 120,
      totalTokens: 1_682,
      contextTokens: 8_000,
      contextWindow: 200_000,
      // `model` wins over `responseModel`; cost is money, never projected.
      model: "anthropic/claude-sonnet-5",
    });
  });

  it("reports a message_end without a usage object as unavailable", () => {
    const parsed = parsePiChildSessionEvent(
      messageEndEvent({ model: "openai/gpt-5.6" }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const report = parsePiChildUsageReport(parsed.data);
    expect(report.isErr()).toBe(true);
    expect(report._unsafeUnwrapErr()).toEqual({ type: "UsageUnavailable" });
  });

  it("ignores usage on a non-assistant message_end message", () => {
    const parsed = parsePiChildSessionEvent(
      messageEndEvent({ role: "user", usage: { input: 5, totalTokens: 5 } }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsePiChildUsageReport(parsed.data).isErr()).toBe(true);
  });

  it("drops malformed and overbound message_end usage fields individually", () => {
    const parsed = parsePiChildSessionEvent(
      messageEndEvent({
        model: "y".repeat(MAX_CHILD_USAGE_MODEL_LENGTH + 1),
        usage: {
          input: "many",
          output: -3,
          cacheRead: 1.5,
          cacheWrite: MAX_CHILD_USAGE_TOKENS + 1,
          reasoning: null,
          totalTokens: 88,
        },
        contextUsage: { tokens: true, contextWindow: "200k" },
      }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const report = parsePiChildUsageReport(parsed.data)._unsafeUnwrap();
    expect(report.inputTokens).toBeUndefined();
    expect(report.outputTokens).toBeUndefined();
    expect(report.cacheReadTokens).toBeUndefined();
    expect(report.cacheWriteTokens).toBeUndefined();
    expect(report.reasoningTokens).toBeUndefined();
    expect(report.contextTokens).toBeUndefined();
    expect(report.contextWindow).toBeUndefined();
    expect(report.model).toBeUndefined();
    expect(report.totalTokens).toBe(88);
  });

  it("drops malformed and oversized fields individually", () => {
    const parsed = parsePiChildSessionEvent(
      usageEvent({
        input: "many",
        output: -3,
        cacheRead: 1.5,
        cacheWrite: MAX_CHILD_USAGE_TOKENS + 1,
        reasoning: true,
        totalTokens: 12,
        context: { tokens: null, contextWindow: -1 },
        model: "x".repeat(MAX_CHILD_USAGE_MODEL_LENGTH + 1),
      }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const report = parsePiChildUsageReport(parsed.data)._unsafeUnwrap();
    expect(report.inputTokens).toBeUndefined();
    expect(report.outputTokens).toBeUndefined();
    expect(report.cacheReadTokens).toBeUndefined();
    expect(report.cacheWriteTokens).toBeUndefined();
    expect(report.reasoningTokens).toBeUndefined();
    expect(report.contextTokens).toBeUndefined();
    expect(report.contextWindow).toBeUndefined();
    expect(report.model).toBeUndefined();
    // A well-formed sibling still survives beside malformed neighbours.
    expect(report.totalTokens).toBe(12);
  });

  it("pins the view bounds to the parser bounds", () => {
    expect(CHILD_OVERLAY_TELEMETRY_BOUNDS.maxTokens).toBe(
      MAX_CHILD_USAGE_TOKENS,
    );
    expect(CHILD_OVERLAY_TELEMETRY_BOUNDS.maxModelLength).toBe(
      MAX_CHILD_USAGE_MODEL_LENGTH,
    );
  });
});

describe("child overlay telemetry projection", () => {
  it("projects a valid live usage report onto the view", async () => {
    const { controller } = await openController(
      [liveChild({ childId: "c1" })],
      "c1",
    );
    const view = apply(
      controller,
      usageEvent(
        {
          input: 100,
          output: 25,
          totalTokens: 125,
          context: { tokens: 4_000, contextWindow: 16_000 },
        },
        { model: "openai/gpt-5.6" },
      ),
    );
    expect(view.telemetry).toEqual({
      provider: "openai",
      model: "openai/gpt-5.6",
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      reasoningTokens: undefined,
      totalTokens: 125,
      contextTokens: 4_000,
      contextWindow: 16_000,
      contextPercent: 25,
    });
  });

  it("has no telemetry when the host reported nothing", async () => {
    const { view } = await openController(
      [liveChild({ childId: "c1", runs: [{ run: 1, action: "start" }] })],
      "c1",
    );
    expect(view.telemetry).toBeUndefined();
  });

  it("leaves fields absent for a malformed payload instead of throwing", async () => {
    const { controller } = await openController(
      [liveChild({ childId: "c1" })],
      "c1",
    );
    const view = apply(
      controller,
      usageEvent({
        input: "lots",
        output: -1,
        totalTokens: MAX_CHILD_USAGE_TOKENS + 5,
        context: { tokens: 10 },
      }),
    );
    expect(view.telemetry?.inputTokens).toBeUndefined();
    expect(view.telemetry?.outputTokens).toBeUndefined();
    expect(view.telemetry?.totalTokens).toBeUndefined();
    expect(view.telemetry?.model).toBeUndefined();
    expect(view.telemetry?.contextTokens).toBe(10);
  });

  it("keeps every field absent when nothing in the payload is usable", async () => {
    const { controller } = await openController(
      [liveChild({ childId: "c1", runs: [] })],
      "c1",
    );
    const view = apply(controller, usageEvent({ input: {}, output: [] }));
    expect(view.telemetry).toBeUndefined();
  });

  it("replaces prior telemetry with the latest report and never sums", async () => {
    const { controller } = await openController(
      [liveChild({ childId: "c1" })],
      "c1",
    );
    apply(controller, usageEvent({ input: 100, output: 10, totalTokens: 110 }));
    const view = apply(
      controller,
      usageEvent({ input: 5, output: 1, totalTokens: 6 }),
    );
    expect(view.telemetry?.inputTokens).toBe(5);
    expect(view.telemetry?.outputTokens).toBe(1);
    expect(view.telemetry?.totalTokens).toBe(6);
  });

  it("isolates telemetry per child", async () => {
    const controller = createChildOverlayController(
      createMemoryChildOverlaySource([
        liveChild({ childId: "c1" }),
        liveChild({ childId: "c2" }),
      ]),
    );
    const first = await controller.open("c1");
    expect(first.isOk()).toBe(true);
    apply(controller, usageEvent({ input: 42, totalTokens: 42 }));

    const second = await controller.open("c2");
    expect(second.isOk()).toBe(true);
    expect(second._unsafeUnwrap().telemetry).toBeUndefined();

    const reopened = await controller.open("c1");
    expect(reopened.isOk()).toBe(true);
    expect(reopened._unsafeUnwrap().telemetry?.inputTokens).toBe(42);
  });

  it("omits the provider when the model identifier is ambiguous", async () => {
    const { controller } = await openController(
      [liveChild({ childId: "c1" })],
      "c1",
    );
    for (const model of [
      "gpt-5.6",
      "vendor/team/model",
      "/leading",
      "trailing/",
    ]) {
      const view = apply(controller, usageEvent({ totalTokens: 1 }, { model }));
      expect(view.telemetry?.model).toBe(model);
      expect(view.telemetry?.provider).toBeUndefined();
    }
  });

  it("falls back to the authoritative descriptor model label", async () => {
    const { controller, view: opened } = await openController(
      [
        liveChild({
          childId: "c1",
          runs: [
            { run: 1, action: "start", model: "openai/gpt-5.6" },
            { run: 2, action: "retry", model: "cursor/grok-4.5" },
          ],
        }),
      ],
      "c1",
    );
    expect(opened.telemetry?.model).toBe("cursor/grok-4.5");
    expect(opened.telemetry?.provider).toBe("cursor");
    const view = apply(controller, usageEvent({ totalTokens: 3 }));
    expect(view.telemetry?.model).toBe("cursor/grok-4.5");
    expect(view.telemetry?.totalTokens).toBe(3);
  });

  it("omits the context percentage unless both operands are reported", async () => {
    const { controller } = await openController(
      [liveChild({ childId: "c1" })],
      "c1",
    );
    const usedOnly = apply(
      controller,
      usageEvent({ context: { tokens: 900 } }),
    );
    expect(usedOnly.telemetry?.contextTokens).toBe(900);
    expect(usedOnly.telemetry?.contextPercent).toBeUndefined();

    const limitOnly = apply(
      controller,
      usageEvent({ context: { contextWindow: 12_000 } }),
    );
    expect(limitOnly.telemetry?.contextWindow).toBe(12_000);
    expect(limitOnly.telemetry?.contextPercent).toBeUndefined();

    const zeroLimit = apply(
      controller,
      usageEvent({ context: { tokens: 10, contextWindow: 0 } }),
    );
    expect(zeroLimit.telemetry?.contextPercent).toBeUndefined();

    const both = apply(
      controller,
      usageEvent({ context: { tokens: 3_000, contextWindow: 12_000 } }),
    );
    expect(both.telemetry?.contextPercent).toBe(25);
  });

  it("ignores a host-reported percentage it cannot verify", async () => {
    const { controller } = await openController(
      [liveChild({ childId: "c1" })],
      "c1",
    );
    const view = apply(
      controller,
      usageEvent({ context: { percent: 87, tokens: null } }),
    );
    expect(view.telemetry?.contextPercent).toBeUndefined();
  });

  it("ignores usage events for a settled child", async () => {
    const { controller } = await openController(
      [liveChild({ childId: "c1", status: "settled" })],
      "c1",
    );
    const view = apply(controller, usageEvent({ input: 9, totalTokens: 9 }));
    expect(view.telemetry).toBeUndefined();
  });

  it("projects the real live message_end usage onto the view", async () => {
    const { controller } = await openController(
      [liveChild({ childId: "c1" })],
      "c1",
    );
    const view = apply(
      controller,
      messageEndEvent({
        model: "openai/gpt-5.6",
        usage: {
          input: 900,
          output: 100,
          cacheRead: 50,
          cacheWrite: 10,
          reasoning: 40,
          totalTokens: 1_050,
          cost: { total: 0.42 },
        },
        contextUsage: { tokens: 4_000, contextWindow: 16_000, percent: 3 },
      }),
    );
    expect(view.telemetry).toEqual({
      provider: "openai",
      model: "openai/gpt-5.6",
      inputTokens: 900,
      outputTokens: 100,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      reasoningTokens: 40,
      totalTokens: 1_050,
      contextTokens: 4_000,
      contextWindow: 16_000,
      contextPercent: 25,
    });
  });

  it("replaces the retained report with the newest message_end, never sums", async () => {
    const { controller } = await openController(
      [liveChild({ childId: "c1" })],
      "c1",
    );
    apply(
      controller,
      messageEndEvent({
        usage: { input: 900, output: 100, totalTokens: 1000 },
      }),
    );
    const view = apply(
      controller,
      messageEndEvent({
        id: "msg_02",
        usage: { input: 40, output: 5, totalTokens: 45 },
      }),
    );
    expect(view.telemetry?.inputTokens).toBe(40);
    expect(view.telemetry?.outputTokens).toBe(5);
    expect(view.telemetry?.totalTokens).toBe(45);
  });

  it("leaves a retained report untouched for an unusable message_end", async () => {
    const { controller } = await openController(
      [liveChild({ childId: "c1" })],
      "c1",
    );
    apply(
      controller,
      messageEndEvent({ usage: { input: 700, totalTokens: 800 } }),
    );
    // No usage object at all: not a report, so nothing is replaced.
    const noUsage = apply(controller, messageEndEvent({ model: "a/b" }));
    expect(noUsage.telemetry?.totalTokens).toBe(800);
    // Present but wholly malformed: every field is absent, never a throw.
    const malformed = apply(
      controller,
      messageEndEvent({
        id: "msg_03",
        usage: { input: {}, output: [], totalTokens: "lots" },
      }),
    );
    expect(malformed.telemetry?.totalTokens).toBeUndefined();
    expect(malformed.telemetry?.inputTokens).toBeUndefined();
  });

  it("isolates live message_end telemetry per child", async () => {
    const controller = createChildOverlayController(
      createMemoryChildOverlaySource([
        liveChild({ childId: "c1" }),
        liveChild({ childId: "c2" }),
      ]),
    );
    expect((await controller.open("c1")).isOk()).toBe(true);
    apply(
      controller,
      messageEndEvent({ usage: { input: 77, totalTokens: 77 } }),
    );

    const second = await controller.open("c2");
    expect(second._unsafeUnwrap().telemetry).toBeUndefined();

    const reopened = await controller.open("c1");
    expect(reopened._unsafeUnwrap().telemetry?.inputTokens).toBe(77);
  });
});

describe("child overlay historical telemetry", () => {
  it("projects usage from a persisted assistant entry in the loaded window", async () => {
    const { view } = await openController(
      [
        liveChild({
          childId: "c1",
          status: "settled",
          runs: [],
          entries: [
            nativeAssistantEntry("m1", {
              model: "anthropic/claude-sonnet-5",
              usage: {
                input: 500,
                output: 60,
                cacheRead: 20,
                cacheWrite: 5,
                reasoning: 15,
                totalTokens: 585,
                cost: { total: 0.01 },
              },
            }),
          ],
        }),
      ],
      "c1",
    );
    expect(view.telemetry?.provider).toBe("anthropic");
    expect(view.telemetry?.model).toBe("anthropic/claude-sonnet-5");
    expect(view.telemetry?.inputTokens).toBe(500);
    expect(view.telemetry?.outputTokens).toBe(60);
    expect(view.telemetry?.cacheReadTokens).toBe(20);
    expect(view.telemetry?.cacheWriteTokens).toBe(5);
    expect(view.telemetry?.reasoningTokens).toBe(15);
    expect(view.telemetry?.totalTokens).toBe(585);
  });

  it("keeps only the newest persisted report in the window", async () => {
    const { view } = await openController(
      [
        liveChild({
          childId: "c1",
          status: "settled",
          runs: [],
          entries: [
            nativeAssistantEntry("m1", {
              model: "openai/gpt-5.6",
              usage: { input: 10, totalTokens: 10 },
            }),
            nativeAssistantEntry("m2", {
              model: "cursor/grok-4.5",
              usage: { input: 999, totalTokens: 1_200 },
            }),
          ],
        }),
      ],
      "c1",
    );
    expect(view.telemetry?.model).toBe("cursor/grok-4.5");
    expect(view.telemetry?.inputTokens).toBe(999);
    expect(view.telemetry?.totalTokens).toBe(1_200);
  });

  it("leaves malformed and overbound persisted usage absent, never throwing", async () => {
    const { view } = await openController(
      [
        liveChild({
          childId: "c1",
          status: "settled",
          runs: [],
          entries: [
            nativeAssistantEntry("m1", {
              model: "z".repeat(MAX_CHILD_USAGE_MODEL_LENGTH + 1),
              usage: {
                input: -5,
                output: 2.5,
                cacheRead: "none",
                totalTokens: MAX_CHILD_USAGE_TOKENS + 1,
              },
            }),
          ],
        }),
      ],
      "c1",
    );
    expect(view.telemetry).toBeUndefined();
  });

  it("has no telemetry when persisted assistant entries carry no usage", async () => {
    const { view } = await openController(
      [
        liveChild({
          childId: "c1",
          status: "settled",
          runs: [],
          entries: [nativeAssistantEntry("m1", {})],
        }),
      ],
      "c1",
    );
    expect(view.telemetry).toBeUndefined();
  });

  it("lets a newer live message_end replace the historical report", async () => {
    const { controller, view: opened } = await openController(
      [
        liveChild({
          childId: "c1",
          entries: [
            nativeAssistantEntry("m1", {
              model: "openai/gpt-5.6",
              usage: { input: 10, totalTokens: 10 },
            }),
          ],
        }),
      ],
      "c1",
    );
    expect(opened.telemetry?.totalTokens).toBe(10);
    const view = apply(
      controller,
      messageEndEvent({
        model: "openai/gpt-5.6",
        usage: { input: 320, totalTokens: 400 },
      }),
    );
    expect(view.telemetry?.inputTokens).toBe(320);
    expect(view.telemetry?.totalTokens).toBe(400);
  });
});
