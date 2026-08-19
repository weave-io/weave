/**
 * Checked-in publication rollout declaration and tuple contract.
 *
 * The declaration is code-reviewed state. `RELEASE_ROLLOUT_MODE` is external
 * state. The workflow files are observed state. Publication is safe only when
 * those three values form one of the tuples below; no caller may infer a
 * rollout stage from one value alone.
 */
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import {
  RELEASE_PUBLISH_WORKFLOW_PATH,
  RELEASE_WORKFLOW_PATH,
} from "./constants.js";

export const ROLLOUT_STAGE_SCHEMA_VERSION = 1 as const;
export const ROLLOUT_STAGES = ["pre-cutover", "frozen", "ready"] as const;
export type RolloutStage = (typeof ROLLOUT_STAGES)[number];

export const RELEASE_ROLLOUT_MODES = [
  "disabled",
  "dry-run",
  "enabled",
] as const;
export type ReleaseRolloutMode = (typeof RELEASE_ROLLOUT_MODES)[number];

export const NEW_PIPELINE_SCHEDULE = "17 0 * * *" as const;
export const OLD_PIPELINE_WORKFLOW_PATH = RELEASE_WORKFLOW_PATH;
export const NEW_PIPELINE_WORKFLOW_PATH = RELEASE_PUBLISH_WORKFLOW_PATH;

const FULL_SHA = /^[0-9a-f]{40}$/;
const EVIDENCE = z.string().min(1).max(2_048);
const UtcTimestampSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "must be an ISO timestamp",
  );

/** Evidence that the old publisher was quiescent before the freeze. */
export const RolloutFreezeRecordSchema = z
  .object({
    schemaVersion: z.literal(ROLLOUT_STAGE_SCHEMA_VERSION),
    commitSha: z.string().regex(FULL_SHA),
    committedAt: UtcTimestampSchema,
    quiescenceEvidence: EVIDENCE,
  })
  .strict();
export type RolloutFreezeRecord = z.infer<typeof RolloutFreezeRecordSchema>;

/** Evidence that activation was reviewed while the external mode stayed off. */
export const RolloutActivationRecordSchema = z
  .object({
    schemaVersion: z.literal(ROLLOUT_STAGE_SCHEMA_VERSION),
    commitSha: z.string().regex(FULL_SHA),
    committedAt: UtcTimestampSchema,
    greenReport: EVIDENCE,
  })
  .strict();
export type RolloutActivationRecord = z.infer<
  typeof RolloutActivationRecordSchema
>;

export const RolloutStageDeclarationSchema = z
  .object({
    schemaVersion: z.literal(ROLLOUT_STAGE_SCHEMA_VERSION),
    stage: z.enum(ROLLOUT_STAGES),
    freezeRecord: RolloutFreezeRecordSchema.nullable(),
    activationRecord: RolloutActivationRecordSchema.nullable(),
  })
  .strict()
  .superRefine((declaration, context) => {
    if (declaration.stage === "pre-cutover") {
      if (declaration.freezeRecord !== null)
        context.addIssue({
          code: "custom",
          path: ["freezeRecord"],
          message: "pre-cutover cannot carry a freeze record",
        });
      if (declaration.activationRecord !== null)
        context.addIssue({
          code: "custom",
          path: ["activationRecord"],
          message: "pre-cutover cannot carry an activation record",
        });
    }
    if (declaration.stage === "frozen" && declaration.freezeRecord === null)
      context.addIssue({
        code: "custom",
        path: ["freezeRecord"],
        message: "frozen requires a committed freeze record",
      });
    if (declaration.stage === "frozen" && declaration.activationRecord !== null)
      context.addIssue({
        code: "custom",
        path: ["activationRecord"],
        message: "frozen cannot carry an activation record",
      });
    if (declaration.stage === "ready") {
      if (declaration.freezeRecord === null)
        context.addIssue({
          code: "custom",
          path: ["freezeRecord"],
          message: "ready requires the prior freeze record",
        });
      if (declaration.activationRecord === null)
        context.addIssue({
          code: "custom",
          path: ["activationRecord"],
          message: "ready requires a committed activation record",
        });
    }
  });
export type RolloutStageDeclaration = z.infer<
  typeof RolloutStageDeclarationSchema
>;

/**
 * The observed workflow topology. Presence is not enough: a workflow is
 * operational only when its schedule trigger is present too.
 */
export interface WorkflowTopology {
  readonly oldWorkflowPresent: boolean;
  readonly oldWorkflowScheduled: boolean;
  readonly newWorkflowPresent: boolean;
  readonly newWorkflowScheduled: boolean;
  /** Optional repository-side checks used by doctor, not by the tuple rules. */
  readonly oldWorkflowOperational?: boolean;
  readonly newWorkflowGateDisabled?: boolean;
  readonly attestationWorkflowPresent?: boolean;
  readonly attestationWorkflowCalls?: boolean;
}

