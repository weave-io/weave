import { err, ok, type Result } from "neverthrow";
import {
  makePiLiveReasoningRejection,
  readPiLiveReasoningCarrier,
  readPiLiveReasoningUpdate,
} from "./child-live-reasoning-carrier.js";
import {
  inspectorDisplay,
  newestUtf8,
  normalizeTerminalFragment,
  normalizeTerminalText,
  parentDisplay,
  piLiveReasoningUtf8Bytes,
  reconcileEnd,
} from "./child-live-reasoning-display.js";
import {
  invalidatePiLiveReasoningObservers,
  notifyPiLiveReasoningObserver,
} from "./child-live-reasoning-fanout.js";
import type { PiLiveReasoningRegistry } from "./child-live-reasoning-registry.js";
import {
  PI_LIVE_REASONING_MAX_BYTES,
  PI_LIVE_REASONING_PARENT_PREFIX,
  PI_LIVE_REASONING_UNPRINTABLE_MARKER,
  type PiLiveReasoningObserver,
  type PiLiveReasoningPhase,
  type PiLiveReasoningProjectorConfig,
  type PiLiveReasoningRejection,
  type PiLiveReasoningSnapshot,
  type PiLiveReasoningUpdate,
} from "./child-live-reasoning-types.js";

interface MutableState {
  childId: string | undefined;
  generationId: string | undefined;
  epoch: number;
  phase: PiLiveReasoningPhase | "idle";
  contentIndex: number | undefined;
  text: string;
  retainedBytes: number;
  omitted: boolean;
  unprintable: boolean;
  released: boolean;
}

/**
 * Reducer and UI fanout for exactly one authenticated child's active thinking
 * block. The class has no session-event, tree, transcript, or settlement type
 * fields; callers must explicitly release it at the lifecycle boundary.
 */
export class PiLiveReasoningProjector {
  private diagnostics: PiLiveReasoningProjectorConfig["diagnostics"];
  private parentCardObserver: PiLiveReasoningObserver | undefined;
  private inspectorObserver: PiLiveReasoningObserver | undefined;
  private readonly invalidationObservers = new Set<() => void>();
  private readonly registry: PiLiveReasoningRegistry | undefined;
  private registryKey: string | undefined;
  private state: MutableState;

  constructor(config: PiLiveReasoningProjectorConfig) {
    this.diagnostics = config.diagnostics;
    this.parentCardObserver =
      config.parentCardObserver ?? config.onParentCardReasoning;
    this.inspectorObserver =
      config.inspectorObserver ?? config.onInspectorReasoning;
    this.registry = config.registry;
    this.registryKey = config.registryKey ?? config.childId;
    this.state = {
      childId: config.childId,
      generationId: config.generationId,
      epoch: 0,
      phase: "idle",
      contentIndex: undefined,
      text: "",
      retainedBytes: 0,
      omitted: false,
      unprintable: false,
      released: false,
    };
    if (this.registry !== undefined && this.registryKey !== undefined) {
      this.registry.register(this.registryKey, this).match(
        () => undefined,
        () => undefined,
      );
    }
  }

  /** Accepts only the exact parser-approved generic Pi carrier. */
  accept(
    event: unknown,
  ): Result<PiLiveReasoningUpdate | undefined, PiLiveReasoningRejection> {
    if (this.state.released) {
      return err(makePiLiveReasoningRejection("disposed"));
    }
    const carrier = readPiLiveReasoningCarrier(event);
    if (carrier.isErr()) {
      return err(makePiLiveReasoningRejection(carrier.error));
    }
    if (carrier.value === undefined) return ok(undefined);

    if (carrier.value.phase === "start") {
      this.state.epoch += 1;
      this.state.phase = "start";
      this.state.contentIndex = carrier.value.contentIndex;
      this.state.text = "";
      this.state.retainedBytes = 0;
      this.state.omitted = false;
      this.state.unprintable = false;
      this.appendInput(carrier.value.text, carrier.value.inputWasNonEmpty);
      return this.emitUpdate("start");
    }

    if (this.state.phase === "idle" || this.state.phase === "end") {
      return err(makePiLiveReasoningRejection("no-active-block"));
    }
    if (this.state.contentIndex !== carrier.value.contentIndex) {
      return err(makePiLiveReasoningRejection("out-of-order"));
    }

    if (carrier.value.phase === "delta") {
      this.appendInput(carrier.value.text, carrier.value.inputWasNonEmpty);
      return this.emitUpdate("delta");
    }

    const normalized = normalizeTerminalText(carrier.value.text);
    const reconciled = reconcileEnd(this.state.text, normalized.text);
    const finalText = normalizeTerminalText(reconciled).text;
    const bounded = newestUtf8(finalText, PI_LIVE_REASONING_MAX_BYTES);
    this.state.text = bounded.text;
    this.state.retainedBytes = piLiveReasoningUtf8Bytes(bounded.text);
    this.state.omitted = this.state.omitted || bounded.omitted;
    this.state.unprintable =
      this.state.text.length === 0 &&
      (this.state.unprintable ||
        (carrier.value.inputWasNonEmpty && !normalized.hadPrintable));
    this.state.phase = "end";
    return this.emitUpdate("end");
  }

