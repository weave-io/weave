/**
 * The child inspector layout: closed facts in, width-safe lines out.
 *
 * This module is pure and stateless. It renders no Pi component, reads no
 * clock, holds no draft, and decides nothing about a child's lifecycle. It is
 * given five closed fact types plus a width, a height, a paint, and the
 * already-painted transcript rows, and it returns the overlay region by
 * region.
 *
 * Five honesty rules are properties of the types rather than rules a reviewer
 * has to remember:
 *
 * 1. **The header cannot regrow telemetry or an id.**
 *    {@link OverlayHeaderFacts} has no field for status, elapsed, turn, queue,
 *    tokens, cost, or a child id, so the Session Header structurally cannot
 *    print one. Those facts live on the Status Matrix rail and on the frame
 *    marker.
 * 2. **The header is state-free.** Nothing it reads is derived from a child's
 *    state, so its bytes are identical for a running, failing, steered,
 *    completed, cancelled, or recovering child.
 * 3. **The prompt cannot see the search.** {@link renderPromptGroup} takes
 *    {@link OverlayPromptFacts} and nothing else, so the prompt region is
 *    byte-identical with search open and closed.
 * 4. **A settled child cannot be given an input.** {@link OverlayPromptFacts}
 *    carries a `draft` that {@link promptField} reads only while the child is
 *    live; a settled child gets the read-only notice, no caret, and every
 *    mutating key printed with an explicit `✕`.
 * 5. **The prompt group answers the cancel confirmation itself**, so `q` can
 *    never cancel without a `y` / `n` answer.
 *
 * Geometry and colour are borrowed, never re-implemented: `ui-rows.ts` owns
 * measurement, clipping, padding and sanitizing, and `ui-paint.ts` owns the
 * ink vocabulary. Untrusted child text reaches the screen only through
 * {@link safeTrim}, so it can never forge the one high-contrast frame this
 * module draws.
 *
 * See `docs/specs/33-spec-pi-adapter/33-weave-ui-design.md` §2, and the
 * normative prototype `prototypes/weave-pi-tui-grilling.ts`
 * (`composeSessionHeader`, `headerIdentityRow`, `headerContextRow`,
 * `renderRailStatusMatrix`, `compactStatusMatrix`, `transcriptWindow`,
 * `navFacts`, `navMatchList`, `markSearchGutter`, `searchRailSections`,
 * `renderPromptGroup`, `promptPrimaryEditor`, `promptField`, `promptKeys`,
 * `keyLine`, `keyLadder`, `keyChip`, `promptCancelConfirm`, `frameOverlay`,
 * `frameTop`, `frameBottom`, `squeezeBody`, `composeOverlayRegions`).
 */

import {
  clampToWidth,
  fitLineToWidth,
  measureWidth,
  truncatePlainToWidth,
} from "./render-width.js";
import { type Paint, paintTone, type Tone } from "./ui-paint.js";
import {
  cell,
  fitTo,
  joinColumns,
  joinFit,
  RAIL_GEOMETRY,
  reserveRows,
  rowLR,
  safeTrim,
  splitRail,
  stackSections,
  TRANSCRIPT_MIN,
  wrapPlain,
} from "./ui-rows.js";

// ---------------------------------------------------------------------------
// Geometry and vocabulary
// ---------------------------------------------------------------------------

/** Border columns the outer frame consumes, one on each side. */
export const OVERLAY_FRAME_COLUMNS = 2;

/** Border rows the outer frame consumes, one above and one below. */
export const OVERLAY_FRAME_ROWS = 2;

/** The one title the overlay frame carries. It never carries an id. */
export const OVERLAY_FRAME_TITLE = " WEAVE · CHILD INSPECTOR ";

/** Clears any background or inverse a content row left open before the edge. */
const FRAME_RESET = "\u001B[0m";

/** Columns the transcript gives up to the marker gutter while search is open. */
export const OVERLAY_SEARCH_INSET = 2;

/** Rail key column. Fixed, so every rail value starts on one column. */
export const OVERLAY_MATRIX_KEY = 8;

/** The inverse badge that opens the identity row. */
export const OVERLAY_CHILD_BADGE = " CHILD ";

/** The separator between header facts. */
export const OVERLAY_HEADER_SEP = " · ";

/** Matches the rail search lists at most this many rows before folding. */
export const OVERLAY_SEARCH_LIST_MAX = 3;

/**
 * What the search rail promises the keyboard, richest first.
 *
 * The full sentence is the contract; the narrower rungs exist only so a rail
 * at its minimum width still states BOTH actions rather than cutting one of
 * them off mid-word. The indent is the first thing to go, because alignment is
 * worth less than the words.
 */
export const OVERLAY_SEARCH_KEY_HINT = "Enter jump · Esc close search";
const OVERLAY_SEARCH_KEY_HINT_LADDER: readonly string[] = [
  `  ${OVERLAY_SEARCH_KEY_HINT}`,
  OVERLAY_SEARCH_KEY_HINT,
  "Enter jump · Esc close",
  "Enter · Esc",
];

/** What an absent operational fact prints. Never a fabricated zero. */
export const OVERLAY_UNKNOWN = "—";

/**
 * Canonical order of every fact the Session Header may print.
 *
 * {@link composeSessionHeader} reports the facts it printed in this order
 * whatever the width did to the rows, so a test can assert the model always
 * sits between the child's name and its role.
 */
export const OVERLAY_HEADER_FACT_ORDER = [
  "child-badge-name",
  "model",
  "role",
  "title",
  "parent",
  "plan",
  "task",
  "subtask",
] as const;

export type OverlayHeaderFactId = (typeof OVERLAY_HEADER_FACT_ORDER)[number];

/** Width bands the header degrades through. Measured, never guessed. */
export type OverlayHeaderTier = "wide" | "mid" | "tight";

