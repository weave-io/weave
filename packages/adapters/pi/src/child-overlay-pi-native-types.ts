import type { ChildOverlayEntry } from "./child-overlay-types.js";
import type { PiChildProviderError } from "./child-provider-error.js";
import type { PiChildTranscriptEntry } from "./child-transcript.js";

/** One rendered entry's row span, in the identity space the viewport anchors on. */
export interface OverlayPiNativeSpan {
  readonly entryId: string;
  readonly rows: number;
}

/** The transcript pane, painted and plain, with its row → entry map. */
export interface OverlayPiNativePane {
  readonly painted: readonly string[];
  readonly plain: readonly string[];
  readonly spans: readonly OverlayPiNativeSpan[];
  /** Rows from the mounted-only reasoning projector, never indexed. */
  readonly transientLines?: readonly string[];
}

/**
 * Everything the pane may print about a child, and nothing else.
 *
 * There is no child id, no thread id, no session path and no descriptor here:
 * the pane names the two agents in a delegation and prints the reducer's own
 * bounded facts.
 */
export interface OverlayPiNativeInput {
  readonly entries: readonly PiChildTranscriptEntry[];
  /** What the header calls this child. Never an id. */
  readonly childName: string;
  /** The dispatching agent, when an authoritative source named one. */
  readonly parentName?: string;
  /** Current mounted-only reasoning rows; never transcript or search data. */
  readonly liveReasoningRows?: readonly string[];
  /**
   * The child has settled. A settled pane is frozen: the streaming caret is
   * gone and the newest assistant message is the final response, because
   * settlement is the only completion authority the overlay has.
   */
  readonly settled: boolean;
}

/**
 * The pane's facts plus the two things only the whole view knows: the run's
 * classified terminal failure, and the bounded overlay window that still names
 * the kinds when the reducer has produced nothing drawable yet.
 */
export interface OverlayTranscriptInput extends OverlayPiNativeInput {
  /** Latest classified provider failure for the RUN, already sanitized. */
  readonly terminalError?: PiChildProviderError;
  /** The bounded overlay window, used only when the pane renders nothing. */
  readonly windowEntries: readonly ChildOverlayEntry[];
  /** True when an assistant message already carries the classified failure. */
  readonly terminalErrorStated: boolean;
}

/** Painted transcript rows plus the per-entry row spans that produced them. */
export interface OverlayTranscriptRender {
  readonly lines: readonly string[];
  readonly spans: readonly OverlayPiNativeSpan[];
  /** Transient prefix rows, excluded from spans and search. */
  readonly transientLines: readonly string[];
  /**
   * The ANSI-free text of those same rows, per entry: the search index the
   * controller matches queries against. It is produced here because only the
   * render knows what actually fit on screen.
   */
  readonly searchIndex: ReadonlyMap<string, string>;
}
