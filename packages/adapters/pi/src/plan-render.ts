/**
 * The Plan Rail: the single owner of ambient parent context in Pi.
 *
 * The rail mounts above the real Pi editor and answers exactly two questions
 * while the user does ordinary work: WHICH PRIMARY AGENT IS SELECTED, and
 * WHAT PLAN AND TASK IS ACTIVE. Before it there were three owners - a compact
 * plan widget below the editor, a duplicate current-task footer, and the agent
 * status line - and the same task could appear twice with two different
 * spellings. There is now one surface, so identity has one place to be wrong.
 *
 * WHY IT IS SAFE
 *   {@link PlanRailFacts} is the whole vocabulary, and it is parent-side only.
 *   There is no field for a child id, a token count, a cost, an elapsed time,
 *   an active tool, or a queue depth, and the renderer never takes a child
 *   state, so the rail is byte-identical in every child state. The child
 *   inspector already owns all of that; the closed fact type is the structural
 *   reason this surface cannot leak it.
 *
 * NARROW LADDER (measured, never guessed)
 *   The selected agent name and the active task text survive to the narrowest
 *   supported tier. Everything else leaves in one fixed order, one drop per
 *   measured width band: the plan name goes first, then the `next` row, then
 *   the word `cycle` from the `Alt+A` hint. `Alt+A` itself is the last hint
 *   standing. {@link joinFit} enforces the same order inside row 1 for any
 *   width, so a long agent name degrades the header rather than the identity.
 *
 * Nothing here decides *which* plan is active: callers resolve that once
 * through `active-plan-ui-state.ts` and hand the result to
 * {@link buildPlanRailFacts}.
 */
import type {
  ActivePlanTask,
  PlanTaskNode,
  PlanTaskSnapshot,
} from "@weaveio/weave-engine";
import {
  fitLineToWidth,
  measureWidth,
  truncatePlainToWidth,
} from "./render-width.js";
import { type Paint, plainPaint } from "./ui-paint.js";
import { joinFit, safeTrim } from "./ui-rows.js";

/** How one parent task reads as a mark on the rail's progress row. */
export type PlanRailMarkState = "done" | "active" | "pending";

/**
 * Bounds the marks a pathological plan may contribute. Beyond this the row
 * states the position with its ordinal alone rather than growing without
 * limit.
 */
export const PLAN_RAIL_MAX_MARKS = 40;

/** Columns the `┃ now  `/`┗ next ` gutters cost before any task text. */
const TASK_GUTTER_COLUMNS = 10;

/**
 * The plan half of the rail's vocabulary. Present only when a plan is active,
 * so "no active plan" is a structural absence rather than a set of blanks.
 */
export interface PlanRailPlanFacts {
  /** The plan name, as the workflow slug spells it. */
  readonly plan: string;
  /** One mark per parent task, in plan order. */
  readonly marks: readonly PlanRailMarkState[];
  /** The position, already formatted: `3/8`. */
  readonly ordinal: string;
  /** The active task title. */
  readonly task: string;
  /** The task after the active one, or `undefined` at the end of the plan. */
  readonly nextTask: string | undefined;
}

/**
 * Everything the Plan Rail is allowed to say.
 *
 * Deliberately closed and deliberately small. Adding a child id, token count,
 * cost, elapsed time, or queue depth would require changing this type, which
 * is exactly the review the inspector boundary deserves.
 */
export interface PlanRailFacts {
  /** The selected primary (or active direct-step) agent name. */
  readonly agent: string;
  /**
   * How many primary agents `Alt+A` can select. The hint appears only when
   * there is somewhere to cycle to, so a single-agent config shows no key it
   * cannot honour.
   */
  readonly cycleCandidateCount: number;
  readonly plan: PlanRailPlanFacts | undefined;
}

/** The measured width bands the rail degrades through. */
export type PlanRailTier = "wide" | "mid" | "tight" | "micro";

/**
 * Classifies a width into its band. Measured, never guessed: each boundary is
 * the width at which the next-least-valuable piece stops fitting comfortably
 * beside everything the rail promises to keep.
 */
export function planRailTier(width: number): PlanRailTier {
  const columns = Number.isFinite(width) ? Math.floor(width) : 0;
  if (columns >= 96) return "wide";
  if (columns >= 68) return "mid";
  if (columns >= 46) return "tight";
  return "micro";
}

/** The plan name survives only in the widest band. It is the first to go. */
function showsPlanName(tier: PlanRailTier): boolean {
  return tier === "wide";
}

/** The `next` row goes after the plan name and before the word `cycle`. */
function showsNextRow(tier: PlanRailTier): boolean {
  return tier === "wide" || tier === "mid";
}

/** The descriptive word leaves the hint last; the `Alt+A` key never does. */
function showsCycleWord(tier: PlanRailTier): boolean {
  return tier !== "micro";
}

/**
 * The Weave mark. It is decoration around the agent name, so the narrowest
 * band keeps the diamond and spends its columns on the name instead.
 */
function railMark(tier: PlanRailTier): string {
  return tier === "micro" ? "◆" : "◆ WEAVE";
}

/** One parent task's mark: the active one, a finished one, or an upcoming one. */
function markStateOf(
  index: number,
  state: PlanTaskNode["state"],
  activeIndex: number,
): PlanRailMarkState {
  if (index === activeIndex) return "active";
  if (state === "completed") return "done";
  return "pending";
}

function markGlyph(paint: Paint, state: PlanRailMarkState): string {
  if (state === "done") return paint.muted("●");
  if (state === "active") return paint.acc("◐");
  return paint.dim("○");
}

