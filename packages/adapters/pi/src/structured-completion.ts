/**
 * Structured completion for direct workflow-step children (Pi adapter contract).
 *
 * A direct-step child receives exactly one governed `weave_complete_step`
 * tool. Its closed input is the *only* legitimate source of a completion
 * candidate: process exit, free-form prose, or a second/duplicate/late call
 * are never treated as success. This module owns pure parsing/validation of
 * that candidate into the engine's `StepCompletionSignal` shape - it never
 * touches the Runtime Store or calls `completeStep` itself (that remains the
 * `PiWorkflowController`'s job).
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { StepCompletionSignal } from "@weaveio/weave-engine";
import { err, ok, Result } from "neverthrow";
import { Type } from "typebox";
import { projectDiagnosticText } from "./child-diagnostic-projection.js";
import {
  makeCompletionSignalMalformedFailure,
  makeCompletionSignalMissingFailure,
  type PiAdapterFailure,
} from "./errors.js";
import type { PiToolRegistration } from "./types.js";

export const WEAVE_COMPLETE_STEP_TOOL_NAME = "weave_complete_step";

/** Pi adapter contract: bounded diagnostic projections, closed enums. */
const MAX_MESSAGE_LENGTH = 32 * 1_024;
const MAX_NEXT_STEP_HINT_LENGTH = 4_096;
const MAX_COMPLETION_CANDIDATE_BYTES = 64 * 1_024 * 1_024;
const MAX_ARTIFACT_FIELD_BYTES = 64 * 1_024;

/** The shared diagnostic projection with this module's own marker text. */
function truncateCompletionText(value: string, maxBytes: number): string {
  return projectDiagnosticText(
    value,
    maxBytes,
    "\n… [completion diagnostic truncated]",
  );
}

const COMPLETION_OUTCOMES = new Set(["success", "blocked", "failed", "paused"]);
const COMPLETION_METHODS = new Set([
  "agent_signal",
  "user_confirm",
  "review_verdict",
  "plan_created",
  "plan_complete",
]);

interface RawArtifactRefCandidate {
  readonly name?: unknown;
  readonly path?: unknown;
  readonly mimeType?: unknown;
  readonly description?: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function parseArtifactRefs(
  raw: unknown,
  stepName: string,
): Result<StepCompletionSignal["artifacts"], PiAdapterFailure> {
  if (raw === undefined) return ok(undefined);
  if (!Array.isArray(raw)) {
    return err(
      makeCompletionSignalMalformedFailure(
        stepName,
        "artifacts must be an array",
      ),
    );
  }
  const parsed: Array<{
    name: string;
    path: string;
    mimeType?: string;
    description?: string;
  }> = [];
  const encoder = new TextEncoder();
  let aggregateBytes = 2;
  for (let index = 0; index < raw.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      return err(
        makeCompletionSignalMalformedFailure(
          stepName,
          "artifact entries must be enumerable data properties",
        ),
      );
    }
    const entry = descriptor.value;
    if (!isPlainRecord(entry)) {
      return err(
        makeCompletionSignalMalformedFailure(
          stepName,
          "artifact entry must be an object",
        ),
      );
    }
    const candidate = entry as RawArtifactRefCandidate;
    if (typeof candidate.name !== "string" || candidate.name.length === 0) {
      return err(
        makeCompletionSignalMalformedFailure(
          stepName,
          "artifact name is required",
        ),
      );
    }
    if (typeof candidate.path !== "string" || candidate.path.length === 0) {
      return err(
        makeCompletionSignalMalformedFailure(
          stepName,
          "artifact path is required",
        ),
      );
    }
    if (
      candidate.mimeType !== undefined &&
      typeof candidate.mimeType !== "string"
    ) {
      return err(
        makeCompletionSignalMalformedFailure(
          stepName,
          "artifact mimeType must be a string",
        ),
      );
    }
    if (
      candidate.description !== undefined &&
      typeof candidate.description !== "string"
    ) {
      return err(
        makeCompletionSignalMalformedFailure(
          stepName,
          "artifact description must be a string",
        ),
      );
    }
    const fields = [
      candidate.name,
      candidate.path,
      candidate.mimeType,
      candidate.description,
    ].filter((value): value is string => typeof value === "string");
    const fieldBytes = fields.map((value) => encoder.encode(value).byteLength);
    if (fieldBytes.some((bytes) => bytes > MAX_ARTIFACT_FIELD_BYTES)) {
      return err(
        makeCompletionSignalMalformedFailure(
          stepName,
          "artifact field exceeds the 64 KiB UTF-8 limit",
        ),
      );
    }
    aggregateBytes += fieldBytes.reduce((total, bytes) => total + bytes, 0) + 32;
    if (aggregateBytes > MAX_COMPLETION_CANDIDATE_BYTES) {
      return err(
        makeCompletionSignalMalformedFailure(
          stepName,
          "artifact catalog exceeds the 64 MiB aggregate limit",
        ),
      );
    }
    parsed.push({
      name: candidate.name,
      path: candidate.path,
      ...(candidate.mimeType !== undefined
        ? { mimeType: candidate.mimeType }
        : {}),
      ...(candidate.description !== undefined
        ? { description: candidate.description }
        : {}),
    });
  }
  return ok(parsed);
}

