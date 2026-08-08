/**
 * SQLite-backed Runtime Store implementation using Kysely over `bun:sqlite`.
 *
 * Implements the `RuntimeStore` interface from `../store.ts`.
 * All fallible operations return `ResultAsync<T, RuntimeStoreError>`.
 *
 * Lazy initialization: the `.weave/runtime/` directory and `weave.db` file
 * are created on the first repository operation, not at construction time.
 *
 * @internal
 */

import { dirname, relative, sep } from "node:path";
import { Kysely, sql } from "kysely";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";

import { logger } from "../../logger.js";
import {
  grantIdentitiesEqual,
  grantIdentityKey,
  hydrateDurableGrant,
  summarizeDurableGrant,
  validateDurableGrantRecordResult,
  validateGrantIdentityResult,
} from "../../permissions/repository.js";
import type {
  Clock,
  DurablePermissionGrantRecord,
  GrantIdentityEnvelope,
  PermissionApprovalRepository,
  PermissionError,
  PermissionGrantSummary,
} from "../../permissions/types.js";
import { registerPermissionApprovalRepository } from "../permission-repository.js";
import {
  BunRuntimeDirectoryGuard,
  directoryIdentitiesMatch,
  type RuntimeDirectoryGuard,
  type RuntimeDirectoryGuardError,
  type RuntimeDirectoryHandle,
  type RuntimeFileIdentity,
  runtimeLeafName,
} from "./runtime-directory-guard.js";

// ---------------------------------------------------------------------------
// Internal sentinel error classes for async error discrimination
// ---------------------------------------------------------------------------

class NotFoundSentinel extends Error {
  readonly kind = "not_found" as const;
  constructor(
    readonly entity: string,
    readonly entityId: string,
  ) {
    super(`not_found:${entity}:${entityId}`);
  }
}

class ConflictSentinel extends Error {
  readonly kind = "conflict" as const;
  constructor(
    readonly entity: string,
    readonly conflictMessage: string,
    readonly conflictingId?: string,
  ) {
    super(`conflict:${entity}`);
  }
}

class TxCallbackErrSentinel extends Error {
  readonly kind = "tx_callback_err" as const;
  constructor(readonly storeError: RuntimeStoreError) {
    super("tx_callback_err");
  }
}

class PermissionConflictSentinel extends Error {
  readonly kind = "permission_conflict" as const;
  constructor() {
    super("permission_conflict");
  }
}

class PermissionHydrationSentinel extends Error {
  readonly kind = "permission_hydration" as const;
  constructor() {
    super("permission_hydration");
  }
}

import {
  conflictError,
  initializationError,
  journalWriteError,
  notFoundError,
  queryError,
  type RuntimeStoreError,
  serializationError,
} from "../errors.js";
import { createProjectSalt } from "../fingerprint.js";
import { RuntimeJournalWriter } from "../journal-writer.js";
import { sanitizeSnapshotMetadata } from "../sanitizer.js";
import type {
  AcquireLeaseInput,
  CreateWorkflowInstanceInput,
  ExecutionLeaseRepository,
  RecordSessionSnapshotInput,
  RuntimeJournalRepository,
  RuntimeStore,
  RuntimeStoreTransaction,
  SessionSnapshotRepository,
  TransactionCallback,
  UpdateWorkflowInstanceInput,
  UsageRepository,
  WorkflowInstanceRepository,
} from "../store.js";
import type {
  ArtifactApprovalState,
  ArtifactId,
  ArtifactIntegrityMetadata,
  ArtifactRef,
  ConsumedArtifactRecord,
  ExecutionLease,
  ExecutionLeaseId,
  JournalQueryFilter,
  JsonObject,
  OwnerId,
  RetentionPruneStats,
  RuntimeJournalEntry,
  RuntimeJournalEntryId,
  SessionSnapshot,
  SessionSnapshotId,
  StepAttemptRecord,
  UsageObservation,
  UsageObservationId,
  UsageObservationQueryFilter,
  UsageObservationRecordResult,
  UsageRollup,
  UsageRollupQueryFilter,
  WorkflowInstance,
  WorkflowInstanceId,
  WorkflowInstanceStatus,
} from "../types.js";
import {
  createArtifactId,
  createExecutionLeaseId,
  createRuntimeJournalEntryId,
  createSessionSnapshotId,
  createWorkflowInstanceId,
} from "../types.js";
import {
  applyObservationToRollup,
  denormalizeUsageObservation,
  emptyUsageRollup,
  type NormalizedUsageObservation,
  normalizeUsageObservation,
  reconcileUsageReplay,
  usageRollupKey,
} from "../usage.js";
import {
  BunSqliteMemoryDialect,
  type MemoryStoreCoordinator,
} from "./kysely-bun-sqlite.js";
import { CURRENT_SCHEMA_VERSION, runMigrations } from "./migrations.js";
import type {
  ExecutionLeaseRow,
  RuntimeJournalEntryRow,
  SessionSnapshotRow,
  WeaveDatabase,
  WorkflowInstanceRow,
} from "./schema.js";

const log = logger.child({ module: "runtime-sqlite-store" });

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function newId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Row ↔ Domain mappers
// ---------------------------------------------------------------------------

function rowToWorkflowInstance(row: WorkflowInstanceRow): WorkflowInstance {
  const artifacts = JSON.parse(row.artifacts_json) as ArtifactRef[];
  // step_attempts_json may be absent in rows created before migration 2
  const stepAttempts: readonly StepAttemptRecord[] = row.step_attempts_json
    ? (JSON.parse(row.step_attempts_json) as StepAttemptRecord[])
    : [];
  return {
    id: createWorkflowInstanceId(row.id),
    workflowName: row.workflow_name,
    goal: row.goal,
    slug: row.slug,
    status: row.status as WorkflowInstanceStatus,
    ...(row.current_step_name !== null
      ? { currentStepName: row.current_step_name }
      : {}),
    artifacts,
    stepAttempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
  };
}

function rowToExecutionLease(row: ExecutionLeaseRow): ExecutionLease {
  return {
    id: createExecutionLeaseId(row.id),
    workflowInstanceId: createWorkflowInstanceId(row.workflow_instance_id),
    ownerId: row.owner_id as OwnerId,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    ...(row.last_heartbeat_at !== null
      ? { lastHeartbeatAt: row.last_heartbeat_at }
      : {}),
  };
}

function rowToSessionSnapshot(row: SessionSnapshotRow): SessionSnapshot {
  const metadata = JSON.parse(row.metadata_json) as Record<
    string,
    string | number | boolean
  >;
  return {
    id: createSessionSnapshotId(row.id),
    workflowInstanceId: createWorkflowInstanceId(row.workflow_instance_id),
    ...(row.lease_id !== null
      ? { leaseId: createExecutionLeaseId(row.lease_id) }
      : {}),
    harnessName: row.harness_name,
    ...(row.harness_version !== null
      ? { harnessVersion: row.harness_version }
      : {}),
    agentName: row.agent_name,
    ...(row.model_id !== null ? { modelId: row.model_id } : {}),
    ...(row.step_name !== null ? { stepName: row.step_name } : {}),
    sessionStatus: row.session_status as SessionSnapshot["sessionStatus"],
    recordedAt: row.recorded_at,
    metadata,
  };
}

function rowToJournalEntry(row: RuntimeJournalEntryRow): RuntimeJournalEntry {
  const data = JSON.parse(row.data_json) as JsonObject;
  return {
    id: createRuntimeJournalEntryId(row.id),
    timestamp: row.timestamp,
    source: {
      kind: row.source_kind as "engine" | "adapter",
      name: row.source_name,
    },
    eventType: row.event_type,
    ...(row.execution_id !== null
      ? { executionId: createExecutionLeaseId(row.execution_id) }
      : {}),
    ...(row.workflow_instance_id !== null
      ? {
          workflowInstanceId: createWorkflowInstanceId(
            row.workflow_instance_id,
          ),
        }
      : {}),
    ...(row.step_id !== null ? { stepId: row.step_id } : {}),
    severity: row.severity as RuntimeJournalEntry["severity"],
    data,
  };
}

// ---------------------------------------------------------------------------
// SqliteWorkflowInstanceRepository
// ---------------------------------------------------------------------------

class SqliteWorkflowInstanceRepository implements WorkflowInstanceRepository {
  constructor(private readonly db: Kysely<WeaveDatabase>) {}

  create(
    input: CreateWorkflowInstanceInput,
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    const now = new Date().toISOString();
    const id = input.id ? (input.id as string) : newId();
    return ResultAsync.fromPromise(
      this.db
        .insertInto("workflow_instances")
        .values({
          id,
          workflow_name: input.workflowName,
          goal: input.goal,
          slug: input.slug,
          status: "created",
          current_step_name: null,
          artifacts_json: "[]",
          step_attempts_json: "[]",
          created_at: now,
          updated_at: now,
          completed_at: null,
          error_message: null,
        })
        .execute()
        .then(() =>
          this.db
            .selectFrom("workflow_instances")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirstOrThrow(),
        )
        .then(rowToWorkflowInstance),
      (cause) => queryError("Failed to create WorkflowInstance", cause),
    );
  }

  findById(
    id: WorkflowInstanceId,
  ): ResultAsync<WorkflowInstance | null, RuntimeStoreError> {
    return ResultAsync.fromPromise(
      this.db
        .selectFrom("workflow_instances")
        .selectAll()
        .where("id", "=", id as string)
        .executeTakeFirst()
        .then((row) => (row ? rowToWorkflowInstance(row) : null)),
      (cause) => queryError("Failed to find WorkflowInstance", cause),
    );
  }

  getById(
    id: WorkflowInstanceId,
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    return this.findById(id).andThen((instance) => {
      if (!instance) {
        return errAsync(notFoundError("WorkflowInstance", id as string));
      }
      return okAsync(instance);
    });
  }

  list(filter?: {
    status?: WorkflowInstanceStatus;
  }): ResultAsync<readonly WorkflowInstance[], RuntimeStoreError> {
    return ResultAsync.fromPromise(
      (() => {
        let query = this.db
          .selectFrom("workflow_instances")
          .selectAll()
          .orderBy("created_at", "asc");
        if (filter?.status) {
          query = query.where("status", "=", filter.status);
        }
        return query.execute().then((rows) => rows.map(rowToWorkflowInstance));
      })(),
      (cause) => queryError("Failed to list WorkflowInstances", cause),
    );
  }

  update(
    id: WorkflowInstanceId,
    input: UpdateWorkflowInstanceInput,
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    const now = new Date().toISOString();
    const isTerminal =
      input.status === "completed" ||
      input.status === "failed" ||
      input.status === "cancelled";

    return ResultAsync.fromPromise(
      this.db
        .selectFrom("workflow_instances")
        .selectAll()
        .where("id", "=", id as string)
        .executeTakeFirst()
        .then((existing) => {
          if (!existing) {
            throw new NotFoundSentinel("WorkflowInstance", id as string);
          }
          return existing;
        })
        .then((existing) => {
          type MutablePatch = {
            updated_at: string;
            status?: string;
            current_step_name?: string | null;
            error_message?: string | null;
            completed_at?: string | null;
          };
          const patch: MutablePatch = { updated_at: now };
          if (input.status !== undefined) {
            patch.status = input.status;
          }
          if (input.currentStepName !== undefined) {
            patch.current_step_name = input.currentStepName ?? null;
          }
          if (input.errorMessage !== undefined) {
            patch.error_message = input.errorMessage ?? null;
          }
          if (isTerminal && !existing.completed_at) {
            patch.completed_at = now;
          }
          return this.db
            .updateTable("workflow_instances")
            .set(patch)
            .where("id", "=", id as string)
            .execute();
        })
        .then(() =>
          this.db
            .selectFrom("workflow_instances")
            .selectAll()
            .where("id", "=", id as string)
            .executeTakeFirstOrThrow(),
        )
        .then(rowToWorkflowInstance),
      (cause) => {
        if (cause instanceof NotFoundSentinel) {
          return notFoundError(cause.entity, cause.entityId);
        }
        return queryError("Failed to update WorkflowInstance", cause);
      },
    );
  }