/**
 * Builds the rail's facts from the one resolved active-plan view plus the
 * agent identity the badge resolver already decided.
 *
 * Returns `undefined` when no Weave primary is active: the rail owns parent
 * context, and with no selected agent there is no parent context to own, so
 * the widget is removed rather than drawn empty.
 */
export function buildPlanRailFacts(input: {
  readonly agentName: string | undefined;
  readonly cycleCandidateCount: number;
  readonly snapshot: PlanTaskSnapshot | undefined;
  readonly activeTask: ActivePlanTask | undefined;
}): PlanRailFacts | undefined {
  const agent = safeTrim(input.agentName ?? "");
  if (agent === "") return undefined;

  const cycleCandidateCount = Number.isFinite(input.cycleCandidateCount)
    ? Math.max(0, Math.floor(input.cycleCandidateCount))
    : 0;
  const plan = buildPlanFacts(input.snapshot, input.activeTask);
  return { agent, cycleCandidateCount, plan };
}

function buildPlanFacts(
  snapshot: PlanTaskSnapshot | undefined,
  activeTask: ActivePlanTask | undefined,
): PlanRailPlanFacts | undefined {
  if (snapshot === undefined || activeTask === undefined) return undefined;

  const parents = snapshot.parents;
  const marks: PlanRailMarkState[] = [];
  const marked = parents.slice(0, PLAN_RAIL_MAX_MARKS);
  for (const [index, parent] of marked.entries()) {
    marks.push(markStateOf(index, parent.state, activeTask.parentIndex));
  }

  const next = parents[activeTask.parentIndex + 1];
  const nextTitle = next === undefined ? "" : safeTrim(next.title);
  return {
    plan: safeTrim(snapshot.planName),
    marks,
    ordinal: `${activeTask.parentOrdinal}/${activeTask.totalParentCount}`,
    task: safeTrim(activeTask.taskTitle),
    nextTask: nextTitle === "" ? undefined : nextTitle,
  };
}

/**
 * Renders the rail for one measured width.
 *
 * Returns `[]` - which removes the widget - when there are no facts, i.e.
 * when no Weave primary is active. With an agent but no plan it renders the
 * single agent row, because "which agent am I talking to" is ambient context
 * whether or not a plan is running.
 *
 * `paint` defaults to the ANSI-free twin, so a plain render is byte-identical
 * geometry to a themed one and a test may assert on both text and columns.
 */
export function renderPlanRailWidgetLines(
  facts: PlanRailFacts | undefined,
  width: number,
  paint: Paint = plainPaint(),
): string[] {
  const columns = Number.isFinite(width) ? Math.floor(width) : 0;
  if (columns <= 0 || facts === undefined || facts.agent === "") return [];

  const tier = planRailTier(columns);
  const rows = [renderHeaderRow(facts, tier, columns, paint)];
  const plan = facts.plan;
  if (plan === undefined)
    return rows.map((row) => fitLineToWidth(row, columns));

  rows.push(renderMarksRow(plan, tier, columns, paint));
  rows.push(
    `${paint.acc("┃")} ${paint.dim("now ")}  ${paint.text(
      truncatePlainToWidth(
        plan.task,
        Math.max(1, columns - TASK_GUTTER_COLUMNS),
      ),
    )}`,
  );
  if (showsNextRow(tier) && plan.nextTask !== undefined) {
    rows.push(
      `${paint.rule("┗")} ${paint.dim("next")}  ${paint.muted(
        truncatePlainToWidth(
          plan.nextTask,
          Math.max(1, columns - TASK_GUTTER_COLUMNS),
        ),
      )}`,
    );
  }
  return rows.map((row) => fitLineToWidth(row, columns));
}

/**
 * Row 1: `◆ WEAVE · <AGENT> · Alt+A cycle · <plan>`, as room allows.
 *
 * The agent piece is first, so {@link joinFit} clips it rather than dropping
 * it while every optional piece behind it is dropped whole. That is the
 * structural form of "the agent name is the last thing the rail may lose".
 */
function renderHeaderRow(
  facts: PlanRailFacts,
  tier: PlanRailTier,
  width: number,
  paint: Paint,
): string {
  const identity = `${paint.acc(railMark(tier))} ${paint.rule("·")} ${paint.bold(
    facts.agent.toUpperCase(),
  )}`;
  const plan = facts.plan;
  return joinFit(
    [
      identity,
      renderCycleHint(facts.cycleCandidateCount, tier, paint),
      showsPlanName(tier) && plan !== undefined ? paint.muted(plan.plan) : "",
    ],
    width,
    paint.rule(" · "),
  );
}

/** The `Alt+A` hint. Empty when there is nowhere to cycle to. */
function renderCycleHint(
  cycleCandidateCount: number,
  tier: PlanRailTier,
  paint: Paint,
): string {
  if (cycleCandidateCount <= 1) return "";
  const key = paint.acc("Alt+A");
  return showsCycleWord(tier) ? `${key} ${paint.dim("cycle")}` : key;
}

/**
 * Row 2: spaced task marks and the ordinal.
 *
 * The marks are the first thing this row gives up: at the narrowest band, and
 * whenever the marks would not fit beside the ordinal, the position is stated
 * as `3/8` alone rather than as a truncated row of dots that would misreport
 * the plan's length.
 */
function renderMarksRow(
  plan: PlanRailPlanFacts,
  tier: PlanRailTier,
  width: number,
  paint: Paint,
): string {
  const ordinal = paint.acc(plan.ordinal);
  if (tier === "micro" || plan.marks.length === 0) return ordinal;
  const dots = plan.marks.map((state) => markGlyph(paint, state)).join(" ");
  const full = `${dots}   ${ordinal}`;
  return measureWidth(full) <= width ? full : ordinal;
}
