/**
 * WEAVE_DELEGATE — THE FINAL INLINE DELEGATION CARD.
 *
 * This file is the FINISHED answer to one question, and it no longer asks any
 * others. It does not touch, replace or reopen the finalized child inspector at
 * `prototypes/weave-pi-tui-grilling.ts`; that file answers "what does the child
 * overlay look like when I open it". This file answers the earlier question:
 *
 *     WHAT DOES A `weave_delegate` CALL LOOK LIKE INLINE, IN THE PARENT'S OWN
 *     PI TRANSCRIPT, WHILE THE SUBAGENT RUNS AND WHEN IT SETTLES?
 *
 * THE DESIGN TREE IS COMPLETE. There is ONE component, ONE renderer and ONE
 * appended entry. Nothing here is selectable, scored or compared any more:
 * every alternative that was ever drawn has been deleted, not disabled.
 *
 *   1  REAL HOST. The primary Pi transcript is the host. No fake transcript, no
 *      fake editor, no fake footer is ever drawn. Exactly ONE TUI-only custom
 *      entry is appended on `session_start` and rendered by ONE registered
 *      entry renderer. Custom entries never enter model context.
 *   2  FRAMED DELEGATION CARD. A bounded, framed inline component with a
 *      collapsed and an expanded form and a truthful inspect hint.
 *   3  IDENTITY RAIL GROUPING. A narrow LEFT RAIL carries the facts the parent
 *      scans vertically; a wide RIGHT BODY carries the assignment and then the
 *      live activity.
 *   4  NATIVE LINE. Beneath the assignment the right body carries exactly ONE
 *      quiet, Pi-like activity row: a semantic glyph plus the single most
 *      meaningful thing the child has produced.
 *   5  STATUS FIRST RAIL. The rail leads with the STATE, in upper case behind a
 *      toned bar (`▌FAILED`), the child name second and the elapsed time third.
 *      Ten columns.
 *   6  BALANCED EDGE FOOTER. One bottom border, two sides, one weight: run,
 *      phase, elapsed, tokens and cost on the left, and the truthful
 *      `Ctrl+O expand · Alt+I inspect child` on the right. `Alt+I` is PRINTED
 *      and NEVER BOUND — this extension registers no keybinding at all.
 *   7  DIRECT TASK. The top body row is ONE IMPERATIVE SENTENCE in the parent's
 *      own words and nothing else — no provenance prefix, no acceptance clause,
 *      no scope fields, no routing rationale.
 *   8  CHILD VIEWPORT. Expanded, the card shows a FIXED-HEIGHT LITERAL BOTTOM
 *      SLICE of the shared, Pi-like child transcript: one status strip reading
 *      `LIVE · following bottom` while the child can still act and
 *      `AT BOTTOM · child settled` once it cannot, plus `↑ N rows above` when
 *      there is scrollback, over nine transcript rows taken from the literal
 *      bottom. Nothing is summarised, grouped or relabelled.
 *   9  EVENT-ACCURATE STREAM. ONE shared timeline with a shared prefix and
 *      three tails — COMPLETED (52 microsteps), FAILED (46) and CANCELLED (44).
 *      Every microstep delivers EXACTLY ONE production event or ONE text delta.
 *  10  NATIVE SETTLE. When the authoritative settlement arrives the status
 *      rail, the Native Line and the footer update from it and NOTHING IS
 *      ADDED — no extra row, no banner, no border verdict. `Ctrl+O details` and
 *      `Alt+I inspect child` remain, and a settled child is READ-ONLY.
 *
 * THE SETTLEMENT IS AUTHORITATIVE, SAFE AND NEVER OPTIMISTIC.
 *   - A COMPLETED card prints the assistant output THE SETTLEMENT NAMED — the
 *     body of the message the `settle` reducer made authoritative. It never
 *     reads an ended-but-unsettled reply, so a completion CANDIDATE can never
 *     reach the card: three assistant messages end on the shared prefix and
 *     none of them can claim authority.
 *   - A FAILED card prints the already-redacted reason. No stack, no absolute
 *     path, no secret, no provider payload. Recovery is named only where the
 *     failure class is documented as recoverable (`retryGuidance`), and never
 *     as a card affordance.
 *   - A CANCELLED card names the initiator in safe terms, says the partial work
 *     was kept and that nothing was verified, and never claims success.
 *   - NOTHING on the card offers retry, steer, resume or cancel, in any state.
 *     `Ctrl+O expand`, `Ctrl+O details`, `Ctrl+O collapse` and
 *     `Alt+I inspect child` are the only actions it ever prints.
 *
 * THE PRE-SETTLEMENT CARD IS LOCKED. `activeTerminal` is the ONLY gate, and it
 * returns `undefined` unless the shared stream has published an authoritative
 * outcome AND that settlement named a row with text. One microstep before
 * settlement the card is the running card, at every width, on every path,
 * expanded or not.
 *
 * THE CARD STAYS BOUNDED. Collapsed it is four to six rows depending on the
 * width; narrow terminals keep the rail's state word, the assignment and
 * `Alt+I`. `TERMINAL_BODY_MAX` enforces the settled body budget.
 *
 * THE STREAM IS A DEMO CONTROL, NOT A TIMER. There is no interval, no timeout,
 * no background work and no async anything in this prototype. `Space` is the
 * primary advance key; `⇧Space` and `[` go back, `]` and `u` are aliases for
 * next, `0` resets to the first microstep and `End` or `g` jumps to the settled
 * one. The stream controller prints the path, `step N/M`, the PRODUCTION EVENT
 * TYPE that just arrived (`message_update · summary delta 3/6`,
 * `tool_partial_result · bash 18 of 24`, `settlement · completed ·
 * authoritative`) and the lifecycle state.
 *
 * THE VOCABULARY IS PRODUCTION'S, NOT AN INVENTION. Every microstep names one
 * parser-approved event from `packages/adapters/pi/src/child-session-events.ts`
 * — `message_start`, `message_update`, `message_end`, `tool_call`,
 * `tool_partial_result`, `tool_result`, `tool_error`, `queue_change`, `status`,
 * `retry`, `usage` — plus the two facts that schema deliberately does not
 * carry: the overlay replay `input` step from `child-overlay-replay.ts`, and
 * the AUTHORITATIVE settlement, which `child-compact-render.ts` accepts only as
 * its own `settle` reducer input and never derives from a child event. No raw
 * provider protocol row is simulated anywhere.
 *
 * THE CARD REPAINTS IN PLACE. Stepping the stream mutates in-memory demo state
 * and calls `tui.requestRender()`; the already-appended entry re-renders. NO
 * TRANSCRIPT ENTRY IS EVER APPENDED PER STEP — `pi.appendEntry` is called
 * exactly once, ever, guarded by a counter the smoke test asserts on at every
 * step of every stream.
 *
 * HOW THIS PROTOTYPE STAYS HONEST
 *   - Stepping the stream, jumping a checkpoint or toggling the demo expansion
 *     MUTATES IN-MEMORY DEMO STATE ONLY.
 *   - The stream controller is a small NATIVE Pi overlay anchored TOP-RIGHT, so
 *     it never covers the entry it is showing.
 *   - Every mock string passes `safeText` (ANSI stripped, control bytes
 *     removed, box drawing removed) BEFORE it becomes a segment, so mock
 *     content structurally cannot paint the screen, forge a frame or break
 *     width math. `▍`, `▏` and `▌` are block-element glyphs and therefore
 *     reachable only through `glyph()`, which mock data cannot call.
 *   - Every emitted line is clipped to the viewport width by `emit`, which is
 *     the only function that turns segments into terminal output.
 *   - Reasoning is rendered as a SUMMARY only, headed `reasoning · SUMMARY` in
 *     the expanded viewport and `summary · …` on the collapsed Native Line.
 *   - Failure text is the already-redacted, human-safe reason, expanded or not.
 *   - The one file name any region may print is the bounded, RELATIVE demo path
 *     `child-overlay-component.ts`.
 *
 * Launch:
 *   pi --no-extensions -e ./prototypes/weave-delegate-tool-grilling.ts \
 *      --no-session --offline --tui-mode fullscreen
 *
 * Controls (also printed inside the stream controller):
 *   Space        advance ONE microstep — the primary stream key
 *   ⇧Space / [   go back one microstep      ] / u   aliases for next
 *   0            reset to microstep 1        End / g   jump to settled
 *   b r t s      accepted · summary · tool calls · steered checkpoints
 *   c f x        switch to the completed · failed · cancelled tail AND settle
 *   e            toggle the demo expanded view (Pi's own Ctrl+O also works,
 *                and is the real binding this card ships with)
 *   Esc          close the controller only — the inline entry stays on screen
 *
 * NO KEY ABOVE IS A GLOBAL PI SHORTCUT. This extension registers no keybinding
 * at all; every key is handled only while the controller overlay has focus, and
 * there is no selection key of any kind: `←`, `→` and `1`–`5` do nothing.
 *
 * Commands:
 *   /grilling         reopen the stream controller
 *   /grilling-clear   clear the status chip and close the controller
 *
 * Every agent, file, number, cost and result below is MOCK DATA and says so on
 * screen. Single file. Bun only. No server, no browser, no network, no timer,
 * no model call, no message ever sent to the model.
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
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";

/* ==========================================================================
   1. MOCK DATA — deliberately unmistakable
   ========================================================================== */

const DEMO_MARK = "DEMO DATA";

/** The tool name under review. Printed verbatim on the card's top edge. */
const TOOL = "weave_delegate";

/** Parent-side identity: who issued the delegation. */
const PARENT = {
	agent: "LOOM",
	role: "planner",
} as const;

/** Child-side identity: one child, identical across every state. */
const CHILD = {
	agent: "shuttle",
	role: "implementer",
	model: "gpt-5.6-sol",
	childId: "9f31…c4",
	thread: "thread 2 · leaf 7",
} as const;

/**
 * The BOUNDED ASSIGNMENT, in the parent's own words. This is the fact that
 * makes a delegation block readable at a glance: not what the child is doing
 * right now, but what it was asked to do. It is static — a tool failure does
 * not change an assignment — and it is the card's top body row, verbatim.
 */
const ASSIGNMENT = "Fix header suffix width handling and run the focused sweep.";

/** Same assignment, already bounded hard for a one-line slot. */
const ASSIGNMENT_SHORT = "Fix header suffix width · focused sweep";

/** The action/run descriptor production prints on its third line. */
const ACTION = "run 1 · start";

type Tone = "run" | "ok" | "warn" | "bad" | "mute";

/**
 * One demo state. Every rail reads the SAME facts, so a rail can only win by
 * choosing a better hierarchy, order and width — never by inventing data
 * another rail was denied.
 */
interface StateFacts {
	/** Direct checkpoint key. */
	readonly key: string;
	readonly id: string;
	/** The lifecycle label the stream controller prints. */
	readonly label: string;
	/** Status word the rail shows (`running`, `failed`, …). */
	readonly status: string;
	/** Finer phase (`tool call`, `bootstrap`), used by the footer. */
	readonly phase: string;
	readonly tone: Tone;
	/** True once the child can no longer act. */
	readonly settled: boolean;
	/** Latest meaningful reasoning SUMMARY — never raw chain-of-thought. */
	readonly summary: string;
	/** Bootstrap/system note, when the child has not produced activity yet. */
	readonly bootNote?: string;
	/** Active or last tool call. */
	readonly tool?: string;
	/** Safe progress or result for that tool. */
	readonly toolResult?: string;
	/** Queue / intervention record when the parent steered the child. */
	readonly queue?: string;
	/** Authoritative final response on completion. */
	readonly final?: string;
	/** Safe, already-redacted failure reason. */
	readonly failure?: string;
	/**
	 * The failure CLASS, in product vocabulary. Expanded regions may name it;
	 * nothing derives a recovery from a class this prototype cannot state.
	 */
	readonly failureClass?: string;
	/**
	 * True only where the failure class has a documented recovery. This is the
	 * single gate on retry guidance: an unclassified failure gets no advice.
	 */
	readonly retryable?: boolean;
	/** Cancellation record. */
	readonly cancel?: string;
	readonly elapsed: string;
	readonly tokens: string;
	readonly cost: string;
	/** Action/run line, e.g. `run 1 · start`. */
	readonly action: string;
}

const STATES: readonly StateFacts[] = [
	{
		key: "b",
		id: "bootstrap",
		label: "starting · bootstrap",
		status: "starting",
		phase: "bootstrap",
		tone: "run",
		settled: false,
		summary: "…",
		bootNote: "provisioning child thread · tool policy inherited",
		elapsed: "0.4s",
		tokens: "0 tok",
		cost: "$0.00",
		action: ACTION,
	},
	{
		key: "r",
		id: "reasoning",
		label: "running · reasoning",
		status: "running",
		phase: "reasoning",
		tone: "run",
		settled: false,
		summary:
			"Reserving the trailing status suffix before the title truncates, then re-running the width sweep.",
		elapsed: "38s",
		tokens: "4.2k tok",
		cost: "$0.03",
		action: ACTION,
	},
	{
		key: "t",
		id: "tool",
		label: "running · tool call",
		status: "running",
		phase: "tool call",
		tone: "run",
		settled: false,
		summary:
			"Reserving the trailing status suffix before the title truncates, then re-running the width sweep.",
		tool: "edit · child-overlay-component.ts",
		toolResult: "1 replacement · +6 −3",
		elapsed: "1m12s",
		tokens: "9.8k tok",
		cost: "$0.07",
		action: ACTION,
	},
	{
		key: "s",
		id: "steered",
		label: "queued · steered",
		status: "steered",
		phase: "queued",
		tone: "warn",
		settled: false,
		summary:
			"Acknowledged the steer; finishing the edit before widening the sweep.",
		tool: "bash · bun test --filter overlay",
		toolResult: "running · 18 of 24",
		queue: "1 queued · from LOOM: also keep the 40 to 200 column sweep green",
		elapsed: "1m48s",
		tokens: "12.6k tok",
		cost: "$0.09",
		action: "run 1 · steer",
	},
	{
		key: "c",
		id: "completed",
		label: "completed",
		status: "completed",
		phase: "settled",
		tone: "ok",
		settled: true,
		summary: "Suffix reserved before truncation; the sweep is green.",
		tool: "bash · bun test --filter overlay",
		toolResult: "24 pass · 0 fail",
		final:
			"Reserved the trailing status suffix before the title truncates. Width sweep green from 40 to 200 columns. 1 file changed, +6 −3, 24 focused tests pass.",
		elapsed: "2m31s",
		tokens: "18.4k tok",
		cost: "$0.12",
		action: "run 1 · settled",
	},
	{
		key: "f",
		id: "failed",
		label: "failed",
		status: "failed",
		phase: "settled",
		tone: "bad",
		settled: true,
		summary: "Stopped after the focused sweep failed at width 41.",
		tool: "bash · bun test --filter overlay",
		toolResult: "23 pass · 1 fail at width 41",
		failure: "child settlement missing · no child activity for 15m00s",
		failureClass: "child settlement missing",
		retryable: true,
		elapsed: "15m02s",
		tokens: "21.7k tok",
		cost: "$0.15",
		action: "run 1 · failed",
	},
	{
		key: "x",
		id: "cancelled",
		label: "cancelled",
		status: "cancelled",
		phase: "settled",
		tone: "mute",
		settled: true,
		summary: "Cancelled by LOOM after the steer; the applied edit was kept.",
		tool: "bash · bun test --filter overlay",
		toolResult: "abandoned in flight",
		cancel: "cancelled by parent · 1 tool call abandoned · edit left applied",
		// Stamps track the shared timeline: the cancel tail branches after the
		// bash call has already reported `18 of 24` at 1m18s.
		elapsed: "1m26s",
		tokens: "13.2k tok",
		cost: "$0.09",
		action: "run 1 · cancelled",
	},
];

