/**
 * `TrajectoryEvent` union, `TrajectoryResult` shape, and related typed errors.
 *
 * Normative source: docs/specs/33-spec-harness-trajectory-evals/33-spec-harness-trajectory-evals.md
 *
 * The engine only ever consumes this normalized event union. It never
 * inspects harness-native log formats or plugin hook payloads directly —
 * adapters are responsible for producing a stream of these events
 * regardless of which observation channel (A: log parsing, B: plugin
 * hooks) they use internally. See the spec's "Two-Channel Adapter
 * Contract" section and docs/adapter-boundary.md.
 */

import type { ResultAsync } from "neverthrow";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Common envelope
// ---------------------------------------------------------------------------

const TimestampSchema = z.iso.datetime({ offset: true });

const CommonEnvelopeSchema = z.object({
  sessionId: z.string(),
  timestamp: TimestampSchema,
});

// ---------------------------------------------------------------------------
// TrajectoryEvent union — one schema per event kind
// ---------------------------------------------------------------------------

export const SessionCreatedEventSchema = CommonEnvelopeSchema.extend({
  kind: z.literal("session-created"),
  agentName: z.string(),
  model: z.string(),
}).strict();

export const SubagentSpawnedEventSchema = CommonEnvelopeSchema.extend({
  kind: z.literal("subagent-spawned"),
  parentAgentName: z.string(),
  childAgentName: z.string(),
}).strict();

export const ToolCallBeforeEventSchema = CommonEnvelopeSchema.extend({
  kind: z.literal("tool-call-before"),
  toolName: z.string(),
  agentName: z.string(),
}).strict();

export const ToolCallAfterEventSchema = CommonEnvelopeSchema.extend({
  kind: z.literal("tool-call-after"),
  toolName: z.string(),
  agentName: z.string(),
  succeeded: z.boolean(),
}).strict();

export const MessageEmittedEventSchema = CommonEnvelopeSchema.extend({
  kind: z.literal("message-emitted"),
  role: z.enum(["user", "assistant", "tool"]),
  agentName: z.string(),
}).strict();

export const SessionCompletedEventSchema = CommonEnvelopeSchema.extend({
  kind: z.literal("session-completed"),
  agentName: z.string(),
  durationMs: z.number(),
}).strict();

export const SessionErroredEventSchema = CommonEnvelopeSchema.extend({
  kind: z.literal("session-errored"),
  agentName: z.string(),
  errorKind: z.string(),
}).strict();

export const TrajectoryEventSchema = z.discriminatedUnion("kind", [
  SessionCreatedEventSchema,
  SubagentSpawnedEventSchema,
  ToolCallBeforeEventSchema,
  ToolCallAfterEventSchema,
  MessageEmittedEventSchema,
  SessionCompletedEventSchema,
  SessionErroredEventSchema,
]);

export type SessionCreatedEvent = z.infer<typeof SessionCreatedEventSchema>;
export type SubagentSpawnedEvent = z.infer<typeof SubagentSpawnedEventSchema>;
export type ToolCallBeforeEvent = z.infer<typeof ToolCallBeforeEventSchema>;
export type ToolCallAfterEvent = z.infer<typeof ToolCallAfterEventSchema>;
export type MessageEmittedEvent = z.infer<typeof MessageEmittedEventSchema>;
export type SessionCompletedEvent = z.infer<typeof SessionCompletedEventSchema>;
export type SessionErroredEvent = z.infer<typeof SessionErroredEventSchema>;
export type TrajectoryEvent = z.infer<typeof TrajectoryEventSchema>;

// ---------------------------------------------------------------------------
// TrajectorySummary — publishable field set (closed; see spec §Publishable
// Field Set). No other trajectory-derived field may appear here without a
// new ADR.
// ---------------------------------------------------------------------------

export const TrajectorySummarySchema = z
  .object({
    harnessDelegatedCorrectly: z.boolean(),
    observedSpawns: z.array(z.string()),
    observedToolCalls: z.number(),
    harnessCompletedWithoutError: z.boolean(),
  })
  .strict();

export type TrajectorySummary = z.infer<typeof TrajectorySummarySchema>;