/**
 * Validates one raw completion-candidate payload (the `weave_complete_step`
 * tool's input, exactly as received - never re-derived from prose) against
 * the closed Pi adapter contract shape. `raw === undefined` maps to
 * `CompletionSignalMissing` (the step settled without ever calling the
 * tool); a value failing shape validation maps to
 * `CompletionSignalMalformed`.
 */
export function parseStructuredCompletionCandidate(
  raw: unknown,
  stepName: string,
): Result<StepCompletionSignal, PiAdapterFailure> {
  if (raw === undefined) {
    return err(makeCompletionSignalMissingFailure(stepName));
  }
  if (!isPlainRecord(raw)) {
    return err(
      makeCompletionSignalMalformedFailure(
        stepName,
        "candidate must be a plain object",
      ),
    );
  }
  const outcome = raw.outcome;
  if (typeof outcome !== "string" || !COMPLETION_OUTCOMES.has(outcome)) {
    return err(
      makeCompletionSignalMalformedFailure(
        stepName,
        "outcome is missing or not a closed value",
      ),
    );
  }
  const method = raw.method;
  if (
    method !== undefined &&
    (typeof method !== "string" || !COMPLETION_METHODS.has(method))
  ) {
    return err(
      makeCompletionSignalMalformedFailure(
        stepName,
        "method is not a closed completion method",
      ),
    );
  }
  const approved = raw.approved;
  if (approved !== undefined && typeof approved !== "boolean") {
    return err(
      makeCompletionSignalMalformedFailure(
        stepName,
        "approved must be a boolean",
      ),
    );
  }
  const message = raw.message;
  if (message !== undefined) {
    if (typeof message !== "string") {
      return err(
        makeCompletionSignalMalformedFailure(
          stepName,
          "message must be a string",
        ),
      );
    }

  }
  const nextStepHint = raw.nextStepHint;
  if (nextStepHint !== undefined) {
    if (typeof nextStepHint !== "string") {
      return err(
        makeCompletionSignalMalformedFailure(
          stepName,
          "nextStepHint must be a string",
        ),
      );
    }

  }
  const artifactsResult = parseArtifactRefs(raw.artifacts, stepName);
  if (artifactsResult.isErr()) return err(artifactsResult.error);

  const signal: StepCompletionSignal = {
    outcome: outcome as StepCompletionSignal["outcome"],
    ...(method !== undefined
      ? { method: method as StepCompletionSignal["method"] }
      : {}),
    ...(approved !== undefined ? { approved } : {}),
    ...(message !== undefined
      ? { message: truncateCompletionText(message, MAX_MESSAGE_LENGTH) }
      : {}),
    ...(nextStepHint !== undefined
      ? {
          nextStepHint: truncateCompletionText(
            nextStepHint,
            MAX_NEXT_STEP_HINT_LENGTH,
          ),
        }
      : {}),
    ...(artifactsResult.value !== undefined
      ? { artifacts: artifactsResult.value }
      : {}),
  };
  const serializedBytes = new TextEncoder().encode(
    serializeCompletionCandidate(signal),
  ).byteLength;
  if (serializedBytes > MAX_COMPLETION_CANDIDATE_BYTES) {
    return err(
      makeCompletionSignalMalformedFailure(
        stepName,
        "completion candidate exceeds the 64 MiB serialized limit",
      ),
    );
  }
  return ok(signal);
}