/* ---- KEY HINTS — truthful, and ranked by what survives narrowing ---------

   `Alt+I` is the printed name of the child inspector. It is printed, NEVER
   BOUND: this extension registers no keybinding at all, and the smoke test
   asserts it. `Ctrl+O` is Pi's own expand/collapse binding for tool output,
   which this entry already honours, so it is the one key hint the product
   could ship today. `Enter` is deliberately absent — the prototype does not
   implement it, so it does not advertise it.

   The three inspect spellings are a LADDER, richest first. Narrow terminals
   walk down it, and the bare key is the last passenger off the card.
   ------------------------------------------------------------------------ */

const INSPECT_HINT = "Alt+I inspect child";
const INSPECT_HINT_MID = "Alt+I inspect";
const INSPECT_HINT_MIN = "Alt+I";

/** Pi's real binding, so this hint is safe to print. */
const EXPAND_KEY = "Ctrl+O";

/**
 * The expand verb for this state. A LIVE child expands; a SETTLED child is
 * read, not resumed. Either way the expanded card collapses, and no verb here
 * ever implies retry, steer, cancel or any other mutation of a settled run.
 */
function expandVerb(f: StateFacts, expanded: boolean): string {
	if (expanded) return "collapse";
	return f.settled ? "details" : "expand";
}

/** `Ctrl+O expand`, `Ctrl+O details`, `Ctrl+O collapse`. Always truthful. */
function expandHint(f: StateFacts, expanded: boolean): string {
	return `${EXPAND_KEY} ${expandVerb(f, expanded)}`;
}

/* ==========================================================================
   2. WIDTH-SAFE PRIMITIVES

   `emit` is the ONLY path from data to terminal output, and it clips. `seg`
   is the ONLY constructor of a content segment, and it sanitizes. Together they
   make "no raw ANSI from mock content" and "every line obeys width" structural
   properties rather than review discipline.
   ========================================================================== */

type Ink =
	| "text"
	| "acc"
	| "alt"
	| "dim"
	| "muted"
	| "ok"
	| "warn"
	| "bad"
	| "rule"
	| "bold"
	| "inv";

interface Seg {
	readonly ink: Ink;
	readonly t: string;
}

type Row = readonly Seg[];

type Paint = Record<Ink, (s: string) => string>;

const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Box drawing (U+2500–U+257F) and block elements (U+2580–U+259F). */
const BOX_CHARS = /[\u2500-\u259F]/g;

/**
 * Strip terminal sequences, drop control bytes and delete box drawing. All mock
 * content passes through here on its way into a segment, so no mock string can
 * colour the screen, move the cursor, smuggle a newline into a one-line slot or
 * forge a second frame.
 *
 * Runs of spaces are DELIBERATELY preserved: separator segments such as
 * `" · "`, the rail divider gutter and fixed-width label padding all depend on
 * exact spacing. Tabs and newlines still become single spaces.
 */
function safeText(raw: string): string {
	return stripTerminalSequences(raw)
		.replace(/[\t\n\v\f\r]/g, " ")
		.replace(CONTROL_CHARS, "")
		.replace(BOX_CHARS, "");
}

/**
 * The only segment constructor that may emit box-drawing glyphs. The card
 * frame, the rail divider and the active-block bar call it; mock content never
 * can, because `safeText` deletes the whole box-drawing and block-element
 * range. That is what makes "exactly one border, no nested cards" a structural
 * property instead of a hope about mock data.
 */
function glyph(ink: Ink, t: string): Seg {
	return { ink, t };
}

/** Same sanitizer, whitespace-collapsed and trimmed — used for prose. */
function safeTrim(raw: string): string {
	return safeText(raw).replace(/ +/g, " ").trim();
}

/** The only content segment constructor. */
function seg(ink: Ink, t: string): Seg {
	return { ink, t: safeText(t) };
}

/**
 * ANSI-free truncation. `truncateToWidth` from pi-tui preserves styling by
 * emitting reset sequences, which would put raw ANSI into text this prototype
 * promises is ANSI-free. Every string here is already sanitized, so a plain
 * grapheme walk is both correct and cheaper.
 */
function truncatePlain(text: string, width: number, suffix = "…"): string {
	const limit = Math.max(0, Math.floor(width));
	if (limit === 0) return "";
	if (visibleWidth(text) <= limit) return text;
	const suffixWidth = visibleWidth(suffix);
	if (limit <= suffixWidth) return suffix.slice(0, limit);
	const room = limit - suffixWidth;
	let out = "";
	let used = 0;
	for (const ch of text) {
		const w = visibleWidth(ch);
		if (used + w > room) break;
		out += ch;
		used += w;
	}
	return `${out}${suffix}`;
}

/** Padding/rule segment: exact repeated character, never sanitized away. */
function fill(ink: Ink, ch: string, count: number): Seg {
	return { ink, t: count > 0 ? ch.repeat(count) : "" };
}

function rowWidth(row: Row): number {
	let total = 0;
	for (const s of row) total += visibleWidth(s.t);
	return total;
}

/** Clip a row to `width` columns, adding an ellipsis when content is lost. */
function clipRow(row: Row, width: number): Row {
	const limit = Math.max(0, Math.floor(width));
	if (limit === 0) return [];
	if (rowWidth(row) <= limit) return row;
	const out: Seg[] = [];
	let used = 0;
	for (const s of row) {
		const room = limit - used;
		if (room <= 0) break;
		const w = visibleWidth(s.t);
		if (w <= room) {
			out.push(s);
			used += w;
			continue;
		}
		const piece = truncatePlain(s.t, room);
		if (visibleWidth(piece) > 0) out.push({ ink: s.ink, t: piece });
		used = limit;
		break;
	}
	return out;
}

/** Pad a row on the right to exactly `width` columns (after clipping). */
function padRow(row: Row, width: number, ink: Ink = "dim"): Row {
	const clipped = clipRow(row, width);
	const gap = Math.max(0, Math.floor(width) - rowWidth(clipped));
	return gap > 0 ? [...clipped, fill(ink, " ", gap)] : clipped;
}

/** Render one row to a terminal line. The single ANSI-producing function. */
function emit(row: Row, width: number, p: Paint): string {
	const clipped = clipRow(row, width);
	let out = "";
	for (const s of clipped) {
		if (s.t.length === 0) continue;
		out += p[s.ink](s.t);
	}
	return out;
}

/** Plain word wrap. Input is already sanitized single-line text. */
function wrapPlain(text: string, width: number, maxLines: number): string[] {
	const limit = Math.max(4, Math.floor(width));
	const words = safeTrim(text)
		.split(" ")
		.filter((w) => w.length > 0);
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const next = line.length === 0 ? word : `${line} ${word}`;
		if (visibleWidth(next) <= limit) {
			line = next;
			continue;
		}
		if (line.length > 0) lines.push(line);
		line = visibleWidth(word) <= limit ? word : truncatePlain(word, limit);
		if (lines.length >= maxLines) break;
	}
	if (line.length > 0 && lines.length < maxLines) lines.push(line);
	if (lines.length > maxLines) lines.length = maxLines;
	// Signal loss on the last kept line when content was dropped.
	const kept = lines.join(" ");
	if (visibleWidth(kept) < visibleWidth(safeTrim(text)) && lines.length > 0) {
		const last = lines[lines.length - 1] ?? "";
		lines[lines.length - 1] = truncatePlain(`${last} …`, limit);
	}
	return lines;
}

/* ==========================================================================
   3. PAINT — theme in, ink out
   ========================================================================== */

function makePaint(theme: Theme): Paint {
	return {
		text: (s) => theme.fg("text", s),
		acc: (s) => theme.fg("accent", s),
		alt: (s) => theme.fg("customMessageLabel", s),
		dim: (s) => theme.fg("dim", s),
		muted: (s) => theme.fg("muted", s),
		ok: (s) => theme.fg("success", s),
		warn: (s) => theme.fg("warning", s),
		bad: (s) => theme.fg("error", s),
		rule: (s) => theme.fg("borderMuted", s),
		bold: (s) => theme.bold(s),
		inv: (s) => theme.inverse(s),
	};
}

/** ANSI-free paint, used by the noninteractive smoke test. */
function plainPaint(): Paint {
	const id = (s: string): string => s;
	return {
		text: id,
		acc: id,
		alt: id,
		dim: id,
		muted: id,
		ok: id,
		warn: id,
		bad: id,
		rule: id,
		bold: id,
		inv: id,
	};
}

function toneInk(tone: Tone): Ink {
	switch (tone) {
		case "run":
			return "acc";
		case "ok":
			return "ok";
		case "warn":
			return "warn";
		case "bad":
			return "bad";
		default:
			return "muted";
	}
}

/* ==========================================================================
   4. SHARED FACT SELECTORS

   Every rail must answer its questions from the same facts. Answering them
   once, here, keeps the five comparable: they differ in FACT HIERARCHY, WIDTH
   AND EMPHASIS, not in which facts they were allowed to see.
   ========================================================================== */

interface Activity {
	/** Short kind label: `tool`, `think`, `queue`, `reply`, `error`, `cancel`. */
	readonly kind: string;
	readonly text: string;
	readonly ink: Ink;
}

/** `bash · bun test --filter overlay · running · 18 of 24`, or undefined. */
function toolPhrase(f: StateFacts): string | undefined {
	if (!f.tool) return undefined;
	return f.toolResult ? `${f.tool} · ${f.toolResult}` : f.tool;
}

/**
 * The single most meaningful thing to say about the child RIGHT NOW, in one
 * line. Precedence is deliberate: settlement outranks queue, queue outranks a
 * live tool, a live tool outranks a reasoning summary, and a child with no
 * activity yet gets the bootstrap note.
 */
function latestActivity(f: StateFacts): Activity {
	if (f.failure) return { kind: "error", text: f.failure, ink: "bad" };
	if (f.cancel) return { kind: "cancel", text: f.cancel, ink: "muted" };
	if (f.final) return { kind: "reply", text: f.final, ink: "text" };
	if (f.queue) return { kind: "queue", text: f.queue, ink: "warn" };
	const tool = toolPhrase(f);
	if (tool) return { kind: "tool", text: tool, ink: "text" };
	if (f.bootNote) return { kind: "boot", text: f.bootNote, ink: "muted" };
	return { kind: "think", text: f.summary, ink: "text" };
}

/**
 * NEVER SHOW RAW CHAIN-OF-THOUGHT. Reasoning is a bounded SUMMARY and the card
 * must say so in words, not merely imply it with a glyph. The Native Line body
 * runs every reasoning summary through here first.
 */
function markSummary(a: Activity): Activity {
	return a.kind === "think" ? { ...a, text: `summary · ${a.text}` } : a;
}

/**
 * The demo mark is a prototype affordance, not product data, so it yields the
 * column first. Below 56 columns the tool name wins and the mark is dropped;
 * the entry's own banner line still says DEMO DATA, so nothing is ever mistaken
 * for a real child.
 */
function demoTagFor(width: number, lead = "  "): Row {
	return width >= 56 ? [seg("dim", `${lead}${DEMO_MARK}`)] : [];
}

/* ==========================================================================
   5. THE CARD FRAME

   Frame invariants the shell obeys (all asserted by the smoke test):
     - exactly ONE `╭…╮` top edge and ONE `╰…╯` bottom edge;
     - every interior row starts and ends with `│`;
     - no corner glyph ever appears inside the card, so there are no nested
       cards and no second border competing for the eye;
     - collapsed height stays inside 5–7 rows at every width and every state;
     - the rail and the latest activity survive narrowing first, the assignment
       truncates rather than disappears, and telemetry drops before the inspect
       hint.
   ========================================================================== */

/**
 * The narrowest card this prototype will draw. It matches the clamp the live
 * entry applies, so the width a rail lays out for is always the width `emit`
 * clips to and the frame can never be cut in half.
 */
const MIN_CARD_WIDTH = 12;

