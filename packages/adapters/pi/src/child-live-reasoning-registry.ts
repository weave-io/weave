import { ok, type Result } from "neverthrow";
import type { PiLiveReasoningProjector } from "./child-live-reasoning-projector.js";
import { PI_LIVE_REASONING_MAX_REGISTRY_ENTRIES } from "./child-live-reasoning-types.js";

/**
 * A process-memory registry for UI projectors. Its lookup is for generation-
 * local UI owners; diagnostics and health expose only bounded counts, never
 * keys, identities, or snapshots.
 */
export class PiLiveReasoningRegistry {
  private readonly entries = new Map<string, PiLiveReasoningProjector>();

  register(
    key: string,
    projector: PiLiveReasoningProjector,
  ): Result<void, never> {
    const prior = this.entries.get(key);
    if (prior !== undefined && prior !== projector) {
      prior.clear().match(
        () => undefined,
        () => undefined,
      );
    }
    this.entries.delete(key);
    while (this.entries.size >= PI_LIVE_REASONING_MAX_REGISTRY_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      evicted?.clear().match(
        () => undefined,
        () => undefined,
      );
    }
    this.entries.set(key, projector);
    return ok(undefined);
  }

  unregister(
    key: string,
    projector?: PiLiveReasoningProjector,
  ): Result<void, never> {
    if (projector === undefined || this.entries.get(key) === projector) {
      this.entries.delete(key);
    }
    return ok(undefined);
  }

  get(key: string): PiLiveReasoningProjector | undefined {
    return this.entries.get(key);
  }

  size(): number {
    return this.entries.size;
  }

  /** Total bytes retained by all live projectors in this generation. */
  retainedBytes(): number {
    let total = 0;
    for (const projector of this.entries.values()) {
      total += projector.snapshot().retainedBytes;
    }
    return total;
  }

  clear(): Result<void, never> {
    for (const projector of this.entries.values()) {
      projector.clear().match(
        () => undefined,
        () => undefined,
      );
    }
    this.entries.clear();
    return ok(undefined);
  }
}

export function createPiLiveReasoningRegistry(): PiLiveReasoningRegistry {
  return new PiLiveReasoningRegistry();
}
