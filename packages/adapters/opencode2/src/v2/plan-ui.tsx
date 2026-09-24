import { ResultAsync } from "neverthrow";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { WeaveRpc } from "../rpc.js";
import type { V2TuiContext as Context } from "../sdk-types.js";
import {
  INVALID_PLAN_NAME_MESSAGE,
  PLAN_CATALOG_UNREADABLE_MESSAGE,
  parsePlanName,
} from "./plan-name.js";
import {
  PlanUiController,
  type PlanUiScope,
  type PlanUiState,
  taskDialogOptions,
} from "./plan-ui-state.js";

type StartCommandError = { readonly type: "CommandFailed" };
type PlanListFetch =
  | { readonly type: "listed"; readonly names: readonly string[] }
  | { readonly type: "unreadable" };

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
    return context.theme.text.feedback.success.base;
  if (state.type === "disconnected")
    return context.theme.text.feedback.error.base;
  if (state.type === "unsupported_host" || state.type === "unavailable")
    return context.theme.text.feedback.warning.base;
  if (state.type === "ready") return context.theme.text.feedback.info.base;
  return context.theme.text.muted;
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
  let startRequest: AbortController | undefined;
  let disposed = false;
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
        location: { directory: scope.directory },
      };
      const [status, plan] = await Promise.all([
        rpc.status(input, options),
        rpc.plan(input, options),
      ]);
      return { ...plan, refreshFailed: status.refresh === "failed" };
    },
    publish: setState,
  });

  const fetchPlanNames = async (
    scope: PlanUiScope,
    signal: AbortSignal,
  ): Promise<PlanListFetch> => {
    const listed = await ResultAsync.fromThrowable(
      () =>
        rpc.plans(
          {
            sessionID: scope.sessionID,
            directory: scope.directory,
            workspaceID: scope.workspaceID,
            scopeToken: "start",
          },
          {
            signal,
            location: { directory: scope.directory },
          },
        ),
      (): StartCommandError => ({ type: "CommandFailed" }),
    )();
    if (listed.isErr()) return { type: "unreadable" };
    const value = listed.value;
    if (
      value !== null &&
      typeof value === "object" &&
      "names" in value &&
      Array.isArray(value.names)
    ) {
      return { type: "listed", names: value.names };
    }
    return { type: "unreadable" };
  };

  const startPlan = async (input?: string): Promise<void> => {
    if (disposed || ownsDialog) return;
    const scope = sessionScope(props.context, props.sessionID);
    if (scope === undefined) {
      props.context.ui.toast.show({
        message: "Weave could not read the current session.",
        variant: "error",
      });
      return;
    }
    const parsed = parsePlanName(input ?? "");
    if (parsed.type === "invalid") {
      await props.context.ui.dialog.alert({
        title: "Weave: Start plan",
        message: INVALID_PLAN_NAME_MESSAGE,
      });
      return;
    }
    const request = new AbortController();
    startRequest = request;
    const current = () => {
      if (
        disposed ||
        request.signal.aborted ||
        props.sessionID !== scope.sessionID
      )
        return false;
      const latest = sessionScope(props.context, scope.sessionID);
      return (
        latest?.directory === scope.directory &&
        latest?.workspaceID === scope.workspaceID
      );
    };
    ownsDialog = true;
    try {
      let planName = parsed.type === "valid" ? parsed.name : undefined;
      if (planName === undefined) {
        const listed = await fetchPlanNames(scope, request.signal);
        if (!current()) return;
        if (listed.type === "unreadable") {
          await props.context.ui.dialog.alert({
            title: "Weave: Start plan",
            message: PLAN_CATALOG_UNREADABLE_MESSAGE,
          });
          return;
        }
        if (listed.names.length === 0) {
          await props.context.ui.dialog.alert({
            title: "Weave: Start plan",
            message: "No plans found under .weave/plans.",
          });
          return;
        }
        planName = await props.context.ui.dialog.select({
          title: "Start a Weave plan",
          placeholder: "Filter plans",
          options: listed.names.map((name) => ({ title: name, value: name })),
        });
        if (!current() || planName === undefined) return;
      }
      const confirmed = await props.context.ui.dialog.confirm({
        title: "Start plan",
        message: `Start plan "${planName}" with Tapestry in this session?`,
        label: { confirm: "Start", cancel: "Cancel" },
      });
      if (!current() || !confirmed) return;
      const selectedPlan = planName;
      const submitted = await ResultAsync.fromThrowable(
        () =>
          rpc.start(
            {
              sessionID: scope.sessionID,
              directory: scope.directory,
              workspaceID: scope.workspaceID,
              scopeToken: "start",
              planName: selectedPlan,
            },
            {
              signal: request.signal,
              location: { directory: scope.directory },
            },
          ),
        (): StartCommandError => ({ type: "CommandFailed" }),
      )();
      if (current() && submitted.isErr()) {
        props.context.ui.toast.show({
          message: "Weave could not start the selected plan.",
          variant: "error",
        });
      }
    } finally {
      if (startRequest === request) startRequest = undefined;
      ownsDialog = false;
    }
  };

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
        id: "weave.start",
        title: "Weave: Start plan",
        description: "Start explicit foreground work from a Weave plan",
        group: "Weave",
        bind: false,
        palette: true,
        slash: { name: "weave:start", arguments: true },
        run: startPlan,
      },
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
    startRequest?.abort();
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
    startRequest?.abort();
    void controller.load(props.sessionID);
  });
  onCleanup(() => {
    disposed = true;
    startRequest?.abort();
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
