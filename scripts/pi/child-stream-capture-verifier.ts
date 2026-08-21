import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import {
  CAPTURE_BOUNDS,
  type CaptureFixture,
  type CaptureManifest,
  FIXTURE_SCHEMA_VERSION,
  type FixtureStructuralFacts,
  type FixtureValidationFailure,
  type FixtureValidationFailureType,
  invalidFixture,
  MANIFEST_SCHEMA_VERSION,
  MAX_CAPTURE_DEPTH,
  MAX_CAPTURE_EVENTS,
  MAX_CAPTURE_TOTAL_BYTES,
  REASONING_OMITTED_MARKER,
  REQUIRED_PI_VERSION,
  SANITIZER_VERSION,
} from "./child-stream-capture-contract.js";
import {
  containsForbiddenContent,
  isRecord,
  sha256HexOfText,
  THINKING_EVENT_TYPES,
  utf8Bytes,
} from "./child-stream-capture-sanitizer.js";

// ---------------------------------------------------------------------------
// Fixture and manifest serialization / independent verification
// ---------------------------------------------------------------------------

export function serializeFixture(events: CaptureFixture["events"]): string {
  return `${JSON.stringify(
    { schemaVersion: FIXTURE_SCHEMA_VERSION, events } satisfies CaptureFixture,
    null,
    2,
  )}\n`;
}

export function buildCaptureManifest(input: {
  readonly piVersion: string;
  readonly piExecutableSha256: string;
  readonly piPackageSha256: string;
  readonly piAiVersion: string;
  readonly piAiPackageSha256: string;
  readonly eventCount: number;
  readonly fixtureBytes: number;
  readonly captureTimeMs: number;
  readonly fixtureSha256: string;
  readonly captureCompletedAt?: string;
}): CaptureManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    sanitizerVersion: SANITIZER_VERSION,
    piVersion: input.piVersion,
    piExecutableSha256: input.piExecutableSha256,
    piPackageSha256: input.piPackageSha256,
    piAiVersion: input.piAiVersion,
    piAiPackageSha256: input.piAiPackageSha256,
    eventCount: input.eventCount,
    fixtureBytes: input.fixtureBytes,
    captureTimeMs: input.captureTimeMs,
    captureCompletedAt: input.captureCompletedAt ?? new Date().toISOString(),
    fixtureSha256: input.fixtureSha256,
    omitReasoningContent: true,
    idEncoding: "ordinals",
    bounds: CAPTURE_BOUNDS,
  };
}

function parseJson(
  text: string,
  failure: FixtureValidationFailureType,
): Result<unknown, FixtureValidationFailure> {
  return Result.fromThrowable(
    () => JSON.parse(text) as unknown,
    () => invalidFixture(failure),
  )();
}

function parseCaptureFixture(
  text: string,
): Result<CaptureFixture, FixtureValidationFailure> {
  const parsed = parseJson(text, "fixture-corrupt");
  if (parsed.isErr()) return err(parsed.error);
  if (!isRecord(parsed.value)) return err(invalidFixture("fixture-corrupt"));
  if (parsed.value.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
    return err(invalidFixture("fixture-corrupt"));
  }
  const events = parsed.value.events;
  if (!Array.isArray(events) || events.length > MAX_CAPTURE_EVENTS) {
    return err(invalidFixture("fixture-corrupt"));
  }
  let expectedOrdinal = 0;
  for (const event of events) {
    if (
      !isRecord(event) ||
      event.ordinalId !== expectedOrdinal ||
      typeof event.eventType !== "string" ||
      !isRecord(event.payload) ||
      event.payload.type !== event.eventType
    ) {
      return err(invalidFixture("fixture-corrupt"));
    }
    expectedOrdinal += 1;
  }
  return ok({
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    events: events as unknown as CaptureFixture["events"],
  });
}

function parseCaptureManifest(
  text: string,
): Result<CaptureManifest, FixtureValidationFailure> {
  const parsed = parseJson(text, "manifest-corrupt");
  if (parsed.isErr()) return err(parsed.error);
  if (!isRecord(parsed.value)) return err(invalidFixture("manifest-corrupt"));
  const value = parsed.value;
  const bounds = value.bounds;
  if (
    value.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    value.sanitizerVersion !== SANITIZER_VERSION ||
    value.piVersion !== REQUIRED_PI_VERSION ||
    typeof value.piExecutableSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.piExecutableSha256) ||
    typeof value.piPackageSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.piPackageSha256) ||
    value.piAiVersion !== REQUIRED_PI_VERSION ||
    typeof value.piAiPackageSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.piAiPackageSha256) ||
    typeof value.eventCount !== "number" ||
    !Number.isSafeInteger(value.eventCount) ||
    value.eventCount < 1 ||
    typeof value.fixtureBytes !== "number" ||
    !Number.isSafeInteger(value.fixtureBytes) ||
    value.fixtureBytes < 1 ||
    typeof value.captureTimeMs !== "number" ||
    !Number.isSafeInteger(value.captureTimeMs) ||
    value.captureTimeMs < 0 ||
    typeof value.captureCompletedAt !== "string" ||
    !Number.isFinite(Date.parse(value.captureCompletedAt)) ||
    typeof value.fixtureSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.fixtureSha256) ||
    value.omitReasoningContent !== true ||
    value.idEncoding !== "ordinals" ||
    !isRecord(bounds) ||
    JSON.stringify(bounds) !== JSON.stringify(CAPTURE_BOUNDS)
  ) {
    return err(invalidFixture("manifest-corrupt"));
  }
  return ok(value as unknown as CaptureManifest);
}

