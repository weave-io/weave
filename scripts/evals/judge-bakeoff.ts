/**
 * Judge bake-off harness — Spec 37, task 16.3.
 *
 * An acceptance check for TypeSafe Jev as the eval judge, against human
 * pass/fail labels on real agent outputs. If Jev is accepted it replaces the
 * hard-coded judge in `packages/cli/src/commands/eval.ts` (task 16.4):
 *
 *   - TypeSafe Jev (`typesafe/jev-1.13`) through OpenRouter's decisions
 *     endpoint. Jev answers typed questions (`noul`, `choice`, `score`) and
 *     returns no free text. It is the candidate under test.
 *   - Claude Sonnet 5 (`anthropic/claude-sonnet-5`) through the production
 *     `RealLangChainJudge` and its `JUDGE_PROMPT_TEMPLATE`, with only the
 *     model id changed. Reported as a reference only, not a contender.
 *
 * Subcommands:
 *
 *   collect --selection <file> --out-dir <dir> [--force]
 *     Reads local raw eval artifacts (`--raw-artifacts`) named in the
 *     selection file, joins them with their case and rubric fixtures, and
 *     writes `items.json` plus a blind `labels.md` (no model id, no verdict).
 *
 *   score --items <file> --out <file>
 *     Runs both judges over every item and writes their verdicts.
 *
 *   compare --items <file> --verdicts <file> --labels <file> [--out <file>]
 *     Parses the maintainer's labels from `labels.md` and emits a Markdown
 *     report: Jev ACCEPTED or REJECTED against `JEV_ACCEPTANCE_RULE`, then
 *     per-judge agreement, confusion counts, Cohen's kappa, a per-suite
 *     breakdown and per-item verdicts, with Sonnet 5 as a reference.
 *
 * The item, verdict and label files hold raw agent output. Keep them outside
 * the repository; they must never be committed or published (see
 * `docs/eval-sanitization-and-publish-pipeline.md`). The method is recorded
 * in `docs/artifacts/judge-bakeoff-2026-09-23.md`.
 */

