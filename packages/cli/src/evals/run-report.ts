/**
 * The report `weave eval run` prints after a live run (Spec 37, task 17.2).
 *
 * For every case × model result it prints the verdict. A failed case also
 * gets each applicable scoring dimension with its score, marked where it fell
 * below its bar, the case's bounded public explanation, and the path of its
 * raw transcript — so running one case for one model is enough to see why it
 * failed without opening the bundle.
 *
 * With `--repeat N` (N > 1) it prints one block per case × model instead: the
 * pass rate over the repeats (errored attempts left out and counted
 * separately), then the same breakdown for each attempt that did not pass.
 *
 * What it prints is limited to the publishable `CaseReport` fields plus local
 * paths. The transcript, the model's answer, the composed prompt and the
 * judge's rationales stay in the raw artifact file, which exists only under
 * `--raw-artifacts` (rejected in CI). The report can therefore go to a CI log
 * without disclosing anything the published bundle does not.
 */

import type { ThemeColors } from "../theme/colors.js";
import {
  PASS_THRESHOLD,
  PRIMARY_STRUCTURAL_PASS_THRESHOLD,
} from "./langchain-agent-evals.js";
import { tallyAttempts } from "./pass-rates.js";
import type { CaseReport, EvalRunSummary } from "./runner.js";
import { QUALITATIVE_PASS_THRESHOLD } from "./tapestry-category-routing-runner.js";
import type { ScoringDimension } from "./types.js";

/**
 * The dimensions in print order, with the score each has to reach.
 *
 * A structural dimension (routing, delegation, execution) is what a case
 * passes on: the scorer passes a case outright when one reaches
 * `PRIMARY_STRUCTURAL_PASS_THRESHOLD`. `rationaleQuality` never passes a case
 * on its own; its bar is the qualitative gate `QUALITATIVE_PASS_THRESHOLD`
 * that category-routing cases enforce, and elsewhere a low score only pulls
 * the weighted total down.
 */
const DIMENSION_BARS: ReadonlyArray<{
  dimension: ScoringDimension;
  bar: number;
}> = [
  { dimension: "routingCorrectness", bar: PRIMARY_STRUCTURAL_PASS_THRESHOLD },
  {
    dimension: "delegationCorrectness",
    bar: PRIMARY_STRUCTURAL_PASS_THRESHOLD,
  },
  {
    dimension: "executionCompleteness",
    bar: PRIMARY_STRUCTURAL_PASS_THRESHOLD,
  },
  { dimension: "rationaleQuality", bar: QUALITATIVE_PASS_THRESHOLD },
];

const DIMENSION_COLUMN = Math.max(
  ...DIMENSION_BARS.map(({ dimension }) => dimension.length),
);

/** Renders an `EvalRunSummary` as the text `weave eval run` prints. */
export class EvalRunReport {
  constructor(private readonly theme: ThemeColors) {}

  render(summary: EvalRunSummary): string {
    const lines: string[] = ["", ...this.header(summary)];
    if (summary.metadata.repeatCount > 1) {
      for (const group of groupRepeats(summary.caseReports)) {
        lines.push("", ...this.repeatLines(group));
      }
    } else {
      for (const report of summary.caseReports) {
        lines.push("", ...this.caseLines(report));
      }
    }
    lines.push(...this.footer(summary), "");
    return lines.join("\n");
  }

  private header(summary: EvalRunSummary): string[] {
    const counts = this.headerCounts(summary);
    const title = `${this.theme.boldCyan("Eval run")} ${summary.runId ?? "(no run written)"}: ${counts}`;
    if (summary.runId === null) return [title];
    return [title, `  ${this.whereWritten(summary)}`];
  }

  private headerCounts(summary: EvalRunSummary): string {
    const tail = `${summary.passedCases} passed, ${summary.failedCases} failed`;
    const repeatCount = summary.metadata.repeatCount;
    if (repeatCount <= 1) {
      return `${summary.totalCases} ${plural(summary.totalCases, "case")}, ${tail}`;
    }
    return (
      `${summary.totalCases} ${plural(summary.totalCases, "attempt")} ` +
      `(each case ${repeatCount} times per model), ${tail}`
    );
  }

  /**
   * One case × model over its repeats: the pass rate, then each attempt that
   * did not pass with its dimensions, explanation and transcript path.
   */
  private repeatLines(attempts: readonly CaseReport[]): string[] {
    const first = attempts[0];
    if (first === undefined) return [];
    const tally = tallyAttempts(attempts);
    const scored = tally.passed + tally.failed;
    const requirement = first.required ? "required" : "optional";
    const lines = [
      `  ${this.repeatVerdict(tally)}  ${tally.passed}/${scored} passed  ${first.caseId} on ${first.modelId}  ${this.theme.dim(`(${first.suite}, ${requirement})`)}`,
    ];
    if (tally.errored > 0) {
      lines.push(
        `        ${tally.errored} errored ${plural(tally.errored, "attempt")} left out of the pass rate`,
      );
    }
    for (const report of attempts) {
      if (report.passed) continue;
      lines.push(...this.missedAttemptLines(report));
    }
    return lines;
  }

