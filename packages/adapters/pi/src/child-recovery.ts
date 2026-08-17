import {
  errAsync,
  okAsync,
  ResultAsync,
  type ResultAsync as ResultAsyncType,
} from "neverthrow";
import type { PiChildSessionEvent } from "./child-session-events.js";
import type { PiChildRefRecord } from "./child-session-refs.js";
import { MAX_FINAL_OUTPUT_BYTES } from "./child-tree.js";

/**
 * The durable child record recovery reads. Since ADR 0014 the authority is the
 * parent session's `weave.child-ref.v1` ledger, not an adapter-owned store.
 */
export type PiChildRecoveryRecord = PiChildRefRecord;

export const RECOVERY_CHOICES = ["Recover now", "Skip", "Inspect"] as const;
export type PiRecoveryChoice = (typeof RECOVERY_CHOICES)[number];

export interface PiChildRecoveryUi {
  select(
    title: string,
    options: readonly string[],
    optionsConfig?: { timeout?: number },
  ): Promise<string | undefined>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  inspect?(record: PiChildRecoveryRecord): void | PromiseLike<void>;
}

/**
 * Recovery's read/write seam over the child-ref ledger. `list` returns the
 * scanned refs for the live parent session; `updateStatus` appends one
 * lifecycle entry. Neither ever touches child transcript content.
 */
export interface PiChildRecoveryHistory {
  list(): ResultAsyncType<readonly PiChildRecoveryRecord[], unknown>;
  updateStatus(
    record: PiChildRecoveryRecord,
    status: PiChildRefRecord["status"],
  ): ResultAsyncType<void, unknown>;
}

export interface PiChildRecoveryDescriptor {
  readonly name: string;
  readonly current?: boolean;
}

export interface PiChildRecoverySpawnInput {
  readonly record: PiChildRecoveryRecord;
  readonly descriptor: PiChildRecoveryDescriptor;
  readonly generationId: string;
  readonly model?: string;
  readonly policy?: unknown;
  readonly limits?: unknown;
  readonly continuation: string;
  /**
   * Optional parser-approved session-event sink for restore spawns. Invoked
   * from the authenticated child observer; exceptions are isolated and must
   * never affect child execution.
   */
  readonly onSessionEvent?: (event: PiChildSessionEvent) => void;
}

/** The only recovered data that may cross back into the parent model. */
export interface PiChildRecoverySettlement {
  readonly finalOutput: string;
  readonly interventionCount: number;
}

export interface PiChildRecoveryDeps {
  readonly history: PiChildRecoveryHistory;
  readonly ui: PiChildRecoveryUi;
  readonly generationId: string;
  readonly isGenerationCurrent?: (generationId: string) => boolean;
  readonly trustedProject: boolean;
  readonly recoveryEnabled: boolean;
  readonly countdownSeconds: number;
  readonly resolveDescriptor: (
    name: string,
  ) => PiChildRecoveryDescriptor | undefined;
  readonly currentModel?: string;
  /**
   * Read per validation, never captured: a restore must carry the policy the
   * published catalog holds when the user accepts it, not the one activated
   * at boot.
   */
  readonly currentPolicy?: () => unknown;
  readonly currentLimits?: unknown;
  /** Starts a child and resolves only with its authenticated terminal result. */
  readonly spawn: (
    input: PiChildRecoverySpawnInput,
  ) => ResultAsyncType<PiChildRecoverySettlement, unknown>;
  /** `triggerTurn: false` is mandatory: recovery is context projection, not a new turn. */
  readonly injectParentContext?: (
    content: string,
    options: { readonly triggerTurn: false },
  ) => ResultAsyncType<void, unknown>;
  readonly now?: () => number;
}

export type PiChildRecoveryFailure =
  | { readonly type: "ChildRecoveryUnavailable"; readonly reason: string }
  | { readonly type: "ChildRecoverySpawnFailed" };

export const RECOVERY_CONTINUATION =
  "Continue from the saved session. Review the current state and complete the original task. Do not repeat completed work.";

/**
 * A ref record is recoverable only when it still names a usable native
 * session and a descriptor title. The ref ledger never carries transcript
 * content, so this is metadata-only validation.
 */
function isSafeRecoveryMetadata(record: PiChildRecoveryRecord): boolean {
  return (
    record.sessionRef.length > 0 &&
    record.nativeSessionId.length > 0 &&
    record.threadId.length > 0 &&
    record.title.length > 0
  );
}

