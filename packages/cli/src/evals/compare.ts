/**
 * `weave eval compare <baseline> <candidate>` (Spec 37, task 18.2).
 *
 * Reads two local run bundles and states, per suite × model, whether the
 * candidate's pass rate differs from the baseline's by more than chance
 * allows. The statistics live in `binomial-stats.ts`; this module owns
 * reading the bundles, refusing comparisons that would mislead, and building
 * the comparison.
 *
 * # What a bundle contributes
 *
 * Only sanitized, publishable-grade files are read from a run directory:
 * `bundle-index.json` (run ID, commit, suites, repeat count), each suite's
 * `score-<suite>.json` (one row per attempt: case, model, passed, errored),
 * `prompt-hashes.json` (agent → SHA-256) and, where present, a recorded
 * judge. The `raw/` directory — prompts, transcripts, answers, rationales —
 * is never opened, and nothing printed is taken from a free-text field.
 *
 * # What makes two runs comparable
 *
 * Prompt hashes are *expected* to differ: that is what a comparison is for.
 * The rest of the design must match, or the difference in pass rates could
 * come from the design rather than the prompts:
 *
 * - the same case × model pairs (`CaseSetMismatch`, `ModelSetMismatch`);
 * - the same repeat count (`RepeatCountMismatch`);
 * - the same judge, when both runs record one (`JudgeMismatch`). A run that
 *   records none — every run before task 16.4 — has an **unknown** judge;
 *   the comparison proceeds and says so on every report;
 * - neither run a dry run (`DryRunBundle`).
 *
 * Refusals are typed `CompareError` values; nothing here throws.
 */

import { join } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { FileSystem } from "../fs/file-system.js";
import {
  bestPossibleP,
  fisherExactTwoSided,
  holmAdjust,
  type ProportionInterval,
  SIGNIFICANCE_LEVEL,
  wilsonInterval,
} from "./binomial-stats.js";
import { type AttemptTally, tallyAttempts } from "./pass-rates.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The judge that scored a run, as recorded in its bundle (task 16.4). */
export interface JudgeRecord {
  id: string;
  version: string | null;
}

/** One scored attempt, as a comparison needs it. */
export interface ComparedAttempt {
  suite: string;
  caseId: string;
  modelId: string;
  passed: boolean;
  errored: boolean;
}

/** What `eval compare` reads from one run directory. */
export interface RunSnapshot {
  /** The argument the user gave (a path or a run ID). */
  ref: string;
  /** The resolved run directory. */
  dir: string;
  runId: string;
  gitSha: string;
  dryRun: boolean;
  /** How many times each case ran per model; 1 without `--repeat`. */
  repeatCount: number;
  /** The recorded judge, or `null` when the bundle records none. */
  judge: JudgeRecord | null;
  /** Agent name → composed-prompt SHA-256. */
  promptHashes: Map<string, string>;
  attempts: ComparedAttempt[];
}

/** Why two bundles could not be compared. */
export type CompareError =
  | {
      /** No run directory with a `bundle-index.json` was found for `ref`. */
      type: "BundleNotFound";
      ref: string;
      /** The paths that were tried. */
      tried: string[];
      message: string;
    }
  | {
      /** A bundle file could not be read or is not valid JSON. */
      type: "BundleUnreadable";
      path: string;
      message: string;
    }
  | {
      /** A bundle file is valid JSON but not the shape `eval compare` reads. */
      type: "BundleInvalid";
      path: string;
      message: string;
    }
  | {
      /** A dry run scores nothing, so it has no pass rate to compare. */
      type: "DryRunBundle";
      ref: string;
      message: string;
    }
  | {
      /** The runs used different models. */
      type: "ModelSetMismatch";
      onlyInBaseline: string[];
      onlyInCandidate: string[];
      message: string;
    }
  | {
      /** The runs ran different cases, or different case × model pairs. */
      type: "CaseSetMismatch";
      onlyInBaseline: string[];
      onlyInCandidate: string[];
      message: string;
    }
  | {
      /** The runs repeated each case a different number of times. */
      type: "RepeatCountMismatch";
      baseline: number;
      candidate: number;
      message: string;
    }
  | {
      /** Both runs record a judge, and they are not the same judge. */
      type: "JudgeMismatch";
      baseline: JudgeRecord;
      candidate: JudgeRecord;
      message: string;
    };

