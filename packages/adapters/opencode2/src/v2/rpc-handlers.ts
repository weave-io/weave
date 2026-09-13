import { ConfigPlanTaskReader } from "@weaveio/weave-config";
import { err, ok, type ResultAsync } from "neverthrow";
import {
  type PlanTaskNode,
  type PlanTaskSnapshotReader,
  selectActivePlanTask,
  selectNextPlanTask,
} from "@weaveio/weave-engine";
import type { WeaveRpc } from "../rpc.js";
import type { V2RpcHandlers as RpcHandlers } from "../sdk-types.js";
import type { OpenCode2CatalogController } from "./config-refresh.js";
import type { StartPlanError } from "./commands.js";
import { fromOpenCode2Promise } from "./errors.js";
import {
  buildOpenCode2Health,
  type OpenCode2RegistrationReadiness,
} from "./health.js";
import type { OpenCode2Context } from "./host-types.js";
import { listPlanNames } from "./plan-catalog.js";
import {
  flattenPlanTasks,
  type OpenCode2PlanSessionState,
} from "./plan-session-state.js";
import {
  validateSessionScope,
  type OpenCode2SessionScope,
} from "./session-scope.js";

export interface OpenCode2RpcDependencies {
  readonly location: string;
  readonly workspaceID?: string;
  readonly session: Pick<OpenCode2Context["session"], "get">;
  readonly catalog: OpenCode2CatalogController;
  readonly plans: OpenCode2PlanSessionState;
  readonly ownsAgent: (agent: string) => boolean;
  readonly reader?: PlanTaskSnapshotReader;
  readonly registration: () => OpenCode2RegistrationReadiness;
  readonly start?: (
    sessionID: string,
    planName: string,
  ) => ResultAsync<void, StartPlanError>;
}

type RpcScopeError = {
  readonly code: "session_unavailable" | "wrong_location";
  readonly message: string;
};

function resolveScope(
  dependencies: OpenCode2RpcDependencies,
  input: { sessionID: string; directory: string; workspaceID?: string },
): ResultAsync<OpenCode2SessionScope, RpcScopeError> {
  return fromOpenCode2Promise(
    () => dependencies.session.get({ sessionID: input.sessionID }),
    "session_unavailable",
    "Session unavailable",
  )
    .mapErr(
      (): RpcScopeError => ({
        code: "session_unavailable",
        message: "Session unavailable",
      }),
    )
    .andThen((session) => {
      const owned = validateSessionScope(
        input.sessionID,
        session,
        dependencies.location,
        dependencies.workspaceID,
      );
      const requested = validateSessionScope(
        input.sessionID,
        session,
        input.directory,
        input.workspaceID,
      );
      if (owned.isErr() || requested.isErr()) {
        return err({
          code: "wrong_location",
          message: "Session does not belong to this Location",
        } as const);
      }
      return ok(owned.value);
    });
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
      const scope = await resolveScope(dependencies, input);
      if (scope.isErr())
        return context.error(scope.error.code, scope.error.message, {
          code: scope.error.code,
        });
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
      const scope = await resolveScope(dependencies, input);
      if (scope.isErr())
        return context.error(scope.error.code, scope.error.message, {
          code: scope.error.code,
        });

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
    start: async (input, context) => {
      const scope = await resolveScope(dependencies, input);
      if (scope.isErr())
        return context.error(scope.error.code, scope.error.message, {
          code: scope.error.code,
        });
      const start = dependencies.start;
      if (start === undefined || !dependencies.registration().foregroundPlans)
        return context.error(
          "start_unavailable",
          "Weave start is unavailable",
          { code: "start_unavailable" },
        );
      const started = await start(input.sessionID, input.planName);
      if (started.isErr())
        return context.error(
          started.error.type === "WrongLocation"
            ? "wrong_location"
            : "start_unavailable",
          started.error.message,
          {
            code: started.error.type,
          },
        );
      return {
        scope: { sessionID: input.sessionID, scopeToken: input.scopeToken },
      };
    },
    plans: async (input, context) => {
      const scope = await resolveScope(dependencies, input);
      if (scope.isErr())
        return context.error(scope.error.code, scope.error.message, {
          code: scope.error.code,
        });
      const listed = await listPlanNames(scope.value.directory);
      if (listed.isErr() && listed.error.type === "Unreadable") {
        return context.error(
          "plan_catalog_unreadable",
          "Weave could not list plans",
          { code: "unreadable" },
        );
      }
      return {
        scope: { sessionID: input.sessionID, scopeToken: input.scopeToken },
        names: listed.isOk() ? [...listed.value] : [],
      };
    },
  };
}