/**
 * An interrupted top-level child is one the ref ledger still shows as queued
 * or running: the parent went away before any terminal lifecycle entry was
 * appended. Settled, failed, cancelled and tombstoned refs are never
 * candidates.
 */
export function findOrdinaryRecoveryCandidates(
  records: readonly PiChildRecoveryRecord[],
): readonly PiChildRecoveryRecord[] {
  return records.filter(
    (record) =>
      (record.status === "running" || record.status === "queued") &&
      record.settledAt === undefined &&
      isSafeRecoveryMetadata(record),
  );
}

/** Truncate by bytes, backing over UTF-8 continuation bytes. */
export function boundedRecoveryOutput(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= MAX_FINAL_OUTPUT_BYTES) return value;
  let end = MAX_FINAL_OUTPUT_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.slice(0, end));
}

function unavailable(
  reason: string,
): ResultAsyncType<never, PiChildRecoveryFailure> {
  return errAsync({ type: "ChildRecoveryUnavailable", reason });
}

/** Convert sync throws and ResultAsync rejections into one safe typed failure. */
function safely<T>(
  operation: () => ResultAsyncType<T, unknown>,
  reason: string,
): ResultAsyncType<T, PiChildRecoveryFailure> {
  return ResultAsync.fromPromise(
    Promise.resolve()
      .then(operation)
      .then((result) =>
        result.match(
          (value) => value,
          () => {
            throw new Error(reason);
          },
        ),
      ),
    () => ({ type: "ChildRecoveryUnavailable" as const, reason }),
  );
}

export class PiChildRecoveryCoordinator {
  private readonly now: () => number;
  private readonly current: (generationId: string) => boolean;

  constructor(private readonly deps: PiChildRecoveryDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.current =
      deps.isGenerationCurrent ??
      ((generationId) => generationId === deps.generationId);
  }

  candidates(): ResultAsyncType<
    readonly PiChildRecoveryRecord[],
    PiChildRecoveryFailure
  > {
    if (!this.deps.recoveryEnabled) return okAsync([]);
    return safely(
      () => this.deps.history.list(),
      "History is unavailable.",
    ).map(findOrdinaryRecoveryCandidates);
  }

  private validate(
    record: PiChildRecoveryRecord,
  ): ResultAsyncType<PiChildRecoverySpawnInput, PiChildRecoveryFailure> {
    if (!this.deps.recoveryEnabled) return unavailable("Recovery is disabled.");
    if (!this.deps.trustedProject)
      return unavailable("Recovery is unavailable in an untrusted project.");
    if (!this.current(this.deps.generationId))
      return unavailable("The recovery generation is stale.");
    if (
      (record.status !== "running" && record.status !== "queued") ||
      record.settledAt !== undefined
    )
      return unavailable(
        "The child is not an interrupted top-level ordinary child.",
      );
    if (!isSafeRecoveryMetadata(record))
      return unavailable("The child record is unavailable for recovery.");
    const descriptorName = record.title;
    return safely(
      () => okAsync(this.deps.resolveDescriptor(descriptorName)),
      "The trusted child descriptor is no longer available.",
    ).andThen((descriptor) => {
      if (
        descriptor === undefined ||
        descriptor.current === false ||
        descriptor.name !== descriptorName
      )
        return unavailable(
          "The trusted child descriptor is no longer available.",
        );
      return okAsync({
        record,
        descriptor,
        generationId: this.deps.generationId,
        model: this.deps.currentModel,
        policy: this.deps.currentPolicy?.(),
        limits: this.deps.currentLimits,
        continuation: RECOVERY_CONTINUATION,
      });
    });
  }