/** The verdict for one suite × model. */
export type ComparisonVerdict =
  /** The candidate passes more often, beyond chance (Holm-adjusted). */
  | "improved"
  /** The candidate passes less often, beyond chance (Holm-adjusted). */
  | "regressed"
  /** The test could have detected a change, and did not. */
  | "no-detectable-change"
  /** No outcome at this sample size could reach significance. */
  | "too-few-attempts"
  /** One side has no scored attempt (every attempt errored). */
  | "not-scored";

/** One side of a comparison row. */
export interface ComparedSide extends AttemptTally {
  /** 95% Wilson interval on `passRate`, or `null` when nothing was scored. */
  interval: ProportionInterval | null;
}

/** One case on one model, for locating where a suite-level change came from. */
export interface CaseComparison {
  caseId: string;
  baseline: ComparedSide;
  candidate: ComparedSide;
  /** Unadjusted two-sided Fisher p; descriptive only, no verdict. */
  pValue: number;
}

/** One suite on one model. */
export interface SuiteModelComparison {
  suite: string;
  modelId: string;
  baseline: ComparedSide;
  candidate: ComparedSide;
  /** Candidate minus baseline pass rate, or `null` when a side is unscored. */
  difference: number | null;
  /** Two-sided Fisher p for this row alone. */
  pValue: number;
  /** Holm-adjusted p across the testable rows, or `null` when not tested. */
  adjustedP: number | null;
  verdict: ComparisonVerdict;
  cases: CaseComparison[];
}

/** An agent whose composed prompt differs between the two runs. */
export interface PromptChange {
  agentName: string;
  baselineHash: string | null;
  candidateHash: string | null;
}

/** How the judge compares across the two runs. */
export type JudgeStatus =
  | { kind: "same"; judge: JudgeRecord }
  | {
      kind: "unknown";
      baseline: JudgeRecord | null;
      candidate: JudgeRecord | null;
    };

/** A full comparison, ready to print. */
export interface RunComparison {
  baseline: RunSnapshot;
  candidate: RunSnapshot;
  repeatCount: number;
  judge: JudgeStatus;
  promptChanges: PromptChange[];
  /** Rows tested together under Holm's adjustment. */
  testedRows: number;
  significanceLevel: number;
  rows: SuiteModelComparison[];
}

// ---------------------------------------------------------------------------
// Bundle file shapes (only the fields read; unknown keys are ignored)
// ---------------------------------------------------------------------------

/** A suite name becomes a file name, so it must be a plain identifier. */
const SuiteNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "suite names must be plain identifiers");

const JudgeRecordSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1).optional(),
});

const BundleIndexSchema = z.object({
  runId: z.string().min(1),
  gitSha: z.string().min(1),
  dryRun: z.boolean(),
  runSummary: z.object({
    suites: z.array(SuiteNameSchema),
    repeatCount: z.number().int().min(2).optional(),
  }),
  judge: JudgeRecordSchema.optional(),
});

const ScoreFileSchema = z.object({
  suite: SuiteNameSchema,
  repeatCount: z.number().int().min(2).optional(),
  results: z.array(
    z.object({
      caseId: z.string().min(1),
      modelId: z.string().min(1),
      passed: z.boolean(),
      errored: z.boolean().optional(),
    }),
  ),
});

const PromptHashesSchema = z.object({
  promptHashes: z.array(
    z.object({ agentName: z.string().min(1), hash: z.string().min(1) }),
  ),
});

/** Where a judge may be recorded, besides `bundle-index.json`. */
const JudgeCarrierSchema = z.object({ judge: JudgeRecordSchema.optional() });

const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------------------
// Reading a bundle
// ---------------------------------------------------------------------------

/**
 * Reads the parts of a local run bundle `eval compare` needs, through the
 * CLI's injected `FileSystem`.
 */
export class RunBundleReader {
  constructor(private readonly fs: FileSystem) {}

