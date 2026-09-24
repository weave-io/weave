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
 *   - Claude Sonnet 5 (`anthropic/claude-sonnet-5`) through
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
 *   score --items <file> [--negatives <file>] --out <file>
 *     Runs both judges over every item not already in `--out` and writes
 *     the merged verdicts. `--negatives` adds constructed negatives (same
 *     shape as `items.json`, plus `derivedFrom` and `defect`).
 *
 *   compare --items <file> [--negatives <file>] --verdicts <file>
 *           --labels <file> [--out <file>]
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
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { z } from "zod";
import {
  EVALS_ROOT,
  loadCaseFile,
  loadRubricFile,
} from "../../packages/cli/src/evals/case-loader.js";
import {
  SIGNAL_QUESTIONS,
  signalQuestion,
} from "../../packages/cli/src/evals/judge-questions.js";
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
 * One yes/no question per runner signal. Since task 16.4 the production
 * judge asks these same questions, so the wording lives in
 * `packages/cli/src/evals/judge-questions.ts` and is re-exported here: a
 * re-run of this check asks what production asks.
 */
export { SIGNAL_QUESTIONS, signalQuestion };

/**
 * The shape of the `@langchain/openai` module the Sonnet reference judge is
 * built from. Typed narrowly so the dynamic import needs no type graph.
 */
interface LangChainOpenAIModule {
  ChatOpenAI: new (fields: {
    model?: string;
    temperature?: number;
    /** `@langchain/openai` v1 reads `apiKey`, never `openAIApiKey`. */
    apiKey?: string;
    configuration?: { baseURL?: string; [key: string]: unknown };
  }) => unknown;
}

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
  | { type: "MissingVerdicts"; ids: string[] }
  | { type: "DuplicateItemIds"; ids: string[] }
  | { type: "DuplicateVerdictIds"; ids: string[] }
  | { type: "UnknownVerdictIds"; ids: string[] }
  | { type: "DuplicateLabelIds"; ids: string[] }
  | { type: "NoItems" }
  | { type: "StaleVerdicts"; ids: string[] }
  | { type: "ReservedCriterionKey"; itemId: string; key: string }
  | { type: "InconsistentVerdicts"; ids: string[] }
  | { type: "JudgeModelMismatch"; path: string; message: string };

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
  /**
   * Constructed negatives only: the real item this one was derived from.
   * A negative keeps that item's task, rubric, reference, criteria and
   * threshold, and changes only the response to plant `defect`.
   */
  derivedFrom?: string;
  /** Constructed negatives only: the defect planted in the response. */
  defect?: string;
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
  /**
   * `itemDigest()` of the item as scored. A verdict is reused, and compared,
   * only while the item still has this digest. Verdict files written before
   * digests existed have none and are taken as written.
   */
  itemDigest?: string;
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

/** Question keys the harness adds itself; a criterion may not reuse them. */
const RESERVED_JEV_KEYS: ReadonlySet<string> = new Set(["overall", "quality"]);

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
  const reserved = item.criteria.find((c) => RESERVED_JEV_KEYS.has(c.key));
  if (reserved !== undefined) {
    return err({
      type: "ReservedCriterionKey",
      itemId: item.id,
      key: reserved.key,
    });
  }
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

const JevNoulSchema = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
});
const JevScoreSchema = z.object({
  type: z.literal("score"),
  score: z
    .number()
    .min(0)
    .max(QUALITY_ANCHORS.length - 1),
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
        message: `answer "${key}" is missing or not a noul in [0, 1]`,
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
      message: `answer "quality" is missing or not a score in [0, ${QUALITY_ANCHORS.length - 1}]`,
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
    // fromThrowable also catches a fetch implementation that throws
    // synchronously, so every failure becomes a recorded judge error.
    const send = ResultAsync.fromThrowable(
      () =>
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
    );
    return send().andThen((response) =>
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
        criteria: item.criteria,
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
      verdicts.push({ id: item.id, itemDigest: itemDigest(item), jev, sonnet });
    }
    return verdicts;
  }
}

// ---------------------------------------------------------------------------
// Labelling sheet (pure)
// ---------------------------------------------------------------------------