/** `╭─ left ────── right ─╮` style edge, width-safe and right-droppable. */
function cardEdge(width: number, open: boolean, left: Row, right: Row): Row {
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
function cardBody(width: number, content: Row): Row {
	const inner = Math.max(0, width - 4);
	return [
		glyph("rule", "│"),
		fill("rule", " ", 1),
		...padRow(content, inner),
		fill("rule", " ", 1),
		glyph("rule", "│"),
	];
}

function clipText(text: string, width: number): string {
	return truncatePlain(safeTrim(text), Math.max(1, width));
}

/**
 * The semantic role of a rendered row. Slots are what make the card checkable
 * region by region: the expanded Child Viewport owns exactly one slot,
 * `detail`, and every other slot — `frame-top`, `identity`, `task`, `activity`,
 * `activity-detail`, `rule` and `frame-bottom` — belongs to the shell.
 */
type Slot =
	| "frame-top"
	| "frame-bottom"
	| "rule"
	| "identity"
	| "task"
	| "activity"
	| "activity-detail"
	| "detail";

/**
 * One rendered row. `rail` and `body` are the two COLUMNS of a zipped body row,
 * kept beside the composed line on purpose: a two-row assignment shifts the
 * activity line down one physical row, so "the non-assignment regions did not
 * change" can only be checked column by column, never line by line.
 */
interface CardRow {
	readonly slot: Slot;
	readonly row: Row;
	/** The rail cell on this row, when the row is a zipped body row. */
	readonly rail?: Row;
	/** The body cell on this row, when the row is a zipped body row. */
	readonly body?: Row;
}

function edgeTop(width: number, left: Row, right: Row): CardRow {
	return { slot: "frame-top", row: cardEdge(width, true, left, right) };
}

function edgeBottom(width: number, left: Row, right: Row): CardRow {
	return { slot: "frame-bottom", row: cardEdge(width, false, left, right) };
}

function bodyRow(width: number, slot: Slot, content: Row): CardRow {
	return { slot, row: cardBody(width, content) };
}

/** A full-width interior separator. A rule, deliberately NOT a second frame. */
function ruleRow(width: number): CardRow {
	const inner = Math.max(1, width - 4);
	return { slot: "rule", row: cardBody(width, [fill("rule", "─", inner)]) };
}

/* ==========================================================================
   5e. THE FOOTER — BALANCED EDGE

   The bottom edge is a CONSTANT. One border, two sides, one weight:

     ╰─ run 1 · reasoning · 38s · 4.2k tok · $0.03 ── Ctrl+O expand · Alt+I … ─╯

   IT DOES NOT CHANGE SHAPE AT SETTLEMENT. Native Settle keeps the same two
   sides and the same ladders; only the words the ladders are built from move,
   because `expandVerb` says `details` for a settled child.

   THE DROP ORDER IS MECHANICAL, NOT EDITORIAL. The action side is measured
   FIRST at every width and the telemetry side is offered only the columns that
   survive it. So `Alt+I` outlives the expand hint, the expand hint outlives
   elapsed, and run, phase, tokens and cost leave before either hint — by
   construction, without a single width constant.
   ------------------------------------------------------------------------ */

/**
 * Folded identity, used only when the terminal is too narrow to pay for a rail
 * column. `weave_delegate` already owns the top edge, so this row carries the
 * child and its status alone. It is a BODY row, not a footer row: this is the
 * one place the card prints identity outside the rail, and no footer may
 * duplicate it.
 */
function identityRow(f: StateFacts): Row {
	return [
		seg("text", CHILD.agent),
		seg("dim", " · "),
		seg(toneInk(f.tone), f.status),
	];
}

/** The first candidate that fits the budget. Candidates are richest-first. */
function fitRow(candidates: readonly Row[], budget: number): Row {
	for (const candidate of candidates) {
		if (rowWidth(candidate) <= budget) return candidate;
	}
	return [];
}

/** Turn a ladder of plain strings into a ladder of one-segment rows. */
function inkLadder(ink: Ink, texts: readonly string[]): readonly Row[] {
	return texts.map((t) => [seg(ink, t)]);
}

/**
 * The ACTION LADDER: the two key hints, richest first, degrading to the bare
 * `Alt+I`. The expand hint always leads and the inspect hint always survives
 * — that is what makes the "inspect survives first" rule structural rather
 * than remembered. These two hints are the ONLY hints the card can print, so a
 * settled footer structurally cannot offer retry, steer, resume or cancel.
 */
function actionLadder(f: StateFacts, expanded: boolean): readonly Row[] {
	const e = expandHint(f, expanded);
	const pair = (a: string, aInk: Ink, b: string, bInk: Ink): Row => [
		seg(aInk, a),
		seg("dim", " · "),
		seg(bInk, b),
	];
	return [
		pair(e, "dim", INSPECT_HINT, "dim"),
		pair(e, "dim", INSPECT_HINT_MID, "dim"),
		pair(EXPAND_KEY, "dim", INSPECT_HINT_MID, "dim"),
		[seg("dim", INSPECT_HINT_MID)],
		[seg("dim", INSPECT_HINT_MIN)],
	];
}

/**
 * `run 1 · reasoning`. The run descriptor uses the LIFECYCLE PHASE
 * (`bootstrap`, `reasoning`, `tool call`, `queued`, `settled`), never the
 * status word (`running`, `failed`, `cancelled`) — the rail owns that, and the
 * footer is forbidden from printing it a second time.
 */
function runDescriptor(f: StateFacts): string {
	return `${runParts(f).id} · ${f.phase}`;
}

/** Full telemetry ladder: run, phase, elapsed, tokens, cost — then less. */
function teleLadderFull(f: StateFacts): readonly string[] {
	return [
		`${runDescriptor(f)} · ${f.elapsed} · ${f.tokens} · ${f.cost}`,
		`${runDescriptor(f)} · ${f.elapsed} · ${f.cost}`,
		`${runDescriptor(f)} · ${f.elapsed}`,
		`${f.phase} · ${f.elapsed}`,
		f.elapsed,
	];
}

/**
 * Compose the bottom edge from a PRIMARY side and a SECONDARY side.
 *
 * The primary side is measured first and gets the columns it asks for; the
 * secondary side is offered only what is left, and the arithmetic mirrors
 * `cardEdge` exactly, so a fitted row can never push the frame out of shape or
 * force the edge to silently drop the side that matters. The ACTION side is
 * always primary, which is the whole drop-order guarantee in one line.
 *
 * The two budgets are DIFFERENT ON PURPOSE. `cardEdge` spends two extra rule
 * columns when its left side is empty, so a right-hand side can afford two
 * fewer columns than a left-hand one. Getting this wrong does not misalign the
 * frame — `cardEdge` would quietly drop the whole side instead, which is
 * exactly how an inspect hint disappears at one awkward width and nobody
 * notices. The smoke test sweeps every column from 12 to 200 for that reason.
 */
function composeEdge(
	width: number,
	primary: readonly Row[],
	secondary: readonly Row[],
	primarySide: "left" | "right",
): CardRow {
	const inner = Math.max(0, width - 4);
	const p = fitRow(primary, Math.max(0, inner - (primarySide === "left" ? 3 : 5)));
	const pw = rowWidth(p);
	const budget = inner - 2 - (pw > 0 ? pw + 2 : 0) - 1;
	// If not even the primary fits, the secondary does not get the columns it
	// vacated. An edge that prints `38s` on a card too narrow for `Alt+I` has
	// inverted the drop order, and the card is not allowed to do that.
	const fitted = pw === 0 ? [] : fitRow(secondary, Math.max(0, budget));
	// TELEMETRY NEVER OUTLIVES AN AFFORDANCE. Once the edge has degraded far
	// enough to lose `Ctrl+O`, whatever is left on the secondary side can only be
	// numbers, and numbers are the first thing to drop.
	const carriesExpand = [...p, ...fitted].some((x) => x.t.includes(EXPAND_KEY));
	const s = carriesExpand ? fitted : [];
	return primarySide === "left"
		? edgeBottom(width, p, s)
		: edgeBottom(width, s, p);
}

/**
 * THE FOOTER REGION: exactly one bottom edge, at every width, in every state,
 * under every assignment. `renderCard` asks for it once, as the last thing it
 * draws, and nothing above it may change it.
 *
 * Left side: the run, the lifecycle PHASE (never the status word — the rail
 * owns that), elapsed, tokens and cost, degrading through `teleLadderFull`.
 * Right side: `Ctrl+O expand · Alt+I inspect child`, degrading through
 * `actionLadder`, with the action side measured first so an affordance always
 * outlives a number.
 *
 * SETTLEMENT DOES NOT RESHAPE IT. Native Settle keeps both ladders, so the only
 * thing the authoritative outcome changes here is the expand VERB — `expand`
 * becomes `details` — and the telemetry the stream has already published.
 */
function cardFooter(
	width: number,
	f: StateFacts,
	expanded: boolean,
): readonly CardRow[] {
	return [
		composeEdge(
			width,
			actionLadder(f, expanded),
			inkLadder("dim", teleLadderFull(f)),
			"right",
		),
	];
}

/** `run 1 · start` split into its two halves, for column layouts. */
function runParts(f: StateFacts): {
	readonly id: string;
	readonly phase: string;
} {
	const parts = safeTrim(f.action).split(" · ");
	return { id: parts[0] ?? "run 1", phase: parts[1] ?? f.phase };
}

/* ==========================================================================
   5g. THE SHARED STREAM — THE SIMULATOR EVERY REGION READS

   Everything the card knows about the child lives between this banner and the
   Child Viewport below: the ONE SHARED TIMELINE, its projector, the SHARED
   PI-LIKE TRANSCRIPT RENDERER and the honest state phrases.

   ONE TIMELINE, THREE TAILS: 52 microsteps to COMPLETED, 46 to FAILED and 44 to
   CANCELLED, over a shared prefix. A settlement arrives exactly once and only
   as the LAST microstep of its tail, and the projector publishes AUTHORITY to
   exactly one row and only at that microstep.

   THAT LAST PROPERTY IS WHAT MAKES THE SETTLED CARD HONEST. `liveStream` sets
   `outcome` only from a `settlement` step and marks `authoritative` only on the
   row that settlement named, so the gate — `activeTerminal` — cannot fire one
   microstep early.
   ------------------------------------------------------------------------ */

/* ---- the production event vocabulary this simulator follows -------------

   Every microstep below names ONE event from the parser-approved child session
   schema in `packages/adapters/pi/src/child-session-events.ts`, plus the two
   facts that schema deliberately does NOT carry:

     `input`       one overlay replay input step — the delegation task, or a
                   steer — exactly as `child-overlay-replay.ts` records it:
                   `{ kind: "input", input: "task" | "steering" }`.
     `settlement`  the AUTHORITATIVE Task 8 settlement, which is never derived
                   from a child event: `child-compact-render.ts` accepts it only
                   as its own `settle` reducer input, and `reduceSettle` is the
                   only thing that may publish a final response, an error
                   summary or a cancellation.

   NOTHING HERE INVENTS A PROVIDER PROTOCOL ROW. `message_update` is Pi 0.84's
   streaming delta carrier, and the two flavours simulated are exactly the two
   the parent tree reader distinguishes: a TEXT delta, which becomes assistant
   body text, and a THINKING delta, which `mapPiChildSessionEventToCompactInput`
   records as a bounded reasoning item and never as body text. A thinking delta
   is rendered here as a bounded `SUMMARY` and never as raw chain-of-thought.

   `tool_call` ARRIVES TWICE PER CALL ON PURPOSE. `child-overlay-replay.ts`
   prefers the step that carries arguments when it compacts two `tool_call`
   steps for one `toolCallId` (`shouldReplaceCompactedStep`), which is
   production's own statement that a call can open before its arguments are
   readable. So a call opens bare, then gains its arguments, then may report
   `tool_partial_result`, and only ends on `tool_result` or `tool_error`.
   ------------------------------------------------------------------------ */

/** The production event families one microstep may deliver. */
type ChildEventType =
	| "input"
	| "status"
	| "message_start"
	| "message_update"
	| "message_end"
	| "tool_call"
	| "tool_partial_result"
	| "tool_result"
	| "tool_error"
	| "queue_change"
	| "retry"
	| "usage"
	| "settlement";

/**
 * The DISPLAY kind of one child row. It is the SHAPE the row takes on the
 * child's own screen, and it is deliberately NOT the production event name: one
 * `message_start` opens a `msg` head, six `message_update` thinking deltas grow
 * ONE `think` row beneath it, and three text deltas grow ONE `reply` row
 * beneath that. `run` is a progress tick on a call that is still open, and
 * `result` is a call's terminal `⎿` row whether it succeeded or failed — a
 * failing terminal differs by INK and TEXT, never by pretending to be open.
 */
type EventKind =
	| "sent"
	| "boot"
	| "msg"
	| "think"
	| "tool"
	| "run"
	| "result"
	| "queue"
	| "steer"
	| "retry"
	| "reply"
	| "error"
	| "cancel";

/** One display row of the child's transcript. */
interface MockEvent {
	readonly id: string;
	/** Relative stamp of the microstep that last touched this row. */
	readonly at: string;
	readonly kind: EventKind;
	/** Child turn. A tool RESULT re-invokes the child, so it opens a new turn. */
	readonly turn: number;
	readonly ink: Ink;
	/** Tool group, shared by a call, its progress ticks and its terminal row. */
	readonly group?: string;
}

/** The revealed view of one display row at the current cursor. */
interface LiveEvent {
	readonly e: MockEvent;
	/** The text revealed so far. Grows monotonically, in place. */
	readonly text: string;
	/** True while more deltas are still to come for this row. */
	readonly streaming: boolean;
	/** True once the row is frozen: `message_end`, or a one-shot event. */
	readonly ended: boolean;
	/** True for a tool call whose own result or error has not arrived yet. */
	readonly open: boolean;
	/** True only for the row the AUTHORITATIVE settlement named. */
	readonly authoritative: boolean;
}

/* ---- the three tails, the phases and the checkpoints -------------------- */

const PATH_IDS = ["completed", "failed", "cancelled"] as const;

/** Which tail of the shared timeline is active. */
type PathId = (typeof PATH_IDS)[number];

/** The authoritative settlement outcome. Identical to the tail, by design. */
type Outcome = PathId;

/** The lifecycle phase the rail and footer read, derived from the cursor. */
type PhaseId = "bootstrap" | "reasoning" | "tool" | "steered";

/** A named cursor position a direct key can jump to. */
type CheckpointId = "accepted" | "summary" | "tools" | "steer" | "settled";

/**
 * The direct keys, mapped to NAMED TIMELINE CHECKPOINTS rather than to seven
 * unrelated miniature streams. `b r t s` land on the SHARED PREFIX and keep the
 * active tail; `c f x` switch the tail AND land on its settlement, which is the
 * only useful near-terminal position on a tail a reader just chose.
 */
interface Checkpoint {
	readonly key: string;
	readonly id: CheckpointId;
	/** Present only where the key also switches the tail. */
	readonly path?: PathId;
	readonly label: string;
	readonly note: string;
}

const CHECKPOINTS: readonly Checkpoint[] = [
	{
		key: "b",
		id: "accepted",
		label: "accepted",
		note: "delegation accepted · prompt committed",
	},
	{
		key: "r",
		id: "summary",
		label: "summary",
		note: "the reasoning SUMMARY has finished growing",
	},
	{
		key: "t",
		id: "tools",
		label: "tool calls",
		note: "read and edit have both returned",
	},
	{
		key: "s",
		id: "steer",
		label: "steered",
		note: "a steer is queued behind the open call",
	},
	{
		key: "c",
		id: "settled",
		path: "completed",
		label: "completed",
		note: "authoritative final response",
	},
	{
		key: "f",
		id: "settled",
		path: "failed",
		label: "failed",
		note: "safe redacted failure reason",
	},
	{
		key: "x",
		id: "settled",
		path: "cancelled",
		label: "cancelled",
		note: "cancellation record · nothing verified",
	},
];

/* ---- the mock content, bounded and safe -------------------------------- */

const SENT_NOTE = "delegation accepted · task received · run 1";
const BOOT_NOTE = "child thread provisioned · tool policy inherited";
const SUMMARY_TEXT =
	"Reserving the trailing status suffix before the title truncates, then re-running the width sweep.";
const M1_TEXT = "Reading the component before touching the suffix arithmetic.";
const READ_CALL = "read · child-overlay-component.ts";
const READ_PROGRESS = "reading · 96 of 142 lines";
const READ_RESULT = "142 lines · suffix handling sits at the title truncation";
const M2_TEXT =
	"Reserving the suffix width before the title truncates, then re-running the focused sweep.";
const EDIT_CALL = "edit · child-overlay-component.ts";
const EDIT_RESULT = "1 replacement · +6 −3";
const STEER_TEXT = "from LOOM: also keep the 40 to 200 column sweep green";
const STEER_QUEUED = `${STEER_TEXT} · 1 queued`;
const STEER_DRAINED = `${STEER_TEXT} · queue drained`;
const STEER_STATUS = "steer queued behind the open tool call";
const M3_TEXT =
	"Acknowledged the steer; the 40 to 200 column sweep goes in the same run.";
const BASH_CALL = "bash · bun test --filter overlay";
const BASH_PROGRESS_EARLY = "running · 8 of 24";
const BASH_PROGRESS = "running · 18 of 24";
const BASH_PROGRESS_LATE = "running · 24 of 24";
const BASH_PROGRESS_FAILING = "running · 23 of 24";
const BASH_PASS = "24 pass · 0 fail";
const BASH_FAIL = "23 pass · 1 fail at width 41 · exit 1";
const BASH_ABANDONED = "abandoned in flight · no result recorded";
const RETRY_NOTE = "attempt 2 · transient tool failure · focused sweep re-run";
const AWAIT_NOTE = "awaiting child activity · budget renews on child activity";
const SILENT_NOTE = "no child activity for 10m00s";
const CANCEL_STATUS = "cancel requested by LOOM · draining the queue";

/**
 * Split one sanitized sentence into EXACTLY `parts` chunks on word boundaries
 * (or into one chunk per word, when the sentence is shorter than `parts`).
 * Joining the chunks back with a single space reproduces the sentence exactly,
 * which is what lets a streaming row grow WITHOUT ever showing text the mock
 * facts do not contain, and makes the growth strictly monotonic.
 */
function chunkWords(text: string, parts: number): readonly string[] {
	const words = safeTrim(text)
		.split(" ")
		.filter((w) => w.length > 0);
	if (words.length === 0) return [""];
	const n = Math.max(1, Math.min(Math.floor(parts), words.length));
	const out: string[] = [];
	let i = 0;
	for (let k = 0; k < n; k += 1) {
		const size = Math.ceil((words.length - i) / (n - k));
		out.push(words.slice(i, i + size).join(" "));
		i += size;
	}
	return out;
}

/** The revealed prefix of a chunk list after `k` deltas. Monotonic by design. */
function grown(chunks: readonly string[], k: number): string {
	return safeTrim(chunks.slice(0, Math.max(0, k)).join(" "));
}

const SUMMARY_CHUNKS = chunkWords(SUMMARY_TEXT, 6);
const M1_CHUNKS = chunkWords(M1_TEXT, 3);
const M2_CHUNKS = chunkWords(M2_TEXT, 3);
const M3_CHUNKS = chunkWords(M3_TEXT, 2);

function stateById(id: string): StateFacts {
	return (STATES.find((s) => s.id === id) ?? STATES[0]) as StateFacts;
}

const FINAL_CHUNKS = chunkWords(stateById("completed").final ?? "", 6);

/** `0.6s`, `38s`, `1m18s`, `15m02s`. One distinct stamp per microstep. */
function stamp(sec: number): string {
	if (sec < 10) return `${sec.toFixed(1)}s`;
	if (sec < 60) return `${Math.round(sec)}s`;
	const m = Math.floor(sec / 60);
	const s = Math.round(sec % 60);
	return `${m}m${String(s).padStart(2, "0")}s`;
}

/* ---- one microstep ------------------------------------------------------ */

/** The mutation one microstep applies to one display row. */
interface RowPatch {
	readonly id: string;
	readonly kind: EventKind;
	readonly turn: number;
	readonly ink: Ink;
	/** The row's FULL text after this microstep. Never shrinks. */
	readonly text: string;
	readonly group?: string;
	/** True while the row is still growing; absent means it is complete. */
	readonly streaming?: boolean;
}

/**
 * ONE MICROSTEP. Exactly one production event or one text delta, with the row
 * mutation it causes, the readout the stream controller prints, and the
 * telemetry the card is allowed to show once it has arrived.
 */
interface TimelineStep {
	/** 1-based position on this tail. */
	readonly n: number;
	readonly type: ChildEventType;
	readonly at: string;
	/** `message_update · summary delta 3/6`. Exact, and printed verbatim. */
	readonly readout: string;
	readonly tokens?: string;
	readonly cost?: string;
	readonly row?: RowPatch;
	/** Rows a `message_end` freezes: they stop streaming and lose the caret. */
	readonly freeze?: readonly string[];
	/** The authoritative settlement. Only ever on the LAST step of a tail. */
	readonly settles?: Outcome;
	/** The row the settlement makes authoritative. */
	readonly settleRow?: string;
	/** The lifecycle phase this microstep moves the rail and footer into. */
	readonly phase?: PhaseId;
	readonly mark?: CheckpointId;
}

/**
 * THE ONE SHARED TIMELINE. A 39-microstep prefix every tail shares, then the
 * tail the caller asked for. Only the tail differs, so switching paths never
 * swaps in an unrelated miniature stream: the reader keeps the same child, the
 * same calls and the same messages, and only the ending changes.
 */
function buildTimeline(path: PathId): readonly TimelineStep[] {
	const steps: TimelineStep[] = [];

	const row = (
		id: string,
		kind: EventKind,
		turn: number,
		ink: Ink,
		text: string,
		opts: { readonly group?: string; readonly streaming?: boolean } = {},
	): RowPatch => ({
		id,
		kind,
		turn,
		ink,
		text,
		...(opts.group === undefined ? {} : { group: opts.group }),
		...(opts.streaming === undefined ? {} : { streaming: opts.streaming }),
	});

	const add = (
		sec: number,
		type: ChildEventType,
		readout: string,
		extra: {
			readonly tokens?: string;
			readonly cost?: string;
			readonly row?: RowPatch;
			readonly freeze?: readonly string[];
			readonly settles?: Outcome;
			readonly settleRow?: string;
			readonly phase?: PhaseId;
			readonly mark?: CheckpointId;
		} = {},
	): void => {
		steps.push({
			n: steps.length + 1,
			type,
			at: stamp(sec),
			readout,
			...extra,
		});
	};

	/* --- shared prefix: acceptance and provisioning ---------------------- */

	add(0.0, "status", "status · delegation accepted", {
		row: row("s1", "boot", 1, "dim", SENT_NOTE),
	});
	add(0.3, "status", "status · child thread provisioned", {
		row: row("s2", "boot", 1, "muted", BOOT_NOTE),
	});
	add(0.6, "input", "input · delegation prompt committed", {
		row: row("p1", "sent", 1, "muted", ASSIGNMENT),
		mark: "accepted",
	});

	/* --- shared prefix: the first assistant message ---------------------- */

	add(2.1, "message_start", "message_start · assistant m1", {
		row: row("m1h", "msg", 1, "text", "", { streaming: true }),
	});
	const summarySecs = [3.0, 4.2, 5.4, 6.6, 7.9, 9.1];
	for (const [i, sec] of summarySecs.entries()) {
		const k = i + 1;
		add(
			sec,
			"message_update",
			`message_update · summary delta ${k}/${SUMMARY_CHUNKS.length}`,
			{
				row: row("m1r", "think", 1, "dim", grown(SUMMARY_CHUNKS, k), {
					streaming: k < SUMMARY_CHUNKS.length,
				}),
				...(k === 1 ? { phase: "reasoning" as PhaseId } : {}),
				...(k === SUMMARY_CHUNKS.length ? { mark: "summary" as CheckpointId } : {}),
			},
		);
	}
	const m1Secs = [11, 12, 13];
	for (const [i, sec] of m1Secs.entries()) {
		const k = i + 1;
		add(
			sec,
			"message_update",
			`message_update · m1 text delta ${k}/${M1_CHUNKS.length}`,
			{
				row: row("m1b", "reply", 1, "text", grown(M1_CHUNKS, k), {
					streaming: k < M1_CHUNKS.length,
				}),
			},
		);
	}
	add(14, "message_end", "message_end · assistant m1", {
		freeze: ["m1h", "m1r", "m1b"],
	});

	/* --- shared prefix: the read call ------------------------------------ */

	add(15, "tool_call", "tool_call · read · args pending", {
		row: row("t-read", "tool", 1, "text", "read", { group: "read" }),
		phase: "tool",
	});
	add(16, "tool_call", "tool_call · read · args ready", {
		row: row("t-read", "tool", 1, "text", READ_CALL, { group: "read" }),
	});
	add(18, "tool_partial_result", "tool_partial_result · read 96 of 142", {
		row: row("rp-read", "run", 1, "muted", READ_PROGRESS, { group: "read" }),
	});
	add(20, "tool_result", "tool_result · read 142 lines", {
		row: row("r-read", "result", 2, "muted", READ_RESULT, { group: "read" }),
	});
	add(21, "usage", "usage · 4.2k tok · $0.03", {
		tokens: "4.2k tok",
		cost: "$0.03",
	});

	/* --- shared prefix: the second assistant message and the edit -------- */

	add(22, "message_start", "message_start · assistant m2", {
		row: row("m2h", "msg", 2, "text", "", { streaming: true }),
	});
	const m2Secs = [24, 25, 26];
	for (const [i, sec] of m2Secs.entries()) {
		const k = i + 1;
		add(
			sec,
			"message_update",
			`message_update · m2 text delta ${k}/${M2_CHUNKS.length}`,
			{
				row: row("m2b", "reply", 2, "text", grown(M2_CHUNKS, k), {
					streaming: k < M2_CHUNKS.length,
				}),
			},
		);
	}
	add(28, "message_end", "message_end · assistant m2", {
		freeze: ["m2h", "m2b"],
	});
	add(30, "tool_call", "tool_call · edit · args pending", {
		row: row("t-edit", "tool", 2, "text", "edit", { group: "edit" }),
	});
	add(31, "tool_call", "tool_call · edit · args ready", {
		row: row("t-edit", "tool", 2, "text", EDIT_CALL, { group: "edit" }),
	});
	add(36, "tool_result", "tool_result · edit 1 replacement · +6 −3", {
		row: row("r-edit", "result", 3, "muted", EDIT_RESULT, { group: "edit" }),
		mark: "tools",
	});
	add(37, "usage", "usage · 9.8k tok · $0.07", {
		tokens: "9.8k tok",
		cost: "$0.07",
	});

	/* --- shared prefix: the steer ---------------------------------------- */

	add(41, "input", "input · steer from LOOM", {
		row: row("q1", "queue", 3, "warn", STEER_TEXT),
		phase: "steered",
	});
	add(42, "queue_change", "queue_change · 1 queued", {
		row: row("q1", "queue", 3, "warn", STEER_QUEUED),
	});
	add(44, "status", "status · steer queued behind the call", {
		row: row("s3", "boot", 3, "warn", STEER_STATUS),
		mark: "steer",
	});

	/* --- shared prefix: the acknowledgement and the bash call ------------ */

	add(46, "message_start", "message_start · assistant m3", {
		row: row("m3h", "msg", 3, "text", "", { streaming: true }),
		phase: "tool",
	});
	const m3Secs = [48, 50];
	for (const [i, sec] of m3Secs.entries()) {
		const k = i + 1;
		add(
			sec,
			"message_update",
			`message_update · m3 text delta ${k}/${M3_CHUNKS.length}`,
			{
				row: row("m3b", "reply", 3, "text", grown(M3_CHUNKS, k), {
					streaming: k < M3_CHUNKS.length,
				}),
			},
		);
	}
	add(52, "message_end", "message_end · assistant m3", {
		freeze: ["m3h", "m3b"],
	});
	add(54, "tool_call", "tool_call · bash · args pending", {
		row: row("t-bash", "tool", 3, "text", "bash", { group: "bash" }),
	});
	add(55, "tool_call", "tool_call · bash · args ready", {
		row: row("t-bash", "tool", 3, "text", BASH_CALL, { group: "bash" }),
	});
	add(64, "tool_partial_result", "tool_partial_result · bash 8 of 24", {
		row: row("rp-bash", "run", 3, "muted", BASH_PROGRESS_EARLY, {
			group: "bash",
		}),
	});
	add(78, "tool_partial_result", "tool_partial_result · bash 18 of 24", {
		row: row("rp-bash", "run", 3, "muted", BASH_PROGRESS, { group: "bash" }),
	});

	/* --- the completed tail ---------------------------------------------- */

	if (path === "completed") {
		add(86, "tool_partial_result", "tool_partial_result · bash 24 of 24", {
			row: row("rp-bash", "run", 3, "muted", BASH_PROGRESS_LATE, {
				group: "bash",
			}),
		});
		add(90, "tool_result", "tool_result · bash 24 pass · 0 fail", {
			row: row("r-bash", "result", 4, "ok", BASH_PASS, { group: "bash" }),
		});
		add(91, "usage", "usage · 15.1k tok · $0.10", {
			tokens: "15.1k tok",
			cost: "$0.10",
		});
		add(96, "message_start", "message_start · final response", {
			row: row("m4h", "msg", 4, "text", "", { streaming: true }),
		});
		const finalSecs = [104, 112, 120, 128, 136, 144];
		for (const [i, sec] of finalSecs.entries()) {
			const k = i + 1;
			add(
				sec,
				"message_update",
				`message_update · final text delta ${k}/${FINAL_CHUNKS.length}`,
				{
					row: row("m4b", "reply", 4, "text", grown(FINAL_CHUNKS, k), {
						streaming: k < FINAL_CHUNKS.length,
					}),
				},
			);
		}
		add(146, "message_end", "message_end · final response", {
			freeze: ["m4h", "m4b"],
		});
		add(148, "usage", "usage · 18.4k tok · $0.12", {
			tokens: "18.4k tok",
			cost: "$0.12",
		});
		// AUTHORITY ARRIVES LAST. Until this microstep the final message is an
		// ordinary ended reply; only the settlement may call it FINAL RESPONSE.
		add(151, "settlement", "settlement · completed · authoritative", {
			settles: "completed",
			settleRow: "m4h",
			mark: "settled",
		});
		return steps;
	}

	/* --- the failed tail -------------------------------------------------- */

	if (path === "failed") {
		add(86, "tool_partial_result", "tool_partial_result · bash 23 of 24", {
			row: row("rp-bash", "run", 3, "muted", BASH_PROGRESS_FAILING, {
				group: "bash",
			}),
		});
		// A tool_error is a TERMINAL row for its group: the call closes and loses
		// its caret. It is not, and never becomes, a settlement.
		add(92, "tool_error", "tool_error · bash 1 fail at width 41", {
			row: row("r-bash", "result", 4, "bad", BASH_FAIL, { group: "bash" }),
		});
		add(100, "retry", "retry · attempt 2", {
			row: row("rt1", "retry", 4, "warn", RETRY_NOTE),
		});
		add(120, "status", "status · awaiting child activity", {
			row: row("s4", "boot", 4, "muted", AWAIT_NOTE),
		});
		add(300, "usage", "usage · 21.7k tok · $0.15", {
			tokens: "21.7k tok",
			cost: "$0.15",
		});
		add(600, "status", "status · no child activity for 10m00s", {
			row: row("s5", "boot", 4, "warn", SILENT_NOTE),
		});
		add(902, "settlement", "settlement · failed · authoritative", {
			row: row(
				"st",
				"error",
				4,
				"bad",
				stateById("failed").failure ?? "failed",
			),
			settles: "failed",
			settleRow: "st",
			mark: "settled",
		});
		return steps;
	}

	/* --- the cancelled tail ----------------------------------------------- */

	add(80, "status", "status · cancel requested by LOOM", {
		row: row("s4", "boot", 3, "muted", CANCEL_STATUS),
	});
	add(81, "queue_change", "queue_change · queue drained", {
		row: row("q1", "queue", 3, "muted", STEER_DRAINED),
	});
	add(82, "tool_error", "tool_error · bash abandoned in flight", {
		row: row("r-bash", "result", 4, "muted", BASH_ABANDONED, {
			group: "bash",
		}),
	});
	add(84, "usage", "usage · 13.2k tok · $0.09", {
		tokens: "13.2k tok",
		cost: "$0.09",
	});
	add(86, "settlement", "settlement · cancelled · authoritative", {
		row: row(
			"st",
			"cancel",
			4,
			"muted",
			stateById("cancelled").cancel ?? "cancelled",
		),
		settles: "cancelled",
		settleRow: "st",
		mark: "settled",
	});
	return steps;
}

/** Timelines are pure and small; build each tail once. */
const TIMELINE_CACHE = new Map<PathId, readonly TimelineStep[]>();

function timelineFor(path: PathId): readonly TimelineStep[] {
	const hit = TIMELINE_CACHE.get(path);
	if (hit) return hit;
	const built = buildTimeline(path);
	TIMELINE_CACHE.set(path, built);
	return built;
}

/** Total microsteps on one tail. */
function streamSteps(path: PathId): number {
	return Math.max(1, timelineFor(path).length);
}

/**
 * The cursor CLAMPS rather than wraps. `0` resets and `End` jumps to the settled
 * step, so wrapping would only ever hide which end of the timeline the reader
 * had reached.
 */
function clampStep(step: number, total: number): number {
	const t = Math.max(1, Math.floor(total));
	const n = Math.floor(step);
	if (!Number.isFinite(n) || n < 1) return 1;
	return Math.min(t, n);
}

/** The 1-based microstep carrying a checkpoint, or 1 when the tail lacks it. */
function markStep(path: PathId, id: CheckpointId): number {
	const steps = timelineFor(path);
	const found = steps.find((s) => s.mark === id);
	return found?.n ?? 1;
}

/**
 * The step a tail OPENS on. One short of the settlement, so the demo lands
 * mid-flight with something visibly streaming instead of on a finished run.
 */
function defaultStep(path: PathId): number {
	return Math.max(1, streamSteps(path) - 1);
}

/* ---- the shared projector ---------------------------------------------- */

/** Mutable fold cell for one display row. */
interface RowCell {
	e: MockEvent;
	text: string;
	streaming: boolean;
	ended: boolean;
}

/** The visible slice of the child's stream, plus what just happened. */
interface LiveStream {
	readonly events: readonly LiveEvent[];
	readonly step: number;
	readonly total: number;
	readonly path: PathId;
	/** The production event family the current microstep delivered. */
	readonly type: ChildEventType;
	/** `message_update · summary delta 3/6`. The controller prints it verbatim. */
	readonly arrival: string;
	/** Stamp, tokens and cost as of the current microstep, never ahead of it. */
	readonly at: string;
	readonly tokens: string;
	readonly cost: string;
	readonly phase: PhaseId;
	/** The AUTHORITATIVE outcome, or undefined while the child can still act. */
	readonly outcome: Outcome | undefined;
	/** The most recent named checkpoint at or before the cursor. */
	readonly checkpoint: CheckpointId | undefined;
	/** The row the current microstep touched — what the reader should watch. */
	readonly latest: LiveEvent | undefined;
}

/**
 * THE ONLY READER OF THE TIMELINE. The Child Viewport, the collapsed Native
 * Line, the rail and the footer are handed the SAME result, so no region can be
 * one microstep ahead of another.
 *
 * The fold is strictly forward and each row's text is replaced by the FULL text
 * the microstep declares, which the builder derives from `grown()` — so text
 * inside one message can only ever grow, and freezes on `message_end`.
 */
function liveStream(path: PathId, step: number): LiveStream {
	const steps = timelineFor(path);
	const total = Math.max(1, steps.length);
	const cursor = clampStep(step, total);

	const order: string[] = [];
	const cells = new Map<string, RowCell>();
	let at = "0.0s";
	let tokens = "0 tok";
	let cost = "$0.00";
	let phase: PhaseId = "bootstrap";
	let outcome: Outcome | undefined;
	let settleRow: string | undefined;
	let checkpoint: CheckpointId | undefined;
	let arrival = "";
	let type: ChildEventType = "status";
	let touched: string | undefined;

	for (let i = 0; i < cursor; i += 1) {
		const s = steps[i] as TimelineStep;
		at = s.at;
		if (s.tokens !== undefined) tokens = s.tokens;
		if (s.cost !== undefined) cost = s.cost;
		if (s.phase !== undefined) phase = s.phase;
		if (s.mark !== undefined) checkpoint = s.mark;
		arrival = s.readout;
		type = s.type;

		const patch = s.row;
		if (patch !== undefined) {
			if (!cells.has(patch.id)) order.push(patch.id);
			cells.set(patch.id, {
				e: {
					id: patch.id,
					at: s.at,
					kind: patch.kind,
					turn: patch.turn,
					ink: patch.ink,
					...(patch.group === undefined ? {} : { group: patch.group }),
				},
				text: safeTrim(patch.text),
				streaming: patch.streaming === true,
				ended: patch.streaming !== true,
			});
			touched = patch.id;
		}
		for (const id of s.freeze ?? []) {
			const cell = cells.get(id);
			if (cell === undefined) continue;
			cell.streaming = false;
			cell.ended = true;
			touched = id;
		}
		if (s.settles !== undefined) {
			outcome = s.settles;
			settleRow = s.settleRow;
			if (s.settleRow !== undefined && cells.has(s.settleRow)) {
				touched = s.settleRow;
			}
		}
	}

	// A CALL STAYS OPEN until its own terminal row lands. A progress tick shares
	// the group on purpose and deliberately does NOT close it.
	const closed = new Set<string>();
	for (const id of order) {
		const cell = cells.get(id);
		if (cell?.e.kind === "result" && cell.e.group !== undefined) {
			closed.add(cell.e.group);
		}
	}

	const events: LiveEvent[] = order.map((id) => {
		const cell = cells.get(id) as RowCell;
		return {
			e: cell.e,
			text: cell.text,
			streaming: cell.streaming,
			ended: cell.ended,
			open:
				cell.e.kind === "tool" &&
				cell.e.group !== undefined &&
				!closed.has(cell.e.group),
			// AUTHORITY IS THE SETTLEMENT'S ALONE. No row may claim it early, and
			// no row on a failed or cancelled tail may claim a success.
			authoritative: outcome !== undefined && cell.e.id === settleRow,
		};
	});

	const latest =
		events.find((l) => l.e.id === touched) ?? events[events.length - 1];

	return {
		events,
		step: cursor,
		total,
		path,
		type,
		arrival,
		at,
		tokens,
		cost,
		phase,
		outcome,
		checkpoint,
		latest,
	};
}

/**
 * The lifecycle facts the rail and footer read, DERIVED FROM THE CURSOR rather
 * than chosen beside it. A card that says COMPLETED while the stream is still
 * provisioning the thread would be the one lie this prototype cannot afford, so
 * status, phase, settlement, final response, failure and cancellation all come
 * from where the reader actually is on the timeline.
 */
function factsFor(path: PathId, step: number): StateFacts {
	const live = liveStream(path, step);
	if (live.outcome !== undefined) return stateById(live.outcome);
	switch (live.phase) {
		case "reasoning":
			return stateById("reasoning");
		case "tool":
			return stateById("tool");
		case "steered":
			return stateById("steered");
		default:
			return stateById("bootstrap");
	}
}

/**
 * The same facts with the telemetry the CURSOR justifies. Elapsed, tokens and
 * cost are stream facts, not state constants: they advance one microstep at a
 * time and land exactly on the state's own figures at the settled step.
 */
function factsAt(path: PathId, step: number): StateFacts {
	const live = liveStream(path, step);
	return {
		...factsFor(path, step),
		elapsed: live.at,
		tokens: live.tokens,
		cost: live.cost,
	};
}

/* ---- what an event is called, shared by every region ------------------- */

/**
 * The streaming mark. It is a BLOCK ELEMENT, so `safeText` deletes it from mock
 * content and only `glyph()` can put it on screen — a child cannot fake being
 * live.
 */
const STREAM_MARK = "▍";

/**
 * Interior columns below which the viewport folds: prose keeps one line fewer
 * and a message body is clipped harder. Chosen so a forty-column terminal is
 * always narrow and eighty never is.
 */
const DETAIL_NARROW = 44;

/** True while this row is the thing the reader should watch. */
function eventLive(l: LiveEvent): boolean {
	return l.streaming || l.open;
}

/** Everything the expanded region is allowed to know. */
interface DetailCtx {
	/** The card width, for `bodyRow`. */
	readonly w: number;
	/** Interior columns available to a detail row. */
	readonly inner: number;
	/** The COLLAPSED body width, so the region can ask what the card clipped. */
	readonly bodyW: number;
	/** True where prose must fold to fewer lines. */
	readonly narrow: boolean;
	readonly f: StateFacts;
	/** The visible stream, identical to the one the collapsed card reads. */
	readonly live: LiveStream;
}

/* ---- the shared Pi-like transcript rendering ---------------------------

   ONE renderer turns the visible child stream into PLAIN PI-LIKE ROWS, in the
   same visual vocabulary the finalized child inspector already chose: a quiet
   role gutter, a bare tool call signature, a `⎿` result continuation, ordinary
   prose on a two-column indent and the streaming caret `▍`. THE CHILD VIEWPORT
   IS, BY CONSTRUCTION, A LITERAL BOTTOM SLICE OF THESE ROWS: it takes the last
   nine and never re-renders, re-groups or re-labels one of them.
   ------------------------------------------------------------------------ */

/**
 * The child's own role gutters. `▌` is a BLOCK ELEMENT and therefore reachable
 * only through `glyph()`, which mock content cannot call — an assistant block
 * bar cannot be forged by a child string.
 */
const PI_GLYPH: Readonly<Record<EventKind, string>> = {
	sent: "❯",
	boot: "·",
	msg: "▌",
	think: "✻",
	tool: "⚙",
	run: "⎿",
	result: "⎿",
	queue: "↯",
	steer: "↯",
	retry: "↺",
	reply: "▌",
	error: "✖",
	cancel: "⊘",
};

/** The assistant block bar, drawn with `glyph()` so mock text cannot fake it. */
const ASSISTANT_BAR = "▌";

/** Pi's own two-column body indent beneath a role gutter. */
const CHILD_INDENT_W = 2;

/** An empty interior row. The fixed-height viewport pads with it. */
function blankRow(): Row {
	return [seg("dim", "")];
}

/** Keep the LAST `target` rows and pad ABOVE, so content sits on the bottom. */
function padAbove(rows: readonly Row[], target: number): Row[] {
	const kept = rows.slice(-Math.max(0, target));
	const gap = Math.max(0, target - kept.length);
	return [...Array.from({ length: gap }, () => blankRow()), ...kept];
}

/** Wrapped prose lines cost fewer rows on a narrow card. */
function proseMax(ctx: DetailCtx, full: number): number {
	return ctx.narrow ? Math.max(1, full - 1) : full;
}

/** Indented body prose beneath a role gutter, with the caret while it grows. */
function proseRows(
	text: string,
	ink: Ink,
	ctx: DetailCtx,
	maxLines: number,
	live: boolean,
): Row[] {
	const w = Math.max(6, ctx.inner - CHILD_INDENT_W - 2);
	const lines = wrapPlain(text, w, Math.max(1, maxLines));
	return lines.map((ln, i) => {
		const row: Seg[] = [fill("dim", " ", CHILD_INDENT_W), seg(ink, ln)];
		if (live && i === lines.length - 1) {
			row.push(seg("dim", " "), glyph("acc", STREAM_MARK));
		}
		return row;
	});
}

/**
 * The `⎿` continuation: a tool's progress, its result or a safe terminal
 * detail. A CALL and its RESULT are never the same row, which is how the
 * transcript says "this happened because of that" without a label column.
 */
function contRows(
	text: string,
	ink: Ink,
	ctx: DetailCtx,
	maxLines: number,
	live: boolean,
): Row[] {
	const w = Math.max(6, ctx.inner - CHILD_INDENT_W - 4);
	const lines = wrapPlain(text, w, Math.max(1, maxLines));
	return lines.map((ln, i) => {
		const row: Seg[] = [
			fill("dim", " ", CHILD_INDENT_W),
			seg("dim", i === 0 ? `${PI_GLYPH.result} ` : "  "),
			seg(ink, ln),
		];
		if (live && i === lines.length - 1) {
			row.push(seg("dim", " "), glyph("acc", STREAM_MARK));
		}
		return row;
	});
}

/** `⚙ read(child-overlay-component.ts)`, with a caret while the call is open. */
function toolCallRow(l: LiveEvent, ctx: DetailCtx): Row {
	const parts = l.text.split(" · ");
	const name = safeTrim(parts[0] ?? l.text);
	const args = safeTrim(parts.slice(1).join(" · "));
	const room = Math.max(4, ctx.inner - 4 - visibleWidth(name) - (l.open ? 2 : 0));
	const row: Seg[] = [
		seg("dim", `${PI_GLYPH.tool} `),
		seg("text", clipText(name, Math.max(2, ctx.inner - 4))),
		seg("dim", `(${clipText(args, room)})`),
	];
	if (l.open) row.push(seg("dim", " "), glyph("acc", STREAM_MARK));
	return row;
}

/**
 * The head label of one assistant message. THREE STATES, and the order matters:
 * a message that is still streaming, a message that has ENDED but has not been
 * settled, and the one message an AUTHORITATIVE settlement has named. Only the
 * third may say FINAL RESPONSE, which is how the card refuses to show a final
 * answer before the settlement that makes it one.
 */
function messageHeadLabel(l: LiveEvent): string {
	if (l.authoritative) return "  FINAL RESPONSE";
	return l.ended ? "  reply" : "  streaming reply";
}

/**
 * ONE child row, rendered the way the child's own screen renders it. In
 * `compact` form a message body keeps one line; in full form it keeps up to
 * four, wrapped.
 *
 * A MESSAGE IS THREE ROW FAMILIES, exactly as Pi draws it: the `msg` head with
 * the assistant block bar, the `think` reasoning SUMMARY beneath it, and the
 * `reply` body beneath that. One `message_start` makes the head, thinking
 * deltas grow the SUMMARY, text deltas grow the body, and `message_end` freezes
 * all three at once.
 */
function piEventRows(l: LiveEvent, ctx: DetailCtx, compact: boolean): Row[] {
	const live = eventLive(l);
	const one = compact ? 1 : 0;
	switch (l.e.kind) {
		case "sent":
			return [
				[
					seg("acc", `${PI_GLYPH.sent} `),
					seg("bold", `${PARENT.agent} → ${CHILD.agent}`),
					seg("dim", "  delegation prompt"),
				],
				...proseRows(l.text, "muted", ctx, one || proseMax(ctx, 3), live),
			];
		case "boot": {
			const row: Seg[] = [
				seg("dim", `${PI_GLYPH.boot} `),
				seg("muted", clipText(l.text, Math.max(2, ctx.inner - 4))),
			];
			if (live) row.push(seg("dim", " "), glyph("acc", STREAM_MARK));
			return [row];
		}
		case "think":
			return [
				[
					seg("muted", `${PI_GLYPH.think} `),
					seg("muted", "reasoning · SUMMARY"),
				],
				...proseRows(l.text, "dim", ctx, one || proseMax(ctx, 3), live),
			];
		case "tool":
			return [toolCallRow(l, ctx)];
		case "run":
		case "result":
			// A terminal `⎿` row keeps the ink its own event carried, so a failing
			// or abandoned call is visibly not a success — and never keeps a caret.
			return contRows(l.text, l.e.ink, ctx, one || proseMax(ctx, 2), l.open);
		case "retry":
			return [
				[
					seg("warn", `${PI_GLYPH.retry} `),
					seg("warn", clipText(l.text, Math.max(2, ctx.inner - 4))),
				],
			];
		case "queue":
		case "steer":
			return [
				[
					seg("warn", `${PI_GLYPH.queue} `),
					seg("bold", `${PARENT.agent} → ${CHILD.agent}`),
					seg("dim", "  steer · queued"),
				],
				...proseRows(l.text, "warn", ctx, one || proseMax(ctx, 2), live),
			];
		case "msg": {
			const head: Seg[] = [
				glyph("acc", ASSISTANT_BAR),
				seg("text", ` ${CHILD.agent}`),
				seg(l.authoritative ? "acc" : "dim", messageHeadLabel(l)),
			];
			if (live) head.push(seg("dim", " "), glyph("acc", STREAM_MARK));
			return [head];
		}
		case "reply":
			// The body of a message whose head row already named it. Prose only — a
			// second block bar would read as a second message.
			return proseRows(l.text, "text", ctx, one || proseMax(ctx, 4), live);
		case "error":
			return [
				[
					seg("bad", `${PI_GLYPH.error} `),
					seg("text", CHILD.agent),
					seg("bad", l.authoritative ? "  FAILED" : "  failing"),
				],
				...contRows(l.text, "bad", ctx, one || proseMax(ctx, 2), live),
			];
		default:
			return [
				[
					seg("muted", `${PI_GLYPH.cancel} `),
					seg("text", CHILD.agent),
					seg("muted", l.authoritative ? "  CANCELLED" : "  cancelling"),
				],
				...contRows(l.text, "muted", ctx, one || proseMax(ctx, 2), live),
			];
	}
}

/** One rendered transcript row, tagged with the event and message it came from. */
interface TRow {
	readonly row: Row;
	readonly id: string;
	readonly kind: EventKind;
	/** The child message this row belongs to. */
	readonly turn: number;
	readonly at: string;
	/** True on the FIRST row of an event: the boundary a reader sees. */
	readonly head: boolean;
}

/**
 * THE SHARED TRANSCRIPT. The whole visible stream, top to bottom, exactly as
 * the child's own screen would print it. Nothing is summarised, counted or
 * folded here; the viewport simply takes the bottom of it.
 */
function transcriptRows(ctx: DetailCtx, compact: boolean): TRow[] {
	const out: TRow[] = [];
	for (const l of ctx.live.events) {
		const rows = piEventRows(l, ctx, compact);
		for (const [i, row] of rows.entries()) {
			out.push({
				row,
				id: l.e.id,
				kind: l.e.kind,
				turn: l.e.turn,
				at: l.e.at,
				head: i === 0,
			});
		}
	}
	return out;
}

/** The hard row ceiling and floor the expanded region renders inside. */
const REGION_ROWS_MAX = 12;
const REGION_ROWS_MIN = 7;

/**
 * THE WINDOW HEIGHT. A constant, not a budget a renderer may spend differently:
 * nine transcript rows, under one status strip, at every width, on every path,
 * at every microstep, settled or not.
 */
const VIEWPORT_ROWS = 9;

/**
 * The only row builder the expanded region uses. It owns the `detail` slot, so
 * the region cannot accidentally emit a shell row, forge a frame or wrap past
 * its cap.
 */
interface DetailSink {
	readonly rows: CardRow[];
	/** A raw content row. */
	readonly line: (content: Row) => void;
}

function detailSink(ctx: DetailCtx): DetailSink {
	const rows: CardRow[] = [];
	return {
		rows,
		line: (content) => rows.push(bodyRow(ctx.w, "detail", content)),
	};
}

/* ---- honest state phrases, shared by every region -----------------------

   These are the only sentences the card adds to `StateFacts`, and each one is
   derivable from the facts it is handed. Nothing here may claim progress,
   success, verification or safety the facts do not support.

   `aliveness` answers "can the child still act", and `retryGuidance` is the
   ONLY source of a recovery sentence — it returns `undefined` unless the
   failure CLASS is documented as recoverable, so an unclassified failure
   structurally cannot be given advice.
   ------------------------------------------------------------------------ */

/** Whether the child can still act, in words. Never a progress claim. */
function aliveness(f: StateFacts): string {
	if (f.failure) return "child no longer running";
	if (f.cancel) return "child stopped by the parent";
	if (f.final) return "child finished and released";
	return "child running";
}

/**
 * Retry guidance, and ONLY where the failure class justifies it. A confident
 * retry hint on an unknown class is how a card lies.
 */
function retryGuidance(f: StateFacts): string | undefined {
	if (!f.failure || f.retryable !== true) return undefined;
	return `${f.failureClass ?? "transient"} · re-delegation from the parent is the documented recovery`;
}

/* ==========================================================================
   5g2. THE EXPANDED REGION — CHILD VIEWPORT

   The expanded region is a window onto the bottom of the child's own screen:
   nine rows of the SHARED TRANSCRIPT, taken as a LITERAL BOTTOM SLICE, under
   one status strip that says whether the window is following a live child or
   sitting at the bottom of a settled one, and how much scrollback is above it.

   Nothing here is summarised, grouped, counted or relabelled. This is what a
   reader would see if they opened the child and pressed End.

   THE ONLY THING SETTLEMENT CHANGES HERE IS ONE HONEST WORD. While the child
   can still act the strip reads `LIVE · following bottom`; once the
   authoritative settlement has landed it reads `AT BOTTOM · child settled`.
   That is a fact about the child, and nothing else in the region moves.
   ========================================================================== */

/**
 * CHILD VIEWPORT — a window onto the bottom of the child's own screen.
 *
 * It deliberately does NOT clip on event boundaries: a real window clips
 * wherever the bottom happens to fall, so a body line may appear without its
 * head row exactly as it would on the child's own screen.
 */
function childViewport(ctx: DetailCtx): CardRow[] {
	const s = detailSink(ctx);
	const rows = transcriptRows(ctx, false).map((t) => t.row);
	const window = rows.slice(-VIEWPORT_ROWS);
	const above = rows.length - window.length;
	const strip: Seg[] = [
		seg(
			"dim",
			ctx.f.settled ? "AT BOTTOM · child settled" : "LIVE · following bottom",
		),
	];
	if (above > 0) {
		strip.push(
			seg("dim", "  "),
			seg("dim", `↑ ${above} row${above === 1 ? "" : "s"} above`),
		);
	}
	s.line(strip);
	for (const row of padAbove(window, VIEWPORT_ROWS)) s.line(row);
	return s.rows;
}

/**
 * The expanded region for this card. `renderCard` calls this once, AFTER it has
 * drawn the shared separator; nothing else in the file may ask for detail rows.
 * Every returned row is forced into the `detail` slot, so the region could not
 * emit a shell row even by accident.
 *
 * THE REGION IS A FIXED BUDGET. Twelve rows is the ceiling and seven the floor;
 * the viewport spends exactly ten — one strip and nine transcript rows — at
 * every width, on every path, at every microstep.
 */
function detailRegion(
	width: number,
	f: StateFacts,
	bodyW: number,
	live: LiveStream,
): CardRow[] {
	const w = Math.max(MIN_CARD_WIDTH, Math.floor(width));
	const inner = Math.max(6, w - 4);
	const ctx: DetailCtx = {
		w,
		inner,
		bodyW,
		narrow: inner < DETAIL_NARROW,
		f,
		live,
	};
	const rows: CardRow[] = childViewport(ctx)
		.slice(0, DETAIL_ROW_MAX)
		.map((r) => ({ slot: "detail" as Slot, row: r.row }));
	while (rows.length < DETAIL_ROW_MIN) {
		rows.push(bodyRow(w, "detail", blankRow()));
	}
	return rows;
}

/** The hard row ceiling for the expanded region, separator excluded. */
const DETAIL_ROW_MAX = REGION_ROWS_MAX;

/** The floor the region reaches, so it never reads as empty. */
const DETAIL_ROW_MIN = REGION_ROWS_MIN;

/** The row count the viewport always spends: one strip, nine rows. */
const VIEWPORT_REGION_ROWS = VIEWPORT_ROWS + 1;

/* ==========================================================================
   5i. THE TERMINAL SEAM — NATIVE SETTLE

   THE SETTLED CARD ADDS NOTHING. When the authoritative settlement arrives the
   rail's state word changes, the Native Line carries the authoritative final
   reply, safe reason or cancellation record, and the footer says
   `Ctrl+O details · Alt+I inspect child`. No row is added, no banner appears
   and no border carries a verdict, so a settled delegation costs the transcript
   exactly what a running one cost.

   THE SETTLEMENT IS THE ONLY AUTHORITY. `terminalFacts` derives the safe
   outcome vocabulary from the settlement, the child's own reported evidence and
   the already-redacted state facts — never from a guess, and never from a
   message the settlement did not name. It returns `undefined` unless the stream
   has published an authoritative outcome AND that settlement named a row
   carrying text, which is what keeps a completion CANDIDATE off the card.

   `activeTerminal` is the ONE GATE, and the card asks it once per render. While
   it returns `undefined` — which is every microstep before the settlement of
   every tail — the card is the locked running card, at every width, on every
   path, expanded or not.
   ========================================================================== */

/**
 * The safe, derived vocabulary of ONE authoritative outcome. Native Settle
 * spends only what it can print truthfully: the verdict word the rail and the
 * controller read, and the headline the Native Line already carries. `evidence`
 * and `recovery` are derived here so the honesty rules live in one place.
 */
interface TerminalFacts {
	readonly outcome: Outcome;
	/** `COMPLETED` · `FAILED` · `CANCELLED`. Upper case means authoritative. */
	readonly verdict: string;
	readonly glyph: string;
	readonly ink: Ink;
	/** The authoritative sentence the settlement published. */
	readonly headline: string;
	/** What backs the verdict: verification, failure class, or the initiator. */
	readonly evidence: string;
	/** Documented recovery, and only where the failure class justifies one. */
	readonly recovery: string | undefined;
}

/** The row the settlement itself named, or undefined while the child may act. */
function settledRow(live: LiveStream): LiveEvent | undefined {
	if (live.outcome === undefined) return undefined;
	return live.events.find((l) => l.authoritative);
}

/**
 * THE AUTHORITATIVE SENTENCE, AND NOTHING ELSE.
 *
 * For a completed run the settlement names the assistant message HEAD, so the
 * text is that message's own body. An ended-but-unsettled reply is never read,
 * which is exactly how a COMPLETION CANDIDATE is kept off the card: three
 * assistant messages end on the shared prefix and none of them can reach here.
 * For a failed or cancelled run the settlement carries its own already-redacted
 * record and that record is used verbatim.
 */
function authoritativeText(live: LiveStream): string | undefined {
	const head = settledRow(live);
	if (head === undefined) return undefined;
	if (head.e.kind !== "msg") {
		return head.text.length > 0 ? head.text : undefined;
	}
	const body = live.events.find(
		(x) => x.e.kind === "reply" && x.e.turn === head.e.turn,
	);
	return body !== undefined && body.text.length > 0 ? body.text : undefined;
}

/**
 * The child's own LAST TOOL TERMINAL: the call and what it returned, in the
 * child's words. This is evidence the child reported, not a claim the card
 * invented, and it is the only thing a completed card is allowed to call
 * verification.
 */
function verificationEvidence(
	live: LiveStream,
): { readonly call: string; readonly term: string } | undefined {
	for (let i = live.events.length - 1; i >= 0; i -= 1) {
		const l = live.events[i] as LiveEvent;
		if (l.e.kind !== "result" || l.e.group === undefined) continue;
		const call = live.events.find(
			(x) => x.e.kind === "tool" && x.e.group === l.e.group,
		);
		return { call: call?.text ?? l.e.group, term: l.text };
	}
	return undefined;
}

/**
 * THE ONE DERIVATION. It returns `undefined` unless the stream has published an
 * AUTHORITATIVE outcome and that settlement named a row carrying text, so the
 * settled card cannot be reached one microstep early even if a renderer wanted
 * it.
 */
function terminalFacts(
	f: StateFacts,
	live: LiveStream,
): TerminalFacts | undefined {
	const outcome = live.outcome;
	if (outcome === undefined) return undefined;
	const headline = authoritativeText(live);
	if (headline === undefined) return undefined;
	const v = verificationEvidence(live);

	if (outcome === "completed") {
		const term = v?.term ?? "no tool evidence recorded";
		return {
			outcome,
			verdict: "COMPLETED",
			glyph: "✓",
			ink: "ok",
			headline,
			evidence: `verified · ${v === undefined ? term : `${v.call} · ${v.term}`}`,
			recovery: undefined,
		};
	}

	if (outcome === "failed") {
		const cls = f.failureClass ?? "failure";
		return {
			outcome,
			verdict: "FAILED",
			glyph: "✕",
			ink: "bad",
			headline,
			evidence: `${cls} · ${aliveness(f)} · settled at ${f.elapsed}`,
			// NAMED ONLY WHERE THE CLASS IS DOCUMENTED AS RECOVERABLE, and phrased
			// as what the PARENT may do next — never as an action this card offers.
			recovery: retryGuidance(f),
		};
	}

	return {
		outcome,
		verdict: "CANCELLED",
		glyph: "⊘",
		ink: "muted",
		headline,
		evidence: `stopped by ${PARENT.agent}`,
		recovery: undefined,
	};
}

/**
 * THE SETTLED BODY BUDGET. Native Settle adds no row, so the settled body is
 * exactly the one Native Line the running card already had, at every width, on
 * every path.
 */
const TERMINAL_BODY_MAX = 1;

/**
 * THE ONE GATE. Every settlement-dependent decision reads this and nothing
 * else, so "the settled card appears ONLY once the authoritative settlement
 * microstep has arrived" is a property of ONE function.
 */
function activeTerminal(
	f: StateFacts,
	live: LiveStream,
): TerminalFacts | undefined {
	return terminalFacts(f, live);
}

/**
 * The card's top-edge left side. `weave_delegate`, always — settlement never
 * writes a verdict onto the frame.
 */
function cardTitle(): Row {
	return [seg("alt", TOOL)];
}

/**
 * The body rows beneath the assignment: the Native Line, before and after
 * settlement. It reads the stream, and at the settlement microstep the latest
 * row IS the settled one, so the authoritative reply, safe reason or
 * cancellation record arrives without the card growing.
 */
function terminalBody(
	f: StateFacts,
	bodyW: number,
	live: LiveStream,
): readonly Row[] {
	const rows = bodyActivity(f, bodyW, live)
		.map((a) => a.content)
		.slice(0, TERMINAL_BODY_MAX);
	return rows.length > 0 ? rows : [[seg("dim", "")]];
}

/* ==========================================================================
   5h. THE ASSIGNMENT — DIRECT TASK

   The top body row is ONE IMPERATIVE SENTENCE, in the parent's own words, in
   text ink, from the first column:

     Fix header suffix width handling and run the focused sweep.

   No provenance prefix, no acceptance clause, no scope fields, no routing
   rationale, and never a second row: the card is FOUR or FIVE rows tall at
   every width, in every state.

   THE ASSIGNMENT IS STATE-INVARIANT, BY CONSTRUCTION. A tool failure does not
   change what a child was asked to do, so `assignmentRows` takes a body width
   and nothing else. The smoke test asserts the rendered row is identical
   across every lifecycle state and every microstep.

   THE TASK SURVIVES LAST. The ladder is richest-first and ends on the bare
   `Fix suffix width`, so narrowing only ever removes words from the tail, and
   never the work itself.
   ------------------------------------------------------------------------ */

/**
 * The task, in four bounded rungs, widest first. `ASSIGNMENT` is the original
 * sentence; the rest are the same instruction with words removed, never with
 * meaning added.
 */
const TASK_MID = ASSIGNMENT_SHORT;
const TASK_TIGHT = "Fix header suffix width · sweep";
const TASK_MIN = "Fix suffix width";

/**
 * Fit the assignment row from the richest-first ladder. If not even the floor
 * fits — a card barely wider than its own frame — the task is clipped with an
 * ellipsis rather than dropped, because a delegation card with no assignment is
 * not a delegation card.
 */
function fitTask(candidates: readonly Row[], bodyW: number): readonly Row[] {
	const row = fitRow(candidates, Math.max(0, bodyW));
	if (row.length > 0) return [row];
	return [[seg("text", clipText(TASK_MIN, Math.max(2, bodyW)))]];
}

/**
 * The assignment region: exactly ONE body row, at every width, in every state.
 * `renderCard` calls it once, and nothing else in the file does.
 */
function assignmentRows(bodyW: number): readonly Row[] {
	return fitTask(
		inkLadder("text", [ASSIGNMENT, TASK_MID, TASK_TIGHT, TASK_MIN]),
		bodyW,
	).slice(0, ASSIGNMENT_ROW_MAX);
}

/** The assignment budget: exactly ONE row. */
const ASSIGNMENT_ROW_MAX = 1;

/* ==========================================================================
   5b. THE RIGHT BODY — NATIVE LINE

   Beneath the assignment there is exactly ONE activity row: a quiet Pi-like
   semantic glyph plus the single most meaningful thing the child has produced.

   IT READS THE STREAM, AND ONLY THE STREAM. "The single most meaningful thing
   the child has produced" means the LATEST VISIBLE EVENT, so this row reads the
   cursor — and never the terminal width or the rail.

   IT IS THE SETTLED ROW TOO. Native Settle adds nothing, so at the settlement
   microstep this same row carries the authoritative final reply, the safe
   reason or the cancellation record, and the card does not grow.
   ========================================================================== */

/** The body budget: exactly ONE activity row, at every width. */
const ACTIVITY_ROW_MAX = 1;

interface ActivityRow {
	/** The single body row beneath the assignment. */
	readonly content: Row;
}

function arow(content: Row): ActivityRow {
	return { content };
}

const ACTIVITY_GLYPH: Readonly<Record<string, string>> = {
	sent: "→",
	tool: "⏵",
	think: "⤷",
	boot: "◇",
	queue: "⇥",
	// `say` is a child message that is STILL BEING WRITTEN, or one that has ended
	// without an authoritative settlement behind it. `✓` is reserved for the
	// settled final response, so the collapsed row can never imply an answer the
	// settlement has not published.
	say: "▸",
	reply: "✓",
	error: "✕",
	failed: "✕",
	cancel: "⊘",
};

function activityGlyph(a: Activity): string {
	return ACTIVITY_GLYPH[a.kind] ?? "·";
}

/** The two-column lead marker: glyph plus one space, toned by the state. */
function activityLead(a: Activity, tone: Tone): Seg {
	return seg(a.ink === "text" ? toneInk(tone) : a.ink, `${activityGlyph(a)} `);
}

/**
 * Prose ink. The glyph already carries the state's tone, so the sentence itself
 * stays in ordinary text ink unless the event class demands otherwise (a steer
 * is warning, a failure is error).
 */
function activityInk(a: Activity): Ink {
	return a.ink;
}

/**
 * NATIVE LINE — one Pi-like line, nothing else.
 *
 * A delegation in a transcript is glanced at, not studied. One semantic glyph
 * and the single most meaningful sentence the child has produced is the whole
 * body. It reads exactly like Pi's own tool and reasoning lines, so a
 * delegation costs the transcript one row and no new vocabulary.
 *
 * States: bootstrap `◇` boot note · reasoning `⤷ summary · …` · tool `⏵ tool ·
 * result` · steer `⇥ 1 queued · …` · completion `✓ final` · failure `✕ safe
 * reason` · cancellation `⊘ cancel record`.
 *
 * It reads ONLY the body width, never the terminal width and never the rail, so
 * two rails that leave the same number of body columns produce the same row.
 */
function nativeLine(
	f: StateFacts,
	width: number,
	live: LiveStream,
): ActivityRow[] {
	const latest = live.latest;
	const a = markSummary(liveActivity(f, live));
	const mark = latest ? eventLive(latest) : false;
	const body = clipText(a.text, Math.max(2, width - (mark ? 4 : 2)));
	const row: Seg[] = [activityLead(a, f.tone), seg(activityInk(a), body)];
	if (mark) row.push(seg("dim", " "), glyph("acc", STREAM_MARK));
	return [arow(row)];
}

/**
 * The latest visible event, expressed in the Native Line's activity vocabulary.
 *
 * A tool RESULT is reported as its CALL plus its result, which is what makes
 * this converge exactly on `latestActivity(f)` at the final step of every
 * state: `edit · child-overlay-component.ts · 1 replacement · +6 −3` is the
 * same sentence the locked card printed before the stream existed.
 */
function liveActivity(f: StateFacts, live: LiveStream): Activity {
	const l = live.latest;
	if (!l) return latestActivity(f);
	switch (l.e.kind) {
		case "sent":
			return { kind: "sent", text: l.text, ink: "muted" };
		case "boot":
		case "retry":
			return { kind: "boot", text: l.text, ink: "muted" };
		case "think":
			return { kind: "think", text: l.text, ink: "text" };
		case "tool":
			return { kind: "tool", text: l.text, ink: "text" };
		case "msg": {
			// A message head with no body yet is not an answer. It reports the
			// message that opened, and the caret says it is still being written.
			const body = live.events.find(
				(x) => x.e.kind === "reply" && x.e.turn === l.e.turn,
			);
			if (body !== undefined && body.text.length > 0) {
				// ONLY THE SETTLED MESSAGE EARNS `✓`. Everything else is `▸`.
				return {
					kind: l.authoritative ? "reply" : "say",
					text: body.text,
					ink: "text",
				};
			}
			return { kind: "say", text: `${CHILD.agent} is writing`, ink: "muted" };
		}
		case "run":
		case "result": {
			const call = live.events.find(
				(x) => x.e.kind === "tool" && x.e.group === l.e.group,
			);
			return {
				kind: "tool",
				text: call ? `${call.text} · ${l.text}` : l.text,
				// A failing or abandoned terminal keeps its own ink: the collapsed
				// row must never paint a failure as ordinary progress.
				ink: l.e.ink === "bad" ? "bad" : "text",
			};
		}
		case "queue":
		case "steer":
			return { kind: "queue", text: l.text, ink: "warn" };
		case "reply":
			// A body delta is never authoritative on its own: authority is published
			// by the settlement and carried by the message head.
			return { kind: "say", text: l.text, ink: "text" };
		case "error":
			return { kind: "error", text: l.text, ink: "bad" };
		default:
			return { kind: "cancel", text: l.text, ink: "muted" };
	}
}

/**
 * The body activity rows, bounded. A rail can shrink the body but can never
 * change its row count, so the collapsed card's height is decided by the rail's
 * cell count alone.
 */
function bodyActivity(
	f: StateFacts,
	bodyWidth: number,
	live: LiveStream,
): readonly ActivityRow[] {
	const produced = nativeLine(f, bodyWidth, live);
	if (produced.length === 0) return [arow([seg("dim", "")])];
	return produced.slice(0, ACTIVITY_ROW_MAX);
}

/* ==========================================================================
   5c. THE LEFT RAIL — STATUS FIRST

   Its three cells, top to bottom:

     ▌RUNNING    the state, upper case behind a toned bar, loudest in the card
     shuttle     the child, second
     38s         the elapsed time, third — droppable when the body gets tight

   Ten columns, one for the bar and nine for the widest status word, so the rail
   never truncates the fact it exists to align. The state word is the ONE thing
   the authoritative settlement rewrites here.
   ========================================================================== */

/** Gutter, divider, gutter. One column of air on each side of the rule. */
function railDivider(): Seg {
	return glyph("rule", " │ ");
}

const RAIL_DIVIDER_W = 3;

/** The settled rail width: one bar column plus the widest status word. */
const RAIL_W = 10;

/** Below this body width the rail cannot pay for itself, and identity folds. */
const RAIL_MIN_BODY = 17;

/**
 * The body columns the rail must leave over its own width before it may print
 * its DROPPABLE cell. This is the rail's own drop order made mechanical: the
 * state and the child name always survive; ELAPSED is the cell that leaves —
 * which is exactly the fact the Balanced Edge footer is also carrying.
 */
const RAIL_TIGHT_SLACK = 16;

/** The rail uses at most three cells. */
const RAIL_CELL_MAX = 3;

/**
 * STATUS FIRST — the state is the loudest thing in the card.
 *
 * Optimised for the failure hunt: scanning a long transcript for the one
 * delegation that broke. `▌FAILED` sits at the top, the child name second, the
 * elapsed time third — because "failed after 15m02s" is the pair a reader wants
 * when something is wrong.
 */
function railStatusFirst(
	f: StateFacts,
	w: number,
	tight: boolean,
): readonly Row[] {
	const ink = toneInk(f.tone);
	const cells: Row[] = [
		[
			glyph(ink, "▌"),
			seg(ink, clipText(f.status.toUpperCase(), Math.max(1, w - 1))),
		],
		[seg("text", clipText(CHILD.agent, w))],
	];
	if (!tight) cells.push([seg("dim", clipText(f.elapsed, w))]);
	return cells;
}

/**
 * The rail column width for this card, and whether the droppable cell survives.
 * One function, so "what does narrowing cost" is answerable without reading the
 * renderer. It takes the width and nothing else, so expanding the card cannot
 * buy itself room by squeezing the collapsed one.
 */
function railPlan(width: number): {
	readonly tight: boolean;
	readonly railW: number;
	readonly folded: boolean;
	readonly bodyW: number;
} {
	const w = Math.max(MIN_CARD_WIDTH, Math.floor(width));
	const inner = Math.max(6, w - 4);
	const tight = inner < RAIL_W + RAIL_MIN_BODY + RAIL_TIGHT_SLACK;
	const railW = RAIL_W;
	const folded = inner < railW + RAIL_MIN_BODY;
	const bodyW = folded ? inner : Math.max(6, inner - railW - RAIL_DIVIDER_W);
	return { tight, railW, folded, bodyW };
}

/* ==========================================================================
   5f. THE SHELL — THE DELEGATION CARD

   One function draws the card. It places every row itself and asks the LOCKED
   CHILD VIEWPORT for exactly one region: the rows BELOW the interior separator,
   and only when the entry is expanded.

     row 0        `╭─ weave_delegate ── DEMO DATA ─╮`
     row 1        ▌RUNNING  │  the Direct Task assignment row
     row 2        shuttle   │  the Native Line activity row
     row 3        38s       │  (blank body cell, at widths that pay for it)
     (expanded)   the shell's interior rule
     (expanded)   the Child Viewport
     last         the Balanced Edge bottom border

   THE GEOMETRY DOES NOT MOVE AT SETTLEMENT. Collapsed height is five rows at
   ordinary and folded widths and four in the tight band where the rail drops
   its elapsed cell, running or settled, because Native Settle adds no row and
   writes no verdict onto the frame. What the settlement changes is the WORDS:
   the rail's state, the Native Line's sentence and the footer's expand verb.

   Every zipped row records its rail cell and its body cell beside the composed
   line, so the card can be checked column by column as well as byte by byte.
   ========================================================================== */

/**
 * Draw the delegation card for one path at one MICROSTEP.
 *
 * EVERY REGION READS ONE PROJECTION. `liveStream` is called once, here, and the
 * same `LiveStream` is handed to the rail, the footer, the Native Line and the
 * viewport — so no region can be one microstep ahead of another, and the rail's
 * clock, the footer's telemetry and the viewport's newest row cannot disagree.
 */
function renderCard(
	path: PathId,
	width: number,
	expanded: boolean,
	step: number,
): CardRow[] {
	const w = Math.max(MIN_CARD_WIDTH, Math.floor(width));
	const inner = Math.max(6, w - 4);
	const plan = railPlan(w);
	const live = liveStream(path, step);
	const f = factsAt(path, step);
	const rows: CardRow[] = [];

	rows.push(edgeTop(w, cardTitle(), demoTagFor(w, "")));

	if (plan.folded) {
		// FOLDED RAIL. The terminal cannot pay for a rail column, so identity folds
		// into one body row, and the card is five rows tall.
		rows.push(bodyRow(w, "identity", identityRow(f)));
		for (const row of assignmentRows(inner)) {
			rows.push({ slot: "task", row: cardBody(w, row), body: row });
		}
		for (const [i, content] of terminalBody(f, inner, live).entries()) {
			rows.push({
				slot: i === 0 ? "activity" : "activity-detail",
				row: cardBody(w, clipRow(content, inner)),
				body: clipRow(content, inner),
			});
		}
		if (expanded) {
			rows.push(ruleRow(w), ...detailRegion(w, f, inner, live));
		}
		rows.push(...cardFooter(w, f, expanded));
		return rows;
	}

	const cells = railStatusFirst(f, plan.railW, plan.tight).slice(
		0,
		RAIL_CELL_MAX,
	);
	// Body column, top to bottom: the assignment row, then the Native Line — the
	// same row before and after the authoritative settlement.
	const taskCells = assignmentRows(plan.bodyW);
	const bodyCells: Row[] = [...taskCells, ...terminalBody(f, plan.bodyW, live)];
	const height = Math.max(cells.length, bodyCells.length);

	for (let i = 0; i < height; i += 1) {
		const railCell = cells[i] ?? [];
		const bodyCell = bodyCells[i] ?? [];
		const slot: Slot =
			i < taskCells.length
				? "task"
				: i === taskCells.length
					? "activity"
					: "activity-detail";
		const clippedBody = clipRow(bodyCell, plan.bodyW);
		rows.push({
			slot,
			row: cardBody(w, [
				...padRow(railCell, plan.railW),
				railDivider(),
				...clippedBody,
			]),
			rail: railCell,
			body: clippedBody,
		});
	}

	// THE SHELL OWNS THE SEPARATOR. It is drawn here, once, so the expanded region
	// can neither skip the rule nor draw a second one.
	if (expanded) {
		rows.push(ruleRow(w), ...detailRegion(w, f, plan.bodyW, live));
	}
	rows.push(...cardFooter(w, f, expanded));
	return rows;
}

/* ==========================================================================
   6. DEMO STORE — the mutable state the live entry reads at render time
   ========================================================================== */

class DemoStore {
	/** Which tail of the ONE shared timeline is active. */
	private pathId: PathId = "completed";
	/**
	 * THE MICROSTEP CURSOR. It is a demo control and nothing else — no timer, no
	 * interval and no background work ever advances it. One `Space` moves it by
	 * exactly one. The tail opens one microstep short of its settlement, so the
	 * card lands mid-flight with something visibly streaming.
	 */
	private streamStep = defaultStep("completed");
	/** Demo-only expansion override, OR-ed with Pi's own expanded flag. */
	private expandedDemo = false;
	private readonly listeners = new Set<() => void>();

	get path(): PathId {
		return this.pathId;
	}

	/**
	 * Index of the DERIVED lifecycle facts, for cache keys and the status chip.
	 * Looked up by id: `currentState` carries the cursor's own telemetry, so it is
	 * a fresh object and is never identical to the `STATES` entry it came from.
	 */
	get stateIndex(): number {
		const id = this.currentState.id;
		return Math.max(
			0,
			STATES.findIndex((s) => s.id === id),
		);
	}

	get stateNumber(): number {
		return this.stateIndex + 1;
	}

	/**
	 * Whether the cursor has reached the AUTHORITATIVE settlement. The stream
	 * controller prints it, because "is this the settled card" is the one thing a
	 * reader must never have to guess.
	 */
	get settled(): boolean {
		return this.stream.outcome !== undefined;
	}

	/** The lifecycle facts the cursor justifies — never a state chosen beside it. */
	get currentState(): StateFacts {
		return factsAt(this.pathId, this.step);
	}

	/** Total microsteps on the active tail. */
	get streamTotal(): number {
		return streamSteps(this.pathId);
	}

	/** The cursor, always clamped into `1..streamTotal`. */
	get step(): number {
		return clampStep(this.streamStep, this.streamTotal);
	}

	/** The visible stream at the current cursor, for the controller readout. */
	get stream(): LiveStream {
		return liveStream(this.pathId, this.step);
	}

	get expanded(): boolean {
		return this.expandedDemo;
	}

	/** Move the microstep cursor. CLAMPS: `0` and `End` are the two jumps. */
	setStep(step: number): void {
		const next = clampStep(step, this.streamTotal);
		if (next === this.streamStep) return;
		this.streamStep = next;
		this.emit();
	}

	stepStream(delta: number): void {
		this.setStep(this.step + delta);
	}

	/** `0` — back to the first microstep of the active tail. */
	resetStream(): void {
		this.setStep(1);
	}

	/** `End` / `g` — the settled microstep of the active tail. */
	latestStream(): void {
		this.setStep(this.streamTotal);
	}

	/**
	 * Jump to a NAMED CHECKPOINT. A checkpoint that names a tail switches to it
	 * AND lands on its settlement, so a path switch can never leave the cursor at
	 * a position that means something else on the new tail.
	 */
	setCheckpoint(index: number): void {
		const cp = CHECKPOINTS[wrapIndex(index, CHECKPOINTS.length)] as Checkpoint;
		const path = cp.path ?? this.pathId;
		const step = markStep(path, cp.id);
		if (path === this.pathId && step === this.streamStep) return;
		this.pathId = path;
		this.streamStep = step;
		this.emit();
	}

	toggleExpanded(): void {
		this.expandedDemo = !this.expandedDemo;
		this.emit();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

function wrapIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return ((index % length) + length) % length;
}

const store = new DemoStore();

/* ==========================================================================
   7. THE LIVE INLINE ENTRY COMPONENT

   This is the FINAL component. It is returned by the ONE registered entry
   renderer and reads the demo store at RENDER time, which is what lets the
   stream controller repaint the already-appended transcript entry instead of
   appending a new one per step.
   ========================================================================== */

/** Live instances, so a state change can invalidate their caches. */
const liveEntries = new Set<DelegateEntry>();

class DelegateEntry implements Component {
	private cache:
		| { readonly key: string; readonly lines: readonly string[] }
		| undefined;

	constructor(
		private readonly paint: Paint,
		/** Pi's own expanded flag (Ctrl+O), captured at rebuild time. */
		private readonly piExpanded: boolean,
	) {
		liveEntries.add(this);
		// Bounded registry: this prototype rebuilds rarely, but never grow.
		if (liveEntries.size > 16) {
			const oldest = liveEntries.values().next().value;
			if (oldest && oldest !== this) liveEntries.delete(oldest);
		}
	}

	render(width: number): string[] {
		const w = Math.max(12, Math.floor(width));
		const path = store.path;
		const step = store.step;
		const expanded = this.piExpanded || store.expanded;
		const key = `${path}:${step}:${expanded}:${w}`;
		if (this.cache && this.cache.key === key) return [...this.cache.lines];

		// The DEMO banner sits OUTSIDE the card, above the top edge, so the card
		// itself keeps exactly one border and the prototype label never reads as
		// part of the component. It names the tail, the microstep and whether the
		// authoritative settlement has landed.
		const live = store.settled ? " · SETTLED" : " · running";
		const banner: Row = [
			seg("dim", `${DEMO_MARK} · final weave_delegate`),
			seg("dim", ` · ${path} · step ${step}/${store.streamTotal}${live}`),
			seg("dim", expanded ? " · Ctrl+O to collapse" : " · Ctrl+O to see it"),
		];
		const card = renderCard(path, w, expanded, step).map((r) => r.row);
		const lines = [banner, ...card].map((row) => emit(row, w, this.paint));
		this.cache = { key, lines };
		return [...lines];
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

/* ==========================================================================
   8. THE STREAM CONTROLLER — a small NATIVE Pi overlay, anchored top-right

   It is a READOUT AND A TRANSPORT, not a chooser. There is nothing left to
   choose: it prints where the reader is on the shared timeline, what event just
   arrived, what lifecycle state that justifies, and which keys move the stream.
   It never prints a verdict, a design alternative or a selection key.
   ========================================================================== */

interface ControllerHost {
	readonly tui: TUI;
	readonly theme: Theme;
	readonly close: () => void;
}

const CONTROLLER_TITLE = "WEAVE_DELEGATE · FINAL PROTOTYPE";

/** The checkpoint the cursor currently sits on or after, in plain words. */
function checkpointLabel(live: LiveStream): string {
	if (live.checkpoint === undefined) return "before the first checkpoint";
	const cp = CHECKPOINTS.find(
		(c) =>
			c.id === live.checkpoint &&
			(c.path === undefined || c.path === live.path),
	);
	return cp?.label ?? live.checkpoint;
}

/** `COMPLETED tail · 52 steps`. Always names the path the reader is on. */
function pathLabel(live: LiveStream): string {
	return `${live.path.toUpperCase()} tail · ${live.total} steps`;
}

/** `settled · completed`, or the honest "still running" while it is not. */
function outcomeLabel(live: LiveStream): string {
	return live.outcome === undefined
		? "not settled · child may still act"
		: `settled · ${live.outcome} · authoritative`;
}

function controllerRows(expandedNow: boolean): Row[] {
	const state = store.currentState;
	const live = store.stream;
	const rows: Row[] = [];

	// WHERE THE READER IS.
	rows.push([seg("dim", "path      "), seg(toneInk(state.tone), pathLabel(live))]);
	rows.push([
		seg("dim", "step      "),
		seg("acc", `${live.step}/${live.total}`),
		seg("dim", "  "),
		seg("text", checkpointLabel(live)),
	]);
	rows.push([
		seg("dim", "event     "),
		seg("text", live.arrival.length > 0 ? live.arrival : "nothing yet"),
	]);
	rows.push([
		seg("dim", "state     "),
		seg(toneInk(state.tone), state.label),
	]);
	rows.push([seg("dim", "settle    "), seg("dim", outcomeLabel(live))]);
	rows.push([seg("dim", "")]);

	// HOW THE READER MOVES. Space first, because it is the primary key.
	rows.push([seg("acc", "Space"), seg("dim", "  advance ONE microstep")]);
	rows.push([seg("dim", "⇧Space or [ back · ] u next")]);
	rows.push([seg("dim", "0 reset · End or g settle")]);
	rows.push([seg("dim", "b accepted  r summary  t tools")]);
	rows.push([seg("dim", "s steered   c f x switch the tail")]);
	rows.push([
		seg("dim", "e  expanded: "),
		seg(expandedNow ? "acc" : "dim", expandedNow ? "on" : "off"),
		seg("dim", "  (Ctrl+O too)"),
	]);
	rows.push([seg("dim", "Esc  close · the entry stays")]);
	rows.push([seg("dim", "")]);

	// WHAT THE READER IS LOOKING AT.
	rows.push([seg("muted", "One press delivers ONE production")]);
	rows.push([seg("muted", "event or ONE text delta — nothing")]);
	rows.push([seg("muted", "is on a timer.")]);
	rows.push([seg("dim", "")]);
	rows.push([seg("muted", "Native Settle: the settlement moves")]);
	rows.push([seg("muted", "the status rail, the native line and")]);
	rows.push([seg("muted", "the footer — and adds no row.")]);
	rows.push([seg("muted", "Alt+I is printed and NEVER bound.")]);
	rows.push([seg("muted", "Ctrl+O is Pi's own real binding.")]);
	return rows;
}

class StreamController implements Component {
	private cache:
		| { readonly key: string; readonly lines: readonly string[] }
		| undefined;

	constructor(private readonly host: ControllerHost) {}

	/**
	 * EVERY KEY HERE IS OVERLAY-LOCAL. The extension registers no keybinding at
	 * all, so none of these is a global Pi shortcut; they are read only while the
	 * controller overlay has focus, and `Esc` closes the controller and nothing
	 * else. There is NO SELECTION KEY: `←`, `→` and the digits `1`–`5` fall
	 * through to the checkpoint lookup, match nothing and do nothing.
	 *
	 * `⇧Space` is matched before `Space`, because a terminal without the Kitty
	 * protocol reports both as a bare space and the back key must not silently
	 * become a second next key.
	 */
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.host.close();
			return;
		}
		if (matchesKey(data, Key.shift("space"))) store.stepStream(-1);
		else if (matchesKey(data, Key.space)) store.stepStream(1);
		else if (data === "[") store.stepStream(-1);
		else if (data === "]" || data === "u") store.stepStream(1);
		else if (data === "0") store.resetStream();
		else if (matchesKey(data, Key.end) || data === "g") store.latestStream();
		else if (data === "e") store.toggleExpanded();
		else {
			const direct = CHECKPOINTS.findIndex((c) => c.key === data);
			if (direct >= 0) store.setCheckpoint(direct);
		}
		this.invalidate();
		this.host.tui.requestRender();
	}

	render(width: number): string[] {
		const w = Math.max(20, Math.floor(width));
		const key = `${store.path}:${store.step}:${store.expanded}:${w}`;
		if (this.cache && this.cache.key === key) return [...this.cache.lines];
		const paint = makePaint(this.host.theme);
		const inner = Math.max(6, w - 4);
		const lines: string[] = [];
		lines.push(
			emit(cardEdge(w, true, [seg("acc", CONTROLLER_TITLE)], []), w, paint),
		);
		for (const row of controllerRows(store.expanded)) {
			lines.push(emit(cardBody(w, clipRow(row, inner)), w, paint));
		}
		lines.push(
			emit(
				cardEdge(
					w,
					false,
					[seg("dim", DEMO_MARK)],
					[seg("dim", "native settle")],
				),
				w,
				paint,
			),
		);
		this.cache = { key, lines };
		return [...lines];
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

/* ==========================================================================
   9. EXTENSION WIRING
   ========================================================================== */

const ENTRY_TYPE = "weave-delegate-tool-grilling";
const STATUS_ID = "weave-delegate-grilling";

interface EntryData {
	readonly demo: true;
	readonly note: string;
}

/** Counters the noninteractive smoke test asserts on. */
const wiring = {
	entryRenderers: 0,
	appendedEntries: 0,
	messagesSent: 0,
	controllerOpens: 0,
};

let controllerOpen = false;
/** Set while the controller is open, so `/grilling-clear` can close it. */
let closeController: (() => void) | undefined;

/** `DEMO DATA · final weave_delegate · <path> · step N/M · <state>`. */
function statusText(): string {
	return `${DEMO_MARK} · final weave_delegate · ${store.path} · step ${store.step}/${store.streamTotal} · ${store.currentState.label}`;
}

function updateStatus(ui: ExtensionUIContext): void {
	ui.setStatus(STATUS_ID, statusText());
}

function clearDemo(ui: ExtensionUIContext): void {
	ui.setStatus(STATUS_ID, undefined);
	closeController?.();
}

/**
 * Repaint the ALREADY-APPENDED entry. This is the workaround the brief asks
 * for: invalidate the live component caches and ask the TUI to redraw. No new
 * transcript entry is created, so `wiring.appendedEntries` stays at 1 forever.
 */
function repaintEntry(tui: TUI): void {
	for (const entry of liveEntries) entry.invalidate();
	tui.requestRender();
}

async function openController(ui: ExtensionUIContext): Promise<void> {
	if (controllerOpen) return;
	controllerOpen = true;
	wiring.controllerOpens += 1;
	try {
		await ui.custom<null>(
			(tui, theme, _keybindings, done) => {
				closeController = () => done(null);
				const overlay = new StreamController({
					tui,
					theme,
					close: () => done(null),
				});
				const unsubscribe = store.subscribe(() => {
					updateStatus(ui);
					overlay.invalidate();
					repaintEntry(tui);
				});
				const disposable = Object.assign(overlay, {
					dispose: () => unsubscribe(),
				});
				tui.requestRender();
				return disposable;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "top-right",
					// The title is 32 columns and `cardEdge` keeps corners, gutters and a
					// rule column around it, so 40 is the narrowest untruncated frame. 56
					// leaves the controller's own readout rows a little air.
					width: 56,
					minWidth: 36,
					maxHeight: "70%",
					margin: { top: 1, right: 2 },
					// Hide rather than corrupt the screen on tiny terminals.
					visible: (termWidth: number, termHeight: number) =>
						termWidth >= 64 && termHeight >= 20,
				},
			},
		);
	} finally {
		controllerOpen = false;
		closeController = undefined;
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerEntryRenderer<EntryData>(
		ENTRY_TYPE,
		(_entry, { expanded }, theme) => {
			return new DelegateEntry(makePaint(theme), expanded);
		},
	);
	wiring.entryRenderers += 1;

	// NO ARGUMENTS. There is nothing to select, so the command ignores whatever
	// follows it and simply reopens the readout.
	pi.registerCommand("grilling", {
		description:
			"Open the final weave_delegate card stream controller (demo data)",
		handler: async (_args, ctx) => {
			updateStatus(ctx.ui);
			await openController(ctx.ui);
		},
	});

	pi.registerCommand("grilling-clear", {
		description:
			"Clear the weave_delegate demo status and close the stream controller",
		handler: async (_args, ctx) => {
			clearDemo(ctx.ui);
			ctx.ui.notify(
				"Stream controller and status cleared. The inline demo entry stays in the transcript; reopen the controller with /grilling.",
				"info",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (wiring.appendedEntries === 0) {
			pi.appendEntry<EntryData>(ENTRY_TYPE, {
				demo: true,
				note: "DEMO DATA — inline weave_delegate tool component prototype. TUI only; never sent to the model.",
			});
			wiring.appendedEntries += 1;
		}
		updateStatus(ctx.ui);
		openController(ctx.ui).catch(() => {
			ctx.ui.notify(
				"Stream controller failed to open. Try /grilling.",
				"error",
			);
		});
	});
}

/** Exported for the noninteractive smoke test; unused by pi at runtime. */
/** Exported for the noninteractive smoke test; unused by pi at runtime. */
export const __prototype = {
	// the terminal seam
	TERMINAL_BODY_MAX,
	terminalFacts,
	activeTerminal,
	terminalBody,
	cardTitle,
	settledRow,
	authoritativeText,
	verificationEvidence,
	aliveness,
	retryGuidance,
	// mock facts
	STATES,
	TOOL,
	PARENT,
	CHILD,
	ASSIGNMENT,
	ASSIGNMENT_SHORT,
	ACTION,
	DEMO_MARK,
	ENTRY_TYPE,
	STATUS_ID,
	INSPECT_HINT,
	INSPECT_HINT_MID,
	INSPECT_HINT_MIN,
	EXPAND_KEY,
	expandVerb,
	expandHint,
	// width-safe primitives
	safeText,
	safeTrim,
	truncatePlain,
	seg,
	glyph,
	fill,
	emit,
	clipRow,
	padRow,
	rowWidth,
	wrapPlain,
	clipText,
	makePaint,
	plainPaint,
	toneInk,
	latestActivity,
	markSummary,
	toolPhrase,
	// the frame and the footer
	MIN_CARD_WIDTH,
	demoTagFor,
	cardEdge,
	cardBody,
	edgeTop,
	edgeBottom,
	bodyRow,
	ruleRow,
	fitRow,
	inkLadder,
	actionLadder,
	runDescriptor,
	teleLadderFull,
	composeEdge,
	cardFooter,
	identityRow,
	runParts,
	// the assignment
	ASSIGNMENT_ROW_MAX,
	TASK_MID,
	TASK_TIGHT,
	TASK_MIN,
	fitTask,
	assignmentRows,
	// the expanded region
	detailRegion,
	detailSink,
	childViewport,
	piEventRows,
	transcriptRows,
	toolCallRow,
	proseRows,
	contRows,
	proseMax,
	blankRow,
	padAbove,
	messageHeadLabel,
	PI_GLYPH,
	ASSISTANT_BAR,
	CHILD_INDENT_W,
	REGION_ROWS_MAX,
	REGION_ROWS_MIN,
	VIEWPORT_ROWS,
	VIEWPORT_REGION_ROWS,
	DETAIL_NARROW,
	DETAIL_ROW_MAX,
	DETAIL_ROW_MIN,
	// the shared stream
	buildTimeline,
	timelineFor,
	streamSteps,
	defaultStep,
	clampStep,
	markStep,
	stamp,
	grown,
	stateById,
	factsFor,
	factsAt,
	PATH_IDS,
	CHECKPOINTS,
	liveStream,
	liveActivity,
	chunkWords,
	eventLive,
	STREAM_MARK,
	SENT_NOTE,
	BOOT_NOTE,
	SUMMARY_TEXT,
	SUMMARY_CHUNKS,
	M1_TEXT,
	M2_TEXT,
	M3_TEXT,
	FINAL_CHUNKS,
	READ_CALL,
	READ_PROGRESS,
	READ_RESULT,
	EDIT_CALL,
	EDIT_RESULT,
	STEER_TEXT,
	STEER_QUEUED,
	STEER_DRAINED,
	STEER_STATUS,
	BASH_CALL,
	BASH_PROGRESS,
	BASH_PASS,
	BASH_FAIL,
	BASH_ABANDONED,
	RETRY_NOTE,
	// the native line and the rail
	ACTIVITY_GLYPH,
	ACTIVITY_ROW_MAX,
	activityGlyph,
	activityLead,
	activityInk,
	nativeLine,
	bodyActivity,
	railPlan,
	railDivider,
	railStatusFirst,
	RAIL_DIVIDER_W,
	RAIL_MIN_BODY,
	RAIL_TIGHT_SLACK,
	RAIL_CELL_MAX,
	RAIL_W,
	// the card, the entry and the controller
	renderCard,
	DemoStore,
	DelegateEntry,
	StreamController,
	CONTROLLER_TITLE,
	controllerRows,
	checkpointLabel,
	pathLabel,
	outcomeLabel,
	liveEntries,
	store,
	wiring,
	statusText,
	updateStatus,
	clearDemo,
	repaintEntry,
	openController,
	wrapIndex,
};

export type {
	ActivityRow,
	TerminalFacts,
	DetailCtx,
	DetailSink,
	ChildEventType,
	EventKind,
	PathId,
	Outcome,
	PhaseId,
	CheckpointId,
	Checkpoint,
	TimelineStep,
	RowPatch,
	MockEvent,
	LiveEvent,
	LiveStream,
	TRow,
	CardRow,
	Ink,
	Row,
	Seg,
	Slot,
	StateFacts,
};