  /**
   * Read the run named by `ref`: a run directory path, or a run ID looked up
   * under `eval-bundles/runs/` in the working directory.
   */
  read(ref: string): ResultAsync<RunSnapshot, CompareError> {
    return this.resolveDir(ref).andThen((dir) =>
      this.readJson(join(dir, "bundle-index.json"), BundleIndexSchema).andThen(
        (index) =>
          ResultAsync.combine(
            index.runSummary.suites.map((suite) =>
              this.readJson(join(dir, `score-${suite}.json`), ScoreFileSchema),
            ),
          ).andThen((scoreFiles) =>
            ResultAsync.combine([
              this.readPromptHashes(dir),
              this.readJudge(dir, index.judge),
            ]).map(([promptHashes, judge]) => ({
              ref,
              dir,
              runId: index.runId,
              gitSha: index.gitSha,
              dryRun: index.dryRun,
              repeatCount: index.runSummary.repeatCount ?? 1,
              judge,
              promptHashes: promptHashes as Map<string, string>,
              attempts: scoreFiles.flatMap((file) =>
                file.results.map((row) => ({
                  suite: file.suite,
                  caseId: row.caseId,
                  modelId: row.modelId,
                  passed: row.passed,
                  errored: row.errored === true,
                })),
              ),
            })),
          ),
      ),
    );
  }

  private resolveDir(ref: string): ResultAsync<string, CompareError> {
    const candidates = [this.fs.resolvePath(ref)];
    if (RUN_ID_RE.test(ref)) {
      candidates.push(this.fs.resolvePath(join("eval-bundles", "runs", ref)));
    }
    const check = async (): Promise<string | null> => {
      for (const dir of candidates) {
        const found = await this.fs.exists(join(dir, "bundle-index.json"));
        if (found.isOk() && found.value) return dir;
      }
      return null;
    };
    return ResultAsync.fromSafePromise(check()).andThen((dir) => {
      if (dir !== null) return ok(dir);
      return err<string, CompareError>({
        type: "BundleNotFound",
        ref,
        tried: candidates,
        message:
          `No eval run found for "${ref}": no bundle-index.json in ` +
          `${candidates.join(" or ")}. Pass a run directory ` +
          "(eval-bundles/runs/<runId>) or a run ID.",
      });
    });
  }

  private readJson<T>(
    path: string,
    schema: z.ZodType<T>,
  ): ResultAsync<T, CompareError> {
    return this.fs
      .readText(path)
      .mapErr(
        (): CompareError => ({
          type: "BundleUnreadable",
          path,
          message: `Could not read ${path}.`,
        }),
      )
      .andThen((text) => this.parseJson(path, text, schema));
  }

  private parseJson<T>(
    path: string,
    text: string,
    schema: z.ZodType<T>,
  ): Result<T, CompareError> {
    const json = Result.fromThrowable(
      () => JSON.parse(text) as unknown,
      (): CompareError => ({
        type: "BundleUnreadable",
        path,
        message: `${path} is not valid JSON.`,
      }),
    )();
    if (json.isErr()) return err(json.error);
    const parsed = schema.safeParse(json.value);
    if (parsed.success) return ok(parsed.data);
    const issue = parsed.error.issues[0];
    const where = issue !== undefined ? issue.path.join(".") : "";
    return err({
      type: "BundleInvalid",
      path,
      message: `${path} is not an eval bundle file eval compare can read (${where}: ${issue?.message ?? "invalid"}).`,
    });
  }

  /** `prompt-hashes.json` is optional: a run without provenance has none. */
  private readPromptHashes(
    dir: string,
  ): ResultAsync<Map<string, string>, CompareError> {
    const path = join(dir, "prompt-hashes.json");
    return this.optionalJson(path, PromptHashesSchema).map(
      (file) =>
        new Map(
          (file?.promptHashes ?? []).map((record) => [
            record.agentName,
            record.hash,
          ]),
        ),
    );
  }