import { basename, dirname, join, resolve } from "node:path";
import { logger } from "@weaveio/weave-engine";
import { err, errAsync, ok, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import type { LangChainOpenAIModule } from "../../packages/cli/src/commands/eval.js";
import {
  EVALS_ROOT,
  loadCaseFile,
  loadRubricFile,
} from "../../packages/cli/src/evals/case-loader.js";
import {
  type LangChainJudge,
  PASS_THRESHOLD,
  RealLangChainJudge,
} from "../../packages/cli/src/evals/langchain-agent-evals.js";
import { QUALITATIVE_PASS_THRESHOLD } from "../../packages/cli/src/evals/tapestry-category-routing-runner.js";
import type {
  EvalCase,
  EvalRubric,
  RawCaseResultArtifact,
  ScoringDimension,
} from "../../packages/cli/src/evals/types.js";

const log = logger.child({ module: "judge-bakeoff" });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "typesafe/jev-1.13";
export const SONNET_MODEL = "anthropic/claude-sonnet-5";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Jev passes an item when its `overall` noul is at least this value. */
export const JEV_PASS_THRESHOLD = 0.5;

/**
 * Jev's context is 32k tokens. The state is refused, never truncated, above
 * this many characters (about 3.5 characters per token with headroom for the
 * questions), so a verdict is never given on a response the judge only
 * partly saw.
 */
export const JEV_MAX_STATE_CHARS = 100_000;

/** Anchors for the secondary `quality` score question, lowest first. */
export const QUALITY_ANCHORS = [
  "fails the case",
  "meets few of the criteria",
  "meets most of the criteria, with gaps",
  "fully meets the case",
] as const;

/**
 * One yes/no question per runner signal. The signal ids are the
 * `required_artifacts` of the judge-scored `task_completion` cases; each
 * question restates in plain words what the deterministic runner checks.
 */
export const SIGNAL_QUESTIONS: Readonly<Record<string, string>> = {
  plan_scope_explicit:
    "Does the plan state its scope explicitly, including what is out of scope?",
  plan_file_tasks:
    "Does every task in the plan name the files it creates or changes?",
  plan_sequence_explicit: "Does the plan give an explicit order for its tasks?",
  plan_acceptance_coverage:
    "Does the plan give acceptance or success criteria for its tasks?",
  review_verdict_present:
    "Does the review give an explicit verdict tag such as [APPROVE] or [REJECT]?",
  review_verdict_approve: "Is the review's verdict an approval?",
  review_verdict_reject: "Is the review's verdict a rejection?",
  review_blockers_zero: "Does the review raise no blocking issues?",
  review_blockers_present: "Does the review raise at least one blocking issue?",
  review_file_refs_present: "Does the review cite the files it reviewed?",
  review_blocker_file_refs:
    "Does each blocking issue point to a specific file?",
  review_approval_disciplined:
    "Is the approval consistent, with no blocking issue raised alongside it?",
  review_rejection_disciplined:
    "Is the rejection consistent, with every blocking issue concrete and actionable?",
  review_blockers_cited:
    "Is each blocking issue traced to the evidence in the change that causes it?",
  security_verdict_present:
    "Does the security review give an explicit verdict, approve or block?",
  security_verdict_approve: "Is the security verdict an approval?",
  security_verdict_block: "Is the security verdict a block?",
  security_blocker_count_capped:
    "Does the review state a cap on its blocking findings and stay within it?",
  security_findings_present: "Does the review list specific security findings?",
  security_severity_present: "Does each finding carry a severity?",
  security_findings_evidence_backed:
    "Is every finding backed by concrete evidence from the change?",
  security_file_refs_present: "Does the review cite the affected files?",
  security_blocking_format_disciplined:
    "Is the block consistent: blocking findings present, within the cap, each with a severity and evidence?",
  security_fast_exit_approve:
    "Does the review approve briefly, with no findings and no blockers, as a low-risk change warrants?",
  spindle_inline_citations_present:
    "Does the answer cite its sources inline, next to the claims they support?",
  spindle_source_facts_separated:
    "Does the answer present source facts first, separately from its own interpretation?",
  spindle_confidence_reported: "Does the answer state its confidence?",
  spindle_sources_list_present: "Does the answer include a list of sources?",
  shuttle_task_intake_structured:
    "Does the report restate the task it was given in a structured way?",
  shuttle_files_acknowledged:
    "Does the report name the files it changed or inspected?",
  shuttle_acceptance_confirmed:
    "Does the report confirm each acceptance criterion?",
  shuttle_evidence_reported:
    "Does the report give evidence, such as the commands run and their results?",
  shuttle_unverified_disclosed:
    "Does the report say plainly what it could not verify?",
  shuttle_no_unobserved_pass_claim:
    "Does the report avoid claiming that tests or checks passed when it did not observe them?",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BakeoffError =
  | { type: "UsageError"; message: string }
  | { type: "FileReadError"; path: string; message: string }
  | { type: "FileWriteError"; path: string; message: string }
  | { type: "InvalidFile"; path: string; message: string }
  | { type: "RefusedOverwrite"; path: string }
  | { type: "CaseNotFound"; caseId: string }
  | { type: "FixtureError"; caseId: string; message: string }
  | { type: "UnsupportedOutcomeKind"; caseId: string; kind: string }
  | { type: "EmptyTranscript"; itemId: string }
  | { type: "StateTooLong"; itemId: string; length: number; limit: number }
  | { type: "JevHttpError"; itemId: string; status: number; body: string }
  | { type: "JevResponseInvalid"; itemId: string; message: string }
  | { type: "SonnetJudgeFailed"; itemId: string; message: string }
  | { type: "MissingLabels"; ids: string[] }
  | { type: "UnknownLabelIds"; ids: string[] }
  | { type: "MissingVerdicts"; ids: string[] };

export type Verdict = "pass" | "fail";

export interface SelectionEntry {
  /** Stable blind id, e.g. `B01`. */
  id: string;
  /** Path to a local raw case artifact (`raw/case-*.json`). */
  raw: string;
}

export interface BakeoffCriterion {
  /** Question key sent to Jev, e.g. the runner signal id. */
  key: string;
  /** The yes/no question. */
  question: string;
}

export interface BakeoffItem {
  id: string;
  suite: string;
  caseId: string;
  modelId: string;
  outcomeKind: "task_completion" | "agent_routing";
  /** The user message the agent was given. Shown to the labeller only. */
  task: string;
  /** Rubric text; the same text goes to both judges. */
  rubric: string;
  /** Expected outcome; the same text goes to both judges. */
  reference: string;
  /** The full agent response. */
  response: string;
  criteria: BakeoffCriterion[];
  /** Sonnet 5 passes the item when its score is at least this value. */
  sonnetPassThreshold: number;
}

export interface JevVerdict {
  ok: true;
  modelVersion: string;
  overall: number;
  criteria: Record<string, number>;
  quality: number;
  pass: boolean;
  /** Secondary rule, reported but not used by the acceptance rule. */
  allCriteriaPass: boolean;
  cost: number;
}

export interface SonnetVerdict {
  ok: true;
  score: number;
  pass: boolean;
  rationale: string;
}

export interface FailedVerdict {
  ok: false;
  error: BakeoffError;
}

export interface ItemVerdicts {
  id: string;
  jev: JevVerdict | FailedVerdict;
  sonnet: SonnetVerdict | FailedVerdict;
}

export interface VerdictFile {
  scoredAt: string;
  jevModel: string;
  sonnetModel: string;
  verdicts: ItemVerdicts[];
}

export interface HumanLabel {
  verdict: Verdict;
  note: string;
}

// ---------------------------------------------------------------------------
// Item construction (pure)
// ---------------------------------------------------------------------------

/** The yes/no question for one runner signal. */
export function signalQuestion(signal: string): string {
  const known = SIGNAL_QUESTIONS[signal];
  if (known !== undefined) return known;
  return `Does the response satisfy the criterion "${signal.replaceAll("_", " ")}"?`;
}

function acceptedTargets(evalCase: EvalCase): string[] {
  if (evalCase.expected_outcome.kind !== "agent_routing") return [];
  return [
    evalCase.expected_outcome.target_agent,
    ...evalCase.accepted_alternates,
  ];
}

function buildCriteria(evalCase: EvalCase): BakeoffCriterion[] {
  const outcome = evalCase.expected_outcome;
  if (outcome.kind === "agent_routing") {
    const targets = acceptedTargets(evalCase)
      .map((t) => `"${t}"`)
      .join(", ");
    return [
      {
        key: "routes_to_accepted_target",
        question: `Does the response make a clear routing decision to one of: ${targets}?`,
      },
      {
        key: "justifies_routing",
        question:
          "Does the response justify its routing choice with reasoning consistent with the rubric and reviewer notes?",
      },
    ];
  }
  if (outcome.kind !== "task_completion") return [];
  if (outcome.required_artifacts.length === 0) {
    return [
      {
        key: "meets_expected_outcome",
        question: `Does the response achieve the expected outcome: ${outcome.description}?`,
      },
    ];
  }
  return outcome.required_artifacts.map((signal) => ({
    key: signal,
    question: signalQuestion(signal),
  }));
}

function rubricNotes(rubric: EvalRubric): string {
  const notes = rubric.scoring.notes?.trim() ?? "";
  if (notes === "") return "";
  return `\nReviewer notes: ${notes}`;
}

function criteriaBlock(criteria: BakeoffCriterion[]): string {
  return criteria.map((c) => `- ${c.question}`).join("\n");
}

/**
 * The Sonnet pass threshold mirrors production: `PASS_THRESHOLD` for
 * `task_completion` cases and for optional category-routing cases, and the
 * category-routing qualitative gate for required ones.
 */
export function sonnetThreshold(
  evalCase: EvalCase,
  rubric: EvalRubric,
): number {
  if (evalCase.expected_outcome.kind !== "agent_routing") return PASS_THRESHOLD;
  if (!rubric.scoring.required) return PASS_THRESHOLD;
  return QUALITATIVE_PASS_THRESHOLD;
}

/** Join one raw artifact with its case and rubric into a bake-off item. */
export function buildItem(
  entry: SelectionEntry,
  raw: Pick<
    RawCaseResultArtifact,
    "caseId" | "modelId" | "transcript" | "rawContent"
  >,
  evalCase: EvalCase,
  rubric: EvalRubric,
): Result<BakeoffItem, BakeoffError> {
  const outcome = evalCase.expected_outcome;
  if (outcome.kind !== "task_completion" && outcome.kind !== "agent_routing") {
    return err({
      type: "UnsupportedOutcomeKind",
      caseId: evalCase.id,
      kind: outcome.kind,
    });
  }
  const task = raw.transcript.find((m) => m.role === "user")?.content;
  if (task === undefined)
    return err({ type: "EmptyTranscript", itemId: entry.id });

  const criteria = buildCriteria(evalCase);
  const lines = [`Case: ${evalCase.description}`];
  let reference: string;
  if (outcome.kind === "task_completion") {
    lines.push(`Expected outcome: ${outcome.description}`);
    const signals = outcome.required_artifacts;
    reference =
      signals.length > 0
        ? `Task: ${outcome.description}; required signals: [${signals.join(", ")}]`
        : `Task: ${outcome.description}; no specific signals required`;
  } else {
    const alternates = evalCase.accepted_alternates;
    const alternatesText =
      alternates.length > 0
        ? `; accepted alternates: [${alternates.join(", ")}]`
        : "";
    lines.push(`Expected routing: "${outcome.target_agent}"${alternatesText}`);
    reference = `Expected: route to "${outcome.target_agent}"${alternatesText}`;
  }
  lines.push(`Criteria:\n${criteriaBlock(criteria)}`);

  return ok({
    id: entry.id,
    suite: evalCase.suite,
    caseId: evalCase.id,
    modelId: raw.modelId,
    outcomeKind: outcome.kind,
    task,
    rubric: `${lines.join("\n")}${rubricNotes(rubric)}`,
    reference,
    response: raw.rawContent,
    criteria,
    sonnetPassThreshold: sonnetThreshold(evalCase, rubric),
  });
}

// ---------------------------------------------------------------------------
// Jev request and response (pure)
// ---------------------------------------------------------------------------

type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

export interface JevRequest {
  model: string;
  state: string;
  questions: Record<string, JevQuestion>;
}

const JEV_INSTRUCTION_PREFIX =
  "Read the rubric, the reference and the agent response in the state. ";

/**
 * The response as both judges and the labeller see it. A blank response is
 * shown as an explicit marker so no one mistakes it for a rendering gap.
 */
export function displayResponse(item: Pick<BakeoffItem, "response">): string {
  if (item.response.trim() === "") return "(empty response)";
  return item.response;
}

/** The state Jev judges: rubric, reference and response, in that order. */
export function buildJevState(item: BakeoffItem): string {
  return [
    "# Rubric",
    item.rubric,
    "",
    "# Reference (expected outcome)",
    item.reference,
    "",
    "# Agent response",
    displayResponse(item),
  ].join("\n");
}

/**
 * One `noul` per criterion, an `overall` noul that decides the verdict, and
 * an anchored `quality` score reported for 16.4 but not used here.
 */
export function buildJevRequest(
  item: BakeoffItem,
  model: string = JEV_MODEL,
): Result<JevRequest, BakeoffError> {
  const state = buildJevState(item);
  if (state.length > JEV_MAX_STATE_CHARS) {
    return err({
      type: "StateTooLong",
      itemId: item.id,
      length: state.length,
      limit: JEV_MAX_STATE_CHARS,
    });
  }
  const questions: Record<string, JevQuestion> = {};
  for (const criterion of item.criteria) {
    questions[criterion.key] = {
      type: "noul",
      instructions: `${JEV_INSTRUCTION_PREFIX}${criterion.question}`,
    };
  }
  questions.overall = {
    type: "noul",
    instructions: `${JEV_INSTRUCTION_PREFIX}Would a careful reviewer applying the rubric accept the agent response as passing this case?`,
  };
  questions.quality = {
    type: "score",
    instructions: `${JEV_INSTRUCTION_PREFIX}How well does the agent response meet the rubric?`,
    criteria: [...QUALITY_ANCHORS],
  };
  return ok({ model, state, questions });
}

const JevNoulSchema = z.object({ type: z.literal("noul"), noul: z.number() });
const JevScoreSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
});
const JevResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ cost: z.number() }).partial().optional(),
});