export const WorkflowTopologySchema = z
  .object({
    oldWorkflowPresent: z.boolean(),
    oldWorkflowScheduled: z.boolean(),
    newWorkflowPresent: z.boolean(),
    newWorkflowScheduled: z.boolean(),
    oldWorkflowOperational: z.boolean().optional(),
    newWorkflowGateDisabled: z.boolean().optional(),
    attestationWorkflowPresent: z.boolean().optional(),
    attestationWorkflowCalls: z.boolean().optional(),
  })
  .strict();

export interface RolloutTuple {
  readonly declaration: RolloutStageDeclaration;
  readonly stage: RolloutStage;
  readonly mode: ReleaseRolloutMode;
  readonly topology: WorkflowTopology;
  readonly publicationCapable: boolean;
}

export type RolloutTupleError =
  | {
      type: "InvalidRolloutStageDeclaration";
      issues: readonly string[];
    }
  | { type: "InvalidRolloutMode"; mode: unknown }
  | { type: "InvalidWorkflowTopology"; issues: readonly string[] }
  | {
      type: "RolloutInvalidState";
      reason: string;
      stage: RolloutStage;
      mode: ReleaseRolloutMode;
    };

/** The initial checked-in state. It cannot publish and carries no evidence. */
export const ROLLOUT_STAGE_DECLARATION: RolloutStageDeclaration = {
  schemaVersion: ROLLOUT_STAGE_SCHEMA_VERSION,
  stage: "pre-cutover",
  freezeRecord: null,
  activationRecord: null,
};

/** Alias used by runtime consumers that prefer a shorter declaration name. */
export const ROLLOUT_STAGE = ROLLOUT_STAGE_DECLARATION;

export function parseReleaseRolloutMode(
  value: unknown,
): Result<ReleaseRolloutMode, RolloutTupleError> {
  if (
    typeof value === "string" &&
    (RELEASE_ROLLOUT_MODES as readonly string[]).includes(value)
  )
    return ok(value as ReleaseRolloutMode);
  return err({ type: "InvalidRolloutMode", mode: value });
}