/**
 * Serializes a validated candidate back to a bounded JSON string for the
 * direct-step completion authority. Direct dispatch reuses the private child
 * transport, but its completion semantics are distinct from ordinary
 * delegation's free-text output.
 */
export function serializeCompletionCandidate(candidate: object): string {
  // Re-project the already validated signal before crossing the settlement
  // boundary. This is deliberate defense in depth: a caller cannot smuggle
  // transcript, intervention, thinking, tool, or UI fields into the only
  // completion-authority payload by passing an object with extra properties.
  const signal = candidate as Partial<StepCompletionSignal>;
  const bounded: Partial<StepCompletionSignal> = {
    ...(signal.outcome !== undefined ? { outcome: signal.outcome } : {}),
    ...(signal.method !== undefined ? { method: signal.method } : {}),
    ...(signal.approved !== undefined ? { approved: signal.approved } : {}),
    ...(signal.message !== undefined ? { message: signal.message } : {}),
    ...(signal.nextStepHint !== undefined
      ? { nextStepHint: signal.nextStepHint }
      : {}),
    ...(signal.artifacts !== undefined
      ? {
          artifacts: signal.artifacts.map((artifact) => ({
            name: artifact.name,
            path: artifact.path,
            ...(artifact.mimeType !== undefined
              ? { mimeType: artifact.mimeType }
              : {}),
            ...(artifact.description !== undefined
              ? { description: artifact.description }
              : {}),
          })),
        }
      : {}),
  };
  return JSON.stringify(bounded);
}

/**
 * Parses the bounded JSON string produced by {@link serializeCompletionCandidate}
 * back into a raw candidate value for {@link parseStructuredCompletionCandidate}.
 * Returns `undefined` (mapped by the caller to `CompletionSignalMissing`) for
 * anything that isn't valid, bounded JSON - never throws.
 */
export function tryParseCompletionCandidateJson(raw: string): unknown {
  if (
    raw.length === 0 ||
    new TextEncoder().encode(raw).byteLength > MAX_COMPLETION_CANDIDATE_BYTES
  ) {
    return undefined;
  }
  const parsed = Result.fromThrowable(
    () => JSON.parse(raw) as unknown,
    () => undefined,
  )();
  return parsed.isOk() ? parsed.value : undefined;
}

/** One-shot recorder used by the child-side tool registration: records exactly one candidate, rejects a second as a typed duplicate. */
export class SingleCompletionCandidateRecorder {
  private candidate: StepCompletionSignal | undefined;
  private duplicateAttempted = false;

  record(input: StepCompletionSignal): Result<void, "duplicate"> {
    if (this.candidate !== undefined) {
      this.duplicateAttempted = true;
      return err("duplicate");
    }
    this.candidate = input;
    return ok(undefined);
  }

  take(): StepCompletionSignal | undefined {
    return this.candidate;
  }

  hadDuplicateAttempt(): boolean {
    return this.duplicateAttempted;
  }
}

/**
 * The real Pi-compatible TypeBox parameter schema for `weave_complete_step`
 * (Pi adapter contract), matching {@link parseStructuredCompletionCandidate}'s
 * closed shape exactly: closed outcome/method enums via `StringEnum`
 * (provider-safe, never `anyOf`/`const`), bounded strings, a bounded
 * artifact array.
 */
