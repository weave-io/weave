/**
 * WS1 delegation metrics over a normalised session-store dataset.
 *
 * Definitions: Spec 37's "Metric definitions for the session audit script"
 * and Spec 38's Metrics section. Each metric is one small pure function so it
 * can be tested on its own. Where this code narrows or widens a definition,
 * the function's comment says how and why; the script header in
 * `opencode-sessions.ts` lists the same differences.
 */

import type {
  AuditDataset,
  AuditDelegation,
  AuditMessage,
  AuditSession,
} from "./session-store.js";

/** Harness built-in subagents Weave's orchestrators should not use. */
export const BUILTIN_AGENTS: readonly string[] = ["explore", "general"];

const CONFIGURATION_ERROR =
  /Model not found|ProviderModelNotFound|Unknown agent|Agent not found/i;
const TRANSIENT_ERROR = /Connection reset|Subagent failed/i;
/** Errors from the user stopping the call, not from the delegation itself. */
const USER_ABORT = /Task cancelled|Tool execution aborted|Aborted/i;

export interface Fraction {
  readonly count: number;
  readonly total: number;
}

export interface DelegationCounts {
  readonly total: number;
  readonly completed: number;
  readonly error: number;
  readonly running: number;
}

export interface BuiltinDelegations {
  readonly total: number;
  readonly byAgent: Readonly<Record<string, number>>;
}

export interface CategoryShuttleShare extends Fraction {
  /** Projects counted as defining categories. */
  readonly projects: number;
}

export interface TransientFailures {
  readonly total: number;
  readonly recovered: number;
}

export interface RecoveredFailures {
  readonly recovered: number;
  /** Transient plus configuration failures. */
  readonly total: number;
  readonly transient: Fraction;
  readonly configuration: Fraction;
  /** Every failed delegation, user aborts included. */
  readonly allFailed: number;
}

export interface PlanTaskDelegation {
  /** Sessions with a plan-starting command. */
  readonly planSessions: number;
  /** Plan sessions in which Loom answered after the command. */
  readonly sessionsWithLoomTurns: number;
  /** Loom messages after the command that contain a delegation. */
  readonly loomDelegationMessages: number;
  /** Plan sessions with at least one such message. */
  readonly sessionsWithLoomDelegation: number;
}

function isCategoryShuttle(target: string | null): boolean {
  return target?.startsWith("shuttle-") === true;
}

function isFailed(delegation: AuditDelegation): boolean {
  return delegation.status === "error";
}

/** `task` (V1) or `subagent` (V2) tool calls, by status. */
export function delegations(dataset: AuditDataset): DelegationCounts {
  const count = (status: AuditDelegation["status"]): number =>
    dataset.delegations.filter((d) => d.status === status).length;
  return {
    total: dataset.delegations.length,
    completed: count("completed"),
    error: count("error"),
    running: count("running"),
  };
}

/**
 * A failed delegation whose error names a missing model or an unknown agent,
 * or that has no target. A call without a target that the user aborted is
 * not counted: the audit's baseline (11 of 597) excludes those.
 */
export function isConfigurationFailure(delegation: AuditDelegation): boolean {
  if (!isFailed(delegation)) return false;
  const error = delegation.error ?? "";
  if (CONFIGURATION_ERROR.test(error)) return true;
  if (delegation.target !== null) return false;
  return !USER_ABORT.test(error);
}

/** A failed delegation the harness reported as a dropped connection. */
export function isTransientFailure(delegation: AuditDelegation): boolean {
  if (!isFailed(delegation)) return false;
  if (isConfigurationFailure(delegation)) return false;
  return TRANSIENT_ERROR.test(delegation.error ?? "");
}

export function configurationFailures(dataset: AuditDataset): Fraction {
  return {
    count: dataset.delegations.filter(isConfigurationFailure).length,
    total: dataset.delegations.length,
  };
}

/** Category-shuttle delegations: completed ÷ total. */
export function categoryShuttleSuccess(dataset: AuditDataset): Fraction {
  const shuttles = dataset.delegations.filter((d) =>
    isCategoryShuttle(d.target),
  );
  return {
    count: shuttles.filter((d) => d.status === "completed").length,
    total: shuttles.length,
  };
}

/**
 * In projects that define categories: delegations to `shuttle-*` ÷
 * delegations to `shuttle` or `shuttle-*`.
 *
 * A project defines categories when `definesCategories(projectDir)` says so
 * (the CLI reads the project's effective Weave config as it is today) or
 * when any session of it delegated to a category shuttle in the window.
 */
export function categoryShuttleShare(
  dataset: AuditDataset,
  definesCategories: (projectDir: string) => boolean,
): CategoryShuttleShare {
  const sessions = new Map<string, AuditSession>(
    dataset.sessions.map((session) => [session.id, session]),
  );
  const projectOf = (d: AuditDelegation): string =>
    sessions.get(d.sessionId)?.projectDir ?? "";
  const projects = new Set<string>();
  for (const session of dataset.sessions) {
    if (definesCategories(session.projectDir)) projects.add(session.projectDir);
  }
  for (const delegation of dataset.delegations) {
    if (isCategoryShuttle(delegation.target))
      projects.add(projectOf(delegation));
  }
  const family = dataset.delegations.filter(
    (d) =>
      projects.has(projectOf(d)) &&
      (d.target === "shuttle" || isCategoryShuttle(d.target)),
  );
  return {
    count: family.filter((d) => isCategoryShuttle(d.target)).length,
    total: family.length,
    projects: projects.size,
  };
}