  recover(
    record: PiChildRecoveryRecord,
  ): ResultAsyncType<void, PiChildRecoveryFailure> {
    return this.validate(record).andThen((input) => {
      if (!this.current(input.generationId))
        return unavailable("The recovery generation is stale.");
      const running = safely(
        () => this.deps.history.updateStatus(record, "running"),
        "Child ref update failed.",
      );
      const spawned = running.andThen(() =>
        safely(() => this.deps.spawn(input), "Recovery process failed.")
          .andThen((settlement) =>
            settlement !== null &&
            typeof settlement === "object" &&
            typeof settlement.finalOutput === "string" &&
            Number.isSafeInteger(settlement.interventionCount) &&
            settlement.interventionCount >= 0
              ? okAsync(settlement)
              : errAsync({ type: "ChildRecoverySpawnFailed" as const }),
          )
          .mapErr(() => ({ type: "ChildRecoverySpawnFailed" as const }))
          .orElse((failure) =>
            safely(
              () => this.deps.history.updateStatus(record, "failed"),
              "Child ref rollback failed.",
            )
              .mapErr(() => failure)
              .andThen(() => errAsync(failure)),
          ),
      );
      return spawned.andThen((settlement) => {
        // A valid authenticated settlement is terminal even when this
        // generation has gone stale. Persist it before deciding whether
        // context may cross back into the parent.
        const count =
          Number.isSafeInteger(settlement.interventionCount) &&
          settlement.interventionCount >= 0
            ? settlement.interventionCount
            : 0;
        const output = boundedRecoveryOutput(
          typeof settlement.finalOutput === "string"
            ? settlement.finalOutput
            : "",
        );
        return safely(
          () => this.deps.history.updateStatus(record, "completed"),
          "Child ref settlement update failed.",
        )
          .mapErr(() => ({ type: "ChildRecoverySpawnFailed" as const }))
          .andThen(() =>
            this.injectSettlementContent(output, count, input.generationId),
          );
      });
    });
  }

  startup(): ResultAsyncType<
    "recovered" | "skipped" | "none",
    PiChildRecoveryFailure
  > {
    return this.candidates().andThen((records) => {
      if (records.length === 0) return okAsync("none" as const);
      return safely(
        () =>
          ResultAsync.fromPromise(
            this.deps.ui.select(
              "Interrupted Weave children",
              RECOVERY_CHOICES,
              { timeout: Math.max(0, this.deps.countdownSeconds) * 1000 },
            ),
            () => undefined,
          ),
        "Recovery prompt failed.",
      ).andThen((choice) => {
        if (choice === "Skip") return okAsync("skipped" as const);
        if (choice === "Inspect") {
          let result: ResultAsyncType<void, PiChildRecoveryFailure> =
            okAsync(undefined);
          for (const candidate of records) {
            result = result.andThen(() =>
              safely(
                () =>
                  ResultAsync.fromPromise(
                    Promise.resolve(this.deps.ui.inspect?.(candidate)),
                    () => undefined,
                  ),
                "Recovery inspection failed.",
              ),
            );
          }
          return result.map(() => "skipped" as const);
        }
        if (choice !== undefined && choice !== "Recover now")
          return unavailable("Recovery prompt returned an invalid choice.");
        // Pi returns undefined for timeout/cancel; the startup contract is expiry => recover.
        let result: ResultAsyncType<number, PiChildRecoveryFailure> =
          okAsync(0);
        for (const candidate of records)
          result = result.andThen((count) =>
            this.recover(candidate).map(() => count + 1),
          );
        return result.map(() => "recovered" as const);
      });
    });
  }

  recoverByChildId(
    childId: string,
  ): ResultAsyncType<void, PiChildRecoveryFailure> {
    return this.candidates().andThen((records) => {
      const record = records.find((candidate) => candidate.childId === childId);
      return record === undefined
        ? unavailable("The child is not recoverable.")
        : this.recover(record);
    });
  }

  recoverAll(): ResultAsyncType<number, PiChildRecoveryFailure> {
    return this.candidates().andThen((records) => {
      let result: ResultAsyncType<number, PiChildRecoveryFailure> = okAsync(0);
      for (const record of records)
        result = result.andThen((count) =>
          this.recover(record).map(() => count + 1),
        );
      return result;
    });
  }

  private injectSettlementContent(
    output: string,
    count: number,
    generationId: string,
  ): ResultAsyncType<void, PiChildRecoveryFailure> {
    const injectParentContext = this.deps.injectParentContext;
    if (injectParentContext === undefined) return okAsync(undefined);
    if (!this.current(generationId))
      return unavailable("The recovery generation is stale.");
    const content = `Recovered child result:\n${output}\nInterventions: ${count}`;
    return safely(
      () => injectParentContext(content, { triggerTurn: false }),
      "Parent context injection failed.",
    )
      .andThen(() =>
        this.current(generationId)
          ? okAsync(undefined)
          : unavailable("The recovery generation is stale."),
      )
      .mapErr(() => ({ type: "ChildRecoverySpawnFailed" as const }));
  }
}
