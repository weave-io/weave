/**
 * Colour for the Weave UI surfaces, and nothing else.
 *
 * This module is one half of a deliberate split. It knows which theme token
 * every named ink resolves to; it does not know how wide anything is, and it
 * never cuts, pads or measures a string. All of that lives in `ui-rows.ts`
 * and `render-width.ts`.
 *
 * The split is what makes {@link plainPaint} exact: because a paint only ever
 * wraps a string, an ANSI-free paint produces byte-identical geometry to a
 * themed one. A test can therefore assert on plain text and on exact column
 * counts at the same time, and the assertion still describes what a real
 * terminal will show.
 *
 * Every optional theme capability has one documented degradation, applied
 * here once rather than at each call site.
 *
 * See `docs/specs/33-spec-pi-adapter/33-weave-ui-design.md` §3.
 */

import type { PiUiThemePort } from "./types.js";

/**
 * The complete ink vocabulary of both Weave surfaces.
 *
 * A renderer names an ink, never a theme token, so the mapping from role to
 * colour is stated once and a surface cannot quietly invent a new one.
 */
export type Ink =
  /** Ordinary foreground prose. */
  | "text"
  /** The accent: live state, the selected thing, the current match. */
  | "acc"
  /** Alternate identity ink for badges and labels. */
  | "alt"
  /** The one high-contrast outer boundary. Never an inner separator. */
  | "frame"
  /** Recessive text that may be lost first. */
  | "dim"
  /** Present but secondary text. */
  | "muted"
  /** Success. */
  | "ok"
  /** Warning. */
  | "warn"
  /** Failure. */
  | "bad"
  /** Inner separators and panel edges. */
  | "rule"
  /** Reasoning summaries. Never raw chain-of-thought. */
  | "think"
  /** A search match inside otherwise ordinary text. */
  | "match"
  /** Emphasis without a colour change. */
  | "bold"
  /** Inverse video: badges and alert pairs only. */
  | "inv";

/**
 * The semantic state of a thing being described, independent of its ink.
 *
 * Facts carry a tone; renderers turn a tone into an ink with
 * {@link toneInk}. Keeping the two apart means a status word, a bar and a
 * glyph derived from the same fact can never disagree about colour.
 */
export type Tone = "run" | "ok" | "warn" | "bad" | "mute";

/** One function per ink. The only thing in the UI layer that emits ANSI. */
export type Paint = Readonly<Record<Ink, (text: string) => string>>;

/**
 * Binds the ink vocabulary to a host theme.
 *
 * Degradations, all of them structural rather than remembered:
 *
 * - `inv` uses `theme.inverse` when the host has it and `theme.bold`
 *   otherwise, so an inverse badge stays legible on a stand-in port.
 *
 * `match` needs no degradation here. `searchMatchText` is one of Pi's two
 * optional theme *colours*, and Pi degrades it inside the host: a theme that
 * does not define it resolves the token to `colors.text`. So the token is
 * passed unconditionally to `fg`, and a stand-in port satisfies `match` with
 * the same single `fg` method every other ink already needs.
 *
 * Nothing here measures or cuts text.
 */
export function makePaint(theme: PiUiThemePort): Paint {
  const inverse = theme.inverse?.bind(theme);
  const bold = (text: string): string => theme.bold(text);
  return Object.freeze({
    text: (text) => theme.fg("text", text),
    acc: (text) => theme.fg("accent", text),
    alt: (text) => theme.fg("customMessageLabel", text),
    frame: (text) => theme.fg("borderAccent", text),
    dim: (text) => theme.fg("dim", text),
    muted: (text) => theme.fg("muted", text),
    ok: (text) => theme.fg("success", text),
    warn: (text) => theme.fg("warning", text),
    bad: (text) => theme.fg("error", text),
    rule: (text) => theme.fg("borderMuted", text),
    think: (text) => theme.fg("thinkingText", text),
    match: (text) => theme.fg("searchMatchText", text),
    bold,
    inv: (text) => (inverse ? inverse(text) : bold(text)),
  });
}

/**
 * The ANSI-free twin.
 *
 * Identity for every ink, so a rendered surface is exactly what a themed
 * render would be with the escapes removed. Tests use it to assert on plain
 * text; the search rail uses it to build its match list, so no byte of
 * transcript colour can be mistaken for content.
 */
export function plainPaint(): Paint {
  const identity = (text: string): string => text;
  return Object.freeze({
    text: identity,
    acc: identity,
    alt: identity,
    frame: identity,
    dim: identity,
    muted: identity,
    ok: identity,
    warn: identity,
    bad: identity,
    rule: identity,
    think: identity,
    match: identity,
    bold: identity,
    inv: identity,
  });
}

/**
 * The single tone-to-ink mapping.
 *
 * `mute` deliberately resolves to `muted` rather than `dim`: a muted state is
 * still a stated state, and `dim` is reserved for text the layout is willing
 * to lose.
 */
export function toneInk(tone: Tone): Ink {
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

/** Paints `text` in the ink that `tone` maps to. */
export function paintTone(paint: Paint, tone: Tone, text: string): string {
  return paint[toneInk(tone)](text);
}
