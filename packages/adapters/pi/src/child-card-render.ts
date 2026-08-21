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
 *    the width alone, and the body reserves the assignment row plus one
 *    optional live-reasoning row, so a settled card is exactly as tall as the
 *    running card it replaced.
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

import { formatAgentDisplayName } from "./agent-display-name.js";
import {
  CARD_TOOL_NAME,
  CARD_VIEWPORT_ROWS,
  type PiDelegationCardFacts,
} from "./child-card-model.js";
import { truncatePlainToWidth } from "./render-width.js";
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
export const CARD_MIN_WIDTH = 16;

/** The rail column: one bar column plus the widest status word. */
export const CARD_RAIL_W = 25;

/** Gutter, divider, gutter — one column of air on each side of the rule. */
export const CARD_RAIL_DIVIDER_W = 3;

/** Below this body width the rail cannot pay for itself and identity folds. */
export const CARD_RAIL_MIN_BODY = 17;

/**
 * The body columns the rail must leave over its own width before it may print
 * its droppable cell. The state word and the child name always survive;
 * elapsed is the cell that leaves.
 */
export const CARD_RAIL_TIGHT_SLACK = 12;

/** The rail uses at most three cells. */
export const CARD_RAIL_CELL_MAX = 3;

/** The assignment budget: exactly one row, at every width, in every state. */
export const CARD_ASSIGNMENT_ROW_MAX = 1;

/** The Native Line budget: at most one live-reasoning row. */
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

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Pi's own expand/collapse binding for tool output, so the hint is truthful. */
export const CARD_EXPAND_KEY = "Ctrl+O";

/** The inspect hint ladder, richest first. The bare key leaves last. */
export const CARD_INSPECT_HINT = "Alt+I inspect child";
export const CARD_INSPECT_HINT_MID = "Alt+I inspect";
export const CARD_INSPECT_HINT_MIN = "Alt+I";

/** What the card says when the parent recorded no assignment sentence. */
export const CARD_NO_ASSIGNMENT = "no assignment recorded";