// ---------------------------------------------------------------------------
// RawArtifactRef — local-only, never published
// ---------------------------------------------------------------------------

export const RawArtifactRefSchema = z
  .object({
    path: z.string(),
  })
  .strict();

export type RawArtifactRef = z.infer<typeof RawArtifactRefSchema>;

// ---------------------------------------------------------------------------
// TrajectoryResult — event stream + publishable summary + local-only ref
// ---------------------------------------------------------------------------

export const TrajectoryResultSchema = z
  .object({
    events: z.array(TrajectoryEventSchema),
    summary: TrajectorySummarySchema,
    rawArtifactRef: RawArtifactRefSchema,
  })
  .strict();

export type TrajectoryResult = z.infer<typeof TrajectoryResultSchema>;

// ---------------------------------------------------------------------------
// TrajectoryRunnerError — typed, discriminated, neverthrow-style error union
// ---------------------------------------------------------------------------

export type TrajectoryRunnerError =
  | {
      type: "SandboxStartFailed";
      testCaseId: string;
      model: string;
    }
  | {
      type: "TimeoutExceeded";
      testCaseId: string;
      model: string;
    }
  | {
      type: "EventStreamMalformed";
      testCaseId: string;
      model: string;
    }
  | {
      type: "HarnessCrashed";
      testCaseId: string;
      model: string;
    }
  | {
      type: "WorkspaceUnavailable";
      testCaseId: string;
      model: string;
    };

// ---------------------------------------------------------------------------
// TrajectoryEventParseError — typed parse/validation error for callers that
// validate a raw adapter-produced payload against TrajectoryEventSchema.
// ---------------------------------------------------------------------------

export type TrajectoryEventParseError = {
  type: "TrajectoryEventParseError";
  path: string;
  message: string;
};

// ---------------------------------------------------------------------------
// TrajectoryRunner interface — adapter-implemented contract
//
// Normative source: docs/specs/33-spec-harness-trajectory-evals §"TrajectoryRunner
// Interface". The spec's `run()` signature takes an `EvalCase` from
// `packages/cli/src/evals/types.ts`, but `@weaveio/weave-core` (and adapter
// packages that depend on it) must never depend on `@weaveio/weave-cli` —
// that would invert the dependency graph. `TrajectoryCase` below is the
// minimal, engine/adapter-owned projection of the `expected_outcome.kind ===
// "harness_trajectory"` fields an adapter's `TrajectoryRunner` actually
// needs. The `@weaveio/weave-cli` eval runner is responsible for narrowing a
// full `EvalCase` down to this shape before calling an adapter's runner.
// ---------------------------------------------------------------------------

/**
 * Minimal per-case fields a `TrajectoryRunner` needs from an
 * `expected_outcome.kind === "harness_trajectory"` eval case. See the module
 * doc comment above for why this is not the full `EvalCase` shape.
 */
export interface TrajectoryCase {
  /** Correlates results and errors back to the originating eval case. */
  testCaseId: string;
  /** Ordered list of child agent names the harness is expected to spawn. */
  expectedSpawns: string[];
  /** Tool names the harness is expected to invoke at least once. */
  expectedTools: string[];
  /** Wall-clock budget for the whole session, in seconds. */
  maxDurationSeconds: number;
  /** Symbolic name of the adapter-owned sandbox profile to run under. */
  sandboxProfile: string;
}

/**
 * Adapter-provided handle to the ephemeral per-case workspace. The engine
 * never constructs this value; it is supplied by the adapter's harness-
 * specific setup step.
 */
export interface TrajectoryWorkspace {
  /** Absolute path to the mounted workspace directory (`/workspace`). */
  root: string;
  /** Absolute path to the mounted artifacts directory (`/artifacts`). */
  artifactsDir: string;
}

/**
 * Adapter-implemented contract that produces a `TrajectoryResult` from a
 * case, a model, and a workspace. See docs/specs/33-spec-harness-trajectory-evals
 * for the full normative contract.
 */
export interface TrajectoryRunner {
  run(
    testCase: TrajectoryCase,
    model: string,
    workspace: TrajectoryWorkspace,
  ): ResultAsync<TrajectoryResult, TrajectoryRunnerError>;
}
