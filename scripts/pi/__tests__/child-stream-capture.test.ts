import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  captureChildEvents,
  containsForbiddenContent,
  FIXTURE_SCHEMA_VERSION,
  injectControlledReasoningInMemory,
  MANIFEST_SCHEMA_VERSION,
  MAX_CAPTURE_ARRAY_LENGTH,
  MAX_CAPTURE_DEPTH,
  MAX_CAPTURE_EVENTS,
  MAX_CAPTURE_KEYS,
  MAX_CAPTURE_STRING_BYTES,
  MAX_CAPTURE_TOTAL_BYTES,
  PROMPT_OMITTED_MARKER,
  PROVIDER_VALUE_OMITTED_MARKER,
  REASONING_OMITTED_MARKER,
  readFixtureAndManifest,
  replayFixtureThroughAdapter,
  runFixtureRedControls,
  SANITIZER_VERSION,
  STRING_OMITTED_MARKER,
  sanitizeRawEvent,
  sanitizeRawEvents,
  validateFixtureStructure,
  verifyCaptureManifest,
} from "../child-stream-capture.js";

const CONTROLLED_REASONING_SENTINEL = "CONTROLLED-REASONING-SENTINEL";
const FIXTURE_PATH = join(
  import.meta.dir,
  "../../../packages/adapters/pi/src/__fixtures__/pi-0.84.2-child-ui-events.v1.json",
);