/** The status strip of the expanded viewport, in its two honest forms. */
export const CARD_VIEWPORT_LIVE = "LIVE · following bottom";
export const CARD_VIEWPORT_SETTLED = "AT BOTTOM · child settled";

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
  | "identity-detail"
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
  /** TUI-only raw reasoning line; never read from persisted facts. */
  readonly liveReasoningLine?: string;
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
  return composeDelegationCard(
    facts,
    width,
    options.expanded === true,
    options.liveReasoningLine,
  ).map((row) => emit(row.row, width, options.paint));
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
  liveReasoningLine = "",
): readonly PiCardRow[] {
  const w = normalizeCardWidth(width);
  const inner = innerWidth(w);
  const plan = railPlan(w);
  const rows: PiCardRow[] = [edgeTop(w, cardTitle(facts), [])];

  if (plan.folded) {
    // The terminal cannot pay for a rail column, so identity folds into one
    // body row. This is the only place the card prints identity outside the
    // rail, and no footer may duplicate it.
    for (const [index, identity] of identityRows(facts, inner).entries()) {
      rows.push({
        slot: index === 0 ? "identity" : "identity-detail",
        row: cardBody(w, identity),
        body: identity,
      });
    }
    rows.push(...zipBodyOnly(w, inner, facts, liveReasoningLine));
  } else {
    rows.push(...zipRailAndBody(w, plan, facts, liveReasoningLine));
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
  return facts === undefined
    ? [seg("alt", CARD_TOOL_NAME)]
    : [seg("bold", formatAgentDisplayName(facts.agentName))];
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
  const folded = inner < CARD_RAIL_W + CARD_RAIL_DIVIDER_W + CARD_RAIL_MIN_BODY;
  const tight =
    !folded &&
    inner <
      CARD_RAIL_W +
        CARD_RAIL_DIVIDER_W +
        CARD_RAIL_MIN_BODY +
        CARD_RAIL_TIGHT_SLACK;
  const bodyW = folded ? inner : inner - CARD_RAIL_W - CARD_RAIL_DIVIDER_W;
  return { tight, railW: CARD_RAIL_W, folded, bodyW };
}

/** Gutter, divider, gutter. */
function railDivider(): Seg {
  return glyph("rule", " │ ");
}

/**
 * Status first: the state word and provider share row one, the applied model
 * id is row two, and row three is deliberately blank. Elapsed is footer-only.
 *
 * The identity is one authenticated atom. A missing atom renders `—` rather
 * than the configured model intent.
 */
export function railStatusFirst(
  facts: PiDelegationCardFacts,
  w: number,
  tight: boolean,
): readonly Row[] {
  const ink = toneInk(facts.tone);
  // Rail cells are fixed-field identity, so they cut flush: the one cut mark
  // this line may carry belongs to the body column beside them.
  const identity = facts.appliedIdentity ?? { provider: "—", id: "—" };
  const status: Seg[] = [
    glyph(ink, "▌"),
    seg(ink, ` ${clipCell(facts.status.toUpperCase(), Math.max(1, w - 1))}`),
  ];
  if (!tight) {
    status.push(seg("dim", " "), seg("acc", clipCell(identity.provider, w)));
  }
  const model: Row = [
    fill("dim", " ", 10),
    seg("text", clipCell(identity.id, Math.max(1, w - 10))),
  ];
  return [clipRow(status, w), clipRow(model, w), []].slice(
    0,
    CARD_RAIL_CELL_MAX,
  );
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
  return identityRows(facts, bodyW)[0] ?? [];
}

/** Two bounded folded rows: status, then display name and applied model id. */
export function identityRows(
  facts: PiDelegationCardFacts,
  bodyW: number,
): readonly Row[] {
  const ink = toneInk(facts.tone);
  const state = facts.status.toUpperCase();
  const identity = facts.appliedIdentity ?? { provider: "—", id: "—" };
  const first = fitRow(
    [
      [
        glyph(ink, "▌"),
        seg(ink, state),
        seg("dim", " · "),
        seg("text", facts.agentName),
      ],
      [glyph(ink, "▌"), seg(ink, state)],
    ],
    Math.max(0, bodyW),
  );
  const second = fitRow(
    [
      [
        seg("bold", formatAgentDisplayName(facts.agentName)),
        seg("dim", " · "),
        seg("text", identity.id),
      ],
      [seg("bold", formatAgentDisplayName(facts.agentName))],
    ],
    Math.max(0, bodyW),
  );
  const firstRow =
    first.length > 0
      ? first
      : [glyph(ink, "▌"), seg(ink, clipCell(state, Math.max(1, bodyW - 1)))];
  const secondRow =
    second.length > 0
      ? second
      : [seg("text", clipCell(identity.id, Math.max(1, bodyW)))];
  return [clipRow(firstRow, bodyW), clipRow(secondRow, bodyW)];
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
 * Native Line: one transient raw-reasoning line, or no row when no printable
 * reasoning is active. It reads only the body width, never persisted facts.
 */
export function nativeLine(
  _facts: PiDelegationCardFacts,
  bodyW: number,
  liveReasoningLine = "",
): readonly Row[] {
  const text = safeTrim(liveReasoningLine);
  if (text.length === 0) return [];
  return [[seg("think", clipText(text, Math.max(2, bodyW)))]];
}

/** The optional live-reasoning row beneath the assignment. */
function activityRows(
  facts: PiDelegationCardFacts,
  bodyW: number,
  liveReasoningLine: string,
): readonly Row[] {
  return nativeLine(facts, bodyW, liveReasoningLine).slice(
    0,
    CARD_ACTIVITY_ROW_MAX,
  );
}

/** The folded layout: no rail, so the body owns the whole inner width. */
function zipBodyOnly(
  width: number,
  inner: number,
  facts: PiDelegationCardFacts,
  liveReasoningLine: string,
): readonly PiCardRow[] {
  const rows: PiCardRow[] = [];
  for (const row of assignmentRows(facts, inner)) {
    const body = clipRow(row, inner);
    rows.push({ slot: "task", row: cardBody(width, body), body });
  }
  for (const [index, content] of activityRows(
    facts,
    inner,
    liveReasoningLine,
  ).entries()) {
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
function bodySlot(
  index: number,
  taskRows: number,
  hasActivity: boolean,
): PiCardSlot {
  if (index < taskRows) return "task";
  if (hasActivity && index === taskRows) return "activity";
  return "activity-detail";
}

/** The ordinary layout: the rail column beside the body column. */
function zipRailAndBody(
  width: number,
  plan: PiCardRailPlan,
  facts: PiDelegationCardFacts,
  liveReasoningLine: string,
): readonly PiCardRow[] {
  const cells = railStatusFirst(facts, plan.railW, plan.tight);
  const taskCells = assignmentRows(facts, plan.bodyW);
  const bodyCells: Row[] = [
    ...taskCells,
    ...activityRows(facts, plan.bodyW, liveReasoningLine),
  ];
  const hasActivity = bodyCells.length > taskCells.length;
  const height = Math.max(cells.length, bodyCells.length);

  const rows: PiCardRow[] = [];
  for (let index = 0; index < height; index += 1) {
    const railCell = cells[index] ?? [];
    const bodyCell = bodyCells[index] ?? [];
    const clippedBody = clipRow(bodyCell, plan.bodyW);
    rows.push({
      slot: bodySlot(index, taskCells.length, hasActivity),
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
  const content: Row[] = [
    viewportStrip(facts),
    ...padAbove(
      // The parent card never replays child transcript rows. The inspector
      // owns tool and assistant detail; this fixed region remains shell-only.
      [],
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
  return [
    seg("dim", facts.settled ? CARD_VIEWPORT_SETTLED : CARD_VIEWPORT_LIVE),
  ];
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