  /**
   * The judge that scored the run: `bundle-index.json`'s `judge`, else the
   * `judge` of `public-report.json` or `provenance-manifest.json`. `null`
   * when none records one (every run before task 16.4).
   */
  private readJudge(
    dir: string,
    fromIndex: z.infer<typeof JudgeRecordSchema> | undefined,
  ): ResultAsync<JudgeRecord | null, CompareError> {
    if (fromIndex !== undefined) {
      return ResultAsync.fromSafePromise(
        Promise.resolve(toJudgeRecord(fromIndex)),
      );
    }
    return this.optionalJson(
      join(dir, "public-report.json"),
      JudgeCarrierSchema,
    ).andThen((report) => {
      if (report?.judge !== undefined) {
        return ResultAsync.fromSafePromise(
          Promise.resolve<JudgeRecord | null>(toJudgeRecord(report.judge)),
        );
      }
      return this.optionalJson(
        join(dir, "provenance-manifest.json"),
        JudgeCarrierSchema,
      ).map((manifest) =>
        manifest?.judge !== undefined ? toJudgeRecord(manifest.judge) : null,
      );
    });
  }

  private optionalJson<T>(
    path: string,
    schema: z.ZodType<T>,
  ): ResultAsync<T | null, CompareError> {
    return this.fs
      .exists(path)
      .orElse(() => ok(false))
      .andThen((found) => {
        if (!found) {
          return ResultAsync.fromSafePromise(Promise.resolve<T | null>(null));
        }
        return this.readJson(path, schema).map((value): T | null => value);
      });
  }
}

function toJudgeRecord(raw: z.infer<typeof JudgeRecordSchema>): JudgeRecord {
  return { id: raw.id, version: raw.version ?? null };
}

// ---------------------------------------------------------------------------
// Comparing two snapshots
// ---------------------------------------------------------------------------

/**
 * Compare two run snapshots, or refuse with the reason they cannot be.
 *
 * Checks, in order: dry runs, judge, models, case × model pairs, repeat
 * count. Then, per suite × model, a two-sided Fisher's exact test on scored
 * attempts (errored ones left out), Holm-adjusted across every row that
 * could reach significance at its sample size.
 */
export function compareRuns(
  baseline: RunSnapshot,
  candidate: RunSnapshot,
): Result<RunComparison, CompareError> {
  const refusal = checkComparable(baseline, candidate);
  if (refusal !== null) return err(refusal);

  const rows = buildRows(baseline, candidate);
  const testable = rows.filter((row) => row.testable);
  const adjusted = holmAdjust(testable.map((row) => row.pValue));
  const adjustedByKey = new Map(
    testable.map((row, index) => [row.key, adjusted[index] ?? 1]),
  );

  return ok({
    baseline,
    candidate,
    repeatCount: baseline.repeatCount,
    judge: judgeStatus(baseline.judge, candidate.judge),
    promptChanges: promptChanges(baseline, candidate),
    testedRows: testable.length,
    significanceLevel: SIGNIFICANCE_LEVEL,
    rows: rows.map((row) => finishRow(row, adjustedByKey.get(row.key))),
  });
}

function checkComparable(
  baseline: RunSnapshot,
  candidate: RunSnapshot,
): CompareError | null {
  for (const run of [baseline, candidate]) {
    if (!run.dryRun) continue;
    return {
      type: "DryRunBundle",
      ref: run.ref,
      message: `Run ${run.runId} is a dry run: it scored nothing, so it has no pass rate to compare.`,
    };
  }

  const judgeRefusal = checkJudges(baseline.judge, candidate.judge);
  if (judgeRefusal !== null) return judgeRefusal;

  const models = difference(
    baseline.attempts.map((a) => a.modelId),
    candidate.attempts.map((a) => a.modelId),
  );
  if (models.onlyInBaseline.length > 0 || models.onlyInCandidate.length > 0) {
    return {
      type: "ModelSetMismatch",
      ...models,
      message:
        "The runs used different models, so a pass-rate difference could come from the models, not the prompts. " +
        describeDifference(models, "models") +
        " Re-run the candidate with the baseline's --model / --models.",
    };
  }

  const cases = difference(
    baseline.attempts.map((a) => `${a.suite}/${a.caseId}`),
    candidate.attempts.map((a) => `${a.suite}/${a.caseId}`),
  );
  if (cases.onlyInBaseline.length > 0 || cases.onlyInCandidate.length > 0) {
    return {
      type: "CaseSetMismatch",
      ...cases,
      message:
        "The runs ran different cases, so a pass-rate difference could come from the case set, not the prompts. " +
        describeDifference(cases, "cases") +
        " Re-run the candidate with the baseline's --agent / --case filters.",
    };
  }

  const pairs = difference(
    baseline.attempts.map(pairKey),
    candidate.attempts.map(pairKey),
  );
  if (pairs.onlyInBaseline.length > 0 || pairs.onlyInCandidate.length > 0) {
    return {
      type: "CaseSetMismatch",
      ...pairs,
      message:
        "The runs ran the same cases and models but not the same case × model pairs. " +
        describeDifference(pairs, "case × model pairs"),
    };
  }

  if (baseline.repeatCount !== candidate.repeatCount) {
    return {
      type: "RepeatCountMismatch",
      baseline: baseline.repeatCount,
      candidate: candidate.repeatCount,
      message:
        `The baseline repeated each case ${baseline.repeatCount} time(s) and the candidate ` +
        `${candidate.repeatCount}. Re-run the candidate with --repeat ${baseline.repeatCount}, ` +
        "so both runs sample every case equally.",
    };
  }

  return null;
}

