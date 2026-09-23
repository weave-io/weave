/**
 * The text `weave eval compare` prints (Spec 37, task 18.2).
 *
 * Everything printed comes from a `RunComparison`: run IDs, commits, suite,
 * case and model identifiers, integer counts, rates, p-values, short prompt
 * hashes and the recorded judge. No prompt, transcript, answer or rationale
 * reaches this module — `RunBundleReader` never reads them.
 */

import type { ThemeColors } from "../theme/colors.js";
import type { ProportionInterval } from "./binomial-stats.js";
import {
  type ComparedSide,
  type ComparisonVerdict,
  describeJudge,
  type JudgeStatus,
  type PromptChange,
  type RunComparison,
  type SuiteModelComparison,
} from "./compare.js";

/** Characters of a SHA shown in the report. */
const SHORT_SHA = 7;
const SHORT_HASH = 12;

/** Renders a `RunComparison` as the text `weave eval compare` prints. */
export class ComparisonReport {
  constructor(private readonly theme: ThemeColors) {}

  render(comparison: RunComparison): string {
    const lines: string[] = [
      "",
      ...this.header(comparison),
      ...this.rule(comparison),
    ];
    let suite: string | null = null;
    for (const row of comparison.rows) {
      if (row.suite !== suite) {
        suite = row.suite;
        lines.push("", `  ${this.theme.bold(row.suite)}`);
      }
      lines.push(...this.rowLines(row));
    }
    lines.push("", ...this.footer(comparison), "");
    return lines.join("\n");
  }

  private header(comparison: RunComparison): string[] {
    const { baseline, candidate } = comparison;
    const models = new Set(comparison.rows.map((row) => row.modelId)).size;
    const cases = new Set(
      comparison.rows.flatMap((row) =>
        row.cases.map((c) => `${row.suite}/${c.caseId}`),
      ),
    ).size;
    return [
      `${this.theme.boldCyan("Eval compare")} ${baseline.runId} → ${candidate.runId}`,
      `  Commits:  ${baseline.gitSha.slice(0, SHORT_SHA)} → ${candidate.gitSha.slice(0, SHORT_SHA)}`,
      `  Design:   ${cases} ${plural(cases, "case")} × ${models} ${plural(models, "model")}, ` +
        `each case ${comparison.repeatCount} ${plural(comparison.repeatCount, "time")} per model`,
      `  Judge:    ${this.judgeLine(comparison.judge)}`,
      ...this.promptLines(comparison.promptChanges),
    ];
  }

  private judgeLine(status: JudgeStatus): string {
    if (status.kind === "same") return describeJudge(status.judge);
    const side = (judge: typeof status.baseline): string =>
      judge === null ? "not recorded" : describeJudge(judge);
    return this.theme.yellow(
      `unknown (baseline: ${side(status.baseline)}; candidate: ${side(status.candidate)}). ` +
        "Assuming both runs were scored by the same judge.",
    );
  }

  private promptLines(changes: readonly PromptChange[]): string[] {
    if (changes.length === 0) {
      return [
        `  Prompts:  ${this.theme.dim("no composed prompt changed between the runs")}`,
      ];
    }
    const hash = (value: string | null): string =>
      value === null ? "(none)" : value.slice(0, SHORT_HASH);
    return [
      `  Prompts:  ${changes.length} ${plural(changes.length, "agent")} changed`,
      ...changes.map(
        (change) =>
          `            ${change.agentName}  ${hash(change.baselineHash)} → ${hash(change.candidateHash)}`,
      ),
    ];
  }

  private rule(comparison: RunComparison): string[] {
    const alpha = comparison.significanceLevel;
    return [
      `  Rule:     Fisher's exact test per suite × model on scored attempts (errored ones left out), ` +
        `Holm-adjusted across ${comparison.testedRows} testable ${plural(comparison.testedRows, "row")}; ` +
        `a change is reported when the adjusted p < ${alpha}. Ranges are 95% Wilson intervals.`,
    ];
  }

  private rowLines(row: SuiteModelComparison): string[] {
    const lines = [
      `    ${row.modelId}`,
      `      ${this.side("baseline ", row.baseline)}`,
      `      ${this.side("candidate", row.candidate)}`,
      `      ${this.verdict(row)}`,
    ];
    const changed = row.cases.filter(
      (c) => c.baseline.passRate !== c.candidate.passRate,
    );
    if (changed.length === 0) return lines;
    lines.push(`      ${this.theme.dim("Cases whose pass rate moved:")}`);
    for (const c of changed) {
      lines.push(
        `        ${c.caseId}  ${counts(c.baseline)} → ${counts(c.candidate)}  ` +
          this.theme.dim(`(p ${formatP(c.pValue)}, unadjusted)`),
      );
    }
    return lines;
  }

  private side(label: string, side: ComparedSide): string {
    const errored =
      side.errored > 0
        ? this.theme.yellow(`, ${side.errored} errored left out`)
        : "";
    return `${label}  ${counts(side).padEnd(7)} ${formatRate(side.passRate)} ${formatInterval(side.interval)}${errored}`;
  }

  private verdict(row: SuiteModelComparison): string {
    const delta =
      row.difference === null
        ? ""
        : ` (${row.difference >= 0 ? "+" : ""}${Math.round(row.difference * 100)} points)`;
    const p =
      row.adjustedP === null
        ? ""
        : this.theme.dim(
            `  p ${formatP(row.pValue)}, Holm-adjusted p ${formatP(row.adjustedP)}`,
          );
    return `${this.verdictLabel(row.verdict)}${delta}${p}`;
  }

  private verdictLabel(verdict: ComparisonVerdict): string {
    switch (verdict) {
      case "improved":
        return this.theme.boldGreen("IMPROVED");
      case "regressed":
        return this.theme.boldRed("REGRESSED");
      case "no-detectable-change":
        return "no detectable change";
      case "too-few-attempts":
        return this.theme.yellow(
          "no detectable change: too few scored attempts for any difference to show; re-run both with a higher --repeat",
        );
      case "not-scored":
        return this.theme.yellow(
          "not compared: one run has no scored attempt (every attempt errored)",
        );
    }
  }

  private footer(comparison: RunComparison): string[] {
    const changed = comparison.rows.filter(
      (row) => row.verdict === "improved" || row.verdict === "regressed",
    ).length;
    if (changed > 0) {
      return [
        `  ${changed} suite × model ${plural(changed, "row")} changed beyond the noise.`,
      ];
    }
    return [
      "  No suite × model row changed beyond the noise. That does not show the runs are equal: " +
        "small samples only detect large changes.",
    ];
  }
}

function counts(side: ComparedSide): string {
  return `${side.passed}/${side.passed + side.failed}`;
}

function formatRate(rate: number | null): string {
  if (rate === null) return "  n/a";
  return `${String(Math.round(rate * 100)).padStart(3)}%`;
}

function formatInterval(interval: ProportionInterval | null): string {
  if (interval === null) return "";
  return `[${Math.round(interval.low * 100)}–${Math.round(interval.high * 100)}%]`;
}

/** `= 0.123`, or `< 0.001` for a p-value too small to print in 3 places. */
function formatP(p: number): string {
  if (p < 0.001) return "< 0.001";
  return `= ${p.toFixed(3)}`;
}

function plural(count: number, noun: string): string {
  if (count === 1) return noun;
  return `${noun}s`;
}
