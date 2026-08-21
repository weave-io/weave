/**
 * Internal generation-scoped plumbing for the Pi extension.
 *
 * This module is deliberately absent from the package's `exports` map and from
 * `index.ts`: it is a private seam that `extension.ts` composes, and tests
 * reach through a relative import. Nothing here widens the adapter's public
 * API.
 */
import type { RuntimeStore } from "@weaveio/weave-engine";
import { Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { PiTelemetry } from "./telemetry.js";
import type { PiSessionContext, PiSessionManagerPort } from "./types.js";

/**
 * The generation-owned model-fallback coordinator, seen only through its
 * reset/shutdown boundary so this module never imports coordinator internals.
 */
export interface PiGenerationModelFailoverPort {
  reset(): unknown;
  shutdown(): unknown;
}

/** Generation-scoped holder for the one primary-session failover coordinator. */
export interface PiModelFailoverCoordinatorCell {
  coordinator: PiGenerationModelFailoverPort | undefined;
  generationId: string | undefined;
}

export function createModelFailoverCoordinatorCell(): PiModelFailoverCoordinatorCell {
  return { coordinator: undefined, generationId: undefined };
}

/**
 * Synchronously invalidate timers and publish any retained failure once.
 * A replaced generation must not keep a live coordinator across the first
 * await of shutdown or replacement.
 */
export function shutdownModelFailoverCoordinator(
  cell: PiModelFailoverCoordinatorCell,
): void {
  const coordinator = cell.coordinator;
  cell.coordinator = undefined;
  cell.generationId = undefined;
  if (coordinator === undefined) return;
  Result.fromThrowable(
    () => coordinator.shutdown(),
    () => undefined,
  )();
}

/**
 * Owns the resources a single extension generation created, so a replaced
 * generation releases them exactly once and never on its successor's behalf.
 */
export class PiGenerationResourceOwner {
  private disposed = false;
  private runtimeStore: RuntimeStore | undefined;
  private telemetry: PiTelemetry | undefined;
  private modelFailover: PiGenerationModelFailoverPort | undefined;

  /**
   * `onDispose` runs exactly once, when this generation stops owning its
   * resources. It releases generation-scoped state a retained closure could
   * otherwise keep alive - notably the newest session context. A throwing
   * `onDispose` is absorbed so disposal keeps its `never` failure type.
   */
  constructor(
    readonly generationId: string,
    private readonly onDispose?: () => void,
  ) {}

  adoptRuntimeStore(store: RuntimeStore): void {
    if (this.disposed) {
      void store.close().match(
        () => {},
        () => {},
      );
      return;
    }
    this.runtimeStore = store;
  }

  adoptTelemetry(telemetry: PiTelemetry): void {
    if (this.disposed) {
      void telemetry.shutdown().match(
        () => {},
        () => {},
      );
      return;
    }
    this.telemetry = telemetry;
  }

  adoptModelFailover(coordinator: PiGenerationModelFailoverPort): void {
    if (this.disposed) {
      Result.fromThrowable(
        () => coordinator.shutdown(),
        () => undefined,
      )();
      return;
    }
    this.modelFailover = coordinator;
  }

  takeModelFailover(): PiGenerationModelFailoverPort | undefined {
    const held = this.modelFailover;
    this.modelFailover = undefined;
    return held;
  }

  dispose(): ResultAsync<void, never> {
    if (this.disposed) return ResultAsync.fromSafePromise(Promise.resolve());
    this.disposed = true;
    Result.fromThrowable(
      () => this.onDispose?.(),
      () => {},
    )().match(
      () => {},
      () => {},
    );
    const failover = this.modelFailover;
    this.modelFailover = undefined;
    if (failover !== undefined) {
      Result.fromThrowable(
        () => failover.shutdown(),
        () => undefined,
      )();
    }
    const telemetry = this.telemetry;
    const runtimeStore = this.runtimeStore;
    this.telemetry = undefined;
    this.runtimeStore = undefined;

    return ResultAsync.fromThrowable(
      async () => {
        if (telemetry !== undefined) await telemetry.shutdown();
        if (runtimeStore !== undefined) await runtimeStore.close();
      },
      () => {},
    )().orElse(() => ResultAsync.fromSafePromise(Promise.resolve()));
  }
}

/**
 * Why a child-ref entry read could not consult a session manager. Bounded
 * codes only: they name the shape of the degradation, never a session.
 */
export type PiChildRefEntryReadDegradation =
  | "no-session-manager"
  | "get-entries-failed";

/** Generation-scoped holder for the newest session context Pi handed us. */
export interface PiGenerationSessionCtxCell {
  /** Records `ctx` as the newest context observed for `generationId`. */
  readonly note: (generationId: string, ctx: PiSessionContext) => void;
  /**
   * The newest context for `generationId`, or `undefined` when the cell holds
   * another generation's context. A replaced generation therefore never reads
   * its successor's session manager.
   */
  readonly read: (generationId: string) => PiSessionContext | undefined;
  /** Drops the held context when `generationId` still owns the cell. */
  readonly clear: (generationId: string) => void;
}

export function createGenerationSessionCtxCell(): PiGenerationSessionCtxCell {
  let held: { generationId: string; ctx: PiSessionContext } | undefined;
  return {
    note: (generationId, ctx) => {
      held = { generationId, ctx };
    },
    read: (generationId) =>
      held?.generationId === generationId ? held.ctx : undefined,
    clear: (generationId) => {
      if (held?.generationId === generationId) held = undefined;
    },
  };
}

type PiSessionEntriesReader = (
  this: PiSessionManagerPort,
) => readonly unknown[];

const PI_SESSION_ENTRIES_READER_SCHEMA = z.custom<PiSessionEntriesReader>(
  (value) => value instanceof Function,
);

function findSessionEntriesReader(
  manager: PiSessionManagerPort,
): PiSessionEntriesReader | undefined {
  let current: PiSessionManagerPort | object | null = manager;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "getEntries");
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) return undefined;
      const parsed = PI_SESSION_ENTRIES_READER_SCHEMA.safeParse(
        descriptor.value,
      );
      return parsed.success ? parsed.data : undefined;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

/**
 * Reads Pi's parent session entries from a context, fail-closed.
 *
 * An absent or throwing session manager yields no entries and one bounded
 * degradation report: the ref ledger is then simply empty, which every caller
 * already treats as "no durable children", never as an authority to skip a
 * check.
 */
export function readSessionManagerEntries(
  ctx: PiSessionContext | undefined,
  report: (degradation: PiChildRefEntryReadDegradation) => void,
): readonly unknown[] {
  const manager = ctx?.sessionManager;
  if (manager === undefined) {
    report("no-session-manager");
    return [];
  }
  const reader = Result.fromThrowable(
    () => findSessionEntriesReader(manager),
    () => false,
  )().match(
    (candidate) => candidate,
    () => void 0,
  );
  if (reader === undefined) {
    report("no-session-manager");
    return [];
  }
  return Result.fromThrowable(
    () => reader.call(manager),
    () => false,
  )().match(
    (entries) => entries,
    () => {
      report("get-entries-failed");
      return [];
    },
  );
}