function containsRawReasoningShape(value: unknown, depth = 0): boolean {
  if (depth > MAX_CAPTURE_DEPTH) return true;
  if (typeof value === "string") return false;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value))
    return value.some((item) => containsRawReasoningShape(item, depth + 1));
  if (!isRecord(value)) return true;
  const type = typeof value.type === "string" ? value.type : undefined;
  if (type === "thinking" || type === "reasoning") {
    for (const [key, member] of Object.entries(value)) {
      if (key !== "type" && typeof member === "string") return true;
    }
  }
  if (THINKING_EVENT_TYPES.has(type ?? "")) {
    for (const key of ["delta", "content", "text"]) {
      if (typeof value[key] === "string") return true;
    }
  }
  for (const [key, member] of Object.entries(value)) {
    if (
      (key === "thinking" || key === "reasoning") &&
      typeof member === "string"
    ) {
      return true;
    }
    if (containsRawReasoningShape(member, depth + 1)) return true;
  }
  return false;
}

function reasoningMarkerFacts(
  value: unknown,
  depth = 0,
): { readonly hasMarker: boolean; readonly valid: boolean } {
  if (depth > MAX_CAPTURE_DEPTH) return { hasMarker: false, valid: false };
  if (value === null || typeof value !== "object") {
    return { hasMarker: false, valid: true };
  }
  if (Array.isArray(value)) {
    let hasMarker = false;
    let valid = true;
    for (const item of value) {
      const next = reasoningMarkerFacts(item, depth + 1);
      hasMarker ||= next.hasMarker;
      valid &&= next.valid;
    }
    return { hasMarker, valid };
  }
  if (!isRecord(value)) return { hasMarker: false, valid: false };
  const marker = value.marker;
  const isMarker = marker === REASONING_OMITTED_MARKER;
  if (isMarker) {
    return {
      hasMarker: true,
      valid:
        typeof value.byteLength === "number" &&
        Number.isSafeInteger(value.byteLength) &&
        value.byteLength >= 0 &&
        value.byteLength <= MAX_CAPTURE_TOTAL_BYTES &&
        typeof value.lineCount === "number" &&
        Number.isSafeInteger(value.lineCount) &&
        value.lineCount >= 0 &&
        value.lineCount <= MAX_CAPTURE_TOTAL_BYTES &&
        typeof value.truncated === "boolean",
    };
  }
  let hasMarker = false;
  let valid = true;
  for (const item of Object.values(value)) {
    const next = reasoningMarkerFacts(item, depth + 1);
    hasMarker ||= next.hasMarker;
    valid &&= next.valid;
  }
  return { hasMarker, valid };
}

function contentFreeFixture(
  fixtureText: string,
  fixture: CaptureFixture,
): boolean {
  if (containsForbiddenContent(fixtureText)) return false;
  if (fixtureText.includes("SYNTHETIC-CONTROLLED-REASONING-")) return false;
  if (containsRawReasoningShape(fixture)) return false;
  const markers = reasoningMarkerFacts(fixture);
  return markers.hasMarker && markers.valid;
}

/** Independently hashes and validates the immutable fixture + sidecar pair. */
export function verifyCaptureManifest(
  fixtureText: string,
  manifestText: string,
): Result<
  { readonly fixture: CaptureFixture; readonly manifest: CaptureManifest },
  FixtureValidationFailure
> {
  const manifest = parseCaptureManifest(manifestText);
  if (manifest.isErr()) return err(manifest.error);
  const fixture = parseCaptureFixture(fixtureText);
  if (fixture.isErr()) return err(fixture.error);
  const fixtureBytes = utf8Bytes(fixtureText);
  if (
    fixtureBytes > MAX_CAPTURE_TOTAL_BYTES ||
    !contentFreeFixture(fixtureText, fixture.value) ||
    sha256HexOfText(fixtureText) !== manifest.value.fixtureSha256 ||
    fixtureBytes !== manifest.value.fixtureBytes ||
    fixture.value.events.length !== manifest.value.eventCount
  ) {
    return err(invalidFixture("fixture-corrupt"));
  }
  return ok({ fixture: fixture.value, manifest: manifest.value });
}