  private repeatVerdict(tally: {
    passed: number;
    failed: number;
    passRate: number | null;
  }): string {
    if (tally.passRate === null) return this.theme.boldRed("ERRORED");
    if (tally.failed === 0) return this.theme.boldGreen("PASS");
    if (tally.passed === 0) return this.theme.boldRed("FAIL");
    return this.theme.yellow("FLAKY");
  }

  private missedAttemptLines(report: CaseReport): string[] {
    const label = `        Attempt ${report.attempt ?? 1}:`;
    if (report.errored) {
      return [
        `${label} ${this.theme.boldRed("ERRORED")} (no scorable answer)`,
        ...this.transcriptLines(report),
      ];
    }
    const lines = [
      `${label} ${this.theme.boldRed("FAIL")}  weighted total ${score(report.weightedTotal)} (pass mark ${score(PASS_THRESHOLD)})`,
      ...this.dimensionLines(report),
    ];
    if (report.publicExplanation !== null) {
      lines.push(`        Why: ${report.publicExplanation}`);
    }
    lines.push(...this.transcriptLines(report));
    return lines;
  }

  private whereWritten(summary: EvalRunSummary): string {
    if (summary.metadata.publishMode === "publish") {
      return `Bundle: ${summary.bundleDir} (publish mode: sent to the results repository)`;
    }
    return `Bundle: ${summary.bundleDir} (local only; nothing was published)`;
  }

  private caseLines(report: CaseReport): string[] {
    const verdict = report.passed
      ? this.theme.boldGreen("PASS")
      : this.theme.boldRed("FAIL");
    const requirement = report.required ? "required" : "optional";
    const lines = [
      `  ${verdict}  ${report.caseId} on ${report.modelId}  ${this.theme.dim(`(${report.suite}, ${requirement})`)}`,
      `        Weighted total ${score(report.weightedTotal)} (pass mark ${score(PASS_THRESHOLD)})`,
    ];

    if (!report.passed) {
      lines.push(...this.dimensionLines(report));
      if (report.publicExplanation !== null) {
        lines.push(`        Why: ${report.publicExplanation}`);
      }
    }

    lines.push(...this.transcriptLines(report));
    return lines;
  }

  /**
   * The transcript path, or — when `--raw-artifacts` was given but this case
   * has none — a line saying why, rather than a silence the footer (which
   * only covers runs without the flag) would not explain.
   */
  private transcriptLines(report: CaseReport): string[] {
    if (report.rawArtifactPath !== null) {
      return [`        Raw transcript: ${report.rawArtifactPath}`];
    }
    if (report.rawArtifactMissing === null) return [];
    const reason =
      report.rawArtifactMissing === "NotProduced"
        ? "the runner produced no raw artifact for this case"
        : `writing it failed (${report.rawArtifactMissing})`;
    return [
      `        Raw transcript: ${this.theme.yellow("not written")} — ${reason}`,
    ];
  }

  private dimensionLines(report: CaseReport): string[] {
    return DIMENSION_BARS.flatMap(({ dimension, bar }) => {
      const entry = report.dimensionScores[dimension];
      if (!entry.applicable) return [];
      const name = dimension.padEnd(DIMENSION_COLUMN);
      if (entry.score < bar) {
        return [
          `        ${this.theme.red("✗")} ${name}  ${score(entry.score)}  below ${score(bar)}`,
        ];
      }
      return [
        `        ${this.theme.green("✓")} ${name}  ${score(entry.score)}`,
      ];
    });
  }

  private footer(summary: EvalRunSummary): string[] {
    if (summary.caseReports.length === 0) return [];
    if (summary.metadata.rawArtifactsEnabled) return [];
    return [
      "",
      this.theme.dim(
        "  Raw transcripts were not written. Re-run with --raw-artifacts to keep them locally (not available in CI).",
      ),
    ];
  }
}

/**
 * Group case reports by suite, case and model, keeping the order in which
 * each group first appears. Attempts inside a group keep run order.
 */
function groupRepeats(reports: readonly CaseReport[]): CaseReport[][] {
  const groups = new Map<string, CaseReport[]>();
  for (const report of reports) {
    const key = `${report.suite}\u0000${report.caseId}\u0000${report.modelId}`;
    const group = groups.get(key) ?? [];
    group.push(report);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function score(value: number): string {
  return value.toFixed(2);
}

function plural(count: number, noun: string): string {
  if (count === 1) return noun;
  return `${noun}s`;
}
