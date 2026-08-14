/**
 * Weave inside Pi — THE FINAL CHILD INSPECTOR PROTOTYPE.
 *
 * This file is no longer a grilling canvas. Ten rounds of design review are
 * settled, every alternative is DELETED rather than hidden, and one surface
 * remains: the design the user selected. It is kept as the reference the
 * implementation plan is written against, so each locked decision is stated
 * here and enforced by the types below.
 *
 * THE FINAL DESIGN TREE
 *   1. Overall     SPLIT INSPECTOR — a native centered Pi overlay drawn over
 *                  the REAL Pi session. No fake transcript, editor or footer
 *                  is drawn outside the overlay.
 *   2. Layout      Pi-native child transcript LEFT, Status Matrix RIGHT RAIL,
 *                  child prompt and controls below.
 *   3. Transcript  PI NATIVE — role gutters, understated read / edit / bash
 *                  calls and results, reasoning as a SUMMARY only, plain
 *                  streaming and final assistant responses. Raw
 *                  chain-of-thought is never rendered (section 6f).
 *   4. Rail        STATUS MATRIX — an aligned key/value matrix grouped by
 *                  lifecycle · work · spend, with an inverse alert pair above
 *                  the matrix when a tool fails (section 6g).
 *   5. Header      SESSION HEADER (section 6h)
 *                    row 1  inverse ` CHILD ` badge · `shuttle` ·
 *                           `gpt-5.6-sol` · `implementer` ·
 *                           `overlay header width`
 *                    row 2  `delegated by LOOM` · plan › task › subtask
 *                  No telemetry row and no child id: those facts live on the
 *                  rail and on the outer frame marker. The model sits
 *                  immediately after the child's name and appears exactly
 *                  once.
 *   6. Widget      PLAN RAIL above the REAL Pi editor (`ui.setWidget`,
 *                  section 4), surviving Esc
 *                    row 1  `◆ WEAVE · LOOM` · `Alt+A cycle` · plan · DEMO DATA
 *                    row 2  task marks `● ● ◐ ○ ○ ○ ○ ○` and `3/8`
 *                    row 3  `┃ now `  the active task
 *                    row 4  `┗ next`  the task after it
 *                  It reads `WidgetFacts` — parent context only — so it is
 *                  byte-identical in every child state.
 *   7. Prompt      PRIMARY-LIKE EDITOR (section 6d-II) — a bordered Pi-style
 *                  input panel over one muted key row: Enter steer,
 *                  Alt+Enter queue, q cancel (y / n confirmation), / search,
 *                  Esc close. Settled states are read-only and caretless.
 *   8. Navigation  RAIL SEARCH (section 6d-IV) — `/` prepends a SEARCH
 *                  section to the Status Matrix, the transcript grows one
 *                  subtle marker column, `n / N` (aliases `j / k`) move the
 *                  rail cursor and the shared transcript window follows.
 *                  Precedence: cancel confirmation › search › overlay.
 *   9. Outcomes    NATIVE SETTLEMENT (section 6j) — no new chrome at all. The
 *                  authoritative final response, the safe failure line, the
 *                  cancellation record and the retry record are ORDINARY
 *                  transcript events; the frame marker and the rail carry the
 *                  state word; the locked editor becomes read-only once the
 *                  child settles. Recovery stays LIVE, and its attempt
 *                  lineage is read in the native transcript and on the rail.
 *                  There is no banner band, no rail verdict section, no
 *                  transcript checkpoint block and no action deck.
 *  10. Frame       exactly ONE high-contrast titled outer border wraps the
 *                  overlay, carrying the demo title and the live state
 *                  marker (section 9).
 *
 * WHAT KEEPS IT HONEST, structurally rather than by discipline
 *   - `WidgetFacts` holds parent-side context only, so the persistent widget
 *     cannot print a child id, token count, cost, elapsed time or queue depth.
 *   - `HeaderFacts` has no telemetry group and no child-id field, so the
 *     Session Header cannot regrow one.
 *   - `PromptFacts` resolves the field text and the caret once, so a settled
 *     child can never be given a live input, and `renderPromptGroup` answers
 *     the cancel confirmation ITSELF — `q` cannot cancel without `y / n`.
 *   - `NavFacts` is built from an ANSI-FREE twin render of the transcript, so
 *     no byte of transcript colour can paint the search rail.
 *   - `safeText` strips ANSI, removes stack frames, redacts credential-shaped
 *     tokens and long opaque ids and hides absolute paths outside the demo
 *     repo. Failure text reaches the screen only through it.
 *   - Every emitted row passes the width-safe primitives in section 2.
 *
 * Launch:
 *   pi --no-extensions -e ./prototypes/weave-pi-tui-grilling.ts --no-session --offline
 *
 * Controls (also printed inside the overlay):
 *   r e c s x y  demo child state — Running, tool Error, Completed,
 *                Steered/queued, cancelled (x), recovery/retry (y)
 *   Tab          next child state   (Shift+Tab previous)
 *   /            open / close Rail Search (fixed demo query `width`)
 *   n / N        next / previous match      (only while search is open)
 *   j / k        aliases for n / N          (only while search is open)
 *   Enter        jump to the current match and accept  (search open)
 *   q            demo cancel confirmation (y / n) — cancels nothing
 *   Esc          cancel confirmation, then search, then the overlay
 *
 * Commands:
 *   /grilling         reopen the final inspector overlay
 *   /grilling-clear   remove the demo widget and status
 *
 * Every number, path and transcript line below is MOCK DATA. The overlay says
 * so on its own banner, and the widget carries a subtle DEMO DATA mark, so
 * neither can be mistaken for a real child.
 *
 * Single file. Bun only. No server, no browser, no network, no model call.
 */

