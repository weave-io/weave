/**
 * `ChildOverlayView` → the child inspector's closed fact types.
 *
 * The layout module (`child-overlay-layout.ts`) can only print what its fact
 * types can carry, so this is the one place that decides which authoritative
 * view field becomes which inspector fact. Keeping the projection here — and
 * out of the component — is what makes the ownership rules checkable:
 *
 * - The **header** gets identity and provenance only. It has no field for a
 *   status, an elapsed time, a token count or a child id, so nothing here can
 *   give it one.
 * - The **rail** gets every operational fact, and it is the only surface that
 *   may print captured failure text.
 * - The **prompt** gets the draft, the queue and the state word, and never the
 *   search or the failure detail.
 * - The **frame marker** gets the settlement phase, and nothing else.
 *
 * An unknown fact is absent, never guessed: no fabricated zero, no invented
 * percentage, and no child id smuggled in as a name. Untrusted text is
 * sanitized by the layout's own `safeTrim` before it reaches a cell, and the
 * only failure text admitted here is the already-bounded, already-sanitized
 * provider-error projection.
 */

import {
  type OverlayHeaderFacts,
  type OverlayPromptFacts,
  type OverlayRailFacts,
  type OverlaySettlementFacts,
  type OverlaySettlementPhase,
  overlaySettlementFacts,
} from "./child-overlay-layout.js";
import type {
  ChildOverlayStatus,
  ChildOverlayView,
} from "./child-overlay-types.js";
import type { PiChildProviderError } from "./child-provider-error.js";
import { resolveDurableChildTitle } from "./child-title.js";

/**
 * What the header calls a child whose agent name and title are both unknown.
 *
 * Deliberately generic: the child id is an identifier the header may never
 * print, and inventing a name from one would leak it.
 */
export const CHILD_OVERLAY_UNNAMED = "child" as const;

/**
 * Compact a bounded token count for the rail's SPEND group.
 *
 * Exact below a thousand, then one decimal per magnitude, so a wide count
 * still fits the rail's value column. Values already passed the Zod ceilings.
 */
export function formatOverlayTokenCount(
  count: number | undefined,
): string | undefined {
  if (count === undefined || !Number.isFinite(count) || count < 0)
    return undefined;
  const n = Math.floor(count);
  if (n < 1_000) return String(n);
  const scale = (value: number, suffix: string): string => {
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded)
      ? `${rounded}${suffix}`
      : `${rounded.toFixed(1)}${suffix}`;
  };
  if (n < 1_000_000) return scale(n / 1_000, "k");
  if (n < 1_000_000_000) return scale(n / 1_000_000, "M");
  return scale(n / 1_000_000_000, "B");
}