  addArtifact(
    id: WorkflowInstanceId,
    artifact: {
      name: string;
      path: string;
      mimeType?: string;
      description?: string;
      integrity?: ArtifactIntegrityMetadata;
      producerAgent?: string;
    },
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    return ResultAsync.fromPromise(
      this.db
        .selectFrom("workflow_instances")
        .selectAll()
        .where("id", "=", id as string)
        .executeTakeFirst()
        .then((existing) => {
          if (!existing) {
            throw new NotFoundSentinel("WorkflowInstance", id as string);
          }
          const artifacts = JSON.parse(
            existing.artifacts_json,
          ) as ArtifactRef[];

          // Find existing artifact with same name to determine revision (last occurrence)
          const prior =
            [...artifacts].reverse().find((a) => a.name === artifact.name) ??
            null;
          const revision = prior ? prior.revision + 1 : 1;
          // Reuse stable id across revisions; assign new id for first occurrence
          const artifactId = prior ? prior.id : createArtifactId(newId());

          const ref: ArtifactRef = {
            id: artifactId,
            name: artifact.name,
            path: artifact.path,
            revision,
            // New revision always resets approvalState to pending, invalidating prior approval.
            approvalState: "pending",
            ...(artifact.producerAgent
              ? { producerAgent: artifact.producerAgent }
              : {}),
            ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
            ...(artifact.description
              ? { description: artifact.description }
              : {}),
            ...(artifact.integrity ? { integrity: artifact.integrity } : {}),
          };
          artifacts.push(ref);
          return this.db
            .updateTable("workflow_instances")
            .set({
              artifacts_json: JSON.stringify(artifacts),
              updated_at: new Date().toISOString(),
            })
            .where("id", "=", id as string)
            .execute();
        })
        .then(() =>
          this.db
            .selectFrom("workflow_instances")
            .selectAll()
            .where("id", "=", id as string)
            .executeTakeFirstOrThrow(),
        )
        .then(rowToWorkflowInstance),
      (cause) => {
        if (cause instanceof NotFoundSentinel) {
          return notFoundError(cause.entity, cause.entityId);
        }
        return queryError("Failed to add artifact to WorkflowInstance", cause);
      },
    );
  }

  updateArtifactApproval(
    id: WorkflowInstanceId,
    artifactId: ArtifactId,
    approvalState: ArtifactApprovalState,
    approval?: {
      readonly actor: import("../types.js").ArtifactApprovalActor;
      readonly decidedAt: string;
      readonly expectedRevision: number;
      readonly expectedDigest?: string;
    },
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    return ResultAsync.fromPromise(
      this.db.transaction().execute(async (transaction) => {
        const existing = await transaction
          .selectFrom("workflow_instances")
          .selectAll()
          .where("id", "=", id as string)
          .executeTakeFirst();
        if (!existing) {
          throw new NotFoundSentinel("WorkflowInstance", id as string);
        }
        const artifacts = JSON.parse(existing.artifacts_json) as ArtifactRef[];
        let artifactIndex = -1;
        for (let i = artifacts.length - 1; i >= 0; i--) {
          if (artifacts[i].id === artifactId) {
            artifactIndex = i;
            break;
          }
        }
        if (artifactIndex === -1) {
          throw new NotFoundSentinel("ArtifactRef", artifactId as string);
        }
        const currentArtifact = artifacts[artifactIndex];
        if (
          approval !== undefined &&
          currentArtifact.revision !== approval.expectedRevision
        ) {
          throw new ConflictSentinel(
            "ArtifactRevision",
            "Artifact revision changed before approval commit",
            artifactId as string,
          );
        }
        if (
          approval !== undefined &&
          currentArtifact.integrity !== undefined &&
          currentArtifact.integrity.digest !== approval.expectedDigest
        ) {
          throw new ConflictSentinel(
            "ArtifactDigest",
            "Artifact digest changed before approval commit",
            artifactId as string,
          );
        }
        const updatedArtifacts = artifacts.map((artifact, index) => {
          if (index !== artifactIndex) return artifact;
          if (approval === undefined) return { ...artifact, approvalState };
          return {
            ...artifact,
            approvalState,
            approvalActor: approval.actor,
            approvalDecidedAt: approval.decidedAt,
          };
        });
        await transaction
          .updateTable("workflow_instances")
          .set({
            artifacts_json: JSON.stringify(updatedArtifacts),
            updated_at: new Date().toISOString(),
          })
          .where("id", "=", id as string)
          .execute();
        const updated = await transaction
          .selectFrom("workflow_instances")
          .selectAll()
          .where("id", "=", id as string)
          .executeTakeFirstOrThrow();
        return rowToWorkflowInstance(updated);
      }),
      (cause) => {
        if (cause instanceof NotFoundSentinel) {
          return notFoundError(cause.entity, cause.entityId);
        }
        if (cause instanceof ConflictSentinel) {
          return conflictError(
            cause.entity,
            cause.conflictMessage,
            cause.conflictingId,
          );
        }
        return queryError(
          "Failed to update artifact approval on WorkflowInstance",
          cause,
        );
      },
    );
  }