function checkJudges(
  baseline: JudgeRecord | null,
  candidate: JudgeRecord | null,
): CompareError | null {
  if (baseline === null || candidate === null) return null;
  if (sameJudge(baseline, candidate)) return null;
  return {
    type: "JudgeMismatch",
    baseline,
    candidate,
    message:
      `The runs were scored by different judges (${describeJudge(baseline)} and ` +
      `${describeJudge(candidate)}), so their pass rates are not on the same scale. ` +
      "Re-run the baseline with the candidate's judge.",
  };
}

function sameJudge(a: JudgeRecord, b: JudgeRecord): boolean {
  return a.id === b.id && a.version === b.version;
}

function judgeStatus(
  baseline: JudgeRecord | null,
  candidate: JudgeRecord | null,
): JudgeStatus {
  if (baseline !== null && candidate !== null) {
    return { kind: "same", judge: baseline };
  }
  return { kind: "unknown", baseline, candidate };
}

/** `id@version`, or `id` when the version is not recorded. */
export function describeJudge(judge: JudgeRecord): string {
  if (judge.version === null) return judge.id;
  return `${judge.id}@${judge.version}`;
}

function pairKey(attempt: ComparedAttempt): string {
  return `${attempt.suite}/${attempt.caseId} on ${attempt.modelId}`;
}

/** Items in one list and not the other, each sorted and de-duplicated. */
function difference(
  baseline: readonly string[],
  candidate: readonly string[],
): { onlyInBaseline: string[]; onlyInCandidate: string[] } {
  const left = new Set(baseline);
  const right = new Set(candidate);
  return {
    onlyInBaseline: [...left].filter((item) => !right.has(item)).sort(),
    onlyInCandidate: [...right].filter((item) => !left.has(item)).sort(),
  };
}

/** How many differences to name before summarising the rest. */
const MAX_LISTED_DIFFERENCES = 5;

function describeDifference(
  diff: { onlyInBaseline: string[]; onlyInCandidate: string[] },
  noun: string,
): string {
  const parts: string[] = [];
  if (diff.onlyInBaseline.length > 0) {
    parts.push(`Only in the baseline: ${listSome(diff.onlyInBaseline)}.`);
  }
  if (diff.onlyInCandidate.length > 0) {
    parts.push(`Only in the candidate: ${listSome(diff.onlyInCandidate)}.`);
  }
  if (parts.length === 0) return `The ${noun} match.`;
  return parts.join(" ");
}

function listSome(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED_DIFFERENCES).join(", ");
  const rest = items.length - MAX_LISTED_DIFFERENCES;
  if (rest <= 0) return shown;
  return `${shown} and ${rest} more`;
}

function promptChanges(
  baseline: RunSnapshot,
  candidate: RunSnapshot,
): PromptChange[] {
  const agents = new Set([
    ...baseline.promptHashes.keys(),
    ...candidate.promptHashes.keys(),
  ]);
  return [...agents]
    .sort()
    .map((agentName) => ({
      agentName,
      baselineHash: baseline.promptHashes.get(agentName) ?? null,
      candidateHash: candidate.promptHashes.get(agentName) ?? null,
    }))
    .filter((change) => change.baselineHash !== change.candidateHash);
}

