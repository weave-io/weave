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
import {
  type OverlayTranscriptInput,
  overlayPayloadText,
  overlayToolArgs,
  overlayToolOutcome,
  overlayToolTarget,
  overlayToolTone,
} from "./child-overlay-pi-native.js";
import type {
  ChildOverlayOutcome,
  ChildOverlayStatus,
  ChildOverlayView,
} from "./child-overlay-types.js";
import type { PiChildProviderError } from "./child-provider-error.js";
import { resolveDurableChildTitle } from "./child-title.js";
import type {
  PiChildTranscriptState,
  PiChildTranscriptToolEntry,
} from "./child-transcript.js";
import { safeTrim } from "./ui-rows.js";

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

// ---------------------------------------------------------------------------
// The live projection the WORK and SPEND groups are read from
// ---------------------------------------------------------------------------

/**
 * Why the rail reads the TRANSCRIPT and not the descriptor.
 *
 * A descriptor is a snapshot taken when the reader opened the child, and the
 * overlay refreshes it exactly once, at settlement. Projecting the rail from
 * it meant every WORK fact printed `—` for the whole life of the run and every
 * queue depth, turn count and token total stayed at its open-time value however
 * many events arrived. The transcript reducer, by contrast, is fed by
 * `applyLiveEvent` on every parser-approved event AND rebuilt from replay steps
 * when history is paged, so both paths reach the same facts — which is what
 * makes a replayed window and a live stream agree on the rail.
 *
 * The descriptor is still consulted, but only as the fallback for a fact no
 * event has reported yet. An unknown stays unknown; nothing here estimates.
 */
function latestToolEntry(
  transcript: PiChildTranscriptState,
): PiChildTranscriptToolEntry | undefined {
  for (let i = transcript.entries.length - 1; i >= 0; i -= 1) {
    const entry = transcript.entries[i];
    if (entry?.kind === "tool") return entry;
  }
  return undefined;
}

/** Assistant messages observed so far: the child's own conversation turns. */
function observedTurns(transcript: PiChildTranscriptState): number {
  return transcript.entries.filter((entry) => entry.kind === "assistant")
    .length;
}

/**
 * The turn this child has reached, as ONE fact for every surface.
 *
 * Two authorities count the same thing and neither sees all of it: the
 * descriptor snapshot knows the turn the run had reached when the reader
 * opened it, and the transcript knows every assistant message this window has
 * loaded or watched arrive. Both only ever grow, so the LARGER is the best
 * lower bound either can support — taking the observed count alone reported
 * `1` for a child opened at turn 9, and taking the snapshot alone froze the
 * row for the whole run.
 *
 * It is exported and shared because the prompt used to read the descriptor
 * turn directly while the rail read this: one frame printed `turn 3` under
 * `turn 7`, and a reader has no way to tell which of two disagreeing turn
 * counters describes the child they are steering.
 */
export function childOverlayTurn(view: ChildOverlayView): number | undefined {
  const observed = observedTurns(view.transcript);
  const reported = view.identity?.turn;
  if (reported === undefined) return observed > 0 ? observed : undefined;
  return Math.max(observed, reported);
}

/**
 * Reported spend, from whichever authoritative shape the aggregate used.
 *
 * Pi reports `cost` as a breakdown object (`{ input, output, total }`), older
 * recorded sessions report a bare number, and some hosts report `costUsd`.
 * Anything else is unavailable rather than zero.
 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The run's spend, from the LATEST authoritative host report.
 *
 * Every turn a child takes re-sends the whole conversation, so a per-turn
 * `Usage` is not a slice of the run that could be added up — it is the run so
 * far, priced again. A real 0.84.2 report makes that plain: `input 2, output
 * 22, cacheRead 38798, totalTokens 38909, cost.total 0.0205`, where the two
 * tiny figures are the turn's new tokens and `cacheRead` is the whole context
 * the host re-read. The host's own `totalTokens` is therefore the run's token
 * count, and the parent's delegation card prints exactly that.
 *
 * Summing reports double-counts the context once per turn; taking `input` and
 * `output` alone reports a fraction of it. So the input-side figure is
 * whatever `totalTokens` does not attribute to output, which keeps the two
 * printed numbers adding back up to the host's own total.
 *
 * The delegation tree's aggregate and Pi's cumulative `UsageTotals` remain the
 * FALLBACKS, for a window that has seen no report of its own. An unknown
 * prints `—`; nothing here prices tokens or estimates a total.
 */
