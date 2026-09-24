/**
 * What the eval judge is asked about one case (Spec 37, task 16.4).
 *
 * Each judged dimension becomes one `JudgeInput`: a rubric, a reference and
 * the agent's **actual response**, plus a list of yes/no criteria derived
 * from the case. The judge (`JevJudge` in `jev-judge.ts`) asks one `noul`
 * question per criterion and one `overall` question, and its verdict is the
 * overall one. The criteria only say which checks failed.
 *
 * The rubric, reference and criteria for `executionCompleteness` and for the
 * routing verdict follow the design the judge acceptance check fixed and
 * accepted (`buildItem()` in `scripts/evals/judge-bakeoff.ts`, recorded in
 * `docs/artifacts/judge-bakeoff-2026-09-23.md`), so the judge sees here what
 * it was measured on there:
 *
 * - a `task_completion` case: one question per required runner signal,
 *   restating in plain words what the deterministic runner checks
 *   (`SIGNAL_QUESTIONS`), or one "does it achieve the expected outcome"
 *   question when the case requires no signal;
 * - an `agent_routing` case: does the response make a clear routing decision
 *   to an accepted target, and does it justify it.
 *
 * `delegationCorrectness` and the `rationaleQuality` of a case that is not a
 * routing case were not part of that check; their questions follow the same
 * shape: the delegation chain the case expects, and the three properties the
 * rationale rubric has always named (coherent, relevant, detailed).
 *
 * Everything here is pure: no I/O, no judge call.
 */

import type { JudgeCriterion, JudgeInput } from "./langchain-agent-evals.js";
import type { EvalCase, EvalRubric, ModelRunOutput } from "./types.js";

/**
 * One yes/no question per runner signal. The signal ids are the
 * `required_artifacts` of the judge-scored `task_completion` cases; each
 * question restates in plain words what the deterministic runner checks.
 *
 * The wording is the wording the judge acceptance check used; change it only
 * with a new acceptance run (see `docs/agent-evals.md`, "The judge").
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

/** The yes/no question for one runner signal. */
export function signalQuestion(signal: string): string {
  const known = SIGNAL_QUESTIONS[signal];
  if (known !== undefined) return known;
  return `Does the response satisfy the criterion "${signal.replaceAll("_", " ")}"?`;
}

/**
 * The three properties the rationale rubric names, one question each. Asked
 * of every case that is not a routing case.
 */
export const RATIONALE_CRITERIA: readonly JudgeCriterion[] = [
  {
    key: "rationale_coherent",
    question: "Is the response coherent and internally consistent?",
  },
  {
    key: "rationale_relevant",
    question: "Is the response directly relevant to the task the case sets?",
  },
  {
    key: "rationale_detailed",
    question: "Is the response detailed enough for a reviewer to act on?",
  },
];

function reviewerNotes(rubric: EvalRubric): string {
  const notes = rubric.scoring.notes?.trim() ?? "";
  if (notes === "") return "";
  return `\nReviewer notes: ${notes}`;
}

function criteriaBlock(criteria: readonly JudgeCriterion[]): string {
  return criteria.map((c) => `- ${c.question}`).join("\n");
}

/** The rubric text: the case, what it expects, the criteria, the notes. */
function rubricText(
  evalCase: EvalCase,
  rubric: EvalRubric,
  expectation: string,
  criteria: readonly JudgeCriterion[],
): string {
  const lines = [`Case: ${evalCase.description}`, expectation];
  lines.push(`Criteria:\n${criteriaBlock(criteria)}`);
  return `${lines.join("\n")}${reviewerNotes(rubric)}`;
}

function quoted(names: readonly string[]): string {
  return names.map((n) => `"${n}"`).join(", ");
}

/**
 * `executionCompleteness` of a `task_completion` case the judge scores (every
 * one without the `judgment` tag). Returns `undefined` for any other kind.
 */