/** A row before Holm's adjustment. */
interface DraftRow {
  key: string;
  suite: string;
  modelId: string;
  baseline: ComparedSide;
  candidate: ComparedSide;
  pValue: number;
  /** Both sides scored and some outcome could reach significance. */
  testable: boolean;
  unscored: boolean;
  cases: CaseComparison[];
}

function side(attempts: readonly ComparedAttempt[]): ComparedSide {
  const tally = tallyAttempts(attempts);
  return {
    ...tally,
    interval: wilsonInterval(tally.passed, tally.passed + tally.failed),
  };
}

function pValueOf(baseline: AttemptTally, candidate: AttemptTally): number {
  return fisherExactTwoSided(
    baseline.passed,
    baseline.failed,
    candidate.passed,
    candidate.failed,
  );
}

function groupBy(
  attempts: readonly ComparedAttempt[],
  key: (attempt: ComparedAttempt) => string,
): Map<string, ComparedAttempt[]> {
  const groups = new Map<string, ComparedAttempt[]>();
  for (const attempt of attempts) {
    const k = key(attempt);
    const group = groups.get(k) ?? [];
    group.push(attempt);
    groups.set(k, group);
  }
  return groups;
}

function buildRows(baseline: RunSnapshot, candidate: RunSnapshot): DraftRow[] {
  const rowKey = (a: ComparedAttempt): string => `${a.suite}\u0000${a.modelId}`;
  const baseRows = groupBy(baseline.attempts, rowKey);
  const candRows = groupBy(candidate.attempts, rowKey);

  return [...baseRows.keys()].sort().map((key) => {
    const baseAttempts = baseRows.get(key) ?? [];
    const candAttempts = candRows.get(key) ?? [];
    const first = baseAttempts[0];
    const baseSide = side(baseAttempts);
    const candSide = side(candAttempts);
    const baseScored = baseSide.passed + baseSide.failed;
    const candScored = candSide.passed + candSide.failed;
    const unscored = baseScored === 0 || candScored === 0;
    return {
      key,
      suite: first?.suite ?? "",
      modelId: first?.modelId ?? "",
      baseline: baseSide,
      candidate: candSide,
      pValue: pValueOf(baseSide, candSide),
      testable:
        !unscored && bestPossibleP(baseScored, candScored) < SIGNIFICANCE_LEVEL,
      unscored,
      cases: buildCaseRows(baseAttempts, candAttempts),
    };
  });
}

function buildCaseRows(
  baseline: readonly ComparedAttempt[],
  candidate: readonly ComparedAttempt[],
): CaseComparison[] {
  const baseCases = groupBy(baseline, (a) => a.caseId);
  const candCases = groupBy(candidate, (a) => a.caseId);
  return [...baseCases.keys()].sort().map((caseId) => {
    const baseSide = side(baseCases.get(caseId) ?? []);
    const candSide = side(candCases.get(caseId) ?? []);
    return {
      caseId,
      baseline: baseSide,
      candidate: candSide,
      pValue: pValueOf(baseSide, candSide),
    };
  });
}

function finishRow(
  row: DraftRow,
  adjustedP: number | undefined,
): SuiteModelComparison {
  const difference =
    row.baseline.passRate === null || row.candidate.passRate === null
      ? null
      : row.candidate.passRate - row.baseline.passRate;
  return {
    suite: row.suite,
    modelId: row.modelId,
    baseline: row.baseline,
    candidate: row.candidate,
    difference,
    pValue: row.pValue,
    adjustedP: adjustedP ?? null,
    verdict: verdictOf(row, adjustedP, difference),
    cases: row.cases,
  };
}

function verdictOf(
  row: DraftRow,
  adjustedP: number | undefined,
  difference: number | null,
): ComparisonVerdict {
  if (row.unscored) return "not-scored";
  if (!row.testable || adjustedP === undefined) return "too-few-attempts";
  if (adjustedP >= SIGNIFICANCE_LEVEL) return "no-detectable-change";
  if (difference !== null && difference > 0) return "improved";
  return "regressed";
}