// ---------------------------------------------------------------------------
// Structural validation and red controls
// ---------------------------------------------------------------------------

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

/** Validates lifecycle ordering, answer deltas, and authoritative tool ids. */
export function validateFixtureStructure(
  fixture: CaptureFixture,
): Result<FixtureStructuralFacts, FixtureValidationFailure> {
  const thinkingState = new Map<number, "started" | "delta-seen">();
  let thinkingTriplesCompleted = 0;
  let textDeltaCount = 0;
  let textStarted = false;
  let textEnded = false;

  for (const event of fixture.events) {
    if (event.eventType !== "message_update") continue;
    const type = assistantEventType(event.payload);
    if (type === "text_start") {
      if (textStarted || textEnded)
        return err(invalidFixture("missing-text-delta"));
      textStarted = true;
    }
    if (type === "text_delta") {
      if (!textStarted || textEnded)
        return err(invalidFixture("missing-text-delta"));
      textDeltaCount += 1;
    }
    if (type === "text_end") {
      if (!textStarted || textDeltaCount === 0 || textEnded) {
        return err(invalidFixture("missing-text-delta"));
      }
      textEnded = true;
    }
    if (type === undefined || !THINKING_EVENT_TYPES.has(type)) continue;
    const eventValue = assistantEvent(event.payload);
    const contentIndex = eventValue?.contentIndex;
    if (typeof contentIndex !== "number") {
      return err(invalidFixture("malformed-thinking-lifecycle"));
    }
    const state = thinkingState.get(contentIndex);
    if (type === "thinking_start") {
      if (state !== undefined)
        return err(invalidFixture("malformed-thinking-lifecycle"));
      thinkingState.set(contentIndex, "started");
    } else if (type === "thinking_delta") {
      if (state === undefined)
        return err(invalidFixture("malformed-thinking-lifecycle"));
      thinkingState.set(contentIndex, "delta-seen");
    } else {
      if (state !== "delta-seen")
        return err(invalidFixture("malformed-thinking-lifecycle"));
      thinkingState.delete(contentIndex);
      thinkingTriplesCompleted += 1;
    }
  }
  if (thinkingState.size > 0 || thinkingTriplesCompleted === 0) {
    return err(invalidFixture("malformed-thinking-lifecycle"));
  }
  if (!textStarted || textDeltaCount < 2 || !textEnded) {
    return err(invalidFixture("missing-text-delta"));
  }

  const started = new Set<string>();
  const terminal = new Set<string>();
  let hasReadTool = false;
  let hasBashTool = false;
  for (const event of fixture.events) {
    if (event.eventType === "tool_execution_start") {
      const id = event.payload.toolCallId;
      const name = event.payload.toolName;
      if (
        typeof id !== "string" ||
        typeof name !== "string" ||
        started.has(id)
      ) {
        return err(invalidFixture("broken-tool-correlation"));
      }
      started.add(id);
      hasReadTool ||= name === "read";
      hasBashTool ||= name === "bash";
      continue;
    }
    if (
      event.eventType === "tool_execution_update" ||
      event.eventType === "tool_execution_end"
    ) {
      const id = event.payload.toolCallId;
      if (typeof id !== "string" || !started.has(id) || terminal.has(id)) {
        return err(invalidFixture("broken-tool-correlation"));
      }
      if (event.eventType === "tool_execution_end") terminal.add(id);
    }
  }
  if (
    started.size === 0 ||
    terminal.size !== started.size ||
    !hasReadTool ||
    !hasBashTool
  ) {
    return err(invalidFixture("broken-tool-correlation"));
  }
  return ok({
    hasThinkingLifecycle: thinkingTriplesCompleted > 0,
    hasTextDelta: textDeltaCount > 0,
    textDeltaCount,
    toolCorrelationCount: terminal.size,
    hasReadTool,
    hasBashTool,
  });
}

/** Applies corruption, omission, correlation, and lifecycle red controls. */
export function runFixtureRedControls(
  fixtureText: string,
  manifestText: string,
): Result<
  Readonly<Record<FixtureValidationFailureType, true>>,
  {
    readonly mutation: FixtureValidationFailureType;
    readonly reason: "not-rejected" | "base-fixture-invalid";
  }