export function overlayHeaderTier(width: number): OverlayHeaderTier {
  if (width >= 96) return "wide";
  if (width >= 62) return "mid";
  return "tight";
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/**
 * THE HEADER'S COMPLETE VOCABULARY.
 *
 * There is no telemetry group and no child-id field, so status, elapsed, turn,
 * run, queue, tokens, cost, live activity, and a bounded child hint are
 * unreachable from here. Every field except the name and the bounded title is
 * optional, because an unknown fact is absent rather than invented.
 */
export interface OverlayHeaderFacts {
  /** The child agent's name. Never dropped. */
  readonly name: string;
  /** The child's model. Row 1 only, immediately after the name. Never right. */
  readonly model?: string;
  /** The child's role, when the session configured one. Never invented. */
  readonly role?: string;
  /** The bounded task title. Never dropped; identity grows a row instead. */
  readonly boundedTitle: string;
  /** The parent agent that delegated this child. */
  readonly parent?: string;
  readonly plan?: string;
  /** `task 3/8 · <title>` — the caller composes it; the header only places it. */
  readonly taskCrumb?: string;
  readonly subtask?: string;
}

/**
 * Every operational fact the Status Matrix rail exposes.
 *
 * Reading them from one place is what lets the header and the prompt stay
 * quiet: nothing they drop is actually lost. `errorDetail` is the ONE place
 * captured failure text may land, and the caller is responsible for having
 * sanitized it before it arrives.
 */
export interface OverlayRailFacts {
  readonly status: string;
  readonly tone: Tone;
  readonly elapsed?: string;
  readonly turn?: string;
  readonly run?: string;
  readonly branch?: string;
  /** What the child is doing right now, in the caller's safe words. */
  readonly live?: string;
  readonly tool?: string;
  readonly target?: string;
  readonly args?: string;
  /** Progress line, result line, or failure line of the latest tool. */
  readonly toolOutcome?: string;
  readonly toolTone: Tone;
  readonly failed: boolean;
  /** Safe, already-sanitized tool-error detail. Never environment or secrets. */
  readonly errorDetail?: string;
  readonly queueCount: number;
  readonly firstQueued?: string;
  readonly tokensIn?: string;
  readonly tokensOut?: string;
  readonly cost?: string;
}

/**
 * Everything the prompt may say.
 *
 * `draft` is read only while the child is live, so a settled child can never be
 * shown an editable field or a caret. There is no raw error text here: the
 * failure detail stays on the rail.
 */
export interface OverlayPromptFacts {
  readonly target: string;
  readonly turn?: number;
  /** Settled: read-only. No steer, no queue, nothing to cancel. */
  readonly settled: boolean;
  /** The latest tool failed. The child is still alive. */
  readonly failed: boolean;
  readonly queueCount: number;
  /** The live draft. Ignored entirely once the child has settled. */
  readonly draft: string;
  /** The state word the frame marker and the rail also print. */
  readonly stateWord: string;
  /** The cancel confirmation is open; it replaces the editor. */
  readonly confirmingCancel: boolean;
  /** What a settled field says. Defaults to the read-only notice. */
  readonly settledNotice?: string;
}

/** One occurrence of the query in one already-rendered transcript row. */
export interface OverlayNavMatch {
  /** 1-based position in the ordered match list. */
  readonly ordinal: number;
  /** Row index in the painted transcript block. */
  readonly row: number;
  /** What the owning event is called in a match list. */
  readonly label: string;
  /** When the owning event happened, in the caller's own words. */
  readonly at: string;
  /** ANSI-free row text, collapsed to one line. */
  readonly snippet: string;
}

/**
 * One transcript row, painted and in its ANSI-free twin.
 *
 * The twin is what the match list is built from, so no byte of transcript
 * colour can paint the search rail.
 */
export interface OverlayNavRow {
  readonly painted: string;
  readonly plain: string;
  readonly label: string;
  readonly at?: string;
}

/**
 * Everything the locked search may say.
 *
 * It has no prompt, no rail telemetry and no settlement facts, which is the
 * structural reason search cannot become a second status surface.
 */
export interface OverlayNavFacts {
  readonly open: boolean;
  /** A jump was accepted; the anchor outlives the search UI. */
  readonly accepted: boolean;
  readonly query: string;
  readonly matches: readonly OverlayNavMatch[];
  readonly total: number;
  /** 1-based ordinal, or 0 when nothing matched. */
  readonly current: number;
  readonly currentMatch: OverlayNavMatch | undefined;
  /** `2/5`, or `0/0` when nothing matched. */
  readonly counter: string;
  /** `assistant 2 · tool 1` — where the matches are, by label. */
  readonly summary: string;
  readonly empty: boolean;
  /** Transcript rows carrying a match. Used by the marker gutter. */
  readonly rows: ReadonlySet<number>;
  /** Row the transcript window anchors on, or undefined when it does not. */
  readonly anchorRow: number | undefined;
}

/** The six conditions a child can be in. */
export type OverlaySettlementPhase =
  | "live"
  | "queued"
  | "failed"
  | "completed"
  | "cancelled"
  | "recovering";

/**
 * Everything settlement derives, and all of it.
 *
 * No headline, no reason prose, no action set: the frame marker, the rail and
 * the prompt are the only surfaces, and they own their own wording.
 */
export interface OverlaySettlementFacts {
  readonly phase: OverlaySettlementPhase;
  /** No further child work is possible. Drives the read-only prompt. */
  readonly settled: boolean;
  readonly word: string;
  readonly glyph: string;
  readonly tone: Tone;
}

/** THE ONE CONSTRUCTOR, read by the frame marker and by the prompt. */
export function overlaySettlementFacts(
  phase: OverlaySettlementPhase,
  word?: string,
): OverlaySettlementFacts {
  return {
    phase,
    settled: phase === "completed" || phase === "cancelled",
    word: boundedWord(word ?? defaultStateWord(phase)),
    glyph: settlementGlyph(phase),
    tone: settlementTone(phase),
  };
}

function defaultStateWord(phase: OverlaySettlementPhase): string {
  switch (phase) {
    case "completed":
      return "COMPLETED";
    case "failed":
      return "TOOL ERROR";
    case "cancelled":
      return "CANCELLED";
    case "recovering":
      return "RECOVERING";
    case "queued":
      return "STEERED";
    default:
      return "RUNNING";
  }
}

function settlementTone(phase: OverlaySettlementPhase): Tone {
  switch (phase) {
    case "completed":
      return "ok";
    case "failed":
      return "bad";
    case "cancelled":
      return "warn";
    case "queued":
      return "warn";
    default:
      return "run";
  }
}

/** A printed mark, so a state reads on a monochrome terminal too. */
function settlementGlyph(phase: OverlaySettlementPhase): string {
  switch (phase) {
    case "completed":
      return "✔";
    case "failed":
      return "✖";
    case "cancelled":
      return "⊘";
    case "recovering":
      return "↻";
    case "queued":
      return "↯";
    default:
      return "●";
  }
}

function boundedWord(word: string): string {
  const clean = safeTrim(word);
  return clean.length === 0 ? "RUNNING" : clean;
}

// ---------------------------------------------------------------------------
// Small shared parts
// ---------------------------------------------------------------------------

/** Repeats a literal one-column glyph. Never called with untrusted text. */
function repeatGlyph(character: string, count: number): string {
  const repeats = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return repeats > 0 ? character.repeat(repeats) : "";
}

/** The inner separator rule. Muted, never the frame ink. */
export function overlayRuleRow(paint: Paint, width: number): string {
  return cell(paint.rule(repeatGlyph("─", width)), width);
}

/** A rail section heading: the title, then a muted rule to the edge. */
export function overlaySectionHead(
  paint: Paint,
  title: string,
  width: number,
): string {
  const label = safeTrim(title);
  const rule = Math.max(0, width - measureWidth(label) - 1);
  return cell(
    `${paint.muted(label)} ${paint.rule(repeatGlyph("─", rule))}`,
    width,
  );
}

/**
 * Cuts a FIXED-FIELD cell flush, without a cut mark.
 *
 * One line, one `…`. The transcript pane and the Status Matrix rail share a
 * line, so if both marked their own cut the reader would see two marks for one
 * line. Prose keeps the mark, because prose is where lost words matter;
 * the rail's key/value cells and its match list — bounded, repeated, and one
 * resize away from being whole again — cut flush instead.
 *
 * Only ever called with already-sanitized, ANSI-free text, which is what makes
 * {@link truncatePlainToWidth} the right cutter here.
 */
function fitFieldToWidth(text: string, width: number): string {
  return truncatePlainToWidth(text, width, "");
}

/** The value an absent operational fact prints. */
function factValue(value: string | undefined): string {
  if (value === undefined) return OVERLAY_UNKNOWN;
  const clean = safeTrim(value);
  return clean.length === 0 ? OVERLAY_UNKNOWN : clean;
}

/** Joins present pieces with `·`, or reports the fact as unknown. */
function joinFacts(pieces: ReadonlyArray<string | undefined>): string {
  const kept = pieces
    .map((piece) => (piece === undefined ? "" : safeTrim(piece)))
    .filter((piece) => piece.length > 0);
  return kept.length === 0 ? OVERLAY_UNKNOWN : kept.join(" · ");
}

// ---------------------------------------------------------------------------
// The Session Header
// ---------------------------------------------------------------------------

interface HeaderPart {
  readonly id: OverlayHeaderFactId;
  /** Painted, ready-to-place text. */
  readonly text: string;
  readonly width: number;
}

interface HeaderRow {
  readonly lines: readonly string[];
  readonly facts: readonly OverlayHeaderFactId[];
}

/** The header, plus the facts it actually printed in canonical order. */
export interface ComposedOverlayHeader {
  readonly lines: readonly string[];
  readonly facts: readonly OverlayHeaderFactId[];
}

function headerPart(id: OverlayHeaderFactId, painted: string): HeaderPart {
  return { id, text: painted, width: measureWidth(painted) };
}

/**
 * Fills a row in priority order and stops at the first fact that does not fit,
 * recording which facts survived.
 *
 * A squeezed row therefore loses its LAST fact instead of truncating its first.
 */
function joinParts(
  parts: readonly HeaderPart[],
  width: number,
  separator: string,
): { line: string; kept: OverlayHeaderFactId[] } {
  const separatorWidth = measureWidth(separator);
  const out: string[] = [];
  const kept: OverlayHeaderFactId[] = [];
  let used = 0;
  for (const part of parts) {
    if (part.width === 0) continue;
    const add = (out.length === 0 ? 0 : separatorWidth) + part.width;
    if (used + add > width) break;
    out.push(part.text);
    kept.push(part.id);
    used += add;
  }
  return { line: out.join(separator), kept };
}

function partsWidth(
  parts: readonly HeaderPart[],
  separatorWidth: number,
): number {
  const present = parts.filter((part) => part.width > 0);
  if (present.length === 0) return 0;
  return (
    present.reduce((sum, part) => sum + part.width, 0) +
    separatorWidth * (present.length - 1)
  );
}

function identityParts(
  paint: Paint,
  facts: OverlayHeaderFacts,
): readonly HeaderPart[] {
  const name = safeTrim(facts.name);
  const badge = `${paint.inv(paint.acc(OVERLAY_CHILD_BADGE))} ${paint.bold(name)}`;
  const model = safeTrim(facts.model ?? "");
  const role = safeTrim(facts.role ?? "");
  const title = safeTrim(facts.boundedTitle);
  // Order is the locked amendment: the model rides with the name, never right.
  return [
    headerPart("child-badge-name", badge),
    headerPart("model", model.length > 0 ? paint.alt(model) : ""),
    headerPart("role", role.length > 0 ? paint.dim(role) : ""),
    headerPart("title", title.length > 0 ? paint.text(title) : ""),
  ];
}

/** Budget for the right-hand side of a header row. Mirrors {@link rowLR}. */
function rightBudget(width: number): number {
  return Math.max(8, Math.floor(width * 0.6));
}

/**
 * ROW 1 — the identity cluster, all of it on the left: badge, name, model,
 * role, bounded task title.
 *
 * The identity grows to two rows before a narrow width may take the title,
 * which is the one identity fact no width is allowed to drop.
 */
export function headerIdentityRow(
  paint: Paint,
  facts: OverlayHeaderFacts,
  width: number,
): HeaderRow {
  const separator = paint.rule(OVERLAY_HEADER_SEP);
  const separatorWidth = measureWidth(OVERLAY_HEADER_SEP);
  const parts = identityParts(paint, facts);
  const badge = parts[0] as HeaderPart;
  const title = parts[3] as HeaderPart;

  if (partsWidth(parts, separatorWidth) <= width) {
    const row = joinParts(parts, width, separator);
    return { lines: [cell(row.line, width)], facts: row.kept };
  }

  // Two-row identity: as much of badge · name · model · role as fits, with the
  // task title on its own row underneath. The title is never surrendered.
  const top = joinParts(parts.slice(0, 3), width, separator);
  const kept: OverlayHeaderFactId[] =
    top.kept.length > 0 ? top.kept : ["child-badge-name"];
  const topLine =
    top.kept.length > 0 ? top.line : fitLineToWidth(badge.text, width);
  return {
    lines: [
      cell(topLine, width),
      cell(fitLineToWidth(title.text, width), width),
    ],
    facts: [...kept, "title"],
  };
}

/**
 * ROW 2 — provenance and plan context.
 *
 * The breadcrumb sheds its subtask, then its plan name, as the row narrows;
 * provenance leads because the rail never says who delegated the child.
 */
export function headerContextRow(
  paint: Paint,
  facts: OverlayHeaderFacts,
  width: number,
): HeaderRow | undefined {
  const separator = paint.rule(OVERLAY_HEADER_SEP);
  const tier = overlayHeaderTier(width);
  const parentName = safeTrim(facts.parent ?? "");
  const parent =
    parentName.length > 0
      ? `${paint.dim("delegated by")} ${paint.alt(parentName)}`
      : "";
  const crumbRoom = Math.max(
    0,
    width -
      measureWidth(parent) -
      (parent.length > 0 ? measureWidth(OVERLAY_HEADER_SEP) : 0),
  );
  const plan = safeTrim(facts.plan ?? "");
  const task = safeTrim(facts.taskCrumb ?? "");
  const subtask = safeTrim(facts.subtask ?? "");
  const planPart = headerPart("plan", plan.length > 0 ? paint.muted(plan) : "");
  const taskPart = headerPart("task", task.length > 0 ? paint.text(task) : "");
  const subtaskPart = headerPart(
    "subtask",
    subtask.length > 0 ? paint.dim(subtask) : "",
  );
  const crumbParts = crumbPartsForTier(tier, planPart, taskPart, subtaskPart);
  const crumb = joinParts(crumbParts, crumbRoom, ` ${paint.rule("›")} `);
  const pieces = [parent, crumb.line].filter((piece) => piece.length > 0);
  if (pieces.length === 0) return undefined;
  return {
    lines: [cell(pieces.join(separator), width)],
    facts: [...(parent.length > 0 ? (["parent"] as const) : []), ...crumb.kept],
  };
}

/** The breadcrumb each width band may print. Narrow bands say less, not less clearly. */
function crumbPartsForTier(
  tier: OverlayHeaderTier,
  plan: HeaderPart,
  task: HeaderPart,
  subtask: HeaderPart,
): readonly HeaderPart[] {
  if (tier === "tight") return [task];
  if (tier === "mid") return [plan, task];
  return [plan, task, subtask];
}

/**
 * The overlay's ONE header.
 *
 * Identity is always kept whole; the context row is what a vertically starved
 * overlay loses, so a starved terminal drops provenance before it drops the
 * child. Nothing here is state-derived, so the bytes are identical in every
 * child state.
 */
export function composeSessionHeader(
  paint: Paint,
  facts: OverlayHeaderFacts,
  width: number,
): ComposedOverlayHeader {
  const identity = headerIdentityRow(paint, facts, width);
  const context = headerContextRow(paint, facts, width);
  const printed = new Set<OverlayHeaderFactId>([
    ...identity.facts,
    ...(context?.facts ?? []),
  ]);
  return {
    lines: [...identity.lines, ...(context?.lines ?? [])],
    facts: OVERLAY_HEADER_FACT_ORDER.filter((id) => printed.has(id)),
  };
}

/**
 * The one row the header may never lose when the overlay is vertically starved.
 *
 * It keeps the two identity facts the full header also refuses to drop — WHO
 * this is and WHAT it was given. The frame marker above and the compact matrix
 * below still carry status, elapsed, queue and cost.
 */
export function identitySafetyRow(
  paint: Paint,
  facts: OverlayHeaderFacts,
  width: number,
): string[] {
  const parts = identityParts(paint, facts);
  const badge = parts[0] as HeaderPart;
  const title = parts[3] as HeaderPart;
  const core =
    badge.width +
    (title.width > 0 ? measureWidth(OVERLAY_HEADER_SEP) + title.width : 0);
  if (core <= width) {
    return [
      rowLR(badge.text, fitLineToWidth(title.text, rightBudget(width)), width),
    ];
  }
  return [
    cell(badge.text, width),
    cell(fitLineToWidth(title.text, width), width),
  ];
}

// ---------------------------------------------------------------------------
// The Status Matrix rail
// ---------------------------------------------------------------------------

/** One aligned key/value row. The key column is fixed at every width. */
export function matrixRow(
  paint: Paint,
  key: string,
  value: string,
  width: number,
  ink: (text: string) => string = (text) => paint.text(text),
): string {
  const valueWidth = Math.max(1, width - OVERLAY_MATRIX_KEY - 1);
  return cell(
    `${paint.dim(
      cell(
        fitFieldToWidth(safeTrim(key), OVERLAY_MATRIX_KEY),
        OVERLAY_MATRIX_KEY,
      ),
    )} ${ink(fitFieldToWidth(safeTrim(value), valueWidth))}`,
    width,
  );
}

function queueText(facts: OverlayRailFacts): string {
  return facts.queueCount === 0
    ? "queue empty"
    : `queue ${facts.queueCount} · ${factValue(facts.firstQueued)}`;
}

/**
 * One aligned key/value matrix, grouped by LIFECYCLE (where the run is), WORK
 * (what it is doing) and SPEND (what it costs).
 *
 * Values share a column, so one child at two moments can be compared by eye. A
 * failing tool raises an inverse alert pair ABOVE the matrix, so an error never
 * has to be found inside a grid — and `extraSections` (the SEARCH section) can
 * never demote that alert.
 */
export function renderRailStatusMatrix(
  paint: Paint,
  facts: OverlayRailFacts,
  rail: number,
  room: number,
  extraSections: ReadonlyArray<readonly string[]> = [],
): string[] {
  const bad = (text: string): string => paint.bad(text);
  const tool = factValue(facts.tool);
  const outcome = factValue(facts.toolOutcome);
  const detail = safeTrim(facts.errorDetail ?? "");
  const alert: ReadonlyArray<readonly string[]> = facts.failed
    ? [
        [
          cell(
            paint.inv(
              paint.bad(cell(` ✖ ${safeTrim(facts.status)} · ${tool} `, rail)),
            ),
            rail,
          ),
          matrixRow(paint, "error", outcome, rail, bad),
          ...(detail.length > 0
            ? wrapPlain(detail, rail, 3).map((line) => cell(bad(line), rail))
            : []),
        ],
      ]
    : [];
  const lifecycle = [
    overlaySectionHead(paint, "LIFECYCLE", rail),
    matrixRow(paint, "status", facts.status, rail, (text) =>
      paintTone(paint, facts.tone, text),
    ),
    matrixRow(paint, "elapsed", factValue(facts.elapsed), rail),
    matrixRow(paint, "turn", factValue(facts.turn), rail),
    matrixRow(paint, "run", joinFacts([facts.run, facts.branch]), rail),
    matrixRow(paint, "live", factValue(facts.live), rail, (text) =>
      paintTone(paint, facts.tone, text),
    ),
  ];
  const work = [
    overlaySectionHead(paint, "WORK", rail),
    matrixRow(
      paint,
      "tool",
      tool,
      rail,
      facts.failed ? bad : (text) => paint.text(text),
    ),
    matrixRow(
      paint,
      facts.failed ? "failed" : "result",
      outcome,
      rail,
      (text) => paintTone(paint, facts.toolTone, text),
    ),
    matrixRow(paint, "target", factValue(facts.target), rail, (text) =>
      paint.dim(text),
    ),
    matrixRow(
      paint,
      "queue",
      String(Math.max(0, Math.floor(facts.queueCount))),
      rail,
      facts.queueCount > 0
        ? (text) => paint.warn(text)
        : (text) => paint.dim(text),
    ),
    matrixRow(paint, "next", factValue(facts.firstQueued), rail, (text) =>
      paint.muted(text),
    ),
    matrixRow(paint, "args", factValue(facts.args), rail, (text) =>
      paint.dim(text),
    ),
  ];
  const spend = [
    overlaySectionHead(paint, "SPEND", rail),
    matrixRow(paint, "cost", factValue(facts.cost), rail),
    matrixRow(paint, "in", factValue(facts.tokensIn), rail),
    matrixRow(paint, "out", factValue(facts.tokensOut), rail),
  ];
  return stackSections(
    [...alert, ...extraSections, lifecycle, work, spend],
    room,
  );
}

/**
 * Below `RAIL_GEOMETRY.min + TRANSCRIPT_MIN + 1` there is no rail.
 *
 * The matrix folds into dense full-width rows above the transcript, keeping its
 * aligned key column. It never drops status, tool or error, queue, elapsed or
 * cost, so the header and the prompt keep their subtraction even here.
 */
export function compactStatusMatrix(
  paint: Paint,
  facts: OverlayRailFacts,
  width: number,
): string[] {
  const tool = factValue(facts.tool);
  const outcome = factValue(facts.toolOutcome);
  const alert = facts.failed
    ? [
        matrixRow(paint, "error", `✖ ${tool} · ${outcome}`, width, (text) =>
          paint.bad(text),
        ),
      ]
    : [];
  return [
    ...alert,
    matrixRow(
      paint,
      "life",
      joinFacts([
        facts.status,
        facts.run,
        facts.branch,
        facts.turn === undefined ? undefined : `turn ${facts.turn}`,
        facts.elapsed,
      ]),
      width,
      (text) => paintTone(paint, facts.tone, text),
    ),
    matrixRow(
      paint,
      "work",
      joinFacts([facts.tool, facts.target, facts.toolOutcome]),
      width,
      (text) => paintTone(paint, facts.toolTone, text),
    ),
    matrixRow(paint, "queue", queueText(facts), width, (text) =>
      paint.warn(text),
    ),
    matrixRow(
      paint,
      "spend",
      joinFacts([
        facts.cost === undefined ? undefined : `cost ${facts.cost}`,
        facts.tokensIn === undefined ? undefined : `in ${facts.tokensIn}`,
        facts.tokensOut === undefined ? undefined : `out ${facts.tokensOut}`,
      ]),
      width,
      (text) => paint.dim(text),
    ),
    matrixRow(paint, "live", factValue(facts.live), width, (text) =>
      paintTone(paint, facts.tone, text),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Navigation and search
// ---------------------------------------------------------------------------

export interface OverlayNavInput {
  readonly query: string;
  readonly open: boolean;
  readonly accepted?: boolean;
  /** 1-based cursor. Clamped to the match count; 0 when nothing matched. */
  readonly current?: number;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

function navSummary(matches: readonly OverlayNavMatch[]): string {
  const counts = new Map<string, number>();
  for (const match of matches) {
    counts.set(match.label, (counts.get(match.label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => `${label} ${count}`)
    .join(" · ");
}

/**
 * Every occurrence of the query, in transcript order.
 *
 * Counting OCCURRENCES rather than rows is what makes the counter honest: a
 * wrapped paragraph that says the word twice reports two matches, and `n`
 * visits both. Matching runs on the caller's ANSI-free twin, sanitized again
 * here, so no byte of transcript colour can reach the search rail.
 */
export function overlayNavMatchList(
  rows: readonly OverlayNavRow[],
  query: string,
): readonly OverlayNavMatch[] {
  const needle = safeTrim(query).toLowerCase();
  if (needle.length === 0) return [];
  const matches: OverlayNavMatch[] = [];
  rows.forEach((row, index) => {
    const snippet = safeTrim(row.plain);
    const hits = countOccurrences(snippet.toLowerCase(), needle);
    for (let occurrence = 0; occurrence < hits; occurrence += 1) {
      matches.push({
        ordinal: matches.length + 1,
        row: index,
        label: safeTrim(row.label),
        at: safeTrim(row.at ?? ""),
        snippet,
      });
    }
  });
  return matches;
}

/** The complete search vocabulary, derived once from the ANSI-free twin. */
export function buildOverlayNavFacts(
  rows: readonly OverlayNavRow[],
  input: OverlayNavInput,
): OverlayNavFacts {
  const query = safeTrim(input.query);
  const matches = overlayNavMatchList(rows, query);
  const total = matches.length;
  const requested = Number.isFinite(input.current ?? 1)
    ? Math.floor(input.current ?? 1)
    : 1;
  const current = total === 0 ? 0 : Math.min(Math.max(1, requested), total);
  const currentMatch = current === 0 ? undefined : matches[current - 1];
  const accepted = input.accepted === true;
  const live = input.open || accepted;
  return {
    open: input.open,
    accepted,
    query,
    matches,
    total,
    current,
    currentMatch,
    counter: `${current}/${total}`,
    summary: total === 0 ? "no match in this transcript" : navSummary(matches),
    empty: total === 0,
    rows: new Set(matches.map((match) => match.row)),
    anchorRow: live ? currentMatch?.row : undefined,
  };
}

type MarkKind = "current" | "match" | "none";

function markKind(facts: OverlayNavFacts, row: number): MarkKind {
  if (facts.currentMatch !== undefined && facts.currentMatch.row === row)
    return "current";
  return facts.rows.has(row) ? "match" : "none";
}

function searchMarker(paint: Paint, kind: MarkKind): string {
  if (kind === "current") return `${paint.acc("▌")} `;
  if (kind === "match") return `${paint.dim("·")} `;
  return "  ";
}

/**
 * The two-column marker gutter beside the transcript.
 *
 * The painted rows were already produced at the inset width, so the row indices
 * in {@link OverlayNavFacts} are exactly the ones being marked: there is no
 * second layout to drift out of step with.
 */
export function markSearchGutter(
  paint: Paint,
  facts: OverlayNavFacts,
  painted: readonly string[],
  width: number,
): string[] {
  return painted.map((line, row) =>
    cell(
      `${cell(searchMarker(paint, markKind(facts, row)), OVERLAY_SEARCH_INSET)}${line}`,
      width,
    ),
  );
}

/**
 * THE ONLY HIGHLIGHTER.
 *
 * It takes plain text, sanitizes it again, clips it, and repaints the query
 * occurrences with the inverse accent, so a tool that printed an escape
 * sequence cannot paint the rail.
 */
export function highlightQuery(
  paint: Paint,
  raw: string,
  query: string,
  width: number,
  base: (text: string) => string = (text) => paint.text(text),
): string {
  const text = fitLineToWidth(safeTrim(raw), Math.max(0, width));
  const needle = safeTrim(query).toLowerCase();
  if (needle.length === 0) return base(text);
  const hay = text.toLowerCase();
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    if (at > from) out.push(base(text.slice(from, at)));
    out.push(paint.inv(paint.acc(text.slice(at, at + needle.length))));
    from = at + needle.length;
  }
  if (from < text.length) out.push(base(text.slice(from)));
  return out.join("");
}

/** The widest search hint this rail can print whole. Never a cut one. */
function searchKeyHint(rail: number): string {
  const floor = OVERLAY_SEARCH_KEY_HINT_LADDER[
    OVERLAY_SEARCH_KEY_HINT_LADDER.length - 1
  ] as string;
  return (
    OVERLAY_SEARCH_KEY_HINT_LADDER.find((rung) => measureWidth(rung) <= rail) ??
    floor
  );
}

/** The SEARCH section prepended to the Status Matrix while `/` is open. */
export function searchRailSections(
  paint: Paint,
  facts: OverlayNavFacts,
  rail: number,
): ReadonlyArray<readonly string[]> {
  const listed = facts.matches.slice(0, OVERLAY_SEARCH_LIST_MAX);
  const rows = listed.map((match) => {
    const plain = joinFacts([`${match.ordinal}. ${match.label}`, match.at]);
    const current = facts.currentMatch?.ordinal === match.ordinal;
    return cell(
      current
        ? paint.inv(
            paint.acc(
              cell(
                ` ▸ ${fitFieldToWidth(plain, Math.max(1, rail - 4))} `,
                rail,
              ),
            ),
          )
        : `${paint.dim("  ")}${paint.muted(
            fitFieldToWidth(plain, Math.max(1, rail - 2)),
          )}`,
      rail,
    );
  });
  const more =
    facts.total > listed.length
      ? [
          cell(
            paint.dim(`  +${facts.total - listed.length} more · n / N`),
            rail,
          ),
        ]
      : [];
  return [
    [
      overlaySectionHead(paint, "SEARCH", rail),
      matrixRow(paint, "query", facts.query, rail, (text) =>
        highlightQuery(paint, text, facts.query, rail),
      ),
      matrixRow(paint, "match", facts.counter, rail, (text) =>
        facts.empty ? paint.bad(text) : paint.acc(text),
      ),
      matrixRow(paint, "kinds", facts.summary, rail, (text) =>
        paint.muted(text),
      ),
      ...rows,
      ...more,
      cell(paint.dim(searchKeyHint(rail)), rail),
    ],
  ];
}

// ---------------------------------------------------------------------------
// The primary-like prompt
// ---------------------------------------------------------------------------

export type OverlayPromptKeyId =
  | "send"
  | "queue"
  | "cancel"
  | "search"
  | "close";

export interface OverlayPromptKey {
  readonly id: OverlayPromptKeyId;
  readonly key: string;
  readonly label: string;
  /** Consequence marker. `q` always carries `(confirm)`. */
  readonly note: string;
  readonly enabled: boolean;
  readonly danger: boolean;
}

/** What a settled field says when the caller names nothing more specific. */
export const OVERLAY_READ_ONLY_NOTICE = "read-only — this child has settled";

/**
 * The complete key set, and the only one.
 *
 * A settled child disables everything that would mutate it and keeps only
 * search and close.
 */
export function promptKeys(
  facts: OverlayPromptFacts,
): readonly OverlayPromptKey[] {
  const live = !facts.settled;
  return [
    {
      id: "send",
      key: "Enter",
      label: "steer",
      note: "",
      enabled: live,
      danger: false,
    },
    {
      id: "queue",
      key: "Alt+Enter",
      label: "queue",
      note: "",
      enabled: live,
      danger: false,
    },
    {
      id: "cancel",
      key: "q",
      label: "cancel",
      note: "(confirm)",
      enabled: live,
      danger: true,
    },
    {
      id: "search",
      key: "/",
      label: "search",
      note: "",
      enabled: true,
      danger: false,
    },
    {
      id: "close",
      key: "Esc",
      label: "close",
      note: "",
      enabled: true,
      danger: false,
    },
  ];
}

type NoteLevel = "all" | "danger" | "none";

/**
 * A disabled key carries a printed `✕`, not only a dim colour: a settled child
 * must read as unactionable on a monochrome terminal too.
 */
export function keyChip(
  paint: Paint,
  key: OverlayPromptKey,
  notes: NoteLevel,
): string {
  const body = key.enabled
    ? `${paint.acc(key.key)} ${paint.text(key.label)}`
    : `${paint.dim("✕")} ${paint.dim(key.key)} ${paint.dim(key.label)}`;
  const showNote =
    key.note !== "" && (notes === "all" || (notes === "danger" && key.danger));
  return showNote ? `${body} ${paint.dim(key.note)}` : body;
}

/**
 * The order a narrowing row gives keys up: `/ search` first, then
 * `Alt+Enter queue`, then `q cancel`.
 *
 * `Enter` and `Esc` are the floor, because a control bar that cannot say how to
 * act or how to leave is not a control bar. Nothing here changes what the keys
 * DO — only what the row has room to say about them.
 */
export function keyLadder(
  keys: readonly OverlayPromptKey[],
): ReadonlyArray<readonly OverlayPromptKey[]> {
  const without = (
    list: readonly OverlayPromptKey[],
    id: OverlayPromptKeyId,
  ): readonly OverlayPromptKey[] => list.filter((key) => key.id !== id);
  const second = without(keys, "search");
  const third = without(second, "queue");
  return [keys, second, third, without(third, "cancel")];
}

/**
 * One row of key chips.
 *
 * It sheds ordinary notes first, then the danger note, and only then whole
 * chips, in {@link keyLadder} order, so `q cancel (confirm)` keeps its
 * consequence marker far longer than `/ search` keeps its place. The
 * confirmation itself is enforced by {@link renderPromptGroup}, not by this row.
 */
export function keyLine(
  paint: Paint,
  keys: readonly OverlayPromptKey[],
  width: number,
): string {
  const separator = paint.rule(" · ");
  const ladder = keyLadder(keys);
  for (const rung of ladder) {
    for (const level of ["all", "danger", "none"] as const) {
      const line = rung
        .map((key) => keyChip(paint, key, level))
        .join(separator);
      if (measureWidth(line) <= width) return line;
    }
  }
  const floor = ladder[ladder.length - 1] ?? keys;
  return joinFit(
    floor.map((key) => keyChip(paint, key, "none")),
    width,
    separator,
  );
}

function pickKeys(
  facts: OverlayPromptFacts,
  ids: readonly OverlayPromptKeyId[],
): readonly OverlayPromptKey[] {
  const all = promptKeys(facts);
  return ids
    .map((id) => all.find((key) => key.id === id))
    .filter((key): key is OverlayPromptKey => key !== undefined);
}

/**
 * The input line, and the only one.
 *
 * A settled child is resolved here, once: it reads its notice, in the dim ink,
 * with no caret and no access to the draft at all.
 */
export function promptField(
  paint: Paint,
  facts: OverlayPromptFacts,
  width: number,
): string {
  const marker = facts.settled ? paint.dim("▪") : paint.acc("❯");
  const room = Math.max(1, width - 3);
  const source = facts.settled
    ? (facts.settledNotice ?? OVERLAY_READ_ONLY_NOTICE)
    : facts.draft;
  const text = fitLineToWidth(safeTrim(source), room);
  return facts.settled
    ? `${marker} ${paint.dim(text)}`
    : `${marker} ${paint.text(text)}${paint.inv(" ")}`;
}

/**
 * The editor panel is drawn in the MUTED rule colour on purpose: the overlay
 * owns exactly one high-contrast frame, and this inner surface never competes
 * with it.
 */
function panelTop(paint: Paint, label: string, width: number): string {
  if (width < 6) return cell(paint.rule(repeatGlyph("─", width)), width);
  const inner = width - 2;
  // The label is composed from already-sanitized parts by `promptLabel`, so its
  // deliberate leading and trailing space survives the fit.
  const text = fitLineToWidth(label, Math.max(0, inner - 2));
  const rule = Math.max(0, inner - measureWidth(text) - 1);
  return cell(
    `${paint.rule("╭─")}${paint.muted(text)}${paint.rule(
      repeatGlyph("─", rule),
    )}${paint.rule("╮")}`,
    width,
  );
}

function panelRow(paint: Paint, body: string, width: number): string {
  if (width < 6) return cell(body, width);
  return cell(
    `${paint.rule("│")} ${cell(body, width - 3)}${paint.rule("│")}`,
    width,
  );
}

function panelBottom(paint: Paint, width: number): string {
  if (width < 4) return cell(paint.rule(repeatGlyph("─", width)), width);
  return cell(
    `${paint.rule("╰")}${paint.rule(repeatGlyph("─", width - 2))}${paint.rule("╯")}`,
    width,
  );
}

/**
 * Columns the panel's own border and left gutter take from a body row.
 *
 * A caller that renders its own component into the panel — the live Pi editor
 * — must render at `width - OVERLAY_PROMPT_PANEL_INSET`, or the panel would
 * clip it. Exported so the geometry is stated once rather than rediscovered.
 */
export const OVERLAY_PROMPT_PANEL_INSET = 3;

/** Widths at or above this can afford the editor label's queue hint. */
const PROMPT_WIDE_LABEL = 78;

function promptLabel(facts: OverlayPromptFacts, width: number): string {
  const target = safeTrim(facts.target);
  const queueTag = facts.queueCount > 0 ? ` · ${facts.queueCount} queued` : "";
  const turnTag = facts.turn === undefined ? "" : ` · turn ${facts.turn}`;
  if (facts.settled) {
    return ` ${target} · ${safeTrim(facts.stateWord).toLowerCase()} · read-only `;
  }
  const lead = facts.failed
    ? `tool error · steer a retry into ${target}`
    : `steer ${target}`;
  return width >= PROMPT_WIDE_LABEL
    ? ` ${lead}${turnTag}${queueTag} · Alt+Enter queues instead `
    : ` ${lead}${turnTag}${queueTag} `;
}

/**
 * PI'S OWN EDITOR, BORROWED.
 *
 * A bordered input panel whose label names the target and the turn, over one
 * muted key row. Four rows at every width; the narrow ladder shortens the label
 * and then sheds key notes and trailing chips.
 */
export function promptPrimaryEditor(
  paint: Paint,
  facts: OverlayPromptFacts,
  width: number,
): string[] {
  return promptEditorPanel(
    paint,
    facts,
    [
      promptField(
        paint,
        facts,
        Math.max(1, width - OVERLAY_PROMPT_PANEL_INSET),
      ),
    ],
    width,
  );
}

/**
 * Is this one of the bare rules Pi's own editor draws above and below itself?
 *
 * A rule sanitizes to nothing at all. The editor's SCROLL edges
 * (`─── ↑ 3 more ───`) keep their words and are therefore not rules: they are
 * content, and the panel keeps them.
 */
function isEditorRuleRow(line: string): boolean {
  return safeTrim(line).length === 0;
}

/**
 * One host editor render, reduced to the text rows the prompt panel may hold.
 *
 * Pi 0.83's editor draws `[rule, ...text rows, rule]` and this overlay gives it
 * no autocomplete, so its own chrome is exactly the first and last rows. The
 * panel owns the prompt's border, so those rules are removed rather than drawn
 * twice. Both guards keep at least one row, so an unexpected shape degrades to
 * the editor's own output inside the panel rather than to an empty prompt.
 */
export function overlayEditorBodyRows(
  rendered: readonly string[],
  width: number,
): string[] {
  const rows = [...rendered];
  if (rows.length > 1 && isEditorRuleRow(rows[0] as string)) rows.shift();
  if (rows.length > 1 && isEditorRuleRow(rows.at(-1) as string)) rows.pop();
  return rows.map((line) => fitLineToWidth(line, width));
}

/**
 * The same locked panel, wrapped around body rows the caller painted.
 *
 * Production's live child types into Pi's own editor, which draws a bare rule
 * above and below its text and no side rails at all. Handing those rows to
 * this function is what keeps the live prompt the SAME bordered, labelled
 * panel a settled child gets, instead of an unlabelled underline at the bottom
 * of the overlay. The panel is drawn in the muted rule colour, so the overlay
 * still owns exactly one high-contrast frame.
 *
 * Body rows must already be painted at
 * `width - `{@link OVERLAY_PROMPT_PANEL_INSET} columns.
 */
export function promptEditorPanel(
  paint: Paint,
  facts: OverlayPromptFacts,
  body: readonly string[],
  width: number,
): string[] {
  const rows = body.length > 0 ? body : [""];
  return [
    panelTop(paint, promptLabel(facts, width), width),
    ...rows.map((line) => panelRow(paint, line, width)),
    panelBottom(paint, width),
    cell(
      keyLine(
        paint,
        pickKeys(facts, ["send", "queue", "cancel", "search", "close"]),
        width,
      ),
      width,
    ),
  ];
}

/**
 * The cancel confirmation.
 *
 * {@link renderPromptGroup} returns it INSTEAD of the editor, which is the
 * structural reason `q` can never cancel without a `y` / `n` answer.
 */
export function promptCancelConfirm(
  paint: Paint,
  facts: OverlayPromptFacts,
  width: number,
): string[] {
  const target = safeTrim(facts.target);
  const turnTag = facts.turn === undefined ? "" : ` at turn ${facts.turn}`;
  const question = facts.settled
    ? paint.warn("nothing to cancel — already settled")
    : paint.bad(`cancel ${target}${turnTag}?`);
  return [
    cell(
      `${question} ${paint.acc("y")} ${paint.dim("yes")} ${paint.rule(
        "·",
      )} ${paint.acc("n")} ${paint.dim("no")} ${paint.rule("·")} ${paint.dim(
        "Esc keep running",
      )}`,
      width,
    ),
  ];
}

/**
 * The overlay's only prompt entry point.
 *
 * It reads {@link OverlayPromptFacts} and nothing else — no nav facts, no rail
 * facts — so the prompt region is byte-identical with search open and closed.
 */
export function renderPromptGroup(
  paint: Paint,
  facts: OverlayPromptFacts,
  width: number,
): string[] {
  const rows = facts.confirmingCancel
    ? promptCancelConfirm(paint, facts, width)
    : promptPrimaryEditor(paint, facts, width);
  return rows.map((line) => cell(line, width));
}

// ---------------------------------------------------------------------------
// The transcript window
// ---------------------------------------------------------------------------

/** Rows below which the anchored window cannot state both directions. */
const ANCHORED_WINDOW_MIN = 5;

/** Shows the newest rows and states how many scrolled out of view. */
function scrollTail(
  paint: Paint,
  lines: readonly string[],
  width: number,
  room: number,
): string[] {
  if (room <= 0) return [];
  if (lines.length <= room) return fitTo(lines, room, "tail");
  const hidden = lines.length - (room - 1);
  return [
    cell(paint.muted(`↑ ${hidden} earlier row(s) · / to search`), width),
    ...lines.slice(hidden),
  ];
}

/**
 * THE SHARED TRANSCRIPT WINDOW.
 *
 * Without an anchor it shows the newest rows and states how many scrolled out.
 * With an anchor — set whenever search is open or a jump was accepted — it
 * centres the current match and states how much is above AND below, because a
 * reader who jumped into the middle of a transcript needs to know they are in
 * the middle.
 */
export function transcriptWindow(
  paint: Paint,
  lines: readonly string[],
  width: number,
  room: number,
  anchorRow: number | undefined,
): string[] {
  if (room <= 0) return [];
  if (lines.length <= room) return fitTo(lines, room, "tail");
  if (anchorRow === undefined || room < ANCHORED_WINDOW_MIN) {
    return scrollTail(paint, lines, width, room);
  }
  const body = room - 2;
  const start = Math.min(
    Math.max(0, anchorRow - Math.floor(body / 2)),
    Math.max(0, lines.length - body),
  );
  const later = lines.length - start - body;
  return [
    cell(
      paint.muted(
        start === 0
          ? "↑ top of transcript · anchored on the current match"
          : `↑ ${start} earlier row(s) · anchored on the current match`,
      ),
      width,
    ),
    ...lines.slice(start, start + body),
    cell(
      paint.muted(
        later <= 0 ? "↓ end of transcript" : `↓ ${later} later row(s)`,
      ),
      width,
    ),
  ];
}

// ---------------------------------------------------------------------------
// The outer frame
// ---------------------------------------------------------------------------

export interface OverlayFrameChrome {
  readonly title: string;
  readonly marker: string;
  readonly markerTone: Tone;
}

export function frameTop(
  paint: Paint,
  width: number,
  chrome: OverlayFrameChrome,
): string {
  if (width <= 0) return "";
  if (width < 4) {
    return fitLineToWidth(paint.frame(repeatGlyph("─", width)), width);
  }
  const inner = width - OVERLAY_FRAME_COLUMNS;
  const title = chrome.title;
  const marker = chrome.marker;
  const titleWidth = measureWidth(title);
  const markerWidth = measureWidth(marker);
  let body: string;
  if (inner >= titleWidth + markerWidth + 4) {
    const rule = inner - titleWidth - markerWidth - 2;
    body =
      paint.frame("─") +
      paint.bold(paint.frame(title)) +
      paint.frame(repeatGlyph("─", rule)) +
      paintTone(paint, chrome.markerTone, marker) +
      FRAME_RESET +
      paint.frame("─");
  } else if (inner >= titleWidth + 2) {
    body =
      paint.frame("─") +
      paint.bold(paint.frame(title)) +
      paint.frame(repeatGlyph("─", inner - titleWidth - 1));
  } else if (inner >= 6) {
    const short = fitLineToWidth(title.trim(), inner - 2);
    body =
      paint.frame("─") +
      paint.bold(paint.frame(short)) +
      paint.frame(
        repeatGlyph("─", Math.max(0, inner - measureWidth(short) - 1)),
      );
  } else {
    body = paint.frame(repeatGlyph("─", inner));
  }
  return clampToWidth(
    `${paint.frame("╭")}${body}${paint.frame("╮")}${FRAME_RESET}`,
    width,
  );
}

export function frameBottom(paint: Paint, width: number): string {
  if (width <= 0) return "";
  if (width < 4) {
    return fitLineToWidth(paint.frame(repeatGlyph("─", width)), width);
  }
  return clampToWidth(
    `${paint.frame("╰")}${paint.frame(
      repeatGlyph("─", width - OVERLAY_FRAME_COLUMNS),
    )}${paint.frame("╯")}${FRAME_RESET}`,
    width,
  );
}

/** Wraps one composed content row in the left and right border columns. */
function frameRow(paint: Paint, line: string, inner: number): string {
  return `${paint.frame("│")}${FRAME_RESET}${cell(line, inner)}${FRAME_RESET}${paint.frame("│")}${FRAME_RESET}`;
}

/** Applies the ONE high-contrast frame to fully composed overlay content. */
export function frameOverlay(
  paint: Paint,
  content: readonly string[],
  width: number,
  chrome: OverlayFrameChrome,
): string[] {
  if (width < 4) return content.map((line) => fitLineToWidth(line, width));
  const inner = width - OVERLAY_FRAME_COLUMNS;
  return [
    frameTop(paint, width, chrome),
    ...content.map((line) => clampToWidth(frameRow(paint, line, inner), width)),
    frameBottom(paint, width),
  ];
}

/**
 * Last-resort vertical guard.
 *
 * Overflow is removed from the MIDDLE and reported, so a starved terminal never
 * loses the prompt controls at the bottom and never hides rows silently.
 */
export function squeezeBody(
  paint: Paint,
  body: readonly string[],
  height: number,
  width: number,
): string[] {
  if (body.length <= height) return fitTo(body, height);
  if (height <= 2) return body.slice(body.length - height);
  const keepHead = 1;
  const dropped = body.length - height + 1;
  return [
    ...body.slice(0, keepHead),
    cell(paint.muted(`↕ ${dropped} row(s) hidden · resize to see more`), width),
    ...body.slice(keepHead + dropped),
  ];
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * The width the caller must render the transcript pane at.
 *
 * The search inset is taken off BEFORE the pane is produced, so the gutter row
 * indices and the match row indices can never drift apart.
 */
export interface OverlayPaneGeometry {
  /** Columns inside the outer frame. */
  readonly inner: number;
  /** The transcript column, gutter included. */
  readonly pane: number;
  /** The transcript column the caller renders into. */
  readonly transcript: number;
  /** The Status Matrix rail, or `undefined` when the rail folds. */
  readonly rail: number | undefined;
}

/**
 * Rows the composed body keeps even when it has less to say.
 *
 * The body shrinks to its content so the prompt stays attached to the
 * hierarchy above it, but it never shrinks to a peephole: a reader opening an
 * inspector on a child that has barely started still gets a usable transcript
 * window, and the surface does not resize on every one of its first events.
 */
export const OVERLAY_MIN_BODY_ROWS = 12;

/**
 * How many rows the composed body actually takes.
 *
 * It is what the body HAS to say — the transcript rows that exist, plus a
 * folded rail above them, or the side rail's own natural height — held between
 * {@link OVERLAY_MIN_BODY_ROWS} and the rows the caller can spare. Budgeting
 * the content rather than the canvas is what keeps a short transcript from
 * stranding the prompt at the bottom of a mostly empty overlay.
 */
export function overlayComposedBodyRows(input: {
  readonly transcript: number;
  readonly foldedRail: number;
  readonly rail: number;
  readonly room: number;
}): number {
  const need = Math.max(
    OVERLAY_MIN_BODY_ROWS,
    input.foldedRail + input.transcript,
    input.rail,
  );
  return Math.max(1, Math.min(input.room, need));
}

export function overlayPaneGeometry(
  width: number,
  searchOpen: boolean,
): OverlayPaneGeometry {
  const inner = Math.max(1, Math.floor(width) - OVERLAY_FRAME_COLUMNS);
  const split = splitRail(inner, RAIL_GEOMETRY, TRANSCRIPT_MIN);
  const pane = split.isOk() ? split.value.main : inner;
  const inset = searchOpen ? OVERLAY_SEARCH_INSET : 0;
  return {
    inner,
    pane,
    transcript: Math.max(1, pane - inset),
    rail: split.isOk() ? split.value.rail : undefined,
  };
}

/** The overlay, region by region. There is no banner and no footer. */
export interface OverlayRegions {
  /** The framed overlay, ready to hand to the host. */
  readonly lines: readonly string[];
  /** The Session Header and its rule. */
  readonly head: readonly string[];
  /** Transcript and rail, or their degraded foldings. */
  readonly main: readonly string[];
  /** The primary-like editor, or the cancel confirmation. */
  readonly prompt: readonly string[];
}

export interface OverlayComposeInput {
  readonly width: number;
  readonly height: number;
  readonly paint: Paint;
  readonly header: OverlayHeaderFacts;
  readonly rail: OverlayRailFacts;
  readonly prompt: OverlayPromptFacts;
  readonly nav: OverlayNavFacts;
  readonly settlement: OverlaySettlementFacts;
  /**
   * Already-painted transcript rows, produced at
   * {@link OverlayPaneGeometry.transcript} columns. This module paints no
   * transcript of its own.
   */
  readonly transcript: readonly string[];
  /** Overrides {@link OVERLAY_FRAME_TITLE}. Never carries an id. */
  readonly title?: string;
}

interface BodyParts {
  readonly head: readonly string[];
  readonly main: readonly string[];
  readonly prompt: readonly string[];
}

/**
 * The body: transcript left, Status Matrix rail right, prompt below the header.
 *
 * The prompt is produced FIRST, from prompt facts alone, so nothing the
 * transcript or the search does can move it.
 */
function composeBody(
  input: OverlayComposeInput,
  width: number,
  height: number,
): BodyParts {
  const paint = input.paint;
  const foot = renderPromptGroup(paint, input.prompt, width);

  const split = splitRail(width, RAIL_GEOMETRY, TRANSCRIPT_MIN);
  const paneWidth = split.isOk() ? split.value.main : width;
  const transcriptLines = input.nav.open
    ? markSearchGutter(paint, input.nav, input.transcript, paneWidth)
    : input.transcript;
  const anchorRow = input.nav.anchorRow;

  const head = [
    ...composeSessionHeader(paint, input.header, width).lines,
    overlayRuleRow(paint, width),
  ];

  const roomResult = reserveRows(height, head.length + foot.length);
  if (roomResult.isErr()) {
    // Vertically starved: the head collapses to the rows no header may lose —
    // the child's name and its bounded title. Status, elapsed, queue and cost
    // are NOT re-added here: the frame marker above and the compact matrix
    // below still carry them.
    const minimal = identitySafetyRow(paint, input.header, width);
    // The prompt is the last thing a starved terminal may lose. When it must be
    // cut to one row, keep the row that still says how to LEAVE.
    const escIndex = foot.reduce(
      (found, line, index) => (line.includes("Esc") ? index : found),
      -1,
    );
    const tightFoot =
      foot.length > 1 && height < minimal.length + foot.length + 1
        ? [foot[escIndex >= 0 ? escIndex : foot.length - 1] as string]
        : foot;
    const fallback = reserveRows(height, minimal.length + tightFoot.length);
    if (fallback.isErr()) {
      // One spare row still buys the rail's headline (status plus tool or
      // error), which beats spending it on a single transcript line.
      const spare = height - minimal.length - tightFoot.length;
      const headline =
        spare >= 1
          ? compactStatusMatrix(paint, input.rail, width).slice(0, spare)
          : [];
      return { head: minimal, main: headline, prompt: tightFoot };
    }
    return {
      head: minimal,
      main: transcriptWindow(
        paint,
        transcriptLines,
        width,
        fallback.value,
        anchorRow,
      ),
      prompt: tightFoot,
    };
  }
  const room = roomResult.value;

  if (split.isErr()) {
    // Degraded: the rail folds into dense rows above a single-column
    // transcript. It still owns every operational fact.
    const ops = compactStatusMatrix(paint, input.rail, width).slice(
      0,
      Math.max(0, room - 1),
    );
    const body = transcriptWindow(
      paint,
      transcriptLines,
      width,
      Math.max(0, room - ops.length - 1),
      anchorRow,
    );
    return {
      head,
      main: [...ops, overlayRuleRow(paint, width), ...body],
      prompt: foot,
    };
  }

  const { main: paneColumns, rail: railWidth } = split.value;
  // The SEARCH section rides the matrix's own `extraSections` capability, so
  // the matrix compresses its own groups around it instead of the transcript
  // losing rows — and the failure alert still outranks it.
  const extra = input.nav.open
    ? searchRailSections(paint, input.nav, railWidth)
    : [];
  const railLines = renderRailStatusMatrix(
    paint,
    input.rail,
    railWidth,
    room,
    extra,
  );
  const merged = joinColumns(
    [
      {
        lines: transcriptWindow(
          paint,
          transcriptLines,
          paneColumns,
          room,
          anchorRow,
        ),
        width: paneColumns,
      },
      { lines: fitTo(railLines, room, "head"), width: railWidth },
    ],
    room,
    paint.rule("│"),
  );
  return { head, main: merged, prompt: foot };
}

/**
 * The whole inspector, as a pure function of facts and a size.
 *
 * The regions are returned alongside the framed lines so a caller — or a test —
 * can assert that the header is byte-identical in every child state and that
 * the prompt is byte-identical with search open and closed.
 */
export function composeOverlayRegions(
  input: OverlayComposeInput,
): OverlayRegions {
  const paint = input.paint;
  const width = Math.max(1, Math.floor(input.width));
  const innerWidth = Math.max(1, width - OVERLAY_FRAME_COLUMNS);
  const innerHeight = Math.max(
    3,
    Math.floor(input.height) - OVERLAY_FRAME_ROWS,
  );
  const parts = composeBody(input, innerWidth, innerHeight);
  // Overflow is taken out of the transcript block, never out of the prompt, so
  // a starved terminal can still act on the child.
  const above = squeezeBody(
    paint,
    [...parts.head, ...parts.main],
    Math.max(1, innerHeight - parts.prompt.length),
    innerWidth,
  );
  // Keeping the tail preserves the prompt and the newest transcript rows when a
  // very short terminal starves the body.
  const content = fitTo([...above, ...parts.prompt], innerHeight, "tail");
  const chrome: OverlayFrameChrome = {
    title: input.title ?? OVERLAY_FRAME_TITLE,
    marker: ` ${input.settlement.glyph} ${input.settlement.word} `,
    markerTone: input.settlement.tone,
  };
  return {
    lines: frameOverlay(paint, content, width, chrome),
    head: parts.head,
    main: parts.main,
    prompt: parts.prompt,
  };
}

/** The framed overlay alone, for callers that do not need the regions. */
export function composeOverlay(input: OverlayComposeInput): string[] {
  return [...composeOverlayRegions(input).lines];
}