/** Validate a Jev response and turn it into a verdict. */
export function parseJevResponse(
  item: BakeoffItem,
  body: unknown,
): Result<JevVerdict, BakeoffError> {
  const parsed = JevResponseSchema.safeParse(body);
  if (!parsed.success) {
    return err({
      type: "JevResponseInvalid",
      itemId: item.id,
      message: parsed.error.message,
    });
  }
  const { answers } = parsed.data;
  const noul = (key: string): Result<number, BakeoffError> => {
    const answer = JevNoulSchema.safeParse(answers[key]);
    if (!answer.success) {
      return err({
        type: "JevResponseInvalid",
        itemId: item.id,
        message: `answer "${key}" is missing or not a noul`,
      });
    }
    return ok(answer.data.noul);
  };

  const criteria: Record<string, number> = {};
  for (const criterion of item.criteria) {
    const value = noul(criterion.key);
    if (value.isErr()) return err(value.error);
    criteria[criterion.key] = value.value;
  }
  const overall = noul("overall");
  if (overall.isErr()) return err(overall.error);
  const quality = JevScoreSchema.safeParse(answers.quality);
  if (!quality.success) {
    return err({
      type: "JevResponseInvalid",
      itemId: item.id,
      message: 'answer "quality" is missing or not a score',
    });
  }

  return ok({
    ok: true,
    modelVersion: parsed.data.model,
    overall: overall.value,
    criteria,
    quality: quality.data.score,
    pass: overall.value >= JEV_PASS_THRESHOLD,
    allCriteriaPass: Object.values(criteria).every(
      (v) => v >= JEV_PASS_THRESHOLD,
    ),
    cost: parsed.data.usage?.cost ?? 0,
  });
}