interface OverlaySpendFacts {
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly cost?: number;
}

/** The latest report's own figures, or `undefined` when it stated none. */
function latestReportSpend(
  view: ChildOverlayView,
): OverlaySpendFacts | undefined {
  const telemetry = view.telemetry;
  if (telemetry === undefined) return undefined;
  const output = telemetry.outputTokens;
  const total = telemetry.totalTokens;
  // The input side is everything the host counted that was not output: new
  // input tokens plus the cache read and cache write it accounted for.
  const inputSide =
    total !== undefined
      ? Math.max(0, total - (output ?? 0))
      : sumDefined(
          telemetry.inputTokens,
          telemetry.cacheReadTokens,
          telemetry.cacheWriteTokens,
        );
  const spend: OverlaySpendFacts = {
    tokensIn: inputSide,
    tokensOut: output,
    cost: telemetry.costTotal,
  };
  return spend.tokensIn === undefined &&
    spend.tokensOut === undefined &&
    spend.cost === undefined
    ? undefined
    : spend;
}

/** The sum of the reported components, or `undefined` when none was reported. */
function sumDefined(
  ...values: readonly (number | undefined)[]
): number | undefined {
  const reported = values.filter(
    (value): value is number => value !== undefined,
  );
  return reported.length === 0
    ? undefined
    : reported.reduce((total, value) => total + value, 0);
}

/** The fallback aggregate, used only where no report of its own exists. */
function aggregateTokens(
  view: ChildOverlayView,
  key: "inputTokens" | "outputTokens",
  eventKey: "input" | "output",
): number | undefined {
  const descriptor = view.identity?.usage?.[key];
  if (descriptor !== undefined) return descriptor;
  const cumulative: Record<string, unknown> = { ...view.transcript.usage };
  return finiteNumber(cumulative[key]) ?? finiteNumber(cumulative[eventKey]);
}

/**
 * The SPEND group's three figures, from the one authority that has them.
 *
 * The latest host report wins outright when it exists: it is the same figure
 * the parent's delegation card prints, and a delegation-tree aggregate that
 * summed per-turn full-context reports disagrees with the host by an order of
 * magnitude. Each figure falls back independently, so a report that stated
 * tokens but no cost still leaves cost to the aggregate rather than to `—`.
 */
function overlaySpend(view: ChildOverlayView): OverlaySpendFacts {
  const latest = latestReportSpend(view);
  const fallbackCost =
    view.identity?.usage?.cost ?? aggregateCost({ ...view.transcript.usage });
  return {
    tokensIn: latest?.tokensIn ?? aggregateTokens(view, "inputTokens", "input"),
    tokensOut:
      latest?.tokensOut ?? aggregateTokens(view, "outputTokens", "output"),
    cost: latest?.cost ?? fallbackCost,
  };
}

function aggregateCost(usage: Record<string, unknown>): number | undefined {
  const direct = usage.cost;
  const bare = finiteNumber(direct);
  if (bare !== undefined) return bare;
  if (typeof direct === "object" && direct !== null) {
    const total = finiteNumber((direct as Record<string, unknown>).total);
    if (total !== undefined) return total;
  }
  return finiteNumber(usage.costUsd);
}

