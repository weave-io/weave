import { err, ok, type Result } from "neverthrow";

export const SESSION_GOAL_STATE_VERSION = 1 as const;
export const DEFAULT_MAX_GOAL_CONTINUATIONS = 100;

export type Clock = () => number;
export type SessionGoalStatus =
  | "pursuing"
  | "paused"
  | "blocked"
  | "achieved"
  | "budget-limited";

export interface SessionGoalState {
  readonly version: typeof SESSION_GOAL_STATE_VERSION;
  readonly planName: string;
  readonly planContentRevision: string;
  readonly status: SessionGoalStatus;
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly turns: number;
  readonly tokens: number;
  readonly continuations: number;
  readonly evidence?: string;
  readonly reason?: string;
}

export interface SessionGoalSnapshot {
  readonly version: typeof SESSION_GOAL_STATE_VERSION;
  readonly state: SessionGoalState | null;
}

export interface SessionGoalBudget {
  readonly maxContinuations: number;
}

export type SessionGoalError =
  | { readonly type: "NoActiveGoal" }
  | {
      readonly type: "IllegalTransition";
      readonly from: SessionGoalStatus;
      readonly to: SessionGoalStatus;
    }
  | {
      readonly type: "InvalidSnapshot";
      readonly reason: string;
      readonly value?: unknown;
    }
  | {
      readonly type: "PlanNotResolved";
      readonly planName?: string;
      readonly planContentRevision?: string;
    }
  | { readonly type: "PlanIncomplete"; readonly reason: string }
  | {
      readonly type: "ProviderUnavailable";
      readonly reason: string;
      readonly cause?: unknown;
    };

const STATUSES = new Set<SessionGoalStatus>([
  "pursuing",
  "paused",
  "blocked",
  "achieved",
  "budget-limited",
]);

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function invalid(
  reason: string,
  value?: unknown,
): Result<never, SessionGoalError> {
  return err({ type: "InvalidSnapshot", reason, value });
}

/** Parse and validate the complete persisted session-goal envelope. */
export function parseSessionGoalSnapshot(
  value: unknown,
): Result<SessionGoalState | null, SessionGoalError> {
  if (typeof value !== "object" || value === null)
    return invalid("snapshot must be an object");
  const snapshot = value as { version?: unknown; state?: unknown };
  if (snapshot.version !== SESSION_GOAL_STATE_VERSION) {
    return invalid("snapshot has an unsupported version");
  }
  if (snapshot.state === null) return ok(null);
  if (typeof snapshot.state !== "object" || snapshot.state === null) {
    return invalid("state must be an object or null");
  }

  const state = snapshot.state as Partial<SessionGoalState>;
  if (state.version !== SESSION_GOAL_STATE_VERSION)
    return invalid("state has an unsupported version");
  if (typeof state.planName !== "string" || state.planName.trim() === "") {
    return invalid("planName must not be blank");
  }
  if (
    typeof state.planContentRevision !== "string" ||
    state.planContentRevision.trim() === ""
  ) {
    return invalid("planContentRevision must not be blank");
  }
  if (
    typeof state.status !== "string" ||
    !STATUSES.has(state.status as SessionGoalStatus)
  ) {
    return invalid("status is unknown");
  }
  for (const field of [
    "startedAt",
    "elapsedMs",
    "turns",
    "tokens",
    "continuations",
  ] as const) {
    if (!isFiniteNonNegative(state[field]))
      return invalid(`${field} must be finite and non-negative`, state[field]);
  }
  if (state.evidence !== undefined && typeof state.evidence !== "string") {
    return invalid("evidence must be a string when present", state.evidence);
  }
  if (state.reason !== undefined && typeof state.reason !== "string") {
    return invalid("reason must be a string when present", state.reason);
  }

  return ok({
    version: SESSION_GOAL_STATE_VERSION,
    planName: state.planName.trim(),
    planContentRevision: state.planContentRevision,
    status: state.status as SessionGoalStatus,
    startedAt: state.startedAt as number,
    elapsedMs: state.elapsedMs as number,
    turns: Math.floor(state.turns as number),
    tokens: Math.floor(state.tokens as number),
    continuations: Math.floor(state.continuations as number),
    evidence: state.evidence,
    reason: state.reason,
  });
}

export class SessionGoalController {
  private state: SessionGoalState | undefined;
  private activeSince: number | undefined;

  constructor(
    private readonly clock: Clock = () => Date.now(),
    private readonly budget: SessionGoalBudget = {
      maxContinuations: DEFAULT_MAX_GOAL_CONTINUATIONS,
    },
  ) {}

  get current(): Readonly<SessionGoalState> | undefined {
    return this.state;
  }

  get isPursuing(): boolean {
    return this.state?.status === "pursuing";
  }

  start(
    planName: string,
    planContentRevision: string,
  ): Result<void, SessionGoalError> {
    if (
      typeof planName !== "string" ||
      planName.trim() === "" ||
      typeof planContentRevision !== "string" ||
      planContentRevision.trim() === ""
    ) {
      return err({ type: "PlanNotResolved", planName, planContentRevision });
    }
    const now = this.clock();
    this.state = {
      version: SESSION_GOAL_STATE_VERSION,
      planName: planName.trim(),
      planContentRevision,
      status: "pursuing",
      startedAt: now,
      elapsedMs: 0,
      turns: 0,
      tokens: 0,
      continuations: 0,
    };
    this.activeSince = now;
    return ok(undefined);
  }