export function buildWeaveCompleteStepParameters() {
  return Type.Object({
    outcome: StringEnum(["success", "blocked", "failed", "paused"], {
      description: "The step's completion outcome.",
    }),
    method: Type.Optional(
      StringEnum(
        [
          "agent_signal",
          "user_confirm",
          "review_verdict",
          "plan_created",
          "plan_complete",
        ],
        { description: "The workflow step's declared completion method." },
      ),
    ),
    approved: Type.Optional(
      Type.Boolean({
        description:
          "Required for review_verdict: whether the reviewed change is approved.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description:
          "A human-readable completion message. Oversized prose is safely projected.",
      }),
    ),
    nextStepHint: Type.Optional(
      Type.String({
        description:
          "An optional next-step hint. Oversized prose is safely projected.",
      }),
    ),
    artifacts: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String({ minLength: 1, maxLength: MAX_ARTIFACT_FIELD_BYTES }),
          path: Type.String({ minLength: 1, maxLength: MAX_ARTIFACT_FIELD_BYTES }),
          mimeType: Type.Optional(
            Type.String({ maxLength: MAX_ARTIFACT_FIELD_BYTES }),
          ),
          description: Type.Optional(
            Type.String({ maxLength: MAX_ARTIFACT_FIELD_BYTES }),
          ),
        }),
        {
          description:
            "Declared artifact references. Large catalogs use bounded output transfer.",
        },
      ),
    ),
  });
}

export type CompletionRecordOutcome =
  | "recorded"
  | "duplicate"
  | "late"
  | "malformed";

export interface CompletionRecordAttempt {
  readonly outcome: CompletionRecordOutcome;
  readonly malformedReason?: string;
}

/**
 * Pure: classifies one `weave_complete_step` call against the recorder and
 * whether the completion window is still open (Pi adapter contract). Missing,
 * duplicate, malformed, and late are distinct typed outcomes, never merged
 * into a single generic failure.
 */
export function recordCompletionAttempt(
  recorder: SingleCompletionCandidateRecorder,
  windowOpen: boolean,
  raw: unknown,
  stepName: string,
): CompletionRecordAttempt {
  if (!windowOpen) return { outcome: "late" };
  const parsed = parseStructuredCompletionCandidate(raw, stepName);
  if (parsed.isErr()) {
    return { outcome: "malformed", malformedReason: parsed.error.safeMessage };
  }
  const recorded = recorder.record(parsed.value);
  return recorded.isErr() ? { outcome: "duplicate" } : { outcome: "recorded" };
}

/**
 * Builds the one Weave-owned `weave_complete_step` tool for a single
 * direct-step child (Pi adapter contract). Never registered for ordinary-delegation
 * or nested-helper children - only the direct-step bootstrap branch
 * (`mode: "direct-step"`, see `direct-dispatch-transport.ts`) registers
 * this. Records exactly one candidate; never advances workflow state
 * itself - the parent controller validates it after `agent_settled` and
 * calls `completeStep` exactly once.
 *
 */
export function buildWeaveCompleteStepToolRegistration(deps: {
  readonly stepName: string;
  readonly recorder: SingleCompletionCandidateRecorder;
  readonly isWindowOpen: () => boolean;
  /**
   * Fired for every attempt, recorded or not (Pi adapter contract). This is the
   * only observation point available before `agent_settled` fires - the
   * controller consults it (not free-form prose or process-exit state) to
   * distinguish a missing candidate from a duplicate/late/malformed one at
   * settlement time.
   */
  readonly onAttempt?: (attempt: CompletionRecordAttempt) => void;
}): PiToolRegistration {
  const tool: PiToolRegistration = {
    name: WEAVE_COMPLETE_STEP_TOOL_NAME,
    label: "Complete this workflow step",
    description:
      "Records this step's one structured completion candidate. Does not itself advance workflow state - the controller validates it once this turn settles and calls completeStep exactly once.",
    parameters: buildWeaveCompleteStepParameters(),
    promptGuidelines: [
      "Call this exactly once, after finishing the assigned step, with a closed `outcome` and (when the step declares one) its `method`.",
    ],
    execute: async (_toolCallId, params) => {
      const attempt = recordCompletionAttempt(
        deps.recorder,
        deps.isWindowOpen(),
        params,
        deps.stepName,
      );
      if (attempt.outcome === "recorded") {
        deps.onAttempt?.(attempt);
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        };
      }
      deps.onAttempt?.(attempt);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: attempt.outcome }),
          },
        ],
      };
    },
  };
  return tool;
}