/** The newest queue report, or `undefined` when the child reported none. */
function latestQueue(
  transcript: PiChildTranscriptState,
): { readonly size?: number; readonly first?: string } | undefined {
  for (let i = transcript.entries.length - 1; i >= 0; i -= 1) {
    const entry = transcript.entries[i];
    if (entry?.kind !== "queue") continue;
    // A report that named no depth leaves the count UNKNOWN, so the caller
    // falls back to the descriptor's proven depth instead of printing zero.
    const first = overlayPayloadText(entry.queue?.[0]);
    return {
      ...(entry.size === undefined ? {} : { size: entry.size }),
      ...(first.length === 0 ? {} : { first }),
    };
  }
  return undefined;
}

/**
 * What the child is doing right now, in its own reported words.
 *
 * Read from the newest transcript entry, so it moves with the run instead of
 * describing the reader's scrollback. When nothing has happened yet the row
 * falls back to the viewport state, which is still an honest live fact.
 */
function liveActivity(view: ChildOverlayView): string | undefined {
  if (view.readOnly) return undefined;
  const entries = view.transcript.entries;
  const newest = entries[entries.length - 1];
  if (newest !== undefined) {
    if (newest.kind === "assistant" && newest.streaming) {
      return "streaming reply";
    }
    if (newest.kind === "tool") {
      const name = safeTrim(newest.toolName) || "tool";
      if (newest.state === "error") return `${name} failed`;
      if (newest.state === "result") return `${name} done`;
      return `running ${name}`;
    }
    if (newest.kind === "thinking") return "reasoning";
    if (
      newest.kind === "queue" &&
      newest.size !== undefined &&
      newest.size > 0
    ) {
      return `${newest.size} queued`;
    }
  }
  return liveViewportWords(view);
}

/**
 * The lifecycle word, plus whatever status the child last reported.
 *
 * The lifecycle word is authoritative and never replaced: settlement is the
 * only completion authority. A reported status refines it rather than
 * overriding it, so `LIVE · working` still says the run is live.
 */
function statusWords(view: ChildOverlayView): string {
  // The same authoritative word the frame marker prints, so a settled child's
  // verdict cannot differ between the marker and the rail.
  const lifecycle = childOverlaySettlementFacts(view).word;
  const reported = safeTrim(view.transcript.status ?? "");
  if (reported.length === 0 || view.readOnly) return lifecycle;
  return `${lifecycle} · ${reported}`;
}

/**
 * The pane's own facts, projected once so the transcript and the rail can
 * never disagree about which child they describe.
 */
export function childOverlayTranscriptInput(
  view: ChildOverlayView,
): OverlayTranscriptInput {
  const parent = view.identity?.parentAgentName;
  return {
    entries: view.transcript.entries,
    childName: childOverlayName(view),
    ...(parent === undefined || parent.length === 0
      ? {}
      : { parentName: parent }),
    settled: view.readOnly,
    ...(view.terminalError === undefined
      ? {}
      : { terminalError: view.terminalError }),
    windowEntries: view.entries,
    terminalErrorStated: view.transcript.entries.some(
      (entry) => entry.kind === "assistant" && entry.stopReason === "error",
    ),
  };
}

function settlementPhase(
  status: ChildOverlayStatus,
  outcome: ChildOverlayOutcome | undefined,
): OverlaySettlementPhase {
  if (status === "settled") {
    // The authoritative verdict, when the settlement authority named one.
    if (outcome === "failed") return "failed";
    if (outcome === "cancelled") return "cancelled";
    // COMPATIBILITY FALLBACK: history written before the outcome field
    // existed proves only that the run ended. It stays on the completed phase
    // and keeps the generic `SETTLED` word below rather than claiming a
    // verdict the record does not carry.
    return "completed";
  }
  if (status === "orphan") return "cancelled";
  return "live";
}

/**
 * The frame marker's phase and word.
 *
 * The lifecycle status says whether the run ended; the authoritative outcome
 * says HOW. Both come from the settlement authority through the descriptor —
 * never from assistant text, reported status prose, or a `message_end` — so
 * this layer states a verdict only when one was proven, and otherwise keeps
 * the generic settled wording.
 */