import type {
	ExtensionAPI,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { err, ok, type Result } from "neverthrow";

/* ==========================================================================
   1. MOCK DATA
   ========================================================================== */

/**
 * PARENT-SIDE CONTEXT — the only facts the persistent widget may read.
 *
 * Every field here is about the PARENT session: which primary agent is
 * selected, what it can be cycled to, and which plan and task are active.
 * Nothing child-operational lives here, which is why the persistent widget
 * cannot print a child id, a token count, a cost, an elapsed time or an active
 * child tool: it has no way to reach one.
 */
const CONTEXT = {
	badge: "◆ WEAVE",
	agent: "LOOM",
	agentRole: "planner",
	/** The PARENT's own model — parent context, never the child's. */
	agentModel: "gpt-5.6-luna",
	/** Primary agents Alt+A cycles through, selected one first. */
	cycle: ["LOOM", "TAPESTRY", "PATTERN", "WEFT"] as readonly string[],
	plan: "pi-child-overlay-ux-feedback",
	taskOrdinal: 3,
	taskTotal: 8,
	task: "Child overlay rendering",
	nextTask: "Native child stream rendering",
	subtask: "3.3 Transcript event rendering",
	tasks: [
		["done", "1", "Child compact block contract"],
		["done", "2", "Delegation controller settlement"],
		["active", "3", "Child overlay rendering"],
		["queued", "4", "Native child stream rendering"],
		["queued", "5", "Thread provisioning"],
		["queued", "6", "Steer / queue / cancel plumbing"],
		["queued", "7", "Search over child transcripts"],
		["queued", "8", "Release setup + live proof"],
	] as ReadonlyArray<readonly [string, string, string]>,
} as const;

const DEMO_MARK = "DEMO DATA";

/**
 * Child identity — identical across states, as it would be for one child.
 *
 * `childId` is now reported in ONE place: the transcript's bootstrap line,
 * the way a real session log records it. Round 6 deleted the bounded hint the
 * header used to trail (`child 9f31…c4`) on the finding that a bounded opaque
 * id is unreadable, unsearchable and unactionable at a glance. The persistent
 * widget never sees it at all. It is never a raw opaque id and never a secret.
 */
const CHILD = {
	title: "shuttle · overlay header width",
	/** The child's own task title, already bounded for a header row. */
	boundedTitle: "overlay header width",
	agent: "shuttle",
	role: "implementer",
	model: "gpt-5.6-sol",
	childId: "9f31…c4",
	/**
	 * WHAT the child was asked to do, in product language. Static: an assignment
	 * does not change when a tool fails, which is exactly why it can live in a
	 * header while live activity cannot.
	 */
	assignment:
		"reserve the trailing marker width before the title truncates, then keep the width sweep green from 40 to 200 columns",
	/** The same assignment, already bounded for one header row. */
	boundedAssignment: "reserve the trailing marker before truncating",
	prompt:
		"Fix headerLines() so ` · STATUS` is reserved before the title truncates, then keep the width sweep green from 40 to 200 columns.",
} as const;

type Tone = "run" | "ok" | "warn" | "bad" | "mute";

type EventKind =
	| "sys"
	| "prompt"
	| "reason"
	| "tool"
	| "assistant"
	| "error"
	| "queue";

interface ChildEvent {
	readonly at: string;
	readonly kind: EventKind;
	/** Short label: tool name + target, or event title. */
	readonly title: string;
	/** Arguments for tools, prose for reasoning/assistant/error. */
	readonly body?: string;
	/** Tool result or progress line. */
	readonly result?: string;
	readonly tone?: Tone;
	readonly streaming?: boolean;
}

/**
 * Shared spine of every state: delegation prompt, reasoning SUMMARY, a read
 * call with arguments and output, an assistant reply, and an edit call with
 * arguments and output. Each state then adds its own bash call and ending, so
 * every state always has read / edit / bash for the rail to report on.
 */
const BASE_EVENTS: readonly ChildEvent[] = [
	{
		at: "14:19:44",
		kind: "sys",
		title: "bootstrap accepted",
		body: `childId ${CHILD.childId} · tool policy inherited · model ${CHILD.model}`,
		tone: "mute",
	},
	{
		at: "14:19:44",
		kind: "prompt",
		title: "delegation prompt · from LOOM",
		body: CHILD.prompt,
	},
	{
		at: "14:19:51",
		kind: "reason",
		title: "reasoning SUMMARY",
		body: "Plans to reserve the status suffix width first, truncate the title into the remainder, then re-run the width sweep. Summary only — raw chain-of-thought is never streamed or stored.",
		tone: "mute",
	},
	{
		at: "14:19:58",
		kind: "tool",
		title: "read · child-overlay-component.ts",
		body: "offset 470 · limit 76",
		result: "76 lines · fitLineWithSuffix at 512",
		tone: "ok",
	},
	{
		at: "14:20:36",
		kind: "assistant",
		title: "assistant",
		body: "The suffix is appended after truncation, so at width 51 the marker is cut instead of the title. Reserving the suffix first.",
	},
	{
		at: "14:21:02",
		kind: "tool",
		title: "edit · child-overlay-component.ts",
		body: "1 replacement · fitLineWithSuffix(line, suffix, width)",
		result: "applied · +6 −3",
		tone: "ok",
	},
];

type StateId =
	| "running"
	| "error"
	| "completed"
	| "steered"
	| "cancelled"
	| "recovery";

interface ChildState {
	readonly id: StateId;
	readonly label: string;
	/** Short label for the footer's state chips. Six chips must fit one row. */
	readonly chip: string;
	readonly key: string;
	readonly status: string;
	readonly tone: Tone;
	readonly run: string;
	readonly branch: string;
	readonly turn: number;
	readonly queue: number;
	readonly elapsed: string;
	readonly tokensIn: number;
	readonly tokensOut: number;
	readonly cost: string;
	readonly live: string;
	readonly events: readonly ChildEvent[];
	readonly queued: readonly string[];
}

const STATES: readonly ChildState[] = [
	{
		id: "running",
		label: "Running",
		chip: "running",
		key: "r",
		status: "RUNNING",
		tone: "run",
		run: "run 1",
		branch: "branch main",
		turn: 4,
		queue: 1,
		elapsed: "2m18s",
		tokensIn: 48213,
		tokensOut: 6120,
		cost: "0.2841",
		live: "working · bash running 12s",
		queued: ["also cover width 40 and 200"],
		events: [
			...BASE_EVENTS,
			{
				at: "14:21:47",
				kind: "tool",
				title: "bash · bun test child-overlay-component.test.ts",
				body: "cwd ~/projects/weave · timeout 120s",
				result: "running · 61 pass so far",
				tone: "run",
			},
			{
				at: "14:22:07",
				kind: "assistant",
				title: "assistant",
				body: "Width 51 now keeps ` · RUNNING`. Sweeping 40 → 200 columns to be sure nothing else regressed",
				streaming: true,
			},
		],
	},
	{
		id: "error",
		label: "Tool error",
		chip: "failed",
		key: "e",
		status: "TOOL ERROR",
		tone: "bad",
		run: "run 1",
		branch: "branch main",
		turn: 5,
		queue: 1,
		elapsed: "3m04s",
		tokensIn: 52988,
		tokensOut: 7011,
		cost: "0.3122",
		live: "child alive · 1 tool error",
		queued: ["also cover width 40 and 200"],
		events: [
			...BASE_EVENTS,
			{
				at: "14:21:47",
				kind: "tool",
				title: "bash · bun test child-overlay-component.test.ts",
				body: "cwd ~/projects/weave · timeout 120s",
				result: "exit 1 · 81 pass · 2 fail · 2.4s",
				tone: "bad",
			},
			{
				at: "14:21:49",
				kind: "error",
				title: "tool error · bash · exit 1",
				body: 'width 51: expected " · RUNNING", received " · RUNNIN…" (2 failing assertions). Detail is the captured test diff only — no environment values, tokens or paths outside the repo are shown.',
				tone: "bad",
			},
			{
				at: "14:22:11",
				kind: "assistant",
				title: "assistant",
				body: "The reservation runs after the ellipsis is applied, so one column is still lost. Moving it above the truncate call and re-running.",
				streaming: true,
			},
		],
	},
	{
		id: "completed",
		label: "Completed",
		chip: "done",
		key: "c",
		status: "COMPLETED",
		tone: "ok",
		run: "run 1",
		branch: "branch main",
		turn: 7,
		queue: 0,
		elapsed: "5m02s",
		tokensIn: 71002,
		tokensOut: 9840,
		cost: "0.4130",
		live: "settled · final response sent",
		queued: [],
		events: [
			...BASE_EVENTS,
			{
				at: "14:21:47",
				kind: "tool",
				title: "bash · bun test child-overlay-component.test.ts",
				body: "cwd ~/projects/weave · timeout 120s",
				result: "83 pass · 0 fail · 1.9s",
				tone: "ok",
			},
			{
				at: "14:24:30",
				kind: "assistant",
				title: "final response",
				body: "Reserved the status suffix before truncation in fitLineWithSuffix, added width cases 40/51/200 to the sweep. 83 pass, 0 fail.",
				tone: "ok",
			},
			{
				at: "14:24:31",
				kind: "sys",
				title: "child settled · run 1 complete",
				body: "lease released · no residual process",
				tone: "mute",
			},
		],
	},
	{
		id: "steered",
		label: "Queued / steered",
		chip: "steered",
		key: "s",
		status: "STEERED",
		tone: "warn",
		run: "run 1",
		branch: "branch main",
		turn: 4,
		queue: 2,
		elapsed: "2m41s",
		tokensIn: 50110,
		tokensOut: 6402,
		cost: "0.2955",
		live: "steer accepted · 2 queued",
		queued: ["also cover width 40 and 200", "then update the doc comment"],
		events: [
			...BASE_EVENTS,
			{
				at: "14:21:47",
				kind: "tool",
				title: "bash · bun test child-overlay-component.test.ts",
				body: "cwd ~/projects/weave · timeout 120s",
				result: "running · 58 pass so far",
				tone: "run",
			},
			{
				at: "14:22:20",
				kind: "queue",
				title: "steer accepted · turn 4",
				body: "reserve the suffix in fitLineWithSuffix, not in the caller",
				tone: "warn",
			},
			{
				at: "14:22:21",
				kind: "queue",
				title: "queued · 2 messages",
				body: "1. also cover width 40 and 200 · 2. then update the doc comment",
				tone: "warn",
			},
			{
				at: "14:22:34",
				kind: "assistant",
				title: "assistant",
				body: "Taking the steer now; the queued width cases run after this edit lands.",
				streaming: true,
			},
		],
	},
	{
		id: "cancelled",
		label: "Cancelled",
		chip: "cancelled",
		key: "x",
		status: "CANCELLED",
		tone: "warn",
		run: "run 1",
		branch: "branch main",
		turn: 5,
		queue: 0,
		elapsed: "3m48s",
		tokensIn: 55140,
		tokensOut: 7388,
		cost: "0.3269",
		live: "cancelled by LOOM · partial kept",
		queued: [],
		events: [
			...BASE_EVENTS,
			{
				at: "14:21:47",
				kind: "tool",
				title: "bash · bun test child-overlay-component.test.ts",
				body: "cwd ~/projects/weave · timeout 120s",
				result: "stopped at 41s · 62 assertions ran · no verdict",
				tone: "warn",
			},
			{
				at: "14:22:28",
				kind: "assistant",
				title: "assistant",
				body: "Was re-running the width sweep when the run was stopped. The edit to fitLineWithSuffix is already applied; the sweep result is unknown.",
			},
			{
				at: "14:22:29",
				kind: "sys",
				title: "cancel confirmed · run 1 stopped",
				body: "requested by LOOM from the inspector · confirmed y · partial output kept · lease released · no residual process",
				tone: "warn",
			},
		],
	},
	{
		id: "recovery",
		label: "Recovery / retry",
		chip: "retry",
		key: "y",
		status: "RECOVERING",
		tone: "run",
		run: "run 1",
		branch: "branch main",
		turn: 6,
		queue: 1,
		elapsed: "4m12s",
		tokensIn: 61470,
		tokensOut: 8204,
		cost: "0.3548",
		live: "attempt 2 of 2 · resumed",
		queued: ["then update the doc comment"],
		events: [
			...BASE_EVENTS,
			{
				at: "14:21:47",
				kind: "tool",
				title: "bash · bun test child-overlay-component.test.ts",
				body: "cwd ~/projects/weave · timeout 120s",
				result: "exit 1 · 81 pass · 2 fail · 2.4s",
				tone: "bad",
			},
			{
				at: "14:21:49",
				kind: "error",
				title: "tool error · bash · exit 1",
				body: 'width 51: expected " · RUNNING", received " · RUNNIN…" (2 failing assertions). Detail is the captured test diff only — no environment values, tokens or paths outside the repo are shown.',
				tone: "bad",
			},
			{
				at: "14:22:52",
				kind: "sys",
				title: "retry accepted · attempt 2 of 2",
				body: "attempt 1 failed at the width sweep · resumed from the applied edit to fitLineWithSuffix · earlier turns are not replayed",
				tone: "warn",
			},
			{
				at: "14:23:05",
				kind: "tool",
				title: "bash · bun test child-overlay-component.test.ts",
				body: "cwd ~/projects/weave · attempt 2 · timeout 120s",
				result: "running · 71 pass so far",
				tone: "run",
			},
			{
				at: "14:23:18",
				kind: "assistant",
				title: "assistant",
				body: "Attempt 2 moved the reservation above the truncate call; the width sweep is re-running from 40 to 200 columns.",
				streaming: true,
			},
		],
	},
];

/**
 * THE ONE DEMO QUERY. The locked Rail Search always searches this string, so
 * every child state is exercised against the same search behaviour.
 *
 * It is deliberately a word that occurs in EVERY child state and in more than
 * one event KIND: the delegation prompt, the reasoning summary, an edit tool
 * call, a streaming reply, the captured tool-error line, the final response
 * and the queued steer message. The matches below are not a mock list — they
 * are found by scanning the rendered transcript, so a state with fewer matches
 * really does report fewer.
 */
const NAV_QUERY = "width";

/** The ordinal the demo opens on, clamped per state by `navFacts`. */
const NAV_START_MATCH = 2;

const CHILD_DRAFT = "also assert the 200-column case";

/* ==========================================================================
   2. WIDTH-SAFE PRIMITIVES — every emitted line passes through these
   ========================================================================== */

type LayoutError =
	| { kind: "too-narrow"; need: number }
	| { kind: "too-short"; need: number };

function clip(text: string, width: number): string {
	return width <= 0 ? "" : truncateToWidth(text, width, "…");
}

function cell(text: string, width: number): string {
	return width <= 0 ? "" : truncateToWidth(text, width, "…", true);
}

/**
 * Left/right row. The right side never takes more than 60% of the row, so a
 * long trailing note can never squeeze the leading identity out of view.
 */
function rowLR(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const rightWidth = Math.min(
		visibleWidth(right),
		Math.max(0, width - 2),
		Math.max(8, Math.floor(width * 0.6)),
	);
	const right2 = clip(right, rightWidth);
	const leftWidth = Math.max(0, width - visibleWidth(right2));
	return cell(clip(left, Math.max(0, leftWidth - 1)), leftWidth) + right2;
}

function repeat(ch: string, width: number): string {
	return width <= 0 ? "" : ch.repeat(Math.max(0, width));
}

function wrapIndented(text: string, width: number, indent: string): string[] {
	const inner = Math.max(1, width - visibleWidth(indent));
	return wrapTextWithAnsi(text, inner).map((line) => cell(indent + line, width));
}

/** Wraps, then folds anything past `maxLines` into an ellipsis on the last row. */
function clampWrap(text: string, width: number, maxLines: number): string[] {
	const safeWidth = Math.max(1, width);
	const lines = wrapTextWithAnsi(text, safeWidth);
	if (lines.length <= maxLines) return lines;
	const kept = lines.slice(0, Math.max(1, maxLines));
	const lastIndex = kept.length - 1;
	kept[lastIndex] = clip(`${kept[lastIndex] ?? ""} …`, safeWidth);
	return kept;
}

function fitTo(
	lines: readonly string[],
	height: number,
	keep: "head" | "tail" = "head",
): string[] {
	if (height <= 0) return [];
	if (lines.length >= height) {
		return keep === "head"
			? lines.slice(0, height)
			: lines.slice(lines.length - height);
	}
	return [...lines, ...Array.from({ length: height - lines.length }, () => "")];
}

/**
 * Narrowest transcript pane the round-3 Pi-native renderer is allowed to keep.
 * Below this the rail folds into dense rows instead of squeezing the reading
 * column, so the rail can never buy room by starving the transcript.
 */
const TRANSCRIPT_MIN = 38;

/** Rail sizing band. Width is part of the rail's design, not a bare constant. */
interface RailGeometry {
	readonly min: number;
	readonly max: number;
	readonly ratio: number;
}

/** Main pane + right rail. Fails closed on narrow terminals so callers degrade. */
function splitRail(
	width: number,
	geometry: RailGeometry,
): Result<{ main: number; rail: number }, LayoutError> {
	const need = geometry.min + TRANSCRIPT_MIN + 1;
	if (width < need) return err({ kind: "too-narrow", need });
	const rail = Math.max(
		geometry.min,
		Math.min(geometry.max, Math.round(width * geometry.ratio)),
	);
	// Never let rail sizing eat into the transcript minimum.
	const capped = Math.min(rail, width - TRANSCRIPT_MIN - 1);
	return ok({ main: width - capped - 1, rail: capped });
}

function reserveRows(
	height: number,
	chrome: number,
): Result<number, LayoutError> {
	const left = height - chrome;
	if (left < 2) return err({ kind: "too-short", need: chrome + 2 });
	return ok(left);
}

function joinColumns(
	columns: ReadonlyArray<{ lines: readonly string[]; width: number }>,
	height: number,
	separator: string,
): string[] {
	const rows: string[] = [];
	for (let i = 0; i < height; i++) {
		rows.push(
			columns
				.map((column) => cell(column.lines[i] ?? "", column.width))
				.join(separator),
		);
	}
	return rows;
}

function wrapIndex(index: number, length: number): number {
	return ((index % length) + length) % length;
}

/* ==========================================================================
   3. PAINT — native theme colors only
   ========================================================================== */

interface Paint {
	text: (s: string) => string;
	acc: (s: string) => string;
	/** High-contrast outer overlay boundary. Never used for inner separators. */
	frame: (s: string) => string;
	alt: (s: string) => string;
	dim: (s: string) => string;
	muted: (s: string) => string;
	ok: (s: string) => string;
	warn: (s: string) => string;
	bad: (s: string) => string;
	rule: (s: string) => string;
	bold: (s: string) => string;
	inv: (s: string) => string;
	tone: (tone: Tone, s: string) => string;
}

function makePaint(theme: Theme): Paint {
	const tone = (t: Tone, s: string): string =>
		t === "run"
			? theme.fg("accent", s)
			: t === "ok"
				? theme.fg("success", s)
				: t === "warn"
					? theme.fg("warning", s)
					: t === "bad"
						? theme.fg("error", s)
						: theme.fg("dim", s);
	return {
		text: (s) => theme.fg("text", s),
		acc: (s) => theme.fg("accent", s),
		frame: (s) => theme.fg("borderAccent", s),
		alt: (s) => theme.fg("customMessageLabel", s),
		dim: (s) => theme.fg("dim", s),
		muted: (s) => theme.fg("muted", s),
		ok: (s) => theme.fg("success", s),
		warn: (s) => theme.fg("warning", s),
		bad: (s) => theme.fg("error", s),
		rule: (s) => theme.fg("borderMuted", s),
		bold: (s) => theme.bold(s),
		inv: (s) => theme.inverse(s),
		tone,
	};
}

/**
 * ANSI-free paint. Used only by the noninteractive smoke test so it can assert
 * on plain text and exact column widths without a live Theme.
 */
function plainPaint(): Paint {
	const id = (s: string): string => s;
	return {
		text: id,
		acc: id,
		frame: id,
		alt: id,
		dim: id,
		muted: id,
		ok: id,
		warn: id,
		bad: id,
		rule: id,
		bold: id,
		inv: id,
		tone: (_t, s) => s,
	};
}

/* ==========================================================================
   4. THE LOCKED PERSISTENT CONTEXT WIDGET — PLAN RAIL (settled in round 7)

   This is the component that lives ABOVE THE REAL PI EDITOR (`ui.setWidget`,
   section 8) and survives Esc. It is the user's ambient answer to two
   questions while they do ordinary Pi work:

       WHICH PRIMARY AGENT IS SELECTED, and WHAT PLAN/TASK IS ACTIVE.

   Round 7 selected PLAN RAIL and amended it with the agent-cycle keybind:

       ◆ WEAVE · LOOM · Alt+A cycle · pi-child-overlay-ux-feedback  DEMO DATA
       ● ● ◐ ○ ○ ○ ○ ○   3/8
       ┃ now    Child overlay rendering
       ┗ next   Native child stream rendering

   It is no longer a variable. There is ONE widget, `renderPlanRailWidget`,
   and the demo footer in section 10 never names it.

   WHY IT IS SAFE
     `WidgetFacts` is the whole vocabulary, and it is parent-side only: no
     child id, no token count, no cost, no elapsed time, no active tool and no
     queue depth, because the inspector overlay already owns all of it. The
     widget does not even take a `ChildState`, so it is byte-identical in all
     four child states — the strongest available statement that this surface
     is parent context and nothing else.

   NARROW LADDER (measured, not guessed): the selected AGENT NAME and the
   ACTIVE TASK TEXT survive to the last column. Everything else goes in this
   order — `DEMO DATA` shortens to `demo`, the `◆ WEAVE` mark shortens to `◆`,
   the plan name leaves the header, `next` leaves entirely, the word `cycle`
   leaves the `Alt+A` hint, and the task marks collapse into the `n/total`
   fraction. `Alt+A` itself is the last hint standing, and it survives every
   practical terminal width.
   ========================================================================== */

interface WidgetView {
	readonly width: number;
	readonly p: Paint;
}

function planProgress(): string {
	return `${CONTEXT.taskOrdinal}/${CONTEXT.taskTotal}`;
}

/**
 * Everything the widget is allowed to say. Deliberately small: it is the
 * structural reason the persistent parent surface cannot leak child telemetry.
 */
interface WidgetFacts {
	readonly badge: string;
	readonly agent: string;
	readonly role: string;
	readonly model: string;
	readonly plan: string;
	/** `3/8`. */
	readonly progress: string;
	readonly task: string;
	readonly nextTask: string;
	/** Alt+A cycle candidates, selected agent first. */
	readonly cycle: readonly string[];
}

function widgetFacts(): WidgetFacts {
	return {
		badge: CONTEXT.badge,
		agent: CONTEXT.agent,
		role: CONTEXT.agentRole,
		model: CONTEXT.agentModel,
		plan: CONTEXT.plan,
		progress: planProgress(),
		task: CONTEXT.task,
		nextTask: CONTEXT.nextTask,
		cycle: CONTEXT.cycle,
	};
}

/** Width bands the widget degrades through. Measured, never guessed. */
type WidgetTier = "wide" | "mid" | "tight" | "micro";

function widgetTier(width: number): WidgetTier {
	return width >= 96
		? "wide"
		: width >= 68
			? "mid"
			: width >= 46
				? "tight"
				: "micro";
}

/** Subtle but never absent: the mark shortens before it disappears. */
function demoTag(p: Paint, tier: WidgetTier): string {
	return p.dim(tier === "wide" || tier === "mid" ? DEMO_MARK : "demo");
}

/**
 * The Weave mark. It is decoration around the agent name, so a micro terminal
 * keeps the diamond and spends its columns on the name instead.
 */
function widgetBadge(tier: WidgetTier): string {
	return tier === "micro" ? "◆" : CONTEXT.badge;
}

/**
 * Joins pieces in priority order, dropping every piece that does not fit —
 * EXCEPT the first, which is clipped instead. The first piece always carries
 * the selected agent, and the narrow contract says the agent name is the last
 * thing the widget may lose.
 */
function joinFit(
	pieces: ReadonlyArray<string>,
	width: number,
	sep: string,
): string {
	const out: string[] = [];
	let used = 0;
	for (const piece of pieces) {
		if (!piece) continue;
		const add =
			(out.length === 0 ? 0 : visibleWidth(sep)) + visibleWidth(piece);
		if (used + add > width) {
			if (out.length === 0) return clip(piece, Math.max(0, width));
			break;
		}
		out.push(piece);
		used += add;
	}
	return out.join(sep);
}

/** Columns a row may spend on its left side once the demo mark is reserved. */
function leftRoom(width: number, mark: string): number {
	return Math.max(0, width - visibleWidth(mark) - 2);
}

/** Spaced task marks: filled for done, half for active, hollow after. */
function planDots(p: Paint): string {
	return CONTEXT.tasks
		.map(([status]) =>
			status === "done"
				? p.muted("●")
				: status === "active"
					? p.acc("◐")
					: p.dim("○"),
		)
		.join(" ");
}

/**
 * THE ROUND-7 AMENDMENT — the agent-cycle keybind, shown beside the selected
 * primary agent so cycling is discoverable without a cheatsheet.
 *
 * It only appears when there is somewhere to cycle TO, and it degrades by
 * dropping the descriptive word first: `Alt+A cycle` → `Alt+A`. The keybind
 * itself is the last piece of the hint to go, and `joinFit` places it ahead of
 * the plan name, so a narrowing terminal surrenders the plan before the key.
 */
function cycleHint(p: Paint, f: WidgetFacts, tier: WidgetTier): string {
	if (f.cycle.length <= 1) return "";
	const key = p.acc("Alt+A");
	return tier === "wide" || tier === "mid" ? `${key} ${p.dim("cycle")}` : key;
}

/**
 * PLAN FIRST. An agent header (with its cycle keybind) over spaced task marks,
 * then an explicit `now` and `next`, so a long plan reads as a position in a
 * sequence instead of a fraction.
 */
function renderPlanRailWidget({ width, p }: WidgetView): string[] {
	const f = widgetFacts();
	const tier = widgetTier(width);
	const mark = demoTag(p, tier);
	const header = joinFit(
		[
			`${p.acc(widgetBadge(tier))} ${p.rule("·")} ${p.bold(f.agent)}`,
			cycleHint(p, f, tier),
			tier === "micro" ? "" : p.muted(f.plan),
		],
		leftRoom(width, mark),
		p.rule(" · "),
	);
	const marks =
		tier === "micro"
			? p.acc(f.progress)
			: `${planDots(p)}   ${p.acc(f.progress)}`;
	const rows = [
		rowLR(header, mark, width),
		cell(marks, width),
		cell(
			`${p.acc("┃")} ${p.dim("now ")}  ${p.text(clip(f.task, Math.max(1, width - 10)))}`,
			width,
		),
	];
	if (tier === "micro" || tier === "tight") return rows;
	return [
		...rows,
		cell(
			`${p.rule("┗")} ${p.dim("next")}  ${p.muted(clip(f.nextTask, Math.max(1, width - 10)))}`,
			width,
		),
	];
}

/** The widget's only entry point, plus the width contract for every row. */
function renderContextWidget(view: WidgetView): string[] {
	return renderPlanRailWidget(view).map((line) => cell(line, view.width));
}

/* ==========================================================================
   5. VIEW MODEL
   ========================================================================== */

/**
 * Locked search state. `open`, the current ordinal and whether a jump has been
 * accepted are SHARED overlay state, so changing the demo child state keeps the
 * search behaviour rather than reinventing it per state.
 */
interface NavUi {
	readonly open: boolean;
	/** 1-based match ordinal. Clamped into range for the live state. */
	readonly current: number;
	/** Enter was pressed: the transcript stays anchored after navigation closes. */
	readonly accepted: boolean;
}

interface OverlayUi {
	readonly nav: NavUi;
	readonly confirmCancel: boolean;
	readonly draft: string;
}

interface View {
	readonly width: number;
	readonly height: number;
	readonly p: Paint;
	readonly s: ChildState;
	readonly ui: OverlayUi;
	/** True when the overlay is too narrow for the rail and side chrome. */
	readonly narrow: boolean;
	/** True when vertical room forces the banner and header to collapse. */
	readonly short: boolean;
}

/* ==========================================================================
   6. COMPONENTS
   Every group is a pure function of (view, width) returning width-safe lines.
   6a shared parts · 6b header facts and header atoms · 6c operational facts
   6d prompt controls and search · 6e event helpers
   6f the Pi-native transcript · 6g the Status Matrix rail
   6h the Session Header · 6i the overlay body that composes all of the above.
   6j settlement facts — Native Settlement's whole derived vocabulary.
   ========================================================================== */

/* --- 6a. small shared parts --------------------------------------------- */

function ruleRow(v: View, width: number, ch = "─"): string {
	return cell(v.p.rule(repeat(ch, width)), width);
}

function sectionHead(p: Paint, title: string, width: number): string {
	const fill = Math.max(0, width - visibleWidth(title) - 1);
	return cell(`${p.muted(title)} ${p.rule(repeat("─", fill))}`, width);
}

/**
 * Stacks operational sections into a fixed number of rows. Blank spacers go
 * first, then section detail, so no category is ever dropped outright: the
 * rail always keeps at least the heading and one row of every group.
 */
function stackSections(
	sections: ReadonlyArray<readonly string[]>,
	room: number,
): string[] {
	const spaced = sections.flatMap((section, i) =>
		i === 0 ? [...section] : ["", ...section],
	);
	if (spaced.length <= room) return spaced;
	const tight = sections.flatMap((section) => [...section]);
	if (tight.length <= room) return tight;
	const count = sections.length;
	if (room < count * 2) {
		// Too tight for headings: keep each group's single most valuable row.
		return sections
			.map((section) => section[1] ?? section[0] ?? "")
			.slice(0, room);
	}
	// Heading plus one row per group, then grow groups round-robin.
	const take = sections.map((section) => Math.min(2, section.length));
	let used = take.reduce((sum, n) => sum + n, 0);
	let grew = true;
	while (used < room && grew) {
		grew = false;
		for (let i = 0; i < count && used < room; i++) {
			const section = sections[i] as readonly string[];
			const current = take[i] as number;
			if (current < section.length) {
				take[i] = current + 1;
				used++;
				grew = true;
			}
		}
	}
	return sections.flatMap((section, i) => section.slice(0, take[i]));
}

/**
 * Shows the newest rows and states how many scrolled out of view. Real child
 * transcripts scroll; the marker keeps that visible instead of silent loss.
 */
function scrollTail(
	v: View,
	lines: readonly string[],
	width: number,
	room: number,
): string[] {
	if (room <= 0) return [];
	if (lines.length <= room) return fitTo(lines, room, "tail");
	const hidden = lines.length - (room - 1);
	return [
		cell(v.p.muted(`↑ ${hidden} earlier row(s) · / to search`), width),
		...lines.slice(hidden),
	];
}

/* --- 6b. header facts + shared header atoms ------------------------------ */

/**
 * THE LOCKED HEADER'S FACTS — round 6's selected pruning, with the user's
 * amendment applied.
 *
 * The type is the lock. There is no `telemetry` group and no `childHint`
 * field, so no future edit can quietly reintroduce status, elapsed, turn,
 * run, branch, queue, tokens, cost, live activity or a bounded child id into
 * the header: those facts are unreachable from here and live in the Status
 * Matrix rail (section 6g) and on the outer frame marker (section 9).
 *
 * Because nothing here is state-derived, the header is INVARIANT across all
 * six child states, settled ones included. Press Tab and watch: the rail, the
 * frame marker and the transcript change; the header does not.
 */
interface FactPart {
	/** Stable identifier used by the smoke test's subsequence assertions. */
	readonly id: string;
	/** Painted, ready-to-place text. Empty means the fact was deleted. */
	readonly text: string;
}

interface HeaderFacts {
	readonly role: string;
	readonly name: string;
	readonly boundedTitle: string;
	readonly parent: string;
	readonly plan: string;
	readonly taskCrumb: string;
	readonly subtask: string;
	/** The child's model. Row 1 only, immediately after the name. Never right. */
	readonly model: string;
}

function headerFacts(_v: View): HeaderFacts {
	return {
		role: CHILD.role,
		name: CHILD.agent,
		boundedTitle: CHILD.boundedTitle,
		parent: CONTEXT.agent,
		plan: CONTEXT.plan,
		taskCrumb: `task ${planProgress()} ${CONTEXT.task}`,
		subtask: CONTEXT.subtask,
		model: CHILD.model,
	};
}

/**
 * Canonical order of every fact the LOCKED Session Header can print. Output is
 * recorded in this order regardless of how a width laid the rows out, so the
 * smoke test can assert the model always sits between the child's name and its
 * role — the user's round-6 amendment — at every width and in every state.
 */
const HEADER_FACT_ORDER: readonly string[] = [
	"child-badge-name",
	"model",
	"role",
	"title",
	"parent",
	"plan",
	"task",
	"subtask",
];

/**
 * Fills a row in priority order and stops at the first fact that does not fit,
 * recording exactly which facts survived. A squeezed row therefore loses its
 * LAST fact instead of truncating its first.
 */
function joinParts(
	parts: readonly FactPart[],
	width: number,
	sep: string,
): { line: string; kept: string[] } {
	const out: string[] = [];
	const kept: string[] = [];
	let used = 0;
	for (const part of parts) {
		if (!part.text) continue;
		const add =
			(out.length === 0 ? 0 : visibleWidth(sep)) + visibleWidth(part.text);
		if (used + add > width) break;
		out.push(part.text);
		kept.push(part.id);
		used += add;
	}
	return { line: out.join(sep), kept };
}

/**
 * Width bands every header degrades through. `tight` is the same threshold the
 * body uses for `narrow`, so a header never claims room the overlay does not
 * have.
 */
type HeaderTier = "wide" | "mid" | "tight";

function headerTier(width: number): HeaderTier {
	return width >= 96 ? "wide" : width >= 62 ? "mid" : "tight";
}

const HEADER_SEP = " · ";

/**
 * The inverse badge that opens the identity row: the Session Header's
 * Pi-session-like identity mark, not a content choice.
 */
const CHILD_BADGE = " CHILD ";

/**
 * True when badge, name, MODEL, role and bounded title all fit on one row.
 * Measured, never guessed, and deliberately conservative: below this the
 * identity area grows to two rows instead of letting `joinParts` drop the task
 * title, which is the one identity fact no width is allowed to take.
 */
function identityFitsOneRow(f: HeaderFacts, width: number): boolean {
	const need =
		visibleWidth(CHILD_BADGE) +
		1 +
		visibleWidth(f.name) +
		visibleWidth(HEADER_SEP) +
		visibleWidth(f.model) +
		visibleWidth(HEADER_SEP) +
		visibleWidth(f.role) +
		visibleWidth(HEADER_SEP) +
		visibleWidth(f.boundedTitle);
	return need <= width;
}

/** The two facts no width may take: who this is and what it was given. */
function identityCoreFitsOneRow(f: HeaderFacts, width: number): boolean {
	const need =
		visibleWidth(CHILD_BADGE) +
		1 +
		visibleWidth(f.name) +
		visibleWidth(HEADER_SEP) +
		visibleWidth(f.boundedTitle);
	return need <= width;
}

/** Budget for the right-hand side of a header row. Mirrors `rowLR`'s cap. */
function rightBudget(width: number): number {
	return Math.max(8, Math.floor(width * 0.6));
}

/**
 * The one row the header may never lose when the overlay is vertically starved.
 *
 * It keeps the two identity facts the full header also refuses to drop — WHO
 * this is and WHAT it was given. The frame marker
 * one row above and the compact matrix below still carry status, elapsed,
 * queue and cost. The smoke test asserts the child name and the bounded title
 * survive here at every width from 40 to 200 columns and in every child state.
 */
function identitySafetyRow(v: View, width: number): string[] {
	const { p } = v;
	const f = headerFacts(v);
	const badge = `${p.inv(p.acc(CHILD_BADGE))} ${p.bold(f.name)}`;
	if (identityCoreFitsOneRow(f, width)) {
		return [
			rowLR(badge, p.text(clip(f.boundedTitle, rightBudget(width))), width),
		];
	}
	return [cell(badge, width), cell(p.text(clip(f.boundedTitle, width)), width)];
}

/* --- 6c. shared operational facts (one source for the rail and headers) -- */

/**
 * Every operational fact the rail exposes or deliberately compresses. Reading
 * it from one place is what lets the Session Header and the child prompt stay
 * quiet: nothing they drop is actually lost.
 */
interface RailFacts {
	readonly status: string;
	readonly tone: Tone;
	readonly run: string;
	readonly branch: string;
	readonly turn: string;
	readonly elapsed: string;
	readonly toolTitle: string;
	readonly tool: string;
	readonly target: string;
	readonly args: string;
	/** Progress line, result line or failure line of the latest tool. */
	readonly toolOutcome: string;
	readonly toolTone: Tone;
	readonly failed: boolean;
	/** Safe, captured tool-error detail. Never environment or secret values. */
	readonly errorDetail: string;
	readonly queueCount: number;
	readonly queued: readonly string[];
	readonly firstQueued: string;
	readonly tokensIn: number;
	readonly tokensOut: number;
	readonly cost: string;
	readonly live: string;
}

function railFacts(s: ChildState): RailFacts {
	const tool = lastTool(s);
	const error = [...s.events].reverse().find((e) => e.kind === "error");
	const toolTone: Tone = tool ? eventTone(tool) : "mute";
	return {
		status: s.status,
		tone: s.tone,
		run: s.run,
		branch: s.branch.replace("branch ", ""),
		turn: String(s.turn),
		elapsed: s.elapsed,
		toolTitle: tool?.title ?? "no tool call yet",
		tool: tool ? toolName(tool) : "none",
		target: tool ? toolTarget(tool) : "",
		args: tool?.body ?? "",
		toolOutcome: tool?.result ?? "no result yet",
		toolTone,
		failed: toolTone === "bad",
		// Captured failure text reaches the rail only through the sanitiser.
		errorDetail: safeText(error?.body ?? ""),
		queueCount: s.queue,
		queued: s.queued,
		firstQueued: s.queued[0] ?? "empty",
		tokensIn: s.tokensIn,
		tokensOut: s.tokensOut,
		cost: s.cost,
		live: s.live,
	};
}

function lastTool(s: ChildState): ChildEvent | undefined {
	return [...s.events].reverse().find((e) => e.kind === "tool");
}

/* ==========================================================================
   6d. NAVIGATION AND SEARCH FACTS

   One matching engine, one fact type, one placement. Everything the search
   surface may say comes from `NavFacts`, and every string it paints comes from
   the ANSI-FREE plain render, never from painted bytes.

   WHY THE MATCHES ARE REAL
     `renderTranscriptPane` renders each event TWICE at the same width — once
     with the live theme and once with `plainPaint()` — and records the row
     span each event occupies. Both renders have identical layout because every
     primitive in section 2 measures with `visibleWidth`, so row `i` of the
     plain render is the ANSI-free twin of row `i` of the painted one. Matches
     are counted on the twin. That is what makes highlighting terminal-safe:
     the prototype never slices, re-colours or re-emits a byte that came out of
     a painted transcript line.

   WHY IT IS PER-EVENT
     `renderPiNative` is stateless across events, so rendering the events one
     at a time and concatenating is byte-identical to rendering them together.
     The smoke test asserts exactly that. It buys the row→event map the rail's
     match list needs without touching the locked round-3 renderer.
   ========================================================================== */

const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

/** Defensive: no snippet, marker or highlight is ever built from painted bytes. */
function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

/** Collapses a transcript row into one snippet line. */
function condense(text: string): string {
	return stripAnsi(text).replace(/\s+/gu, " ").trim();
}

/** Which rows of the pane render belong to which transcript event. */
interface EventSpan {
	readonly eventIndex: number;
	readonly start: number;
	readonly length: number;
}

/** The transcript pane, painted and plain, with its row→event map. */
interface PaneRender {
	readonly painted: readonly string[];
	readonly plain: readonly string[];
	readonly spans: readonly EventSpan[];
}

function renderTranscriptPane(v: View, width: number): PaneRender {
	const painted: string[] = [];
	const plain: string[] = [];
	const spans: EventSpan[] = [];
	const plainView: View = { ...v, p: plainPaint() };
	v.s.events.forEach((event, eventIndex) => {
		const one: ChildState = { ...v.s, events: [event] };
		const start = painted.length;
		const lines = renderPiNative({ ...v, s: one }, width);
		const bare = renderPiNative({ ...plainView, s: one }, width);
		painted.push(...lines);
		plain.push(...bare.map(stripAnsi));
		spans.push({ eventIndex, start, length: lines.length });
	});
	return { painted, plain, spans };
}

/** One occurrence of the query in one rendered row. */
interface NavMatch {
	/** 1-based position in the ordered match list. */
	readonly ordinal: number;
	/** Row index in the pane render. */
	readonly row: number;
	readonly eventIndex: number;
	readonly kind: EventKind;
	readonly at: string;
	/** What the owning event is called in a match list. */
	readonly label: string;
	/** ANSI-free row text, collapsed to one line. */
	readonly snippet: string;
}

/** What an event is called in a match list. Short enough for a rail row. */
function navEventLabel(event: ChildEvent): string {
	switch (event.kind) {
		case "tool":
			return toolName(event);
		case "assistant":
			return replyLabel(event);
		case "error":
			return "tool error";
		case "prompt":
			return "delegation prompt";
		case "reason":
			return "reasoning summary";
		case "queue":
			return (event.title.split(" · ")[0] ?? "queue").trim();
		case "sys":
			return "session";
	}
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let count = 0;
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at < 0) return count;
		count++;
		from = at + needle.length;
	}
}