/** Delegations to the harness's own `explore` and `general` subagents. */
export function builtinAgentDelegations(
  dataset: AuditDataset,
): BuiltinDelegations {
  const byAgent: Record<string, number> = {};
  for (const agent of BUILTIN_AGENTS) {
    byAgent[agent] = dataset.delegations.filter(
      (d) => d.target === agent,
    ).length;
  }
  return {
    total: Object.values(byAgent).reduce((sum, n) => sum + n, 0),
    byAgent,
  };
}

/**
 * Whether a failed delegation was recovered: a delegation after it, in the
 * same assistant turn or the next, went to the same target (transient
 * failures) or to `shuttle` (configuration failures) and completed. A turn
 * is the run of assistant messages that answers one user message.
 */
export class RecoveryIndex {
  /** Per message: its session, position and turn number within the session. */
  private readonly positions = new Map<
    string,
    { sessionId: string; order: number; turn: number }
  >();
  private readonly bySession = new Map<string, AuditDelegation[]>();

  constructor(dataset: AuditDataset) {
    const turns = new Map<string, number>();
    const ordered = [...dataset.messages].sort((a, b) => a.order - b.order);
    for (const message of ordered) {
      const turn =
        (turns.get(message.sessionId) ?? 0) + (message.role === "user" ? 1 : 0);
      turns.set(message.sessionId, turn);
      this.positions.set(message.id, {
        sessionId: message.sessionId,
        order: message.order,
        turn,
      });
    }
    for (const delegation of dataset.delegations) {
      const list = this.bySession.get(delegation.sessionId) ?? [];
      list.push(delegation);
      this.bySession.set(delegation.sessionId, list);
    }
  }

  isRecovered(failed: AuditDelegation): boolean {
    const wanted = isConfigurationFailure(failed) ? "shuttle" : failed.target;
    if (wanted === null) return false;
    const origin = this.positions.get(failed.messageId);
    if (origin === undefined) return false;
    return (this.bySession.get(failed.sessionId) ?? []).some((candidate) => {
      if (candidate.target !== wanted) return false;
      if (candidate.status !== "completed") return false;
      const at = this.positions.get(candidate.messageId);
      if (at === undefined) return false;
      if (at.turn > origin.turn + 1) return false;
      if (at.order > origin.order) return true;
      return at.order === origin.order && candidate.index > failed.index;
    });
  }
}

export function transientFailures(dataset: AuditDataset): TransientFailures {
  const index = new RecoveryIndex(dataset);
  const failed = dataset.delegations.filter(isTransientFailure);
  return {
    total: failed.length,
    recovered: failed.filter((d) => index.isRecovered(d)).length,
  };
}

/**
 * Recovered failures ÷ transient plus configuration failures. Spec 38 divides
 * by all failed delegations; user aborts (`Task cancelled`, `Tool execution
 * aborted`) are left out of the denominator here because nothing should
 * retry them, and reported separately as `allFailed`.
 */
export function recoveredFailures(dataset: AuditDataset): RecoveredFailures {
  const index = new RecoveryIndex(dataset);
  const fraction = (list: AuditDelegation[]): Fraction => ({
    count: list.filter((d) => index.isRecovered(d)).length,
    total: list.length,
  });
  const transient = fraction(dataset.delegations.filter(isTransientFailure));
  const configuration = fraction(
    dataset.delegations.filter(isConfigurationFailure),
  );
  return {
    recovered: transient.count + configuration.count,
    total: transient.total + configuration.total,
    transient,
    configuration,
    allFailed: dataset.delegations.filter(isFailed).length,
  };
}

/**
 * Loom's activity after a plan-starting command. The audit's baseline counts
 * plan sessions in which Loom took any turn ("17 of 20"); Spec 37 counts
 * Loom messages with a delegation. Both are reported, and only Loom messages
 * after the first command in the session count, so Loom's planning before
 * `/start-work` is not mistaken for plan execution.
 */
export function planTaskDelegation(dataset: AuditDataset): PlanTaskDelegation {
  const delegating = new Set(dataset.delegations.map((d) => d.messageId));
  const bySession = new Map<string, AuditMessage[]>();
  for (const message of dataset.messages) {
    const list = bySession.get(message.sessionId) ?? [];
    list.push(message);
    bySession.set(message.sessionId, list);
  }
  let planSessions = 0;
  let sessionsWithLoomTurns = 0;
  let loomDelegationMessages = 0;
  let sessionsWithLoomDelegation = 0;
  for (const messages of bySession.values()) {
    const marker = messages.find((m) => m.planMarker);
    if (marker === undefined) continue;
    planSessions += 1;
    const loom = messages.filter(
      (m) =>
        m.order > marker.order && m.role === "assistant" && m.agent === "loom",
    );
    if (loom.length > 0) sessionsWithLoomTurns += 1;
    const delegatingLoom = loom.filter((m) => delegating.has(m.id)).length;
    loomDelegationMessages += delegatingLoom;
    if (delegatingLoom > 0) sessionsWithLoomDelegation += 1;
  }
  return {
    planSessions,
    sessionsWithLoomTurns,
    loomDelegationMessages,
    sessionsWithLoomDelegation,
  };
}