> {
  const base = verifyCaptureManifest(fixtureText, manifestText);
  if (base.isErr()) {
    return err({ mutation: base.error.type, reason: "base-fixture-invalid" });
  }
  const structural = validateFixtureStructure(base.value.fixture);
  if (structural.isErr()) {
    return err({
      mutation: structural.error.type,
      reason: "base-fixture-invalid",
    });
  }
  const events = base.value.fixture.events;

  const missingText = validateFixtureStructure({
    ...base.value.fixture,
    events: events.filter(
      (event) => assistantEventType(event.payload) !== "text_delta",
    ),
  });
  if (!missingText.isErr() || missingText.error.type !== "missing-text-delta") {
    return err({ mutation: "missing-text-delta", reason: "not-rejected" });
  }

  const brokenCorrelation = validateFixtureStructure({
    ...base.value.fixture,
    events: events.map((event) =>
      event.eventType === "tool_execution_end"
        ? {
            ...event,
            payload: { ...event.payload, toolCallId: "tool-call-unknown" },
          }
        : event,
    ),
  });
  if (
    !brokenCorrelation.isErr() ||
    brokenCorrelation.error.type !== "broken-tool-correlation"
  ) {
    return err({ mutation: "broken-tool-correlation", reason: "not-rejected" });
  }

  let droppedStart = false;
  const malformedThinking = validateFixtureStructure({
    ...base.value.fixture,
    events: events.filter((event) => {
      if (
        !droppedStart &&
        assistantEventType(event.payload) === "thinking_start"
      ) {
        droppedStart = true;
        return false;
      }
      return true;
    }),
  });
  if (
    !malformedThinking.isErr() ||
    malformedThinking.error.type !== "malformed-thinking-lifecycle"
  ) {
    return err({
      mutation: "malformed-thinking-lifecycle",
      reason: "not-rejected",
    });
  }

  const corruptFixture = verifyCaptureManifest(
    `${fixtureText.slice(0, -1)}${fixtureText.endsWith("\n") ? " " : "\n"}`,
    manifestText,
  );
  if (
    !corruptFixture.isErr() ||
    corruptFixture.error.type !== "fixture-corrupt"
  ) {
    return err({ mutation: "fixture-corrupt", reason: "not-rejected" });
  }

  const parsedManifest = parseJson(manifestText, "manifest-corrupt");
  if (parsedManifest.isErr() || !isRecord(parsedManifest.value)) {
    return err({ mutation: "manifest-corrupt", reason: "not-rejected" });
  }
  const corruptManifest = verifyCaptureManifest(
    fixtureText,
    `${JSON.stringify({ ...parsedManifest.value, schemaVersion: 99 }, null, 2)}\n`,
  );
  if (
    !corruptManifest.isErr() ||
    corruptManifest.error.type !== "manifest-corrupt"
  ) {
    return err({ mutation: "manifest-corrupt", reason: "not-rejected" });
  }

  return ok({
    "missing-text-delta": true,
    "broken-tool-correlation": true,
    "malformed-thinking-lifecycle": true,
    "fixture-corrupt": true,
    "manifest-corrupt": true,
  });
}

// ---------------------------------------------------------------------------
// Fixture I/O used by replay and the verifier
// ---------------------------------------------------------------------------

export function deriveManifestPath(fixturePath: string): string {
  return fixturePath.endsWith(".json")
    ? `${fixturePath.slice(0, -5)}.manifest.json`
    : `${fixturePath}.manifest.json`;
}

function readBoundedFixtureText(
  path: string,
): ResultAsync<string, FixtureValidationFailure> {
  const file = Result.fromThrowable(
    () => Bun.file(path),
    () => invalidFixture("fixture-corrupt"),
  )();
  if (file.isErr()) return errAsync(file.error);
  if (file.value.size > MAX_CAPTURE_TOTAL_BYTES) {
    return errAsync(invalidFixture("fixture-corrupt"));
  }
  return ResultAsync.fromThrowable(
    () => file.value.slice(0, MAX_CAPTURE_TOTAL_BYTES + 1).arrayBuffer(),
    () => invalidFixture("fixture-corrupt"),
  )().andThen((bytes) => {
    if (bytes.byteLength > MAX_CAPTURE_TOTAL_BYTES) {
      return errAsync(invalidFixture("fixture-corrupt"));
    }
    const decoded = Result.fromThrowable(
      () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      () => invalidFixture("fixture-corrupt"),
    )();
    return decoded.isOk() ? okAsync(decoded.value) : errAsync(decoded.error);
  });
}

export function readFixtureAndManifest(
  fixturePath: string,
): ResultAsync<
  { readonly fixtureText: string; readonly manifestText: string },
  FixtureValidationFailure
> {
  const manifestPath = deriveManifestPath(fixturePath);
  return readBoundedFixtureText(fixturePath).andThen((fixtureText) =>
    readBoundedFixtureText(manifestPath).map((manifestText) => ({
      fixtureText,
      manifestText,
    })),
  );
}
