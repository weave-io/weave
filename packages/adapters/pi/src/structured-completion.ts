/**
 * Structured completion for direct workflow-step children (Pi adapter contract).
 *
 * A direct-step child receives exactly one governed `weave_complete_step`
 * tool. Its closed input is the only legitimate source of a completion
 * candidate: process exit, free-form prose, or a second/late call never counts
 * as success. This module parses a bounded, descriptor-safe snapshot and
 * projects only the fields owned by the engine's completion signal.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { copySafeGraph, type SafeGraphCopyBudget } from "@weaveio/weave-core";
import type { StepCompletionSignal } from "@weaveio/weave-engine";
import { err, ok, type Result } from "neverthrow";
import { Type } from "typebox";
import { z } from "zod";
import { projectDiagnosticText } from "./child-diagnostic-projection.js";
import {
  makeCompletionSignalMalformedFailure,
  makeCompletionSignalMissingFailure,
  type PiAdapterFailure,
} from "./errors.js";
import { type JsonValue, parseStrictJson } from "./strict-json.js";
import type { PiToolRegistration } from "./types.js";

export const WEAVE_COMPLETE_STEP_TOOL_NAME = "weave_complete_step";

/** Pi adapter contract: bounded diagnostic projections, closed enums. */
const MAX_MESSAGE_LENGTH = 32 * 1_024;
const MAX_NEXT_STEP_HINT_LENGTH = 4_096;
const MAX_COMPLETION_CANDIDATE_BYTES = 64 * 1_024 * 1_024;
const MAX_ARTIFACT_FIELD_BYTES = 64 * 1_024;

const TextEncoderInstance = new TextEncoder();

/** The shared diagnostic projection with this module's own marker text. */
function truncateCompletionText(value: string, maxBytes: number): string {
  return projectDiagnosticText(
    value,
    maxBytes,
    "\n… [completion diagnostic truncated]",
  );
}

const ArtifactTextSchema = z
  .string()
  .refine(
    (value) =>
      TextEncoderInstance.encode(value).byteLength <= MAX_ARTIFACT_FIELD_BYTES,
    `must be at most ${MAX_ARTIFACT_FIELD_BYTES} UTF-8 bytes`,
  );

const ArtifactRefSchema = z
  .object({
    name: ArtifactTextSchema.min(1),
    path: ArtifactTextSchema.min(1),
    mimeType: ArtifactTextSchema.optional(),
    description: ArtifactTextSchema.optional(),
  })
  .strip();

const ArtifactListSchema = z
  .array(ArtifactRefSchema)
  .superRefine((artifacts, ctx) => {
    let aggregateBytes = 2;
    for (const artifact of artifacts) {
      const fields = [
        artifact.name,
        artifact.path,
        artifact.mimeType,
        artifact.description,
      ];
      for (const field of fields) {
        if (field !== undefined) {
          aggregateBytes += TextEncoderInstance.encode(field).byteLength;
        }
      }
      aggregateBytes += 32;
      if (aggregateBytes > MAX_COMPLETION_CANDIDATE_BYTES) {
        ctx.addIssue({
          code: "custom",
          message: "artifact catalog exceeds the 64 MiB aggregate limit",
        });
        return;
      }
    }
  });

const CompletionCandidateSchema = z
  .object({
    outcome: z.enum(["success", "blocked", "failed", "paused"]),
    method: z
      .enum([
        "agent_signal",
        "user_confirm",
        "review_verdict",
        "plan_created",
        "plan_complete",
      ])
      .optional(),
    approved: z.boolean().optional(),
    message: z.string().optional(),
    nextStepHint: z.string().optional(),
    artifacts: ArtifactListSchema.optional(),
  })
  // Unknown tool fields are accepted for Pi compatibility but are never
  // retained: the parsed output is this explicit allowlist only.
  .strip();

const CompletionCandidateInputBoundary = z.preprocess(
  (value) => value,
  z.json(),
);

const COMPLETION_GRAPH_BUDGET = {
  maxDepth: 64,
  maxNodes: 4_096,
  maxProperties: 4_096,
  maxPropertiesPerObject: 512,
  maxArrayLength: 512,
  maxStringLength: MAX_COMPLETION_CANDIDATE_BYTES,
} satisfies SafeGraphCopyBudget;

type ParsedArtifactRef = z.output<typeof ArtifactRefSchema>;

interface MutableArtifactProjection {
  name: string;
  path: string;
  mimeType?: string;
  description?: string;
}

interface MutableCompletionSignal {
  outcome: StepCompletionSignal["outcome"];
  method?: StepCompletionSignal["method"];
  approved?: boolean;
  message?: string;
  nextStepHint?: string;
  artifacts?: readonly MutableArtifactProjection[];
}

interface CompletionCandidateSource {
  readonly outcome?: unknown;
  readonly method?: unknown;
  readonly approved?: unknown;
  readonly message?: unknown;
  readonly nextStepHint?: unknown;
  readonly artifacts?: unknown;
}

function projectArtifact(
  artifact: ParsedArtifactRef,
): MutableArtifactProjection {
  const projected: MutableArtifactProjection = {
    name: artifact.name,
    path: artifact.path,
  };
  if (artifact.mimeType !== undefined) projected.mimeType = artifact.mimeType;
  if (artifact.description !== undefined) {
    projected.description = artifact.description;
  }
  return projected;
}

type ParsedCompletionCandidate = z.output<typeof CompletionCandidateSchema>;