describe("child-stream-capture constants", () => {
  it("pins the versioned, bounded capture contract", () => {
    expect(FIXTURE_SCHEMA_VERSION).toBe(1);
    expect(MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(SANITIZER_VERSION).toBe("1.1.0");
    expect(MAX_CAPTURE_EVENTS).toBe(1_000);
    expect(MAX_CAPTURE_DEPTH).toBe(32);
    expect(MAX_CAPTURE_KEYS).toBe(128);
    expect(MAX_CAPTURE_ARRAY_LENGTH).toBe(256);
    expect(MAX_CAPTURE_STRING_BYTES).toBe(4_096);
    expect(MAX_CAPTURE_TOTAL_BYTES).toBe(512 * 1024);
    expect(REASONING_OMITTED_MARKER).toBe("<reasoning-omitted>");
  });
});

describe("child-stream-capture online omission and sanitization", () => {
  it("omits thinking prose before the bounded walker sees it", () => {
    const result = sanitizeRawEvent(
      {
        type: "turn_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: CONTROLLED_REASONING_SENTINEL,
              nested: { text: CONTROLLED_REASONING_SENTINEL },
            },
          ],
        },
        thinking: CONTROLLED_REASONING_SENTINEL,
      },
      0,
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const text = JSON.stringify(result.value);
    expect(text).not.toContain(CONTROLLED_REASONING_SENTINEL);
    expect(text).toContain(REASONING_OMITTED_MARKER);
    expect(text).toContain("byteLength");
    expect(text).toContain("lineCount");
    expect(text).toContain("truncated");
  });

  it("does not copy prompts, provider values, or uncontrolled strings", () => {
    const result = sanitizeRawEvent(
      {
        type: "message_start",
        message: {
          role: "user",
          content: [{ type: "text", text: "uncontrolled prompt" }],
          provider: "provider-payload-must-not-survive",
          api: "provider-api-must-not-survive",
          model: "provider-model-must-not-survive",
          metadata: { note: "uncontrolled output" },
        },
      },
      0,
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const text = JSON.stringify(result.value);
    expect(text).not.toContain("uncontrolled prompt");
    expect(text).not.toContain("provider-payload-must-not-survive");
    expect(text).not.toContain("uncontrolled output");
    expect(text).toContain(PROMPT_OMITTED_MARKER);
    expect(text).toContain(PROVIDER_VALUE_OMITTED_MARKER);
    expect(text).toContain(STRING_OMITTED_MARKER);
  });

  it("rejects credentials, absolute paths, environment values, and stack text", () => {
    for (const value of [
      "Bearer abcdefghijklmnop",
      "/private/absolute/path",
      "process.env.SECRET_VALUE",
      "Error\n    at hostile (payload.ts:1:1)",
    ]) {
      expect(containsForbiddenContent(value)).toBe(true);
      expect(sanitizeRawEvent({ type: "text", text: value }, 0).isErr()).toBe(
        true,
      );
    }
  });

  it("fails closed for accessor and revoked-proxy event shapes", () => {
    const accessor = {} as { readonly type: string };
    Object.defineProperty(accessor, "type", {
      enumerable: true,
      get: () => {
        throw new Error();
      },
    });
    expect(sanitizeRawEvent(accessor, 0).isErr()).toBe(true);
    const revocable = Proxy.revocable({ type: "text", text: "safe" }, {});
    revocable.revoke();
    expect(() => sanitizeRawEvent(revocable.proxy, 0)).not.toThrow();
    expect(sanitizeRawEvent(revocable.proxy, 0).isErr()).toBe(true);
  });

  it("ordinalizes tool ids in message and native tool carriers", () => {
    const result = sanitizeRawEvents([
      {
        type: "message_start",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "opaque-tool-id",
              name: "read",
              arguments: { path: "weave-capture-sample.txt" },
            },
          ],
        },
      },
      {
        type: "tool_execution_start",
        toolCallId: "opaque-tool-id",
        toolName: "read",
        args: { path: "weave-capture-sample.txt" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "opaque-tool-id",
        toolName: "read",
        result: {
          content: [
            {
              type: "text",
              text: "weave capture deterministic workspace file\n",
            },
          ],
        },
        isError: false,
      },
    ]);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const text = JSON.stringify(result.value);
    expect(text).toContain("tool-call-1");
    expect(text).not.toContain("opaque-tool-id");
    expect(text).not.toContain("id-1");
  });

  it("fails closed at event, depth, key, array, string, and total bounds", () => {
    expect(
      sanitizeRawEvents(
        Array.from({ length: MAX_CAPTURE_EVENTS + 1 }, () => ({
          type: "agent_start",
        })),
      )._unsafeUnwrapErr().type,
    ).toBe("bounds-exceeded");
    const wide: Record<string, unknown> = { type: "text", text: "safe" };
    for (let index = 0; index < MAX_CAPTURE_KEYS; index += 1)
      wide[`key-${index}`] = index;
    expect(sanitizeRawEvent(wide, 0)._unsafeUnwrapErr().type).toBe(
      "bounds-exceeded",
    );
    expect(
      sanitizeRawEvent(
        { type: "text", text: "x".repeat(MAX_CAPTURE_STRING_BYTES + 1) },
        0,
      ).isOk(),
    ).toBe(true);
    const oversizedReasoning = sanitizeRawEvent(
      {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "x".repeat(MAX_CAPTURE_TOTAL_BYTES + 1),
      },
      0,
    );
    expect(oversizedReasoning.isOk()).toBe(true);
    if (oversizedReasoning.isOk()) {
      expect(oversizedReasoning.value.payload.delta).toEqual({
        marker: REASONING_OMITTED_MARKER,
        byteLength: MAX_CAPTURE_TOTAL_BYTES,
        lineCount: 1,
        truncated: true,
      });
    }
    const nested: Record<string, unknown> = { type: "text", text: "safe" };
    let cursor = nested;
    for (let index = 0; index < MAX_CAPTURE_DEPTH + 2; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(sanitizeRawEvent(nested, 0).isErr()).toBe(true);
    expect(
      sanitizeRawEvent(
        {
          type: "text",
          items: Array.from(
            { length: MAX_CAPTURE_ARRAY_LENGTH + 1 },
            () => "x",
          ),
        },
        0,
      )._unsafeUnwrapErr().type,
    ).toBe("bounds-exceeded");
    const large = Array.from({ length: MAX_CAPTURE_EVENTS }, () => ({
      type: "text",
      items: Array.from({ length: MAX_CAPTURE_ARRAY_LENGTH }, () => 0),
    }));
    expect(sanitizeRawEvents(large)._unsafeUnwrapErr().type).toBe(
      "bounds-exceeded",
    );
    expect(MAX_CAPTURE_TOTAL_BYTES).toBeGreaterThan(0);
  });

  it("does not mutate the in-memory replay source when injecting controlled text", () => {
    const original = {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: REASONING_OMITTED_MARKER,
      },
    };
    const injected = injectControlledReasoningInMemory(original, 7);
    expect(original.assistantMessageEvent.delta).toBe(REASONING_OMITTED_MARKER);
    expect(JSON.stringify(injected)).toContain(
      "SYNTHETIC-CONTROLLED-REASONING-7",
    );
  });
});

