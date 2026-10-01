/**
 * What `weave eval compare-models` prints (Spec 39 task 0.2): the text
 * report, and with `--json` a versioned machine-readable document that later
 * tooling can attach to the evidence of a recommended model list.
 *
 * Everything printed comes from a `ModelComparison`: run IDs, commits, suite,
 * case and model identifiers, counts, rates, p-values, the recorded judge,
 * mean costs and fixed sentences. No prompt, transcript, answer or rationale
 * reaches this module — `RunBundleReader` never reads them.
 */

import type { ThemeColors } from "../theme/colors.js";
import { type CostSummary, describeCost, formatUsd } from "./attempt-usage.js";
import { describeJudge } from "./compare.js";
import {
  counts,
  formatInterval,
  formatP,
  formatRate,
  plural,
} from "./compare-report.js";
import {
  type CaseGuard,
  DETECTABLE_DROP_REFERENCE_RATE,
  type ModelComparison,
  type ModelJudgeStatus,
  PUBLICATION_BAR,
  type SuiteModelComparison,
  type SuiteVerdict,
} from "./model-comparison.js";

const SHORT_SHA = 7;

/** The version of the `--json` document; bump on a breaking change. */
export const MODEL_COMPARISON_JSON_VERSION = 1;

/** The `--json` document: the comparison, with its format named. */
export interface ModelComparisonDocument extends ModelComparison {
  kind: "weave-eval-model-comparison";
  version: typeof MODEL_COMPARISON_JSON_VERSION;
  publicationBar: typeof PUBLICATION_BAR;
}

/** The comparison as the `--json` document. */
export function toModelComparisonDocument(
  comparison: ModelComparison,
): ModelComparisonDocument {
  return {
    kind: "weave-eval-model-comparison",
    version: MODEL_COMPARISON_JSON_VERSION,
    publicationBar: PUBLICATION_BAR,
    ...comparison,
  };
}

/** Renders a `ModelComparison` as the text `weave eval compare-models` prints. */
export class ModelComparisonReport {
  constructor(private readonly theme: ThemeColors) {}

  render(comparison: ModelComparison): string {
    const lines = ["", ...this.header(comparison)];
    for (const suite of comparison.suites) {
      lines.push("", ...this.suiteLines(suite));
    }
    lines.push("", ...this.footer(comparison), "");
    return lines.join("\n");
  }

