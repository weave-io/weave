/**
 * Execution Lifecycle — approveArtifact implementation.
 *
 * Handles artifact approval/rejection with actor validation, revision/digest
 * binding, self-approval prohibition, and lease enforcement.
 *
 * @see docs/adapters/pi.md#workflow-projection
 * @see docs/adr/0010-plan-state-and-artifact-approval-authority.md
 */

import {
  err,
  errAsync,
  type Result as NeverthrowResult,
  ok,
  okAsync,
  Result,
} from "neverthrow";
import { z } from "zod";
import type { RuntimeStore } from "../runtime/store.js";
import type { ArtifactApprovalActor } from "../runtime/types.js";
import {
  lifecycleNotFoundError,
  lifecyclePolicyDecisionError,
  lifecycleValidationError,
} from "./errors.js";
import { mapStoreError, validateActiveLease } from "./lease.js";
import { sanitizeMetadata } from "./metadata.js";
import type {
  ApproveArtifactInput,
  ApproveArtifactOutput,
  ApproveArtifactResult,
  ArtifactRef,
  LifecycleError,
  WorkflowExecutionContext,
} from "./types.js";

const encoder = new TextEncoder();

interface RecordCandidateObject {
  readonly [key: string]: RecordCandidate;
}

type RecordCandidateCallable = (...args: never[]) => void;

type RecordCandidate =
  | RecordCandidateObject
  | readonly RecordCandidate[]
  | RecordCandidateCallable
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;
type ProvenanceScalar = string | number | boolean;

interface CapturedDataRecord {
  [key: string]: RecordCandidate;
}

interface CapturedProvenance {
  [key: string]: ProvenanceScalar;
}

interface ArtifactApprovalUpdate {
  actor: ArtifactApprovalActor;
  decidedAt: string;
  expectedRevision: number;
  expectedDigest?: string;
}

const stringCandidateSchema = z.string();

function isPlainRecordCandidate(
  value: RecordCandidate,
): value is RecordCandidateObject {
  return (
    value !== null &&
    Object(value) === value &&
    !Array.isArray(value) &&
    !(value instanceof Function)
  );
}

function stringCandidate(value: RecordCandidate): string | undefined {
  const parsed = stringCandidateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isBooleanCandidate(value: RecordCandidate): value is boolean {
  return value === true || value === false;
}

function isFiniteNumberCandidate(value: RecordCandidate): value is number {
  return Number.isFinite(value);
}

function isStringPropertyKey(key: PropertyKey): key is string {
  return String(key) === key;
}

function captureDataRecord(
  value: RecordCandidate,
  expectedKeys?: readonly string[],
): NeverthrowResult<Readonly<CapturedDataRecord>, LifecycleError> {
  return Result.fromThrowable(
    () => {
      if (
        !isPlainRecordCandidate(value) ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
      ) {
        return err(
          lifecycleValidationError("expected a plain record", "actor"),
        );
      }
      const keys = Reflect.ownKeys(value);
      const stringKeys = keys.filter(isStringPropertyKey);
      if (stringKeys.length !== keys.length) {
        return err(
          lifecycleValidationError("symbol keys are not allowed", "actor"),
        );
      }
      if (expectedKeys !== undefined) {
        if (stringKeys.length !== expectedKeys.length) {
          return err(
            lifecycleValidationError("actor fields are invalid", "actor"),
          );
        }
        for (const key of stringKeys) {
          if (!expectedKeys.includes(key)) {
            return err(
              lifecycleValidationError("actor fields are invalid", "actor"),
            );
          }
        }
      }
      const capture: CapturedDataRecord = Object.create(null);
      for (const key of stringKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          descriptor.enumerable !== true ||
          !("value" in descriptor)
        ) {
          return err(
            lifecycleValidationError(
              "actor fields must be enumerable data properties",
              "actor",
            ),
          );
        }
        const descriptorValue: RecordCandidate = descriptor.value;
        capture[key] = descriptorValue;
      }
      return ok(Object.freeze(capture));
    },
    () => lifecycleValidationError("actor reflection failed", "actor"),
  )().andThen((result) => result);
}

