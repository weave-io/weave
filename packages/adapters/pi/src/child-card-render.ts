/**
 * The delegation card renderer: bounded facts in, width-safe lines out.
 *
 * This module is pure. It reads {@link PiDelegationCardFacts}, which is already
 * sanitized and bounded by `child-card-model.ts`, and returns terminal lines
 * through {@link emit}, which is the only function in the adapter that turns
 * rows into output and the only one that clips. Nothing here reads a clock,
 * touches the host, or decides whether a child settled.
 *
 * Four geometric guarantees are structural rather than remembered:
 *
 * 1. **One frame.** {@link cardEdge} is the only producer of a corner glyph and
 *    {@link composeDelegationCard} calls it exactly twice — once open, once
 *    closed — so a card has one top edge, one bottom edge, and no corner
 *    inside it. Every interior row comes from {@link cardBody}.
 * 2. **Settlement changes words, not height.** The rail cell count depends on
 *    the width alone, and the body is always the assignment row plus the one
 *    Native Line, so a settled card is exactly as tall as the running card it
 *    replaced.
 * 3. **Affordances outlive numbers.** The footer measures the action side
 *    first and offers the telemetry side only what survives, so `Alt+I` is the
 *    last hint standing and a number can never outlive `Ctrl+O`.
 * 4. **The expanded region is a fixed budget.** One interior rule, one status
 *    strip, and exactly {@link CARD_VIEWPORT_ROWS} literal bottom transcript
 *    rows, at every width and in every state.
 * 5. **One line, one cut mark.** A composed line may carry at most one `…`.
 *    Prose — the assignment, the Native Line, a transcript row — keeps the
 *    mark, because prose is where a reader needs to know something was lost.
 *    Fixed-field cells beside it on the same line ({@link clipCell}: the rail's
 *    state word, child name and elapsed, and a transcript row's bounded head
 *    label) cut flush or drop whole, so two columns can never mark the same
 *    line twice.
 *
 * See `docs/specs/33-spec-pi-adapter/33-weave-ui-design.md` §1, and the
 * normative prototype `prototypes/weave-delegate-tool-grilling.ts`
 * (`cardEdge`, `cardBody`, `railPlan`, `railStatusFirst`, `assignmentRows`,
 * `nativeLine`, `cardFooter`, `composeEdge`, `detailRegion`, `childViewport`).
 */

import {
  CARD_TOOL_NAME,
  CARD_VIEWPORT_ROWS,
  type PiCardActivityKind,
  type PiCardRowKind,
  type PiCardViewportRow,
  type PiDelegationCardFacts,
} from "./child-card-model.js";
import { measureWidth, truncatePlainToWidth } from "./render-width.js";
import { type Ink, type Paint, plainPaint, toneInk } from "./ui-paint.js";
import {
  clipRow,
  emit,
  fill,
  fitRow,
  glyph,
  padRow,
  type Row,
  rowWidth,
  type Seg,
  safeTrim,
  seg,
} from "./ui-rows.js";

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The narrowest card this renderer will draw.
 *
 * Requests below it are clamped up rather than refused, so the width a rail
 * lays out for is always the width {@link emit} clips to and the frame can
 * never be cut in half.
 */
export const CARD_MIN_WIDTH = 12;

/** The rail column: one bar column plus the widest status word. */
export const CARD_RAIL_W = 10;

/** Gutter, divider, gutter — one column of air on each side of the rule. */
export const CARD_RAIL_DIVIDER_W = 3;

/** Below this body width the rail cannot pay for itself and identity folds. */
export const CARD_RAIL_MIN_BODY = 17;

/**
 * The body columns the rail must leave over its own width before it may print
 * its droppable cell. The state word and the child name always survive;
 * elapsed is the cell that leaves.
 */
export const CARD_RAIL_TIGHT_SLACK = 16;

/** The rail uses at most three cells. */
export const CARD_RAIL_CELL_MAX = 3;

/** The assignment budget: exactly one row, at every width, in every state. */
export const CARD_ASSIGNMENT_ROW_MAX = 1;

/** The Native Line budget: exactly one row, at every width, in every state. */
export const CARD_ACTIVITY_ROW_MAX = 1;