function projectCandidate(
  candidate: ParsedCompletionCandidate,
): MutableCompletionSignal {
  const signal: MutableCompletionSignal = { outcome: candidate.outcome };
  if (candidate.method !== undefined) signal.method = candidate.method;
  if (candidate.approved !== undefined) signal.approved = candidate.approved;
  if (candidate.message !== undefined) {
    signal.message = truncateCompletionText(
      candidate.message,
      MAX_MESSAGE_LENGTH,
    );
  }
  if (candidate.nextStepHint !== undefined) {
    signal.nextStepHint = truncateCompletionText(
      candidate.nextStepHint,
      MAX_NEXT_STEP_HINT_LENGTH,
    );
  }
  if (candidate.artifacts !== undefined) {
    signal.artifacts = candidate.artifacts.map(projectArtifact);
  }
  return signal;
}

function malformedCompletion(
  stepName: string,
  parsed: z.ZodSafeParseError<ParsedCompletionCandidate>,
): Result<never, PiAdapterFailure> {
  const issue = parsed.error.issues[0];
  return err(
    makeCompletionSignalMalformedFailure(
      stepName,
      issue?.message ?? "candidate failed schema validation",
    ),
  );
}

/**
 * Validates one raw completion-candidate payload (the `weave_complete_step`
 * tool input) against the closed Pi adapter contract. `undefined` maps to
 * `CompletionSignalMissing`; every other failure maps to `CompletionSignalMalformed`.
 */
export function parseStructuredCompletionCandidate(
  raw: z.input<typeof CompletionCandidateInputBoundary>,
  stepName: string,
): Result<StepCompletionSignal, PiAdapterFailure> {
  if (raw === undefined) {
    return err(makeCompletionSignalMissingFailure(stepName));
  }

  const copied = copySafeGraph(raw, COMPLETION_GRAPH_BUDGET);
  if (copied.isErr()) {
    return err(
      makeCompletionSignalMalformedFailure(
        stepName,
        "candidate contains unsafe object data",
      ),
    );
  }

  const parsed = CompletionCandidateSchema.safeParse(copied.value);
  if (!parsed.success) return malformedCompletion(stepName, parsed);

  const signal = projectCandidate(parsed.data);

  const serializedBytes = TextEncoderInstance.encode(
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
export function serializeCompletionCandidate(
  candidate: CompletionCandidateSource,
): string {
  // Re-project the already validated signal before crossing the settlement
  // boundary. This allowlist prevents transcript, intervention, thinking, tool,
  // or UI fields from entering the completion-authority payload. A caller that
  // supplies an unsafe or malformed object gets an empty projection rather than
  // an exception or an unvalidated field crossing the settlement boundary.
  const copied = copySafeGraph(candidate, COMPLETION_GRAPH_BUDGET);
  if (copied.isErr()) return JSON.stringify({});
  const parsed = CompletionCandidateSchema.safeParse(copied.value);
  if (!parsed.success) return JSON.stringify({});
  return JSON.stringify(projectCandidate(parsed.data));
}

/**
 * Parses the bounded JSON string produced by {@link serializeCompletionCandidate}
 * back into parser-approved JSON for {@link parseStructuredCompletionCandidate}.
 * Invalid, duplicate-key, trailing, or oversized input returns `undefined`.
 */
interface CompletionCandidateJsonArtifact {
  readonly name: string;
  readonly path: string;
  readonly mimeType?: string;
  readonly description?: string;
}

interface CompletionCandidateJsonRecord {
  readonly outcome?: StepCompletionSignal["outcome"];
  readonly method?: StepCompletionSignal["method"];
  readonly approved?: boolean;
  readonly message?: string;
  readonly nextStepHint?: string;
  readonly artifacts?: readonly CompletionCandidateJsonArtifact[];
}

export type CompletionCandidateJson = JsonValue | CompletionCandidateJsonRecord;

export function tryParseCompletionCandidateJson(
  raw: string,
): CompletionCandidateJson | undefined {
  if (
    raw.length === 0 ||
    TextEncoderInstance.encode(raw).byteLength > MAX_COMPLETION_CANDIDATE_BYTES
  ) {
    return undefined;
  }
  const parsed = parseStrictJson(raw);
  return parsed.isOk() ? parsed.value : undefined;
}

/** One-shot recorder used by the child-side tool registration. */
export class SingleCompletionCandidateRecorder {
  private candidate: StepCompletionSignal | undefined;
  private duplicateAttempted = false;

  record(input: StepCompletionSignal): Result<void, "duplicate"> {
    if (this.candidate !== undefined) {
      this.duplicateAttempted = true;
      return err("duplicate");
    }
    this.candidate = input;
    return ok();
  }

  take(): StepCompletionSignal | undefined {
    return this.candidate;
  }

  hadDuplicateAttempt(): boolean {
    return this.duplicateAttempted;
  }
}

/**
 * The real Pi-compatible TypeBox parameter schema for `weave_complete_step`.
 * It mirrors the parser's closed outcome/method enums and bounded artifact
 * fields while keeping the provider-safe `StringEnum` representation.
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
          name: Type.String({
            minLength: 1,
            maxLength: MAX_ARTIFACT_FIELD_BYTES,
          }),
          path: Type.String({
            minLength: 1,
            maxLength: MAX_ARTIFACT_FIELD_BYTES,
          }),
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

/** Classifies one completion-tool call against the one-shot recorder. */
export function recordCompletionAttempt(
  recorder: SingleCompletionCandidateRecorder,
  windowOpen: boolean,
  raw: z.input<typeof CompletionCandidateInputBoundary>,
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
 * Builds the one Weave-owned `weave_complete_step` tool for a direct-step
 * child. It records exactly one candidate and never advances workflow state.
 */
export function buildWeaveCompleteStepToolRegistration(deps: {
  readonly stepName: string;
  readonly recorder: SingleCompletionCandidateRecorder;
  readonly isWindowOpen: () => boolean;
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
      deps.onAttempt?.(attempt);
      if (attempt.outcome === "recorded") {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
        };
      }
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
