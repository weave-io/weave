// ---------------------------------------------------------------------------
// Versioned capture contract
// ---------------------------------------------------------------------------

export const FIXTURE_SCHEMA_VERSION = 1 as const;
export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const SANITIZER_VERSION = "1.1.0" as const;
export const REQUIRED_PI_VERSION = "0.84.2" as const;

export const MAX_CAPTURE_EVENTS = 1_000;
export const MAX_CAPTURE_DEPTH = 32;
export const MAX_CAPTURE_KEYS = 128;
export const MAX_CAPTURE_ARRAY_LENGTH = 256;
export const MAX_CAPTURE_STRING_BYTES = 4_096;
export const MAX_CAPTURE_PREVIEW_BYTES = 512;
export const MAX_CAPTURE_TOTAL_BYTES = 512 * 1024;

/** The value written in place of every thinking string before sanitization. */
export const REASONING_OMITTED_MARKER = "<reasoning-omitted>" as const;
/** User prompts are structure, not fixture content. */
export const PROMPT_OMITTED_MARKER = "<prompt-omitted>" as const;
/** Unknown host text is never copied into the fixture. */
export const STRING_OMITTED_MARKER = "<string-omitted>" as const;
/** Provider metadata is structure-only in the fixture. */
export const PROVIDER_VALUE_OMITTED_MARKER =
  "<provider-value-omitted>" as const;
export const STRING_TRUNCATED_MARKER = "<string-truncated>" as const;

export const CAPTURE_BOUNDS = Object.freeze({
  maxEvents: MAX_CAPTURE_EVENTS,
  maxDepth: MAX_CAPTURE_DEPTH,
  maxKeys: MAX_CAPTURE_KEYS,
  maxArrayLength: MAX_CAPTURE_ARRAY_LENGTH,
  maxStringBytes: MAX_CAPTURE_STRING_BYTES,
  maxPreviewBytes: MAX_CAPTURE_PREVIEW_BYTES,
  maxTotalBytes: MAX_CAPTURE_TOTAL_BYTES,
});

export interface CaptureManifestBounds {
  readonly maxEvents: number;
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxArrayLength: number;
  readonly maxStringBytes: number;
  readonly maxPreviewBytes: number;
  readonly maxTotalBytes: number;
}

export type CaptureFailureType =
  | "invalid-args"
  | "pi-version-mismatch"
  | "pi-ai-unavailable"
  | "workspace-failed"
  | "spawn-failed"
  | "capture-timeout"
  | "bounds-exceeded"
  | "forbidden-content"
  | "sanitization-failed"
  | "fixture-exists"
  | "write-failed";

export interface CaptureFailure {
  readonly type: CaptureFailureType;
  readonly evidence: "blocked";
}

export function blocked(type: CaptureFailureType): CaptureFailure {
  return { type, evidence: "blocked" };
}

export type FixtureValidationFailureType =
  | "manifest-corrupt"
  | "fixture-corrupt"
  | "missing-text-delta"
  | "broken-tool-correlation"
  | "malformed-thinking-lifecycle";

export interface FixtureValidationFailure {
  readonly type: FixtureValidationFailureType;
  readonly evidence: "blocked";
}

export function invalidFixture(
  type: FixtureValidationFailureType,
): FixtureValidationFailure {
  return { type, evidence: "blocked" };
}

export interface SanitizedEvent {
  readonly ordinalId: number;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface CaptureFixture {
  readonly schemaVersion: typeof FIXTURE_SCHEMA_VERSION;
  readonly events: readonly SanitizedEvent[];
}

export interface CaptureManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly sanitizerVersion: typeof SANITIZER_VERSION;
  readonly piVersion: string;
  readonly piExecutableSha256: string;
  readonly piPackageSha256: string;
  readonly piAiVersion: string;
  readonly piAiPackageSha256: string;
  readonly eventCount: number;
  readonly fixtureBytes: number;
  readonly captureTimeMs: number;
  readonly captureCompletedAt: string;
  readonly fixtureSha256: string;
  readonly omitReasoningContent: true;
  readonly idEncoding: "ordinals";
  readonly bounds: CaptureManifestBounds;
}

export interface CaptureSuccess {
  readonly fixturePath: string;
  readonly manifestPath: string;
  readonly eventCount: number;
  readonly captureDurationMs: number;
  readonly fixtureSha256: string;
}

export interface FixtureStructuralFacts {
  readonly hasThinkingLifecycle: boolean;
  readonly hasTextDelta: boolean;
  readonly textDeltaCount: number;
  readonly toolCorrelationCount: number;
  readonly hasReadTool: boolean;
  readonly hasBashTool: boolean;
}

export interface ReplayFacts {
  readonly reasoningObserved: boolean;
  readonly assistantAnswerText: string | undefined;
  readonly assistantDeltaCount: number;
  readonly toolRowCount: number;
  readonly renderedLines: readonly string[];
  readonly syntheticReasoningLeaked: boolean;
  readonly parentRawReasoningLaneAvailable: boolean;
  readonly inspectorRawReasoningLaneAvailable: boolean;
  readonly inspectorToolDetailsLaneAvailable: boolean;
  readonly inspectorAssistantReplyLaneAvailable: boolean;
}