describe("authoritative Pi 0.84.2 fixture and replay", () => {
  it("verifies the immutable fixture and all structural red controls", async () => {
    const loaded = await readFixtureAndManifest(FIXTURE_PATH);
    expect(loaded.isOk()).toBe(true);
    if (loaded.isErr()) return;
    const verified = verifyCaptureManifest(
      loaded.value.fixtureText,
      loaded.value.manifestText,
    );
    expect(verified.isOk()).toBe(true);
    if (verified.isErr()) return;
    const structure = validateFixtureStructure(verified.value.fixture);
    expect(structure.isOk()).toBe(true);
    if (structure.isErr()) return;
    expect(structure.value.hasThinkingLifecycle).toBe(true);
    expect(structure.value.textDeltaCount).toBeGreaterThanOrEqual(2);
    expect(structure.value.hasReadTool).toBe(true);
    expect(structure.value.hasBashTool).toBe(true);
    expect(verified.value.manifest.piPackageSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      runFixtureRedControls(
        loaded.value.fixtureText,
        loaded.value.manifestText,
      ).isOk(),
    ).toBe(true);
    expect(loaded.value.fixtureText).not.toContain('"thinking": "');
    expect(loaded.value.fixtureText).not.toContain(
      "SYNTHETIC-CONTROLLED-REASONING-",
    );
    expect(loaded.value.fixtureText).not.toContain("/private/");
    expect(loaded.value.manifestText).not.toContain("/private/");
  });

  it("replays through the public adapter seam with four independent lane sources", async () => {
    const loaded = await readFixtureAndManifest(FIXTURE_PATH);
    expect(loaded.isOk()).toBe(true);
    if (loaded.isErr()) return;
    const verified = verifyCaptureManifest(
      loaded.value.fixtureText,
      loaded.value.manifestText,
    );
    expect(verified.isOk()).toBe(true);
    if (verified.isErr()) return;
    const replay = replayFixtureThroughAdapter(verified.value.fixture, {
      injectControlledReasoningInMemory: true,
    });
    expect(replay.isOk()).toBe(true);
    if (replay.isErr()) return;
    expect(replay.value.reasoningObserved).toBe(true);
    expect(replay.value.assistantDeltaCount).toBeGreaterThanOrEqual(2);
    expect(replay.value.assistantAnswerText).toBe(
      "Weave capture deterministic final answer.",
    );
    expect(replay.value.toolRowCount).toBeGreaterThanOrEqual(2);
    expect(replay.value.syntheticReasoningLeaked).toBe(false);
    expect(replay.value.parentRawReasoningLaneAvailable).toBe(true);
    expect(replay.value.inspectorRawReasoningLaneAvailable).toBe(true);
    expect(replay.value.inspectorToolDetailsLaneAvailable).toBe(true);
    expect(replay.value.inspectorAssistantReplyLaneAvailable).toBe(true);
  });

  it("captures once through a real Pi 0.84.2 RPC process and refuses overwrite", async () => {
    const pi = Bun.which("pi");
    expect(pi).toBeString();
    if (pi === null) return;
    const root = join(tmpdir(), `weave-pi-capture-test-${crypto.randomUUID()}`);
    await $`mkdir -p ${root}`.quiet();
    try {
      const captured = await captureChildEvents({
        pi,
        requireHostVersion: "0.84.2",
        fixtureDir: root,
        fixtureBaseName: "authoritative",
      });
      expect(captured.isOk()).toBe(true);
      if (captured.isErr()) return;
      const loaded = await readFixtureAndManifest(captured.value.fixturePath);
      expect(loaded.isOk()).toBe(true);
      if (loaded.isErr()) return;
      const verified = verifyCaptureManifest(
        loaded.value.fixtureText,
        loaded.value.manifestText,
      );
      expect(verified.isOk()).toBe(true);
      expect(loaded.value.fixtureText).not.toContain('"thinking": "');
      const second = await captureChildEvents({
        pi,
        requireHostVersion: "0.84.2",
        fixtureDir: root,
        fixtureBaseName: "authoritative",
      });
      expect(second.isErr()).toBe(true);
      if (second.isOk()) return;
      expect(second.error.type).toBe("fixture-exists");
    } finally {
      await $`rm -rf ${root}`.quiet();
    }
  });
});