// ---------------------------------------------------------------------------
// Judges
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Calls the Jev decisions endpoint for one item. */
export class JevClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = JEV_MODEL,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly endpoint: string = JEV_ENDPOINT,
  ) {}

  decide(item: BakeoffItem): ResultAsync<JevVerdict, BakeoffError> {
    const request = buildJevRequest(item, this.model);
    if (request.isErr()) return errAsync(request.error);
    return this.post(item.id, request.value).andThen((body) =>
      parseJevResponse(item, body),
    );
  }

  private post(
    itemId: string,
    request: JevRequest,
  ): ResultAsync<unknown, BakeoffError> {
    return ResultAsync.fromPromise(
      this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      }),
      (cause): BakeoffError => ({
        type: "JevHttpError",
        itemId,
        status: 0,
        body: String(cause),
      }),
    ).andThen((response) =>
      ResultAsync.fromPromise(
        response.text(),
        (cause): BakeoffError => ({
          type: "JevHttpError",
          itemId,
          status: response.status,
          body: String(cause),
        }),
      ).andThen((text) => {
        if (!response.ok) {
          return err<unknown, BakeoffError>({
            type: "JevHttpError",
            itemId,
            status: response.status,
            body: text.slice(0, 500),
          });
        }
        return Result.fromThrowable(
          () => JSON.parse(text) as unknown,
          (): BakeoffError => ({
            type: "JevResponseInvalid",
            itemId,
            message: "response body is not JSON",
          }),
        )();
      }),
    );
  }
}

function dimensionFor(item: BakeoffItem): ScoringDimension {
  if (item.outcomeKind === "agent_routing") return "routingCorrectness";
  return "executionCompleteness";
}

/** Scores one item with a `LangChainJudge` (Sonnet 5 in the bake-off). */
export class SonnetBakeoffJudge {
  constructor(private readonly judge: LangChainJudge) {}

  decide(item: BakeoffItem): ResultAsync<SonnetVerdict, BakeoffError> {
    return this.judge
      .evaluate({
        dimension: dimensionFor(item),
        rubricDescription: item.rubric,
        response: displayResponse(item),
        reference: item.reference,
      })
      .mapErr(
        (e): BakeoffError => ({
          type: "SonnetJudgeFailed",
          itemId: item.id,
          message: e.message,
        }),
      )
      .map((output) => ({
        ok: true as const,
        score: output.score,
        pass: output.score >= item.sonnetPassThreshold,
        rationale: output.rationale,
      }));
  }
}

function settle<T>(
  result: ResultAsync<T, BakeoffError>,
): Promise<T | FailedVerdict> {
  return result.match(
    (value) => value,
    (error): FailedVerdict => ({ ok: false, error }),
  );
}

/** Runs both judges over every item; a judge failure is recorded, not fatal. */
export class BakeoffScorer {
  constructor(
    private readonly jev: Pick<JevClient, "decide">,
    private readonly sonnet: Pick<SonnetBakeoffJudge, "decide">,
  ) {}

  async scoreAll(items: BakeoffItem[]): Promise<ItemVerdicts[]> {
    const verdicts: ItemVerdicts[] = [];
    for (const item of items) {
      const [jev, sonnet] = await Promise.all([
        settle(this.jev.decide(item)),
        settle(this.sonnet.decide(item)),
      ]);
      log.info(
        { item: item.id, jevOk: jev.ok, sonnetOk: sonnet.ok },
        "Scored bake-off item",
      );
      verdicts.push({ id: item.id, jev, sonnet });
    }
    return verdicts;
  }
}

// ---------------------------------------------------------------------------
// Labelling sheet (pure)
// ---------------------------------------------------------------------------

const LABEL_RE = /^\*\*Label \((B\d+)\):\*\*[ \t]*(.*)$/gm;
const NOTE_RE = /^\*\*Note \((B\d+)\):\*\*[ \t]*(.*)$/gm;

