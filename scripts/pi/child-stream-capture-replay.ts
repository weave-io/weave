import { err, ok, type Result } from "neverthrow";
import { renderOverlayPiNative } from "../../packages/adapters/pi/src/child-overlay-pi-native.js";
import { redactProviderErrorFromEvent } from "../../packages/adapters/pi/src/child-provider-error.js";
import {
  parsePiChildSessionEvent,
  retainedChildSessionEvent,
} from "../../packages/adapters/pi/src/child-session-events.js";
import {
  createPiChildTranscriptState,
  reducePiChildTranscript,
} from "../../packages/adapters/pi/src/child-transcript.js";
import { messageUpdateObservesRawReasoning } from "../../packages/adapters/pi/src/message-update-carrier.js";
import { plainPaint } from "../../packages/adapters/pi/src/ui-paint.js";
import {
  type CaptureFixture,
  type FixtureValidationFailure,
  invalidFixture,
  type ReplayFacts,
} from "./child-stream-capture-contract.js";
import {
  isRecord,
  THINKING_EVENT_TYPES,
} from "./child-stream-capture-sanitizer.js";
import { validateFixtureStructure } from "./child-stream-capture-verifier.js";

const SYNTHETIC_REASONING_PREFIX = "SYNTHETIC-CONTROLLED-REASONING-";

/** Clone only the carrier that receives the controlled in-memory test text. */
export function injectControlledReasoningInMemory(
  payload: Record<string, unknown>,
  ordinalId: number,
): Record<string, unknown> {
  const event = isRecord(payload.assistantMessageEvent)
    ? payload.assistantMessageEvent
    : undefined;
  if (event === undefined || !THINKING_EVENT_TYPES.has(String(event.type))) {
    return payload;
  }
  const key = event.type === "thinking_delta" ? "delta" : "content";
  return {
    ...payload,
    assistantMessageEvent: {
      ...event,
      [key]: `${SYNTHETIC_REASONING_PREFIX}${ordinalId}`,
    },
  };
}

function assistantEvent(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return isRecord(payload.assistantMessageEvent)
    ? payload.assistantMessageEvent
    : undefined;
}

function assistantEventType(
  payload: Record<string, unknown>,
): string | undefined {
  const event = assistantEvent(payload);
  return typeof event?.type === "string" ? event.type : undefined;
}

function replayPayload(
  event: CaptureFixture["events"][number],
  injectReasoning: boolean,
): Record<string, unknown> {
  if (!injectReasoning) return { ...event.payload };
  return injectControlledReasoningInMemory(
    { ...event.payload },
    event.ordinalId,
  );
}

/** Replay the captured structure through the production parser and reducer. */
export function replayFixtureThroughAdapter(
  fixture: CaptureFixture,
  options: { readonly injectControlledReasoningInMemory?: boolean } = {},
): Result<ReplayFacts, FixtureValidationFailure> {
  const structural = validateFixtureStructure(fixture);
  if (structural.isErr()) return err(structural.error);
  let state = createPiChildTranscriptState();
  let reasoningObserved = false;
  let assistantDeltaCount = 0;

  for (const event of fixture.events) {
    const payload = replayPayload(
      event,
      options.injectControlledReasoningInMemory === true,
    );
    if (event.eventType === "message_update") {
      reasoningObserved ||= messageUpdateObservesRawReasoning(payload);
      const eventType = assistantEventType(payload);
      if (eventType === "text_delta") assistantDeltaCount += 1;
    }
    const parsed = parsePiChildSessionEvent(payload);
    if (!parsed.success) return err(invalidFixture("fixture-corrupt"));
    const retained = retainedChildSessionEvent(parsed.data);
    if (retained === undefined) continue;
    const next = reducePiChildTranscript(state, {
      kind: "event",
      event: redactProviderErrorFromEvent(retained),
    });
    if (next.isErr()) return err(invalidFixture("fixture-corrupt"));
    state = next.value;
  }

  const rendered = renderOverlayPiNative(
    plainPaint(),
    { entries: state.entries, childName: "capture-replay", settled: true },
    96,
  );
  const renderedLines = rendered.plain.map((line) => line.replace(/\s+$/u, ""));
  const joined = renderedLines.join("\n");
  let toolRowCount = 0;
  for (const line of renderedLines) if (/^⚙ /u.test(line)) toolRowCount += 1;

  const answerTexts = fixture.events
    .filter(
      (event) =>
        event.eventType === "message_end" && isRecord(event.payload.message),
    )
    .flatMap((event) => {
      const message = event.payload.message as Record<string, unknown>;
      if (message.role !== "assistant" || !Array.isArray(message.content))
        return [];
      return message.content.flatMap((block) => {
        if (
          !isRecord(block) ||
          block.type !== "text" ||
          typeof block.text !== "string"
        ) {
          return [];
        }
        return [block.text];
      });
    });
  const assistantAnswerText = answerTexts.at(-1);

  return ok({
    reasoningObserved,
    assistantAnswerText,
    assistantDeltaCount,
    toolRowCount,
    renderedLines,
    syntheticReasoningLeaked: joined.includes(SYNTHETIC_REASONING_PREFIX),
    parentRawReasoningLaneAvailable: structural.value.hasThinkingLifecycle,
    inspectorRawReasoningLaneAvailable: structural.value.hasThinkingLifecycle,
    inspectorToolDetailsLaneAvailable:
      structural.value.toolCorrelationCount > 0,
    inspectorAssistantReplyLaneAvailable:
      structural.value.textDeltaCount > 0 && assistantAnswerText !== undefined,
  });
}
