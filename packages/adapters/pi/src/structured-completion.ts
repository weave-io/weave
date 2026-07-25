/**
 * Structured completion for direct workflow-step children (Spec 33 §15).
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
import {
  makeCompletionSignalMalformedFailure,
  makeCompletionSignalMissingFailure,
  type PiAdapterFailure,
} from "./errors.js";
import type { PiWeaveToolRegistration } from "./permission-bridge.js";
import type { PiToolRegistration } from "./types.js";

export const WEAVE_COMPLETE_STEP_TOOL_NAME = "weave_complete_step";
export const WEAVE_COMPLETE_STEP_TOOL_OWNER = "@weaveio/weave-adapter-pi";
export const WEAVE_COMPLETE_STEP_TOOL_REVISION = "1";

/** Spec 33 §15: bounded message, closed enums, no raw content. */
const MAX_MESSAGE_LENGTH = 4096;
const MAX_NEXT_STEP_HINT_LENGTH = 256;
const MAX_ARTIFACT_REFS = 32;

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
  if (raw.length > MAX_ARTIFACT_REFS) {
    return err(
      makeCompletionSignalMalformedFailure(
        stepName,
        "too many declared artifacts",
      ),
    );
  }
  const parsed: Array<{
    name: string;
    path: string;
    mimeType?: string;
    description?: string;
  }> = [];
  for (const entry of raw) {
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
 * the closed Spec 33 §15 shape. `raw === undefined` maps to
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
    if (message.length > MAX_MESSAGE_LENGTH) {
      return err(
        makeCompletionSignalMalformedFailure(
          stepName,
          "message exceeds bounded length",
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
    if (nextStepHint.length > MAX_NEXT_STEP_HINT_LENGTH) {
      return err(
        makeCompletionSignalMalformedFailure(
          stepName,
          "nextStepHint exceeds bounded length",
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
    ...(message !== undefined ? { message } : {}),
    ...(nextStepHint !== undefined ? { nextStepHint } : {}),
    ...(artifactsResult.value !== undefined
      ? { artifacts: artifactsResult.value }
      : {}),
  };
  return ok(signal);
}

/**
 * Serializes a validated candidate back to a bounded JSON string (used as
 * the reusable `PiChildSettlement.summary` payload when a direct-step child
 * settles - Spec 33 §11.2/§15: direct dispatch reuses the private child
 * transport, but its completion semantics are distinct from ordinary
 * delegation's free-text summary).
 */
export function serializeCompletionCandidate(
  candidate: Record<string, unknown>,
): string {
  return JSON.stringify(candidate);
}

/**
 * Parses the bounded JSON string produced by {@link serializeCompletionCandidate}
 * back into a raw candidate value for {@link parseStructuredCompletionCandidate}.
 * Returns `undefined` (mapped by the caller to `CompletionSignalMissing`) for
 * anything that isn't valid, bounded JSON - never throws.
 */
export function tryParseCompletionCandidateJson(raw: string): unknown {
  if (raw.length === 0 || raw.length > MAX_MESSAGE_LENGTH * 4) return undefined;
  const parsed = Result.fromThrowable(
    () => JSON.parse(raw) as unknown,
    () => undefined,
  )();
  return parsed.isOk() ? parsed.value : undefined;
}

/** One-shot recorder used by the child-side tool registration: records exactly one candidate, rejects a second as a typed duplicate. */
export class SingleCompletionCandidateRecorder {
  private candidate: Record<string, unknown> | undefined;
  private duplicateAttempted = false;

  record(input: Record<string, unknown>): Result<void, "duplicate"> {
    if (this.candidate !== undefined) {
      this.duplicateAttempted = true;
      return err("duplicate");
    }
    this.candidate = input;
    return ok(undefined);
  }

  take(): Record<string, unknown> | undefined {
    return this.candidate;
  }

  hadDuplicateAttempt(): boolean {
    return this.duplicateAttempted;
  }
}

/**
 * The real Pi-compatible TypeBox parameter schema for `weave_complete_step`
 * (Spec 33 §15), matching {@link parseStructuredCompletionCandidate}'s
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
        maxLength: MAX_MESSAGE_LENGTH,
        description: "A bounded human-readable completion message.",
      }),
    ),
    nextStepHint: Type.Optional(
      Type.String({
        maxLength: MAX_NEXT_STEP_HINT_LENGTH,
        description: "An optional bounded hint for the next step.",
      }),
    ),
    artifacts: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String({ minLength: 1 }),
          path: Type.String({ minLength: 1 }),
          mimeType: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
        }),
        { maxItems: MAX_ARTIFACT_REFS },
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
 * whether the completion window is still open (Spec 33 §15). Missing,
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
  const recorded = recorder.record(
    parsed.value as unknown as Record<string, unknown>,
  );
  return recorded.isErr() ? { outcome: "duplicate" } : { outcome: "recorded" };
}

/**
 * Builds the one Weave-owned `weave_complete_step` tool for a single
 * direct-step child (Spec 33 §15). Never registered for ordinary-delegation
 * or nested-helper children - only the direct-step bootstrap branch
 * (`mode: "direct-step"`, see `direct-dispatch-transport.ts`) registers
 * this. Records exactly one candidate; never advances workflow state
 * itself - the parent controller validates it after `agent_settled` and
 * calls `completeStep` exactly once.
 *
 * The returned registration sets `controlChannel: true`
 * (`PiWeaveToolRegistration`, `permission-bridge.ts`): this tool reports
 * the child's own completion candidate to its own parent controller, and
 * MUST remain callable regardless of the descriptor's ordinary
 * `read`/`write`/`execute`/`delegate`/`network` tool policy (a smoke
 * descriptor with `execute: deny` must never block its own step-completion
 * report - the exact-host smoke regression this closes). `controlChannel`
 * alone grants nothing; `PiPermissionBridge.intercept()` only honors the
 * bypass when the caller ALSO attests a live `directStepActive: true` for
 * this exact call and live provenance re-verifies every time (see that
 * method's doc comment and `docs/adapter-boundary.md`'s Control-channel
 * tools section).
 */
export function buildWeaveCompleteStepToolRegistration(deps: {
  readonly stepName: string;
  readonly recorder: SingleCompletionCandidateRecorder;
  readonly isWindowOpen: () => boolean;
  /**
   * Fired for every attempt, recorded or not (Spec 33 §15). This is the
   * only observation point available before `agent_settled` fires - the
   * controller consults it (not free-form prose or process-exit state) to
   * distinguish a missing candidate from a duplicate/late/malformed one at
   * settlement time.
   */
  readonly onAttempt?: (attempt: CompletionRecordAttempt) => void;
}): PiWeaveToolRegistration {
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
  return {
    tool,
    owner: WEAVE_COMPLETE_STEP_TOOL_OWNER,
    revision: WEAVE_COMPLETE_STEP_TOOL_REVISION,
    summary: `Report completion of workflow step "${deps.stepName}".`,
    // Marks this registration eligible for `PiPermissionBridge.intercept()`'s
    // narrow control-channel bypass (Spec 33 §15) - see that flag's doc
    // comment on `PiWeaveToolRegistration` for the full contract. This is a
    // private controller-reporting channel, not a user/agent-governable
    // action: it reports the child's own completion candidate to its own
    // parent controller and never requests approval.
    controlChannel: true,
    // Fail-closed fallback ONLY (Spec 33 §15): the bypass above is what
    // actually authorizes this tool for a live, active direct-step child.
    // If that bypass's live conditions are ever not met - e.g. this exact
    // registration somehow reached a nested/ordinary child, or the call
    // arrives outside an active direct-step session - control falls
    // through to this resolver and the ordinary `execute` capability policy
    // applies exactly like any other governed tool, including `deny`.
    resolver: () =>
      ok([
        {
          unresolved: false,
          capability: "execute",
          operation: "complete-step",
          target: { kind: "weave-workflow-step", identifier: deps.stepName },
          display: {
            summary: `Report completion of step "${deps.stepName}"`,
          },
        },
      ]),
  };
}
