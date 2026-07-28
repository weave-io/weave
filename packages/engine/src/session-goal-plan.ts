import { ok, type Result } from "neverthrow";
import type {
  PlanTaskNode,
  PlanTaskSnapshot,
  PlanTaskState,
} from "./plan-state-provider.js";
import type { SessionGoalError } from "./session-goal.js";

/** Maximum number of lines emitted by {@link renderGoalPlanBlock}. */
export const MAX_GOAL_PLAN_LINES = 100;

export type SessionGoalReportedStatus = "achieved" | "blocked";

export type SessionGoalVerdict =
  | { readonly kind: "achieved"; readonly evidence: string }
  | {
      readonly kind: "incomplete";
      readonly remainingLeafCount: number;
      readonly firstIncompleteTaskId: string;
    }
  | { readonly kind: "blocked"; readonly reason: string };

export interface AdjudicateSessionGoalCompletionInput {
  readonly snapshot: PlanTaskSnapshot;
  readonly reportedStatus: SessionGoalReportedStatus;
  readonly evidence: string;
}

function marker(state: PlanTaskState): string {
  if (state === "completed") return "[x]";
  if (state === "in_progress") return "[~]";
  return "[ ]";
}

function leafNodes(parents: readonly PlanTaskNode[]): PlanTaskNode[] {
  const leaves: PlanTaskNode[] = [];
  for (const parent of parents) {
    if (parent.children.length === 0) {
      leaves.push(parent);
      continue;
    }
    leaves.push(...parent.children);
  }
  return leaves;
}

/** Count unfinished leaves, treating childless parents as leaves. */
export function countIncompleteLeaves(
  parents: readonly PlanTaskNode[],
): number {
  return leafNodes(parents).filter((leaf) => leaf.state !== "completed").length;
}

/**
 * Adjudicate a model's completion report against the authoritative plan
 * snapshot. A model cannot certify an incomplete plan as achieved.
 */
export function adjudicateSessionGoalCompletion({
  snapshot,
  reportedStatus,
  evidence,
}: AdjudicateSessionGoalCompletionInput): Result<
  SessionGoalVerdict,
  SessionGoalError
> {
  if (reportedStatus === "blocked") {
    return ok({ kind: "blocked", reason: evidence.trim() });
  }

  const trimmedEvidence = evidence.trim();
  if (snapshot.complete) {
    return ok({ kind: "achieved", evidence: trimmedEvidence });
  }

  const incompleteLeaves = leafNodes(snapshot.parents).filter(
    (leaf) => leaf.state !== "completed",
  );
  const firstIncomplete = incompleteLeaves[0];
  // A false `complete` flag with no incomplete leaf is malformed upstream
  // state. Keep the bridge total without inventing a task identifier.
  if (firstIncomplete === undefined) {
    return ok({
      kind: "incomplete",
      remainingLeafCount: 0,
      firstIncompleteTaskId: "",
    });
  }
  return ok({
    kind: "incomplete",
    remainingLeafCount: incompleteLeaves.length,
    firstIncompleteTaskId: firstIncomplete.id,
  });
}

function safeLabel(value: string): string {
  const normalized = value.trim().replace(/[\\/]+/g, "/");
  const segments = normalized
    .split("/")
    .filter((segment) => segment.length > 0);
  return (segments.at(-1) ?? "plan").replace(/[\r\n]+/g, " ");
}

function safeTitle(value: string): string {
  return value.trim().replace(/[\r\n]+/g, " ");
}

function renderTaskNode(node: PlanTaskNode, indent: string): string[] {
  const lines = [
    `${indent}- ${marker(node.state)} ${node.id}. ${safeTitle(node.title)}`,
  ];
  for (const child of node.children) {
    lines.push(...renderTaskNode(child, `${indent}  `));
  }
  return lines;
}

/**
 * Render a bounded, harness-neutral plan prompt block. The block uses the
 * same plan header, tree shape, and checkbox markers as the Pi plan renderer.
 */
export function renderGoalPlanBlock({
  planName,
  snapshot,
}: {
  readonly planName: string;
  readonly snapshot: PlanTaskSnapshot;
}): string {
  const header = `Plan "${safeLabel(planName)}" (${snapshot.complete ? "complete" : "in progress"}, ${snapshot.totalParentCount} task${snapshot.totalParentCount === 1 ? "" : "s"}):`;
  const lines = [header];
  if (snapshot.parents.length === 0) {
    lines.push("(no tasks)");
  } else {
    for (const parent of snapshot.parents) {
      lines.push(...renderTaskNode(parent, ""));
    }
  }

  if (lines.length > MAX_GOAL_PLAN_LINES) {
    const hiddenCount = lines.length - (MAX_GOAL_PLAN_LINES - 1);
    lines.length = MAX_GOAL_PLAN_LINES - 1;
    lines.push(`...${hiddenCount} more tasks`);
  }
  return `<plan>\n${lines.join("\n")}\n</plan>`;
}
