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

  it("returns a typed failure for a non-usage event", () => {
    const parsed = parsePiChildSessionEvent({ type: "text", text: "hi" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const report = parsePiChildUsageReport(parsed.data);
    expect(report.isErr()).toBe(true);
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
});
