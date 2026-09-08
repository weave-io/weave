import type { RpcHandlers } from "@opencode-ai/plugin/promise/rpc";
import { ConfigPlanTaskReader } from "@weaveio/weave-config";
import {
  type PlanTaskNode,
  type PlanTaskSnapshotReader,
  selectActivePlanTask,
  selectNextPlanTask,
} from "@weaveio/weave-engine";
import type { WeaveRpc } from "../rpc.js";
import type { OpenCode2CatalogController } from "./config-refresh.js";
import { fromOpenCode2Promise } from "./errors.js";
import {
  buildOpenCode2Health,
  type OpenCode2RegistrationReadiness,
} from "./health.js";
import type { OpenCode2Context } from "./host-types.js";
import {
  flattenPlanTasks,
  type OpenCode2PlanSessionState,
} from "./plan-session-state.js";
import { validateSessionScope } from "./session-scope.js";

export interface OpenCode2RpcDependencies {
  readonly location: string;
  readonly workspaceID?: string;
  readonly session: Pick<OpenCode2Context["session"], "get">;
  readonly catalog: OpenCode2CatalogController;
  readonly plans: OpenCode2PlanSessionState;
  readonly ownsAgent: (agent: string) => boolean;
  readonly reader?: PlanTaskSnapshotReader;
  readonly registration: () => OpenCode2RegistrationReadiness;
}

function taskOutput(
  task: PlanTaskNode & { depth?: 0 | 1 },
  depth = task.depth ?? 0,
) {
  return { id: task.id, title: task.title, state: task.state, depth } as const;
}

export function createOpenCode2RpcHandlers(
  dependencies: OpenCode2RpcDependencies,
): RpcHandlers<typeof WeaveRpc> {
  const reader =
    dependencies.reader ?? new ConfigPlanTaskReader(dependencies.location);
  return {
    status: async (input, context) => {
      const session = await fromOpenCode2Promise(
        () => dependencies.session.get({ sessionID: input.sessionID }),
        "session_unavailable",
        "session could not be read",
      );
      if (session.isErr())
        return context.error("session_unavailable", "Session unavailable", {
          code: session.error.code,
        });
      const scope = validateSessionScope(
        input.sessionID,
        session.value,
        dependencies.location,
        dependencies.workspaceID,
      );
      const requestedScope = validateSessionScope(
        input.sessionID,
        session.value,
        input.directory,
        input.workspaceID,
      );
      if (scope.isErr() || requestedScope.isErr()) {
        return context.error(
          "wrong_location",
          "Session does not belong to this Location",
          { code: "wrong_location" },
        );
      }
      const health = buildOpenCode2Health(
        dependencies.catalog.catalog(),
        dependencies.catalog.status(),
        new Set(
          [...(dependencies.catalog.catalog()?.agents.keys() ?? [])].filter(
            dependencies.ownsAgent,
          ),
        ),
        dependencies.registration(),
      );
      return {
        scope: { sessionID: input.sessionID, scopeToken: input.scopeToken },
        ...(health.catalogRevision === undefined
          ? {}
          : { catalogRevision: health.catalogRevision }),
        refresh: health.refresh,
        agentCount: health.agentCount,
        issues: [...health.issues],
        readiness: health.readiness,
      };
    },
    plan: async (input, context) => {
      const session = await fromOpenCode2Promise(
        () => dependencies.session.get({ sessionID: input.sessionID }),
        "session_unavailable",
        "session could not be read",
      );
      if (session.isErr())
        return context.error("session_unavailable", "Session unavailable", {
          code: session.error.code,
        });
      const scope = validateSessionScope(
        input.sessionID,
        session.value,
        dependencies.location,
        dependencies.workspaceID,
      );
      const requestedScope = validateSessionScope(
        input.sessionID,
        session.value,
        input.directory,
        input.workspaceID,
      );
      if (scope.isErr() || requestedScope.isErr()) {
        return context.error(
          "wrong_location",
          "Session does not belong to this Location",
          { code: "wrong_location" },
        );
      }

      const selected = await dependencies.plans.get(input.sessionID);
      if (selected.isErr())
        return context.error(
          "plan_unavailable",
          "Selected plan state unavailable",
          { code: selected.error.code },
        );
      if (selected.value === undefined) {
        return {
          scope: { sessionID: input.sessionID, scopeToken: input.scopeToken },
          state: "no_plan",
        };
      }
      if (
        selected.value.directory !== scope.value.directory ||
        selected.value.workspaceID !== scope.value.workspaceID
      ) {
        await dependencies.plans.clear(input.sessionID);
        return context.error(
          "wrong_location",
          "Selected plan belongs to another Location",
          { code: "wrong_location" },
        );
      }

      const snapshot = await reader.readSnapshot(selected.value.planName);
      if (snapshot.isErr()) {
        await dependencies.plans.clear(input.sessionID);
        return context.error(
          "plan_unavailable",
          "Selected plan is unavailable",
          { code: snapshot.error.type },
        );
      }
      const active = selectActivePlanTask(snapshot.value).match(
        (task) => task,
        () => undefined,
      );
      const next = selectNextPlanTask(snapshot.value);
      const tasks = flattenPlanTasks(snapshot.value).map((task) =>
        taskOutput(task),
      );
      return {
        scope: { sessionID: input.sessionID, scopeToken: input.scopeToken },
        state: snapshot.value.complete ? "completed" : "ready",
        plan: {
          name: snapshot.value.planName,
          revision: snapshot.value.contentRevision,
          completed: snapshot.value.completedTaskCount,
          total: snapshot.value.totalTaskCount,
          ...(active === undefined
            ? {}
            : {
                current: {
                  id: active.taskId,
                  title: active.taskTitle,
                  state: active.taskState,
                  depth: active.isChild ? 1 : 0,
                },
              }),
          ...(next === undefined
            ? {}
            : {
                next: {
                  id: next.taskId,
                  title: next.taskTitle,
                  state: next.taskState,
                  depth: next.isChild ? 1 : 0,
                },
              }),
          tasks,
        },
      };
    },
  };
}
