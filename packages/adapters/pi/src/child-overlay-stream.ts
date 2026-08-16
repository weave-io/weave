/**
 * The one live-event pipeline behind the mounted child overlay.
 *
 * Freezing the reducer is not enough. An event can still arrive for a child
 * the reader is no longer looking at, for a generation that has already been
 * replaced, or after the focused child settled — and each of those, applied,
 * would mutate a view the reader is entitled to read as final. Every guard
 * therefore lives in this one module, in front of the single
 * `applyLiveEvent` call, rather than being spread across the host callback.
 *
 * Layer position: it depends on `child-overlay-controller.js` and the leaf
 * timer/coalescer modules, and nothing depends on it except the extension
 * wiring and the facade.
 */

import { Result } from "neverthrow";
import type { ChildOverlayController } from "./child-overlay-controller.js";
import type { TimerPort } from "./child-timer.js";
import { UiUpdateCoalescer } from "./ui-update-coalescer.js";

/**
 * The shortest interval between two ordinary overlay repaints.
 *
 * The overlay paints a whole screen, so it repaints on a slightly tighter
 * rhythm than the delegation card's 100 ms card frame but still far below the
 * rate a streaming child produces deltas at.
 */
export const CHILD_OVERLAY_REPAINT_INTERVAL_MS = 50;

/**
 * Repaints one uninterrupted burst may cost, however many events it carries.
 *
 * A burst is bounded by the coalescer, not by its own length: the first event
 * paints immediately, every later event inside the open refresh window is
 * folded into one trailing frame when the window closes. Five thousand deltas
 * inside one window therefore cost exactly the same two repaints as two
 * deltas do.
 */
export const CHILD_OVERLAY_BURST_REPAINT_CEILING = 2;

/** Why one live event never reached the overlay. */
export type ChildOverlayLiveEventDrop =
  | "stream-disposed"
  | "stale-generation"
  | "overlay-closed"
  | "unfocused-child"
  | "settled";

export type ChildOverlayLiveEventOutcome =
  | { readonly kind: "applied" }
  | { readonly kind: "dropped"; readonly reason: ChildOverlayLiveEventDrop };

/** What the mounted pane exposes to a repaint request. */
export interface ChildOverlayRepaintPort {
  invalidate(): void;
  requestRender(): void;
}

export interface ChildOverlayLiveStreamConfig {
  readonly controller: ChildOverlayController;
  readonly repaint: ChildOverlayRepaintPort;
  readonly timer: TimerPort;
  /** Generation that owns this stream. */
  readonly generationId: string;
  /** The host's generation right now; a change means this stream is stale. */
  readonly currentGenerationId: () => string | undefined;
  /**
   * Live thread id for a child id, or `undefined` once that child is no longer
   * live. Absent in tests that drive the focus check by child id alone.
   */
  readonly resolveLiveThreadId?: (childId: string) => string | undefined;
  readonly intervalMs?: number;
}

/**
 * The single live-event pipeline behind the mounted overlay.
 *
 * Repaints are coalesced through the injected {@link TimerPort}: this class
 * never calls `setTimeout`. Settlement bypasses the window entirely and
 * publishes exactly once, so the last frame a reader sees is always the
 * settled one and a later burst can never repaint over it.
 */
export class ChildOverlayLiveStream {
  private readonly controller: ChildOverlayController;
  private readonly repaint: ChildOverlayRepaintPort;
  private readonly generationId: string;
  private readonly currentGenerationId: () => string | undefined;
  private readonly resolveLiveThreadId:
    | ((childId: string) => string | undefined)
    | undefined;
  private readonly coalescer: UiUpdateCoalescer;
  /**
   * The focused child whose final frame has already been published.
   *
   * Settlement freezes one child, not the stream: the reader may open another
   * live child in the same generation, and that child's events must still
   * paint. A newly focused child that is itself already settled is caught by
   * the status check instead.
   */
  private settledChildId: string | undefined;
  /**
   * The child whose authoritative descriptor refresh is still in flight.
   *
   * Settlement is not instantaneous: the live set says the child is gone, and
   * the overlay must re-read the child's real status before it draws the final
   * frame. Until that answer arrives the child is neither live nor settled,
   * and events for it are held out of the window rather than painted over a
   * frame that is about to become final.
   */
  private refreshingChildId: string | undefined;
  /** The in-flight refresh, exposed only so a caller can await settlement. */
  private settlementSignal: Promise<void> | undefined;
  /**
   * A descriptor re-read for a child that is still running.
   *
   * At most one is in flight: a tree change is frequent, and a queue of
   * overlapping describes would answer out of order.
   */
  private liveRefreshInFlight = false;
  private disposed = false;

