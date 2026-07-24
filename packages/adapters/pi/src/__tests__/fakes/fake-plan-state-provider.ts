import type { PlanStateProvider } from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";

/** In-memory PlanStateProvider fake for isolated adapter tests - no real filesystem. */
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
