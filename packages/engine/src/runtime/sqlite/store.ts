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

import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { Kysely } from "kysely";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";

import { logger } from "../../logger.js";

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
  RuntimeJournalEntry,
  RuntimeJournalEntryId,
  SessionSnapshot,
  SessionSnapshotId,
  StepAttemptRecord,
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
import { BunSqliteDialect } from "./kysely-bun-sqlite.js";
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
    leaseId: createExecutionLeaseId(row.lease_id),
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
          // Find the last index of the artifact with the given id
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
          const updatedArtifacts = artifacts.map((a, i) =>
            i === artifactIndex ? { ...a, approvalState } : a,
          );
          return this.db
            .updateTable("workflow_instances")
            .set({
              artifacts_json: JSON.stringify(updatedArtifacts),
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
  }
}

// ---------------------------------------------------------------------------
// SqliteRuntimeStore
// ---------------------------------------------------------------------------

/**
 * Options for creating a SqliteRuntimeStore.
 */
export interface SqliteRuntimeStoreOptions {
  /** Absolute path to the `weave.db` file. */
  readonly dbPath: string;
  /** Whether journal write failures roll back the unit of work. Default: false. */
  readonly strictJournal?: boolean;
  /** Clock source for lease expiry checks. Default: `() => new Date()`. */
  readonly clock?: () => Date;
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
  private initializingPromise: Promise<Result<void, RuntimeStoreError>> | null =
    null;
  private readonly clock: () => Date;
  private _projectSalt: string | null = null;

  readonly instances: WorkflowInstanceRepository;
  readonly leases: ExecutionLeaseRepository;
  readonly snapshots: SessionSnapshotRepository;
  readonly journal: RuntimeJournalRepository;

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

    // Repositories are lazy — they call ensureInitialized() on first use
    this.instances = new LazyWorkflowInstanceRepository(this);
    this.leases = new LazyExecutionLeaseRepository(this);
    this.snapshots = new LazySessionSnapshotRepository(this);
    this.journal = new LazyRuntimeJournalRepository(this);
  }

  /**
   * Ensure the runtime directory and DB are created and migrations applied.
   * Idempotent — safe to call multiple times. Concurrent callers share the
   * same in-flight initialization promise so initialization only runs once.
   */
  ensureInitialized(): ResultAsync<Kysely<WeaveDatabase>, RuntimeStoreError> {
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
          // After successful initialization, db is guaranteed to be set
          return ok(this.db as Kysely<WeaveDatabase>);
        },
      ),
    );
  }

  /**
   * Internal initialization logic. On any failure, closes the DB handle
   * (if open) and resets all state fields before returning the error.
   */
  private async _doInitialize(): Promise<Result<void, RuntimeStoreError>> {
    const dir = dirname(this.options.dbPath);

    // Create runtime directory using node:fs/promises
    const mkdirResult = await ResultAsync.fromPromise(
      fs.mkdir(dir, { recursive: true }),
      (cause) =>
        initializationError(
          `Failed to create runtime directory: ${dir}`,
          cause,
        ),
    );
    if (mkdirResult.isErr()) {
      this.initializingPromise = null;
      return err(mkdirResult.error);
    }

    // Apply restrictive permissions to the directory (best-effort)
    await fs.chmod(dir, 0o700).catch((cause) => {
      log.warn(
        { path: dir, mode: 0o700, cause },
        "Failed to tighten runtime directory permissions",
      );
    });

    // Create Kysely instance with BunSqliteDialect
    const dialect = new BunSqliteDialect(this.options.dbPath);
    const db = new Kysely<WeaveDatabase>({ dialect });
    this.db = db;

    // Run migrations using the raw bun:sqlite Database
    const rawDb = dialect.getDatabase();
    const migrationResult = runMigrations(rawDb);
    if (migrationResult.isErr()) {
      await db.destroy().catch(() => undefined);
      this.db = null;
      this.initialized = false;
      this._projectSalt = null;
      this.initializingPromise = null;
      return err(migrationResult.error);
    }

    // Initialize or read the project salt from runtime_metadata
    try {
      const saltRow = rawDb
        .prepare(
          "SELECT value FROM runtime_metadata WHERE key = 'project_salt'",
        )
        .get() as { value: string } | null;

      if (saltRow) {
        this._projectSalt = saltRow.value;
      } else {
        const newSalt = createProjectSalt();
        rawDb
          .prepare(
            "INSERT INTO runtime_metadata (key, value) VALUES ('project_salt', ?)",
          )
          .run(newSalt);
        this._projectSalt = newSalt;
      }
    } catch (cause) {
      await db.destroy().catch(() => undefined);
      this.db = null;
      this.initialized = false;
      this._projectSalt = null;
      this.initializingPromise = null;
      return err(
        initializationError("Failed to initialize project salt", cause),
      );
    }

    // Apply restrictive permissions to the DB file (best-effort)
    await fs.chmod(this.options.dbPath, 0o600).catch((cause) => {
      log.warn(
        { path: this.options.dbPath, mode: 0o600, cause },
        "Failed to tighten runtime DB permissions",
      );
    });
    await fs.chmod(`${this.options.dbPath}-wal`, 0o600).catch((cause) => {
      log.warn(
        { path: `${this.options.dbPath}-wal`, mode: 0o600, cause },
        "Failed to tighten runtime WAL permissions",
      );
    });
    await fs.chmod(`${this.options.dbPath}-shm`, 0o600).catch((cause) => {
      log.warn(
        { path: `${this.options.dbPath}-shm`, mode: 0o600, cause },
        "Failed to tighten runtime SHM permissions",
      );
    });

    this.initialized = true;
    this.initializingPromise = null;
    log.info(
      { dbPath: this.options.dbPath, schemaVersion: CURRENT_SCHEMA_VERSION },
      "Runtime store initialized",
    );
    return ok(undefined);
  }

  transaction<T>(
    callback: TransactionCallback<T>,
  ): ResultAsync<T, RuntimeStoreError> {
    return this.ensureInitialized().andThen((db) => {
      return ResultAsync.fromPromise(
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
      );
    });
  }

  close(): ResultAsync<void, RuntimeStoreError> {
    if (!this.db) {
      return okAsync(undefined);
    }
    return ResultAsync.fromPromise(this.db.destroy(), (cause) =>
      queryError("Failed to close Runtime Store", cause),
    ).map(() => {
      this.db = null;
      this.initialized = false;
      return undefined;
    });
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
  ): ResultAsync<WorkflowInstance, RuntimeStoreError> {
    return this.repo().andThen((r) =>
      r.updateArtifactApproval(id, artifactId, approvalState),
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