  restore(
    snapshot: SessionGoalSnapshot | SessionGoalState | null,
  ): Result<void, SessionGoalError> {
    if (snapshot === null) {
      this.state = undefined;
      this.activeSince = undefined;
      return ok(undefined);
    }
    const parsed =
      "state" in snapshot
        ? parseSessionGoalSnapshot(snapshot)
        : parseSessionGoalSnapshot({
            version: SESSION_GOAL_STATE_VERSION,
            state: snapshot,
          });
    if (parsed.isErr()) return err(parsed.error);
    this.state = parsed.value === null ? undefined : { ...parsed.value };
    this.activeSince =
      this.state?.status === "pursuing" ? this.clock() : undefined;
    return ok(undefined);
  }

  pause(reason?: string): Result<void, SessionGoalError> {
    if (this.state === undefined) return err({ type: "NoActiveGoal" });
    if (this.state.status !== "pursuing") return this.illegal("paused");
    this.finishActivePeriod();
    this.state = { ...this.state, status: "paused", reason };
    return ok(undefined);
  }

  resume(): Result<void, SessionGoalError> {
    if (this.state === undefined) return err({ type: "NoActiveGoal" });
    if (!["paused", "blocked", "budget-limited"].includes(this.state.status))
      return this.illegal("pursuing");
    this.state = { ...this.state, status: "pursuing", reason: undefined };
    this.activeSince = this.clock();
    return ok(undefined);
  }

  achieve(
    evidence: string,
    planComplete = true,
  ): Result<void, SessionGoalError> {
    if (this.state === undefined) return err({ type: "NoActiveGoal" });
    if (this.state.status !== "pursuing") return this.illegal("achieved");
    if (!planComplete)
      return err({
        type: "PlanIncomplete",
        reason: "The plan is not complete.",
      });
    this.finishActivePeriod();
    this.state = {
      ...this.state,
      status: "achieved",
      evidence: evidence.trim(),
      reason: undefined,
    };
    return ok(undefined);
  }

  block(reason: string): Result<void, SessionGoalError> {
    if (this.state === undefined) return err({ type: "NoActiveGoal" });
    if (this.state.status !== "pursuing") return this.illegal("blocked");
    this.finishActivePeriod();
    this.state = { ...this.state, status: "blocked", reason: reason.trim() };
    return ok(undefined);
  }

  limitBudget(reason: string): Result<void, SessionGoalError> {
    if (this.state === undefined) return err({ type: "NoActiveGoal" });
    if (this.state.status !== "pursuing") return this.illegal("budget-limited");
    this.finishActivePeriod();
    this.state = { ...this.state, status: "budget-limited", reason };
    return ok(undefined);
  }

  clear(): Result<void, SessionGoalError> {
    if (this.state === undefined) return err({ type: "NoActiveGoal" });
    if (this.state.status === "pursuing") this.finishActivePeriod();
    this.state = undefined;
    this.activeSince = undefined;
    return ok(undefined);
  }

  recordTurn(tokens: number): Result<void, SessionGoalError> {
    if (this.state === undefined) return err({ type: "NoActiveGoal" });
    if (!isFiniteNonNegative(tokens))
      return err({
        type: "InvalidSnapshot",
        reason: "tokens must be finite and non-negative",
        value: tokens,
      });
    this.state = {
      ...this.state,
      turns: this.state.turns + 1,
      tokens: this.state.tokens + Math.floor(tokens),
    };
    return ok(undefined);
  }

  recordContinuation(): Result<void, SessionGoalError> {
    if (this.state === undefined) return err({ type: "NoActiveGoal" });
    if (this.state.status !== "pursuing") return this.illegal("pursuing");
    this.state = { ...this.state, continuations: this.state.continuations + 1 };
    return ok(undefined);
  }

  budgetReason(): string | undefined {
    if (
      this.state !== undefined &&
      this.state.continuations >= this.budget.maxContinuations
    ) {
      return `Automatic continuation budget reached (${this.budget.maxContinuations}).`;
    }
    return undefined;
  }

  elapsedMs(): number {
    if (
      this.state === undefined ||
      this.state.status !== "pursuing" ||
      this.activeSince === undefined
    )
      return this.state?.elapsedMs ?? 0;
    return this.state.elapsedMs + Math.max(0, this.clock() - this.activeSince);
  }

  serialize(): SessionGoalSnapshot {
    return this.state === undefined
      ? { version: SESSION_GOAL_STATE_VERSION, state: null }
      : {
          version: SESSION_GOAL_STATE_VERSION,
          state: { ...this.state, elapsedMs: this.elapsedMs() },
        };
  }

  private illegal(to: SessionGoalStatus): Result<never, SessionGoalError> {
    return err({
      type: "IllegalTransition",
      from: this.state?.status as SessionGoalStatus,
      to,
    });
  }

  private finishActivePeriod(): void {
    if (this.state === undefined || this.activeSince === undefined) return;
    this.state = {
      ...this.state,
      elapsedMs:
        this.state.elapsedMs + Math.max(0, this.clock() - this.activeSince),
    };
    this.activeSince = undefined;
  }
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000)
    return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}m`;
}
