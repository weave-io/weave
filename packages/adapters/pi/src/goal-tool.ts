import { StringEnum } from "@earendil-works/pi-ai";
import type {
  PlanTaskSnapshot,
  SessionGoalController,
} from "@weaveio/weave-engine";
import { adjudicateSessionGoalCompletion } from "@weaveio/weave-engine";
import { ResultAsync } from "neverthrow";
import { Type } from "typebox";
import { persistGoalState } from "./goal-session.js";
import type {
  PiExtensionApi,
  PiSessionContext,
  PiToolRegistration,
  PiToolResult,
} from "./types.js";

export const WEAVE_GOAL_REPORT_TOOL_NAME = "weave_goal_report" as const;
const MAX_TASK_ID_LENGTH = 128;

type GoalToolApi = Pick<PiExtensionApi, "registerTool"> & {
  getActiveTools(): readonly string[];
  setActiveTools(names: readonly string[]): void;
  appendEntry(type: string, data: unknown): void;
};

export interface WeaveGoalReportToolDependencies {
  readonly pi: GoalToolApi;
  readonly controller: Pick<
    SessionGoalController,
    "current" | "isPursuing" | "achieve" | "block" | "serialize"
  >;
  /** Reads the authoritative plan snapshot through the workflow controller. */
  readonly readSnapshot: (
    planName: string,
  ) => ResultAsync<PlanTaskSnapshot, unknown>;
}

export type WeaveGoalReportToolRegistration = PiToolRegistration & {
  readonly executionMode: "sequential";
};

interface GoalReportParams {
  readonly status: "achieved" | "blocked";
  readonly evidence: string;
}

function result(
  text: string,
  details?: unknown,
): PiToolResult & { readonly terminate: true } {
  return {
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
    terminate: true,
  };
}

function persistAndSync(deps: WeaveGoalReportToolDependencies): void {
  persistGoalState(deps.pi, deps.controller);
  syncWeaveGoalReportToolAvailability(deps.pi, deps.controller);
}

function safeTaskId(taskId: string): string {
  const oneLine = taskId.replace(/[\r\n]/g, " ").trim();
  return oneLine.length > MAX_TASK_ID_LENGTH
    ? `${oneLine.slice(0, MAX_TASK_ID_LENGTH - 1)}…`
    : oneLine;
}

function readSnapshotSafely(
  deps: WeaveGoalReportToolDependencies,
  planName: string,
): ResultAsync<PlanTaskSnapshot, unknown> {
  return ResultAsync.fromPromise(
    Promise.resolve().then(() => deps.readSnapshot(planName)),
    (error) => error,
  ).andThen((snapshot) => snapshot);
}

/** Keep the private goal-report tool active only during an active goal. */
export function syncWeaveGoalReportToolAvailability(
  pi: Pick<GoalToolApi, "getActiveTools" | "setActiveTools">,
  controller: Pick<SessionGoalController, "isPursuing">,
): void {
  const activeTools = [...pi.getActiveTools()];
  const withoutGoalTool = activeTools.filter(
    (name) => name !== WEAVE_GOAL_REPORT_TOOL_NAME,
  );
  if (controller.isPursuing) {
    if (activeTools.includes(WEAVE_GOAL_REPORT_TOOL_NAME)) return;
    pi.setActiveTools([...activeTools, WEAVE_GOAL_REPORT_TOOL_NAME]);
    return;
  }
  if (withoutGoalTool.length !== activeTools.length) {
    pi.setActiveTools(withoutGoalTool);
  }
}

/** Build the private Pi reporting tool. Registration is owned by the caller. */
export function buildWeaveGoalReportToolRegistration(
  deps: WeaveGoalReportToolDependencies,
): WeaveGoalReportToolRegistration {
  return {
    name: WEAVE_GOAL_REPORT_TOOL_NAME,
    label: "Weave Goal Report",
    description:
      "Report whether the active session goal is achieved or blocked after checking concrete evidence.",
    parameters: Type.Object({
      status: StringEnum(["achieved", "blocked"] as const),
      evidence: Type.String({
        minLength: 1,
        description: "Concrete evidence or the exact blocker.",
      }),
    }),
    executionMode: "sequential",
    execute: async (
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: ((update: PiToolResult) => void) | undefined,
      _ctx: PiSessionContext,
    ) => {
      const params = rawParams as unknown as GoalReportParams;
      if (
        !deps.controller.isPursuing ||
        deps.controller.current === undefined
      ) {
        return result("No active goal can be reported.", {
          status: params.status,
        });
      }

      const evidence = params.evidence.trim();
      if (params.status === "blocked") {
        const blocked = deps.controller.block(evidence);
        if (blocked.isErr()) {
          return result("The active goal could not be blocked safely.");
        }
        persistAndSync(deps);
        return result("Goal blocked and paused.", { status: "blocked" });
      }

      const planName = deps.controller.current.planName;
      const snapshotResult = await readSnapshotSafely(deps, planName);
      if (snapshotResult.isErr()) {
        return result("Goal completion could not be verified safely.");
      }

      const verdictResult = adjudicateSessionGoalCompletion({
        snapshot: snapshotResult.value,
        reportedStatus: "achieved",
        evidence,
      });
      if (verdictResult.isErr()) {
        return result("Goal completion could not be verified safely.");
      }

      const verdict = verdictResult.value;
      if (verdict.kind === "incomplete") {
        const incomplete = deps.controller.achieve(evidence, false);
        if (incomplete.isErr() && incomplete.error.type === "PlanIncomplete") {
          persistAndSync(deps);
          return result(
            `Goal remains in progress: ${verdict.remainingLeafCount} incomplete leaf task(s); first incomplete task: ${safeTaskId(verdict.firstIncompleteTaskId)}.`,
          );
        }
        return result("Goal completion could not be recorded safely.");
      }
      if (verdict.kind !== "achieved") {
        return result("Goal completion could not be verified safely.");
      }

      const achieved = deps.controller.achieve(verdict.evidence, true);
      if (achieved.isErr()) {
        return result("Goal completion could not be recorded safely.");
      }
      persistAndSync(deps);
      return result("Goal achieved.", { status: "achieved" });
    },
  };
}

/** Register the private reporting tool with Pi. */
export function registerWeaveGoalReportTool(
  deps: WeaveGoalReportToolDependencies,
): void {
  deps.pi.registerTool(buildWeaveGoalReportToolRegistration(deps));
  syncWeaveGoalReportToolAvailability(deps.pi, deps.controller);
}