function captureProvenance(
  value: RecordCandidate,
): NeverthrowResult<Readonly<CapturedProvenance>, LifecycleError> {
  const record = captureDataRecord(value);
  if (record.isErr()) {
    return err(
      lifecycleValidationError(
        "user actor requires plain provenance metadata",
        "actor.provenance",
      ),
    );
  }
  const keys = Object.keys(record.value);
  if (keys.length > 32) {
    return err(
      lifecycleValidationError(
        "user provenance exceeds 32 fields",
        "actor.provenance",
      ),
    );
  }
  const captured: CapturedProvenance = Object.create(null);
  for (const key of keys) {
    const value = record.value[key];
    if (encoder.encode(key).byteLength > 64) {
      return err(
        lifecycleValidationError(
          "user provenance key is too long",
          "actor.provenance",
        ),
      );
    }
    const stringValue = stringCandidate(value);
    if (stringValue !== undefined) {
      if (encoder.encode(stringValue).byteLength > 512) {
        return err(
          lifecycleValidationError(
            "user provenance value is too long",
            "actor.provenance",
          ),
        );
      }
      captured[key] = stringValue;
      continue;
    }
    if (isBooleanCandidate(value)) {
      captured[key] = value;
      continue;
    }
    if (isFiniteNumberCandidate(value)) {
      captured[key] = value;
      continue;
    }
    return err(
      lifecycleValidationError(
        "user provenance values must be finite scalars",
        "actor.provenance",
      ),
    );
  }
  const metadata = Object.freeze(captured);
  const sanitized = sanitizeMetadata(metadata);
  if (sanitized.isErr()) return err(sanitized.error);
  return ok(metadata);
}

function captureActor(
  input: RecordCandidate,
): NeverthrowResult<ArtifactApprovalActor, LifecycleError> {
  const base = captureDataRecord(input);
  if (base.isErr()) return err(base.error);
  const kind = base.value.kind;
  if (kind === "user") {
    const exact = captureDataRecord(input, ["kind", "provenance"]);
    if (exact.isErr()) return err(exact.error);
    const provenance = captureProvenance(exact.value.provenance);
    if (provenance.isErr()) return err(provenance.error);
    return ok(Object.freeze({ kind: "user", provenance: provenance.value }));
  }
  if (kind === "agent") {
    const exact = captureDataRecord(input, ["kind", "agentName", "gate"]);
    if (exact.isErr()) return err(exact.error);
    const agentName = stringCandidate(exact.value.agentName);
    if (
      agentName === undefined ||
      agentName.trim().length === 0 ||
      encoder.encode(agentName).byteLength > 128
    ) {
      return err(
        lifecycleValidationError(
          "agent actor requires a bounded non-empty agentName",
          "actor.agentName",
        ),
      );
    }
    if (exact.value.gate !== "review" && exact.value.gate !== "security") {
      return err(
        lifecycleValidationError(
          'agent actor gate must be "review" or "security"',
          "actor.gate",
        ),
      );
    }
    return ok(
      Object.freeze({
        kind: "agent",
        agentName,
        gate: exact.value.gate,
      }),
    );
  }
  return err(
    lifecycleValidationError(
      'actor.kind must be "user" or "agent"',
      "actor.kind",
    ),
  );
}

function authorizeAgentActor(
  actor: Extract<ArtifactApprovalActor, { kind: "agent" }>,
  context: WorkflowExecutionContext | undefined,
): LifecycleError | undefined {
  if (context === undefined) {
    return lifecycleValidationError(
      "context is required for agent artifact approval actors",
      "context",
    );
  }
  const workflow = context.workflows[context.workflowName];
  if (workflow === undefined) {
    return lifecycleValidationError(
      `workflow "${context.workflowName}" is missing from approval context`,
      "context.workflowName",
    );
  }
  const gateSteps = workflow.steps.filter(
    (step) => step.type === "gate" && step.agent === actor.agentName,
  );
  if (gateSteps.length === 0) {
    return lifecyclePolicyDecisionError(
      `Agent "${actor.agentName}" is not an authorized gate actor on workflow "${context.workflowName}"`,
      "unauthorized_actor",
    );
  }
  return undefined;
}

/**
 * Approve or reject an artifact produced by a prior workflow step.
 *
 * Enforces:
 *
 * 1. **Lease enforcement** — fabricated/stale lease IDs fail closed.
 * 2. **Actor validation** — structured `ArtifactApprovalActor` is required.
 * 3. **Gate authorization** — agent actors must match a gate step on the
 *    workflow definition supplied via `context`.
 * 4. **Self-approval prohibition** — agent actors cannot approve artifacts
 *    they produced.
 * 5. **Revision binding** — `expectedRevision` must match the stored revision.
 * 6. **Digest binding** — when integrity metadata is present, `expectedDigest`
 *    is required and must match.
 */