  private header(comparison: ModelComparison): string[] {
    const { current, candidate } = comparison;
    const cases = comparison.suites.reduce((n, s) => n + s.caseCount, 0);
    const lines = [
      `${this.theme.boldCyan("Eval compare-models")} ${current.modelId} (current) → ${candidate.modelId} (candidate)`,
      `  Runs:     ${this.runsLine(comparison)}`,
      `  Commit:   ${comparison.gitSha.slice(0, SHORT_SHA)}`,
      `  Judge:    ${this.judgeLine(comparison.judge)}`,
      `  Config:   ${comparison.configMode}`,
      `  Track:    ${comparison.track === "text" ? "text" : this.theme.yellow("not restricted to --track text")}`,
      `  Design:   ${cases} ${plural(cases, "case")} in ${comparison.suites.length} ${plural(comparison.suites.length, "suite")}, ` +
        `each case ${comparison.repeats} ${plural(comparison.repeats, "time")} per model`,
      `  Rule:     Fisher's exact test per suite on scored attempts (errored ones left out), Holm-adjusted across ` +
        `${comparison.testedSuites} testable ${plural(comparison.testedSuites, "suite")}; significant when the adjusted ` +
        `p < ${comparison.significanceLevel}. Ranges are 95% Wilson intervals.`,
      `  Bar:      Spec 39 publication bar: at least ${PUBLICATION_BAR.minTextCases} text cases and ` +
        `${PUBLICATION_BAR.minRepeats} repeats, no significant drop, and no case at ` +
        `${percent(PUBLICATION_BAR.guardCurrentAtLeast)} or more on current below ` +
        `${percent(PUBLICATION_BAR.guardCandidateBelow)} on the candidate.`,
    ];
    if (comparison.minRepeats < PUBLICATION_BAR.minRepeats) {
      lines.push(
        `  ${this.theme.yellow(
          `--min-repeats ${comparison.minRepeats} is below the bar's ${PUBLICATION_BAR.minRepeats}: ` +
            "a comparison with fewer repeats fails the bar on every suite.",
        )}`,
      );
    }
    return lines;
  }

  private runsLine(comparison: ModelComparison): string {
    if (comparison.oneRun) {
      return `${comparison.current.run.runId} (both models)`;
    }
    return `${comparison.current.run.runId} (current), ${comparison.candidate.run.runId} (candidate)`;
  }

  private judgeLine(status: ModelJudgeStatus): string {
    if (status.kind === "same") {
      if (status.judge !== null) return describeJudge(status.judge);
      return this.theme.dim("not recorded (one run, so both models share it)");
    }
    const side = (judge: typeof status.current): string =>
      judge === null ? "not recorded" : describeJudge(judge);
    return this.theme.yellow(
      `unknown (current: ${side(status.current)}; candidate: ${side(status.candidate)})`,
    );
  }

  private suiteLines(suite: SuiteModelComparison): string[] {
    return [
      `  ${this.theme.bold(suite.suite)}  ${this.theme.dim(`(${suite.caseCount} ${plural(suite.caseCount, "case")})`)}`,
      `    ${this.side("current  ", suite.current)}`,
      `    ${this.side("candidate", suite.candidate)}`,
      `    ${this.verdict(suite)}`,
      `    ${this.detectable(suite)}`,
      ...this.guardLines(suite.cases),
      ...this.costLines(suite),
      `    ${this.barLine(suite)}`,
      `    ${this.theme.dim("Not checked here:")}`,
      ...suite.bar.notCheckedHere.map(
        (step) => `      ${this.theme.dim(`- ${step}`)}`,
      ),
    ];
  }

  private side(label: string, side: SuiteModelComparison["current"]): string {
    const errored =
      side.errored > 0
        ? this.theme.yellow(`, ${side.errored} errored left out`)
        : "";
    return `${label}  ${counts(side).padEnd(7)} ${formatRate(side.passRate)} ${formatInterval(side.interval)}${errored}`;
  }

  private verdict(suite: SuiteModelComparison): string {
    const delta =
      suite.difference === null
        ? ""
        : ` (${suite.difference >= 0 ? "+" : ""}${Math.round(suite.difference * 100)} points)`;
    const p =
      suite.adjustedP === null
        ? ""
        : this.theme.dim(
            `  p ${formatP(suite.pValue)}, Holm-adjusted p ${formatP(suite.adjustedP)}`,
          );
    return `${this.verdictLabel(suite.verdict)}${delta}${p}`;
  }

  private verdictLabel(verdict: SuiteVerdict): string {
    switch (verdict) {
      case "significantly-worse":
        return this.theme.boldRed("SIGNIFICANTLY WORSE");
      case "significantly-better":
        return this.theme.boldGreen("SIGNIFICANTLY BETTER");
      case "no-significant-difference":
        return "no significant difference";
      case "not-testable":
        return this.theme.yellow(
          "not tested: a model has too few scored attempts for any difference to show",
        );
    }
  }

  private detectable(suite: SuiteModelComparison): string {
    const reference = percent(DETECTABLE_DROP_REFERENCE_RATE);
    if (suite.smallestDetectableDrop === null) {
      return this.theme.yellow(
        `Smallest detectable drop: none at this size (from ${reference})`,
      );
    }
    const points = Math.round(suite.smallestDetectableDrop * 100);
    return this.theme.dim(
      `Smallest detectable drop at this size: ${points} points from ${reference}, before Holm's adjustment`,
    );
  }

  private guardLines(cases: readonly CaseGuard[]): string[] {
    const failed = cases.filter((c) => c.status === "fail");
    const unscored = cases.filter((c) => c.status === "not-scored");
    const guarded = cases.filter((c) => c.status !== "not-applicable").length;
    const lines: string[] = [];
    if (failed.length === 0 && unscored.length === 0) {
      lines.push(
        `    Per-case guard: passed (${guarded} ${plural(guarded, "case")} at ` +
          `${percent(PUBLICATION_BAR.guardCurrentAtLeast)} or more on current)`,
      );
      return lines;
    }
    if (failed.length > 0) {
      lines.push(
        `    Per-case guard: ${this.theme.boldRed("FAILED")} on ${failed.length} ${plural(failed.length, "case")}`,
      );
    } else {
      lines.push(
        `    Per-case guard: ${this.theme.yellow("not checked")} on ${unscored.length} ${plural(unscored.length, "case")}`,
      );
    }
    for (const c of [...failed, ...unscored]) {
      const note = c.status === "not-scored" ? "  (every attempt errored)" : "";
      lines.push(
        `      ${c.caseId}  ${counts(c.current)} ${formatRate(c.current.passRate).trim()} → ` +
          `${counts(c.candidate)} ${formatRate(c.candidate.passRate).trim()}${note}`,
      );
    }
    return lines;
  }

  private costLines(suite: SuiteModelComparison): string[] {
    const { current, candidate, difference } = suite.cost;
    return [
      `    Cost per attempt, model calls: ${this.costPair(current.model, candidate.model, difference.model)}`,
      `    Cost per attempt, judge calls: ${this.costPair(current.judge, candidate.judge, difference.judge)}`,
    ];
  }

  private costPair(
    current: CostSummary,
    candidate: CostSummary,
    delta: number | null,
  ): string {
    const change = delta === null ? "" : ` (${signedUsd(delta)})`;
    return `${this.cost(current)} → ${this.cost(candidate)}${change}`;
  }

  private cost(summary: CostSummary): string {
    const described = describeCost(summary);
    if (summary.meanUsd === null) return this.theme.yellow(described.mean);
    if (described.missing === null) return described.mean;
    return `${described.mean} ${this.theme.yellow(`(${described.missing}, left out of the mean)`)}`;
  }

  private barLine(suite: SuiteModelComparison): string {
    if (suite.bar.verdict === "pass") {
      return `Publication bar: ${this.theme.boldGreen("PASS")}`;
    }
    return `Publication bar: ${this.theme.boldRed("FAIL")} — ${suite.bar.reasons.join("; ")}`;
  }

  private footer(comparison: ModelComparison): string[] {
    const passed = comparison.suites.filter((s) => s.bar.verdict === "pass");
    return [
      `  Suites clearing the publication bar steps a comparison can check: ${passed.length} of ${comparison.suites.length}.`,
    ];
  }
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** `+$0.0123` or `-$0.0123`. */
function signedUsd(usd: number): string {
  if (usd === 0) return "same";
  const sign = usd > 0 ? "+" : "-";
  return `${sign}${formatUsd(Math.abs(usd))}`;
}