/** The hard row ceiling of the expanded region, the interior rule excluded. */
export const CARD_DETAIL_ROW_MAX = 12;

/** The floor the expanded region reaches, so it never reads as empty. */
export const CARD_DETAIL_ROW_MIN = 7;

/**
 * The rows the expanded region always spends: one status strip over
 * {@link CARD_VIEWPORT_ROWS} transcript rows.
 */
export const CARD_VIEWPORT_REGION_ROWS = CARD_VIEWPORT_ROWS + 1;

/** Interior columns below which viewport prose is clipped harder. */
const CARD_DETAIL_NARROW = 44;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Pi's own expand/collapse binding for tool output, so the hint is truthful. */
export const CARD_EXPAND_KEY = "Ctrl+O";

/** The inspect hint ladder, richest first. The bare key leaves last. */
export const CARD_INSPECT_HINT = "Alt+I inspect child";
export const CARD_INSPECT_HINT_MID = "Alt+I inspect";
export const CARD_INSPECT_HINT_MIN = "Alt+I";

/**
 * The streaming mark. A block element, so it is reachable only through
 * {@link glyph} and child text structurally cannot fake being live.
 */
const CARD_STREAM_MARK = "▍";

/** What the card says when the parent recorded no assignment sentence. */
export const CARD_NO_ASSIGNMENT = "no assignment recorded";

/** The status strip of the expanded viewport, in its two honest forms. */
export const CARD_VIEWPORT_LIVE = "LIVE · following bottom";
export const CARD_VIEWPORT_SETTLED = "AT BOTTOM · child settled";

/**
 * The Native Line glyph vocabulary.
 *
 * `✓` belongs to `reply`, which the fact model reserves for the
 * settlement-named output, so a collapsed row can never imply an answer the
 * settlement has not published.
 */
const ACTIVITY_GLYPH: Readonly<Record<PiCardActivityKind, string>> =
  Object.freeze({
    sent: "→",
    boot: "◇",
    think: "⤷",
    tool: "⏵",
    queue: "⇥",
    say: "▸",
    reply: "✓",
    error: "✕",
    cancel: "⊘",
  });

/** Prose ink per activity kind. `text` defers the glyph to the state's tone. */
const ACTIVITY_INK: Readonly<Record<PiCardActivityKind, Ink>> = Object.freeze({
  sent: "muted",
  boot: "muted",
  think: "think",
  tool: "text",
  queue: "warn",
  say: "text",
  reply: "text",
  error: "bad",
  cancel: "muted",
});

/** The child's own role gutters, as the viewport prints them. */
const ROW_GLYPH: Readonly<Record<PiCardRowKind, string>> = Object.freeze({
  boot: "·",
  msg: "▌",
  think: "✻",
  tool: "⚙",
  result: "⎿",
  queue: "↯",
  retry: "↺",
  error: "✖",
  settled: "✓",
});

