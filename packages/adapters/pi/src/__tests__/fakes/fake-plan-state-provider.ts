import type {
  PlanStateProvider,
  PlanTaskSnapshot,
} from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";

/** In-memory PlanStateProvider fake for isolated adapter tests - no real filesystem. */
export class MutablePlanStateProvider implements PlanStateProvider {
  private snapshot: PlanTaskSnapshot | undefined;

  constructor(snapshot?: PlanTaskSnapshot) {
    this.snapshot = snapshot;
  }

  setSnapshot(snapshot: PlanTaskSnapshot | undefined): void {
    this.snapshot = snapshot;
  }

  readSnapshot(planName: string) {
    if (this.snapshot === undefined || this.snapshot.planName !== planName) {
      return errAsync({ type: "PlanMissing" as const, planName });
    }
    return okAsync(this.snapshot);
  }

  applyTransition() {
    return errAsync({
      type: "ProviderUnavailable" as const,
      cause: { message: "applyTransition not configured in fake" },
    });
  }

  planExists(planName: string) {
    return okAsync(this.snapshot?.planName === planName);
  }

  isPlanComplete(planName: string) {
    return this.snapshot?.planName === planName
      ? okAsync(this.snapshot.complete)
      : errAsync({ type: "PlanMissing" as const, planName });
  }
}

/** In-memory PlanStateProvider fake for legacy existence/completion tests. */
export class FakePlanStateProvider implements PlanStateProvider {
  constructor(
    private readonly existsMap: Record<string, boolean> = {},
    private readonly completeMap: Record<string, boolean> = {},
  ) {}

  readSnapshot(planName: string) {
    const exists = this.existsMap[planName] ?? false;
    if (!exists) return errAsync({ type: "PlanMissing" as const, planName });
    const complete = this.completeMap[planName] ?? false;
    return okAsync({
      planName,
      contentRevision: "fake-rev-1",
      format: "canonical" as const,
      parents: [
        {
          id: "1",
          title: complete ? "done" : "todo",
          state: complete ? ("completed" as const) : ("pending" as const),
          children: [],
        },
      ],
      totalParentCount: 1,
      complete,
    });
  }

  applyTransition() {
    return errAsync({
      type: "ProviderUnavailable" as const,
      cause: { message: "applyTransition not configured in fake" },
    });
  }

  planExists(planName: string) {
    const exists = this.existsMap[planName] ?? false;
    return okAsync(exists);
  }

  isPlanComplete(planName: string) {
    const complete = this.completeMap[planName] ?? false;
    return okAsync(complete);
  }
}