  constructor(config: ChildOverlayLiveStreamConfig) {
    this.controller = config.controller;
    this.repaint = config.repaint;
    this.generationId = config.generationId;
    this.currentGenerationId = config.currentGenerationId;
    this.resolveLiveThreadId = config.resolveLiveThreadId;
    this.coalescer = new UiUpdateCoalescer(
      () => this.paint(),
      config.timer,
      config.intervalMs ?? CHILD_OVERLAY_REPAINT_INTERVAL_MS,
    );
  }

  /** True once the focused child's final, settled frame has been published. */
  isSettled(): boolean {
    const childId = this.controller.currentChildId();
    return childId !== undefined && childId === this.settledChildId;
  }

  /**
   * Applies one host child event, or reports exactly why it was dropped.
   *
   * A drop is never an error: a late event is ordinary in a streaming system.
   * It is reported so the caller can count it rather than guess.
   */
  ingest(childId: string, event: unknown): ChildOverlayLiveEventOutcome {
    if (this.disposed) return dropped("stream-disposed");
    if (this.currentGenerationId() !== this.generationId) {
      return dropped("stale-generation");
    }
    if (!this.controller.isOpen()) return dropped("overlay-closed");
    const view = this.controller.view();
    if (view.isErr()) return dropped("overlay-closed");
    const open = view.value.child;
    const threadId = this.resolveLiveThreadId?.(childId) ?? childId;
    if (
      open.threadId !== threadId &&
      open.childId !== childId &&
      open.childId !== threadId
    ) {
      return dropped("unfocused-child");
    }
    if (open.childId === this.settledChildId) return dropped("settled");
    if (open.childId === this.refreshingChildId) return dropped("settled");
    // A settled or orphaned child is read-only history. `applyLiveEvent`
    // already refuses to mutate it, and repainting for an event that changed
    // nothing would only cost frames.
    if (open.status !== "live") return dropped("settled");

    const applied = Result.fromThrowable(
      () => this.controller.applyLiveEvent(event),
      () => "overlay_live_event_failed" as const,
    )();
    if (applied.isErr() || applied.value.isErr()) return dropped("settled");
    this.coalescer.request("coalesced");
    return { kind: "applied" };
  }

  /**
   * Freezes the stream and publishes the final frame exactly once.
   *
   * Settlement never waits for a refresh window, and a second call publishes
   * nothing: the reader's last frame is the settled one, and it is drawn once.
   */
  settle(expectedChildId?: string): void {
    if (this.disposed) return;
    const childId = this.controller.currentChildId();
    if (childId === undefined || childId === this.settledChildId) return;
    // A settlement decided for one child may never freeze another: focus can
    // move while an authoritative refresh is in flight.
    if (expectedChildId !== undefined && expectedChildId !== childId) return;
    this.settledChildId = childId;
    this.coalescer.flush();
  }