export function childOverlaySettlementFacts(
  view: ChildOverlayView,
): OverlaySettlementFacts {
  const outcome =
    view.child.status === "settled" ? view.child.outcome : undefined;
  return overlaySettlementFacts(
    settlementPhase(view.child.status, outcome),
    (outcome ?? view.child.status).toUpperCase(),
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
 * The LIFECYCLE and WORK groups are projected from the transcript reducer,
 * which every live event and every replayed page feeds, so the rail moves with
 * the run instead of repeating the descriptor snapshot taken when the reader
 * opened the child. The descriptor is the fallback for facts no event has
 * reported. Nothing here is estimated: an unreported fact is absent, and the
 * layout prints it as unknown.
 */
export function childOverlayRailFacts(
  view: ChildOverlayView,
): OverlayRailFacts {
  const settlement = childOverlaySettlementFacts(view);
  const transcript = view.transcript;
  const tool = latestToolEntry(transcript);
  const toolTone = tool === undefined ? "mute" : overlayToolTone(tool);
  // A terminal provider error is a failure of the RUN; a failed tool is a
  // failure of the current WORK. Either raises the rail's alert pair, and the
  // run-level classification wins the detail line when both exist.
  const providerFailure = formatOverlayFailureSummary(view.terminalError);
  const toolOutcome = tool === undefined ? undefined : overlayToolOutcome(tool);
  const failed = providerFailure !== undefined || toolTone === "bad";
  // A run-level classification outranks the tool line on the alert pair.
  const outcome = providerFailure ?? toolOutcome;
  // The alert pair already prints `outcome`. A detail row that repeats it word
  // for word spends a rail row on nothing, so it is stated only when the two
  // authorities actually say different things.
  const captured = toolTone === "bad" ? toolOutcome : undefined;
  const errorDetail = captured === outcome ? undefined : captured;
  const target = tool === undefined ? "" : overlayToolTarget(tool);
  const args = tool === undefined ? "" : overlayToolArgs(tool);
  const queue = latestQueue(transcript);
  const turn = childOverlayTurn(view);
  const spend = overlaySpend(view);
  return {
    status: statusWords(view),
    tone: settlement.tone,
    elapsed: formatOverlayElapsed(view.identity?.elapsedMs),
    turn: turn === undefined ? undefined : String(turn),
    run: view.activeRun === undefined ? undefined : `run ${view.activeRun}`,
    branch: view.activeBranchId,
    live: liveActivity(view),
    ...(tool === undefined ? {} : { tool: safeTrim(tool.toolName) || "tool" }),
    ...(target.length === 0 ? {} : { target }),
    ...(args.length === 0 ? {} : { args }),
    ...(outcome === undefined ? {} : { toolOutcome: outcome }),
    toolTone: providerFailure === undefined ? toolTone : "bad",
    failed,
    ...(errorDetail === undefined ? {} : { errorDetail }),
    // An unreported queue is UNKNOWN, not empty. Only an authoritative queue
    // entry or a descriptor depth may state a number, including zero.
    queueCount: queue?.size ?? view.identity?.queueDepth,
    ...(queue?.first === undefined ? {} : { firstQueued: queue.first }),
    tokensIn: formatOverlayTokenCount(spend.tokensIn),
    tokensOut: formatOverlayTokenCount(spend.tokensOut),
    cost: formatOverlayCost(spend.cost),
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
    // The same live fact the rail states. See {@link childOverlayTurn}.
    turn: childOverlayTurn(view),
    settled: view.readOnly,
    failed: view.terminalError !== undefined,
    // Absent stays absent: see the rail's queue fact.
    queueCount: view.identity?.queueDepth,
    draft: view.readOnly ? "" : input.draft,
    stateWord: settlement.word,
    confirmingCancel: input.confirmingCancel,
    settledNotice:
      view.child.status === "orphan"
        ? "read-only — this child was orphaned"
        : undefined,
  };
}