/** Elapsed wall time in the rail's own words, or absent when unreported. */
export function formatOverlayElapsed(
  elapsedMs: number | undefined,
): string | undefined {
  if (elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return undefined;
  }
  const seconds = Math.floor(elapsedMs / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * The rail's failure line: the classified fields, and only those.
 *
 * The transcript already carries the canonical provider-error sentence, so the
 * rail states the classification rather than repeating the prose. Every part
 * comes from an enum or a bounded integer the provider-error projection
 * already validated, so no captured provider text can reach the rail.
 */
export function formatOverlayFailureSummary(
  error: PiChildProviderError | undefined,
): string | undefined {
  if (error === undefined) return undefined;
  const parts = [
    error.class,
    error.httpStatus === undefined ? undefined : `HTTP ${error.httpStatus}`,
    error.code,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** Reported spend, at the precision the number actually carries. */
export function formatOverlayCost(
  cost: number | undefined,
): string | undefined {
  if (cost === undefined || !Number.isFinite(cost) || cost < 0)
    return undefined;
  return `$${cost < 1 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

/**
 * What the rail's `live` row says about the reader's own viewport.
 *
 * A settled child has no live state to report, so the row is absent rather
 * than claiming the transcript is still moving.
 */
function liveViewportWords(view: ChildOverlayView): string | undefined {
  if (view.readOnly) return undefined;
  return view.liveTail
    ? "following output"
    : `parked ${view.scrollOffset} row(s) back`;
}

function settlementPhase(status: ChildOverlayStatus): OverlaySettlementPhase {
  if (status === "settled") return "completed";
  if (status === "orphan") return "cancelled";
  return "live";
}

/**
 * The frame marker's phase and word.
 *
 * The three overlay statuses are the only authoritative lifecycle facts this
 * layer has, so the marker states exactly one of them rather than inferring a
 * failure or a retry the source never reported.
 */
export function childOverlaySettlementFacts(
  view: ChildOverlayView,
): OverlaySettlementFacts {
  return overlaySettlementFacts(
    settlementPhase(view.child.status),
    view.child.status.toUpperCase(),
  );
}

/**
 * What the inspector calls this child.
 *
 * The configured agent name first, then the bounded title, and only then the
 * generic placeholder. The child id is never a candidate.
 */
export function childOverlayName(view: ChildOverlayView): string {
  const agent = view.identity?.agentName;
  if (agent !== undefined && agent.length > 0) return agent;
  const title = view.child.title;
  if (title !== undefined && title.length > 0) return title;
  return CHILD_OVERLAY_UNNAMED;
}

function taskOrdinal(view: ChildOverlayView): string | undefined {
  const plan = view.planContext;
  if (plan?.taskOrdinal === undefined) return undefined;
  return plan.taskTotal === undefined
    ? `task ${plan.taskOrdinal}`
    : `task ${plan.taskOrdinal}/${plan.taskTotal}`;
}

function planCrumb(view: ChildOverlayView): string | undefined {
  const plan = view.planContext;
  if (plan === undefined) return undefined;
  const ordinal = taskOrdinal(view);
  const parts = [ordinal, plan.taskTitle].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/**
 * Is this stored title nothing but the child's own durable identity label?
 *
 * A durable title is `<identity label>-<opaque suffix>` derived by
 * {@link resolveDurableChildTitle} from the agent name and the thread or child
 * id. It is storage bookkeeping, not a semantic fact: it repeats the name the
 * header already prints and trails an opaque id fragment the header may never
 * print at all. The check is an equality against every title that function
 * could have produced for THIS child, so it recognizes a derived title by
 * construction rather than by guessing at its shape.
 */
function isDurableIdentityTitle(
  view: ChildOverlayView,
  title: string,
): boolean {
  const agentName = view.identity?.agentName;
  const derived = new Set<string>();
  for (const threadId of [view.child.threadId, view.child.childId]) {
    derived.add(resolveDurableChildTitle({ threadId }));
    if (agentName !== undefined && agentName.length > 0) {
      derived.add(resolveDurableChildTitle({ agentName, threadId }));
    }
  }
  derived.add(resolveDurableChildTitle({}));
  if (agentName !== undefined && agentName.length > 0) {
    derived.add(resolveDurableChildTitle({ agentName }));
  }
  return derived.has(title);
}

/**
 * The header's last identity fact: WHAT this child was given, in product words.
 *
 * The authoritative assignment comes first when a privacy-safe source names
 * one. A stored title is admitted only while it says something the header does
 * not already say: a title equal to the child's name, or a durable identity
 * title such as `shuttle-1d33e680`, is bookkeeping wearing a semantic slot and
 * is dropped outright. An absent fact prints nothing, which is honest; a
 * thread-like id in the header is not.
 */
export function childOverlayBoundedAssignment(view: ChildOverlayView): string {
  const assignment = (view.identity?.assignment ?? "").trim();
  if (assignment.length > 0) return assignment;
  const title = (view.child.title ?? "").trim();
  if (title.length === 0) return "";
  if (title === childOverlayName(view)) return "";
  return isDurableIdentityTitle(view, title) ? "" : title;
}

/**
 * Identity and provenance, and nothing else.
 *
 * The bounded slot carries the child's assignment, never its storage title:
 * see {@link childOverlayBoundedAssignment}. Dispatched task text never
 * reaches it either — the thread-lifecycle privacy contract keeps an
 * unauthenticated assignment out of every descriptor this view is built from.
 */
export function childOverlayHeaderFacts(
  view: ChildOverlayView,
): OverlayHeaderFacts {
  return {
    name: childOverlayName(view),
    model: view.identity?.model ?? view.telemetry?.model,
    role: view.identity?.role,
    boundedTitle: childOverlayBoundedAssignment(view),
    parent: view.identity?.parentAgentName,
    plan: view.planContext?.planName,
    taskCrumb: planCrumb(view),
    subtask: view.planContext?.subtask,
  };
}

/**
 * Every operational fact, on the one surface that owns them.
 *
 * `live` reports the reader's own viewport state — following the tail or
 * parked in the scrollback — because that is the operational fact the overlay
 * can state without guessing at what the child is doing between events.
 */
export function childOverlayRailFacts(
  view: ChildOverlayView,
): OverlayRailFacts {
  const settlement = childOverlaySettlementFacts(view);
  const failed = view.terminalError !== undefined;
  const usage = view.identity?.usage;
  return {
    status: view.child.status.toUpperCase(),
    tone: settlement.tone,
    elapsed: formatOverlayElapsed(view.identity?.elapsedMs),
    turn:
      view.identity?.turn === undefined
        ? undefined
        : String(view.identity.turn),
    run: view.activeRun === undefined ? undefined : `run ${view.activeRun}`,
    branch: view.activeBranchId,
    live: liveViewportWords(view),
    toolOutcome: formatOverlayFailureSummary(view.terminalError),
    toolTone: failed ? "bad" : "mute",
    failed,
    queueCount: view.identity?.queueDepth ?? 0,
    tokensIn: formatOverlayTokenCount(
      view.telemetry?.inputTokens ?? usage?.inputTokens,
    ),
    tokensOut: formatOverlayTokenCount(
      view.telemetry?.outputTokens ?? usage?.outputTokens,
    ),
    cost: formatOverlayCost(usage?.cost),
  };
}

/**
 * What the prompt may say about this child.
 *
 * The draft is supplied by the caller rather than read from the view, because
 * the live draft lives in Pi's own editor while the view holds the last value
 * the controller saved. A settled child's draft is never read at all.
 */
export function childOverlayPromptFacts(
  view: ChildOverlayView,
  input: { readonly draft: string; readonly confirmingCancel: boolean },
): OverlayPromptFacts {
  const settlement = childOverlaySettlementFacts(view);
  return {
    target: childOverlayName(view),
    turn: view.identity?.turn,
    settled: view.readOnly,
    failed: view.terminalError !== undefined,
    queueCount: view.identity?.queueDepth ?? 0,
    draft: view.readOnly ? "" : input.draft,
    stateWord: settlement.word,
    confirmingCancel: input.confirmingCancel,
    settledNotice:
      view.child.status === "orphan"
        ? "read-only — this child was orphaned"
        : undefined,
  };
}