  /** Applies a previously projected update with identity/epoch checks. */
  apply(
    update: PiLiveReasoningUpdate,
  ): Result<PiLiveReasoningSnapshot, PiLiveReasoningRejection> {
    if (this.state.released) {
      return err(makePiLiveReasoningRejection("disposed"));
    }
    const validated = readPiLiveReasoningUpdate(update);
    if (validated.isErr()) {
      return err(makePiLiveReasoningRejection(validated.error));
    }
    const safeUpdate = validated.value;
    if (safeUpdate.childId !== this.state.childId) {
      return err(makePiLiveReasoningRejection("stale-child"));
    }
    if (safeUpdate.generationId !== this.state.generationId) {
      return err(makePiLiveReasoningRejection("stale-generation"));
    }
    if (safeUpdate.phase === "start") {
      if (safeUpdate.lifecycleEpoch < this.state.epoch) {
        return err(makePiLiveReasoningRejection("stale-epoch"));
      }
      this.state.epoch = safeUpdate.lifecycleEpoch;
      this.state.phase = "start";
      this.state.contentIndex = safeUpdate.contentIndex;
      this.state.text = "";
      this.state.retainedBytes = 0;
      this.state.omitted = false;
      this.state.unprintable = false;
    } else {
      if (this.state.phase === "idle" || this.state.phase === "end") {
        return err(makePiLiveReasoningRejection("out-of-order"));
      }
      if (safeUpdate.lifecycleEpoch !== this.state.epoch) {
        return err(makePiLiveReasoningRejection("stale-epoch"));
      }
      if (this.state.contentIndex !== safeUpdate.contentIndex) {
        return err(makePiLiveReasoningRejection("out-of-order"));
      }
    }
    const normalized = normalizeTerminalText(safeUpdate.text);
    // The marker is an internal transport value from the child projector, not
    // printable reasoning. Preserve its meaning when the parent card applies
    // the update; otherwise the marker itself would become a live card row.
    const markerOnly = safeUpdate.text === PI_LIVE_REASONING_UNPRINTABLE_MARKER;
    const displayText = markerOnly ? "" : normalized.text;
    const bounded = newestUtf8(displayText, PI_LIVE_REASONING_MAX_BYTES);
    this.state.text = bounded.text;
    this.state.retainedBytes = piLiveReasoningUtf8Bytes(bounded.text);
    this.state.omitted = this.state.omitted || bounded.omitted;
    this.state.unprintable =
      this.state.text.length === 0 &&
      (markerOnly || (normalized.hadInput && !normalized.hadPrintable));
    this.state.phase = safeUpdate.phase;
    const appliedUpdate: PiLiveReasoningUpdate = {
      ...safeUpdate,
      text: this.displayText(),
    };
    if (appliedUpdate.text.length > 0) {
      this.notify(this.parentCardObserver, appliedUpdate);
      this.notify(this.inspectorObserver, appliedUpdate);
    }
    this.invalidateObservers();
    return ok(this.snapshot());
  }

  snapshot(): PiLiveReasoningSnapshot {
    const parentCardText = parentDisplay(
      this.state.text,
      this.state.omitted,
      this.state.unprintable,
    );
    const inspectorRows = inspectorDisplay(
      this.state.text,
      this.state.omitted,
      this.state.unprintable,
    );
    return {
      childId: this.state.childId,
      generationId: this.state.generationId,
      lifecycleEpoch: this.state.epoch,
      phase: this.state.phase,
      contentIndex: this.state.contentIndex,
      text: this.state.text,
      parentCardText,
      inspectorRows,
      parentCardLine:
        parentCardText.length === 0
          ? ""
          : `${PI_LIVE_REASONING_PARENT_PREFIX}${parentCardText}`,
      active: !this.state.released && this.state.phase !== "idle",
      retainedBytes: this.state.retainedBytes,
      omitted: this.state.omitted,
      unprintable: this.state.unprintable,
      registryEntries: this.registry?.size() ?? 0,
    };
  }

  /** Alias used by UI ports that call their transient value a state. */
  stateSnapshot(): PiLiveReasoningSnapshot {
    return this.snapshot();
  }

  /**
   * Adds the host renderer's row-local invalidation callback. This is a
   * process-memory UI seam only; it never becomes part of a tool result or a
   * persisted card fact.
   */
  registerInvalidation(invalidate: () => void): Result<void, never> {
    if (this.state.released) return ok(undefined);
    this.invalidationObservers.add(invalidate);
    return ok(undefined);
  }

  unregisterInvalidation(invalidate: () => void): Result<void, never> {
    this.invalidationObservers.delete(invalidate);
    return ok(undefined);
  }

  clear(): Result<void, never> {
    return this.release();
  }

  settle(): Result<void, never> {
    return this.release();
  }

