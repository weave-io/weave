import type { PlanTaskNode, PlanTaskSnapshot } from "@weaveio/weave-engine";
import {
  selectActivePlanTask,
  selectNextPlanTask,
} from "@weaveio/weave-engine";
import { okAsync, type ResultAsync } from "neverthrow";
import { fromOpenCode2Promise, type OpenCode2Error } from "./errors.js";
import type { OpenCode2Context } from "./host-types.js";

export interface StoredPlanSelection {
  readonly version: 1;
  readonly sessionID: string;
  readonly directory: string;
  readonly workspaceID?: string;
  readonly planName: string;
  readonly revision: string;
  readonly completed: number;
  readonly total: number;
  readonly currentTitle?: string;
  readonly nextTitle?: string;
}

function selectionKey(sessionID: string): string {
  return `plan/${sessionID}`;
}

function isStoredSelection(value: unknown): value is StoredPlanSelection {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const item = value as Partial<StoredPlanSelection>;
  return (
    item.version === 1 &&
    typeof item.sessionID === "string" &&
    typeof item.directory === "string" &&
    typeof item.planName === "string" &&
    typeof item.revision === "string" &&
    typeof item.completed === "number" &&
    typeof item.total === "number"
  );
}

export function flattenPlanTasks(
  snapshot: PlanTaskSnapshot,
): Array<PlanTaskNode & { depth: 0 | 1 }> {
  const tasks: Array<PlanTaskNode & { depth: 0 | 1 }> = [];
  for (const parent of snapshot.parents) {
    tasks.push({ ...parent, depth: 0 });
    for (const child of parent.children) tasks.push({ ...child, depth: 1 });
  }
  return tasks;
}

export function selectionFromSnapshot(
  sessionID: string,
  directory: string,
  workspaceID: string | undefined,
  snapshot: PlanTaskSnapshot,
): StoredPlanSelection {
  const active = selectActivePlanTask(snapshot).match(
    (task) => task,
    () => undefined,
  );
  const next = selectNextPlanTask(snapshot);
  return {
    version: 1,
    sessionID,
    directory,
    workspaceID,
    planName: snapshot.planName,
    revision: snapshot.contentRevision,
    completed: snapshot.completedTaskCount,
    total: snapshot.totalTaskCount,
    currentTitle: active?.taskTitle,
    nextTitle: next?.taskTitle,
  };
}

export class OpenCode2PlanSessionState {
  constructor(
    private readonly storage: Pick<
      OpenCode2Context["storage"],
      "get" | "set" | "remove"
    >,
  ) {}

  get(
    sessionID: string,
  ): ResultAsync<StoredPlanSelection | undefined, OpenCode2Error> {
    return fromOpenCode2Promise(
      () => this.storage.get(selectionKey(sessionID)),
      "plan_unavailable",
      "selected plan state could not be read",
    ).andThen((value) => {
      if (value === undefined) return okAsync(undefined);
      if (!isStoredSelection(value)) {
        return this.clear(sessionID).map(() => undefined);
      }
      return okAsync(value);
    });
  }

  set(selection: StoredPlanSelection): ResultAsync<void, OpenCode2Error> {
    const stored = {
      version: selection.version,
      sessionID: selection.sessionID,
      directory: selection.directory,
      ...(selection.workspaceID === undefined
        ? {}
        : { workspaceID: selection.workspaceID }),
      planName: selection.planName,
      revision: selection.revision,
      completed: selection.completed,
      total: selection.total,
      ...(selection.currentTitle === undefined
        ? {}
        : { currentTitle: selection.currentTitle }),
      ...(selection.nextTitle === undefined
        ? {}
        : { nextTitle: selection.nextTitle }),
    };
    return fromOpenCode2Promise(
      () => this.storage.set(selectionKey(selection.sessionID), stored),
      "plan_unavailable",
      "selected plan state could not be stored",
    );
  }

  clear(sessionID: string): ResultAsync<void, OpenCode2Error> {
    return fromOpenCode2Promise(
      () => this.storage.remove(selectionKey(sessionID)),
      "plan_unavailable",
      "selected plan state could not be cleared",
    );
  }
}