export function approveArtifact(
  input: ApproveArtifactInput,
  store: RuntimeStore,
): ApproveArtifactResult {
  if (!input.workflowInstanceId) {
    return errAsync(
      lifecycleValidationError(
        "workflowInstanceId is required",
        "workflowInstanceId",
      ),
    );
  }
  if (!input.leaseId) {
    return errAsync(lifecycleValidationError("leaseId is required", "leaseId"));
  }
  if (!input.artifactId) {
    return errAsync(
      lifecycleValidationError("artifactId is required", "artifactId"),
    );
  }
  if (
    input.approvalState !== "approved" &&
    input.approvalState !== "rejected"
  ) {
    return errAsync(
      lifecycleValidationError(
        'approvalState must be "approved" or "rejected"',
        "approvalState",
      ),
    );
  }
  if (
    input.expectedRevision === undefined ||
    input.expectedRevision === null ||
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    return errAsync(
      lifecycleValidationError(
        "expectedRevision is required and must be a positive integer",
        "expectedRevision",
      ),
    );
  }

  const actorResult = captureActor(input.actor);
  if (actorResult.isErr()) return errAsync(actorResult.error);
  const actor = actorResult.value;

  if (actor.kind === "agent") {
    const gateError = authorizeAgentActor(actor, input.context);
    if (gateError !== undefined) return errAsync(gateError);
  }

  if (input.metadata !== undefined && input.metadata !== null) {
    const metaCheck = sanitizeMetadata(input.metadata);
    if (metaCheck.isErr()) return errAsync(metaCheck.error);
  }

  return store.leases
    .findActive()
    .mapErr((storeError): LifecycleError => mapStoreError(storeError))
    .andThen((activeLease) => {
      const leaseCheck = validateActiveLease(
        activeLease,
        input.workflowInstanceId,
        input.leaseId,
      );
      if (leaseCheck.isErr()) return errAsync(leaseCheck.error);
      return okAsync();
    })
    .andThen(() =>
      store.instances
        .findById(input.workflowInstanceId)
        .mapErr((storeError): LifecycleError => mapStoreError(storeError))
        .andThen((existing) => {
          if (existing === null) {
            return errAsync(
              lifecycleNotFoundError(
                "WorkflowInstance",
                input.workflowInstanceId,
              ),
            );
          }

          let artifact: ArtifactRef | undefined;
          for (let i = existing.artifacts.length - 1; i >= 0; i--) {
            if (existing.artifacts[i]?.id === input.artifactId) {
              artifact = existing.artifacts[i];
              break;
            }
          }

          if (artifact === undefined) {
            return errAsync(
              lifecycleNotFoundError(
                "ArtifactRef",
                input.artifactId,
                `Artifact '${input.artifactId}' not found in workflow instance`,
              ),
            );
          }

          if (artifact.revision !== input.expectedRevision) {
            return errAsync(
              lifecyclePolicyDecisionError(
                `Artifact "${artifact.name}" revision mismatch: expected ${input.expectedRevision}, actual ${artifact.revision}`,
                "stale_revision",
              ),
            );
          }

          if (artifact.integrity !== undefined) {
            if (
              input.expectedDigest === undefined ||
              input.expectedDigest.length === 0
            ) {
              return errAsync(
                lifecycleValidationError(
                  "expectedDigest is required when the artifact carries integrity metadata",
                  "expectedDigest",
                ),
              );
            }
            if (input.expectedDigest !== artifact.integrity.digest) {
              return errAsync(
                lifecyclePolicyDecisionError(
                  `Artifact "${artifact.name}" digest mismatch for revision ${artifact.revision}`,
                  "digest_mismatch",
                ),
              );
            }
          }

          if (
            actor.kind === "agent" &&
            artifact.producerAgent !== undefined &&
            actor.agentName === artifact.producerAgent
          ) {
            return errAsync(
              lifecyclePolicyDecisionError(
                `Agent "${actor.agentName}" cannot approve artifact "${artifact.name}" (revision ${artifact.revision}) because it produced that artifact. Self-approval is prohibited.`,
                "self_approval",
              ),
            );
          }

          const decidedAt = new Date().toISOString();
          const approval: ArtifactApprovalUpdate = {
            actor,
            decidedAt,
            expectedRevision: input.expectedRevision,
          };
          if (input.expectedDigest !== undefined) {
            approval.expectedDigest = input.expectedDigest;
          }
          return store.instances
            .updateArtifactApproval(
              input.workflowInstanceId,
              input.artifactId,
              input.approvalState,
              approval,
            )
            .mapErr((storeError): LifecycleError => {
              if (
                storeError.type === "conflict" &&
                storeError.entity === "ArtifactRevision"
              ) {
                return lifecyclePolicyDecisionError(
                  "Artifact revision changed before approval commit",
                  "stale_revision",
                );
              }
              if (
                storeError.type === "conflict" &&
                storeError.entity === "ArtifactDigest"
              ) {
                return lifecyclePolicyDecisionError(
                  "Artifact digest changed before approval commit",
                  "digest_mismatch",
                );
              }
              return mapStoreError(storeError);
            })
            .map((instance): ApproveArtifactOutput => ({ instance }));
        }),
    );
}