const LABEL_LINE_RE = /^\*\*Label \(([BN]\d+)\):\*\*[ \t]*(.*)$/;
const NOTE_LINE_RE = /^\*\*Note \(([BN]\d+)\):\*\*[ \t]*(.*)$/;

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
 * The sheet's lines outside fenced blocks. Task and response text sit inside
 * fences, so a response that happens to contain a `**Label (Bxx):**` line
 * can never set or overwrite a label.
 */
function linesOutsideFences(markdown: string): string[] {
  const outside: string[] = [];
  let openFence: string | undefined;
  for (const line of markdown.split("\n")) {
    const fence = line.match(/^(`{3,})/)?.[1];
    if (openFence === undefined) {
      if (fence !== undefined) {
        openFence = fence;
        continue;
      }
      outside.push(line);
      continue;
    }
    if (
      fence !== undefined &&
      line.trim() === fence &&
      fence.length >= openFence.length
    ) {
      openFence = undefined;
    }
  }
  return outside;
}

/**
 * Parse labels from the sheet. A label line still reading `pass | fail` (or
 * anything but `pass` or `fail`) is unlabelled; an id labelled twice is an
 * error.
 */
export function parseLabelSheet(
  markdown: string,
): Result<Map<string, HumanLabel>, BakeoffError> {
  const lines = linesOutsideFences(markdown);
  const notes = new Map<string, string>();
  for (const line of lines) {
    const match = line.match(NOTE_LINE_RE);
    if (match === null) continue;
    notes.set(match[1] ?? "", (match[2] ?? "").trim());
  }
  const labels = new Map<string, HumanLabel>();
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const missing: string[] = [];
  for (const line of lines) {
    const match = line.match(LABEL_LINE_RE);
    if (match === null) continue;
    const id = match[1] ?? "";
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
    const value = (match[2] ?? "").trim().toLowerCase();
    if (value !== "pass" && value !== "fail") {
      missing.push(id);
      continue;
    }
    labels.set(id, { verdict: value, note: notes.get(id) ?? "" });
  }
  if (duplicates.size > 0) {
    return err({ type: "DuplicateLabelIds", ids: [...duplicates] });
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
  /** Items the human labelled fail, including any the judge errored on. */
  humanFails: number;
}

export interface SuiteAgreement {
  suite: string;
  n: number;
  jevAgree: number;
  sonnetAgree: number;
}

/**
 * The acceptance rule for Jev (maintainer decision, 23 Sep 2026, revised
 * before any comparison was run). Jev is accepted when both hold:
 *
 *   - its agreement with the labels is at least `minAgreementShare` of all
 *     items (24 of 30), and
 *   - it correctly fails all but at most `maxMissedFails` of the items the
 *     labels mark fail (at least 10 of 12, so at most 2 false passes).
 *
 * A judge error counts as a disagreement and as a fail not caught, but not
 * as a false pass.
 *
 * Why an acceptance check and not a head-to-head: a chat-model judge could
 * never later join the eval matrix without grading itself, while Jev can
 * never be an evaluated model. If Jev is rejected, the fallback is a chat
 * model deliberately kept out of the matrix. Sonnet 5 is a reference only.
 */
export const JEV_ACCEPTANCE_RULE = {
  minAgreementShare: 0.8,
  maxMissedFails: 2,
  /** The rule is fixed to the full corpus: 20 real items and 10 negatives. */
  minItems: 30,
  minFailLabelled: 12,
} as const;

export interface Acceptance {
  accepted: boolean;
  /**
   * Whether the corpus has the items and fail labels the rule is fixed to.
   * A partial corpus (for example, the real items without the negatives)
   * is never accepted.
   */
  corpusComplete: boolean;
  requiredItems: number;
  requiredFailLabelled: number;
  n: number;
  agree: number;
  /** Agreements the rule requires for `n` items. */
  requiredAgree: number;
  /** Items the labels mark fail. */
  failLabelled: number;
  /** Fail-labelled items the judge failed. */
  failsCaught: number;
  /** Fails the rule requires the judge to catch. */
  requiredFailsCaught: number;
  /** Judge pass, human fail. */
  falsePasses: number;
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
    maxMissedFails: number;
    minItems: number;
    minFailLabelled: number;
  } = JEV_ACCEPTANCE_RULE,
): Acceptance {
  // Round before ceil so 0.8 * 30 (24.000000000000004) needs 24, not 25.
  const requiredAgree = Math.ceil(
    Math.round(rule.minAgreementShare * a.n * 1e9) / 1e9,
  );
  const requiredFailsCaught = Math.max(0, a.humanFails - rule.maxMissedFails);
  const corpusComplete =
    a.n >= rule.minItems && a.humanFails >= rule.minFailLabelled;
  return {
    accepted:
      corpusComplete &&
      a.agree >= requiredAgree &&
      a.failFail >= requiredFailsCaught,
    corpusComplete,
    requiredItems: rule.minItems,
    requiredFailLabelled: rule.minFailLabelled,
    n: a.n,
    agree: a.agree,
    requiredAgree,
    failLabelled: a.humanFails,
    failsCaught: a.failFail,
    requiredFailsCaught,
    falsePasses: a.failPass,
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
  const humanFails = pairs.filter((p) => p.human === "fail").length;
  const agree = counts.passPass + counts.failFail;
  const scored = n - counts.errors;
  return {
    judge,
    n,
    agree,
    agreement: n === 0 ? 0 : agree / n,
    kappa: cohensKappa(counts, scored),
    humanFails,
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
 * A stored verdict's `pass` flags must follow from its numbers under the
 * thresholds fixed before scoring, so an edited or stale verdict file cannot
 * change the outcome.
 */
export function verdictsConsistent(
  item: BakeoffItem,
  v: ItemVerdicts | undefined,
): boolean {
  if (v === undefined) return true;
  if (v.jev.ok) {
    if (v.jev.pass !== v.jev.overall >= JEV_PASS_THRESHOLD) return false;
    const allCriteria = Object.values(v.jev.criteria).every(
      (c) => c >= JEV_PASS_THRESHOLD,
    );
    if (v.jev.allCriteriaPass !== allCriteria) return false;
  }
  if (v.sonnet.ok) {
    if (v.sonnet.pass !== v.sonnet.score >= item.sonnetPassThreshold) {
      return false;
    }
  }
  return true;
}

function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
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
  if (items.length === 0) return err({ type: "NoItems" });
  const duplicateItems = duplicateIds(items.map((i) => i.id));
  if (duplicateItems.length > 0) {
    return err({ type: "DuplicateItemIds", ids: duplicateItems });
  }
  const duplicateVerdicts = duplicateIds(verdicts.map((v) => v.id));
  if (duplicateVerdicts.length > 0) {
    return err({ type: "DuplicateVerdictIds", ids: duplicateVerdicts });
  }
  const itemIds = new Set(items.map((i) => i.id));
  const unknownVerdicts = verdicts
    .map((v) => v.id)
    .filter((id) => !itemIds.has(id));
  if (unknownVerdicts.length > 0) {
    return err({ type: "UnknownVerdictIds", ids: unknownVerdicts });
  }
  const unknown = [...labels.keys()].filter((id) => !itemIds.has(id));
  if (unknown.length > 0) return err({ type: "UnknownLabelIds", ids: unknown });
  const unlabelled = items.filter((i) => !labels.has(i.id)).map((i) => i.id);
  if (unlabelled.length > 0)
    return err({ type: "MissingLabels", ids: unlabelled });
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const unscored = items.filter((i) => !byId.has(i.id)).map((i) => i.id);
  if (unscored.length > 0)
    return err({ type: "MissingVerdicts", ids: unscored });

  const stale = staleVerdictIds(items, verdicts);
  if (stale.length > 0) return err({ type: "StaleVerdicts", ids: stale });
  const inconsistent = items
    .filter((item) => !verdictsConsistent(item, byId.get(item.id)))
    .map((item) => item.id);
  if (inconsistent.length > 0) {
    return err({ type: "InconsistentVerdicts", ids: inconsistent });
  }

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
  const mark = (met: boolean) => (met ? "met" : "not met");
  const lines = [
    "### Jev acceptance",
    "",
    `**Jev: ${outcome}.**`,
    "",
    "| Condition | Required | Jev | Result |",
    "| --- | --- | --- | --- |",
    `| Corpus | at least ${a.requiredItems} items, ${a.requiredFailLabelled} labelled fail | ${a.n} items, ${a.failLabelled} labelled fail | ${mark(a.corpusComplete)} |`,
    `| Agrees with the labels | at least ${a.requiredAgree}/${a.n} | ${a.agree}/${a.n} | ${mark(a.agree >= a.requiredAgree)} |`,
    `| Fails caught (Jev fail, human fail) | at least ${a.requiredFailsCaught}/${a.failLabelled} | ${a.failsCaught}/${a.failLabelled} | ${mark(a.failsCaught >= a.requiredFailsCaught)} |`,
    `| False passes (Jev pass, human fail) | — | ${a.falsePasses} | — |`,
    `| False fails (Jev fail, human pass) | — | ${a.falseFails} | — |`,
    `| Judge errors (count as disagreements) | — | ${a.errors} | — |`,
    "",
    `Sonnet 5, for reference only: ${report.sonnet.agree}/${report.sonnet.n} agree, ${report.sonnet.failFail}/${report.sonnet.humanFails} fails caught, ${report.sonnet.failPass} false passes, ${report.sonnet.passFail} false fails.`,
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
    "| Item | Source | Suite | Case | Human | Jev (overall noul) | Sonnet 5 (score, reference) |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...items.map((item) => {
      const v = byId.get(item.id) as ItemVerdicts;
      const jev = verdictCell(v.jev, v.jev.ok ? v.jev.overall.toFixed(2) : "");
      const sonnet = verdictCell(
        v.sonnet,
        v.sonnet.ok
          ? `${v.sonnet.score.toFixed(2)} vs ${item.sonnetPassThreshold}`
          : "",
      );
      const source =
        item.derivedFrom === undefined
          ? "real"
          : `negative of ${item.derivedFrom}`;
      return `| ${item.id} | ${source} | ${item.suite} | ${item.caseId} | ${labels.get(item.id)?.verdict ?? "?"} | ${jev} | ${sonnet} |`;
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

const SelectionSchema = z
  .array(z.object({ id: z.string().regex(/^B\d+$/), raw: z.string().min(1) }))
  .refine((entries) => duplicateIds(entries.map((e) => e.id)).length === 0, {
    message: "selection ids must be unique",
  });

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
    derivedFrom: z.string().optional(),
    defect: z.string().optional(),
  }),
);

const FailedVerdictSchema = z.object({
  ok: z.literal(false),
  error: z.custom<BakeoffError>(
    (v) =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as { type?: unknown }).type === "string",
  ),
});

const ItemVerdictsSchema = z.object({
  id: z.string(),
  itemDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  jev: z.union([
    z.object({
      ok: z.literal(true),
      modelVersion: z.string(),
      overall: z.number().min(0).max(1),
      criteria: z.record(z.string(), z.number().min(0).max(1)),
      quality: z.number(),
      pass: z.boolean(),
      allCriteriaPass: z.boolean(),
      cost: z.number(),
    }),
    FailedVerdictSchema,
  ]),
  sonnet: z.union([
    z.object({
      ok: z.literal(true),
      score: z.number(),
      pass: z.boolean(),
      rationale: z.string(),
    }),
    FailedVerdictSchema,
  ]),
});

const VerdictFileSchema = z
  .object({
    scoredAt: z.string(),
    jevModel: z.string(),
    sonnetModel: z.string(),
    verdicts: z.array(ItemVerdictsSchema),
  })
  .refine((file) => duplicateIds(file.verdicts.map((v) => v.id)).length === 0, {
    message: "verdict ids must be unique",
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

/**
 * Join the real items with the constructed negatives. Ids must be unique
 * across both files.
 */
export function mergeItems(
  items: BakeoffItem[],
  negatives: BakeoffItem[],
): Result<BakeoffItem[], BakeoffError> {
  const all = [...items, ...negatives];
  const duplicates = duplicateIds(all.map((i) => i.id));
  if (duplicates.length > 0) {
    return err({ type: "DuplicateItemIds", ids: duplicates });
  }
  return ok(all);
}

/**
 * SHA-256 over everything a judge sees or is thresholded by: rubric,
 * reference, response, criteria and the Sonnet threshold (plus the task,
 * which the labeller sees). Any edit to an item changes its digest.
 */
export function itemDigest(item: BakeoffItem): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    JSON.stringify([
      item.id,
      item.suite,
      item.caseId,
      item.outcomeKind,
      item.task,
      item.rubric,
      item.reference,
      item.response,
      item.criteria,
      item.sonnetPassThreshold,
    ]),
  );
  return hasher.digest("hex");
}

/** Ids whose stored verdict was scored on different item content. */
export function staleVerdictIds(
  items: BakeoffItem[],
  existing: ItemVerdicts[],
): string[] {
  const digests = new Map(items.map((item) => [item.id, itemDigest(item)]));
  return existing
    .filter((v) => {
      const current = digests.get(v.id);
      if (v.itemDigest === undefined || current === undefined) return false;
      return current !== v.itemDigest;
    })
    .map((v) => v.id);
}

/**
 * Items not yet in `existing`. `score` keeps verdicts it has already written
 * instead of re-scoring them, so adding negatives later leaves the first
 * verdicts untouched.
 */
export function unscoredItems(
  items: BakeoffItem[],
  existing: ItemVerdicts[],
): BakeoffItem[] {
  const scored = new Set(existing.map((v) => v.id));
  return items.filter((item) => !scored.has(item.id));
}

function readItems(args: Args): ResultAsync<BakeoffItem[], BakeoffError> {
  const itemsPath = requireArg(args, "items");
  if (itemsPath.isErr()) return errAsync(itemsPath.error);
  const negativesPath = args.negatives;
  return readJson(itemsPath.value, ItemsSchema).andThen((items) => {
    if (typeof negativesPath !== "string") return mergeItems(items, []);
    return readJson(negativesPath, ItemsSchema).andThen((negatives) =>
      mergeItems(items, negatives),
    );
  });
}

function readExistingVerdicts(
  path: string,
): ResultAsync<VerdictFile | undefined, BakeoffError> {
  return ResultAsync.fromSafePromise(Bun.file(path).exists()).andThen(
    (exists): ResultAsync<VerdictFile | undefined, BakeoffError> => {
      if (!exists) return okAsync(undefined);
      return readJson(path, VerdictFileSchema);
    },
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
  // resolve it from there.
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

  const items = await readItems(args);
  if (items.isErr()) return err(items.error);
  const existing = await readExistingVerdicts(outPath.value);
  if (existing.isErr()) return err(existing.error);
  const previous = existing.value;
  if (
    previous !== undefined &&
    (previous.jevModel !== jevModel || previous.sonnetModel !== sonnetModel)
  ) {
    return err({
      type: "JudgeModelMismatch",
      path: outPath.value,
      message: `existing verdicts were scored with ${previous.jevModel} and ${previous.sonnetModel}`,
    });
  }
  const sonnet = await buildSonnetJudge(apiKey, sonnetModel);
  if (sonnet.isErr()) return err(sonnet.error);

  const scorer = new BakeoffScorer(
    new JevClient(apiKey, jevModel),
    sonnet.value,
  );
  const stale = staleVerdictIds(items.value, previous?.verdicts ?? []);
  if (stale.length > 0) return err({ type: "StaleVerdicts", ids: stale });
  const toScore = unscoredItems(items.value, previous?.verdicts ?? []);
  log.info(
    { toScore: toScore.length, kept: previous?.verdicts.length ?? 0 },
    "Scoring bake-off items not yet scored",
  );
  const verdicts = await scorer.scoreAll(toScore);
  const file: VerdictFile = {
    scoredAt: new Date().toISOString(),
    jevModel,
    sonnetModel,
    verdicts: [...(previous?.verdicts ?? []), ...verdicts],
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
  const verdictsPath = requireArg(args, "verdicts");
  if (verdictsPath.isErr()) return err(verdictsPath.error);
  const labelsPath = requireArg(args, "labels");
  if (labelsPath.isErr()) return err(labelsPath.error);

  const items = await readItems(args);
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
  const printed = await ResultAsync.fromPromise(
    Bun.write(Bun.stdout, markdown),
    (cause): BakeoffError => ({
      type: "FileWriteError",
      path: "(stdout)",
      message: String(cause),
    }),
  );
  if (printed.isErr()) return err(printed.error);
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