export function validateRolloutStageDeclaration(
  input: unknown,
): Result<RolloutStageDeclaration, RolloutTupleError> {
  const declarationInput =
    typeof input === "string" &&
    (ROLLOUT_STAGES as readonly string[]).includes(input)
      ? {
          schemaVersion: ROLLOUT_STAGE_SCHEMA_VERSION,
          stage: input,
          freezeRecord: null,
          activationRecord: null,
        }
      : input;
  const parsed = RolloutStageDeclarationSchema.safeParse(declarationInput);
  if (!parsed.success)
    return err({
      type: "InvalidRolloutStageDeclaration",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  return ok(parsed.data);
}

export function validateWorkflowTopology(
  input: unknown,
): Result<WorkflowTopology, RolloutTupleError> {
  const parsed = WorkflowTopologySchema.safeParse(
    normalizeWorkflowTopologyInput(input),
  );
  if (!parsed.success)
    return err({
      type: "InvalidWorkflowTopology",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  return ok(parsed.data);
}

/**
 * Validates the complete rollout tuple. The table is intentionally strict:
 * there is no tuple in which both publishers are live, neither is live, or a
 * mode flip outruns the committed stage evidence.
 */
export function validateRolloutTuple(
  declarationInput: unknown,
  modeInput: unknown,
  topologyInput: unknown,
): Result<RolloutTuple, RolloutTupleError> {
  const declaration = validateRolloutStageDeclaration(declarationInput);
  if (declaration.isErr()) return err(declaration.error);
  const mode = parseReleaseRolloutMode(modeInput);
  if (mode.isErr()) return err(mode.error);
  const topology = validateWorkflowTopology(topologyInput);
  if (topology.isErr()) return err(topology.error);

  const stage = declaration.value.stage;
  const tupleError = invalidTupleReason(stage, mode.value, topology.value);
  if (tupleError !== undefined)
    return err({
      type: "RolloutInvalidState",
      reason: tupleError,
      stage,
      mode: mode.value,
    });
  return ok({
    declaration: declaration.value,
    stage,
    mode: mode.value,
    topology: topology.value,
    publicationCapable: stage === "ready" && mode.value === "enabled",
  });
}

/** Alias for callers that name the declaration separately from the tuple. */
export const validateRolloutState = validateRolloutTuple;

export function isPublicationCapableTuple(tuple: RolloutTuple): boolean {
  return tuple.publicationCapable;
}

function normalizeWorkflowTopologyInput(input: unknown): unknown {
  const record = topologyRecord(input);
  if (record === undefined) return input;
  const oldNested = topologyRecord(
    record.oldWorkflow ?? record.oldPublishWorkflow,
  );
  const newNested = topologyRecord(
    record.newWorkflow ?? record.newPublishWorkflow,
  );
  const oldPresent =
    booleanField(record, ["oldWorkflowPresent", "oldPublishWorkflowPresent"]) ??
    booleanField(oldNested, ["present", "exists"]);
  const oldScheduled =
    booleanField(record, [
      "oldWorkflowScheduled",
      "oldPublishWorkflowScheduled",
    ]) ?? booleanField(oldNested, ["scheduled", "schedule"]);
  const newPresent =
    booleanField(record, ["newWorkflowPresent", "newPublishWorkflowPresent"]) ??
    booleanField(newNested, ["present", "exists"]);
  const newScheduled =
    booleanField(record, [
      "newWorkflowScheduled",
      "newPublishWorkflowScheduled",
    ]) ?? booleanField(newNested, ["scheduled", "schedule"]);
  const oldOperational = booleanField(record, ["oldWorkflowOperational"]);
  const newOperational = booleanField(record, ["newWorkflowOperational"]);
  const normalized = {
    oldWorkflowPresent: oldPresent ?? oldOperational,
    oldWorkflowScheduled: oldScheduled ?? oldOperational,
    newWorkflowPresent: newPresent ?? newOperational,
    newWorkflowScheduled: newScheduled ?? newOperational,
  };
  if (
    normalized.oldWorkflowPresent === undefined ||
    normalized.oldWorkflowScheduled === undefined ||
    normalized.newWorkflowPresent === undefined ||
    normalized.newWorkflowScheduled === undefined
  )
    return input;
  for (const key of [
    "oldWorkflowOperational",
    "newWorkflowGateDisabled",
    "attestationWorkflowPresent",
    "attestationWorkflowCalls",
  ] as const) {
    const value = record[key];
    if (typeof value === "boolean")
      (normalized as Record<string, unknown>)[key] = value;
  }
  return normalized;
}

function topologyRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function booleanField(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): boolean | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function invalidTupleReason(
  stage: RolloutStage,
  mode: ReleaseRolloutMode,
  topology: WorkflowTopology,
): string | undefined {
  const oldOperational =
    topology.oldWorkflowPresent && topology.oldWorkflowScheduled;
  const newOperational =
    topology.newWorkflowPresent && topology.newWorkflowScheduled;

  if (topology.newWorkflowPresent && topology.newWorkflowGateDisabled === false)
    return "new workflow is not protected by the rollout gate";

  if (topology.oldWorkflowScheduled && !topology.oldWorkflowPresent)
    return "old workflow schedule was observed without the old workflow";
  if (topology.newWorkflowScheduled && !topology.newWorkflowPresent)
    return "new workflow schedule was observed without release-publish.yml";
  if (oldOperational && newOperational)
    return "old and new publication workflows are both operational";
  if (!oldOperational && !newOperational)
    return "neither publication workflow is operational";

  if (stage === "pre-cutover") {
    if (mode === "enabled")
      return "publication cannot be enabled before cutover";
    if (!oldOperational)
      return "pre-cutover requires the old scheduled workflow";
    if (newOperational)
      return "pre-cutover requires a scheduleless new workflow";
    if (topology.newWorkflowPresent && topology.newWorkflowScheduled)
      return "pre-cutover new workflow must be scheduleless";
    return undefined;
  }

  if (!newOperational) return `${stage} requires the new scheduled workflow`;
  if (oldOperational) return `${stage} forbids the old scheduled workflow`;
  if (topology.oldWorkflowPresent || topology.oldWorkflowScheduled)
    return `${stage} requires publish.yml to be absent`;
  if (!topology.newWorkflowPresent)
    return `${stage} requires release-publish.yml`;
  if (stage === "frozen") {
    if (mode !== "disabled") return "frozen rollout must remain disabled";
    if (topology.newWorkflowScheduled !== true)
      return "frozen rollout requires the new schedule";
    return undefined;
  }

  if (mode === "dry-run") return "ready accepts only disabled or enabled mode";
  if (topology.newWorkflowScheduled !== true)
    return "ready requires the new schedule";
  return undefined;
}

/** Builds a valid freeze record for tests and reviewed rollout tooling. */
export function createRolloutFreezeRecord(input: {
  commitSha: string;
  committedAt: string;
  quiescenceEvidence: string;
}): Result<RolloutFreezeRecord, RolloutTupleError> {
  const parsed = RolloutFreezeRecordSchema.safeParse({
    schemaVersion: ROLLOUT_STAGE_SCHEMA_VERSION,
    ...input,
  });
  if (!parsed.success)
    return err({
      type: "InvalidRolloutStageDeclaration",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  return ok(parsed.data);
}

/** Builds a valid activation record for tests and reviewed rollout tooling. */
export function createRolloutActivationRecord(input: {
  commitSha: string;
  committedAt: string;
  greenReport: string;
}): Result<RolloutActivationRecord, RolloutTupleError> {
  const parsed = RolloutActivationRecordSchema.safeParse({
    schemaVersion: ROLLOUT_STAGE_SCHEMA_VERSION,
    ...input,
  });
  if (!parsed.success)
    return err({
      type: "InvalidRolloutStageDeclaration",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  return ok(parsed.data);
}
