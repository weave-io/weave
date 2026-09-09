import type { ResultAsync } from "neverthrow";

export type PlanTaskState = "pending" | "in_progress" | "completed";
export type PlanTaskFormat = "canonical" | "legacy";

export interface PlanTaskNode {
  readonly id: string;
  readonly title: string;
  readonly state: PlanTaskState;
  readonly children: readonly PlanTaskNode[];
}

/** Immutable, display-only task state derived from one plan file. */
export interface PlanTaskSnapshot {
  readonly planName: string;
  readonly contentRevision: string;
  readonly format: PlanTaskFormat;
  readonly parents: readonly PlanTaskNode[];
  readonly totalParentCount: number;
  readonly totalTaskCount: number;
  readonly completedTaskCount: number;
  readonly complete: boolean;
}

export type PlanTaskSnapshotError =
  | {
      readonly type: "InvalidPlanName";
      readonly planName: string;
      readonly reason: string;
    }
  | { readonly type: "PlanMissing"; readonly planName: string }
  | {
      readonly type: "PlanUnreadable";
      readonly planName: string;
      readonly reason: string;
    }
  | {
      readonly type: "PlanMalformed";
      readonly planName: string;
      readonly reason: string;
      readonly line?: number;
    }
  | {
      readonly type: "PlanLimitExceeded";
      readonly planName: string;
      readonly limit: "bytes" | "tasks" | "title";
      readonly actual: number;
      readonly maximum: number;
    }
  | {
      readonly type: "PlanPathUnsafe";
      readonly planName: string;
      readonly reason: string;
    };

/** Adapter/config-provided read boundary. It grants no mutation authority. */
export interface PlanTaskSnapshotReader {
  readSnapshot(
    planName: string,
  ): ResultAsync<PlanTaskSnapshot, PlanTaskSnapshotError>;
}