export function executionJudgeInput(
  run: ModelRunOutput,
  evalCase: EvalCase,
  rubric: EvalRubric,
): JudgeInput | undefined {
  const outcome = evalCase.expected_outcome;
  if (outcome.kind !== "task_completion") return undefined;
  const signals = outcome.required_artifacts;
  const criteria: JudgeCriterion[] =
    signals.length > 0
      ? signals.map((signal) => ({
          key: signal,
          question: signalQuestion(signal),
        }))
      : [
          {
            key: "meets_expected_outcome",
            question: `Does the response achieve the expected outcome: ${outcome.description}?`,
          },
        ];
  const reference =
    signals.length > 0
      ? `Task: ${outcome.description}; required signals: [${signals.join(", ")}]`
      : `Task: ${outcome.description}; no specific signals required`;
  return {
    dimension: "executionCompleteness",
    rubricDescription: rubricText(
      evalCase,
      rubric,
      `Expected outcome: ${outcome.description}`,
      criteria,
    ),
    reference,
    response: run.rawContent,
    criteria,
  };
}

/**
 * `delegationCorrectness` of a `delegation_chain` case. Returns `undefined`
 * for any other kind.
 */
export function delegationJudgeInput(
  run: ModelRunOutput,
  evalCase: EvalCase,
  rubric: EvalRubric,
): JudgeInput | undefined {
  const outcome = evalCase.expected_outcome;
  if (outcome.kind !== "delegation_chain") return undefined;
  const chain = outcome.chain.join(" → ");
  const alternates = evalCase.accepted_alternates;
  const alternatesText =
    alternates.length > 0
      ? `; accepted alternates for the last delegate: [${alternates.join(", ")}]`
      : "";
  const alternatesQuestion =
    alternates.length > 0
      ? ` (the last delegate may instead be one of: ${quoted(alternates)})`
      : "";
  const criteria: JudgeCriterion[] = [
    {
      key: "follows_delegation_chain",
      question: `Does the response delegate the work along the chain ${chain}, in that order${alternatesQuestion}?`,
    },
  ];
  return {
    dimension: "delegationCorrectness",
    rubricDescription: rubricText(
      evalCase,
      rubric,
      `Expected delegation chain: ${chain}${alternatesText}`,
      criteria,
    ),
    reference: `Expected chain: ${chain}${alternatesText}`,
    response: run.rawContent,
    criteria,
  };
}

/** The routing questions of an `agent_routing` case (the accepted design). */
function routingJudgeInput(
  run: ModelRunOutput,
  evalCase: EvalCase,
  rubric: EvalRubric,
  target: string,
  via: readonly string[],
): JudgeInput {
  const alternates = evalCase.accepted_alternates;
  const alternatesText =
    alternates.length > 0
      ? `; accepted alternates: [${alternates.join(", ")}]`
      : "";
  const viaText =
    via.length > 0 ? `; accepted first stops: [${via.join(", ")}]` : "";
  const stops =
    via.length > 0
      ? ` (or first to one of the stops the case declares on the way: ${quoted(via)})`
      : "";
  const criteria: JudgeCriterion[] = [
    {
      key: "routes_to_accepted_target",
      question: `Does the response make a clear routing decision to one of: ${quoted([target, ...alternates])}${stops}?`,
    },
    {
      key: "justifies_routing",
      question:
        "Does the response justify its routing choice with reasoning consistent with the rubric and reviewer notes?",
    },
  ];
  return {
    dimension: "rationaleQuality",
    rubricDescription: rubricText(
      evalCase,
      rubric,
      `Expected routing: "${target}"${alternatesText}${viaText}`,
      criteria,
    ),
    reference: `Expected: route to "${target}"${alternatesText}${viaText}`,
    response: run.rawContent,
    criteria,
  };
}

/**
 * `rationaleQuality`, which every case gets. On a routing case it is the
 * routing verdict the category-routing gate reads; on any other case it is
 * the quality of the response as a rationale for the task.
 */
export function rationaleJudgeInput(
  run: ModelRunOutput,
  evalCase: EvalCase,
  rubric: EvalRubric,
): JudgeInput {
  const outcome = evalCase.expected_outcome;
  if (outcome.kind === "agent_routing") {
    return routingJudgeInput(
      run,
      evalCase,
      rubric,
      outcome.target_agent,
      outcome.via,
    );
  }
  return {
    dimension: "rationaleQuality",
    rubricDescription: rubricText(
      evalCase,
      rubric,
      "Judge the response as a rationale for this case: a high-quality rationale is coherent, directly relevant to the task, and sufficiently detailed.",
      RATIONALE_CRITERIA,
    ),
    reference: `Evaluate quality for: ${evalCase.description}`,
    response: run.rawContent,
    criteria: [...RATIONALE_CRITERIA],
  };
}
