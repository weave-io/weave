import { ResultAsync } from "neverthrow";

export interface PlanUiScope {
  readonly sessionID: string;
  readonly directory: string;
  readonly workspaceID?: string;
}

export interface PlanUiTask {
  readonly id: string;
  readonly title: string;
  readonly state: "pending" | "in_progress" | "completed";
  readonly depth: 0 | 1;
}

export interface PlanUiDisplay {
  readonly name: string;
  readonly revision: string;
  readonly completed: number;
  readonly total: number;
  readonly current?: PlanUiTask;
  readonly next?: PlanUiTask;
  readonly tasks: readonly PlanUiTask[];
}

export type PlanUiState =
  | { readonly type: "unsupported_host" }
  | { readonly type: "loading"; readonly scope?: PlanUiScope }
  | {
      readonly type: "no_plan";
      readonly scope: PlanUiScope;
      readonly refreshFailed: boolean;
    }
  | {
      readonly type: "ready";
      readonly scope: PlanUiScope;
      readonly plan: PlanUiDisplay;
      readonly refreshFailed: boolean;
    }
  | {
      readonly type: "completed";
      readonly scope: PlanUiScope;
      readonly plan: PlanUiDisplay;
      readonly refreshFailed: boolean;
    }
  | { readonly type: "unavailable"; readonly scope?: PlanUiScope }
  | { readonly type: "disconnected"; readonly scope?: PlanUiScope };

export interface PlanUiRpcResponse {
  readonly scope: { readonly sessionID: string; readonly scopeToken: string };
  readonly state: "no_plan" | "ready" | "completed";
  readonly plan?: PlanUiDisplay;
  readonly refreshFailed?: boolean;
}

export interface PlanUiDependencies {
  readonly supported: boolean;
  readonly getSession: (sessionID: string) => PlanUiScope | undefined;
  readonly syncSession: (sessionID: string) => Promise<void>;
  readonly fetchPlan: (
    scope: PlanUiScope,
    scopeToken: string,
    signal: AbortSignal,
  ) => Promise<PlanUiRpcResponse>;
  readonly publish: (state: PlanUiState) => void;
}

function sameScope(left: PlanUiScope | undefined, right: PlanUiScope): boolean {
  return (
    left?.sessionID === right.sessionID &&
    left.directory === right.directory &&
    left.workspaceID === right.workspaceID
  );
}

function transportState(
  scope: PlanUiScope | undefined,
  error: unknown,
): PlanUiState {
  if (error instanceof Error && error.name === "AbortError")
    return { type: "loading", scope };
  if (error instanceof Error && error.message.startsWith("rpc."))
    return { type: "unavailable", scope };
  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    typeof error.type === "string"
  ) {
    return { type: "unavailable", scope };
  }
  return { type: "disconnected", scope };
}

/** Owns request cancellation and rejects stale session/location responses. */
export class PlanUiController {
  private generation = 0;
  private activeScope?: PlanUiScope;
  private abort?: AbortController;
  private disposed = false;

  constructor(private readonly dependencies: PlanUiDependencies) {}

  load(sessionID: string): Promise<void> {
    const generation = ++this.generation;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.activeScope = undefined;
    if (!this.dependencies.supported) {
      this.dependencies.publish({ type: "unsupported_host" });
      return Promise.resolve();
    }
    this.dependencies.publish({ type: "loading" });
    return this.resolveAndFetch(sessionID, generation, abort);
  }

  invalidate(): void {
    if (this.activeScope !== undefined)
      void this.load(this.activeScope.sessionID);
  }

  scope(): PlanUiScope | undefined {
    return this.activeScope;
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.abort?.abort();
    this.activeScope = undefined;
  }

  private async resolveAndFetch(
    sessionID: string,
    generation: number,
    abort: AbortController,
  ): Promise<void> {
    let scope = this.dependencies.getSession(sessionID);
    if (scope === undefined) {
      const synced = await ResultAsync.fromThrowable(
        () => this.dependencies.syncSession(sessionID),
        (error) => error,
      )();
      if (synced.isErr()) {
        this.publishIfCurrent(generation, { type: "disconnected" });
        return;
      }
      scope = this.dependencies.getSession(sessionID);
    }
    if (scope === undefined) {
      this.publishIfCurrent(generation, { type: "unavailable" });
      return;
    }
    this.activeScope = scope;
    this.dependencies.publish({ type: "loading", scope });
    const token = `${generation}`;
    const response = await ResultAsync.fromThrowable(
      () => this.dependencies.fetchPlan(scope, token, abort.signal),
      (error) => error,
    )();
    if (response.isErr()) {
      if (abort.signal.aborted) return;
      this.publishIfCurrent(generation, transportState(scope, response.error));
      return;
    }
    if (!this.isCurrent(generation, scope)) return;
    if (
      response.value.scope.sessionID !== scope.sessionID ||
      response.value.scope.scopeToken !== token
    )
      return;
    if (response.value.state === "no_plan") {
      this.dependencies.publish({
        type: "no_plan",
        scope,
        refreshFailed: response.value.refreshFailed === true,
      });
      return;
    }
    if (response.value.plan === undefined) {
      this.dependencies.publish({ type: "unavailable", scope });
      return;
    }
    this.dependencies.publish({
      type: response.value.state,
      scope,
      plan: response.value.plan,
      refreshFailed: response.value.refreshFailed === true,
    });
  }

  private isCurrent(generation: number, scope: PlanUiScope): boolean {
    return (
      !this.disposed &&
      generation === this.generation &&
      sameScope(this.activeScope, scope)
    );
  }

  private publishIfCurrent(generation: number, state: PlanUiState): void {
    if (this.disposed || generation !== this.generation) return;
    this.dependencies.publish(state);
  }
}

export function taskDialogOptions(
  plan: PlanUiDisplay,
): Array<{ title: string; value: string; description: string }> {
  return plan.tasks.map((task) => {
    let marker = "[ ]";
    let description = "Pending";
    if (task.state === "completed") {
      marker = "[x]";
      description = "Completed";
    }
    if (task.state === "in_progress") {
      marker = "[~]";
      description = "In progress";
    }
    if (plan.current?.id === task.id && task.state !== "completed") {
      marker = "[>]";
      description = "Current";
    }
    return {
      title: `${task.depth === 1 ? "  " : ""}${marker} ${task.id}. ${task.title}`,
      value: task.id,
      description,
    };
  });
}