function spanOfRow(
	spans: readonly EventSpan[],
	row: number,
): EventSpan | undefined {
	return spans.find(
		(span) => row >= span.start && row < span.start + span.length,
	);
}

/**
 * Every occurrence of the query, in transcript order. Counting OCCURRENCES
 * rather than rows is what makes the counter honest: a wrapped paragraph that
 * says the word twice reports two matches, and `n` visits both.
 */
function navMatchList(
	state: ChildState,
	pane: PaneRender,
	query: string,
): readonly NavMatch[] {
	const needle = query.toLowerCase();
	const matches: NavMatch[] = [];
	pane.plain.forEach((line, row) => {
		const hits = countOccurrences(line.toLowerCase(), needle);
		if (hits === 0) return;
		const span = spanOfRow(pane.spans, row);
		if (span === undefined) return;
		const event = state.events[span.eventIndex];
		if (event === undefined) return;
		for (let i = 0; i < hits; i++) {
			matches.push({
				ordinal: matches.length + 1,
				row,
				eventIndex: span.eventIndex,
				kind: event.kind,
				at: event.at,
				label: navEventLabel(event),
				snippet: condense(line),
			});
		}
	});
	return matches;
}

/**
 * Everything the locked search may say. It has no prompt, no widget, no rail
 * telemetry, no settlement facts and no raw painted text — the structural
 * reason search cannot quietly become a second status or verdict surface.
 */
