import { createEffect, createSignal, onCleanup } from "solid-js";
import { WeaveRpc } from "../rpc.js";
import type { V2TuiContext as Context } from "../sdk-types.js";
import {
  PlanUiController,
  type PlanUiScope,
  type PlanUiState,
  taskDialogOptions,
} from "./plan-ui-state.js";

const PLAN_REFRESH_INTERVAL_MS = 5_000;

function sessionScope(
  context: Context,
  sessionID: string,
): PlanUiScope | undefined {
  const session = context.data.session.get(sessionID);
  if (session === undefined) return undefined;
  return {
    sessionID,
    directory: session.location.directory,
    workspaceID: session.location.workspaceID,
  };
}

function summary(state: PlanUiState, narrow: boolean): readonly string[] {
  if (state.type === "unsupported_host")
    return ["Weave plan: Unsupported OpenCode version"];
  if (state.type === "loading") return ["Weave plan: Loading"];
  if (state.type === "no_plan") {
    const warning = state.refreshFailed
      ? ["Weave config refresh failed; using last valid config"]
      : [];
    return ["Weave plan: No plan selected", ...warning];
  }
  if (state.type === "unavailable") return ["Weave plan: Unavailable"];
  if (state.type === "disconnected") return ["Weave plan: Disconnected"];
  const first = narrow
    ? `Plan ${state.plan.name}`
    : `Plan ${state.plan.name}  ${state.plan.completed}/${state.plan.total} done`;
  const progress = narrow
    ? [`Done ${state.plan.completed}/${state.plan.total}`]
    : [];
  const current =
    state.type === "completed"
      ? "Plan complete"
      : (state.plan.current?.title ?? "None");
  const warning = state.refreshFailed
    ? ["Weave config refresh failed; using last valid config"]
    : [];
  return [
    first,
    ...progress,
    `Current ${current}`,
    `Next ${state.plan.next?.title ?? "None"}`,
    ...warning,
  ];
}

function stateColor(context: Context, state: PlanUiState) {
  if (state.type === "completed")
    return context.theme.text.feedback.success.default;
  if (state.type === "disconnected")
    return context.theme.text.feedback.error.default;
  if (state.type === "unsupported_host" || state.type === "unavailable")
    return context.theme.text.feedback.warning.default;
  if (state.type === "ready") return context.theme.text.status.running;
  return context.theme.text.subdued;
}

export interface PlanPanelProps {
  readonly context: Context;
  readonly sessionID: string;
}

export function PlanPanel(props: PlanPanelProps) {
  const [state, setState] = createSignal<PlanUiState>({ type: "loading" });
  const [width, setWidth] = createSignal(0);
  let root: { width: number } | undefined;
  let ownsDialog = false;
  const rpc = props.context.client.rpc(WeaveRpc);
  const controller = new PlanUiController({
    supported: true,
    getSession: (sessionID) => sessionScope(props.context, sessionID),
    syncSession: (sessionID) => props.context.data.session.sync(sessionID),
    fetchPlan: async (scope, scopeToken, signal) => {
      const input = {
        sessionID: scope.sessionID,
        directory: scope.directory,
        workspaceID: scope.workspaceID,
        scopeToken,
      };
      const options = {
        signal,
        location: { directory: scope.directory, workspace: scope.workspaceID },
      };
      const [status, plan] = await Promise.all([
        rpc.status(input, options),
        rpc.plan(input, options),
      ]);
      return { ...plan, refreshFailed: status.refresh === "failed" };
    },
    publish: setState,
  });

  const openTasks = async (): Promise<void> => {
    const current = state();
    if (current.type !== "ready" && current.type !== "completed") return;
    const options = taskDialogOptions(current.plan);
    if (options.length === 0) {
      ownsDialog = true;
      try {
        await props.context.ui.dialog.alert({
          title: "Weave: Plan tasks (read-only)",
          message: "This plan has no tasks.",
        });
      } finally {
        ownsDialog = false;
      }
      return;
    }
    ownsDialog = true;
    try {
      const pending = props.context.ui.dialog.select({
        title: "Weave: Plan tasks (read-only)",
        placeholder: "Filter tasks",
        current: current.plan.current?.id,
        options,
      });
      props.context.ui.dialog.set({ size: "large", centered: true });
      await pending;
    } finally {
      ownsDialog = false;
    }
  };

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "weave.plan.tasks",
        title: "Weave: Plan tasks",
        description: "Browse the selected plan without changing it",
        group: "Weave",
        bind: false,
        palette: true,
        enabled: () => state().type === "ready" || state().type === "completed",
        run: openTasks,
      },
    ],
  }));

  const refresh = () => controller.invalidate();
  const invalidate = () => {
    if (ownsDialog) props.context.ui.dialog.clear();
    refresh();
  };
  const invalidateSession = (event: {
    readonly data: { readonly sessionID: string };
  }) => {
    if (event.data.sessionID === props.sessionID) invalidate();
  };
  const stops = [
    props.context.data.on("server.connected", invalidate),
    props.context.data.on("session.moved", invalidateSession),
    props.context.data.on("session.deleted", invalidateSession),
    props.context.data.on("session.execution.succeeded", invalidateSession),
    props.context.data.on("session.execution.failed", invalidateSession),
    props.context.data.on("session.execution.interrupted", invalidateSession),
    rpc.events.on("plan.changed", (event) => {
      if (event.data.sessionID === props.sessionID) invalidate();
    }),
  ];
  const refreshTimer = setInterval(refresh, PLAN_REFRESH_INTERVAL_MS);

  createEffect(() => {
    void controller.load(props.sessionID);
  });
  onCleanup(() => {
    if (ownsDialog) props.context.ui.dialog.clear();
    controller.dispose();
    clearInterval(refreshTimer);
    for (const stop of stops) stop();
  });

  return (
    <box
      ref={(value) => {
        root = value;
      }}
      width="100%"
      flexDirection="column"
      onSizeChange={() => setWidth(root?.width ?? 0)}
    >
      {summary(state(), width() < 32).map((line) => (
        <text
          width="100%"
          height={1}
          wrapMode="none"
          truncate
          fg={stateColor(props.context, state())}
        >
          {line}
        </text>
      ))}
    </box>
  );
}