/** Ink per viewport row kind. A failing row is visibly not a success. */
const ROW_INK: Readonly<Record<PiCardRowKind, Ink>> = Object.freeze({
  boot: "muted",
  msg: "text",
  think: "think",
  tool: "text",
  result: "muted",
  queue: "warn",
  retry: "warn",
  error: "bad",
  settled: "text",
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * The semantic role of a rendered row.
 *
 * Slots make the card checkable region by region: the expanded viewport owns
 * exactly one slot, `detail`, and every other slot belongs to the shell.
 */
export type PiCardSlot =
  | "frame-top"
  | "frame-bottom"
  | "rule"
  | "identity"
  | "task"
  | "activity"
  | "activity-detail"
  | "detail";

/**
 * One rendered row.
 *
 * `rail` and `body` are the two columns of a zipped body row, kept beside the
 * composed line on purpose: a taller rail shifts the body cells, so "the body
 * column did not change" can only be checked column by column.
 */
export interface PiCardRow {
  readonly slot: PiCardSlot;
  readonly row: Row;
  /** The rail cell on this row, when the row is a zipped body row. */
  readonly rail?: Row;
  /** The body cell on this row, when the row is a zipped body row. */
  readonly body?: Row;
}

/** What a caller must supply to turn facts into lines. */
export interface PiCardRenderOptions {
  readonly width: number;
  /** Pi's own expanded flag for this tool entry. */
  readonly expanded?: boolean;
  readonly paint: Paint;
}

/** The rail column sizing for one width, and what narrowing costs. */
export interface PiCardRailPlan {
  /** True where the rail must drop its elapsed cell. */
  readonly tight: boolean;
  readonly railW: number;
  /** True where the terminal cannot pay for a rail and identity folds. */
  readonly folded: boolean;
  readonly bodyW: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Renders one delegation card as width-safe lines.
 *
 * Total by construction: an unusable width is clamped, absent telemetry is
 * omitted rather than guessed at, and every line leaves through {@link emit}.
 */
export function renderDelegationCard(
  facts: PiDelegationCardFacts,
  options: PiCardRenderOptions,
): string[] {
  const width = normalizeCardWidth(options.width);
  return composeDelegationCard(facts, width, options.expanded === true).map(
    (row) => emit(row.row, width, options.paint),
  );
}

/**
 * The slot-tagged rows behind {@link renderDelegationCard}.
 *
 * Exported so a caller — and a test — can check the card region by region and
 * column by column instead of only line by line.
 */
export function composeDelegationCard(
  facts: PiDelegationCardFacts,
  width: number,
  expanded: boolean,
): readonly PiCardRow[] {
  const w = normalizeCardWidth(width);
  const inner = innerWidth(w);
  const plan = railPlan(w);
  const rows: PiCardRow[] = [edgeTop(w, cardTitle(facts), [])];

  if (plan.folded) {
    // The terminal cannot pay for a rail column, so identity folds into one
    // body row. This is the only place the card prints identity outside the
    // rail, and no footer may duplicate it.
    const identity = identityRow(facts, inner);
    rows.push({
      slot: "identity",
      row: cardBody(w, identity),
      body: identity,
    });
    rows.push(...zipBodyOnly(w, inner, facts));
  } else {
    rows.push(...zipRailAndBody(w, plan, facts));
  }

  // The shell owns the separator: it is drawn here, once, so the expanded
  // region can neither skip the rule nor draw a second one.
  if (expanded) {
    rows.push(ruleRow(w), ...detailRegion(w, facts));
  }
  rows.push(cardFooter(w, facts, expanded));
  return rows;
}

/**
 * The honest fallback: a bounded, framed card that states it has no facts.
 *
 * A render or parse failure must still occupy one framed entry, because an
 * empty entry reads as "the delegation did nothing" rather than "the card
 * could not be drawn". It claims no state, no telemetry, and no outcome.
 */
export function degradedDelegationCard(
  reason: string,
  options: PiCardRenderOptions = { width: 60, paint: plainPaint() },
): string[] {
  const width = normalizeCardWidth(options.width);
  const inner = innerWidth(width);
  const detail = safeTrim(reason);
  const rows: Row[] = [
    cardEdge(width, true, cardTitle(), []),
    cardBody(
      width,
      clipRow([seg("muted", "delegation card unavailable")], inner),
    ),
    cardBody(
      width,
      clipRow(
        [seg("dim", detail.length > 0 ? detail : "no reason recorded")],
        inner,
      ),
    ),
    cardEdge(width, false, [], [seg("dim", CARD_INSPECT_HINT_MIN)]),
  ];
  return rows.map((row) => emit(row, width, options.paint));
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/** `╭─ left ────── right ─╮` style edge, width-safe and right-droppable. */
export function cardEdge(
  width: number,
  open: boolean,
  left: Row,
  right: Row,
): Row {
  const lc = open ? "╭" : "╰";
  const rc = open ? "╮" : "╯";
  const remaining = Math.max(0, width - 4); // corners plus the two rules
  if (remaining <= 2) return [glyph("rule", `${lc}${rc}`)];

  let l = clipRow(left, Math.max(0, remaining - 2));
  let r = clipRow(right, Math.max(0, remaining - rowWidth(l) - 4));
  let lw = rowWidth(l);
  let rw = rowWidth(r);
  let dashes = remaining - 2 - lw - (rw > 0 ? rw + 2 : 0);
  if (dashes < 1 && rw > 0) {
    r = [];
    rw = 0;
    dashes = remaining - 2 - lw;
  }
  if (dashes < 1) {
    l = clipRow(l, Math.max(0, remaining - 3));
    lw = rowWidth(l);
    dashes = Math.max(1, remaining - 2 - lw);
  }
  const out: Seg[] = [glyph("rule", `${lc}─`)];
  if (lw > 0) out.push(fill("rule", " ", 1), ...l, fill("rule", " ", 1));
  // An empty side takes no gutter: an edge with nothing to say is a plain rule.
  out.push(fill("rule", "─", dashes + (lw > 0 ? 0 : 2)));
  if (rw > 0) out.push(fill("rule", " ", 1), ...r, fill("rule", " ", 1));
  out.push(glyph("rule", `─${rc}`));
  return out;
}

/** One interior row: `│ …content padded to the inner width… │`. */
export function cardBody(width: number, content: Row): Row {
  const inner = innerWidth(width);
  return [
    glyph("rule", "│"),
    fill("rule", " ", 1),
    ...padRow(content, inner),
    fill("rule", " ", 1),
    glyph("rule", "│"),
  ];
}

/** A full-width interior separator. A rule, deliberately not a second frame. */
export function ruleRow(width: number): PiCardRow {
  const inner = Math.max(1, width - 4);
  return { slot: "rule", row: cardBody(width, [fill("rule", "─", inner)]) };
}

function edgeTop(width: number, left: Row, right: Row): PiCardRow {
  return { slot: "frame-top", row: cardEdge(width, true, left, right) };
}

function edgeBottom(width: number, left: Row, right: Row): PiCardRow {
  return { slot: "frame-bottom", row: cardEdge(width, false, left, right) };
}

function bodyRow(width: number, slot: PiCardSlot, content: Row): PiCardRow {
  return { slot, row: cardBody(width, content) };
}

/**
 * The card's top-edge left side: the tool, always. Settlement never writes a
 * verdict onto the frame.
 */
function cardTitle(facts?: PiDelegationCardFacts): Row {
  return [seg("alt", facts?.tool ?? CARD_TOOL_NAME)];
}

// ---------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------

/**
 * The rail column width for this card, and whether the droppable cell
 * survives.
 *
 * It takes the width and nothing else, so expanding the card cannot buy itself
 * room by squeezing the collapsed one.
 */
export function railPlan(width: number): PiCardRailPlan {
  const w = normalizeCardWidth(width);
  const inner = innerWidth(w);
  const tight =
    inner < CARD_RAIL_W + CARD_RAIL_MIN_BODY + CARD_RAIL_TIGHT_SLACK;
  const folded = inner < CARD_RAIL_W + CARD_RAIL_MIN_BODY;
  const bodyW = folded
    ? inner
    : Math.max(6, inner - CARD_RAIL_W - CARD_RAIL_DIVIDER_W);
  return { tight, railW: CARD_RAIL_W, folded, bodyW };
}

/** Gutter, divider, gutter. */
function railDivider(): Seg {
  return glyph("rule", " │ ");
}

/**
 * Status first: the state word is the loudest thing in the card, the child
 * name is second, and elapsed is third and droppable.
 *
 * The elapsed cell is always present at a width that pays for it, even when
 * the telemetry is not yet known, so the card's height is decided by the width
 * alone and cannot move when a usage event lands.
 */
export function railStatusFirst(
  facts: PiDelegationCardFacts,
  w: number,
  tight: boolean,
): readonly Row[] {
  const ink = toneInk(facts.tone);
  // Rail cells are fixed-field identity, so they cut flush: the one cut mark
  // this line may carry belongs to the body column beside them.
  const cells: Row[] = [
    [
      glyph(ink, "▌"),
      seg(ink, clipCell(facts.status.toUpperCase(), Math.max(1, w - 1))),
    ],
    [seg("text", clipCell(facts.agentName, w))],
  ];
  if (!tight) {
    const elapsed = facts.telemetry.elapsed;
    cells.push(elapsed === undefined ? [] : [seg("dim", clipCell(elapsed, w))]);
  }
  return cells.slice(0, CARD_RAIL_CELL_MAX);
}

/**
 * Folded identity, used only where the terminal cannot pay for a rail column.
 *
 * The top edge already names the tool, so this row carries the state and the
 * child alone — and it carries them in the rail's own order, state first, so
 * that the fact the rail exists to align is the last thing a clip can reach.
 * The ladder is richest first: state and child, then the state alone.
 */
export function identityRow(facts: PiDelegationCardFacts, bodyW: number): Row {
  const ink = toneInk(facts.tone);
  const state = facts.status.toUpperCase();
  const full: Row = [
    glyph(ink, "▌"),
    seg(ink, state),
    seg("dim", " · "),
    seg("text", facts.agentName),
  ];
  const fitted = fitRow(
    [full, [glyph(ink, "▌"), seg(ink, state)]],
    Math.max(0, bodyW),
  );
  // The floor keeps the bar and cuts the word flush. The bar is the state's
  // only colour-free signal, so it is the last thing the card gives up, and
  // cutting the word without a mark leaves this line's one `…` to the prose
  // rows below it.
  return fitted.length > 0
    ? fitted
    : [glyph(ink, "▌"), seg(ink, clipCell(state, Math.max(1, bodyW - 1)))];
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

/**
 * The task, richest first: the whole sentence, then its first sentence.
 *
 * Nothing here rewrites the parent's words. A rung only ever removes a
 * trailing sentence, and the clipped floor states its own loss with an
 * ellipsis, because a delegation card with no assignment is not a delegation
 * card.
 */
export function assignmentLadder(assignment: string): readonly Row[] {
  const full = safeTrim(assignment);
  if (full.length === 0) return [[seg("dim", CARD_NO_ASSIGNMENT)]];
  const head = firstSentence(full);
  const rungs = head === full ? [full] : [full, head];
  return rungs.map((text) => [seg("text", text)] as Row);
}

/** The first sentence of already-sanitized prose, or the whole of it. */
function firstSentence(text: string): string {
  const stop = text.indexOf(". ");
  if (stop <= 0) return text;
  return text.slice(0, stop + 1);
}

/**
 * Fit the assignment from its richest-first ladder. If not even the floor fits
 * — a card barely wider than its own frame — the task is clipped rather than
 * dropped.
 */
export function fitTask(
  candidates: readonly Row[],
  bodyW: number,
  fallback: string,
): readonly Row[] {
  const row = fitRow(candidates, Math.max(0, bodyW));
  if (row.length > 0) return [row];
  return [[seg("text", clipText(fallback, Math.max(2, bodyW)))]];
}

/** The assignment region: exactly one body row, at every width. */
export function assignmentRows(
  facts: PiDelegationCardFacts,
  bodyW: number,
): readonly Row[] {
  const text = safeTrim(facts.assignment);
  return fitTask(
    assignmentLadder(facts.assignment),
    bodyW,
    text.length > 0 ? text : CARD_NO_ASSIGNMENT,
  ).slice(0, CARD_ASSIGNMENT_ROW_MAX);
}

/**
 * Native Line: one semantic glyph plus the single most meaningful thing the
 * child has produced, and the streaming mark while that thing may still grow.
 *
 * It reads only the body width, never the terminal width and never the rail,
 * so two rails that leave the same number of body columns produce the same
 * row. It is the settled row too: settlement rewrites the sentence and adds no
 * row.
 */
export function nativeLine(
  facts: PiDelegationCardFacts,
  bodyW: number,
): readonly Row[] {
  const kind = facts.activity.kind;
  const ink = ACTIVITY_INK[kind];
  const live = facts.activity.live;
  // Reasoning is a bounded summary, and the card says so in words rather than
  // implying it with a glyph.
  const text =
    kind === "think" ? `summary · ${facts.activity.text}` : facts.activity.text;
  const body = clipText(text, Math.max(2, bodyW - (live ? 4 : 2)));
  const row: Seg[] = [
    seg(ink === "text" ? toneInk(facts.tone) : ink, `${ACTIVITY_GLYPH[kind]} `),
    seg(ink, body),
  ];
  if (live) row.push(seg("dim", " "), glyph("acc", CARD_STREAM_MARK));
  return [row];
}

/**
 * The body rows beneath the assignment. Exactly one, before and after
 * settlement, so a settled delegation costs the transcript what a running one
 * cost.
 */
function activityRows(
  facts: PiDelegationCardFacts,
  bodyW: number,
): readonly Row[] {
  const produced = nativeLine(facts, bodyW).slice(0, CARD_ACTIVITY_ROW_MAX);
  return produced.length > 0 ? produced : [[seg("dim", "")]];
}

/** The folded layout: no rail, so the body owns the whole inner width. */
function zipBodyOnly(
  width: number,
  inner: number,
  facts: PiDelegationCardFacts,
): readonly PiCardRow[] {
  const rows: PiCardRow[] = [];
  for (const row of assignmentRows(facts, inner)) {
    const body = clipRow(row, inner);
    rows.push({ slot: "task", row: cardBody(width, body), body });
  }
  for (const [index, content] of activityRows(facts, inner).entries()) {
    const body = clipRow(content, inner);
    rows.push({
      slot: index === 0 ? "activity" : "activity-detail",
      row: cardBody(width, body),
      body,
    });
  }
  return rows;
}

/**
 * The slot one zipped body row belongs to: the assignment rows first, then the
 * one Native Line, then the blank cells a taller rail leaves behind.
 */
function bodySlot(index: number, taskRows: number): PiCardSlot {
  if (index < taskRows) return "task";
  return index === taskRows ? "activity" : "activity-detail";
}

/** The ordinary layout: the rail column beside the body column. */
function zipRailAndBody(
  width: number,
  plan: PiCardRailPlan,
  facts: PiDelegationCardFacts,
): readonly PiCardRow[] {
  const cells = railStatusFirst(facts, plan.railW, plan.tight);
  const taskCells = assignmentRows(facts, plan.bodyW);
  const bodyCells: Row[] = [...taskCells, ...activityRows(facts, plan.bodyW)];
  const height = Math.max(cells.length, bodyCells.length);

  const rows: PiCardRow[] = [];
  for (let index = 0; index < height; index += 1) {
    const railCell = cells[index] ?? [];
    const bodyCell = bodyCells[index] ?? [];
    const slot = bodySlot(index, taskCells.length);
    const clippedBody = clipRow(bodyCell, plan.bodyW);
    rows.push({
      slot,
      row: cardBody(width, [
        ...padRow(railCell, plan.railW),
        railDivider(),
        ...clippedBody,
      ]),
      rail: railCell,
      body: clippedBody,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The footer
// ---------------------------------------------------------------------------

/**
 * The expand verb for this state. A live child expands; a settled child is
 * read, not resumed. No verb here ever implies retry, steer, or cancel.
 */
export function expandVerb(
  facts: PiDelegationCardFacts,
  expanded: boolean,
): string {
  if (expanded) return "collapse";
  return facts.settled ? "details" : "expand";
}

/** `Ctrl+O expand`, `Ctrl+O details`, `Ctrl+O collapse`. Always truthful. */
function expandHint(facts: PiDelegationCardFacts, expanded: boolean): string {
  return `${CARD_EXPAND_KEY} ${expandVerb(facts, expanded)}`;
}

/**
 * The action ladder: the two key hints, richest first, degrading to the bare
 * `Alt+I`. These two hints are the only hints the card can print, so a settled
 * footer structurally cannot offer retry, steer, resume, or cancel.
 */
export function actionLadder(
  facts: PiDelegationCardFacts,
  expanded: boolean,
): readonly Row[] {
  const hint = expandHint(facts, expanded);
  const pair = (left: string, right: string): Row => [
    seg("dim", left),
    seg("dim", " · "),
    seg("dim", right),
  ];
  return [
    pair(hint, CARD_INSPECT_HINT),
    pair(hint, CARD_INSPECT_HINT_MID),
    pair(CARD_EXPAND_KEY, CARD_INSPECT_HINT_MID),
    [seg("dim", CARD_INSPECT_HINT_MID)],
    [seg("dim", CARD_INSPECT_HINT_MIN)],
  ];
}

/**
 * `run 1 · reasoning`. The run descriptor uses the lifecycle phase, never the
 * status word — the rail owns that, and the footer is forbidden from printing
 * it a second time.
 */
export function runDescriptor(facts: PiDelegationCardFacts): string {
  const phase = safeTrim(facts.run.phase);
  const run = `run ${facts.run.number}`;
  return phase.length > 0 ? `${run} · ${phase}` : run;
}

/**
 * The telemetry ladder: run, phase, elapsed, tokens, cost — then less.
 *
 * An unknown figure is absent rather than zero, so a rung that would have
 * carried it simply loses that clause and duplicate rungs collapse away.
 */
export function telemetryLadder(
  facts: PiDelegationCardFacts,
): readonly string[] {
  const { elapsed, tokens, cost } = facts.telemetry;
  const run = runDescriptor(facts);
  const phase = safeTrim(facts.run.phase);
  const rungs = [
    [run, elapsed, tokens, cost],
    [run, elapsed, cost],
    [run, elapsed],
    [phase, elapsed],
    [elapsed],
  ].map((parts) =>
    parts.filter(
      (part): part is string => part !== undefined && part.length > 0,
    ),
  );
  const out: string[] = [];
  for (const rung of rungs) {
    const text = rung.join(" · ");
    if (text.length > 0 && out[out.length - 1] !== text) out.push(text);
  }
  return out;
}

/** Turn a ladder of plain strings into a ladder of one-segment rows. */
function inkLadder(ink: Ink, texts: readonly string[]): readonly Row[] {
  return texts.map((text) => [seg(ink, text)] as Row);
}

/**
 * Composes the bottom edge from a primary and a secondary side.
 *
 * The primary side is measured first and gets the columns it asks for; the
 * secondary side is offered only what is left, and the arithmetic mirrors
 * {@link cardEdge} exactly, so a fitted row can never push the frame out of
 * shape. The action side is always primary, which is the whole drop-order
 * guarantee in one line.
 *
 * The two budgets differ on purpose: {@link cardEdge} spends two extra rule
 * columns when its left side is empty, so a right-hand side can afford two
 * fewer columns than a left-hand one.
 */
export function composeEdge(
  width: number,
  primary: readonly Row[],
  secondary: readonly Row[],
  primarySide: "left" | "right",
): PiCardRow {
  const inner = innerWidth(width);
  const p = fitRow(
    primary,
    Math.max(0, inner - (primarySide === "left" ? 3 : 5)),
  );
  const pw = rowWidth(p);
  const budget = inner - 2 - (pw > 0 ? pw + 2 : 0) - 1;
  // If not even the primary fits, the secondary does not get the columns it
  // vacated: an edge that prints elapsed on a card too narrow for `Alt+I` has
  // inverted the drop order.
  const fitted = pw === 0 ? [] : fitRow(secondary, Math.max(0, budget));
  // Telemetry never outlives an affordance. Once the edge has degraded far
  // enough to lose `Ctrl+O`, whatever is left can only be numbers.
  const carriesExpand = [...p, ...fitted].some((s) =>
    s.t.includes(CARD_EXPAND_KEY),
  );
  const s = carriesExpand ? fitted : [];
  return primarySide === "left"
    ? edgeBottom(width, p, s)
    : edgeBottom(width, s, p);
}

/**
 * The footer region: exactly one bottom edge, at every width, in every state.
 *
 * Left: the run, the lifecycle phase, elapsed, tokens, and cost. Right:
 * `Ctrl+O expand · Alt+I inspect child`, with the action side measured first.
 * Settlement changes the expand verb and the numbers, never the shape.
 */
export function cardFooter(
  width: number,
  facts: PiDelegationCardFacts,
  expanded: boolean,
): PiCardRow {
  return composeEdge(
    width,
    actionLadder(facts, expanded),
    inkLadder("dim", telemetryLadder(facts)),
    "right",
  );
}

// ---------------------------------------------------------------------------
// The expanded region
// ---------------------------------------------------------------------------

/**
 * The expanded region: one status strip over exactly
 * {@link CARD_VIEWPORT_ROWS} literal bottom transcript rows.
 *
 * Nothing here is summarized, grouped, counted, or relabelled; the rows are
 * the fact model's own bottom slice, padded above so content sits on the
 * bottom exactly as it would on the child's own screen. The region is a fixed
 * budget clamped between {@link CARD_DETAIL_ROW_MIN} and
 * {@link CARD_DETAIL_ROW_MAX}.
 */
export function detailRegion(
  width: number,
  facts: PiDelegationCardFacts,
): readonly PiCardRow[] {
  const w = normalizeCardWidth(width);
  const inner = Math.max(6, w - 4);
  const narrow = inner < CARD_DETAIL_NARROW;
  const content: Row[] = [
    viewportStrip(facts),
    ...padAbove(
      facts.viewport.rows
        .slice(-CARD_VIEWPORT_ROWS)
        .map((row) => clipRow(viewportRow(row, inner, narrow), inner)),
      CARD_VIEWPORT_ROWS,
    ),
  ];
  const rows: PiCardRow[] = content
    .slice(0, CARD_DETAIL_ROW_MAX)
    .map((row) => bodyRow(w, "detail", clipRow(row, inner)));
  while (rows.length < CARD_DETAIL_ROW_MIN) {
    rows.push(bodyRow(w, "detail", []));
  }
  return rows;
}

/**
 * The status strip: whether the window follows a live child or sits at the
 * bottom of a settled one, and how much scrollback is above it.
 */
function viewportStrip(facts: PiDelegationCardFacts): Row {
  const strip: Seg[] = [
    seg("dim", facts.settled ? CARD_VIEWPORT_SETTLED : CARD_VIEWPORT_LIVE),
  ];
  const above = Math.max(0, facts.viewport.above);
  if (above > 0) {
    // Fixed padding is built with `fill`, never with spaces inside a segment:
    // `seg` collapses whitespace runs, so a segment cannot carry layout.
    strip.push(
      fill("dim", " ", 2),
      seg("dim", `↑ ${above} row${above === 1 ? "" : "s"} above`),
    );
  }
  return strip;
}

/** One transcript row: role gutter, bounded head label, then the text. */
function viewportRow(
  row: PiCardViewportRow,
  inner: number,
  narrow: boolean,
): Row {
  const ink = ROW_INK[row.kind];
  const head = safeTrim(row.head);
  const headBudget = Math.max(2, Math.floor(inner / 3));
  // The head is a bounded label, so it is printed whole or not at all: a head
  // that had to be cut would put a second `…` on a line whose text already
  // carries one.
  if (head.length > 0 && !narrow && measureWidth(head) <= headBudget) {
    const lead: Seg[] = [
      glyph(ink, `${ROW_GLYPH[row.kind]} `),
      seg("muted", head),
      fill("dim", " ", 2),
    ];
    const used = lead.reduce((total, s) => total + measureWidth(s.t), 0);
    return [...lead, seg(ink, clipText(row.text, Math.max(2, inner - used)))];
  }
  const lead: Seg[] = [glyph(ink, `${ROW_GLYPH[row.kind]} `)];
  const used = lead.reduce((total, s) => total + measureWidth(s.t), 0);
  return [...lead, seg(ink, clipText(row.text, Math.max(2, inner - used)))];
}

/** Keep the last `target` rows and pad above, so content sits on the bottom. */
function padAbove(rows: readonly Row[], target: number): Row[] {
  const kept = rows.slice(-Math.max(0, target));
  const gap = Math.max(0, target - kept.length);
  return [...Array.from({ length: gap }, (): Row => []), ...kept];
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/** Floors a caller-supplied width into a drawable card width. */
function normalizeCardWidth(width: number): number {
  if (!Number.isFinite(width)) return CARD_MIN_WIDTH;
  return Math.max(CARD_MIN_WIDTH, Math.floor(width));
}

/** The interior columns between the two frame borders and their gutters. */
function innerWidth(width: number): number {
  return Math.max(0, width - 4);
}

/** Clips already-sanitized text, marking the cut. */
function clipText(text: string, width: number): string {
  return truncatePlainToWidth(safeTrim(text), Math.max(1, width));
}

/**
 * Clips a fixed-field cell FLUSH, without a cut mark.
 *
 * Used only where a cell shares its line with a prose column that already
 * states the line's loss. The card is a summary; the complete value of every
 * cell cut here — the state word, the child name, elapsed — is one `Alt+I`
 * away in the inspector, which is why the rail can afford to lose the mark
 * rather than let one line carry two of them.
 */
function clipCell(text: string, width: number): string {
  return truncatePlainToWidth(safeTrim(text), Math.max(1, width), "");
}