interface NavFacts {
	readonly open: boolean;
	/** A jump was accepted with Enter; the anchor outlives the search UI. */
	readonly accepted: boolean;
	readonly query: string;
	readonly matches: readonly NavMatch[];
	readonly total: number;
	/** 1-based ordinal, or 0 when the state has no match at all. */
	readonly current: number;
	readonly currentMatch: NavMatch | undefined;
	/** `2/5`, or `0/0` when nothing matched. */
	readonly counter: string;
	/** `assistant 2 · tool 1 · error 1` — where the matches are, by kind. */
	readonly summary: string;
	readonly empty: boolean;
	/** Pane rows carrying a match. Used by the transcript marker column. */
	readonly rows: ReadonlySet<number>;
	/** Row the transcript window is anchored on, or undefined when it is not. */
	readonly anchorRow: number | undefined;
}

function navSummary(matches: readonly NavMatch[]): string {
	const counts = new Map<string, number>();
	for (const match of matches) {
		counts.set(match.kind, (counts.get(match.kind) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([kind, n]) => `${kind} ${n}`)
		.join(" · ");
}

function navFacts(v: View, pane: PaneRender): NavFacts {
	const matches = navMatchList(v.s, pane, NAV_QUERY);
	const total = matches.length;
	const current = total === 0 ? 0 : Math.min(Math.max(1, v.ui.nav.current), total);
	const currentMatch = current === 0 ? undefined : matches[current - 1];
	const live = v.ui.nav.open || v.ui.nav.accepted;
	return {
		open: v.ui.nav.open,
		accepted: v.ui.nav.accepted,
		query: NAV_QUERY,
		matches,
		total,
		current,
		currentMatch,
		counter: `${current}/${total}`,
		summary: total === 0 ? "no match in this state" : navSummary(matches),
		empty: total === 0,
		rows: new Set(matches.map((m) => m.row)),
		anchorRow: live ? currentMatch?.row : undefined,
	};
}

/**
 * THE ONLY HIGHLIGHTER. It takes PLAIN text — caller-guaranteed, and stripped
 * again here — clips it to the given width, and repaints the query occurrences
 * with the theme's inverse accent. No byte of transcript colour survives into
 * the search surface, so a tool that printed an escape sequence cannot paint
 * the rail.
 */
function highlightQuery(
	p: Paint,
	raw: string,
	query: string,
	width: number,
	base: (s: string) => string = (s) => p.text(s),
): string {
	const text = clip(stripAnsi(raw), Math.max(0, width));
	if (query === "") return base(text);
	const needle = query.toLowerCase();
	const hay = text.toLowerCase();
	const out: string[] = [];
	let from = 0;
	for (;;) {
		const at = hay.indexOf(needle, from);
		if (at < 0) break;
		if (at > from) out.push(base(text.slice(from, at)));
		out.push(p.inv(p.acc(text.slice(at, at + needle.length))));
		from = at + needle.length;
	}
	if (from < text.length) out.push(base(text.slice(from)));
	return out.join("");
}

/* ==========================================================================
   6d-II. THE LOCKED CHILD PROMPT — PRIMARY-LIKE EDITOR

   The bottom of the overlay: the one place the user ACTS on a child instead
   of reading it. There is ONE renderer, `promptPrimaryEditor` — a bordered
   Pi-style input panel whose label names the target and the turn, over one
   muted key row.

     row 1  `╭─ steer shuttle · turn 4 · 1 queued · Alt+Enter queues instead ─╮`
     row 2  `│ ❯ also assert the 200-column case█                             │`
     row 3  `╰──────────────────────────────────────────────────────────────╯`
     row 4  `Enter steer · Alt+Enter queue · q cancel (confirm) · / search · Esc close`

   WHAT IS STRUCTURAL
     `PromptFacts` is the vocabulary and `promptKeys` is the key set. The
     editor cannot invent a key, cannot render a live input for a settled child
     (the field text and caret come from `promptField`), and cannot reprint raw
     tool-error text — the failure detail stays in the Status Matrix rail.
     `renderPromptGroup` answers the cancel confirmation ITSELF and never
     reaches the editor while it is open, so `q` can never cancel without a
     `y / n` answer.

     `PromptFacts` cannot reach `NavFacts`, so the prompt is BYTE-IDENTICAL
     with search open and closed. And because Native Settlement adds no
     surface, a settled child gets THIS editor, read-only and caretless —
     `promptFacts` decides once, through `settlementFacts`, that a CANCELLED
     child is settled exactly like a completed one.
   ========================================================================== */

/**
 * Everything the prompt may say. Nothing here is raw error text, and nothing
 * here can be typed into: `field` is already resolved for the state, which is
 * why a settled child can never be given a live input or a caret.
 */
interface PromptFacts {
	readonly target: string;
	readonly turn: number;
	/** Settled: read-only. No steer, no queue, nothing to cancel. */
	readonly settled: boolean;
	/** The latest tool failed. The child is still alive. */
	readonly failed: boolean;
	readonly queueCount: number;
	readonly firstQueued: string;
	/** Field text: the draft, or the read-only notice for a settled child. */
	readonly field: string;
	/** Consequence of `Enter` under the canonical split. */
	readonly steerEffect: string;
	/** Consequence of `Alt+Enter`. */
	readonly queueEffect: string;
	/** One safe line of state guidance. Never raw error output. */
	readonly guidance: string;
	readonly stateWord: string;
	readonly tone: Tone;
}

function promptFacts(v: View): PromptFacts {
	const s = v.s;
	// A CANCELLED child is settled exactly like a completed one: no steer, no
	// queue, no caret. It is decided ONCE, in `settlementFacts`, so the prompt and
	// the frame marker can never disagree about whether a child is still live.
	const settlement = settlementFacts(s);
	const settled = settlement.settled;
	const failed = s.id === "error";
	const recovering = s.id === "recovery";
	const queueCount = s.queue;
	const firstQueued = s.queued[0] ?? "";
	const queueTail =
		queueCount === 0 ? "queue empty" : `${queueCount} already queued`;
	// The failure DETAIL never reaches the prompt: only what the user can safely
	// do next. The captured diff stays in the Status Matrix rail.
	const steerEffect = settled
		? "this child has settled — the transcript is read-only"
		: failed
			? `steer a retry — ${CHILD.agent} is still alive at turn ${s.turn}`
			: `interrupts ${CHILD.agent} at turn ${s.turn}`;
	const queueEffect = settled
		? "nothing can be queued for a settled child"
		: `delivered after turn ${s.turn} · ${queueTail}`;
	const guidance = settled
		? s.id === "cancelled"
			? "cancelled · read-only · nothing was completed · / search · Esc close"
			: "settled · read-only · / search the transcript · Esc close"
		: failed
			? `tool error · ${CHILD.agent} is still alive — steer a retry, or cancel with confirmation · detail stays in the rail`
			: recovering
				? `attempt 2 is live at turn ${s.turn} — steer or queue as usual`
				: queueCount > 0
					? `${queueCount} queued · next up “${firstQueued}”`
					: "steer now, or queue for after this turn";
	return {
		target: CHILD.agent,
		turn: s.turn,
		settled,
		failed,
		queueCount,
		firstQueued: firstQueued === "" ? "queue empty" : firstQueued,
		field: settled
			? s.id === "cancelled"
				? "read-only — this child was cancelled"
				: "read-only — this child has settled"
			: v.ui.draft,
		steerEffect,
		queueEffect,
		guidance,
		stateWord: settlement.word,
		tone: settlement.tone,
	};
}

type PromptKeyId = "send" | "queue" | "cancel" | "search" | "close";

interface PromptKey {
	readonly id: PromptKeyId;
	readonly key: string;
	readonly label: string;
	/** Consequence marker. `q` always carries `(confirm)`. */
	readonly note: string;
	readonly enabled: boolean;
	readonly danger: boolean;
}

/**
 * The complete key set, and the only one. A settled child disables everything
 * that would mutate it and keeps only search and close.
 */
function promptKeys(f: PromptFacts): readonly PromptKey[] {
	const live = !f.settled;
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

function pickKeys(
	f: PromptFacts,
	ids: readonly PromptKeyId[],
): readonly PromptKey[] {
	const all = promptKeys(f);
	return ids
		.map((id) => all.find((k) => k.id === id))
		.filter((k): k is PromptKey => k !== undefined);
}

type NoteLevel = "all" | "danger" | "none";

/**
 * A disabled key carries a printed `✕`, not only a dim colour: a settled child
 * must read as unactionable on a monochrome terminal too.
 */
function keyChip(p: Paint, k: PromptKey, notes: NoteLevel): string {
	const body = k.enabled
		? `${p.acc(k.key)} ${p.text(k.label)}`
		: `${p.dim("✕")} ${p.dim(k.key)} ${p.dim(k.label)}`;
	const showNote =
		k.note !== "" && (notes === "all" || (notes === "danger" && k.danger));
	return showNote ? `${body} ${p.dim(k.note)}` : body;
}

/**
 * The order a narrowing row gives keys up: `/ search` first, then
 * `Alt+Enter queue`, then `q cancel`. `Enter` and `Esc` are the floor, because
 * a control bar that cannot say how to act or how to leave is not a control
 * bar. Nothing here changes what the keys DO — only what the row has room to
 * say about them.
 */
function keyLadder(
	keys: readonly PromptKey[],
): ReadonlyArray<readonly PromptKey[]> {
	const without = (
		list: readonly PromptKey[],
		id: PromptKeyId,
	): readonly PromptKey[] => list.filter((k) => k.id !== id);
	const l2 = without(keys, "search");
	const l3 = without(l2, "queue");
	return [keys, l2, l3, without(l3, "cancel")];
}

/**
 * One row of key chips. It sheds ordinary notes first, then the danger note,
 * and only then whole chips — in `keyLadder` order, so `q cancel (confirm)`
 * keeps its consequence marker far longer than `/ search` keeps its place, and
 * `Esc close` is never the casualty. The confirmation itself is enforced by
 * `renderPromptGroup`, not by this row.
 */
function keyLine(
	p: Paint,
	keys: readonly PromptKey[],
	width: number,
): string {
	const sep = p.rule(" · ");
	const ladder = keyLadder(keys);
	for (const rung of ladder) {
		for (const level of ["all", "danger", "none"] as const) {
			const line = rung.map((k) => keyChip(p, k, level)).join(sep);
			if (visibleWidth(line) <= width) return line;
		}
	}
	const floor = ladder[ladder.length - 1] ?? keys;
	return joinFit(
		floor.map((k) => keyChip(p, k, "none")),
		width,
		sep,
	);
}

/**
 * The input line. There is only one, which is why a settled child can never be
 * shown a caret or an editable draft: the read-only rendering is decided here,
 * once.
 */
function promptField(p: Paint, f: PromptFacts, width: number): string {
	const glyph = f.settled ? p.dim("▪") : p.acc("❯");
	const room = Math.max(1, width - 3);
	const text = clip(f.field, room);
	return f.settled
		? `${glyph} ${p.dim(text)}`
		: `${glyph} ${p.text(text)}${p.inv(" ")}`;
}

/* --- a quiet panel, drawn in the MUTED border colour ---------------------- */

/**
 * The overlay owns exactly one high-contrast frame (section 9). This panel is
 * deliberately drawn with `rule` (borderMuted) so the Primary-Like Editor
 * reads as an inner input surface and never competes with that frame.
 */
function panelTop(p: Paint, label: string, width: number): string {
	if (width < 6) return cell(p.rule(repeat("─", width)), width);
	const inner = width - 2;
	const text = clip(label, Math.max(0, inner - 2));
	const fill = Math.max(0, inner - visibleWidth(text) - 1);
	return cell(
		`${p.rule("╭─")}${p.muted(text)}${p.rule(repeat("─", fill))}${p.rule("╮")}`,
		width,
	);
}

function panelRow(p: Paint, body: string, width: number): string {
	if (width < 6) return cell(body, width);
	return cell(
		`${p.rule("│")} ${cell(body, width - 3)}${p.rule("│")}`,
		width,
	);
}

function panelBottom(p: Paint, width: number): string {
	if (width < 4) return cell(p.rule(repeat("─", width)), width);
	return cell(
		`${p.rule("╰")}${p.rule(repeat("─", width - 2))}${p.rule("╯")}`,
		width,
	);
}

/* --- the Primary-Like Editor --------------------------------------------- */

/**
 * PI'S OWN EDITOR, BORROWED. A bordered input panel whose label names the
 * target and the turn, with a single muted key hint underneath. The user is
 * meant to feel they are typing into the same kind of box Pi gives them, so
 * the control surface stays quiet and the input dominates.
 *
 * Density 4 rows. Narrow ladder: the label shortens to the target name, then
 * the key row sheds notes and trailing keys.
 */
function promptPrimaryEditor(v: View, width: number): string[] {
	const { p } = v;
	const f = promptFacts(v);
	// The label is where the editor carries state: the target and turn always,
	// the queue depth when there is one, and safe retry wording after a failure.
	const queueTag = f.queueCount > 0 ? ` · ${f.queueCount} queued` : "";
	const lead = f.failed ? `tool error · steer a retry into ${f.target}` : `steer ${f.target}`;
	const label = f.settled
		? ` ${f.target} · ${f.stateWord.toLowerCase()} · read-only `
		: width >= 78
			? ` ${lead} · turn ${f.turn}${queueTag} · Alt+Enter queues instead `
			: ` ${lead} · turn ${f.turn}${queueTag} `;
	return [
		panelTop(p, label, width),
		panelRow(p, promptField(p, f, Math.max(1, width - 3)), width),
		panelBottom(p, width),
		cell(
			keyLine(
				p,
				pickKeys(f, ["send", "queue", "cancel", "search", "close"]),
				width,
			),
			width,
		),
	];
}

/**
 * The cancel confirmation. It is rendered HERE, and `renderPromptGroup`
 * returns it INSTEAD of the locked editor — the structural reason nothing in
 * this prototype can make `q` cancel without a `y / n` confirmation, and the
 * reason navigation sits BELOW the confirmation in the key precedence chain.
 */
function promptCancelConfirm(v: View, width: number): string[] {
	const { p } = v;
	const f = promptFacts(v);
	const question = f.settled
		? p.warn("nothing to cancel — already settled")
		: p.bad(`cancel ${f.target} at turn ${f.turn}?`);
	return [
		cell(
			`${question} ${p.acc("y")} ${p.dim("yes")} ${p.rule("·")} ${p.acc("n")} ${p.dim("no")} ${p.rule("·")} ${p.dim("demo only — nothing is cancelled")}`,
			width,
		),
	];
}

/** The overlay's only prompt entry point, plus the width contract. */
function renderPromptGroup(v: View, width: number): string[] {
	const rows = v.ui.confirmCancel
		? promptCancelConfirm(v, width)
		: promptPrimaryEditor(v, width);
	return rows.map((line) => cell(line, width));
}

/* ==========================================================================
   6j. SETTLEMENT — NATIVE SETTLEMENT, THE FINAL OUTCOME DESIGN

   THE DESIGN IS THE ABSENCE OF CHROME. A completed, failed, cancelled or
   retrying child is read exactly where an ordinary one is read:

     - the authoritative final response, the captured failure line, the
       cancellation record and the retry record are ORDINARY transcript
       events in the locked Pi-native style (section 6f);
     - the outer frame marker (section 9) and the Status Matrix rail
       (section 6g) carry the state word, the result and the aliveness;
     - the locked Primary-Like Editor (section 6d-II) becomes read-only and
       caretless once the child has settled;
     - RECOVERY IS LIVE, so it keeps its editor, and its attempt lineage is
       read in the native transcript and on the rail like any other work.

   There is no banner band, no rail verdict section, no transcript checkpoint
   block and no action deck. The cost, stated plainly, is that the verdict is
   read out of chronology — that is the accepted trade.

   WHAT IS LEFT TO DERIVE is therefore small: the phase, whether the child has
   settled, and the word, glyph and tone the frame marker and the rail agree
   on. `SettlementFacts` has no headline, no banner copy and no action set,
   because no surface exists that could print one. That is the structural
   reason this file cannot quietly regrow a second verdict region.

   THE SANITISER IS STILL STRUCTURAL. Failure text is the one thing a child
   can put on screen that it did not author safely, and it reaches exactly two
   surfaces: the transcript's error event and the rail's error rows. Both read
   it through `safeText`, which strips ANSI, removes stack frames, redacts
   credential-shaped tokens and long opaque ids, and hides absolute paths
   outside the demo repo.
   ========================================================================== */

/**
 * The redactions every piece of captured failure text passes through. They are
 * deliberately broad: a failure surface is the wrong place to be clever.
 */
const TEXT_REDACTIONS: ReadonlyArray<{
	readonly re: RegExp;
	readonly to: string;
}> = [
	// Stack frames, in the two shapes a JS runtime prints them. The FILE-ish
	// prefix is required, so an ordinary transcript timestamp (`14:24:31`)
	// survives and only a `file.ts:12:4` location is removed.
	{ re: /\bat\s+\S+\s*\([^)]*\)/g, to: "‹stack frame removed›" },
	{ re: /\S*\.[A-Za-z]{1,5}:\d+:\d+/g, to: "‹stack frame removed›" },
	// Credential-shaped tokens.
	{
		re: /\b(?:sk|pk|ghp|gho|ghs|xox[abprs])[-_][A-Za-z0-9_-]{8,}/gi,
		to: "‹credential hidden›",
	},
	{ re: /\bbearer\s+[A-Za-z0-9._-]{8,}/gi, to: "‹credential hidden›" },
	{
		re: /\b(?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*\S+/gi,
		to: "‹credential hidden›",
	},
	// Long opaque ids: unreadable, unsearchable, unactionable — round 6's rule.
	{ re: /\b[0-9a-f]{24,}\b/gi, to: "‹opaque id hidden›" },
	// Absolute paths outside the demo repo. `~/projects/weave` stays.
	{
		re: /(?:^|(?<=\s))\/(?:Users|home|var|etc|private|tmp|opt)\/\S*/g,
		to: "‹path hidden›",
	},
];

/**
 * THE ONLY WAY CAPTURED FAILURE TEXT REACHES A SURFACE. Strips ANSI first (so
 * no byte of tool colour survives), applies every redaction, then collapses
 * whitespace so a multi-line capture can never break a width-safe row.
 */
function safeText(text: string): string {
	let out = stripAnsi(text);
	for (const rule of TEXT_REDACTIONS) out = out.replace(rule.re, rule.to);
	return out.replace(/\s+/gu, " ").trim();
}

/** Which of the six demo conditions the child is in. */
type SettlementPhase =
	| "live"
	| "queued"
	| "failed"
	| "completed"
	| "cancelled"
	| "recovering";

/**
 * Everything Native Settlement derives, and all of it. No headline, no reason
 * prose, no action list: the frame marker, the rail and the prompt are the
 * surfaces, and they already own their own wording.
 */
interface SettlementFacts {
	readonly phase: SettlementPhase;
	/** No further child work is possible. Drives the read-only prompt. */
	readonly settled: boolean;
	readonly word: string;
	readonly glyph: string;
	readonly tone: Tone;
}

function settlementPhase(s: ChildState): SettlementPhase {
	switch (s.id) {
		case "completed":
			return "completed";
		case "error":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "recovery":
			return "recovering";
		case "steered":
			return "queued";
		case "running":
			return "live";
	}
}

function settlementTone(phase: SettlementPhase): Tone {
	switch (phase) {
		case "completed":
			return "ok";
		case "failed":
			return "bad";
		case "cancelled":
			return "warn";
		case "recovering":
			return "run";
		case "queued":
			return "warn";
		case "live":
			return "run";
	}
}

/** A printed mark, so a state reads on a monochrome terminal too. */
function settlementGlyph(phase: SettlementPhase): string {
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
		case "live":
			return "●";
	}
}

/** THE ONE CONSTRUCTOR. Read by the frame marker and by `promptFacts`. */
function settlementFacts(s: ChildState): SettlementFacts {
	const phase = settlementPhase(s);
	return {
		phase,
		settled: phase === "completed" || phase === "cancelled",
		word: terminalStateWord(s),
		glyph: settlementGlyph(phase),
		tone: settlementTone(phase),
	};
}

/**
 * `RUNNING` · `TOOL ERROR` · `COMPLETED` · `STEERED` · `CANCELLED` ·
 * `RECOVERING`. ONE derivation with THREE callers — the outer frame marker,
 * the Status Matrix rail and the child prompt — so the three surfaces that
 * report a child's condition can never print different words for it.
 */
function terminalStateWord(s: ChildState): string {
	return s.status;
}

/**
 * The child's final response event, when it has one. Under Native Settlement
 * this event IS the completion surface: it is rendered by the locked
 * Pi-native transcript renderer and by nothing else.
 */
function finalResponseEvent(s: ChildState): ChildEvent | undefined {
	return s.events.find(
		(event) => event.kind === "assistant" && event.title === "final response",
	);
}

/* ==========================================================================
   6d-IV. THE LOCKED TRANSCRIPT SEARCH — RAIL SEARCH

   SEARCH IS AN OPERATIONAL FACT. `/` prepends a SEARCH section to the Status
   Matrix rail — query, counter, kind breakdown and up to three numbered
   matches, the current one inverse — and the transcript gives up two columns
   for one subtle marker (`▌` current, `·` match) and nothing else. `n / N`
   (aliases `j / k`) move the rail's cursor and the shared transcript window
   follows; `Enter` accepts the jump and anchors the window; `Esc` closes
   SEARCH ONLY, and a second `Esc` closes the overlay.

   There is ONE search surface. The find bar, the search header, the jump
   palette and the event navigator are gone from the file rather than merely
   unselectable.

   WHAT IS STRUCTURAL
     `NavFacts` is the vocabulary, and the match list is found in the
     ANSI-FREE twin render, so no byte of transcript colour can paint the
     rail. Movement, the Enter-anchors behaviour and the shared transcript
     window live in section 6i, not here.

   SEARCH WORKS IN EVERY STATE, including the four settled or exceptional
   ones: under Native Settlement the final response, the captured failure
   line, the cancellation record and the retry record are ordinary transcript
   events, so they are matched, counted, listed and jumped to like any other
   event.

   ORDERING: the SEARCH section rides the matrix's `extraSections` capability,
   which places it under the FAILURE ALERT and above every other section. A
   failing tool still outranks it: round 4 put that alert at the top for a
   reason, and a search may not demote it.
   ========================================================================== */

/** Columns the transcript gives up while search is open. */
const SEARCH_INSET = 2;

type MarkKind = "current" | "match" | "none";

function markKind(f: NavFacts, row: number): MarkKind {
	if (f.currentMatch !== undefined && f.currentMatch.row === row)
		return "current";
	return f.rows.has(row) ? "match" : "none";
}

function searchMarker(p: Paint, kind: MarkKind): string {
	return kind === "current"
		? `${p.acc("▌")} `
		: kind === "match"
			? `${p.dim("·")} `
			: "  ";
}

/**
 * The marker column beside the transcript. The pane was already built at the
 * inset width, so the row indices in `NavFacts` are the ones being marked —
 * there is no second layout to drift out of step with.
 */
function markSearchGutter(
	v: View,
	f: NavFacts,
	pane: PaneRender,
	width: number,
): readonly string[] {
	return pane.painted.map((line, row) =>
		cell(
			`${cell(searchMarker(v.p, markKind(f, row)), SEARCH_INSET)}${line}`,
			width,
		),
	);
}

/** The SEARCH section prepended to the Status Matrix rail while `/` is open. */
function searchRailSections(
	v: View,
	f: NavFacts,
	rail: number,
): ReadonlyArray<readonly string[]> {
	const { p } = v;
	const listed = f.matches.slice(0, 3);
	const rows = listed.map((match) => {
		const plain = `${match.ordinal}. ${match.label} · ${match.at}`;
		const current = f.currentMatch?.ordinal === match.ordinal;
		return cell(
			current
				? p.inv(p.acc(cell(` ▸ ${clip(plain, Math.max(1, rail - 3))} `, rail)))
				: `${p.dim("  ")}${p.muted(clip(plain, Math.max(1, rail - 2)))}`,
			rail,
		);
	});
	const more =
		f.total > listed.length
			? [cell(p.dim(`  +${f.total - listed.length} more · n / N`), rail)]
			: [];
	return [
		[
			sectionHead(p, "SEARCH", rail),
			matrixRow(p, "query", f.query, rail, (s) =>
				highlightQuery(p, s, f.query, rail),
			),
			matrixRow(p, "match", f.counter, rail, (s) =>
				f.empty ? p.bad(s) : p.acc(s),
			),
			matrixRow(p, "kinds", f.summary, rail, (s) => p.muted(s)),
			...rows,
			...more,
			cell(p.dim("  Enter jump · Esc close search"), rail),
		],
	];
}

/* --- 6e. event helpers shared by the transcript and the rails ------------ */

function kindGlyph(kind: EventKind): string {
	switch (kind) {
		case "sys":
			return "·";
		case "prompt":
			return "❯";
		case "reason":
			return "✻";
		case "tool":
			return "⚙";
		case "assistant":
			return "●";
		case "error":
			return "✖";
		case "queue":
			return "↯";
	}
}

function eventTone(event: ChildEvent): Tone {
	if (event.tone) return event.tone;
	if (event.kind === "error") return "bad";
	if (event.kind === "assistant") return "run";
	if (event.kind === "prompt") return "run";
	return "mute";
}

/** `read · file.ts` → `read`. */
function toolName(event: ChildEvent): string {
	return (event.title.split(" · ")[0] ?? event.title).trim();
}

/** `read · file.ts` → `file.ts`. Falls back to the whole title. */
function toolTarget(event: ChildEvent): string {
	const parts = event.title.split(" · ");
	return parts.length > 1 ? parts.slice(1).join(" · ").trim() : "";
}

/** What an assistant event should be called in a header. */
function replyLabel(event: ChildEvent): string {
	if (event.streaming) return "streaming reply";
	return event.title === "final response" ? "final response" : "reply";
}

/**
 * Appends the streaming caret without ever overflowing the column: if the last
 * wrapped row already fills the width, the caret moves to its own row.
 */
function withCaret(
	p: Paint,
	plainLine: string,
	indent: string,
	width: number,
	paint: (s: string) => string,
): string[] {
	const trimmed = plainLine.replace(/\s+$/u, "");
	if (visibleWidth(trimmed) + 1 <= width) {
		return [cell(paint(trimmed) + p.inv(" "), width)];
	}
	return [cell(paint(trimmed), width), cell(`${indent}${p.acc("▍")}`, width)];
}

/* ==========================================================================
   6f. THE TRANSCRIPT — PI NATIVE (selected in round 3)
   `(view, width) => width-safe lines`. It renders the delegation prompt, the
   reasoning SUMMARY, the read / edit / bash calls with their arguments and
   outputs, the safe tool error, the assistant reply (streaming or final) and
   queue / steer events.

   UNDER NATIVE SETTLEMENT THIS IS THE OUTCOME SURFACE. The final response, the
   captured failure line, the cancellation record and the retry record are
   ordinary events drawn in this one style — there is no special terminal
   rendering and no checkpoint block. Captured failure text passes through
   `safeText` on the way to the row.

   It is also the ONE place an opaque child id legitimately appears — on the
   bootstrap line, the way a session log records one — which is the contrast
   drawn against both the locked header and the persistent widget.
   ========================================================================== */

/** Two-column role gutter, mirroring Pi's own primary transcript. */
const PI_NATIVE_INDENT = "  ";

function renderPiNative(v: View, width: number): string[] {
	const { p } = v;
	const out: string[] = [];
	for (const event of v.s.events) {
		const tone = eventTone(event);
		const gutter = p.tone(tone, kindGlyph(event.kind));
		switch (event.kind) {
			case "prompt": {
				out.push(
					rowLR(
						`${gutter} ${p.bold(p.alt(`${CONTEXT.agent} → ${CHILD.agent}`))} ${p.dim("delegation prompt")}`,
						p.dim(event.at),
						width,
					),
				);
				out.push(
					...wrapIndented(event.body ?? "", width, PI_NATIVE_INDENT).map((l) =>
						p.text(l),
					),
				);
				break;
			}
			case "reason": {
				// Deliberately understated: a summary line, never a thought stream.
				out.push(
					rowLR(
						`${gutter} ${p.muted("reasoning · SUMMARY")}`,
						p.dim(event.at),
						width,
					),
				);
				out.push(
					...wrapIndented(event.body ?? "", width, PI_NATIVE_INDENT).map((l) =>
						p.dim(l),
					),
				);
				break;
			}
			case "tool": {
				// Pi-style: bare call signature, result on a `⎿` continuation.
				const args = [toolTarget(event), event.body].filter(Boolean).join(" · ");
				out.push(
					cell(`${gutter} ${p.text(toolName(event))}${p.dim(`(${args})`)}`, width),
				);
				if (event.result) {
					out.push(
						...wrapIndented(
							`⎿ ${event.result}`,
							width,
							PI_NATIVE_INDENT,
						).map((l) => p.tone(tone, l)),
					);
				}
				break;
			}
			case "error": {
				// Under Native Settlement this event IS the failure surface, so the
				// captured detail passes through the sanitiser on its way to the row.
				out.push(
					rowLR(`${gutter} ${p.bad(event.title)}`, p.dim(event.at), width),
				);
				out.push(
					...wrapIndented(
						`⎿ ${safeText(event.body ?? "")}`,
						width,
						PI_NATIVE_INDENT,
					).map((l) => p.bad(l)),
				);
				break;
			}
			case "assistant": {
				out.push(
					rowLR(
						`${gutter} ${p.dim(`${CHILD.agent} · ${replyLabel(event)}`)}`,
						p.dim(event.at),
						width,
					),
				);
				const wrapped = wrapIndented(
					event.body ?? "",
					width,
					PI_NATIVE_INDENT,
				);
				const last = wrapped.length - 1;
				wrapped.forEach((line, i) => {
					if (i === last && event.streaming) {
						out.push(
							...withCaret(p, line, PI_NATIVE_INDENT, width, (s) => p.text(s)),
						);
						return;
					}
					out.push(p.text(line));
				});
				break;
			}
			case "queue": {
				out.push(
					rowLR(`${gutter} ${p.warn(event.title)}`, p.dim(event.at), width),
				);
				out.push(
					...wrapIndented(event.body ?? "", width, PI_NATIVE_INDENT).map((l) =>
						p.dim(l),
					),
				);
				break;
			}
			case "sys": {
				out.push(
					cell(
						`${gutter} ${p.dim(event.title)} ${p.muted(clip(event.body ?? "", Math.max(1, width - visibleWidth(event.title) - 4)))}`,
						width,
					),
				);
				break;
			}
		}
		out.push("");
	}
	return out;
}

/* ==========================================================================
   6g. THE RAIL — STATUS MATRIX (selected in round 4)
   `(view, railWidth, rows, extraSections) => exactly-that-many width-safe
   lines`, plus `compactStatusMatrix` for overlays too narrow to carry a rail
   at all. It exposes status, run, branch, turn, elapsed, the active/latest
   tool with its progress, result or error, the pending queue and its first
   item, input/output tokens, cost and live activity.

   The rail is the REASON the header and the widget can both stay quiet: every
   operational fact they do not print is still here. Under Native Settlement it
   is also where a settled child's state, result and aliveness are read, through
   the ordinary `status`, `result` and `live` rows rather than a verdict
   section. `extraSections` carries exactly one guest, the SEARCH section, and
   the failure alert still outranks it.
   ========================================================================== */

/* --- shared rail atoms ---------------------------------------------------- */

function toolPaint(p: Paint, f: RailFacts): (s: string) => string {
	return (s: string) => p.tone(f.toolTone, s);
}

function queueText(f: RailFacts): string {
	return f.queueCount === 0
		? "queue empty"
		: `queue ${f.queueCount} · ${f.firstQueued}`;
}

/* --- 2. Status Matrix ----------------------------------------------------- */

/** Key column width. Fixed so every value in the rail starts on one column. */
const MATRIX_KEY = 8;

function matrixRow(
	p: Paint,
	key: string,
	value: string,
	width: number,
	paint: (s: string) => string = (s) => p.text(s),
): string {
	const valueWidth = Math.max(1, width - MATRIX_KEY - 1);
	return cell(
		`${p.dim(cell(key, MATRIX_KEY))} ${paint(clip(value, valueWidth))}`,
		width,
	);
}

/**
 * One aligned key/value matrix, grouped by LIFECYCLE (where the run is), WORK
 * (what it is doing) and SPEND (what it costs). Values share a column, so two
 * children — or one child at two moments — can be compared by eye. A failing
 * tool raises an inverse alert pair above the matrix so the error never has to
 * be found inside a grid.
 */
function renderRailStatusMatrix(
	v: View,
	rail: number,
	room: number,
	extraSections: ReadonlyArray<readonly string[]> = [],
): string[] {
	const { p } = v;
	const f = railFacts(v.s);
	const bad = (s: string) => p.bad(s);
	const alert: ReadonlyArray<readonly string[]> = f.failed
		? [
				[
					cell(p.inv(p.bad(cell(` ✖ ${f.status} · ${f.tool} `, rail))), rail),
					matrixRow(p, "error", f.toolOutcome, rail, bad),
					...clampWrap(f.errorDetail, rail, 3).map((line) => cell(bad(line), rail)),
				],
			]
		: [];
	const lifecycle = [
		sectionHead(p, "LIFECYCLE", rail),
		matrixRow(p, "status", f.status, rail, (s) => p.tone(f.tone, s)),
		matrixRow(p, "elapsed", f.elapsed, rail),
		matrixRow(p, "turn", f.turn, rail),
		matrixRow(p, "run", `${f.run} · ${f.branch}`, rail),
		matrixRow(p, "live", f.live, rail, (s) => p.tone(f.tone, s)),
	];
	const work = [
		sectionHead(p, "WORK", rail),
		matrixRow(p, "tool", f.tool, rail, f.failed ? bad : (s) => p.text(s)),
		matrixRow(
			p,
			f.failed ? "failed" : "result",
			f.toolOutcome,
			rail,
			toolPaint(p, f),
		),
		matrixRow(p, "target", f.target, rail, (s) => p.dim(s)),
		matrixRow(
			p,
			"queue",
			String(f.queueCount),
			rail,
			f.queueCount > 0 ? (s) => p.warn(s) : (s) => p.dim(s),
		),
		matrixRow(p, "next", f.firstQueued, rail, (s) => p.muted(s)),
		matrixRow(p, "args", f.args, rail, (s) => p.dim(s)),
	];
	const spend = [
		sectionHead(p, "SPEND", rail),
		matrixRow(p, "cost", f.cost, rail),
		matrixRow(p, "in", String(f.tokensIn), rail),
		matrixRow(p, "out", String(f.tokensOut), rail),
	];
	return stackSections(
		[...alert, ...extraSections, lifecycle, work, spend],
		room,
	);
}

/* --- narrow fallback: the same facts, folded into full-width rows -------- */

/**
 * Below `RAIL_GEOMETRY.min + TRANSCRIPT_MIN + 1` there is no rail. The matrix
 * folds into dense full-width rows above the transcript, keeping its aligned
 * key column. It never drops status, tool/error, queue, elapsed or cost.
 */
function compactStatusMatrix(v: View, width: number): string[] {
	const { p } = v;
	const f = railFacts(v.s);
	const alert = f.failed
		? [matrixRow(p, "error", `✖ ${f.tool} · ${f.toolOutcome}`, width, (s) => p.bad(s))]
		: [];
	return [
		...alert,
		matrixRow(
			p,
			"life",
			`${f.status} · ${f.run} · ${f.branch} · turn ${f.turn} · ${f.elapsed}`,
			width,
			(s) => p.tone(f.tone, s),
		),
		matrixRow(
			p,
			"work",
			`${f.tool} · ${f.target} · ${f.toolOutcome}`,
			width,
			toolPaint(p, f),
		),
		matrixRow(p, "queue", queueText(f), width, (s) => p.warn(s)),
		matrixRow(
			p,
			"spend",
			`cost ${f.cost} · in ${f.tokensIn} · out ${f.tokensOut}`,
			width,
			(s) => p.dim(s),
		),
		matrixRow(p, "live", f.live, width, (s) => p.tone(f.tone, s)),
	];
}

/* --- the fixed rail geometry --------------------------------------------- */

/**
 * The Status Matrix width band. It is fixed, so the transcript column is the
 * same at a given overlay width in every child state.
 */
const RAIL_GEOMETRY: RailGeometry = { min: 30, max: 42, ratio: 0.34 };

/* ==========================================================================
   6h. THE LOCKED SESSION HEADER

   WHAT IS LOCKED
     One composition, `composeSessionHeader`, renders THE header — a
     Pi-session-like identity header (round 5), pruned of telemetry (round 6)
     and amended so the model rides with the name:

       row 1  inverse ` CHILD ` badge · `shuttle` · `gpt-5.6-sol` ·
              `implementer` · `overlay header width`
       row 2  `delegated by LOOM` · plan › task › subtask

     THE AMENDMENT: the model moved LEFT. It is now part of the identity
     cluster, immediately after the child's name and before its role and task
     title, instead of trailing on the right the way round 5 drew it. The
     identity row therefore has no right-hand column at all, which is the
     structural reason a model can never reappear on the right or twice.

     DELETED BY ROUND 6, and unreachable from `HeaderFacts`: the whole
     telemetry row (status, elapsed, turn, run/branch, queue, usage, live) and
     the bounded child-id hint. The Status Matrix rail and the outer frame
     marker still carry every one of those facts, so nothing is lost — only
     de-duplicated.

   RESPONSIVE RULE
     The child's name and its bounded task title come first and are never
     dropped. Identity grows to two rows before a narrow width may take the
     title; on that second row the model, then the role, are what the row
     surrenders. Row 2 sheds its subtask, then its plan name; provenance leads
     it because the rail never says who delegated the child.

   INVARIANCE
     `HeaderFacts` is state-free, so this header is byte-identical in all six
     child states, settled ones included. The smoke test asserts exactly that,
     plus: the model string appears EXACTLY ONCE in the
     header, immediately after `shuttle`, and never in the last third of any
     row.
   ========================================================================== */

interface HeaderRow {
	readonly lines: readonly string[];
	readonly facts: readonly string[];
}

interface ComposedHeader {
	readonly lines: readonly string[];
	/** Facts actually printed, in `HEADER_FACT_ORDER`. */
	readonly facts: readonly string[];
}

/**
 * ROW 1 — the identity cluster, all of it on the left: badge, name, model,
 * role, bounded task title. `joinParts` fills in that priority order and stops
 * at the first fact that does not fit, so a squeezed row loses the TITLE last
 * among the trailing facts — and when the title itself cannot fit, identity
 * takes a second row rather than dropping it.
 */
function headerIdentityRow(
	v: View,
	f: HeaderFacts,
	width: number,
): HeaderRow {
	const { p } = v;
	const sep = p.rule(HEADER_SEP);
	const badge = `${p.inv(p.acc(CHILD_BADGE))} ${p.bold(f.name)}`;
	// Order is the amendment: the model rides with the name, never on the right.
	const identity: readonly FactPart[] = [
		{ id: "child-badge-name", text: badge },
		{ id: "model", text: p.alt(f.model) },
		{ id: "role", text: p.dim(f.role) },
		{ id: "title", text: p.text(f.boundedTitle) },
	];

	if (identityFitsOneRow(f, width)) {
		const row = joinParts(identity, width, sep);
		return { lines: [cell(row.line, width)], facts: row.kept };
	}

	// Two-row identity: as much of badge · name · model · role as fits, with the
	// task title on its own row underneath. The title is never surrendered.
	const top = joinParts(identity.slice(0, 3), width, sep);
	const kept = top.kept.length > 0 ? top.kept : ["child-badge-name"];
	const topLine = top.kept.length > 0 ? top.line : clip(badge, Math.max(0, width));
	return {
		lines: [
			cell(topLine, width),
			cell(p.text(clip(f.boundedTitle, width)), width),
		],
		facts: [...kept, "title"],
	};
}

/**
 * ROW 2 — provenance and plan context: who delegated this child, then which
 * plan and task it serves. The breadcrumb sheds its subtask, then its plan
 * name, as the row narrows; provenance leads because the rail never says it.
 */
function headerContextRow(
	v: View,
	f: HeaderFacts,
	width: number,
): HeaderRow | undefined {
	const { p } = v;
	const sep = p.rule(HEADER_SEP);
	const tier = headerTier(width);
	const parent = `${p.dim("delegated by")} ${p.alt(f.parent)}`;
	const crumbRoom = Math.max(
		0,
		width - visibleWidth(parent) - visibleWidth(HEADER_SEP),
	);
	const crumbParts: readonly FactPart[] =
		tier === "tight"
			? [{ id: "task", text: p.text(f.taskCrumb) }]
			: tier === "mid"
				? [
						{ id: "plan", text: p.muted(f.plan) },
						{ id: "task", text: p.text(CONTEXT.task) },
					]
				: [
						{ id: "plan", text: p.muted(f.plan) },
						{ id: "task", text: p.text(f.taskCrumb) },
						{ id: "subtask", text: p.dim(f.subtask) },
					];
	const crumb = joinParts(crumbParts, crumbRoom, ` ${p.rule("›")} `);
	const pieces = [parent, crumb.line].filter((piece) => piece.length > 0);
	if (pieces.length === 0) return undefined;
	return {
		lines: [cell(pieces.join(sep), width)],
		facts: ["parent", ...crumb.kept],
	};
}

/**
 * The one composition. Identity is always kept whole; the context row is what
 * a vertically squeezed overlay loses, so a starved terminal drops provenance
 * before it drops the child.
 */
function composeSessionHeader(v: View, width: number): ComposedHeader {
	const f = headerFacts(v);
	const identity = headerIdentityRow(v, f, width);
	const detail = [headerContextRow(v, f, width)].filter(
		(row): row is HeaderRow => row !== undefined,
	);
	const shown = v.short ? detail.slice(0, 1) : detail;
	const printed = new Set<string>([
		...identity.facts,
		...shown.flatMap((row) => row.facts),
	]);
	return {
		lines: [...identity.lines, ...shown.flatMap((row) => row.lines)],
		facts: HEADER_FACT_ORDER.filter((id) => printed.has(id)),
	};
}

/** The overlay's only header. Not selectable, not parameterised, not varied. */
function renderSessionHeader(v: View, width: number): string[] {
	return [...composeSessionHeader(v, width).lines];
}

/* ==========================================================================
   6i. THE OVERLAY BODY + THE SHARED TRANSCRIPT WINDOW

   The arrangement is round 2's: Pi-native child transcript left, Status
   Matrix rail right, the locked child prompt and controls below, under the
   locked Session Header. Under Native Settlement the body reads NO outcome
   surface at all — there is none to read — so the same three regions serve
   every one of the six child states.

   The shared part of search lives here, not in the search section: the pane
   render, the match list, the anchored window that keeps the current match on
   screen, and the fact that `prompt` is produced without ever seeing
   `NavFacts` — which is why the prompt region is byte-identical with search
   open and closed.

   No prototype commentary is rendered inside the overlay body: the demo's own
   chrome is the banner (section 10) and the footer (section 10), never the
   product UI.
   ========================================================================== */

/**
 * The overlay body, returned region by region rather than concatenated, so the
 * smoke test can assert on the locked Session Header, the transcript block and
 * the prompt separately instead of guessing where one ends.
 */
interface BodyParts {
	/** The LOCKED Session Header and its rule. */
	readonly head: readonly string[];
	/** Transcript and Status Matrix rail, or their degraded foldings. */
	readonly main: readonly string[];
	/** The locked Primary-Like Editor, or the cancel confirmation. */
	readonly prompt: readonly string[];
}

/**
 * THE SHARED TRANSCRIPT WINDOW. Without an anchor it shows the newest rows and
 * states how many scrolled out. With an anchor — set whenever search is open
 * or a jump has been accepted — it centres the current match and states how
 * much is above AND below, because a reader who jumped into the middle of a
 * transcript needs to know they are in the middle.
 */
function transcriptWindow(
	v: View,
	lines: readonly string[],
	width: number,
	room: number,
	anchorRow: number | undefined,
): string[] {
	if (room <= 0) return [];
	if (lines.length <= room) return fitTo(lines, room, "tail");
	if (anchorRow === undefined || room < 5) {
		return scrollTail(v, lines, width, room);
	}
	const body = room - 2;
	const start = Math.min(
		Math.max(0, anchorRow - Math.floor(body / 2)),
		Math.max(0, lines.length - body),
	);
	const later = lines.length - start - body;
	return [
		cell(
			v.p.muted(
				start === 0
					? "↑ top of transcript · anchored on the current match"
					: `↑ ${start} earlier row(s) · anchored on the current match`,
			),
			width,
		),
		...lines.slice(start, start + body),
		cell(
			v.p.muted(later <= 0 ? "↓ end of transcript" : `↓ ${later} later row(s)`),
			width,
		),
	];
}

/** The transcript pane, its matches, and the search gutter applied to it. */
interface NavRender {
	readonly facts: NavFacts;
	readonly lines: readonly string[];
	readonly anchorRow: number | undefined;
}

/**
 * Builds the pane at the width the transcript actually gets (the search inset
 * is taken off BEFORE the matches are found), so gutter row indices and match
 * row indices can never drift apart.
 */
function navRender(v: View, paneWidth: number): NavRender {
	const open = v.ui.nav.open;
	const inset = open ? SEARCH_INSET : 0;
	const pane = renderTranscriptPane(v, Math.max(1, paneWidth - inset));
	const facts = navFacts(v, pane);
	if (!open) {
		return { facts, lines: pane.painted, anchorRow: facts.anchorRow };
	}
	return {
		facts,
		lines: markSearchGutter(v, facts, pane, paneWidth),
		anchorRow: facts.anchorRow,
	};
}

function bodyRightRail(v: View): BodyParts {
	const { p } = v;
	const open = v.ui.nav.open;
	// The prompt is produced FIRST, from `PromptFacts` alone. It never sees
	// `NavFacts`, and there is no outcome surface that could replace it: a
	// settled child gets the same editor, read-only and caretless.
	const foot = renderPromptGroup(v, v.width).map((line) => cell(line, v.width));

	const split = splitRail(v.width, RAIL_GEOMETRY);
	const paneWidth = split.isOk() ? split.value.main : v.width;
	const rendered = navRender(v, paneWidth);
	const f = rendered.facts;
	const transcriptLines = rendered.lines;

	// HEAD — the locked Session Header. It is state-free, so it is
	// byte-identical in all six child states.
	const head = [...composeSessionHeader(v, v.width).lines, ruleRow(v, v.width)];

	const roomResult = reserveRows(v.height, head.length + foot.length);
	if (roomResult.isErr()) {
		// Vertically starved: the head collapses to the rows no header may lose —
		// the child's name and its bounded task title. Status, elapsed, queue and
		// cost are NOT re-added here: the frame marker above and the compact
		// matrix below still carry them, and the frame marker prints the state
		// word, so a starved terminal still says CANCELLED.
		const minimal: string[] = [...identitySafetyRow(v, v.width)];
		// The prompt is the last thing a starved terminal may lose. When it must be
		// cut to one row, keep the row that still says how to LEAVE.
		const escIndex = foot.reduce(
			(found, line, i) => (line.includes("Esc") ? i : found),
			-1,
		);
		const tightFoot =
			foot.length > 1 && v.height < minimal.length + foot.length + 1
				? [foot[escIndex >= 0 ? escIndex : foot.length - 1] as string]
				: foot;
		const fallback = reserveRows(v.height, minimal.length + tightFoot.length);
		if (fallback.isErr()) {
			// One spare row still buys the rail's headline (status + tool/error),
			// which beats spending it on a single transcript line.
			const spare = v.height - minimal.length - tightFoot.length;
			const headline =
				spare >= 1 ? compactStatusMatrix(v, v.width).slice(0, spare) : [];
			return { head: minimal, main: headline, prompt: tightFoot };
		}
		return {
			head: minimal,
			main: transcriptWindow(
				v,
				transcriptLines,
				v.width,
				fallback.value,
				rendered.anchorRow,
			),
			prompt: tightFoot,
		};
	}
	const room = roomResult.value;

	if (split.isErr()) {
		// Degraded: the rail folds into dense rows above a single-column
		// transcript. It still owns every operational fact, so the header and the
		// prompt keep their subtraction even here.
		const ops = compactStatusMatrix(v, v.width).slice(0, Math.max(0, room - 1));
		const body = transcriptWindow(
			v,
			transcriptLines,
			v.width,
			Math.max(0, room - ops.length - 1),
			rendered.anchorRow,
		);
		return {
			head,
			main: [...ops, ruleRow(v, v.width), ...body],
			prompt: foot,
		};
	}
	const { main, rail: railWidth } = split.value;
	// The SEARCH section rides the Status Matrix's own `extraSections`
	// capability, so the matrix compresses its lifecycle / work / spend groups
	// around it instead of the transcript losing rows — and the round-4 failure
	// alert still outranks it.
	const extra = open ? searchRailSections(v, f, railWidth) : [];
	const railLines = renderRailStatusMatrix(v, railWidth, room, extra);
	const merged = joinColumns(
		[
			{
				lines: transcriptWindow(
					v,
					transcriptLines,
					main,
					room,
					rendered.anchorRow,
				),
				width: main,
			},
			{ lines: fitTo(railLines, room, "head"), width: railWidth },
		],
		room,
		p.rule("│"),
	);
	return { head, main: merged, prompt: foot };
}

/* ==========================================================================
   7. SHARED DEMO STORE
   The only variable left in the prototype is WHICH DEMO CHILD STATE is shown.
   There is no design selection: the surface is final.
   ========================================================================== */

class DemoStore {
	private stateIndex = 0;
	private readonly listeners = new Set<() => void>();

	get state(): ChildState {
		return STATES[wrapIndex(this.stateIndex, STATES.length)] as ChildState;
	}

	get stateNumber(): number {
		return this.stateIndex + 1;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setState(index: number): void {
		this.stateIndex = wrapIndex(index, STATES.length);
		this.emit();
	}

	stepState(delta: number): void {
		this.setState(this.stateIndex + delta);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

const store = new DemoStore();


/* ==========================================================================
   8. PERSISTENT WIDGET COMPONENT (above the REAL Pi editor)
   `ui.setWidget` mounts this above Pi's own editor. No editor is drawn here:
   the thing under this component is the real one, which is the only honest way
   to judge a persistent surface. The component is a thin cache around section
   4's LOCKED Plan Rail. It takes no child state at all, so a cancelled or
   completed child does not change a single byte of parent context, and the
   `Alt+A cycle` affordance stays visible in every state.
   ========================================================================== */

class ContextWidget implements Component {
	private cache: { width: number; lines: string[] } | undefined;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
	) {
		this.unsubscribe = store.subscribe(() => {
			this.tui.requestRender();
		});
	}

	dispose(): void {
		this.unsubscribe();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(8, Math.floor(width));
		// Width is the ONLY input. The widget cannot read the child state, so
		// nothing else can invalidate it.
		if (this.cache && this.cache.width === safeWidth) return this.cache.lines;
		const p = makePaint(this.theme);
		const lines = renderContextWidget({ width: safeWidth, p }).map((line) =>
			truncateToWidth(line, safeWidth, ""),
		);
		this.cache = { width: safeWidth, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

/* ==========================================================================
   9. OUTER OVERLAY FRAME
   One boundary for the whole overlay, shared by every child state. It carries
   the live state marker — Native Settlement's terminal signal — which is why
   the locked
   header drops the status word without the run's state going missing. It never
   carries an id. It is the only decorative box the overlay owns: inner
   separators stay muted so the outer edge reads as the overlay boundary
   against the real Pi transcript behind it.
   ========================================================================== */

/** Border columns consumed on the left and right of every overlay row. */
const FRAME_COLUMNS = 2;

const FRAME_TITLE = " WEAVE · CHILD INSPECTOR · DEMO ";

/** Clears any background/inverse left open by content before the edge. */
const FRAME_RESET = "\u001B[0m";

interface FrameChrome {
	readonly title: string;
	readonly marker: string;
	readonly markerTone: Tone;
	/**
	 * Inverse marker, kept as a frame capability and currently unused: the marker
	 * already carries the settlement glyph and word, which is the reason the
	 * header can drop the status word without the run's state disappearing.
	 */
	readonly markerInverse?: boolean;
}

function frameTop(p: Paint, width: number, chrome: FrameChrome): string {
	if (width <= 0) return "";
	if (width < 4) return clip(p.frame(repeat("─", width)), width);
	const inner = width - FRAME_COLUMNS;
	const titleWidth = visibleWidth(chrome.title);
	const markerWidth = visibleWidth(chrome.marker);
	let body: string;
	if (inner >= titleWidth + markerWidth + 4) {
		const fill = inner - titleWidth - markerWidth - 2;
		body =
			p.frame("─") +
			p.bold(p.frame(chrome.title)) +
			p.frame(repeat("─", fill)) +
			(chrome.markerInverse
				? p.inv(p.tone(chrome.markerTone, chrome.marker))
				: p.tone(chrome.markerTone, chrome.marker)) +
			FRAME_RESET +
			p.frame("─");
	} else if (inner >= titleWidth + 2) {
		body =
			p.frame("─") +
			p.bold(p.frame(chrome.title)) +
			p.frame(repeat("─", inner - titleWidth - 1));
	} else if (inner >= 6) {
		const short = clip(chrome.title.trim(), inner - 2);
		body =
			p.frame("─") +
			p.bold(p.frame(short)) +
			p.frame(repeat("─", Math.max(0, inner - visibleWidth(short) - 1)));
	} else {
		body = p.frame(repeat("─", inner));
	}
	return p.frame("╭") + body + p.frame("╮") + FRAME_RESET;
}

function frameBottom(p: Paint, width: number): string {
	if (width <= 0) return "";
	if (width < 4) return clip(p.frame(repeat("─", width)), width);
	return (
		p.frame("╰") +
		p.frame(repeat("─", width - FRAME_COLUMNS)) +
		p.frame("╯") +
		FRAME_RESET
	);
}

/** Wraps one already-composed content row in the left and right border columns. */
function frameRow(p: Paint, line: string, inner: number): string {
	return `${p.frame("│")}${FRAME_RESET}${cell(line, inner)}${FRAME_RESET}${p.frame("│")}${FRAME_RESET}`;
}

/** Applies the single outer frame to fully composed overlay content. */
function frameOverlay(
	content: readonly string[],
	width: number,
	p: Paint,
	chrome: FrameChrome,
): string[] {
	if (width < 4) return content.map((line) => clip(line, width));
	const inner = width - FRAME_COLUMNS;
	return [
		frameTop(p, width, chrome),
		...content.map((line) => frameRow(p, line, inner)),
		frameBottom(p, width),
	];
}

/* ==========================================================================
   10. OVERLAY COMPOSITION (pure) + COMPONENT
   ========================================================================== */

/**
 * Last-resort vertical guard. The rail body sizes itself, but a starved
 * terminal must never lose the child prompt controls at the bottom, so any
 * overflow is removed from the middle and reported.
 */
function squeezeBody(v: View, body: readonly string[], height: number): string[] {
	if (body.length <= height) return fitTo(body, height);
	if (height <= 2) return body.slice(body.length - height);
	const keepHead = 1;
	const dropped = body.length - height + 1;
	return [
		...body.slice(0, keepHead),
		cell(v.p.muted(`↕ ${dropped} row(s) hidden · resize to see more`), v.width),
		...body.slice(keepHead + dropped),
	];
}

function demoBanner(v: View): string[] {
	if (v.short) return [];
	const text = `${DEMO_MARK} · prototype overlay · nothing here reflects a real child`;
	return [cell(v.p.inv(cell(` ${text}`, v.width)), v.width)];
}

/**
 * The prototype's own footer: what this file is, which demo child state is
 * live, and the interaction keys. It names no design alternative, because
 * there is none — the surface above it is final — and nothing in this section
 * is ever drawn inside the product UI or the widget.
 */
function footerLines(v: View): string[] {
	const { p } = v;
	const rule = ruleRow(v, v.width);
	const title = v.narrow
		? "WEAVE CHILD INSPECTOR"
		: "WEAVE CHILD INSPECTOR · FINAL PROTOTYPE";
	const titleRow = rowLR(p.bold(p.acc(title)), p.dim(DEMO_MARK), v.width);
	const chips = STATES.map((s) =>
		s.id === v.s.id
			? p.inv(` ${s.key} ${s.chip} `)
			: p.dim(` ${s.key} ${s.chip} `),
	).join(p.rule("·"));
	const stateRow = rowLR(
		`${p.muted("CHILD STATE")} ${chips}`,
		p.dim(
			`Tab / Shift+Tab · search: ${v.ui.nav.open ? `OPEN “${NAV_QUERY}”` : "closed"}`,
		),
		v.width,
	);
	if (v.short) return [rule, titleRow, stateRow];
	const help = cell(
		p.muted(
			"keys · / search · n / N match (j / k) · Enter jump · q cancel demo (y / n) · Esc: cancel confirm › search › overlay",
		),
		v.width,
	);
	return [rule, titleRow, stateRow, help];
}

interface ComposeInput {
	readonly width: number;
	readonly height: number;
	readonly p: Paint;
	readonly stateIndex: number;
	readonly ui: OverlayUi;
}

/**
 * The overlay, region by region. `banner` and `footer` are prototype chrome;
 * `head`, `main` and `prompt` are the product surface.
 *
 * The regions are returned unframed and unsqueezed so the smoke test can
 * assert, exactly, that the locked Session Header is byte-identical in every
 * child state, that no region outside `main` and `prompt` reacts to a settled
 * child, and that the prompt is byte-identical with search open and closed.
 */
interface OverlayRegions {
	readonly lines: readonly string[];
	readonly banner: readonly string[];
	readonly head: readonly string[];
	readonly main: readonly string[];
	readonly prompt: readonly string[];
	readonly footer: readonly string[];
}

function composeOverlayRegions(input: ComposeInput): OverlayRegions {
	const state = STATES[wrapIndex(input.stateIndex, STATES.length)] as ChildState;
	// The outer frame owns two columns and two rows; the body never sees them.
	const innerWidth = Math.max(1, input.width - FRAME_COLUMNS);
	const innerHeight = Math.max(3, input.height - 2);
	const view: View = {
		width: innerWidth,
		height: 0,
		p: input.p,
		s: state,
		ui: input.ui,
		narrow: innerWidth < 62,
		short: innerHeight < 16,
	};
	const banner = demoBanner(view);
	const fullFooter = footerLines(view);
	// The prototype's own footer yields rows before the child's header does, so a
	// starved terminal loses demo chrome rather than child facts.
	const footer =
		innerHeight - banner.length - fullFooter.length >= 3
			? fullFooter
			: fullFooter.slice(0, Math.max(0, innerHeight - banner.length - 3));
	const bodyHeight = Math.max(3, innerHeight - banner.length - footer.length);
	const parts = bodyRightRail({ ...view, height: bodyHeight });
	// Last-resort guard: overflow is taken out of the transcript block, never out
	// of the prompt, so a starved terminal can still act on the child.
	const above = squeezeBody(
		view,
		[...parts.head, ...parts.main],
		Math.max(1, bodyHeight - parts.prompt.length),
	);
	// Clamp to the allotted rows. Keeping the tail preserves the footer, the
	// prompt and the newest transcript rows when a very short terminal starves
	// the body.
	const content = fitTo(
		[...banner, ...above, ...parts.prompt, ...footer],
		innerHeight,
		"tail",
	);
	// One frame: the demo title and the live state marker. The marker is why the
	// header may drop the status word without losing it, and no id is ever
	// printed here.
	const settlement = settlementFacts(state);
	const chrome: FrameChrome = {
		title: FRAME_TITLE,
		marker: ` ${settlement.glyph} ${settlement.word} `,
		markerTone: settlement.tone,
	};
	return {
		lines: frameOverlay(content, input.width, input.p, chrome),
		banner,
		head: parts.head,
		main: parts.main,
		prompt: parts.prompt,
		footer,
	};
}

/**
 * The whole overlay as a pure function. The component below calls it with the
 * live theme; the smoke test calls it with `plainPaint()`.
 */
function composeOverlay(input: ComposeInput): string[] {
	return [...composeOverlayRegions(input).lines];
}

interface InspectorHost {
	readonly tui: TUI;
	readonly theme: Theme;
	readonly demo: DemoStore;
	readonly close: () => void;
}

/**
 * Match count for one child state at a reference width. `n` / `N` wrap-around
 * needs a total before a render has happened, and the count is width-stable
 * because the transcript wraps on word boundaries and the query is one word.
 */
function navTotalForState(state: ChildState, width = 72): number {
	const view: View = {
		width,
		height: 0,
		p: plainPaint(),
		s: state,
		ui: {
			nav: { open: false, current: 1, accepted: false },
			confirmCancel: false,
			draft: CHILD_DRAFT,
		},
		narrow: false,
		short: false,
	};
	return navMatchList(state, renderTranscriptPane(view, width), NAV_QUERY).length;
}

/**
 * THE KEY PRECEDENCE CHAIN, in one place:
 *
 *     cancel confirmation  >  search  >  overlay
 *
 * While the confirmation is open, only `y`, `n` and `Esc` are read — so `/`,
 * `n`, `N` and the state keys `x` and `y` can neither reach search nor close
 * the overlay, and `n` unambiguously means NO while `y` unambiguously means
 * YES. With search open, `Esc` closes SEARCH ONLY. With both closed, `Esc`
 * closes the overlay. Nothing else can reorder this, because nothing else
 * reads keys.
 */
class InspectorOverlay implements Component {
	private navOpen = false;
	/** 1-based match ordinal; clamped to the live state's total when rendered. */
	private navCurrent = NAV_START_MATCH;
	/** Enter latched a jump: the transcript stays anchored after navigation closes. */
	private navAccepted = false;
	private confirmCancel = false;
	private cache: { width: number; key: string; lines: string[] } | undefined;
	private readonly unsubscribe: () => void;

	constructor(private readonly host: InspectorHost) {
		this.unsubscribe = host.demo.subscribe(() => {
			// A new child state has a different match list, so navigation restarts at
			// the demo ordinal rather than pointing at a match that no longer exists.
			this.navCurrent = NAV_START_MATCH;
			this.invalidate();
			host.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		// 1. THE CONFIRMATION OWNS EVERY KEY IT IS OPEN FOR.
		if (this.confirmCancel) {
			if (data === "y" || data === "n" || matchesKey(data, Key.escape)) {
				this.confirmCancel = false;
			}
			this.refresh();
			return;
		}
		// 2. SEARCH IS CLOSED BEFORE THE OVERLAY IS.
		if (matchesKey(data, Key.escape)) {
			if (this.navOpen || this.navAccepted) {
				this.closeNav();
				this.refresh();
				return;
			}
			this.unsubscribe();
			this.host.close();
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this.unsubscribe();
			this.host.close();
			return;
		}
		// 3. MOVEMENT KEYS EXIST ONLY WHILE SEARCH IS OPEN, so they can never
		//    collide with the confirmation's `n` or with the demo's state keys.
		if (this.navOpen) {
			if (matchesKey(data, Key.enter)) {
				this.navOpen = false;
				this.navAccepted = true;
				this.refresh();
				return;
			}
			if (data === "n" || data === "j" || matchesKey(data, Key.down)) {
				this.stepMatch(1);
				this.refresh();
				return;
			}
			if (data === "N" || data === "k" || matchesKey(data, Key.up)) {
				this.stepMatch(-1);
				this.refresh();
				return;
			}
		}
		if (matchesKey(data, Key.shift("tab"))) this.host.demo.stepState(-1);
		else if (matchesKey(data, Key.tab)) this.host.demo.stepState(1);
		else if (data === "/") this.toggleNav();
		// `q` NEVER cancels: it only opens the confirmation this prototype cannot
		// render its way around, and the confirmation outranks search.
		else if (data === "q") this.confirmCancel = true;
		else {
			const direct = STATES.findIndex((s) => s.key === data);
			if (direct >= 0) this.host.demo.setState(direct);
		}
		this.refresh();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(8, Math.floor(width));
		const height = this.overlayHeight();
		const key = `${this.host.demo.stateNumber}:${height}:${this.navOpen}:${this.navCurrent}:${this.navAccepted}:${this.confirmCancel}`;
		if (this.cache && this.cache.width === safeWidth && this.cache.key === key) {
			return this.cache.lines;
		}
		const lines = composeOverlay({
			width: safeWidth,
			height,
			p: makePaint(this.host.theme),
			stateIndex: this.host.demo.stateNumber - 1,
			ui: {
				nav: {
					open: this.navOpen,
					current: this.navCurrent,
					accepted: this.navAccepted,
				},
				confirmCancel: this.confirmCancel,
				draft: CHILD_DRAFT,
			},
		}).map((line) => truncateToWidth(line, safeWidth, ""));
		this.cache = { width: safeWidth, key, lines };
		return lines;
	}

	/** Opening restarts at the demo ordinal; closing drops the anchor entirely. */
	private toggleNav(): void {
		if (this.navOpen) {
			this.closeNav();
			return;
		}
		this.navOpen = true;
		this.navAccepted = false;
		this.navCurrent = NAV_START_MATCH;
	}

	private closeNav(): void {
		this.navOpen = false;
		this.navAccepted = false;
		this.navCurrent = NAV_START_MATCH;
	}

	private stepMatch(delta: number): void {
		const total = navTotalForState(this.host.demo.state);
		if (total <= 0) return;
		this.navCurrent = wrapIndex(this.navCurrent - 1 + delta, total) + 1;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	private refresh(): void {
		this.invalidate();
		this.host.tui.requestRender();
	}

	/** Overlay is capped at 86% of the terminal with margin 1 on each side. */
	private overlayHeight(): number {
		const rows = this.host.tui.terminal?.rows ?? 0;
		const usable = rows > 0 ? rows : 30;
		return Math.max(6, Math.min(usable - 4, Math.floor(usable * 0.86) - 2));
	}
}

/* ==========================================================================
   11. EXTENSION ENTRY
   ========================================================================== */

const WIDGET_ID = "weave-grilling-context";
const STATUS_ID = "weave-grilling";

let overlayOpen = false;

function installWidget(ui: ExtensionUIContext): void {
	// The locked Plan Rail needs no demo state: it reads width and nothing else.
	ui.setWidget(WIDGET_ID, (tui, theme) => new ContextWidget(tui, theme));
	updateStatus(ui);
}

function updateStatus(ui: ExtensionUIContext): void {
	ui.setStatus(
		STATUS_ID,
		`${DEMO_MARK} · final child inspector · ${store.state.status.toLowerCase()}`,
	);
}

function clearDemo(ui: ExtensionUIContext): void {
	ui.setWidget(WIDGET_ID, undefined);
	ui.setStatus(STATUS_ID, undefined);
}

async function openInspector(ui: ExtensionUIContext): Promise<void> {
	if (overlayOpen) return;
	overlayOpen = true;
	try {
		await ui.custom<null>(
			(tui, theme, _keybindings, done) => {
				const overlay = new InspectorOverlay({
					tui,
					theme,
					demo: store,
					close: () => done(null),
				});
				tui.requestRender();
				return overlay;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "92%",
					minWidth: 40,
					maxHeight: "86%",
					margin: 1,
					// Hide rather than corrupt the screen on tiny terminals.
					visible: (termWidth: number, termHeight: number) =>
						termWidth >= 44 && termHeight >= 12,
				},
			},
		);
	} finally {
		overlayOpen = false;
	}
	ui.notify(
		"Inspector closed. The locked Weave Plan Rail widget stays above the editor on purpose. Reopen with /grilling, remove the demo with /grilling-clear.",
		"info",
	);
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("grilling", {
		description:
			"Open the final Weave subagent child inspector overlay (demo data)",
		handler: async (_args, ctx) => {
			installWidget(ctx.ui);
			await openInspector(ctx.ui);
		},
	});

	pi.registerCommand("grilling-clear", {
		description: "Remove the Weave child inspector demo widget and status",
		handler: async (_args, ctx) => {
			clearDemo(ctx.ui);
			ctx.ui.notify("Weave child inspector demo widget and status cleared.", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		installWidget(ctx.ui);
		store.subscribe(() => updateStatus(ctx.ui));
		openInspector(ctx.ui).catch(() => {
			ctx.ui.notify(
				"Weave inspector overlay failed to open. Try /grilling.",
				"error",
			);
		});
	});
}

/** Exported for the noninteractive smoke test; unused by pi at runtime. */
export const __prototype = {
	SEARCH_INSET,
	searchRailSections,
	markSearchGutter,
	markKind,
	settlementFacts,
	settlementPhase,
	safeText,
	NAV_QUERY,
	NAV_START_MATCH,
	STATES,
	CONTEXT,
	CHILD,
	CHILD_DRAFT,
	DEMO_MARK,
	DemoStore,
	ContextWidget,
	InspectorOverlay,
	makePaint,
	plainPaint,
	composeOverlay,
	composeOverlayRegions,
	footerLines,
	demoBanner,
	renderContextWidget,
	renderPlanRailWidget,
	widgetFacts,
	widgetTier,
	widgetBadge,
	cycleHint,
	planDots,
	demoTag,
	joinFit,
	leftRoom,
	planProgress,
	installWidget,
	updateStatus,
	clearDemo,
	bodyRightRail,
	headerFacts,
	headerTier,
	identitySafetyRow,
	identityFitsOneRow,
	identityCoreFitsOneRow,
	composeSessionHeader,
	renderSessionHeader,
	headerIdentityRow,
	headerContextRow,
	HEADER_FACT_ORDER,
	HEADER_SEP,
	CHILD_BADGE,
	joinParts,
	railFacts,
	renderRailStatusMatrix,
	compactStatusMatrix,
	renderPiNative,
	TRANSCRIPT_MIN,
	RAIL_GEOMETRY,
	renderPromptGroup,
	promptPrimaryEditor,
	promptFacts,
	promptKeys,
	pickKeys,
	keyLine,
	keyChip,
	promptField,
	promptCancelConfirm,
	terminalStateWord,
	finalResponseEvent,
	renderTranscriptPane,
	navMatchList,
	navFacts,
	navEventLabel,
	navTotalForState,
	navRender,
	highlightQuery,
	stripAnsi,
	transcriptWindow,
	frameOverlay,
	frameTop,
	frameBottom,
	FRAME_COLUMNS,
	FRAME_TITLE,
	fitTo,
	scrollTail,
	stackSections,
	splitRail,
	reserveRows,
	store,
};
