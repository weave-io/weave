import { okAsync, type ResultAsync } from "neverthrow";
import {
  type LiveProofFailureCode,
  type LiveProofReport,
  parseLiveProofArgs,
} from "./child-stream-live-proof-contract.js";
import {
  createLiveProofPort,
  type LiveProofPortConfig,
} from "./child-stream-live-proof-port.js";
import { writeLiveProofReport } from "./child-stream-live-proof-report-writer.js";
import {
  type LiveProofPort,
  runLiveProof,
} from "./child-stream-live-proof-runner.js";
import {
  createLiveProofSystem,
  type LiveProofSystem,
} from "./child-stream-live-proof-system.js";

export interface LiveProofCommandOutcome {
  readonly exitCode: 0 | 1;
  readonly line: string;
  readonly report: LiveProofReport | undefined;
}

export interface LiveProofCommandInput {
  readonly argv: readonly string[];
  readonly repoRoot: string;
  readonly system?: LiveProofSystem;
  /** Test seam. Production builds the real port from the parsed arguments. */
  readonly createPort?: (config: LiveProofPortConfig) => LiveProofPort;
  readonly guardedResources?: LiveProofPortConfig["guardedResources"];
}

function statusLine(input: {
  readonly passed: boolean;
  readonly report: LiveProofReport | undefined;
  readonly reason: LiveProofFailureCode;
}): string {
  if (input.passed && input.report !== undefined) {
    return `live: verified; evidence=content-free; lanes=${input.report.lanes.length}; cleanup=${input.report.cleanup}`;
  }
  return `live: blocked; evidence=content-free; reason=${input.reason}`;
}

function firstFailure(report: LiveProofReport): LiveProofFailureCode {
  const failure = report.failures[0];
  return failure ?? "lane-failed";
}

/**
 * A report is a pass only when every lane passed and every containment,
 * lifecycle, registry, diagnostic, and cleanup status is clean. Anything else
 * is a nonzero exit, including a cleanup failure after green lanes.
 */
export function liveProofReportPassed(report: LiveProofReport): boolean {
  return (
    report.identity.currentBuild === "current" &&
    report.identity.freshParent === "fresh" &&
    report.lanes.every((lane) => lane.status === "pass") &&
    report.isolation === "isolated" &&
    report.settlement === "settled" &&
    report.registry === "empty" &&
    report.diagnostics === "clean" &&
    report.cleanup === "complete" &&
    report.failures.length === 0
  );
}

/**
 * Run the documented `verify-child-streaming live` command.
 *
 * Argument parsing, orchestration, and report writing are separate closed
 * stages. The command returns a content-free status line and an exit code; it
 * never returns host text, and it writes nothing when the arguments are
 * invalid.
 */
export function runLiveProofCommand(
  input: LiveProofCommandInput,
): ResultAsync<LiveProofCommandOutcome, never> {
  const parsed = parseLiveProofArgs(input.argv);
  if (parsed.isErr()) {
    return okAsync({
      exitCode: 1,
      line: statusLine({
        passed: false,
        report: undefined,
        reason:
          parsed.error.reason === "invalid-command"
            ? "invalid-args"
            : parsed.error.reason,
      }),
      report: undefined,
    });
  }

  const args = parsed.value;
  const system = input.system ?? createLiveProofSystem();
  const portConfig: LiveProofPortConfig = {
    repoRoot: input.repoRoot,
    system,
    ...(input.guardedResources === undefined
      ? {}
      : { guardedResources: input.guardedResources }),
  };
  const port = (input.createPort ?? createLiveProofPort)(portConfig);

  return runLiveProof({ args, port }).andThen((report) =>
    writeLiveProofReport({
      system,
      target: args.contentFreeReport,
      report,
    })
      .map(() => {
        const passed = liveProofReportPassed(report);
        return {
          exitCode: passed ? (0 as const) : (1 as const),
          line: statusLine({
            passed,
            report,
            reason: firstFailure(report),
          }),
          report,
        };
      })
      .orElse((failure) =>
        okAsync<LiveProofCommandOutcome, never>({
          exitCode: 1,
          line: statusLine({
            passed: false,
            report: undefined,
            reason: failure.code,
          }),
          report,
        }),
      ),
  );
}