  /**
   * Re-checks liveness after the delegation tree changed.
   *
   * The focused child leaving the live set is the authoritative settlement
   * signal available to the overlay; no session event carries one. Acting on
   * it means more than flipping a publisher flag: the open descriptor is the
   * snapshot taken when the reader opened the child, so every fact the final
   * frame prints — the state word, the read-only rule, whether a caret and an
   * editable prompt are drawn at all — still says `live` until the descriptor
   * itself is refreshed. The refresh therefore happens BEFORE the final
   * repaint, never after it.
   *
   * The refresh is asynchronous; `settlementPending()` resolves once the
   * final frame has been published.
   */
  noteTreeChanged(): void {
    if (this.disposed || this.isSettled()) return;
    if (this.resolveLiveThreadId === undefined) return;
    if (!this.controller.isOpen()) return;
    const view = this.controller.view();
    if (view.isErr()) return;
    const child = view.value.child;
    // Already authoritative history: nothing to re-read, publish the frame.
    if (child.status !== "live") {
      this.settle();
      return;
    }
    if (this.resolveLiveThreadId(child.childId) !== undefined) {
      // Still running. The tree is nonetheless the authority for elapsed time,
      // turn count and aggregate spend, and the open descriptor is the
      // snapshot taken when the reader opened the child, so those rail facts
      // are re-read on the same tree change the parent's card repaints on.
      this.refreshLiveDescriptor();
      return;
    }
    // One refresh per child. A repeated tree change while it is in flight is a
    // no-op, so the final frame is still published exactly once.
    if (this.refreshingChildId === child.childId) return;
    this.refreshingChildId = child.childId;
    this.settlementSignal = this.refreshThenSettle(child.childId);
  }

  /**
   * Resolves when the settlement started by `noteTreeChanged()` has
   * published its final frame, or immediately when none is in flight.
   */
  settlementPending(): Promise<void> {
    return this.settlementSignal ?? Promise.resolve();
  }

  /** Releases the repaint timer. A disposed stream publishes nothing further. */
  dispose(): void {
    this.disposed = true;
    this.refreshingChildId = undefined;
    this.coalescer.dispose();
  }

  /**
   * Refreshes the authoritative descriptor, then publishes the final frame.
   *
   * Fail-closed in both directions. A refresh that errors, and a refresh that
   * still claims the child is live after the delegation tree said it left the
   * live set, are both answered by marking the open child read-only: the live
   * set is the authority here, and a stale or unanswerable descriptor may not
   * keep an editable prompt alive against a child nothing can deliver to.
   *
   * Late answers are discarded rather than applied. If the stream was disposed,
   * the host generation was replaced, or the reader moved to another child
   * while the source was answering, the refresh settles nothing.
   */
  private async refreshThenSettle(childId: string): Promise<void> {
    const refreshed = await this.controller.refreshOpenChild();
    if (this.refreshingChildId === childId) {
      this.refreshingChildId = undefined;
    }
    if (this.disposed) return;
    if (this.currentGenerationId() !== this.generationId) return;
    if (this.controller.currentChildId() !== childId) return;
    const stillClaimsLive =
      refreshed.isOk() && refreshed.value.child.status === "live";
    if (refreshed.isErr() || stillClaimsLive) {
      this.controller.markOpenChildReadOnly();
    }
    this.settle(childId);
  }

  /**
   * Re-reads a RUNNING child's authoritative descriptor.
   *
   * Deliberately weaker than the settlement refresh below: a failed or superseded
   * read here proves nothing about liveness, so it never marks the child
   * read-only and never publishes a final frame. It only lets the rail's
   * tree-owned facts move with the run.
   */
  private refreshLiveDescriptor(): void {
    if (this.liveRefreshInFlight) return;
    this.liveRefreshInFlight = true;
    void this.controller.refreshOpenChild().match(
      () => {
        this.liveRefreshInFlight = false;
        if (this.disposed || this.isSettled()) return;
        this.coalescer.request("coalesced");
      },
      () => {
        this.liveRefreshInFlight = false;
      },
    );
  }

  private paint(): void {
    // A host repaint that throws must never take the child stream down.
    Result.fromThrowable(
      () => {
        this.repaint.invalidate();
        this.repaint.requestRender();
      },
      () => undefined,
    )();
  }
}

function dropped(
  reason: ChildOverlayLiveEventDrop,
): ChildOverlayLiveEventOutcome {
  return { kind: "dropped", reason };
}

export function createChildOverlayLiveStream(
  config: ChildOverlayLiveStreamConfig,
): ChildOverlayLiveStream {
  return new ChildOverlayLiveStream(config);
}