/** A code fence longer than any backtick run in `text`. */
function fenceFor(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function fenced(text: string): string {
  const fence = fenceFor(text);
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * Render the blind labelling sheet. It shows the suite, case, task, rubric,
 * reference and full response, and withholds the model id and both judges'
 * verdicts so the labeller is not anchored.
 */
export function renderLabelSheet(items: BakeoffItem[]): string {
  const header = [
    "# Judge bake-off labelling sheet (Spec 37, task 16.3)",
    "",
    "For each item, decide whether you would accept the agent response as passing the case, judged against the rubric and the reference. Replace `pass | fail` on the `Label` line with `pass` or `fail`, and add a note if it helps. The model and both judges' verdicts are withheld on purpose.",
    "",
    "This file holds raw agent output. Keep it out of the repository.",
    "",
    `Items: ${items.length}`,
  ].join("\n");

  const sections = items.map((item) =>
    [
      "---",
      "",
      `## ${item.id} · ${item.suite} · ${item.caseId}`,
      "",
      "**Task given to the agent**",
      "",
      fenced(item.task),
      "",
      "**Rubric**",
      "",
      fenced(item.rubric),
      "",
      "**Reference**",
      "",
      fenced(item.reference),
      "",
      `**Agent response** (${item.response.length} characters)`,
      "",
      fenced(displayResponse(item)),
      "",
      `**Label (${item.id}):** pass | fail`,
      "",
      `**Note (${item.id}):** `,
    ].join("\n"),
  );

  return `${[header, ...sections].join("\n\n")}\n`;
}

/**
 * Parse labels from the sheet. A label line still reading `pass | fail` (or
 * anything but `pass` or `fail`) is unlabelled.
 */
export function parseLabelSheet(
  markdown: string,
): Result<Map<string, HumanLabel>, BakeoffError> {
  const notes = new Map<string, string>();
  for (const match of markdown.matchAll(NOTE_RE)) {
    notes.set(match[1] ?? "", (match[2] ?? "").trim());
  }
  const labels = new Map<string, HumanLabel>();
  const missing: string[] = [];
  for (const match of markdown.matchAll(LABEL_RE)) {
    const id = match[1] ?? "";
    const value = (match[2] ?? "").trim().toLowerCase();
    if (value !== "pass" && value !== "fail") {
      missing.push(id);
      continue;
    }
    labels.set(id, { verdict: value, note: notes.get(id) ?? "" });
  }
  if (missing.length > 0) return err({ type: "MissingLabels", ids: missing });
  return ok(labels);
}

// ---------------------------------------------------------------------------
// Agreement (pure)
// ---------------------------------------------------------------------------

export interface Agreement {
  judge: string;
  n: number;
  agree: number;
  agreement: number;
  /** Cohen's kappa over the items the judge scored; null when undefined. */
  kappa: number | null;
  /** Human pass, judge pass. */
  passPass: number;
  /** Human fail, judge pass. */
  failPass: number;
  /** Human pass, judge fail. */
  passFail: number;
  /** Human fail, judge fail. */
  failFail: number;
  /** Items the judge could not score; each counts as a disagreement. */
  errors: number;
}

export interface SuiteAgreement {
  suite: string;
  n: number;
  jevAgree: number;
  sonnetAgree: number;
}

/**
 * The acceptance rule for Jev, fixed by the maintainer before labelling
 * (23 Sep 2026). Jev is accepted when it agrees with the labels on at least
 * `minAgreementShare` of the items (16 of 20) and wrongly passes at most
 * `maxFalsePasses` items the maintainer labelled fail. A judge error counts
 * as a disagreement but not as a false pass.
 *
 * Why an acceptance check and not a head-to-head: a chat-model judge could
 * never later join the eval matrix without grading itself, while Jev can
 * never be an evaluated model. If Jev is rejected, the fallback is a chat
 * model deliberately kept out of the matrix.
 */
export const JEV_ACCEPTANCE_RULE = {
  minAgreementShare: 0.8,
  maxFalsePasses: 2,
} as const;

export interface Acceptance {
  accepted: boolean;
  n: number;
  agree: number;
  /** Agreements the rule requires for `n` items. */
  requiredAgree: number;
  /** Judge pass, human fail. */
  falsePasses: number;
  maxFalsePasses: number;
  /** Judge fail, human pass. */
  falseFails: number;
  errors: number;
}

export interface ComparisonReport {
  /** Jev against the acceptance rule. */
  acceptance: Acceptance;
  jev: Agreement;
  jevAllCriteria: Agreement;
  /** Reference only; Sonnet 5 is not a contender. */
  sonnet: Agreement;
  suites: SuiteAgreement[];
}

/** Apply `JEV_ACCEPTANCE_RULE` to a judge's agreement with the labels. */
export function judgeAcceptance(
  a: Agreement,
  rule: {
    minAgreementShare: number;
    maxFalsePasses: number;
  } = JEV_ACCEPTANCE_RULE,
): Acceptance {
  // Round before ceil so 0.8 * 20 (16.000000000000004) needs 16, not 17.
  const requiredAgree = Math.ceil(
    Math.round(rule.minAgreementShare * a.n * 1e9) / 1e9,
  );
  return {
    accepted: a.agree >= requiredAgree && a.failPass <= rule.maxFalsePasses,
    n: a.n,
    agree: a.agree,
    requiredAgree,
    falsePasses: a.failPass,
    maxFalsePasses: rule.maxFalsePasses,
    falseFails: a.passFail,
    errors: a.errors,
  };
}

/** Agreement between a judge's verdicts and the human labels. */
export function agreement(
  judge: string,
  pairs: Array<{ human: Verdict; judge: Verdict | undefined }>,
): Agreement {
  const counts = {
    passPass: 0,
    failPass: 0,
    passFail: 0,
    failFail: 0,
    errors: 0,
  };
  for (const pair of pairs) {
    if (pair.judge === undefined) {
      counts.errors += 1;
      continue;
    }
    if (pair.human === "pass" && pair.judge === "pass") counts.passPass += 1;
    if (pair.human === "fail" && pair.judge === "pass") counts.failPass += 1;
    if (pair.human === "pass" && pair.judge === "fail") counts.passFail += 1;
    if (pair.human === "fail" && pair.judge === "fail") counts.failFail += 1;
  }
  const n = pairs.length;
  const agree = counts.passPass + counts.failFail;
  const scored = n - counts.errors;
  return {
    judge,
    n,
    agree,
    agreement: n === 0 ? 0 : agree / n,
    kappa: cohensKappa(counts, scored),
    ...counts,
  };
}

function cohensKappa(
  c: { passPass: number; failPass: number; passFail: number; failFail: number },
  n: number,
): number | null {
  if (n === 0) return null;
  const observed = (c.passPass + c.failFail) / n;
  const humanPass = (c.passPass + c.passFail) / n;
  const judgePass = (c.passPass + c.failPass) / n;
  const expected = humanPass * judgePass + (1 - humanPass) * (1 - judgePass);
  if (expected === 1) return null;
  return (observed - expected) / (1 - expected);
}

function toVerdict(pass: boolean): Verdict {
  return pass ? "pass" : "fail";
}

function jevVerdict(v: ItemVerdicts): Verdict | undefined {
  return v.jev.ok ? toVerdict(v.jev.pass) : undefined;
}

function jevAllCriteriaVerdict(v: ItemVerdicts): Verdict | undefined {
  return v.jev.ok ? toVerdict(v.jev.allCriteriaPass) : undefined;
}

function sonnetVerdict(v: ItemVerdicts): Verdict | undefined {
  return v.sonnet.ok ? toVerdict(v.sonnet.pass) : undefined;
}

/**
 * Compare Jev (and Sonnet 5, as a reference) with the human labels, and
 * apply `JEV_ACCEPTANCE_RULE` to Jev.
 */
export function compare(
  items: BakeoffItem[],
  verdicts: ItemVerdicts[],
  labels: Map<string, HumanLabel>,
): Result<ComparisonReport, BakeoffError> {
  const itemIds = new Set(items.map((i) => i.id));
  const unknown = [...labels.keys()].filter((id) => !itemIds.has(id));
  if (unknown.length > 0) return err({ type: "UnknownLabelIds", ids: unknown });
  const unlabelled = items.filter((i) => !labels.has(i.id)).map((i) => i.id);
  if (unlabelled.length > 0)
    return err({ type: "MissingLabels", ids: unlabelled });
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const unscored = items.filter((i) => !byId.has(i.id)).map((i) => i.id);
  if (unscored.length > 0)
    return err({ type: "MissingVerdicts", ids: unscored });

  const rows = items.map((item) => ({
    item,
    human: (labels.get(item.id) as HumanLabel).verdict,
    verdicts: byId.get(item.id) as ItemVerdicts,
  }));
  const pairsFor = (
    pick: (v: ItemVerdicts) => Verdict | undefined,
    subset = rows,
  ) => subset.map((r) => ({ human: r.human, judge: pick(r.verdicts) }));

  const suites = [...new Set(items.map((i) => i.suite))].sort().map((suite) => {
    const subset = rows.filter((r) => r.item.suite === suite);
    return {
      suite,
      n: subset.length,
      jevAgree: agreement("jev", pairsFor(jevVerdict, subset)).agree,
      sonnetAgree: agreement("sonnet", pairsFor(sonnetVerdict, subset)).agree,
    };
  });

  const jev = agreement("Jev (overall noul)", pairsFor(jevVerdict));
  const sonnet = agreement("Sonnet 5 (reference)", pairsFor(sonnetVerdict));
  return ok({
    acceptance: judgeAcceptance(jev),
    jev,
    jevAllCriteria: agreement(
      "Jev (all criteria, informational)",
      pairsFor(jevAllCriteriaVerdict),
    ),
    sonnet,
    suites,
  });
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function kappaText(kappa: number | null): string {
  if (kappa === null) return "n/a";
  return kappa.toFixed(2);
}

function agreementRow(a: Agreement): string {
  return `| ${a.judge} | ${a.agree}/${a.n} (${pct(a.agreement)}) | ${kappaText(a.kappa)} | ${a.passPass} | ${a.failFail} | ${a.failPass} | ${a.passFail} | ${a.errors} |`;
}

function verdictCell(
  verdict: JevVerdict | SonnetVerdict | FailedVerdict,
  value: string,
): string {
  if (!verdict.ok) return `error (${verdict.error.type})`;
  return `${toVerdict(verdict.pass)} (${value})`;
}

/** Render the comparison as Markdown for the bake-off artifact. */
export function renderComparison(
  report: ComparisonReport,
  items: BakeoffItem[],
  verdicts: ItemVerdicts[],
  labels: Map<string, HumanLabel>,
): string {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const a = report.acceptance;
  const outcome = a.accepted ? "ACCEPTED" : "REJECTED";
  const agreeMark = a.agree >= a.requiredAgree ? "met" : "not met";
  const falsePassMark = a.falsePasses <= a.maxFalsePasses ? "met" : "not met";
  const lines = [
    "### Jev acceptance",
    "",
    `**Jev: ${outcome}.**`,
    "",
    "| Condition | Required | Jev | Result |",
    "| --- | --- | --- | --- |",
    `| Agrees with the labels | at least ${a.requiredAgree}/${a.n} | ${a.agree}/${a.n} | ${agreeMark} |`,
    `| False passes (Jev pass, human fail) | at most ${a.maxFalsePasses} | ${a.falsePasses} | ${falsePassMark} |`,
    `| False fails (Jev fail, human pass) | not limited | ${a.falseFails} | — |`,
    `| Judge errors (count as disagreements) | not limited | ${a.errors} | — |`,
    "",
    `Sonnet 5, for reference only: ${report.sonnet.agree}/${report.sonnet.n} agree, ${report.sonnet.failPass} false passes, ${report.sonnet.passFail} false fails.`,
    "",
    "### Agreement with the human labels",
    "",
    "| Judge | Agreement | Cohen's κ | Both pass | Both fail | Judge pass, human fail | Judge fail, human pass | Judge errors |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    agreementRow(report.jev),
    agreementRow(report.jevAllCriteria),
    agreementRow(report.sonnet),
    "",
    "A judge error counts as a disagreement.",
    "",
    "### Per suite",
    "",
    "| Suite | Items | Jev agrees | Sonnet 5 agrees (reference) |",
    "| --- | --- | --- | --- |",
    ...report.suites.map(
      (s) => `| ${s.suite} | ${s.n} | ${s.jevAgree} | ${s.sonnetAgree} |`,
    ),
    "",
    "### Per item",
    "",
    "| Item | Suite | Case | Human | Jev (overall noul) | Sonnet 5 (score, reference) |",
    "| --- | --- | --- | --- | --- | --- |",
    ...items.map((item) => {
      const v = byId.get(item.id) as ItemVerdicts;
      const jev = verdictCell(v.jev, v.jev.ok ? v.jev.overall.toFixed(2) : "");
      const sonnet = verdictCell(
        v.sonnet,
        v.sonnet.ok
          ? `${v.sonnet.score.toFixed(2)} vs ${item.sonnetPassThreshold}`
          : "",
      );
      return `| ${item.id} | ${item.suite} | ${item.caseId} | ${labels.get(item.id)?.verdict ?? "?"} | ${jev} | ${sonnet} |`;
    }),
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function readText(path: string): ResultAsync<string, BakeoffError> {
  return ResultAsync.fromPromise(
    Bun.file(path).text(),
    (cause): BakeoffError => ({
      type: "FileReadError",
      path,
      message: String(cause),
    }),
  );
}

function readJson<T>(
  path: string,
  schema: z.ZodType<T>,
): ResultAsync<T, BakeoffError> {
  return readText(path).andThen((text) => {
    const parsed = Result.fromThrowable(
      () => JSON.parse(text) as unknown,
      (): BakeoffError => ({ type: "InvalidFile", path, message: "not JSON" }),
    )();
    if (parsed.isErr()) return err(parsed.error);
    const validated = schema.safeParse(parsed.value);
    if (!validated.success) {
      return err<T, BakeoffError>({
        type: "InvalidFile",
        path,
        message: validated.error.message,
      });
    }
    return ok(validated.data);
  });
}

function writeText(
  path: string,
  content: string,
): ResultAsync<void, BakeoffError> {
  return ResultAsync.fromPromise(
    Bun.write(path, content).then(() => undefined),
    (cause): BakeoffError => ({
      type: "FileWriteError",
      path,
      message: String(cause),
    }),
  );
}

const SelectionSchema = z.array(
  z.object({ id: z.string().regex(/^B\d+$/), raw: z.string().min(1) }),
);

const RawArtifactSchema = z.object({
  caseId: z.string(),
  modelId: z.string(),
  transcript: z.array(
    z.object({
      role: z.enum(["user", "assistant", "tool", "system"]),
      content: z.string(),
    }),
  ),
  rawContent: z.string(),
});

const ItemsSchema = z.array(
  z.object({
    id: z.string(),
    suite: z.string(),
    caseId: z.string(),
    modelId: z.string(),
    outcomeKind: z.enum(["task_completion", "agent_routing"]),
    task: z.string(),
    rubric: z.string(),
    reference: z.string(),
    response: z.string(),
    criteria: z.array(z.object({ key: z.string(), question: z.string() })),
    sonnetPassThreshold: z.number(),
  }),
);

const VerdictFileSchema = z.object({
  scoredAt: z.string(),
  jevModel: z.string(),
  sonnetModel: z.string(),
  // Verdicts are written by `score`; they are trusted as written.
  verdicts: z.array(
    z.custom<ItemVerdicts>(
      (v) => typeof v === "object" && v !== null && "id" in v,
    ),
  ),
});

function findCaseFile(caseId: string): Result<string, BakeoffError> {
  const glob = new Bun.Glob(`cases/*/${caseId}.json`);
  const matches = Array.from(glob.scanSync(EVALS_ROOT));
  const first = matches[0];
  if (first === undefined) return err({ type: "CaseNotFound", caseId });
  return ok(resolve(EVALS_ROOT, first));
}

function loadFixtures(
  caseId: string,
): ResultAsync<{ evalCase: EvalCase; rubric: EvalRubric }, BakeoffError> {
  const casePath = findCaseFile(caseId);
  if (casePath.isErr()) {
    return errAsync(casePath.error);
  }
  const suite = basename(dirname(casePath.value));
  const rubricPath = resolve(EVALS_ROOT, "rubrics", suite, `${caseId}.json`);
  const fixtureError = (e: { message: string }): BakeoffError => ({
    type: "FixtureError",
    caseId,
    message: e.message,
  });
  return loadCaseFile(casePath.value)
    .mapErr(fixtureError)
    .andThen((evalCase) =>
      loadRubricFile(rubricPath)
        .mapErr(fixtureError)
        .map((rubric) => ({ evalCase, rubric })),
    );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

type Args = Record<string, string | true>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";
    if (!flag.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[flag.slice(2)] = true;
      continue;
    }
    args[flag.slice(2)] = next;
    i += 1;
  }
  return args;
}

function requireArg(args: Args, name: string): Result<string, BakeoffError> {
  const value = args[name];
  if (typeof value !== "string") {
    return err({
      type: "UsageError",
      message: `--${name} <value> is required`,
    });
  }
  return ok(value);
}

async function collectCommand(args: Args): Promise<Result<void, BakeoffError>> {
  const selectionPath = requireArg(args, "selection");
  if (selectionPath.isErr()) return err(selectionPath.error);
  const outDir = requireArg(args, "out-dir");
  if (outDir.isErr()) return err(outDir.error);
  const labelsPath = join(outDir.value, "labels.md");
  if (args.force !== true && (await Bun.file(labelsPath).exists())) {
    return err({ type: "RefusedOverwrite", path: labelsPath });
  }

  const selection = await readJson(selectionPath.value, SelectionSchema);
  if (selection.isErr()) return err(selection.error);
  const items: BakeoffItem[] = [];
  for (const entry of selection.value) {
    const raw = await readJson(entry.raw, RawArtifactSchema);
    if (raw.isErr()) return err(raw.error);
    const fixtures = await loadFixtures(raw.value.caseId);
    if (fixtures.isErr()) return err(fixtures.error);
    const item = buildItem(
      entry,
      raw.value,
      fixtures.value.evalCase,
      fixtures.value.rubric,
    );
    if (item.isErr()) return err(item.error);
    items.push(item.value);
  }
  items.sort((a, b) => a.id.localeCompare(b.id));

  const itemsWritten = await writeText(
    join(outDir.value, "items.json"),
    `${JSON.stringify(items, null, 2)}\n`,
  );
  if (itemsWritten.isErr()) return err(itemsWritten.error);
  const labelsWritten = await writeText(labelsPath, renderLabelSheet(items));
  if (labelsWritten.isErr()) return err(labelsWritten.error);
  log.info(
    { items: items.length, outDir: outDir.value },
    "Wrote bake-off items and labelling sheet",
  );
  return ok(undefined);
}

function buildSonnetJudge(
  apiKey: string,
  model: string,
): ResultAsync<SonnetBakeoffJudge, BakeoffError> {
  // `@langchain/openai` is a dependency of the CLI package, not the root, so
  // resolve it from there — the same module production uses.
  const cliDir = resolve(import.meta.dir, "../../packages/cli");
  return ResultAsync.fromPromise(
    (async () => {
      const modulePath = Bun.resolveSync("@langchain/openai", cliDir);
      const { ChatOpenAI } = (await import(
        modulePath
      )) as LangChainOpenAIModule;
      const chat = new ChatOpenAI({
        model,
        temperature: 0,
        apiKey,
        configuration: { baseURL: OPENROUTER_BASE_URL },
      });
      const judge = new RealLangChainJudge(
        chat as unknown as ConstructorParameters<typeof RealLangChainJudge>[0],
      );
      return new SonnetBakeoffJudge(judge);
    })(),
    (cause): BakeoffError => ({
      type: "SonnetJudgeFailed",
      itemId: "(setup)",
      message: String(cause),
    }),
  );
}

async function scoreCommand(args: Args): Promise<Result<void, BakeoffError>> {
  const itemsPath = requireArg(args, "items");
  if (itemsPath.isErr()) return err(itemsPath.error);
  const outPath = requireArg(args, "out");
  if (outPath.isErr()) return err(outPath.error);
  const apiKey = Bun.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return err({
      type: "UsageError",
      message: "OPENROUTER_API_KEY is not set",
    });
  }
  const jevModel =
    typeof args["jev-model"] === "string" ? args["jev-model"] : JEV_MODEL;
  const sonnetModel =
    typeof args["sonnet-model"] === "string"
      ? args["sonnet-model"]
      : SONNET_MODEL;

  const items = await readJson(itemsPath.value, ItemsSchema);
  if (items.isErr()) return err(items.error);
  const sonnet = await buildSonnetJudge(apiKey, sonnetModel);
  if (sonnet.isErr()) return err(sonnet.error);

  const scorer = new BakeoffScorer(
    new JevClient(apiKey, jevModel),
    sonnet.value,
  );
  const verdicts = await scorer.scoreAll(items.value);
  const file: VerdictFile = {
    scoredAt: new Date().toISOString(),
    jevModel,
    sonnetModel,
    verdicts,
  };
  const written = await writeText(
    outPath.value,
    `${JSON.stringify(file, null, 2)}\n`,
  );
  if (written.isErr()) return err(written.error);
  const jevCost = verdicts.reduce(
    (sum, v) => sum + (v.jev.ok ? v.jev.cost : 0),
    0,
  );
  log.info(
    {
      items: verdicts.length,
      jevErrors: verdicts.filter((v) => !v.jev.ok).length,
      sonnetErrors: verdicts.filter((v) => !v.sonnet.ok).length,
      jevCost,
      out: outPath.value,
    },
    "Wrote bake-off verdicts",
  );
  return ok(undefined);
}

async function compareCommand(args: Args): Promise<Result<void, BakeoffError>> {
  const itemsPath = requireArg(args, "items");
  if (itemsPath.isErr()) return err(itemsPath.error);
  const verdictsPath = requireArg(args, "verdicts");
  if (verdictsPath.isErr()) return err(verdictsPath.error);
  const labelsPath = requireArg(args, "labels");
  if (labelsPath.isErr()) return err(labelsPath.error);

  const items = await readJson(itemsPath.value, ItemsSchema);
  if (items.isErr()) return err(items.error);
  const verdicts = await readJson(verdictsPath.value, VerdictFileSchema);
  if (verdicts.isErr()) return err(verdicts.error);
  const sheet = await readText(labelsPath.value);
  if (sheet.isErr()) return err(sheet.error);
  const labels = parseLabelSheet(sheet.value);
  if (labels.isErr()) return err(labels.error);

  const report = compare(items.value, verdicts.value.verdicts, labels.value);
  if (report.isErr()) return err(report.error);
  const markdown = renderComparison(
    report.value,
    items.value,
    verdicts.value.verdicts,
    labels.value,
  );
  const out = args.out;
  if (typeof out === "string") {
    const written = await writeText(out, markdown);
    if (written.isErr()) return err(written.error);
    log.info(
      { out, jevAccepted: report.value.acceptance.accepted },
      "Wrote bake-off comparison",
    );
    return ok(undefined);
  }
  await Bun.write(Bun.stdout, markdown);
  return ok(undefined);
}

const USAGE =
  "usage: bun scripts/evals/judge-bakeoff.ts <collect|score|compare> [options]";

export async function main(
  argv: string[],
): Promise<Result<void, BakeoffError>> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "collect") return collectCommand(args);
  if (command === "score") return scoreCommand(args);
  if (command === "compare") return compareCommand(args);
  return err({ type: "UsageError", message: USAGE });
}

if (import.meta.main) {
  const result = await main(process.argv.slice(2));
  if (result.isErr()) {
    log.error({ error: result.error }, "Judge bake-off failed");
    process.exitCode = 1;
  }
}
