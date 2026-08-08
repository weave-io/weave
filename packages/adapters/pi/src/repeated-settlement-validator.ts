import { err, ok, okAsync, type Result, ResultAsync } from "neverthrow";
import type { PiAdapterFailure, PiAdapterFailureCode } from "./errors.js";
import type { PiChildSettlement } from "./rpc-child.js";

export interface PiSettlementValidationRun {
  readonly index: number;
  readonly mode: "sequential" | "parallel";
  readonly sentinel: string;
}

export interface PiSettlementValidationObservation {
  readonly settlement: PiChildSettlement;
  /** Full private output captured by the inspector/history seam. */
  readonly privateOutput: string;
  /** Diagnostic only. Validation never searches log text. */
  readonly logs: readonly string[];
}

export interface PiRepeatedSettlementValidationOptions {
  readonly sequentialRuns: number;
  readonly maxParallelism: number;
  readonly run: (
    run: PiSettlementValidationRun,
  ) => ResultAsync<PiSettlementValidationObservation, PiAdapterFailure>;
}

export type PiRepeatedSettlementValidationError =
  | {
      readonly type: "InvalidConfiguration";
      readonly reason: "sequential-runs-below-ten" | "parallelism-below-one";
    }
  | {
      readonly type: "StructuredFailure";
      readonly run: PiSettlementValidationRun;
      readonly failureCode: PiAdapterFailureCode;
    }
  | {
      readonly type: "SettlementNotCompleted";
      readonly run: PiSettlementValidationRun;
      readonly outcome: PiChildSettlement["outcome"];
    }
  | {
      readonly type: "SentinelMissing";
      readonly run: PiSettlementValidationRun;
    }
  | {
      readonly type: "DuplicateSentinel";
      readonly sentinel: string;
    };

export interface PiRepeatedSettlementValidationReport {
  readonly validatedRuns: number;
  readonly sequentialRuns: number;
  readonly parallelRuns: number;
}

function createRun(
  mode: PiSettlementValidationRun["mode"],
  index: number,
): PiSettlementValidationRun {
  return {
    mode,
    index,
    sentinel: `PI_TERMINAL_SENTINEL_${mode.toUpperCase()}_${index}`,
  };
}

function validateObservation(
  run: PiSettlementValidationRun,
  observation: PiSettlementValidationObservation,
): Result<PiSettlementValidationRun, PiRepeatedSettlementValidationError> {
  if (observation.settlement.outcome !== "completed") {
    return err({
      type: "SettlementNotCompleted",
      run,
      outcome: observation.settlement.outcome,
    });
  }
  if (!observation.privateOutput.includes(run.sentinel)) {
    return err({ type: "SentinelMissing", run });
  }
  return ok(run);
}

function executeRun(
  options: PiRepeatedSettlementValidationOptions,
  run: PiSettlementValidationRun,
): ResultAsync<PiSettlementValidationRun, PiRepeatedSettlementValidationError> {
  return options
    .run(run)
    .mapErr(
      (failure): PiRepeatedSettlementValidationError => ({
        type: "StructuredFailure",
        run,
        failureCode: failure.code,
      }),
    )
    .andThen((observation) => validateObservation(run, observation));
}

function rejectDuplicateSentinels(
  runs: readonly PiSettlementValidationRun[],
): Result<readonly PiSettlementValidationRun[], PiRepeatedSettlementValidationError> {
  const seen = new Set<string>();
  for (const run of runs) {
    if (seen.has(run.sentinel)) {
      return err({ type: "DuplicateSentinel", sentinel: run.sentinel });
    }
    seen.add(run.sentinel);
  }
  return ok(runs);
}

/**
 * Runs the large-output settlement validator ten or more times in sequence,
 * then starts one batch at maximum child parallelism. It inspects structured
 * failures and private output directly; `logs` are accepted only as diagnostic
 * evidence and are never searched.
 */
export function validateRepeatedSettlements(
  options: PiRepeatedSettlementValidationOptions,
): ResultAsync<
  PiRepeatedSettlementValidationReport,
  PiRepeatedSettlementValidationError
> {
  if (options.sequentialRuns < 10) {
    return ResultAsync.fromSafePromise(
      Promise.resolve(
        err({
          type: "InvalidConfiguration" as const,
          reason: "sequential-runs-below-ten" as const,
        }),
      ),
    ).andThen((result) => result);
  }
  if (options.maxParallelism < 1) {
    return ResultAsync.fromSafePromise(
      Promise.resolve(
        err({
          type: "InvalidConfiguration" as const,
          reason: "parallelism-below-one" as const,
        }),
      ),
    ).andThen((result) => result);
  }

  let sequential = okAsync<
    readonly PiSettlementValidationRun[],
    PiRepeatedSettlementValidationError
  >([]);
  for (let index = 0; index < options.sequentialRuns; index += 1) {
    const run = createRun("sequential", index);
    sequential = sequential.andThen((completed) =>
      executeRun(options, run).map((validated) => [...completed, validated]),
    );
  }

  return sequential.andThen((sequentialRuns) => {
    // Construct every ResultAsync before combining them: each run starts now,
    // so this is a real full-parallelism batch rather than a serial loop.
    const parallel = Array.from(
      { length: options.maxParallelism },
      (_, index) => executeRun(options, createRun("parallel", index)),
    );
    return ResultAsync.combine(parallel)
      .andThen((parallelRuns) =>
        rejectDuplicateSentinels([...sequentialRuns, ...parallelRuns]),
      )
      .map((validated) => ({
        validatedRuns: validated.length,
        sequentialRuns: sequentialRuns.length,
        parallelRuns: options.maxParallelism,
      }));
  });
}