  dispose(): Result<void, never> {
    return this.release();
  }

  isDisposed(): boolean {
    return this.state.released;
  }

  private appendInput(value: string, inputWasNonEmpty: boolean): void {
    const normalized = normalizeTerminalFragment(value);
    const combined = `${this.state.text}${normalized.text}`;
    const bounded = newestUtf8(combined, PI_LIVE_REASONING_MAX_BYTES);
    this.state.text = bounded.text;
    this.state.retainedBytes = piLiveReasoningUtf8Bytes(bounded.text);
    this.state.omitted = this.state.omitted || bounded.omitted;
    this.state.unprintable =
      this.state.text.length === 0 &&
      (this.state.unprintable ||
        (inputWasNonEmpty && !normalized.hadPrintable));
  }

  private displayText(): string {
    return this.state.text.length === 0 && this.state.unprintable
      ? PI_LIVE_REASONING_UNPRINTABLE_MARKER
      : this.state.text;
  }

  private emitUpdate(
    phase: PiLiveReasoningPhase,
  ): Result<PiLiveReasoningUpdate, PiLiveReasoningRejection> {
    const childId = this.state.childId;
    const generationId = this.state.generationId;
    const contentIndex = this.state.contentIndex;
    if (
      childId === undefined ||
      generationId === undefined ||
      contentIndex === undefined
    ) {
      return err(makePiLiveReasoningRejection("disposed"));
    }
    const update: PiLiveReasoningUpdate = {
      childId,
      generationId,
      lifecycleEpoch: this.state.epoch,
      phase,
      contentIndex,
      text: this.displayText(),
    };
    // Fan out the structural start before the first delta. The start carries
    // no display text, but downstream projectors need it to open the same
    // correlated block before they can accept deltas. Keep empty lifecycle
    // updates out of the visible sinks.
    if (phase === "start" || update.text.length > 0) {
      this.notify(this.parentCardObserver, update);
      this.notify(this.inspectorObserver, update);
    }
    this.invalidateObservers();
    return ok(update);
  }

  private notify(
    observer: PiLiveReasoningObserver | undefined,
    update: PiLiveReasoningUpdate,
  ): void {
    notifyPiLiveReasoningObserver(observer, update, () => this.diagnostics);
  }

  private release(): Result<void, never> {
    if (this.state.released) return ok(undefined);
    const registry = this.registry;
    const key = this.registryKey;
    this.state = {
      childId: undefined,
      generationId: undefined,
      epoch: 0,
      phase: "idle",
      contentIndex: undefined,
      text: "",
      retainedBytes: 0,
      omitted: false,
      unprintable: false,
      released: true,
    };
    // Clear the bounded buffer before repainting. A host invalidation therefore
    // can only observe the empty snapshot and cannot replay the last sentinel.
    this.invalidateObservers();
    this.invalidationObservers.clear();
    if (registry !== undefined && key !== undefined) {
      registry.unregister(key, this).match(
        () => undefined,
        () => undefined,
      );
    }
    this.registryKey = undefined;
    this.parentCardObserver = undefined;
    this.inspectorObserver = undefined;
    this.diagnostics = undefined;
    return ok(undefined);
  }

  private invalidateObservers(): void {
    invalidatePiLiveReasoningObservers(
      this.invalidationObservers,
      () => this.diagnostics,
    );
  }
}

/** Factory spelling for callers that prefer a construction function. */
export function createPiLiveReasoningProjector(
  config: PiLiveReasoningProjectorConfig,
): PiLiveReasoningProjector {
  return new PiLiveReasoningProjector(config);
}

/** Direct projection helper for parser-boundary tests and adapter ports. */
export function projectPiLiveReasoningUpdate(
  event: unknown,
  identity: Readonly<{
    readonly childId: string;
    readonly generationId: string;
    readonly lifecycleEpoch: number;
  }>,
): Result<PiLiveReasoningUpdate | undefined, PiLiveReasoningRejection> {
  const carrier = readPiLiveReasoningCarrier(event);
  if (carrier.isErr()) {
    return err(makePiLiveReasoningRejection(carrier.error));
  }
  if (carrier.value === undefined) return ok(undefined);
  if (
    !Number.isSafeInteger(identity.lifecycleEpoch) ||
    identity.lifecycleEpoch < 1
  ) {
    return err(makePiLiveReasoningRejection("stale-epoch"));
  }
  const normalized = normalizeTerminalText(carrier.value.text);
  const bounded = newestUtf8(normalized.text, PI_LIVE_REASONING_MAX_BYTES);
  return ok({
    childId: identity.childId,
    generationId: identity.generationId,
    lifecycleEpoch: identity.lifecycleEpoch,
    phase: carrier.value.phase,
    contentIndex: carrier.value.contentIndex,
    text:
      bounded.text.length === 0 &&
      carrier.value.inputWasNonEmpty &&
      !normalized.hadPrintable
        ? PI_LIVE_REASONING_UNPRINTABLE_MARKER
        : bounded.text,
  });
}
