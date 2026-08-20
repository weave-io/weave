/**
 * The one repaint-coalescing primitive every Weave UI stream shares.
 *
 * A streaming child produces text deltas far faster than a terminal can
 * usefully redraw. Both live surfaces — the delegation card and the child
 * overlay — therefore publish at most one ordinary repaint per refresh window
 * and let the facts they already hold catch up on the next frame.
 *
 * This module is a leaf: it imports only the injected {@link TimerPort} and
 * `neverthrow`, so the card path (`delegation-tool.ts`) and the overlay path
 * (`child-overlay-controller.ts`) can both depend on it without either
 * depending on the other.
 */

import { Result } from "neverthrow";
import type { TimerHandle, TimerPort } from "./child-timer.js";

/**
 * Which frames may wait for the refresh window and which may not.
 *
 * `immediate` is reserved for the facts a reader acts on: a run opening, a
 * tool failing, a provider failing, the parent steering the child, and the
 * authoritative settlement. Everything else is ordinary repaint traffic.
 */
export type UiUpdatePriority = "coalesced" | "immediate";

/**
 * Publishes at most one ordinary update per refresh window.
 *
 * It schedules exclusively through the INJECTED {@link TimerPort} — it never
 * calls `setTimeout` itself — so a test drives the window deterministically and
 * production keeps exactly one timer discipline.
 *
 * Two guarantees make a coalesced frame safe to drop:
 *
 * - **Trailing flush.** A frame that arrives inside an open window is not lost;
 *   it is published when the window closes.
 * - **A coalesced update is never the final one.** `flush()` publishes
 *   unconditionally and settlement always flushes, so the last frame a reader
 *   sees is always the settled one.
 */
export class UiUpdateCoalescer {
  private readonly publish: () => void;
  private readonly timer: TimerPort;
  private readonly intervalMs: number;
  private handle: TimerHandle | undefined;
  private windowOpen = false;
  private pending = false;
  private disposed = false;

  constructor(publish: () => void, timer: TimerPort, intervalMs: number) {
    this.publish = publish;
    this.timer = timer;
    this.intervalMs = Number.isFinite(intervalMs)
      ? Math.max(0, Math.floor(intervalMs))
      : 0;
  }

  /** Requests one update at the given priority. */
  request(priority: UiUpdatePriority): void {
    if (this.disposed) return;
    if (priority === "immediate") {
      this.cancel();
      this.pending = false;
      this.emit();
      this.openWindow();
      return;
    }
    if (!this.windowOpen) {
      this.emit();
      this.openWindow();
      return;
    }
    this.pending = true;
  }

  /** Publishes now, whatever the window says. Settlement always flushes. */
  flush(): void {
    if (this.disposed) return;
    this.cancel();
    this.pending = false;
    this.windowOpen = false;
    this.emit();
  }

  /** Releases the timer. A disposed coalescer publishes nothing further. */
  dispose(): void {
    this.cancel();
    this.pending = false;
    this.windowOpen = false;
    this.disposed = true;
  }

  private openWindow(): void {
    this.windowOpen = true;
    this.handle = this.timer.schedule(() => {
      this.handle = undefined;
      if (this.disposed) return;
      if (this.pending) {
        this.pending = false;
        this.emit();
        this.openWindow();
        return;
      }
      this.windowOpen = false;
    }, this.intervalMs);
  }

  private cancel(): void {
    this.handle?.cancel();
    this.handle = undefined;
  }

  private emit(): void {
    // A publisher that throws must never take the delegation down with it.
    Result.fromThrowable(
      () => this.publish(),
      () => undefined,
    )();
  }
}