  recordStepAttempt(
    id: WorkflowInstanceId,
    stepName: string,
    consumedArtifacts: readonly ConsumedArtifactRecord[],
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    return ResultAsync.fromPromise(
      this.db
        .selectFrom("workflow_instances")
        .selectAll()
        .where("id", "=", id as string)
        .executeTakeFirst()
        .then((existing) => {
          if (!existing) {
            throw new NotFoundSentinel("WorkflowInstance", id as string);
          }
          const stepAttempts: StepAttemptRecord[] = existing.step_attempts_json
            ? (JSON.parse(existing.step_attempts_json) as StepAttemptRecord[])
            : [];
          const priorAttempts = stepAttempts.filter(
            (a) => a.stepName === stepName,
          ).length;
          const record: StepAttemptRecord = {
            stepName,
            attemptNumber: priorAttempts + 1,
            dispatchedAt: new Date().toISOString(),
            consumedArtifacts,
          };
          stepAttempts.push(record);
          return this.db
            .updateTable("workflow_instances")
            .set({
              step_attempts_json: JSON.stringify(stepAttempts),
              updated_at: new Date().toISOString(),
            })
            .where("id", "=", id as string)
            .execute();
        })
        .then(() =>
          this.db
            .selectFrom("workflow_instances")
            .selectAll()
            .where("id", "=", id as string)
            .executeTakeFirstOrThrow(),
        )
        .then(rowToWorkflowInstance),
      (cause) => {
        if (cause instanceof NotFoundSentinel) {
          return notFoundError(cause.entity, cause.entityId);
        }
        return queryError(
          "Failed to record step attempt on WorkflowInstance",
          cause,
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// SqliteExecutionLeaseRepository
// ---------------------------------------------------------------------------

class SqliteExecutionLeaseRepository implements ExecutionLeaseRepository {
  constructor(
    private readonly db: Kysely<WeaveDatabase>,
    private readonly clock: () => Date,
  ) {}

  acquire(
    input: AcquireLeaseInput,
  ): ResultAsync<ExecutionLease, RuntimeStoreError> {
    const now = this.clock();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
    const id = newId();

    return ResultAsync.fromPromise(
      (async () => {
        // Atomic check-and-insert: find any unexpired lease
        const existing = await this.db
          .selectFrom("execution_leases")
          .selectAll()
          .where("expires_at", ">", nowIso)
          .executeTakeFirst();

        if (existing) {
          throw new ConflictSentinel(
            "ExecutionLease",
            "An unexpired lease already exists",
            existing.id,
          );
        }

        await this.db
          .insertInto("execution_leases")
          .values({
            id,
            workflow_instance_id: input.workflowInstanceId as string,
            owner_id: input.ownerId as string,
            acquired_at: nowIso,
            expires_at: expiresAt,
            last_heartbeat_at: null,
          })
          .execute();

        const row = await this.db
          .selectFrom("execution_leases")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirstOrThrow();

        return rowToExecutionLease(row);
      })(),
      (cause) => {
        if (cause instanceof ConflictSentinel) {
          return conflictError(
            cause.entity,
            cause.conflictMessage,
            cause.conflictingId,
          );
        }
        return queryError("Failed to acquire ExecutionLease", cause);
      },
    );
  }

  findActive(): ResultAsync<ExecutionLease | null, RuntimeStoreError> {
    const nowIso = this.clock().toISOString();
    return ResultAsync.fromPromise(
      this.db
        .selectFrom("execution_leases")
        .selectAll()
        .where("expires_at", ">", nowIso)
        .orderBy("acquired_at", "desc")
        .executeTakeFirst()
        .then((row) => (row ? rowToExecutionLease(row) : null)),
      (cause) => queryError("Failed to find active ExecutionLease", cause),
    );
  }

  getActive(): ResultAsync<ExecutionLease, RuntimeStoreError> {
    return this.findActive().andThen((lease) => {
      if (!lease) {
        return errAsync(
          notFoundError("ExecutionLease", "active", "No active lease found"),
        );
      }
      return okAsync(lease);
    });
  }

  findById(
    id: ExecutionLeaseId,
  ): ResultAsync<ExecutionLease | null, RuntimeStoreError> {
    return ResultAsync.fromPromise(
      this.db
        .selectFrom("execution_leases")
        .selectAll()
        .where("id", "=", id as string)
        .executeTakeFirst()
        .then((row) => (row ? rowToExecutionLease(row) : null)),
      (cause) => queryError("Failed to find ExecutionLease", cause),
    );
  }

  getById(
    id: ExecutionLeaseId,
  ): ResultAsync<ExecutionLease, RuntimeStoreError> {
    return this.findById(id).andThen((lease) => {
      if (!lease) {
        return errAsync(notFoundError("ExecutionLease", id as string));
      }
      return okAsync(lease);
    });
  }

  heartbeat(
    id: ExecutionLeaseId,
    ownerId: OwnerId,
    ttlMs: number,
  ): ResultAsync<ExecutionLease, RuntimeStoreError> {
    const now = this.clock();
    const nowIso = now.toISOString();
    const newExpiresAt = new Date(now.getTime() + ttlMs).toISOString();

    return ResultAsync.fromPromise(
      (async () => {
        const row = await this.db
          .selectFrom("execution_leases")
          .selectAll()
          .where("id", "=", id as string)
          .executeTakeFirst();

        if (!row) {
          throw new NotFoundSentinel("ExecutionLease", id as string);
        }
        if (row.expires_at <= nowIso) {
          throw new ConflictSentinel(
            "ExecutionLease",
            "Lease has expired",
            id as string,
          );
        }
        if (row.owner_id !== (ownerId as string)) {
          throw new ConflictSentinel(
            "ExecutionLease",
            "Lease is owned by a different owner",
            id as string,
          );
        }

        await this.db
          .updateTable("execution_leases")
          .set({
            last_heartbeat_at: nowIso,
            expires_at: newExpiresAt,
          })
          .where("id", "=", id as string)
          .execute();

        const updated = await this.db
          .selectFrom("execution_leases")
          .selectAll()
          .where("id", "=", id as string)
          .executeTakeFirstOrThrow();

        return rowToExecutionLease(updated);
      })(),
      (cause) => {
        if (cause instanceof NotFoundSentinel) {
          return notFoundError(cause.entity, cause.entityId);
        }
        if (cause instanceof ConflictSentinel) {
          return conflictError(
            cause.entity,
            cause.conflictMessage,
            cause.conflictingId,
          );
        }
        return queryError("Failed to heartbeat ExecutionLease", cause);
      },
    );
  }

  release(
    id: ExecutionLeaseId,
    ownerId: OwnerId,
  ): ResultAsync<void, RuntimeStoreError> {
    return ResultAsync.fromPromise(
      (async () => {
        const row = await this.db
          .selectFrom("execution_leases")
          .selectAll()
          .where("id", "=", id as string)
          .executeTakeFirst();

        if (!row) {
          throw new NotFoundSentinel("ExecutionLease", id as string);
        }
        if (row.owner_id !== (ownerId as string)) {
          throw new ConflictSentinel(
            "ExecutionLease",
            "Lease is owned by a different owner",
            id as string,
          );
        }

        await this.db
          .deleteFrom("execution_leases")
          .where("id", "=", id as string)
          .execute();
      })(),
      (cause) => {
        if (cause instanceof NotFoundSentinel) {
          return notFoundError(cause.entity, cause.entityId);
        }
        if (cause instanceof ConflictSentinel) {
          return conflictError(
            cause.entity,
            cause.conflictMessage,
            cause.conflictingId,
          );
        }
        return queryError("Failed to release ExecutionLease", cause);
      },
    );
  }
}

// ---------------------------------------------------------------------------
// SqliteSessionSnapshotRepository
// ---------------------------------------------------------------------------

class SqliteSessionSnapshotRepository implements SessionSnapshotRepository {
  constructor(private readonly db: Kysely<WeaveDatabase>) {}

  record(
    input: RecordSessionSnapshotInput,
  ): ResultAsync<SessionSnapshot, RuntimeStoreError> {
    const id = newId();
    const now = new Date().toISOString();

    const sanitizeResult = sanitizeSnapshotMetadata(input.metadata);
    if (sanitizeResult.isErr()) {
      return errAsync(sanitizeResult.error);
    }
    const sanitizedMetadata = sanitizeResult.value;

    let metadataJson: string;
    try {
      metadataJson = JSON.stringify(sanitizedMetadata);
    } catch (cause) {
      return errAsync(
        serializationError("Failed to serialize metadata", cause),
      );
    }

    return ResultAsync.fromPromise(
      this.db
        .insertInto("session_snapshots")
        .values({
          id,
          workflow_instance_id: input.workflowInstanceId as string,
          lease_id: input.leaseId as string,
          harness_name: input.harnessName,
          harness_version: input.harnessVersion ?? null,
          agent_name: input.agentName,
          model_id: input.modelId ?? null,
          step_name: input.stepName ?? null,
          session_status: input.sessionStatus,
          recorded_at: now,
          metadata_json: metadataJson,
        })
        .execute()
        .then(() =>
          this.db
            .selectFrom("session_snapshots")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirstOrThrow(),
        )
        .then(rowToSessionSnapshot),
      (cause) => queryError("Failed to record SessionSnapshot", cause),
    );
  }

  findById(
    id: SessionSnapshotId,
  ): ResultAsync<SessionSnapshot | null, RuntimeStoreError> {
    return ResultAsync.fromPromise(
      this.db
        .selectFrom("session_snapshots")
        .selectAll()
        .where("id", "=", id as string)
        .executeTakeFirst()
        .then((row) => (row ? rowToSessionSnapshot(row) : null)),
      (cause) => queryError("Failed to find SessionSnapshot", cause),
    );
  }

  getById(
    id: SessionSnapshotId,
  ): ResultAsync<SessionSnapshot, RuntimeStoreError> {
    return this.findById(id).andThen((snap) => {
      if (!snap) {
        return errAsync(notFoundError("SessionSnapshot", id as string));
      }
      return okAsync(snap);
    });
  }

  listByWorkflowInstance(
    workflowInstanceId: WorkflowInstanceId,
  ): ResultAsync<readonly SessionSnapshot[], RuntimeStoreError> {
    return ResultAsync.fromPromise(
      this.db
        .selectFrom("session_snapshots")
        .selectAll()
        .where("workflow_instance_id", "=", workflowInstanceId as string)
        .orderBy("recorded_at", "asc")
        .execute()
        .then((rows) => rows.map(rowToSessionSnapshot)),
      (cause) =>
        queryError(
          "Failed to list SessionSnapshots by workflow instance",
          cause,
        ),
    );
  }

  findLatestByWorkflowInstance(
    workflowInstanceId: WorkflowInstanceId,
  ): ResultAsync<SessionSnapshot | null, RuntimeStoreError> {
    return ResultAsync.fromPromise(
      this.db
        .selectFrom("session_snapshots")
        .selectAll()
        .where("workflow_instance_id", "=", workflowInstanceId as string)
        .orderBy("recorded_at", "desc")
        .executeTakeFirst()
        .then((row) => (row ? rowToSessionSnapshot(row) : null)),
      (cause) =>
        queryError(
          "Failed to find latest SessionSnapshot for workflow instance",
          cause,
        ),
    );
  }
}

// ---------------------------------------------------------------------------
// SqliteRuntimeJournalRepository
// ---------------------------------------------------------------------------

class SqliteRuntimeJournalRepository implements RuntimeJournalRepository {
  constructor(private readonly db: Kysely<WeaveDatabase>) {}

  append(
    entry: Omit<RuntimeJournalEntry, "id" | "timestamp">,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError> {
    const id = newId();
    const timestamp = new Date().toISOString();

    let dataJson: string;
    try {
      dataJson = JSON.stringify(entry.data);
    } catch (cause) {
      return errAsync(
        journalWriteError("Failed to serialize journal entry data", cause),
      );
    }

    return ResultAsync.fromPromise(
      this.db
        .insertInto("runtime_journal_entries")
        .values({
          id,
          timestamp,
          source_kind: entry.source.kind,
          source_name: entry.source.name,
          event_type: entry.eventType,
          execution_id: entry.executionId ?? null,
          workflow_instance_id: entry.workflowInstanceId ?? null,
          step_id: entry.stepId ?? null,
          severity: entry.severity,
          data_json: dataJson,
        })
        .execute()
        .then(() =>
          this.db
            .selectFrom("runtime_journal_entries")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirstOrThrow(),
        )
        .then(rowToJournalEntry),
      (cause) =>
        journalWriteError("Failed to append RuntimeJournalEntry", cause),
    );
  }

  findById(
    id: RuntimeJournalEntryId,
  ): ResultAsync<RuntimeJournalEntry | null, RuntimeStoreError> {
    return ResultAsync.fromPromise(
      this.db
        .selectFrom("runtime_journal_entries")
        .selectAll()
        .where("id", "=", id as string)
        .executeTakeFirst()
        .then((row) => (row ? rowToJournalEntry(row) : null)),
      (cause) => queryError("Failed to find RuntimeJournalEntry", cause),
    );
  }

  getById(
    id: RuntimeJournalEntryId,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError> {
    return this.findById(id).andThen((entry) => {
      if (!entry) {
        return errAsync(notFoundError("RuntimeJournalEntry", id as string));
      }
      return okAsync(entry);
    });
  }

  query(
    filter?: JournalQueryFilter,
  ): ResultAsync<readonly RuntimeJournalEntry[], RuntimeStoreError> {
    return ResultAsync.fromPromise(
      (async () => {
        let query = this.db
          .selectFrom("runtime_journal_entries")
          .selectAll()
          .orderBy("timestamp", "asc");

        if (filter?.workflowInstanceId) {
          query = query.where(
            "workflow_instance_id",
            "=",
            filter.workflowInstanceId as string,
          );
        }
        if (filter?.executionId) {
          query = query.where(
            "execution_id",
            "=",
            filter.executionId as string,
          );
        }
        if (filter?.sourceKind) {
          query = query.where("source_kind", "=", filter.sourceKind);
        }
        if (filter?.sourceName) {
          query = query.where("source_name", "=", filter.sourceName);
        }
        if (filter?.eventType) {
          query = query.where("event_type", "=", filter.eventType);
        }
        if (filter?.severity) {
          query = query.where("severity", "=", filter.severity);
        }
        if (filter?.after) {
          query = query.where("timestamp", ">", filter.after);
        }
        if (filter?.before) {
          query = query.where("timestamp", "<", filter.before);
        }
        if (filter?.limit) {
          query = query.limit(filter.limit);
        }

        const rows = await query.execute();
        return rows.map(rowToJournalEntry);
      })(),
      (cause) => queryError("Failed to query RuntimeJournalEntries", cause),
    );
  }

  prune(options: {
    readonly olderThan?: string;
    readonly maxCount?: number;
  }): ResultAsync<RetentionPruneStats, RuntimeStoreError> {
    return ResultAsync.fromPromise(
      (async () => {
        let removedByAge = 0;
        let removedByCount = 0;

        if (options.olderThan !== undefined) {
          const ageResult = await this.db
            .deleteFrom("runtime_journal_entries")
            .where("timestamp", "<", options.olderThan)
            .executeTakeFirst();
          removedByAge = Number(ageResult.numDeletedRows ?? 0n);
        }

        if (options.maxCount !== undefined) {
          const countRow = await this.db
            .selectFrom("runtime_journal_entries")
            .select(this.db.fn.countAll<number>().as("count"))
            .executeTakeFirstOrThrow();
          const total = Number(countRow.count);
          if (total > options.maxCount) {
            const overflow = total - options.maxCount;
            const oldest = await this.db
              .selectFrom("runtime_journal_entries")
              .select("id")
              .orderBy("timestamp", "asc")
              .limit(overflow)
              .execute();
            if (oldest.length > 0) {
              const ids = oldest.map((row) => row.id);
              const countResult = await this.db
                .deleteFrom("runtime_journal_entries")
                .where("id", "in", ids)
                .executeTakeFirst();
              removedByCount = Number(countResult.numDeletedRows ?? 0n);
            }
          }
        }

        return { removedByAge, removedByCount };
      })(),
      (cause) => queryError("Failed to prune RuntimeJournalEntries", cause),
    );
  }
}

// ---------------------------------------------------------------------------
// SqliteUsageRepository
// ---------------------------------------------------------------------------

function rowToNormalizedUsage(
  row: import("./schema.js").UsageObservationRow,
): Result<NormalizedUsageObservation, RuntimeStoreError> {
  return Result.fromThrowable(
    () => JSON.parse(row.normalized_json) as NormalizedUsageObservation,
    (cause) =>
      serializationError(
        "Failed to parse usage observation normalized_json",
        cause,
      ),
  )().andThen((parsed) => {
    if (typeof parsed !== "object" || parsed === null) {
      return err(
        serializationError(
          "usage observation normalized_json is not an object",
        ),
      );
    }
    return ok(parsed);
  });
}

function rowToUsageRollup(
  row: import("./schema.js").UsageRollupRow,
): UsageRollup {
  return {
    source: {
      kind: row.source_kind as "engine" | "adapter",
      name: row.source_name,
    },
    observationCount: row.observation_count,
    ...(row.workflow_instance_id
      ? {
          workflowInstanceId:
            row.workflow_instance_id as UsageRollup["workflowInstanceId"],
        }
      : {}),
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.agent_name ? { agentName: row.agent_name } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
    ...(row.cache_read_tokens !== null
      ? { cacheReadTokens: row.cache_read_tokens }
      : {}),
    ...(row.cache_write_tokens !== null
      ? { cacheWriteTokens: row.cache_write_tokens }
      : {}),
    ...(row.total_tokens !== null ? { totalTokens: row.total_tokens } : {}),
    ...(row.cost !== null ? { cost: row.cost } : {}),
  };
}

class SqliteUsageRepository implements UsageRepository {
  constructor(private readonly db: Kysely<WeaveDatabase>) {}

  recordObservation(
    observation: UsageObservation,
  ): ResultAsync<UsageObservationRecordResult, RuntimeStoreError> {
    const normalizedResult = normalizeUsageObservation(observation);
    if (normalizedResult.isErr()) return errAsync(normalizedResult.error);
    const normalized = normalizedResult.value;

    let normalizedJson: string;
    try {
      normalizedJson = JSON.stringify(normalized);
    } catch (cause) {
      return errAsync(
        serializationError("Failed to serialize usage observation", cause),
      );
    }

    return ResultAsync.fromPromise(
      this.db.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom("usage_observations")
          .selectAll()
          .where("id", "=", normalized.id)
          .executeTakeFirst();

        if (existing) {
          const existingNormalized = rowToNormalizedUsage(existing);
          if (existingNormalized.isErr()) throw existingNormalized.error;
          const replay = reconcileUsageReplay(
            existingNormalized.value,
            normalized,
          );
          if (replay.isErr()) throw replay.error;
          return {
            kind: "noop" as const,
            observation: denormalizeUsageObservation(existingNormalized.value),
          };
        }

        await trx
          .insertInto("usage_observations")
          .values({
            id: normalized.id,
            timestamp: normalized.timestamp,
            source_kind: normalized.sourceKind,
            source_name: normalized.sourceName,
            workflow_instance_id: normalized.workflowInstanceId ?? null,
            step_id: normalized.stepId ?? null,
            agent_name: normalized.agentName ?? null,
            model: normalized.model ?? null,
            input_tokens: normalized.inputTokens ?? null,
            output_tokens: normalized.outputTokens ?? null,
            cache_read_tokens: normalized.cacheReadTokens ?? null,
            cache_write_tokens: normalized.cacheWriteTokens ?? null,
            total_tokens: normalized.totalTokens ?? null,
            cost: normalized.cost ?? null,
            normalized_json: normalizedJson,
          })
          .execute();

        const key = usageRollupKey(normalized);
        const existingRollup = await trx
          .selectFrom("usage_rollups")
          .selectAll()
          .where("rollup_key", "=", key)
          .executeTakeFirst();

        const prior = existingRollup
          ? rowToUsageRollup(existingRollup)
          : emptyUsageRollup(normalized);
        const next = applyObservationToRollup(prior, normalized);

        if (existingRollup) {
          await trx
            .updateTable("usage_rollups")
            .set({
              input_tokens: next.inputTokens ?? null,
              output_tokens: next.outputTokens ?? null,
              cache_read_tokens: next.cacheReadTokens ?? null,
              cache_write_tokens: next.cacheWriteTokens ?? null,
              total_tokens: next.totalTokens ?? null,
              cost: next.cost ?? null,
              observation_count: next.observationCount,
            })
            .where("rollup_key", "=", key)
            .execute();
        } else {
          await trx
            .insertInto("usage_rollups")
            .values({
              rollup_key: key,
              source_kind: normalized.sourceKind,
              source_name: normalized.sourceName,
              workflow_instance_id: normalized.workflowInstanceId ?? null,
              step_id: normalized.stepId ?? null,
              agent_name: normalized.agentName ?? null,
              model: normalized.model ?? null,
              input_tokens: next.inputTokens ?? null,
              output_tokens: next.outputTokens ?? null,
              cache_read_tokens: next.cacheReadTokens ?? null,
              cache_write_tokens: next.cacheWriteTokens ?? null,
              total_tokens: next.totalTokens ?? null,
              cost: next.cost ?? null,
              observation_count: next.observationCount,
            })
            .execute();
        }

        return {
          kind: "inserted" as const,
          observation: denormalizeUsageObservation(normalized),
        };
      }),
      (cause) => {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "type" in cause &&
          (cause as RuntimeStoreError).type !== undefined
        ) {
          return cause as RuntimeStoreError;
        }
        return queryError("Failed to record usage observation", cause);
      },
    );
  }

  findObservationById(
    id: UsageObservationId,
  ): ResultAsync<UsageObservation | null, RuntimeStoreError> {
    return ResultAsync.fromPromise(
      this.db
        .selectFrom("usage_observations")
        .selectAll()
        .where("id", "=", id as string)
        .executeTakeFirst(),
      (cause) => queryError("Failed to find usage observation", cause),
    ).andThen((row) => {
      if (!row) return okAsync(null);
      const normalized = rowToNormalizedUsage(row);
      if (normalized.isErr()) return errAsync(normalized.error);
      return okAsync(denormalizeUsageObservation(normalized.value));
    });
  }

  listObservations(
    filter?: UsageObservationQueryFilter,
  ): ResultAsync<readonly UsageObservation[], RuntimeStoreError> {
    return ResultAsync.fromPromise(
      (async () => {
        let query = this.db
          .selectFrom("usage_observations")
          .selectAll()
          .orderBy("timestamp", "asc");

        if (filter?.workflowInstanceId) {
          query = query.where(
            "workflow_instance_id",
            "=",
            filter.workflowInstanceId as string,
          );
        }
        if (filter?.sourceKind) {
          query = query.where("source_kind", "=", filter.sourceKind);
        }
        if (filter?.sourceName) {
          query = query.where("source_name", "=", filter.sourceName);
        }
        if (filter?.agentName) {
          query = query.where("agent_name", "=", filter.agentName);
        }
        if (filter?.model) {
          query = query.where("model", "=", filter.model);
        }
        if (filter?.after) {
          query = query.where("timestamp", ">", filter.after);
        }
        if (filter?.before) {
          query = query.where("timestamp", "<", filter.before);
        }
        if (filter?.limit) {
          query = query.limit(filter.limit);
        }

        const rows = await query.execute();
        const observations: UsageObservation[] = [];
        for (const row of rows) {
          const normalized = rowToNormalizedUsage(row);
          if (normalized.isErr()) throw normalized.error;
          observations.push(denormalizeUsageObservation(normalized.value));
        }
        return observations;
      })(),
      (cause) => {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "type" in cause &&
          (cause as RuntimeStoreError).type !== undefined
        ) {
          return cause as RuntimeStoreError;
        }
        return queryError("Failed to list usage observations", cause);
      },
    );
  }

  listRollups(
    filter?: UsageRollupQueryFilter,
  ): ResultAsync<readonly UsageRollup[], RuntimeStoreError> {
    return ResultAsync.fromPromise(
      (async () => {
        let query = this.db.selectFrom("usage_rollups").selectAll();

        if (filter?.workflowInstanceId) {
          query = query.where(
            "workflow_instance_id",
            "=",
            filter.workflowInstanceId as string,
          );
        }
        if (filter?.sourceKind) {
          query = query.where("source_kind", "=", filter.sourceKind);
        }
        if (filter?.sourceName) {
          query = query.where("source_name", "=", filter.sourceName);
        }
        if (filter?.agentName) {
          query = query.where("agent_name", "=", filter.agentName);
        }
        if (filter?.model) {
          query = query.where("model", "=", filter.model);
        }

        const rows = await query.execute();
        return rows.map(rowToUsageRollup);
      })(),
      (cause) => queryError("Failed to list usage rollups", cause),
    );
  }

  pruneDetails(options: {
    readonly olderThan?: string;
    readonly maxCount?: number;
  }): ResultAsync<RetentionPruneStats, RuntimeStoreError> {
    return ResultAsync.fromPromise(
      (async () => {
        let removedByAge = 0;
        let removedByCount = 0;

        if (options.olderThan !== undefined) {
          const ageResult = await this.db
            .deleteFrom("usage_observations")
            .where("timestamp", "<", options.olderThan)
            .executeTakeFirst();
          removedByAge = Number(ageResult.numDeletedRows ?? 0n);
        }

        if (options.maxCount !== undefined) {
          const countRow = await this.db
            .selectFrom("usage_observations")
            .select(this.db.fn.countAll<number>().as("count"))
            .executeTakeFirstOrThrow();
          const total = Number(countRow.count);
          if (total > options.maxCount) {
            const overflow = total - options.maxCount;
            const oldest = await this.db
              .selectFrom("usage_observations")
              .select("id")
              .orderBy("timestamp", "asc")
              .limit(overflow)
              .execute();
            if (oldest.length > 0) {
              const ids = oldest.map((row) => row.id);
              const countResult = await this.db
                .deleteFrom("usage_observations")
                .where("id", "in", ids)
                .executeTakeFirst();
              removedByCount = Number(countResult.numDeletedRows ?? 0n);
            }
          }
        }

        return { removedByAge, removedByCount };
      })(),
      (cause) => queryError("Failed to prune usage observations", cause),
    );
  }
}

// ---------------------------------------------------------------------------
// JournalWriterRepository
// ---------------------------------------------------------------------------

/**
 * Adapts a `RuntimeJournalWriter` to the `RuntimeJournalRepository` interface
 * so it can be used inside a `RuntimeStoreTransaction`.
 *
 * The writer enforces strict/best-effort semantics:
 * - Best-effort: `append()` failures are logged and swallowed → returns `ok(entry)`
 *   with a synthetic entry so the surrounding transaction can commit.
 * - Strict: `append()` failures propagate as errors → transaction rolls back.
 *
 * Non-append operations (findById, getById, query) delegate directly to the
 * underlying repository.
 */
class JournalWriterRepository implements RuntimeJournalRepository {
  private readonly writer: RuntimeJournalWriter;

  constructor(
    private readonly inner: SqliteRuntimeJournalRepository,
    strictMode: boolean,
  ) {
    this.writer = new RuntimeJournalWriter(inner, { strictMode });
  }

  append(
    entry: Omit<RuntimeJournalEntry, "id" | "timestamp">,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError> {
    return this.writer
      .write({
        source: entry.source,
        eventType: entry.eventType,
        executionId: entry.executionId,
        workflowInstanceId: entry.workflowInstanceId,
        stepId: entry.stepId,
        severity: entry.severity,
        data: entry.data as JsonObject,
      })
      .andThen((result) => {
        if (result === undefined) {
          // Best-effort mode swallowed the error — return a synthetic entry
          // so the transaction callback sees ok() and can commit.
          const synthetic: RuntimeJournalEntry = {
            id: createRuntimeJournalEntryId("swallowed"),
            timestamp: new Date().toISOString(),
            source: entry.source,
            eventType: entry.eventType,
            severity: entry.severity,
            data: entry.data as JsonObject,
          };
          return okAsync(synthetic);
        }
        return okAsync(result);
      });
  }

  findById(
    id: RuntimeJournalEntryId,
  ): ResultAsync<RuntimeJournalEntry | null, RuntimeStoreError> {
    return this.inner.findById(id);
  }

  getById(
    id: RuntimeJournalEntryId,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError> {
    return this.inner.getById(id);
  }

  query(
    filter?: JournalQueryFilter,
  ): ResultAsync<readonly RuntimeJournalEntry[], RuntimeStoreError> {
    return this.inner.query(filter);
  }

  prune(options: {
    readonly olderThan?: string;
    readonly maxCount?: number;
  }): ResultAsync<RetentionPruneStats, RuntimeStoreError> {
    return this.inner.prune(options);
  }
}

const validPermissionString = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  new TextEncoder().encode(value).byteLength <= 256 &&
  !/[\uD800-\uDFFF]/u.test(value);
const validPermissionTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Bound concurrent-writer retries when SQLite reports a transient lock.
 * Shared by grant `saveMany` and wall high-water `BEGIN IMMEDIATE` updates.
 * Same-instance writers serialize on the mutation queue; this bound covers
 * distinct repository/store instances sharing one DB file. Exhaustion maps to
 * `repository_failure` only after the full retry budget.
 */
const PERMISSION_SQLITE_BUSY_RETRIES = 32;

/**
 * Engine-internal runtime_metadata key for the durable permission wall-clock
 * high-water mark. Not a public API surface; key rows are allowed metadata.
 */
const PERMISSION_WALL_CLOCK_HIGH_WATER_KEY = "permission_wall_clock_high_water";

type PermissionGrantRow = import("./schema.js").PermissionGrantRow;

function rowToGrant(
  row: PermissionGrantRow,
): Result<DurablePermissionGrantRecord, PermissionError> {
  return hydrateDurableGrant(row);
}

function hydrateGrantRows(
  rows: readonly PermissionGrantRow[],
): Result<readonly DurablePermissionGrantRecord[], PermissionError> {
  const records: DurablePermissionGrantRecord[] = [];
  for (const row of rows) {
    const hydrated = rowToGrant(row);
    if (hydrated.isErr()) return err(hydrated.error);
    records.push(hydrated.value);
  }
  return ok(records);
}

/**
 * Read a SQLite driver error code without string-matching messages or leaking
 * raw driver text into permission errors.
 */
function readSqliteErrorCode(error: unknown): string | undefined {
  const read = Result.fromThrowable(
    () => {
      if (!error || typeof error !== "object") return undefined;
      const code = Reflect.get(error, "code");
      return typeof code === "string" ? code : undefined;
    },
    () => undefined,
  )();
  return read.isOk() ? read.value : undefined;
}

function isSqliteConstraintConflict(error: unknown): boolean {
  const code = readSqliteErrorCode(error);
  if (!code) return false;
  return (
    code === "SQLITE_CONSTRAINT" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function isSqliteBusy(error: unknown): boolean {
  const code = readSqliteErrorCode(error);
  if (!code) return false;
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_BUSY_RECOVERY" ||
    code === "SQLITE_BUSY_SNAPSHOT" ||
    code === "SQLITE_LOCKED" ||
    code === "SQLITE_LOCKED_SHAREDCACHE"
  );
}

export class SqlitePermissionApprovalRepository
  implements PermissionApprovalRepository
{
  /**
   * Serializes same-connection writers. One Kysely/bun:sqlite handle must not
   * overlap `BEGIN IMMEDIATE` transactions; the tail recovers after every
   * Ok/Err/throw/rejection so a failed mutation cannot poison later work.
   * High-water observe/list/match also enqueue so maxima cannot be lost.
   */
  private mutationTail: Promise<void> = Promise.resolve();
  /** Process-local cache of the persisted wall high-water (engine-internal). */
  #wallHighWater = 0;

  constructor(
    private readonly db: Kysely<WeaveDatabase>,
    private readonly clock: Clock,
  ) {}
  private failure(): PermissionError {
    return { type: "repository_failure" };
  }
  /**
   * Queue a mutation on this repository instance. Always returns ResultAsync
   * (never a rejected promise) and always advances the tail.
   */
  private enqueueMutation<T>(
    work: () => ResultAsync<T, PermissionError>,
  ): ResultAsync<T, PermissionError> {
    const run: Promise<Result<T, PermissionError>> = this.mutationTail.then(
      async () => {
        const started = Result.fromThrowable(
          work,
          (): PermissionError => this.failure(),
        )();
        if (started.isErr()) return err(started.error);
        // ResultAsync is thenable and resolves to Result; await keeps throws in-band.
        return await started.value;
      },
      async () => {
        // Prior tail rejection is defensive only — recover and still run work.
        const started = Result.fromThrowable(
          work,
          (): PermissionError => this.failure(),
        )();
        if (started.isErr()) return err(started.error);
        return await started.value;
      },
    );
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return ResultAsync.fromPromise(
      run,
      (): PermissionError => this.failure(),
    ).andThen((result) => result);
  }
  /**
   * Invoke the injected clock inside a Result boundary. Throwing clocks and
   * non-timestamp return values become `repository_failure` (never throws).
   */
  private readClock(): Result<number, PermissionError> {
    return Result.fromThrowable(
      () => this.clock(),
      () => this.failure(),
    )().andThen((now) => {
      if (!validPermissionTimestamp(now)) return err(this.failure());
      return ok(now);
    });
  }
  private resolveNow(
    now: number | undefined,
    invalid: PermissionError,
  ): Result<number, PermissionError> {
    if (now === undefined) return this.readClock();
    if (!validPermissionTimestamp(now)) return err(invalid);
    return ok(now);
  }
  /**
   * Parse a persisted high-water metadata value. Malformed rows fail closed.
   */
  private parseHighWaterValue(value: unknown): Result<number, PermissionError> {
    if (typeof value !== "string" || value.length === 0 || value.length > 32)
      return err(this.failure());
    if (!/^[0-9]+$/.test(value)) return err(this.failure());
    const parsed = Number(value);
    if (!validPermissionTimestamp(parsed)) return err(this.failure());
    // Reject non-canonical leading zeros (except "0").
    if (String(parsed) !== value) return err(this.failure());
    return ok(parsed);
  }
  /**
   * Retry a writer body when SQLite reports a transient busy/locked error.
   * Used by multi-store `BEGIN IMMEDIATE` paths; the per-instance mutation
   * queue alone cannot coordinate distinct connections.
   */
  private async withSqliteBusyRetry<T>(work: () => Promise<T>): Promise<T> {
    let lastBusy: unknown;
    for (
      let attempt = 0;
      attempt <= PERMISSION_SQLITE_BUSY_RETRIES;
      attempt += 1
    ) {
      try {
        return await work();
      } catch (error) {
        if (isSqliteBusy(error) && attempt < PERMISSION_SQLITE_BUSY_RETRIES) {
          lastBusy = error;
          // Backoff so the holding writer can commit before re-preflight.
          // attempt 0 yields; later attempts sleep up to 16ms.
          if (attempt === 0) await Promise.resolve();
          else await Bun.sleep(Math.min(2 ** (attempt - 1), 16));
          continue;
        }
        throw error;
      }
    }
    throw lastBusy ?? new Error("permission sqlite busy retries exhausted");
  }
  /**
   * Atomically observe a wall timestamp against the persisted high-water mark.
   * Must run inside the mutation queue (and may nest inside an open IMMEDIATE
   * transaction via `inTransaction: true`). Standalone updates open their own
   * `BEGIN IMMEDIATE` with bounded busy retry so concurrent multi-store
   * observations never lose the global max to last-writer/lower timestamps.
   */
  private advanceHighWaterUnlocked(
    supplied: number,
    options: { readonly inTransaction: boolean } = { inTransaction: false },
  ): ResultAsync<number, PermissionError> {
    if (!validPermissionTimestamp(supplied)) return errAsync(this.failure());
    const runOnce = async (): Promise<number> => {
      if (!options.inTransaction) {
        await sql`BEGIN IMMEDIATE`.execute(this.db);
      }
      try {
        const rows = await sql<{ value: string }>`
          SELECT value AS value
          FROM runtime_metadata
          WHERE key = ${PERMISSION_WALL_CLOCK_HIGH_WATER_KEY}
        `.execute(this.db);
        let previous = this.#wallHighWater;
        const row = rows.rows[0];
        if (row) {
          const parsed = this.parseHighWaterValue(row.value);
          if (parsed.isErr()) throw new PermissionHydrationSentinel();
          previous = Math.max(previous, parsed.value);
        }
        const effective = Math.max(previous, supplied);
        // Max-preserving UPSERT: never let a lower timestamp overwrite a
        // higher committed mark even if a writer raced past preflight.
        if (effective > previous || row === undefined) {
          await sql`
            INSERT INTO runtime_metadata (key, value)
            VALUES (
              ${PERMISSION_WALL_CLOCK_HIGH_WATER_KEY},
              ${String(effective)}
            )
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            WHERE CAST(excluded.value AS INTEGER) >
              CAST(runtime_metadata.value AS INTEGER)
          `.execute(this.db);
        }
        if (!options.inTransaction) {
          await sql`COMMIT`.execute(this.db);
        }
        this.#wallHighWater = effective;
        return effective;
      } catch (error) {
        if (!options.inTransaction) {
          await sql`ROLLBACK`.execute(this.db).catch(() => undefined);
        }
        throw error;
      }
    };
    return ResultAsync.fromPromise(
      options.inTransaction ? runOnce() : this.withSqliteBusyRetry(runOnce),
      (error) => {
        if (error instanceof PermissionHydrationSentinel) return this.failure();
        return this.failure();
      },
    );
  }
  private observeWallNow(
    now: number | undefined,
    invalid: PermissionError,
    options: { readonly inTransaction: boolean } = { inTransaction: false },
  ): ResultAsync<number, PermissionError> {
    const resolved = this.resolveNow(now, invalid);
    if (resolved.isErr()) return errAsync(resolved.error);
    return this.advanceHighWaterUnlocked(resolved.value, options);
  }
  private async insertGrantBatch(
    copies: readonly DurablePermissionGrantRecord[],
    ids: ReadonlySet<string>,
    identities: ReadonlySet<string>,
  ): Promise<readonly DurablePermissionGrantRecord[]> {
    // BEGIN IMMEDIATE serializes writers so concurrent stores either observe
    // each other's preflight result or hit a deterministic constraint/busy path.
    await sql`BEGIN IMMEDIATE`.execute(this.db);
    try {
      const existing = await this.db
        .selectFrom("permission_grants")
        .selectAll()
        .where((eb) =>
          eb.or([
            eb("grant_id", "in", [...ids]),
            ...copies.map((record) =>
              eb.and([
                eb("project_identity", "=", record.identity.projectIdentity),
                eb("agent_name", "=", record.identity.agentName),
                eb(
                  "registration_owner",
                  "=",
                  record.identity.registrationOwner,
                ),
                eb("tool_identity", "=", record.identity.toolIdentity),
                eb(
                  "registration_revision",
                  "=",
                  record.identity.registrationRevision,
                ),
                eb(
                  "policy_fingerprint",
                  "=",
                  record.identity.policyFingerprint,
                ),
                eb(
                  "request_schema_version",
                  "=",
                  record.identity.requestSchemaVersion,
                ),
                eb("request_digest", "=", record.identity.requestDigest),
              ]),
            ),
          ]),
        )
        .execute();
      for (const row of existing) {
        const hydrated = rowToGrant(row);
        if (hydrated.isErr()) throw new PermissionHydrationSentinel();
        const existingKey = grantIdentityKey(hydrated.value.identity);
        if (existingKey.isErr()) throw new PermissionHydrationSentinel();
        if (
          ids.has(hydrated.value.grantId) ||
          identities.has(existingKey.value)
        )
          throw new PermissionConflictSentinel();
      }
      for (const record of copies)
        await this.db
          .insertInto("permission_grants")
          .values({
            grant_id: record.grantId,
            project_identity: record.identity.projectIdentity,
            agent_name: record.identity.agentName,
            registration_owner: record.identity.registrationOwner,
            tool_identity: record.identity.toolIdentity,
            registration_revision: record.identity.registrationRevision,
            policy_fingerprint: record.identity.policyFingerprint,
            request_schema_version: record.identity.requestSchemaVersion,
            request_digest: record.identity.requestDigest,
            display_summary: record.display.summary,
            display_details: record.display.details ?? null,
            created_at: record.createdAt,
            expires_at: record.expiresAt ?? null,
            revoked_at: record.revokedAt ?? null,
            state: record.state,
          })
          .execute();
      await sql`COMMIT`.execute(this.db);
      return Object.freeze(copies);
    } catch (error) {
      await sql`ROLLBACK`.execute(this.db).catch(() => undefined);
      throw error;
    }
  }
  private saveManyUnlocked(
    records: readonly DurablePermissionGrantRecord[],
  ): ResultAsync<readonly DurablePermissionGrantRecord[], PermissionError> {
    if (!Array.isArray(records) || records.length === 0)
      return errAsync({
        type: "invalid_output",
        message: "saveMany requires at least one record",
      });

    const copies: DurablePermissionGrantRecord[] = [];
    for (const record of records) {
      const checked = validateDurableGrantRecordResult(record);
      if (checked.isErr()) return errAsync(checked.error);
      copies.push(checked.value);
    }
    const ids = new Set(copies.map((record) => record.grantId));
    const identityKeys: string[] = [];
    for (const record of copies) {
      const identity = grantIdentityKey(record.identity);
      if (identity.isErr()) return errAsync(identity.error);
      identityKeys.push(identity.value);
    }
    const identities = new Set(identityKeys);
    if (ids.size !== copies.length || identities.size !== copies.length)
      return errAsync({
        type: "invalid_output",
        message: "duplicate grant identity",
      });

    // Observe wall high-water before the grant write so a rolled-back conflict
    // cannot undo an already-observed expiry boundary.
    return this.observeWallNow(undefined, this.failure()).andThen(() =>
      ResultAsync.fromPromise(
        this.withSqliteBusyRetry(() =>
          this.insertGrantBatch(copies, ids, identities),
        ),
        (error): PermissionError => {
          if (
            error instanceof PermissionConflictSentinel ||
            isSqliteConstraintConflict(error)
          ) {
            return {
              type: "invalid_output" as const,
              message: "permission grant conflict",
            };
          }
          // Hydration/busy-exhaustion/unrelated driver failures fail closed.
          return this.failure();
        },
      ),
    );
  }
  saveMany(
    records: readonly DurablePermissionGrantRecord[],
  ): ResultAsync<readonly DurablePermissionGrantRecord[], PermissionError> {
    return this.enqueueMutation(() => this.saveManyUnlocked(records));
  }
  list(
    project: string,
    now?: number,
  ): ResultAsync<readonly PermissionGrantSummary[], PermissionError> {
    if (!validPermissionString(project))
      return errAsync({
        type: "invalid_output",
        message: "invalid repository list input",
      });
    return this.enqueueMutation(() =>
      this.observeWallNow(now, {
        type: "invalid_output",
        message: "invalid repository list input",
      }).andThen((effectiveNow) => {
        // Listing is not expiry-filtered; high-water still advances.
        void effectiveNow;
        return ResultAsync.fromPromise(
          this.db
            .selectFrom("permission_grants")
            .selectAll()
            .where("project_identity", "=", project)
            .orderBy("grant_id", "asc")
            .execute(),
          () => this.failure(),
        )
          .andThen(hydrateGrantRows)
          .andThen((records) => {
            const summaries: PermissionGrantSummary[] = [];
            for (const record of records) {
              const summary = summarizeDurableGrant(record);
              if (summary.isErr()) return err(summary.error);
              summaries.push(summary.value);
            }
            return ok(Object.freeze(summaries));
          })
          .mapErr(() => this.failure());
      }),
    );
  }
  match(
    identity: GrantIdentityEnvelope,
    now?: number,
  ): ResultAsync<PermissionGrantSummary | undefined, PermissionError> {
    const checked = validateGrantIdentityResult(identity);
    if (checked.isErr())
      return errAsync({
        type: "invalid_output",
        message: "invalid grant identity envelope",
      });
    const value = checked.value;
    return this.enqueueMutation(() =>
      this.observeWallNow(now, {
        type: "invalid_output",
        message: "invalid grant identity envelope",
      }).andThen((effectiveNow) =>
        ResultAsync.fromPromise(
          this.db
            .selectFrom("permission_grants")
            .selectAll()
            .where("project_identity", "=", value.projectIdentity)
            .where("agent_name", "=", value.agentName)
            .where("registration_owner", "=", value.registrationOwner)
            .where("tool_identity", "=", value.toolIdentity)
            .where("registration_revision", "=", value.registrationRevision)
            .where("policy_fingerprint", "=", value.policyFingerprint)
            .where("request_schema_version", "=", value.requestSchemaVersion)
            .where("request_digest", "=", value.requestDigest)
            .orderBy("grant_id", "asc")
            .execute(),
          () => this.failure(),
        )
          .andThen(hydrateGrantRows)
          .andThen((records) => {
            // Defense in depth: even if a hostile collation made SQLite return
            // a case/encoding-mismatched row, exact JS identity equality must
            // hold on all eight envelope fields before authorizing.
            for (const candidate of records) {
              if (candidate.state !== "active") continue;
              if (
                candidate.expiresAt !== undefined &&
                candidate.expiresAt <= effectiveNow
              ) {
                continue;
              }
              const equal = grantIdentitiesEqual(candidate.identity, value);
              if (equal.isErr()) return err(equal.error);
              if (!equal.value) continue;
              return summarizeDurableGrant(candidate);
            }
            return ok(undefined);
          })
          .mapErr(() => this.failure()),
      ),
    );
  }
  private revokeUnlocked(
    project: string,
    grantId: string,
  ): ResultAsync<void, PermissionError> {
    if (!validPermissionString(project) || !validPermissionString(grantId))
      return errAsync({
        type: "invalid_output",
        message: "invalid revoke input",
      } satisfies PermissionError);
    return ResultAsync.fromPromise(
      this.db
        .selectFrom("permission_grants")
        .selectAll()
        .where("project_identity", "=", project)
        .where("grant_id", "=", grantId)
        .executeTakeFirst(),
      () => this.failure(),
    ).andThen((row) => {
      // Unknown/wrong-project never observes wall high-water — random revoke
      // attempts must not let callers poison the mark.
      if (!row)
        return errAsync({
          type: "unknown_grant",
          message: "grant not found",
        } satisfies PermissionError);
      const hydrated = rowToGrant(row);
      if (hydrated.isErr()) return errAsync(this.failure());
      // Observe BEFORE the already-revoked early return so idempotent revokes
      // still advance high-water and cannot resurrect later expiries after
      // wall rollback / reopen under a lower clock.
      return this.observeWallNow(undefined, this.failure(), {
        inTransaction: false,
      }).andThen((revokedAt) => {
        if (hydrated.value.state === "revoked") return okAsync(undefined);
        if (revokedAt < hydrated.value.createdAt)
          return errAsync({
            type: "invalid_output",
            message: "invalid revoke timestamp",
          } satisfies PermissionError);
        return ResultAsync.fromPromise(
          this.db
            .updateTable("permission_grants")
            .set({ state: "revoked", revoked_at: revokedAt })
            .where("project_identity", "=", project)
            .where("grant_id", "=", grantId)
            .where("state", "=", "active")
            .execute(),
          () => this.failure(),
        ).map(() => undefined);
      });
    });
  }
  revoke(project: string, grantId: string): ResultAsync<void, PermissionError> {
    return this.enqueueMutation(() => this.revokeUnlocked(project, grantId));
  }
}

// ---------------------------------------------------------------------------
// SqliteRuntimeStoreTransaction
// ---------------------------------------------------------------------------

/**
 * A transaction scope that wraps all repositories with a shared Kysely
 * transaction connection.
 */
class SqliteRuntimeStoreTransaction implements RuntimeStoreTransaction {
  readonly instances: WorkflowInstanceRepository;
  readonly leases: ExecutionLeaseRepository;
  readonly snapshots: SessionSnapshotRepository;
  readonly journal: RuntimeJournalRepository;
  readonly usage: UsageRepository;
  constructor(
    txDb: Kysely<WeaveDatabase>,
    clock: () => Date,
    strictJournal: boolean,
  ) {
    this.instances = new SqliteWorkflowInstanceRepository(txDb);
    this.leases = new SqliteExecutionLeaseRepository(txDb, clock);
    this.snapshots = new SqliteSessionSnapshotRepository(txDb);
    const rawJournal = new SqliteRuntimeJournalRepository(txDb);
    this.journal = new JournalWriterRepository(rawJournal, strictJournal);
    this.usage = new SqliteUsageRepository(txDb);
  }
}

// ---------------------------------------------------------------------------
// SqliteRuntimeStore
// ---------------------------------------------------------------------------

/** Maps a `RuntimeDirectoryGuardError` onto the store's own closed error type. */
function mapDirectoryGuardError(
  cause: RuntimeDirectoryGuardError,
): RuntimeStoreError {
  return initializationError(
    cause.message,
    "cause" in cause ? cause.cause : undefined,
  );
}

/**
 * Thrown by `DirHandleMemoryStoreCoordinator` when a lock/read/write step
 * against the held `RuntimeDirectoryHandle` fails, carrying the original
 * typed `RuntimeDirectoryGuardError` so the caller (`_doInitialize`, or a
 * repository operation's `ResultAsync.fromPromise` mapper) can recover a
 * proper `RuntimeStoreError` instead of collapsing to a bare string.
 */
class CoordinatorFailureSentinel extends Error {
  constructor(readonly guardError: RuntimeDirectoryGuardError) {
    super(guardError.message);
  }
}

/**
 * `MemoryStoreCoordinator` implemented on top of a held `RuntimeDirectoryHandle`
 * (Pi adapter contract concurrency hardening). Every `acquire()` takes the leaf's
 * exclusive advisory lock (`lockLeaf`, itself bounded-retry with backoff)
 * and reloads its latest on-disk bytes (`readLeafBytes`) so a concurrent
 * store's already-committed writes are never silently overwritten.
 * `commit()` persists atomically (`writeLeafAtomic`) and *always* releases
 * the lock afterward — even when the write itself throws — so a flush
 * failure never wedges the lock for every other store sharing this leaf.
 * `discard()` releases the lock without writing anything back, used for
 * bare reads and after a statement failure.
 *
 * Any lock/read/write failure is reported through `onFailure`, which the
 * owning `SqliteRuntimeStore` uses to poison itself for anything other than
 * transient lock contention (`type: "locked"` — the underlying `lockLeaf`
 * already retried with backoff and simply timed out; that is not evidence
 * of corruption and a later attempt is allowed to retry). Every other
 * failure type (`io`, `symlink-rejected`, `identity-changed`,
 * `unavailable`) indicates the held descriptor's assumptions may no longer
 * hold, so the store poisons and fails closed for good.
 */
class DirHandleMemoryStoreCoordinator implements MemoryStoreCoordinator {
  constructor(
    private readonly dirHandle: RuntimeDirectoryHandle,
    private readonly leafName: string,
    private readonly onCommitIdentity: (identity: RuntimeFileIdentity) => void,
    private readonly onFailure: (cause: RuntimeDirectoryGuardError) => void,
  ) {}

  private reportAndThrow(cause: RuntimeDirectoryGuardError): never {
    this.onFailure(cause);
    throw new CoordinatorFailureSentinel(cause);
  }

  async acquire(): Promise<Uint8Array> {
    const lockResult = await this.dirHandle.lockLeaf(this.leafName);
    if (lockResult.isErr()) this.reportAndThrow(lockResult.error);

    const bytesResult = await this.dirHandle.readLeafBytes(this.leafName);
    if (bytesResult.isErr()) {
      // The lock was acquired above; `acquire()` must leave nothing held
      // when it throws, so release it before surfacing the read failure.
      await this.dirHandle.unlockLeaf(this.leafName);
      this.reportAndThrow(bytesResult.error);
    }
    return bytesResult.value;
  }

  async commit(bytes: Uint8Array): Promise<void> {
    try {
      const writeResult = await this.dirHandle.writeLeafAtomic(
        this.leafName,
        bytes,
        0o600,
      );
      if (writeResult.isErr()) this.reportAndThrow(writeResult.error);
      this.onCommitIdentity(writeResult.value);
    } finally {
      await this.dirHandle.unlockLeaf(this.leafName);
    }
  }

  async discard(): Promise<void> {
    await this.dirHandle.unlockLeaf(this.leafName);
  }
}

/**
 * Options for creating a SqliteRuntimeStore.
 */
export interface SqliteRuntimeStoreOptions {
  /** Absolute path to the `weave.db` file. Must be located at or under `projectRoot`. */
  readonly dbPath: string;
  /**
   * Absolute path to the harness-established, already-trusted project root
   * (Pi adapter contract). The no-follow directory guard opens this directly
   * (it is assumed to already exist) and walks every path component between
   * it and `dbPath`'s directory, holding both the root and the runtime
   * directory descriptors for the store's entire lifetime.
   *
   * Defaults to the nearest expected existing ancestor above the canonical
   * `<scope>/runtime/weave.db` layout when omitted. This keeps the anchor
   * outside lazily-created scope/runtime directories, so the held-descriptor
   * `mkdirat` walk can create them without path-based pre-creation. Callers
   * that hold a real project root (e.g. the Pi adapter, passing the harness
   * session's trusted `cwd`) must provide it explicitly so the full
   * project-relative ancestor chain is proven.
   */
  readonly projectRoot?: string;
  /** Whether journal write failures roll back the unit of work. Default: false. */
  readonly strictJournal?: boolean;
  /** Clock source for lease expiry checks. Default: `() => new Date()`. */
  readonly clock?: () => Date;
  /**
   * Test-only seam awaited after DB open/migrations/salt preparation but
   * before the store publishes initialized state. Lets tests deterministically
   * race `close()` against lazy initialization.
   * @internal
   */
  readonly beforeInitPublish?: () => Promise<void>;
  /**
   * No-follow directory verification for the runtime directory and the
   * `weave.db` leaf (Pi adapter contract). Defaults to `BunRuntimeDirectoryGuard`.
   * Tests inject `MemoryRuntimeDirectoryGuard` to exercise symlink-rejection
   * and identity-change paths without touching a real filesystem.
   * @internal
   */
  readonly directoryGuard?: RuntimeDirectoryGuard;
}

/**
 * SQLite-backed implementation of `RuntimeStore`.
 *
 * Lazy initialization: the runtime directory and DB file are created on
 * the first call to `ensureInitialized()`, which is called by all
 * repository operations.
 */
export class SqliteRuntimeStore implements RuntimeStore {
  private db: Kysely<WeaveDatabase> | null = null;
  private initialized = false;
  private closed = false;
  private initializingPromise: Promise<Result<void, RuntimeStoreError>> | null =
    null;
  private closingResult: ResultAsync<void, RuntimeStoreError> | null = null;
  private readonly clock: () => Date;
  private readonly directoryGuard: RuntimeDirectoryGuard;
  private _projectSalt: string | null = null;
  /** Held for the store's lifetime (Pi adapter contract); closed only in `close()` or on init failure. */
  private dirHandle: RuntimeDirectoryHandle | null = null;
  /** The `weave.db` leaf name, captured once at init for per-commit revalidation. */
  private leafName: string | null = null;
  /** Identity the leaf was last proven to have, via the held directory descriptor. */
  private boundLeafIdentity: RuntimeFileIdentity | null = null;
  /** Set once identity revalidation ever fails after publication; poisons all further operations. */
  private poisoned = false;

  readonly instances: WorkflowInstanceRepository;
  readonly leases: ExecutionLeaseRepository;
  readonly snapshots: SessionSnapshotRepository;
  readonly journal: RuntimeJournalRepository;
  readonly usage: UsageRepository;
  #permissions: PermissionApprovalRepository;

  /** The per-project CSPRNG salt stored in `runtime_metadata`. */
  get projectSalt(): string {
    if (!this._projectSalt) {
      throw new Error(
        "projectSalt accessed before store initialization. Call ensureInitialized() first.",
      );
    }
    return this._projectSalt;
  }

  constructor(private readonly options: SqliteRuntimeStoreOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.directoryGuard =
      options.directoryGuard ?? new BunRuntimeDirectoryGuard();

    // Repositories are lazy — they call ensureInitialized() on first use
    this.instances = new LazyWorkflowInstanceRepository(this);
    this.leases = new LazyExecutionLeaseRepository(this);
    this.snapshots = new LazySessionSnapshotRepository(this);
    this.journal = new LazyRuntimeJournalRepository(this);
    this.usage = new LazyUsageRepository(this);
    this.#permissions = new LazyPermissionApprovalRepository(this, () =>
      this.clock().getTime(),
    );
    registerPermissionApprovalRepository(this, this.#permissions);
  }

  /**
   * Whether `close()` has been requested. Lazy repositories consult this so
   * they never cache or reuse a handle after teardown.
   * @internal
   */
  isStoreClosed(): boolean {
    return this.closed;
  }

  /**
   * Ensure the runtime directory and DB are created and migrations applied.
   * Idempotent — safe to call multiple times. Concurrent callers share the
   * same in-flight initialization promise so initialization only runs once.
   * Closed stores never reopen; in-flight init that loses a close race returns
   * a typed closed/initialization failure and does not publish state.
   */
  ensureInitialized(): ResultAsync<Kysely<WeaveDatabase>, RuntimeStoreError> {
    if (this.closed)
      return errAsync(initializationError("Runtime store is closed"));
    if (this.poisoned)
      return errAsync(
        initializationError(
          "Runtime store identity was compromised and is now closed to further operations",
        ),
      );
    if (this.initialized && this.db) {
      return okAsync(this.db);
    }

    if (!this.initializingPromise) {
      this.initializingPromise = this._doInitialize();
    }

    return new ResultAsync(
      this.initializingPromise.then(
        (result): Result<Kysely<WeaveDatabase>, RuntimeStoreError> => {
          if (result.isErr()) return err(result.error);
          // Close may have won after init published; never hand out a torn-down handle.
          if (this.closed || !this.db) {
            return err(initializationError("Runtime store is closed"));
          }
          return ok(this.db);
        },
      ),
    );
  }

  /**
   * Tear down a local (unpublished or published) Kysely handle and clear store
   * publication state. Always clears `initializingPromise` so recoverable
   * failures can retry when the store was not closed.
   */
  private async abandonInitialize(
    db: Kysely<WeaveDatabase> | null,
    error: RuntimeStoreError,
    dirHandle?: RuntimeDirectoryHandle,
  ): Promise<Result<void, RuntimeStoreError>> {
    if (db !== null) {
      await ResultAsync.fromPromise(db.destroy(), () => undefined).match(
        () => undefined,
        () => undefined,
      );
      if (this.db === db) this.db = null;
    }
    if (dirHandle !== undefined) {
      dirHandle.close();
    }
    this.initialized = false;
    this._projectSalt = null;
    this.dirHandle = null;
    this.leafName = null;
    this.boundLeafIdentity = null;
    this.initializingPromise = null;
    return err(error);
  }

  /**
   * Internal initialization logic. Keeps the opened Kysely handle local until
   * the final synchronous publish. If `closed` becomes true at any await
   * boundary, opened resources are destroyed and waiters receive a typed
   * closed failure — `db` / `initialized` / salt are never published.
   */
  private async _doInitialize(): Promise<Result<void, RuntimeStoreError>> {
    if (this.closed) {
      this.initializingPromise = null;
      return err(initializationError("Runtime store is closed"));
    }

    const runtimeDir = dirname(this.options.dbPath);
    const leafName = runtimeLeafName(this.options.dbPath);
    // With no explicit `projectRoot`, anchor one level above the scope that
    // owns `runtime`. This preserves lazy recovery when both the scope and
    // runtime directories are absent: the held-descriptor walk creates both
    // safely. The anchor's own ancestors remain the caller's trust boundary.
    const projectRoot =
      this.options.projectRoot ?? dirname(dirname(runtimeDir));
    const relativeDir = relative(projectRoot, runtimeDir);
    const segments = relativeDir
      .split(sep)
      .filter((segment) => segment.length > 0);
    if (relativeDir.startsWith(`..${sep}`) || relativeDir === "..") {
      this.initializingPromise = null;
      return err(
        initializationError("dbPath must be located at or under projectRoot"),
      );
    }

    // Acquire held, no-follow handles for both the canonical project root
    // and the runtime directory (Pi adapter contract), walking every intermediate
    // path component with a no-follow `openat` (never a single absolute-path
    // open, which only proves the final component). Every subsequent
    // operation on the `weave.db` leaf and its WAL/SHM sidecars happens
    // relative to this same held descriptor - never a bare path re-open.
    const dirHandleResult = await this.directoryGuard.ensureRuntimeDirectory(
      projectRoot,
      segments,
      0o700,
    );
    if (dirHandleResult.isErr()) {
      this.initializingPromise = null;
      return err(mapDirectoryGuardError(dirHandleResult.error));
    }
    const dirHandle = dirHandleResult.value;
    if (this.closed) {
      this.initializingPromise = null;
      dirHandle.close();
      return err(initializationError("Runtime store is closed"));
    }

    // Cross-store coordinator over the held directory descriptor (Pi adapter contract
    // concurrency hardening): every `acquire()` takes the leaf's
    // exclusive advisory lock and reloads its latest on-disk bytes, and
    // `commit()` persists atomically and always releases the lock
    // afterward. The entire bootstrap sequence below - reading the
    // leaf's current bytes, running migrations, initializing the project
    // salt, and the initial flush - runs under one single held lock so a
    // concurrent store's own init/commit can never interleave with it.
    const coordinator = new DirHandleMemoryStoreCoordinator(
      dirHandle,
      leafName,
      (identity) => {
        this.boundLeafIdentity = identity;
      },
      (cause) => {
        // Transient lock contention (the underlying `lockLeaf` already
        // retried with backoff and simply timed out) is not evidence of
        // corruption; every other failure indicates the held descriptor's
        // assumptions may no longer hold, so the store poisons for good.
        if (cause.type !== "locked") this.poisoned = true;
        log.error(
          { err: cause, poisoned: this.poisoned },
          "Runtime store coordinator operation failed",
        );
      },
    );

    // Acquires the exclusive lock and reads the leaf's full current bytes
    // through the held directory descriptor (a no-follow `openat`, never a
    // path). `bun:sqlite`'s `Database` constructor never touches a path for
    // this DB at all: it deserializes these exact bytes in-memory, so there
    // is no "reopen" - related or otherwise - to reason about. An
    // empty/fresh file becomes a brand-new in-memory database (bun:sqlite
    // rejects an empty byte buffer).
    let initialBytes: Uint8Array;
    try {
      initialBytes = await coordinator.acquire();
    } catch (cause) {
      return this.abandonInitialize(
        null,
        cause instanceof CoordinatorFailureSentinel
          ? mapDirectoryGuardError(cause.guardError)
          : initializationError(
              "Failed to acquire the runtime store lock",
              cause,
            ),
        dirHandle,
      );
    }

    // Keep the handle local until publish so close() cannot observe a half-init.
    const dialect = new BunSqliteMemoryDialect(initialBytes, coordinator);
    const db = new Kysely<WeaveDatabase>({ dialect });

    // Run migrations directly against the in-memory raw bun:sqlite Database.
    // Migrations bypass the Kysely driver (and therefore its automatic
    // flush-on-autocommit), so a single explicit commit below persists
    // their combined effect and establishes the first bound leaf identity.
    const rawDb = dialect.getDatabase();
    const migrationResult = runMigrations(rawDb);
    if (migrationResult.isErr()) {
      await coordinator.discard();
      return this.abandonInitialize(db, migrationResult.error, dirHandle);
    }
    if (this.closed) {
      await coordinator.discard();
      return this.abandonInitialize(
        db,
        initializationError("Runtime store is closed"),
        dirHandle,
      );
    }

    // Initialize or read the project salt from runtime_metadata (local until publish)
    const saltResult = Result.fromThrowable(
      () => {
        const saltRow = rawDb
          .prepare(
            "SELECT value FROM runtime_metadata WHERE key = 'project_salt'",
          )
          .get() as { value: string } | null;

        if (saltRow) return saltRow.value;

        const newSalt = createProjectSalt();
        rawDb
          .prepare(
            "INSERT INTO runtime_metadata (key, value) VALUES ('project_salt', ?)",
          )
          .run(newSalt);
        return newSalt;
      },
      (cause) =>
        initializationError("Failed to initialize project salt", cause),
    )();
    if (saltResult.isErr()) {
      await coordinator.discard();
      return this.abandonInitialize(db, saltResult.error, dirHandle);
    }
    const projectSalt = saltResult.value;

    // Migrations and salt initialization above wrote directly against
    // `rawDb`, bypassing the Kysely driver's automatic flush-on-autocommit.
    // Persist that combined effect now, through the same coordinator - this
    // also releases the lock acquired above and establishes
    // `boundLeafIdentity` for the first time.
    const initialFlush = await ResultAsync.fromPromise(
      coordinator.commit(rawDb.serialize()),
      (cause) =>
        cause instanceof CoordinatorFailureSentinel
          ? mapDirectoryGuardError(cause.guardError)
          : initializationError(
              "Failed to persist initial Runtime Store snapshot",
              cause,
            ),
    );
    if (initialFlush.isErr()) {
      return this.abandonInitialize(db, initialFlush.error, dirHandle);
    }

    // The in-memory database never produces WAL/SHM sidecar files - the
    // only on-disk artifact is `weave.db` itself, written exclusively
    // through `writeLeafAtomic`.

    // Deterministic test seam: close() can win before publication.
    if (this.options.beforeInitPublish !== undefined) {
      const gate = await ResultAsync.fromPromise(
        Promise.resolve(this.options.beforeInitPublish()),
        (cause) => initializationError("Initialization interrupted", cause),
      );
      if (gate.isErr()) {
        return this.abandonInitialize(db, gate.error, dirHandle);
      }
    }

    // Final closed check + publish are synchronous so close cannot interleave.
    if (this.closed) {
      return this.abandonInitialize(
        db,
        initializationError("Runtime store is closed"),
        dirHandle,
      );
    }

    // Held for the store's entire lifetime (Pi adapter contract) so every later
    // commit can revalidate stable parent/target identity; closed only in
    // `close()` or on a later poisoning/init failure.
    this.dirHandle = dirHandle;
    this.leafName = leafName;

    this.db = db;
    this._projectSalt = projectSalt;
    this.initialized = true;
    this.initializingPromise = null;
    log.info(
      { dbPath: this.options.dbPath, schemaVersion: CURRENT_SCHEMA_VERSION },
      "Runtime store initialized",
    );
    return ok(undefined);
  }

  /**
   * Re-verifies the `weave.db` leaf's identity through the held directory
   * descriptor (Pi adapter contract: "revalidates file identity across
   * migration/commit"). On mismatch, poisons the store (all further
   * operations fail closed) and returns a typed error.
   */
  private revalidateLeafIdentity(): ResultAsync<void, RuntimeStoreError> {
    if (!this.dirHandle || !this.leafName || !this.boundLeafIdentity) {
      return okAsync(undefined);
    }
    const boundIdentity = this.boundLeafIdentity;
    return this.dirHandle
      .verifyLeaf(this.leafName, { create: false, mode: 0o600 })
      .mapErr((cause) => {
        this.poisoned = true;
        return mapDirectoryGuardError(cause);
      })
      .andThen((observed) => {
        if (!directoryIdentitiesMatch(observed, boundIdentity)) {
          this.poisoned = true;
          return err(
            initializationError(
              "Runtime DB identity changed; store closed to further operations",
            ),
          );
        }
        return ok(undefined);
      });
  }

  transaction<T>(
    callback: TransactionCallback<T>,
  ): ResultAsync<T, RuntimeStoreError> {
    return this.ensureInitialized().andThen((db) => {
      return this.revalidateLeafIdentity().andThen(
        () =>
          ResultAsync.fromPromise(
            db.transaction().execute(async (txDb) => {
              const tx = new SqliteRuntimeStoreTransaction(
                txDb,
                this.clock,
                this.options.strictJournal ?? false,
              );

              const result = await callback(tx);

              if (result.isErr()) {
                // Throw to trigger Kysely transaction rollback
                throw new TxCallbackErrSentinel(result.error);
              }

              return result.value;
            }),
            (cause) => {
              if (cause instanceof TxCallbackErrSentinel) {
                return cause.storeError;
              }
              return queryError("Transaction failed", cause);
            },
          ),
        // `commitTransaction`'s flush (triggered inside the Kysely memory
        // driver once `db.inTransaction` goes false) already re-verifies
        // and rebinds `boundLeafIdentity` as part of persisting every
        // commit (Pi adapter contract) - no separate post-commit check is needed.
      );
    });
  }

  /**
   * Close the store and release resources.
   *
   * Sets `closed` first, awaits any in-flight lazy initialization, then
   * destroys the published DB exactly once and clears all state. Concurrent
   * and repeated close calls share one settlement. After close, repository
   * operations return typed failure and initialization does not resume.
   */
  close(): ResultAsync<void, RuntimeStoreError> {
    this.closed = true;
    if (this.closingResult) return this.closingResult;

    const waitInit =
      this.initializingPromise === null
        ? okAsync(undefined)
        : ResultAsync.fromPromise(
            this.initializingPromise.then(
              () => undefined,
              () => undefined,
            ),
            (cause) => queryError("Failed to close Runtime Store", cause),
          );

    this.closingResult = waitInit.andThen(() => {
      const db = this.db;
      this.db = null;
      this.initialized = false;
      this._projectSalt = null;
      this.initializingPromise = null;
      if (this.dirHandle) {
        this.dirHandle.close();
        this.dirHandle = null;
      }
      this.leafName = null;
      this.boundLeafIdentity = null;

      if (!db) return okAsync(undefined);

      return ResultAsync.fromPromise(db.destroy(), (cause) =>
        queryError("Failed to close Runtime Store", cause),
      ).map(() => undefined);
    });

    return this.closingResult;
  }
}

// ---------------------------------------------------------------------------
// Lazy repository wrappers
// ---------------------------------------------------------------------------
// These wrappers call ensureInitialized() before delegating to the real
// repository implementation. This enables lazy DB creation.

class LazyWorkflowInstanceRepository implements WorkflowInstanceRepository {
  constructor(private readonly store: SqliteRuntimeStore) {}

  private repo(): ResultAsync<
    SqliteWorkflowInstanceRepository,
    RuntimeStoreError
  > {
    return this.store
      .ensureInitialized()
      .map((db) => new SqliteWorkflowInstanceRepository(db));
  }

  create(
    input: CreateWorkflowInstanceInput,
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    return this.repo().andThen((r) => r.create(input));
  }

  findById(
    id: WorkflowInstanceId,
  ): ResultAsync<WorkflowInstance | null, RuntimeStoreError> {
    return this.repo().andThen((r) => r.findById(id));
  }

  getById(
    id: WorkflowInstanceId,
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    return this.repo().andThen((r) => r.getById(id));
  }

  list(filter?: {
    status?: WorkflowInstanceStatus;
  }): ResultAsync<readonly WorkflowInstance[], RuntimeStoreError> {
    return this.repo().andThen((r) => r.list(filter));
  }

  update(
    id: WorkflowInstanceId,
    input: UpdateWorkflowInstanceInput,
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    return this.repo().andThen((r) => r.update(id, input));
  }

  addArtifact(
    id: WorkflowInstanceId,
    artifact: {
      name: string;
      path: string;
      mimeType?: string;
      description?: string;
      integrity?: ArtifactIntegrityMetadata;
      producerAgent?: string;
    },
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    return this.repo().andThen((r) => r.addArtifact(id, artifact));
  }

  updateArtifactApproval(
    id: WorkflowInstanceId,
    artifactId: ArtifactId,
    approvalState: ArtifactApprovalState,
    approval?: {
      readonly actor: import("../types.js").ArtifactApprovalActor;
      readonly decidedAt: string;
      readonly expectedRevision: number;
      readonly expectedDigest?: string;
    },
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    return this.repo().andThen((r) =>
      r.updateArtifactApproval(id, artifactId, approvalState, approval),
    );
  }

  recordStepAttempt(
    id: WorkflowInstanceId,
    stepName: string,
    consumedArtifacts: readonly ConsumedArtifactRecord[],
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    return this.repo().andThen((r) =>
      r.recordStepAttempt(id, stepName, consumedArtifacts),
    );
  }
}

class LazyExecutionLeaseRepository implements ExecutionLeaseRepository {
  constructor(private readonly store: SqliteRuntimeStore) {}

  private repo(): ResultAsync<
    SqliteExecutionLeaseRepository,
    RuntimeStoreError
  > {
    return this.store
      .ensureInitialized()
      .map(
        (db) =>
          new SqliteExecutionLeaseRepository(
            db,
            (this.store as unknown as { clock: () => Date }).clock,
          ),
      );
  }

  acquire(
    input: AcquireLeaseInput,
  ): ResultAsync<ExecutionLease, RuntimeStoreError> {
    return this.repo().andThen((r) => r.acquire(input));
  }

  findActive(): ResultAsync<ExecutionLease | null, RuntimeStoreError> {
    return this.repo().andThen((r) => r.findActive());
  }

  getActive(): ResultAsync<ExecutionLease, RuntimeStoreError> {
    return this.repo().andThen((r) => r.getActive());
  }

  findById(
    id: ExecutionLeaseId,
  ): ResultAsync<ExecutionLease | null, RuntimeStoreError> {
    return this.repo().andThen((r) => r.findById(id));
  }

  getById(
    id: ExecutionLeaseId,
  ): ResultAsync<ExecutionLease, RuntimeStoreError> {
    return this.repo().andThen((r) => r.getById(id));
  }

  heartbeat(
    id: ExecutionLeaseId,
    ownerId: OwnerId,
    ttlMs: number,
  ): ResultAsync<ExecutionLease, RuntimeStoreError> {
    return this.repo().andThen((r) => r.heartbeat(id, ownerId, ttlMs));
  }

  release(
    id: ExecutionLeaseId,
    ownerId: OwnerId,
  ): ResultAsync<void, RuntimeStoreError> {
    return this.repo().andThen((r) => r.release(id, ownerId));
  }
}

class LazySessionSnapshotRepository implements SessionSnapshotRepository {
  constructor(private readonly store: SqliteRuntimeStore) {}

  private repo(): ResultAsync<
    SqliteSessionSnapshotRepository,
    RuntimeStoreError
  > {
    return this.store
      .ensureInitialized()
      .map((db) => new SqliteSessionSnapshotRepository(db));
  }

  record(
    input: RecordSessionSnapshotInput,
  ): ResultAsync<SessionSnapshot, RuntimeStoreError> {
    return this.repo().andThen((r) => r.record(input));
  }

  findById(
    id: SessionSnapshotId,
  ): ResultAsync<SessionSnapshot | null, RuntimeStoreError> {
    return this.repo().andThen((r) => r.findById(id));
  }

  getById(
    id: SessionSnapshotId,
  ): ResultAsync<SessionSnapshot, RuntimeStoreError> {
    return this.repo().andThen((r) => r.getById(id));
  }

  listByWorkflowInstance(
    workflowInstanceId: WorkflowInstanceId,
  ): ResultAsync<readonly SessionSnapshot[], RuntimeStoreError> {
    return this.repo().andThen((r) =>
      r.listByWorkflowInstance(workflowInstanceId),
    );
  }

  findLatestByWorkflowInstance(
    workflowInstanceId: WorkflowInstanceId,
  ): ResultAsync<SessionSnapshot | null, RuntimeStoreError> {
    return this.repo().andThen((r) =>
      r.findLatestByWorkflowInstance(workflowInstanceId),
    );
  }
}

class LazyRuntimeJournalRepository implements RuntimeJournalRepository {
  constructor(private readonly store: SqliteRuntimeStore) {}

  private repo(): ResultAsync<
    SqliteRuntimeJournalRepository,
    RuntimeStoreError
  > {
    return this.store
      .ensureInitialized()
      .map((db) => new SqliteRuntimeJournalRepository(db));
  }

  append(
    entry: Omit<RuntimeJournalEntry, "id" | "timestamp">,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError> {
    return this.repo().andThen((r) => r.append(entry));
  }

  findById(
    id: RuntimeJournalEntryId,
  ): ResultAsync<RuntimeJournalEntry | null, RuntimeStoreError> {
    return this.repo().andThen((r) => r.findById(id));
  }

  getById(
    id: RuntimeJournalEntryId,
  ): ResultAsync<RuntimeJournalEntry, RuntimeStoreError> {
    return this.repo().andThen((r) => r.getById(id));
  }

  query(
    filter?: JournalQueryFilter,
  ): ResultAsync<readonly RuntimeJournalEntry[], RuntimeStoreError> {
    return this.repo().andThen((r) => r.query(filter));
  }

  prune(options: {
    readonly olderThan?: string;
    readonly maxCount?: number;
  }): ResultAsync<RetentionPruneStats, RuntimeStoreError> {
    return this.repo().andThen((r) => r.prune(options));
  }
}

class LazyUsageRepository implements UsageRepository {
  constructor(private readonly store: SqliteRuntimeStore) {}

  private repo(): ResultAsync<SqliteUsageRepository, RuntimeStoreError> {
    return this.store
      .ensureInitialized()
      .map((db) => new SqliteUsageRepository(db));
  }

  recordObservation(
    observation: UsageObservation,
  ): ResultAsync<UsageObservationRecordResult, RuntimeStoreError> {
    return this.repo().andThen((r) => r.recordObservation(observation));
  }

  findObservationById(
    id: UsageObservationId,
  ): ResultAsync<UsageObservation | null, RuntimeStoreError> {
    return this.repo().andThen((r) => r.findObservationById(id));
  }

  listObservations(
    filter?: UsageObservationQueryFilter,
  ): ResultAsync<readonly UsageObservation[], RuntimeStoreError> {
    return this.repo().andThen((r) => r.listObservations(filter));
  }

  listRollups(
    filter?: UsageRollupQueryFilter,
  ): ResultAsync<readonly UsageRollup[], RuntimeStoreError> {
    return this.repo().andThen((r) => r.listRollups(filter));
  }

  pruneDetails(options: {
    readonly olderThan?: string;
    readonly maxCount?: number;
  }): ResultAsync<RetentionPruneStats, RuntimeStoreError> {
    return this.repo().andThen((r) => r.pruneDetails(options));
  }
}

class LazyPermissionApprovalRepository implements PermissionApprovalRepository {
  /** One cached repo so the per-instance mutation queue is shared across calls. */
  private cached: SqlitePermissionApprovalRepository | null = null;
  /**
   * Shared in-flight initialization. Cleared when the attempt settles so a
   * failed init does not stick; only a successful repository is cached.
   * Identity-checked on clear so an older failure cannot drop a newer attempt.
   */
  private resolving: Promise<
    Result<SqlitePermissionApprovalRepository, PermissionError>
  > | null = null;

  constructor(
    private readonly store: SqliteRuntimeStore,
    private readonly clock: Clock,
  ) {}
  private repo(): ResultAsync<
    SqlitePermissionApprovalRepository,
    PermissionError
  > {
    // Never reuse a handle after close — drop any cache immediately.
    if (this.store.isStoreClosed()) {
      this.cached = null;
      this.resolving = null;
      return errAsync({ type: "repository_failure" as const });
    }

    if (this.cached) return okAsync(this.cached);

    if (!this.resolving) {
      let attempt!: Promise<
        Result<SqlitePermissionApprovalRepository, PermissionError>
      >;
      attempt = (async (): Promise<
        Result<SqlitePermissionApprovalRepository, PermissionError>
      > => {
        try {
          const init = await this.store.ensureInitialized();
          if (init.isErr()) {
            return err({ type: "repository_failure" as const });
          }
          // Close may win between init settlement and cache publication.
          if (this.store.isStoreClosed()) {
            this.cached = null;
            return err({ type: "repository_failure" as const });
          }
          return Result.fromThrowable(
            () => {
              if (this.store.isStoreClosed()) {
                this.cached = null;
                throw new Error("closed");
              }
              this.cached ??= new SqlitePermissionApprovalRepository(
                init.value,
                this.clock,
              );
              return this.cached;
            },
            (): PermissionError => ({ type: "repository_failure" }),
          )();
        } catch {
          return err({ type: "repository_failure" as const });
        } finally {
          // Clear before waiters observe settlement so the next call can retry
          // after failure. Only this attempt may clear its own slot.
          if (this.resolving === attempt) this.resolving = null;
        }
      })();
      this.resolving = attempt;
    }

    return ResultAsync.fromPromise(
      this.resolving,
      (): PermissionError => ({ type: "repository_failure" }),
    ).andThen((result) => {
      if (this.store.isStoreClosed()) {
        this.cached = null;
        return err({ type: "repository_failure" as const });
      }
      return result;
    });
  }
  /**
   * Final rejection-safe boundary: sync throws from clock/Date conversion or
   * unexpected repository rejections become typed `repository_failure` and the
   * returned ResultAsync never rejects.
   */
  private invoke<T>(
    run: () => ResultAsync<T, PermissionError>,
  ): ResultAsync<T, PermissionError> {
    return ResultAsync.fromPromise(
      (async (): Promise<Result<T, PermissionError>> => {
        const started = Result.fromThrowable(
          run,
          (): PermissionError => ({ type: "repository_failure" }),
        )();
        if (started.isErr()) return err(started.error);
        // await ResultAsync → Result; keeps this boundary rejection-safe.
        return await started.value;
      })(),
      (): PermissionError => ({ type: "repository_failure" }),
    ).andThen((result) => result);
  }
  saveMany(r: readonly DurablePermissionGrantRecord[]) {
    return this.invoke(() => this.repo().andThen((x) => x.saveMany(r)));
  }
  list(p: string, n?: number) {
    return this.invoke(() => this.repo().andThen((x) => x.list(p, n)));
  }
  match(i: GrantIdentityEnvelope, n?: number) {
    return this.invoke(() => this.repo().andThen((x) => x.match(i, n)));
  }
  revoke(p: string, id: string) {
    return this.invoke(() => this.repo().andThen((x) => x.revoke(p, id)));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new SQLite-backed Runtime Store.
 *
 * The store is lazily initialized — no files are created until the first
 * repository operation.
 */
export function createSqliteRuntimeStore(
  options: SqliteRuntimeStoreOptions,
): SqliteRuntimeStore {
  return new SqliteRuntimeStore(options);
}
