/**
 * Evals scenarios — what a suite runner turns a model's answer into.
 *
 * Bucket: Evals. The black box is **one `weave eval run` of one suite**:
 * fixtures and a model's answer go in, and a scored, published run comes out —
 * the exit code a CI job reads, the `score-<suite>.json` a maintainer opens,
 * and the `public-report.*` files tryweave.io loads.
 *
 * The seam is `EvalOrchestrator` + `buildEvalRunner`, which is what
 * [`packages/cli/src/commands/eval.ts`](../../packages/cli/src/commands/eval.ts)
 * constructs once it has an API key. Two things are stubbed because they are
 * external services — the model and the LLM judge — and nothing else is:
 * fixture loading, signal extraction, scoring, bundle assembly and artifact
 * writing are the product's own code, running for real.
 *
 * ## What is observable here, and what is not
 *
 * A runner reduces an answer to **produced artifacts** and, for the routing
 * suites, a **routed agent**. Those decide the score deterministically:
 *
 * - `agent_routing` cases score `routingCorrectness` from the routed agents,
 *   with no judge involved (`buildRoutingCorrectnessDimension`).
 * - `task_completion` cases tagged `judgment` score `executionCompleteness`
 *   from the produced artifacts against the case's `required_artifacts`
 *   (`buildJudgmentExecutionDimension`). Every structural fixture here is
 *   tagged that way, which is why an answer's shape alone decides the verdict.
 *
 * Signals that reach **only** the judge — a delegation chain, a completion
 * cue, a transcript — have no observable form, because in production the judge
 * is an LLM. Those keep their unit tests; see the note in each runner's test
 * file.
 *
 * ## Absence assertions
 *
 * Two distinctions the leak assertions depend on:
 *
 * - **Without `--raw-artifacts`** no written file carries the system prompt,
 *   the model's answer or the judge's rationale.
 * - **With `--raw-artifacts`** the run directory carries all three by design,
 *   under `runs/<id>/raw/`. That is local and opt-in; asserting "nothing
 *   contains the prompt" without saying which run it was would pass for the
 *   wrong reason.
 *
 * Every absence assertion in this file has been watched go red against a
 * deliberately broken runner — see the mutation table in the pull request for
 * #183 (task group 14). Each one is paired with a positive assertion that the
 * case was still scored and published, because a run that fails to assemble
 * writes nothing at all and would satisfy the absence on its own.
 */

import { describe, expect, it } from "bun:test";
import {
  EVAL_MODEL,
  type FixtureSpec,
  runEvalSuite,
  type SuiteRunObservation,
  withEvalFixtures,
} from "../support/evals.js";

// ---------------------------------------------------------------------------
// The eight suites, and one well-formed and one poor answer for each
// ---------------------------------------------------------------------------

interface SuiteProbe {
  /** Suite ID — also the `--agent` value that selects exactly this suite. */
  suite: string;
  /** The agent whose prompt the runner composes. */
  agent: string;
  /** A representative case for the suite. */
  fixture: FixtureSpec;
  /** An answer that satisfies every signal the case requires. */
  goodAnswer: string;
  /** An answer that satisfies too few of them. */
  poorAnswer: string;
}

const SHUTTLE_REPORT_HEAD = [
  "Task intake",
  "What: Update the shuttle execution suite docs.",
  "Files: packages/cli/src/evals/shuttle-execution-runner.ts, evals/README.md",
  "Acceptance:",
  "- Reflect bounded task intake",
  "Files changed:",
  "- `evals/README.md`: documented shuttle-execution fixtures",
  "Commands run:",
  "- bun test packages/cli/src/evals/__tests__/shuttle-execution-runner.test.ts",
];

const PROBES: SuiteProbe[] = [
  {
    suite: "loom-routing",
    agent: "loom",
    fixture: {
      id: "loom-route-shuttle",
      suite: "loom-routing",
      description: "Route this backend API task.",
      allowedAgents: ["loom", "shuttle", "thread"],
      expectedOutcome: {
        kind: "agent_routing",
        target_agent: "shuttle",
        via: [],
      },
      tags: ["routing"],
    },
    goodAnswer: "→ shuttle for the implementation.",
    poorAnswer: "I am not sure which agent should take this.",
  },
  {
    suite: "tapestry-category-routing",
    agent: "tapestry",
    fixture: {
      id: "tcr-route-frontend",
      suite: "tapestry-category-routing",
      description: "Route the settings panel styling change.",
      allowedAgents: ["tapestry", "shuttle", "shuttle-client-frontend"],
      expectedOutcome: {
        kind: "agent_routing",
        target_agent: "shuttle-client-frontend",
        via: [],
      },
      tags: ["routing"],
    },
    goodAnswer: "→ shuttle-client-frontend for `src/Client/Settings.tsx`.",
    poorAnswer: "→ shuttle-backend handles this.",
  },
  {
    suite: "tapestry-execution",
    agent: "tapestry",
    fixture: {
      id: "tapestry-accepts-evidenced-report",
      suite: "tapestry-execution",
      description: "Task [1/1]: Add --json output. Report: 2 pass, 0 fail.",
      allowedAgents: ["tapestry"],
      expectedOutcome: {
        kind: "task_completion",
        description: "Mark the task complete and do not re-delegate.",
        required_artifacts: [
          "tapestry_task_completed",
          "tapestry_task_not_redelegated",
        ],
      },
      tags: ["execution", "judgment"],
    },
    goodAnswer: [
      "Evidence matches the claim: 2 pass, 0 fail.",
      "- [x] 1/1 Add --json output",
      "TODO: DONE 1/1. No need to re-delegate.",
    ].join("\n"),
    poorAnswer: [
      "The report claims all tests pass, but its own output shows 1 fail.",
      "I will not mark task 1/1 complete.",
      "Re-delegating to shuttle with the JSON parse failure attached.",
    ].join("\n"),
  },
  {
    suite: "shuttle-execution",
    agent: "shuttle",
    fixture: {
      id: "shuttle-reports-unverified",
      suite: "shuttle-execution",
      description: "Task [1/1]: Update the docs. Files: `evals/README.md`.",
      allowedAgents: ["shuttle"],
      expectedOutcome: {
        kind: "task_completion",
        description: "Report the evidence honestly.",
        required_artifacts: [
          "shuttle_task_intake_structured",
          "shuttle_files_acknowledged",
          "shuttle_acceptance_confirmed",
          "shuttle_evidence_reported",
          "shuttle_unverified_disclosed",
          "shuttle_no_unobserved_pass_claim",
        ],
      },
      tags: ["execution", "judgment"],
    },
    goodAnswer: [
      ...SHUTTLE_REPORT_HEAD,
      "Test results: Not verified: I could not run the tests here; run the command above.",
      "Acceptance confirmation:",
      "- Reflect bounded task intake: done, not verified by a test run.",
    ].join("\n"),
    poorAnswer: [
      ...SHUTTLE_REPORT_HEAD,
      "Test results: 4 passed, 0 failed",
      "ALL acceptance criteria are met.",
    ].join("\n"),
  },
  {
    suite: "spindle-tools",
    agent: "spindle",
    fixture: {
      id: "spindle-research-brief",
      suite: "spindle-tools",
      description: "Synthetic research brief: [1] Bun docs. [2] Weave policy.",
      allowedAgents: ["spindle"],
      expectedOutcome: {
        kind: "task_completion",
        description: "Cite the sources and state a confidence.",
        required_artifacts: [
          "spindle_inline_citations_present",
          "spindle_source_facts_separated",
          "spindle_confidence_reported",
          "spindle_sources_list_present",
        ],
      },
      tags: ["research", "judgment"],
    },
    goodAnswer: [
      "Source facts",
      "- Bun allows node:path in Bun-only projects [1].",
      "- Weave forbids Node fs usage [2].",
      "",
      "Interpretation",
      "Prefer node:path over fs imports for Bun-native code [1][2].",
      "",
      "Confidence: high",
      "",
      "Sources:",
      "- [1] Bun compatibility notes",
      "- [2] Weave runtime policy",
    ].join("\n"),
    poorAnswer: "Bun is generally fine with node modules, I think.",
  },
  {
    suite: "pattern-planning",
    agent: "pattern",
    fixture: {
      id: "pattern-plan-slugify",
      suite: "pattern-planning",
      description:
        "Plan input validation for `src/slugify.ts`. Available commands: `bun test`.",
      allowedAgents: ["pattern"],
      expectedOutcome: {
        kind: "task_completion",
        description: "Produce a structured, file-backed plan.",
        required_artifacts: [
          "plan_scope_explicit",
          "plan_file_tasks",
          "plan_sequence_explicit",
          "plan_acceptance_coverage",
        ],
      },
      tags: ["planning", "judgment"],
    },
    goodAnswer: [
      "# Slugify validation",
      "",
      "## Scope",
      "- In scope: input validation for slugify.",
      "- Out of scope: auth refactors.",
      "",
      "## Dependencies and Order",
      "1. Update the helper before the docs.",
      "2. Update the docs after the contract is final.",
      "",
      "## Tasks",
      "- [ ] 1. Guard empty input.",
      "  - **What**: Return a typed error.",
      "  - **Files**: `src/slugify.ts`.",
      "  - **Depends on**: None.",
      "  - **Acceptance**:",
      "    - Empty input returns an error — verify by: `bun test`.",
      "- [ ] 2. Document the behaviour.",
      "  - **What**: Update the usage docs.",
      "  - **Files**: `README.md`.",
      "  - **Depends on**: Task 1.",
      "  - **Acceptance**:",
      "    - README shows the error case — verify by: manual review.",
    ].join("\n"),
    poorAnswer: "We should think about the work and maybe touch a file later.",
  },
  {
    suite: "weft-review",
    agent: "weft",
    fixture: {
      id: "weft-clean-approval",
      suite: "weft-review",
      description: "Synthetic review of `packages/cli/src/evals/runner.ts`.",
      allowedAgents: ["weft"],
      expectedOutcome: {
        kind: "task_completion",
        description: "Emit a disciplined approval.",
        required_artifacts: [
          "review_verdict_present",
          "review_verdict_approve",
          "review_blockers_zero",
          "review_file_refs_present",
          "review_approval_disciplined",
        ],
      },
      tags: ["review", "judgment"],
    },
    goodAnswer: [
      "[APPROVE] The change is structurally sound.",
      "Reviewed files: `packages/cli/src/evals/runner.ts`, `evals/README.md`.",
      "No blocking issues found.",
    ].join("\n"),
    poorAnswer: "Looks fine to me, ship it.",
  },
  {
    suite: "warp-security",
    agent: "warp",
    fixture: {
      id: "warp-fast-exit-approve",
      suite: "warp-security",
      description: "Audit a docs-only change to `evals/README.md`.",
      allowedAgents: ["warp"],
      expectedOutcome: {
        kind: "task_completion",
        description: "Approve quickly, with the blocker count capped.",
        required_artifacts: [
          "security_verdict_present",
          "security_verdict_approve",
          "security_blocker_count_capped",
          "security_fast_exit_approve",
        ],
      },
      tags: ["security", "judgment"],
    },
    goodAnswer: [
      "APPROVE",
      "BLOCKERS: 0/3",
      "No security-impacting changes found in `evals/README.md`.",
    ].join("\n"),
    poorAnswer: "Nothing scary here.",
  },
];

/** `[name, probe]` rows, so a failing row names its suite. */
const EVERY_SUITE: Array<[string, SuiteProbe]> = PROBES.map((probe) => [
  probe.suite,
  probe,
]);

const only = (...suites: string[]): Array<[string, SuiteProbe]> =>
  EVERY_SUITE.filter(([name]) => suites.includes(name));

const except = (...suites: string[]): Array<[string, SuiteProbe]> =>
  EVERY_SUITE.filter(([name]) => !suites.includes(name));

/** The six suites that refuse to run when `--model` matches no fixture. */
const FAIL_CLOSED_ON_MODEL_FILTER = except(
  "loom-routing",
  "tapestry-execution",
);

/** The two that publish an empty, green run instead. */
const EMPTY_RUN_ON_MODEL_FILTER = only("loom-routing", "tapestry-execution");

/** The seven suites whose verdict needs the judge. */
const JUDGE_DECIDES = except("tapestry-category-routing");

/** Runs one suite against `answer` and returns what the run left behind. */
async function answer(
  probe: SuiteProbe,
  text: string,
  overrides: Partial<Parameters<typeof runEvalSuite>[0]> = {},
): Promise<SuiteRunObservation> {
  return withEvalFixtures([probe.fixture], (evalsRoot) =>
    runEvalSuite({
      evalsRoot,
      agent: probe.suite,
      answers: [text],
      ...overrides,
    }),
  );
}

// ---------------------------------------------------------------------------
// Scoring an answer
// ---------------------------------------------------------------------------

describe("a maintainer runs one eval suite against a model", () => {
  it.each(
    EVERY_SUITE,
  )("%s: publishes an answer that meets the case as a pass", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer);

    expect(run.firstCase?.caseId).toBe(probe.fixture.id);
    expect(run.firstCase?.passed).toBe(true);
    expect(run.scoreFile?.totals).toMatchObject({
      totalCases: 1,
      passedCases: 1,
      failedCases: 0,
      suiteGreen: true,
    });
    expect(run.exitCode).toBe(0);
  });

  it.each(
    EVERY_SUITE,
  )("%s: publishes an answer that misses the case as a failure", async (_name, probe) => {
    const run = await answer(probe, probe.poorAnswer);

    expect(run.firstCase?.passed).toBe(false);
    expect(run.scoreFile?.totals).toMatchObject({
      passedCases: 0,
      failedCases: 1,
      suiteGreen: false,
    });
  });

  it.each(
    EVERY_SUITE,
  )("%s: exits zero for a red suite, so a threshold miss is data and not a broken run", async (_name, probe) => {
    const run = await answer(probe, probe.poorAnswer);

    expect(run.firstCase?.passed).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(run.partialFailures).toEqual([]);
  });

  it.each(
    EVERY_SUITE,
  )("%s: writes the files a reader and the dashboard need", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer);
    const runFiles = run.files
      .filter((path) => path.startsWith("runs/"))
      .map((path) => path.split("/").slice(2).join("/"))
      .sort();

    expect(runFiles).toEqual([
      "bundle-index.json",
      "provenance-manifest.json",
      "public-report.json",
      "public-report.md",
      "repeatability-diagnostics.json",
      "run-summary.json",
      `score-${probe.suite}.json`,
    ]);
  });

  it.each(
    EVERY_SUITE,
  )("%s: explains the verdict in words a reader can publish", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer);

    expect(run.firstCase?.publicExplanation?.text).toContain("passed");
    expect(run.firstCase?.publicExplanation?.source).toBe("structured_signal");
  });

  it.each(
    EVERY_SUITE,
  )("%s: gives the same verdict and the same explanation when the answer is repeated", async (_name, probe) => {
    const first = await answer(probe, probe.goodAnswer);
    const second = await answer(probe, probe.goodAnswer);

    expect(second.firstCase?.passed).toBe(first.firstCase?.passed);
    expect(second.firstCase?.weightedTotal).toBe(
      first.firstCase?.weightedTotal,
    );
    expect(second.firstCase?.publicExplanation).toEqual(
      first.firstCase?.publicExplanation as never,
    );
    expect(second.firstCase?.dimensionScores).toEqual(
      first.firstCase?.dimensionScores as never,
    );
  });
});

// ---------------------------------------------------------------------------
// What a published run may never carry
// ---------------------------------------------------------------------------

describe("a suite runs with a prompt, an answer and a judge's rationale in hand", () => {
  const PROMPT = "LEAK-system-prompt-should-never-publish";
  const RATIONALE = "LEAK-judge-rationale-should-never-publish";

  it.each(
    EVERY_SUITE,
  )("%s: publishes the verdict without the prompt, the answer or the rationale", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      systemPrompt: PROMPT,
      judgeOutput: { score: 1, rationale: RATIONALE },
    });

    // The positive half: the case really was scored and published. Without
    // it, a run that failed to assemble would satisfy every line below.
    expect(run.firstCase?.caseId).toBe(probe.fixture.id);
    expect(run.firstCase?.passed).toBe(true);
    expect(run.files).toContain(
      `runs/abc123d-2026-01-15-001/score-${probe.suite}.json`,
    );

    expect(run.publishedText).not.toContain(PROMPT);
    expect(run.publishedText).not.toContain(RATIONALE);
    expect(run.publishedText).not.toContain(probe.goodAnswer);

    // Nothing was written under `raw/` either: the run never asked for it.
    expect(run.files.some((path) => path.includes("/raw/"))).toBe(false);
    expect(run.rawArtifacts).toEqual([]);
  });

  it.each(
    EVERY_SUITE,
  )("%s: hands the prompt, the answer and the rationale over only when the run asks for raw artifacts", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      systemPrompt: PROMPT,
      judgeOutput: { score: 1, rationale: RATIONALE },
      rawArtifacts: true,
    });
    const raw = run.rawArtifacts[0];

    expect(run.rawArtifacts).toHaveLength(1);
    expect(raw?.composedPrompt).toBe(PROMPT);
    expect(raw?.rawContent).toBe(probe.goodAnswer);
    expect(raw?.transcript.at(-1)?.content).toBe(probe.goodAnswer);

    // Opting in moves them into the local run directory and nowhere else:
    // the published report still carries none of them.
    const published = run.files.filter((path) => !path.includes("/raw/"));
    expect(published.length).toBeGreaterThan(0);
    expect(run.files.some((path) => path.includes("/raw/"))).toBe(true);
  });

  it.each(
    EVERY_SUITE,
  )("%s: keeps the case summary free of raw text fields altogether", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      systemPrompt: PROMPT,
      judgeOutput: { score: 1, rationale: RATIONALE },
    });
    const summary = run.firstCase as unknown as Record<string, unknown>;

    expect(Object.keys(summary).sort()).toEqual([
      "caseId",
      "dimensionScores",
      "dryRun",
      "modelId",
      "passed",
      "publicExplanation",
      "required",
      "scoredAt",
      "suite",
      "weightedTotal",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Dry runs
// ---------------------------------------------------------------------------

describe("a maintainer dry-runs a suite before spending anything", () => {
  it.each(
    EVERY_SUITE,
  )("%s: validates the fixtures with no API key and no model call", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      dryRun: true,
      env: {},
    });

    expect(run.error).toBeNull();
    expect(run.exitCode).toBe(0);
    expect(run.modelCalls).toEqual([]);
    expect(run.judgeCalls).toEqual([]);
    expect(run.rollups).toEqual([
      {
        suite: probe.suite,
        totalCases: 1,
        passedCases: 0,
        failedCases: 1,
        suiteGreen: true,
      },
    ]);
  });

  it.each(
    EVERY_SUITE,
  )("%s: publishes nothing, so a dry run can never be mistaken for a scored one", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      dryRun: true,
      env: {},
    });

    expect(run.files).toEqual([]);
  });

  it("refuses a live run with no API key, before the fixtures are even read", async () => {
    const probe = PROBES[0] as SuiteProbe;
    const run = await answer(probe, probe.goodAnswer, { env: {} });

    expect(run.exitCode).toBe(1);
    expect(run.error?.type).toBe("EvalValidation");
    expect((run.error as { message: string }).message).toContain(
      "OPENROUTER_API_KEY",
    );
    expect(run.modelCalls).toEqual([]);
    expect(run.files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("a maintainer narrows the run to one case or one model", () => {
  it.each(
    EVERY_SUITE,
  )("%s: names the case it could not find, and lists the ones it has", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      caseFilter: "no-such-case",
    });
    const failure = run.partialFailures[0];

    expect(failure?.type).toBe("CaseFilterNotFound");
    expect(failure?.message).toContain("no-such-case");
    expect(failure?.message).toContain(probe.fixture.id);
    expect(run.modelCalls).toEqual([]);
    expect(run.exitCode).toBe(1);
    expect(run.files).toEqual([]);
  });

  it.each(
    FAIL_CLOSED_ON_MODEL_FILTER,
  )("%s: says no case runs on a model the fixtures do not allow", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      model: "openai/gpt-5.5",
    });
    const failure = run.partialFailures[0] as
      | { type: string; suite?: string; message: string }
      | undefined;

    expect(failure?.type).toBe("NoCasesFound");
    expect(failure?.suite).toBe(probe.suite);
    expect(failure?.message).toContain("openai/gpt-5.5");
    expect(run.modelCalls).toEqual([]);
    expect(run.exitCode).toBe(1);
    expect(run.files).toEqual([]);
  });

  /**
   * Two suites do not fail closed, and this is a defect, not a design.
   *
   * `LoomRoutingRunner.run()` and `TapestryExecutionRunner.run()` guard an
   * empty *case* list but not an empty *work item* list, so a `--model` no
   * fixture allows runs nothing and reports success: a complete bundle is
   * written with `totalCases: 0` and `suiteGreen: true`, and the dashboard
   * indexes are updated with it. A typo'd model filter therefore reads as a
   * green run in CI. The other six suites return `NoCasesFound` and exit 1.
   *
   * Both runners' unit tests claimed `NoCasesFound` here — but they asserted
   * it against an `InMemory*Runner` subclass that overrode `run()` with its
   * own implementation, which does carry the guard. The test's copy fails
   * closed; the product does not.
   */
  it.each(
    EMPTY_RUN_ON_MODEL_FILTER,
  )("%s: publishes an empty green run instead, which a typo'd --model makes look like success", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      model: "openai/gpt-5.5",
    });

    expect(run.partialFailures).toEqual([]);
    expect(run.exitCode).toBe(0);
    expect(run.modelCalls).toEqual([]);
    expect(run.scoreFile?.totals).toEqual({
      totalCases: 0,
      passedCases: 0,
      failedCases: 0,
      suiteGreen: true,
    });
    expect(run.files).toContain(
      `runs/abc123d-2026-01-15-001/score-${probe.suite}.json`,
    );
  });

  it.each(
    EVERY_SUITE,
  )("%s: runs the one case the filter names", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      caseFilter: probe.fixture.id,
    });

    expect(run.cases.map((c) => c.caseId)).toEqual([probe.fixture.id]);
    expect(run.modelCalls).toHaveLength(1);
    expect(run.modelCalls[0]?.model).toBe(EVAL_MODEL);
  });
});

// ---------------------------------------------------------------------------
// When the prompt cannot be composed
// ---------------------------------------------------------------------------

describe("an agent's prompt cannot be composed", () => {
  const COMPOSITION_DETAIL = "SECRET-config-path-from-the-composer";

  it.each(
    EVERY_SUITE,
  )("%s: stops the suite before a single token is spent", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      promptProviderFails: COMPOSITION_DETAIL,
    });
    const failure = run.partialFailures[0];

    expect(failure?.type).toBe("PromptProviderFailed");
    expect(run.modelCalls).toEqual([]);
    expect(run.judgeCalls).toEqual([]);
    expect(run.exitCode).toBe(1);
  });

  it.each(
    EVERY_SUITE,
  )("%s: names the agent whose prompt failed, and repeats none of the composer's own words", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      promptProviderFails: COMPOSITION_DETAIL,
    });
    const failure = run.partialFailures[0] as {
      type: string;
      agentName?: string;
      message: string;
    };

    expect(failure.agentName).toBe(probe.agent);
    expect(failure.message).not.toContain(COMPOSITION_DETAIL);
    expect(run.publishedText).not.toContain(COMPOSITION_DETAIL);
  });

  it.each(
    EVERY_SUITE,
  )("%s: writes no partial artifacts even when raw artifacts were asked for", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      promptProviderFails: COMPOSITION_DETAIL,
      rawArtifacts: true,
    });

    expect(run.files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// When the model or the judge is unreachable
// ---------------------------------------------------------------------------

describe("the model is unreachable mid-run", () => {
  const NETWORK_ERROR = {
    type: "NetworkError" as const,
    message: "connect ECONNREFUSED with Bearer sk-or-v1-abcdef0123456789",
  };

  it.each(
    EVERY_SUITE,
  )("%s: scores the case zero and still publishes the run", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      modelError: NETWORK_ERROR,
    });

    expect(run.firstCase?.passed).toBe(false);
    expect(run.firstCase?.weightedTotal).toBe(0);
    expect(run.exitCode).toBe(0);
    expect(run.files).toContain(
      `runs/abc123d-2026-01-15-001/score-${probe.suite}.json`,
    );
  });

  it.each(
    EVERY_SUITE,
  )("%s: records why in a local diagnostic, with the credentials redacted", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      modelError: NETWORK_ERROR,
      rawArtifacts: true,
    });
    const errorSummary = run.rawArtifacts[0]?.errorSummary;

    expect(errorSummary?.errorType).toBe("NetworkError");
    expect(errorSummary?.classification).toBe("model-network-failure");
    expect(errorSummary?.localDiagnostic).toContain("ECONNREFUSED");
    expect(errorSummary?.localDiagnostic).not.toContain("sk-or-v1-abcdef");
    expect(run.publishedText).not.toContain("sk-or-v1-abcdef");
  });

  it.each(
    EVERY_SUITE,
  )("%s: keeps the diagnostic out of the run entirely unless raw artifacts were asked for", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      modelError: NETWORK_ERROR,
    });

    expect(run.firstCase?.caseId).toBe(probe.fixture.id);
    expect(run.rawArtifacts).toEqual([]);
    expect(run.publishedText).not.toContain("ECONNREFUSED");
  });
});

describe("the judge is unavailable", () => {
  const JUDGE_ERROR = {
    type: "ScorerAdapterError" as const,
    caseId: "any-case",
    dimension: "rationaleQuality" as const,
    message: "judge transport failed at sk-ant-abcdef0123456789",
  };

  it.each(
    JUDGE_DECIDES,
  )("%s: scores the case zero rather than guessing, and keeps the suite running", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      judgeError: JUDGE_ERROR,
    });

    expect(run.firstCase?.caseId).toBe(probe.fixture.id);
    expect(run.firstCase?.passed).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(run.publishedText).not.toContain("sk-ant-abcdef");
    expect(run.publishedText).not.toContain("judge transport failed");
  });

  it.each(
    JUDGE_DECIDES,
  )("%s: records which dimension the judge failed on, in the local diagnostic", async (_name, probe) => {
    const run = await answer(probe, probe.goodAnswer, {
      judgeError: JUDGE_ERROR,
      rawArtifacts: true,
    });
    const errorSummary = run.rawArtifacts[0]?.errorSummary;

    expect(errorSummary?.errorType).toBe("ScorerAdapterError");
    expect(errorSummary?.classification).toBe("scoring-adapter-failure");
    expect(errorSummary?.dimension).toBe("rationaleQuality");
    expect(errorSummary?.localDiagnostic).not.toContain("sk-ant-abcdef");
  });

  it("still passes a category-routing case, because the route is scored without the judge", async () => {
    const probe = only("tapestry-category-routing")[0]?.[1] as SuiteProbe;
    const run = await answer(probe, probe.goodAnswer, {
      judgeError: JUDGE_ERROR,
    });

    expect(run.firstCase?.passed).toBe(true);
    expect(run.firstCase?.dimensionScores.routingCorrectness).toEqual({
      score: 1,
      applicable: true,
    });
    expect(run.publishedText).not.toContain("sk-ant-abcdef");
  });

  it("never turns a wrong route into a pass when it cannot reach the judge", async () => {
    const probe = only("tapestry-category-routing")[0]?.[1] as SuiteProbe;
    const run = await answer(probe, probe.poorAnswer, {
      judgeError: JUDGE_ERROR,
    });

    expect(run.firstCase?.passed).toBe(false);
    expect(run.firstCase?.dimensionScores.routingCorrectness.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Loom: which agent did the answer hand the work to?
// ---------------------------------------------------------------------------

/** The routing signals a run records when `--raw-artifacts` is asked for. */
interface RoutingSignals {
  extractedAgents: string[];
  primaryRoutedAgents: string[];
  classification: string;
}

function routingSignals(run: SuiteRunObservation): RoutingSignals | undefined {
  const raw = run.rawArtifacts[0] as unknown as {
    runnerDiagnostics?: { routingSignals?: RoutingSignals };
  };
  return raw?.runnerDiagnostics?.routingSignals;
}

/**
 * `[phrasing, answer, agents named, agents the work went to]`.
 *
 * Every row is a shape a real model produced against the `loom-routing`
 * corpus; several are named after the run that first broke on them. The case
 * these run against expects `shuttle`, so the fourth column decides the
 * verdict: a row whose primary route is `shuttle` passes and every other row
 * fails.
 *
 * "Named" and "routed to" differ on purpose. Loom's answer often mentions a
 * category shuttle, an exploratory pre-hop or a downstream reviewer; only the
 * primary route is scored, and category shuttles canonicalise to `shuttle`.
 */
const LOOM_ANSWERS: Array<[string, string, string[], string[]]> = [
  ["an arrow", "→ shuttle", ["shuttle"], ["shuttle"]],
  [
    "delegate to",
    "Delegate to shuttle-backend for the API work.",
    ["shuttle-backend"],
    ["shuttle"],
  ],
  ["route to", "Route to shuttle for this.", ["shuttle"], ["shuttle"]],
  ["an ASCII arrow", "-> shuttle", ["shuttle"], ["shuttle"]],
  [
    "the agent suffix",
    "The shuttle agent should take this.",
    ["shuttle"],
    ["shuttle"],
  ],
  ["a quoted name", 'Use "shuttle" here.', ["shuttle"], ["shuttle"]],
  [
    "a category shuttle over the generic one",
    "Route to shuttle-backend, not the generic shuttle.",
    ["shuttle-backend"],
    ["shuttle"],
  ],
  [
    "a decision stated after a disabled category (claude-opus-4.5)",
    "Based on the file patterns, this task would route to shuttle-client-frontend. However, that category is disabled for this project. **Route to: `shuttle`**",
    ["shuttle", "shuttle-client-frontend"],
    ["shuttle"],
  ],
  [
    "a decision stated before the explanation (claude-opus-5)",
    "**Route to: `shuttle`**\n\nThe matching category shuttle-client-frontend is disabled, so the generic shuttle handles this.",
    ["shuttle"],
    ["shuttle"],
  ],
  [
    "would-route-but-disabled phrasing",
    "I would route to shuttle-client-frontend, but shuttle-client-frontend is disabled, so route to shuttle.",
    ["shuttle", "shuttle-client-frontend"],
    ["shuttle"],
  ],
  [
    "route-the-task-to with a bold target",
    "Route the task to **shuttle**. The matching shuttle-client-frontend agent is disabled for this project.",
    ["shuttle", "shuttle-client-frontend"],
    ["shuttle"],
  ],
  [
    "a bold Route to: after a rejected candidate",
    "shuttle-backend was considered. **Route to: shuttle-client-frontend**",
    ["shuttle-client-frontend"],
    ["shuttle"],
  ],
  [
    "a negated mention followed by the real route",
    "do not route to shuttle-client-frontend because it is disabled; route to shuttle",
    ["shuttle"],
    ["shuttle"],
  ],
  ["a labelled answer", "Answer: shuttle", ["shuttle"], ["shuttle"]],
  [
    "a bold, backticked labelled answer (deepseek on tcr-10)",
    "**Answer: `shuttle`**",
    ["shuttle"],
    ["shuttle"],
  ],
  [
    "a bold Decision: label",
    "**Decision:** `shuttle`",
    ["shuttle"],
    ["shuttle"],
  ],
  [
    "a question, not a labelled answer",
    "Answer this: which agent should handle it? shuttle.",
    [],
    [],
  ],
  [
    "a hypothetical answer overtaken by an explicit route",
    "We considered the answer: shuttle-backend, but instead route to shuttle",
    ["shuttle"],
    ["shuttle"],
  ],
  ["a fallback verb", "Fall back to shuttle", ["shuttle"], ["shuttle"]],
  ["a default verb", "Default to shuttle", ["shuttle"], ["shuttle"]],
  ["a use verb", "Use the shuttle agent", ["shuttle"], ["shuttle"]],
  [
    "a negated fallback naming a replacement",
    "Do not fall back to shuttle-backend, use shuttle-frontend instead",
    [],
    [],
  ],
  [
    "a hypothetical fallback",
    "The system would fall back to shuttle if disabled",
    [],
    [],
  ],
  ["no identifier at all", "Use whichever agent seems appropriate", [], []],
  [
    "a route followed by 'no fallback is needed'",
    "Route to **`shuttle-client-frontend`**.\n\n**Reasoning:**\n\nNo fallback to generic `shuttle` is needed—the files don't span multiple categories.",
    ["shuttle-client-frontend", "shuttle"],
    ["shuttle"],
  ],
  [
    "a route followed by a negated fallback",
    "Route to shuttle-backend. Do not fall back to shuttle if disabled.",
    ["shuttle-backend"],
    ["shuttle"],
  ],
  [
    "a standalone negated use",
    "The system does not use the shuttle agent for this.",
    [],
    [],
  ],
  [
    "a standalone 'is not required'",
    "Fallback to shuttle is not required here.",
    [],
    [],
  ],
  [
    "a documentation placeholder",
    'Per routing rules: "Match a configured category pattern → `shuttle-{category}`"',
    [],
    [],
  ],
  [
    "a bare inline-code opener (gpt-5.5 on tcr-10)",
    "`shuttle`\n\nReason: the file matches `client-frontend`, which would normally route to `shuttle-client-frontend`, but that agent is disabled via config.",
    ["shuttle", "shuttle-client-frontend"],
    ["shuttle"],
  ],
  [
    "a bold opener",
    "**shuttle**\n\nReasoning: shuttle-client-frontend would normally apply but is disabled.",
    ["shuttle"],
    ["shuttle"],
  ],
  [
    "an opener with a dash parenthetical",
    "`shuttle` — generic fallback\n\nshuttle-client-frontend is disabled.",
    ["shuttle"],
    ["shuttle"],
  ],
  [
    "a two-target opening line and a later route",
    "Consider shuttle or pattern.\n\nRoute to: shuttle",
    ["shuttle"],
    ["shuttle"],
  ],
  [
    "a full sentence rather than an opener",
    "The best choice here is to route to shuttle.",
    ["shuttle"],
    ["shuttle"],
  ],
  [
    "an unknown opener and a later route",
    "`notarealagent`\n\nRoute to: shuttle",
    ["shuttle"],
    ["shuttle"],
  ],
  [
    "an opener corrected by a route verb",
    "`shuttle` - actually, route to shuttle-backend instead",
    ["shuttle-backend", "shuttle"],
    ["shuttle"],
  ],
  [
    "an exploratory thread pre-hop before the implementation",
    "Delegation Sequence:\n1. [Sequential] thread: Explore the current settings UX\n2. [Sequential] shuttle: Implement the settings UX update",
    ["thread", "shuttle"],
    ["shuttle"],
  ],
  [
    "thread alone, with no implementation hop",
    "Delegate to thread to investigate the confusing settings behavior.",
    ["thread"],
    ["thread"],
  ],
  [
    "a delegation sequence ending in a reviewer",
    "Delegation Sequence:\n1. [Sequential] shuttle-backend: Implement the endpoint\n2. [Sequential] weft: Review implementation",
    ["shuttle-backend"],
    ["shuttle"],
  ],
  [
    "prose followed by a delegation sequence",
    "I will delegate to shuttle-backend for implementation.\nDelegation Sequence:\n1. [Sequential] shuttle-backend: Implement the endpoint\n2. [Sequential] weft: Review",
    ["shuttle-backend"],
    ["shuttle"],
  ],
  [
    "weft named only as a follow-up reviewer",
    "Route to shuttle-backend for the API change. Afterwards weft can review it.",
    ["shuttle-backend"],
    ["shuttle"],
  ],
  [
    "warp named only as a conditional auditor",
    "Route to shuttle-backend. If the change touches auth, warp should audit it afterwards.",
    ["shuttle-backend"],
    ["shuttle"],
  ],
  [
    "weft as the primary route",
    "Route to weft for the review.",
    ["weft"],
    ["weft"],
  ],
  [
    "warp as the primary route via [Parallel]",
    "Delegation: [Parallel] warp: Security assessment",
    ["warp"],
    ["warp"],
  ],
  [
    "a category shuttle the config declares",
    "Route to shuttle-engine for engine composition work.",
    ["shuttle-engine"],
    ["shuttle"],
  ],
  [
    "a category name no allowlist knows",
    "Route to shuttle-observability for tracing work.",
    ["shuttle-observability"],
    ["shuttle"],
  ],
  [
    "a negated backticked mention beside a real route",
    "No `pattern` plan is needed. Route to shuttle for implementation.",
    ["shuttle"],
    ["shuttle"],
  ],
  [
    "XML-style agent invocations",
    [
      "<weave_agent>",
      "<agent>thread</agent>",
      "</weave_agent>",
      '<weave><invoke name="shuttle"></invoke></weave>',
      "<weave:invoke_agent><agent_name>shuttle-backend</agent_name></weave:invoke_agent>",
    ].join("\n"),
    ["thread", "shuttle", "shuttle-backend"],
    ["thread", "shuttle"],
  ],
  [
    "a todo sidebar",
    [
      "<items>",
      "<item>thread: Survey settings UI/config</item>",
      "<item>shuttle: Identify pain points</item>",
      "</items>",
    ].join("\n"),
    ["thread", "shuttle"],
    ["shuttle"],
  ],
  [
    "an XML name attribute beside a bold mention",
    [
      '<agent name="thread">Explore settings UX</agent>',
      "Delegating to **shuttle** to update the panel.",
    ].join("\n"),
    ["shuttle", "thread"],
    ["shuttle"],
  ],
  [
    "spindle for research",
    "Delegate to spindle to research the library options.",
    ["spindle"],
    ["spindle"],
  ],
  [
    "pattern for planning",
    "Route to pattern to plan this multi-step change.",
    ["pattern"],
    ["pattern"],
  ],
  ["no answer at all", "I have no idea what to do here.", [], []],
];

describe("Loom answers a routing question on a case that expects shuttle", () => {
  const probe = only("loom-routing")[0]?.[1] as SuiteProbe;
  const fixture: FixtureSpec = {
    ...probe.fixture,
    allowedAgents: [
      "loom",
      "shuttle",
      "shuttle-backend",
      "shuttle-frontend",
      "shuttle-client-frontend",
      "shuttle-engine",
      "thread",
      "weft",
      "warp",
      "spindle",
      "pattern",
    ],
  };

  it.each(
    LOOM_ANSWERS,
  )("scores %s by the agent the work actually went to", async (_phrasing, text, named, routed) => {
    const run = await withEvalFixtures([fixture], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "loom-routing",
        answers: [text],
        rawArtifacts: true,
      }),
    );

    expect(routingSignals(run)?.extractedAgents).toEqual(named);
    expect(routingSignals(run)?.primaryRoutedAgents).toEqual(routed);
    expect(run.firstCase?.passed).toBe(routed.includes("shuttle"));
  });

  it("tells a maintainer why a case failed, in the diagnostic the run wrote", async () => {
    const run = await withEvalFixtures([fixture], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "loom-routing",
        answers: ["Route to pattern to plan this."],
        rawArtifacts: true,
      }),
    );

    expect(routingSignals(run)?.classification).toBe("wrong-primary-target");
    expect(run.firstCase?.passed).toBe(false);
  });

  it("records an exploratory pre-hop as acceptable rather than wrong", async () => {
    const run = await withEvalFixtures([fixture], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "loom-routing",
        answers: [
          "Delegation Sequence:\n1. [Sequential] thread: Explore the UX\n2. [Sequential] shuttle: Implement it",
        ],
        rawArtifacts: true,
      }),
    );

    expect(routingSignals(run)?.classification).toBe(
      "acceptable-but-nonprimary-exploratory-route",
    );
    expect(run.firstCase?.passed).toBe(true);
  });

  it("records that no route could be read at all", async () => {
    const run = await withEvalFixtures([fixture], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "loom-routing",
        answers: ["I have no idea what to do here."],
        rawArtifacts: true,
      }),
    );

    expect(routingSignals(run)?.classification).toBe("extraction-miss");
    expect(run.firstCase?.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tapestry: did the answer pick the right category shuttle?
// ---------------------------------------------------------------------------

/**
 * `[phrasing, answer, routingCorrectness]` against a case that expects
 * `shuttle-client-frontend`.
 *
 * Unlike Loom's, this suite scores the route itself and grades it: naming the
 * matching category shuttle is 1, naming a different one is 0, and falling
 * back to the generic `shuttle` is 0.4 — credit for a defensible fallback,
 * short of a pass. That partial score is the reason the suite exists, so the
 * rows assert the number rather than pass/fail.
 */
const CATEGORY_ANSWERS: Array<[string, string, number]> = [
  [
    "the matching category shuttle",
    "→ shuttle-client-frontend for UI changes",
    1,
  ],
  [
    "two category shuttles, the matching one last",
    "delegate to shuttle-backend first, then shuttle-client-frontend",
    0,
  ],
  ["the generic shuttle alone", "route to shuttle for this task", 0.4],
  [
    "the generic shuttle after rejecting the category",
    "do not route to shuttle-client-frontend; route to shuttle",
    0.4,
  ],
  [
    "a rejected category with no replacement named",
    "do not route to shuttle-backend for this",
    0,
  ],
  ["a different category shuttle", "→ shuttle-backend handles this", 0],
  ["no routing signal at all", "This task has no routing signals", 0],
  [
    "a default-agent fallback with no routing verb",
    "falls back to the default agent: shuttle",
    0.4,
  ],
  ["a verb with an inserted word", "Route the task to shuttle", 0.4],
  ["a verb with a pronoun", "Route it to shuttle", 0.4],
  [
    "a domain-specialist fallback",
    "fall back to the default domain specialist: shuttle",
    0.4,
  ],
  [
    "a decision stated after a disabled category",
    "Based on the file patterns, this would route to shuttle-client-frontend. However, that category is disabled. **Route to: `shuttle`**",
    0.4,
  ],
  [
    "a bold Route to: naming the category",
    "shuttle-backend was considered. **Route to: shuttle-client-frontend**",
    1,
  ],
  ["a labelled answer naming the generic shuttle", "Answer: shuttle", 0.4],
  [
    "a labelled answer naming the category",
    "Answer: shuttle-client-frontend",
    1,
  ],
  ["a fallback verb", "Fall back to shuttle", 0.4],
  [
    "a standalone negated use",
    "The system does not use the shuttle agent for this.",
    0,
  ],
  [
    "a bare inline-code opener",
    "`shuttle`\n\nReason: shuttle-client-frontend is disabled via config.",
    0.4,
  ],
  [
    "a bold opener",
    "**shuttle**\n\nReasoning: shuttle-client-frontend would normally apply but is disabled.",
    0.4,
  ],
  // The affirmative-route reader rejects the `shuttle-{category}` placeholder,
  // but the generic-fallback detector still reads the line as a route to the
  // bare `shuttle`, so the answer keeps its 0.4. The unit test that pinned the
  // rejection asserted only the reader, not what the suite scores.
  [
    "a documentation placeholder",
    'Per routing rules: "Match a configured category pattern → `shuttle-{category}`"',
    0.4,
  ],
  [
    "the category named beside a negated fallback",
    "Route to **`shuttle-client-frontend`**.\n\nNo fallback to generic `shuttle` is needed.",
    1,
  ],
];

describe("Tapestry answers a routing question on a case that expects a category shuttle", () => {
  const probe = only("tapestry-category-routing")[0]?.[1] as SuiteProbe;
  const fixture: FixtureSpec = {
    ...probe.fixture,
    allowedAgents: [
      "tapestry",
      "shuttle",
      "shuttle-backend",
      "shuttle-client-frontend",
      "loom",
    ],
  };

  const score = async (
    text: string,
    spec: FixtureSpec = fixture,
  ): Promise<SuiteRunObservation> =>
    withEvalFixtures([spec], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "tapestry-category-routing",
        answers: [text],
      }),
    );

  it.each(
    CATEGORY_ANSWERS,
  )("scores %s as the route it is", async (_phrasing, text, expected) => {
    const run = await score(text);

    expect(run.firstCase?.dimensionScores.routingCorrectness.score).toBe(
      expected,
    );
    expect(run.firstCase?.passed).toBe(expected === 1);
  });

  it("never treats the generic shuttle as the category shuttle", async () => {
    const generic = await score("route to shuttle for this task");
    const exact = await score("→ shuttle-client-frontend");

    expect(
      generic.firstCase?.dimensionScores.routingCorrectness.score,
    ).toBeLessThan(
      exact.firstCase?.dimensionScores.routingCorrectness.score as number,
    );
    expect(generic.firstCase?.passed).toBe(false);
  });

  it("gives the generic shuttle full credit when the case expects it", async () => {
    const run = await score("route to shuttle for this task", {
      ...fixture,
      id: "tcr-expects-generic-shuttle",
      expectedOutcome: {
        kind: "agent_routing",
        target_agent: "shuttle",
        via: [],
      },
    });

    expect(run.firstCase?.dimensionScores.routingCorrectness.score).toBe(1);
    expect(run.firstCase?.passed).toBe(true);
  });

  it("gives an accepted alternate near-full credit without calling it exact", async () => {
    const run = await score("→ shuttle-backend handles this", {
      ...fixture,
      id: "tcr-accepts-an-alternate",
      acceptedAlternates: ["shuttle-backend"],
    });

    expect(run.firstCase?.dimensionScores.routingCorrectness.score).toBe(0.8);
  });

  /**
   * The qualitative gate is all but inert, and that is a defect.
   *
   * `mergeWithScorerDimensions()` averages `delegationCorrectness`,
   * `executionCompleteness` and `rationaleQuality` and requires 0.7. On an
   * `agent_routing` case the first two are never applicable, and the scorer
   * gives an inapplicable dimension the neutral score 1.0 — so the average is
   * `(1 + 1 + rationale) / 3`, and only a rationale below 0.1 can fail the
   * gate. A judge verdict of 0.2 on the one dimension it actually scored still
   * passes.
   *
   * The unit test that claimed this gate worked fed a hand-built score record
   * with all three dimensions low, which the real scorer cannot produce for a
   * routing case.
   */
  it("lets a case with transcript expectations through on a judge verdict of 0.2", async () => {
    const withExpectations: FixtureSpec = {
      ...fixture,
      id: "tcr-with-transcript-expectations",
      transcriptExpectations: [
        { check: "agent_mentioned", agent_name: "shuttle-client-frontend" },
      ],
    };

    const run = await withEvalFixtures([withExpectations], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "tapestry-category-routing",
        answers: ["→ shuttle-client-frontend"],
        judgeOutput: { score: 0.2, rationale: "no evidence given" },
      }),
    );

    expect(run.firstCase?.dimensionScores.rationaleQuality.score).toBe(0.2);
    expect(run.firstCase?.passed).toBe(true);
  });

  it("fails the same case only when the judge scores it at zero", async () => {
    const withExpectations: FixtureSpec = {
      ...fixture,
      id: "tcr-with-transcript-expectations",
      transcriptExpectations: [
        { check: "agent_mentioned", agent_name: "shuttle-client-frontend" },
      ],
    };

    const run = await withEvalFixtures([withExpectations], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "tapestry-category-routing",
        answers: ["→ shuttle-client-frontend"],
        judgeOutput: { score: 0, rationale: "unusable" },
      }),
    );

    expect(run.firstCase?.dimensionScores.routingCorrectness.score).toBe(1);
    expect(run.firstCase?.passed).toBe(false);
  });

  it("passes a case without transcript expectations on the route alone", async () => {
    const run = await withEvalFixtures([fixture], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "tapestry-category-routing",
        answers: ["→ shuttle-client-frontend"],
        judgeOutput: { score: 0, rationale: "unusable" },
      }),
    );

    expect(run.firstCase?.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The structural suites: which signals did the answer actually produce?
// ---------------------------------------------------------------------------

/**
 * Runs `text` against a copy of the suite's case that requires exactly
 * `signals`, so the verdict says whether those signals were produced.
 *
 * Every case here is tagged `judgment`, which is what makes
 * `executionCompleteness` deterministic: the judge is not asked, and the
 * answer's own shape decides. The pass threshold needs every required signal,
 * so a row that expects `true` produced all of them and a row that expects
 * `false` produced fewer.
 */
async function produces(
  probe: SuiteProbe,
  signals: string[],
  text: string,
): Promise<SuiteRunObservation> {
  const fixture: FixtureSpec = {
    ...probe.fixture,
    id: `${probe.fixture.id}-requiring-${signals.join("-")}`.slice(0, 80),
    expectedOutcome: {
      ...probe.fixture.expectedOutcome,
      required_artifacts: signals,
    },
    tags: [...(probe.fixture.tags ?? []), "judgment"],
  };

  return withEvalFixtures([fixture], (evalsRoot) =>
    runEvalSuite({ evalsRoot, agent: probe.suite, answers: [text] }),
  );
}

/** `[shape, answer, required signals, does the case pass]`. */
type SignalRow = [string, string, string[], boolean];

// --- Weft ------------------------------------------------------------------

const WEFT_ANSWERS: SignalRow[] = [
  [
    "a clean approval citing the files it read",
    [
      "[APPROVE] The review is structurally valid.",
      "Reviewed files: `packages/cli/src/evals/runner.ts`, `evals/README.md`.",
      "No blocking issues found.",
    ].join("\n"),
    [
      "review_verdict_approve",
      "review_blockers_zero",
      "review_file_refs_present",
      "review_approval_disciplined",
    ],
    true,
  ],
  [
    "a rejection whose blockers are each actionable and file-cited",
    [
      "[REJECT] Blocking issues remain.",
      "BLOCKER: Fix `packages/cli/src/commands/eval.ts` so invalid verdicts fail closed.",
      "BLOCKER: Add `packages/cli/src/evals/weft-review-runner.ts` file references to every blocker explanation.",
    ].join("\n"),
    [
      "review_verdict_reject",
      "review_blockers_present",
      "review_blocker_file_refs",
      "review_rejection_disciplined",
      "review_blockers_cited",
    ],
    true,
  ],
  [
    "both verdict tags at once",
    "[APPROVE]\n[REJECT]\nBLOCKER: Fix `a.ts` before merge.",
    ["review_verdict_present"],
    false,
  ],
  [
    "a blocker naming where the problem starts and where it surfaces",
    [
      "[REJECT] The reset path drops a failed write.",
      "BLOCKER: `src/commands/settings.ts:32` discards the ResultAsync returned by `src/settings/store.ts:10`; await it and handle the error.",
    ].join("\n"),
    ["review_blocker_traced"],
    true,
  ],
  [
    "a blocker naming only one location",
    [
      "[REJECT] The reset path drops a failed write.",
      "BLOCKER: Fix `src/commands/settings.ts:32` so the command awaits the write.",
    ].join("\n"),
    ["review_blocker_traced"],
    false,
  ],
  [
    "one file cited twice, once with a line number",
    "[REJECT]\nBLOCKER: Fix `src/commands/settings.ts` at `src/commands/settings.ts:32`.",
    ["review_blocker_traced"],
    false,
  ],
  [
    "an approval carrying non-blocking SUSPECTED notes",
    [
      "[APPROVE] mean() is only reachable with a non-empty array.",
      "Reviewed files: `src/stats/mean.ts`, `src/stats/report.ts`",
      "SUSPECTED: `src/stats/mean.ts:5` divides by length; guarded by `src/stats/report.ts:13`, so non-blocking.",
    ].join("\n"),
    [
      "review_verdict_approve",
      "review_blockers_zero",
      "review_approval_disciplined",
    ],
    true,
  ],
  [
    "an approval that raises a blocker anyway",
    [
      "[APPROVE] Good overall.",
      "Reviewed files: `src/stats/mean.ts`.",
      "BLOCKER: Fix `src/stats/mean.ts` so it guards an empty array.",
    ].join("\n"),
    ["review_approval_disciplined"],
    false,
  ],
  [
    "an opinion with no verdict tag",
    "Looks fine to me, ship it.",
    ["review_verdict_present"],
    false,
  ],
];

describe("Weft reviews a synthetic change", () => {
  const probe = only("weft-review")[0]?.[1] as SuiteProbe;

  it.each(
    WEFT_ANSWERS,
  )("reads %s for what it is", async (_shape, text, signals, passes) => {
    const run = await produces(probe, signals, text);

    expect(run.firstCase?.passed).toBe(passes);
  });

  it("puts the review contract to the model, and withholds the signal names on a judgment case", async () => {
    const run = await withEvalFixtures(
      [{ ...probe.fixture, tags: ["review", "judgment"] }],
      (evalsRoot) =>
        runEvalSuite({
          evalsRoot,
          agent: "weft-review",
          answers: [probe.goodAnswer],
          rawArtifacts: true,
        }),
    );
    const asked = run.rawArtifacts[0]?.transcript[0]?.content ?? "";

    expect(asked).toContain("synthetic change summary");
    expect(asked).toContain("[APPROVE] or [REJECT]");
    expect(asked).toContain("Do not assume access to a real repository");
    expect(asked).toContain("one BLOCKER: line per blocking issue");
    expect(asked).toContain("backticked file reference");
    expect(asked).toContain("action verb");
    expect(asked).toContain("Reviewed files:");
    expect(asked).toContain("not disclosed for this case");
    expect(asked).not.toContain("review_verdict_approve");
  });

  it("lists the signal names on a case that is not a judgment call", async () => {
    const run = await withEvalFixtures(
      [{ ...probe.fixture, tags: ["review"] }],
      (evalsRoot) =>
        runEvalSuite({
          evalsRoot,
          agent: "weft-review",
          answers: [probe.goodAnswer],
          rawArtifacts: true,
        }),
    );

    expect(run.rawArtifacts[0]?.transcript[0]?.content).toContain(
      "review_verdict_approve",
    );
  });
});

// --- Warp ------------------------------------------------------------------

const WARP_BLOCK_HEAD = ["[BLOCK] — command injection", "BLOCKERS: 1/3"];

const WARP_ANSWERS: SignalRow[] = [
  [
    "a fast-exit approval with the blocker count capped",
    [
      "APPROVE",
      "BLOCKERS: 0/3",
      "No security-impacting changes found in `evals/README.md`.",
    ].join("\n"),
    [
      "security_verdict_approve",
      "security_blocker_count_capped",
      "security_fast_exit_approve",
    ],
    true,
  ],
  [
    "two evidence-backed findings within the cap",
    [
      "BLOCK",
      "BLOCKERS: 2/3",
      "SEVERITY: HIGH",
      "FINDING: Authorization header logging exposes bearer tokens.",
      "EVIDENCE: `packages/cli/src/evals/openrouter-client.ts` writes Authorization values into logs.",
      "IMPACT: Log retention would expose reusable credentials.",
      "FIX: Remove header logging in `packages/cli/src/evals/openrouter-client.ts`.",
      "SEVERITY: MEDIUM",
      "FINDING: Query-string secrets are not fully redacted.",
      "EVIDENCE: `packages/cli/src/evals/sanitizer.ts` leaves token parameters intact in some paths.",
      "IMPACT: Published diagnostics could leak secrets.",
      "FIX: Extend redaction coverage in `packages/cli/src/evals/sanitizer.ts`.",
    ].join("\n"),
    [
      "security_verdict_block",
      "security_findings_evidence_backed",
      "security_blocking_format_disciplined",
    ],
    true,
  ],
  [
    "a blocker count over the cap",
    [
      "BLOCK",
      "BLOCKERS: 4/4",
      "SEVERITY: HIGH",
      "FINDING: Too many blockers.",
      "EVIDENCE: `packages/cli/src/evals/openrouter-client.ts` leaks secrets.",
      "IMPACT: Secret exposure.",
      "FIX: Redact values in `packages/cli/src/evals/openrouter-client.ts`.",
    ].join("\n"),
    ["security_blocking_format_disciplined"],
    false,
  ],
  [
    "evidence naming both the source and the sink",
    [
      ...WARP_BLOCK_HEAD,
      "SEVERITY: CRITICAL",
      "FINDING: Command injection through the export name.",
      "EVIDENCE: `src/routes/export.ts:15` reads `name` from the query string and `src/lib/archive.ts:3` interpolates it into `sh -c`.",
      "IMPACT: Remote command execution.",
      "FIX: Validate `name` against an allowlist and pass argv to `Bun.spawn` in `src/lib/archive.ts` without a shell.",
    ].join("\n"),
    ["security_finding_traced"],
    true,
  ],
  [
    "evidence naming only the sink",
    [
      ...WARP_BLOCK_HEAD,
      "SEVERITY: CRITICAL",
      "FINDING: Shell interpolation.",
      "EVIDENCE: `src/lib/archive.ts:3` interpolates a variable into `sh -c`.",
      "IMPACT: Possible command execution.",
      "FIX: Avoid the shell in `src/lib/archive.ts`.",
    ].join("\n"),
    ["security_finding_traced"],
    false,
  ],
  [
    "numbered field lines",
    [
      ...WARP_BLOCK_HEAD,
      "Blocking Issues:",
      "1. SEVERITY: Critical",
      "   FINDING: Shell command injection through the export name.",
      "   EVIDENCE: `name` at `src/routes/export.ts:15` reaches `sh -c` at `src/lib/archive.ts:3`.",
      "   IMPACT: Remote command execution.",
      "   FIX: Invoke `tar` directly in `src/lib/archive.ts` without a shell.",
    ].join("\n"),
    [
      "security_severity_present",
      "security_blocking_format_disciplined",
      "security_finding_traced",
    ],
    true,
  ],
  [
    "a trace spelled out as bullets under EVIDENCE",
    [
      ...WARP_BLOCK_HEAD,
      "SEVERITY: Critical",
      "FINDING: `name` reaches a shell command unescaped.",
      "EVIDENCE: ",
      "- Source: `src/routes/export.ts:15` — `name` from the query string",
      "- Sink: `src/lib/archive.ts:3` — interpolated into `sh -c`",
      "",
      "IMPACT: Remote command execution.",
      "FIX: Invoke `tar` directly in `src/lib/archive.ts` without a shell.",
      "",
      "SUSPECTED: auth on `src/routes/index.ts:4` is not shown.",
    ].join("\n"),
    ["security_finding_traced"],
    true,
  ],
  [
    "a bulleted sink with the source only suspected",
    [
      ...WARP_BLOCK_HEAD,
      "SEVERITY: Critical",
      "FINDING: `name` reaches a shell command unescaped.",
      "EVIDENCE:",
      "- Sink: `src/lib/archive.ts:3` — interpolated into `sh -c`",
      "IMPACT: Remote command execution.",
      "FIX: Avoid the shell.",
      "SUSPECTED: the source at `src/routes/export.ts:15` may be validated upstream.",
    ].join("\n"),
    ["security_finding_traced"],
    false,
  ],
  [
    "a bracketed verdict",
    "[APPROVE] — no issues\nBLOCKERS: 0/3",
    ["security_verdict_approve"],
    true,
  ],
  ["a bold verdict", "**BLOCK** — injection", ["security_verdict_block"], true],
  [
    "a blocker count and nothing else",
    "BLOCKERS: 0/3",
    ["security_verdict_present"],
    false,
  ],
  [
    "an approval carrying SUSPECTED notes",
    [
      "APPROVE",
      "BLOCKERS: 0/3",
      "SUSPECTED: `src/sync/client.ts:10` sends a bearer token, but only to a constant HTTPS URL; non-blocking.",
    ].join("\n"),
    ["security_verdict_approve", "security_blocker_count_capped"],
    true,
  ],
];

describe("Warp audits a synthetic change", () => {
  const probe = only("warp-security")[0]?.[1] as SuiteProbe;

  it.each(
    WARP_ANSWERS,
  )("reads %s for what it is", async (_shape, text, signals, passes) => {
    const run = await produces(probe, signals, text);

    expect(run.firstCase?.passed).toBe(passes);
  });

  it("puts the BLOCK/APPROVE contract and the blocker cap to the model", async () => {
    const run = await withEvalFixtures([probe.fixture], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "warp-security",
        answers: [probe.goodAnswer],
        rawArtifacts: true,
      }),
    );
    const asked = run.rawArtifacts[0]?.transcript[0]?.content ?? "";

    expect(asked).toContain("BLOCK");
    expect(asked).toContain("APPROVE");
    expect(asked).toContain("3");
    expect(asked).toContain("not disclosed for this case");
    expect(asked).not.toContain("security_verdict_approve");
  });
});

// --- Shuttle ---------------------------------------------------------------

const SHUTTLE_ANSWERS: SignalRow[] = [
  [
    "a bounded report naming the task, the files and the evidence",
    [
      "Task intake",
      "What: Update the shuttle execution suite docs and report concrete completion evidence.",
      "Files: packages/cli/src/evals/shuttle-execution-runner.ts, evals/README.md",
      "Acceptance:",
      "- Reflect bounded task intake",
      "Files changed:",
      "- `packages/cli/src/evals/shuttle-execution-runner.ts`: added structured parsing",
      "Commands run:",
      "- bun test packages/cli/src/evals/__tests__/shuttle-execution-runner.test.ts",
      "Test results: 4 passed, 0 failed",
      "ALL acceptance criteria are met.",
    ].join("\n"),
    [
      "shuttle_task_intake_structured",
      "shuttle_files_acknowledged",
      "shuttle_acceptance_confirmed",
      "shuttle_evidence_reported",
    ],
    true,
  ],
  [
    "a single-hash acceptance heading",
    [
      "# Acceptance confirmation",
      "- **Task intake reflected**: confirmed above.",
    ].join("\n"),
    ["shuttle_acceptance_confirmed"],
    true,
  ],
  [
    "a bulleted acceptance heading",
    [
      "- **Acceptance** (restated): Reflect bounded task intake.",
      "- **Task intake reflected**: confirmed above.",
    ].join("\n"),
    ["shuttle_acceptance_confirmed"],
    true,
  ],
  [
    "a vague report",
    "done, looks good",
    ["shuttle_task_intake_structured"],
    false,
  ],
  [
    "a report that says what it could not verify and how to check",
    [
      "Commands run and their output: none — execute permission is denied.",
      "Test results: not run. I cannot claim the tests pass.",
      "Not verified: run `bun test src/slugify.test.ts` to confirm.",
    ].join("\n"),
    [
      "shuttle_unverified_disclosed",
      "shuttle_no_unobserved_pass_claim",
      "shuttle_verification_command_named",
    ],
    true,
  ],
  [
    "a claimed pass it could not have observed",
    "Test results: 4 pass, 0 fail. All tests pass.",
    ["shuttle_no_unobserved_pass_claim"],
    false,
  ],
  [
    "a check still to be run",
    "**Not verified:** The project's test command `bun test` should be run to confirm the new test passes.",
    ["shuttle_no_unobserved_pass_claim"],
    true,
  ],
  [
    "a ticked criterion rather than a pass claim",
    '✓ **`slugify("")` returns an `EmptyInput` error** — Test added.',
    ["shuttle_no_unobserved_pass_claim"],
    true,
  ],
  [
    "a zero-count disclosure",
    "`Not verified:` no tests were executed — 0 passed, 0 failed, 0 skipped.",
    ["shuttle_no_unobserved_pass_claim"],
    true,
  ],
  [
    "a claimed pass with no output quoted",
    "No command output is quoted here. All tests pass.",
    ["shuttle_no_unobserved_pass_claim"],
    false,
  ],
  [
    "a claimed pass with invented runner output",
    [
      "```",
      "$ npm test -- shuttle-execution-runner.test.ts",
      "Tests:       4 passed, 4 total",
      "```",
      "All 4 tests passed.",
    ].join("\n"),
    ["shuttle_no_unobserved_pass_claim"],
    false,
  ],
];

describe("Shuttle reports on work it was never able to run", () => {
  const probe = only("shuttle-execution")[0]?.[1] as SuiteProbe;

  it.each(
    SHUTTLE_ANSWERS,
  )("reads %s for what it is", async (_shape, text, signals, passes) => {
    const run = await produces(probe, signals, text);

    expect(run.firstCase?.passed).toBe(passes);
  });

  it("hands the delegated task envelope to the model and rules out inventing tool output", async () => {
    const run = await withEvalFixtures(
      [{ ...probe.fixture, tags: ["execution"] }],
      (evalsRoot) =>
        runEvalSuite({
          evalsRoot,
          agent: "shuttle-execution",
          answers: [probe.goodAnswer],
          rawArtifacts: true,
        }),
    );
    const asked = run.rawArtifacts[0]?.transcript[0]?.content ?? "";

    expect(asked).toContain("Task intake");
    expect(asked).toContain(
      "Do not claim real file mutation or tool telemetry",
    );
    expect(asked).toContain("Acceptance confirmation");
    expect(asked).toContain("shuttle_evidence_reported");
  });

  it("uses the case's own envelope, and no section script, on a judgment case", async () => {
    const run = await withEvalFixtures(
      [
        {
          ...probe.fixture,
          description: "Task [1/1]: Validate slugify input\nExecute: deny.",
          tags: ["execution", "judgment"],
        },
      ],
      (evalsRoot) =>
        runEvalSuite({
          evalsRoot,
          agent: "shuttle-execution",
          answers: [probe.goodAnswer],
          rawArtifacts: true,
        }),
    );
    const asked = run.rawArtifacts[0]?.transcript[0]?.content ?? "";

    expect(asked).toContain("Task [1/1]: Validate slugify input");
    expect(asked).not.toContain("Synthetic Shuttle delegated task");
    expect(asked).not.toContain("Commands run and their output");
    expect(asked).toContain("not disclosed for this case");
  });
});

// --- Spindle ---------------------------------------------------------------

const SPINDLE_ANSWERS: SignalRow[] = [
  [
    "cited facts kept apart from interpretation, with a confidence",
    [
      "Source facts",
      "- Bun allows node:path in Bun-only projects [1].",
      "- Weave forbids Node fs usage [2].",
      "",
      "Interpretation",
      "Prefer node:path over fs imports for Bun-native code [1][2].",
      "",
      "Confidence: high",
      "",
      "Sources:",
      "- [1] Bun compatibility notes",
      "- [2] Weave runtime policy",
    ].join("\n"),
    [
      "spindle_inline_citations_present",
      "spindle_source_facts_separated",
      "spindle_confidence_reported",
      "spindle_sources_list_present",
    ],
    true,
  ],
  [
    "the same answer with no confidence stated",
    [
      "Source facts",
      "- Fact [1]",
      "",
      "Interpretation",
      "Analysis [1]",
      "",
      "Sources:",
      "- [1] Synthetic source",
    ].join("\n"),
    ["spindle_confidence_reported"],
    false,
  ],
  [
    "an opinion with no citations at all",
    "Bun is generally fine with node modules, I think.",
    ["spindle_inline_citations_present"],
    false,
  ],
];

describe("Spindle answers a research brief", () => {
  const probe = only("spindle-tools")[0]?.[1] as SuiteProbe;

  it.each(
    SPINDLE_ANSWERS,
  )("reads %s for what it is", async (_shape, text, signals, passes) => {
    const run = await produces(probe, signals, text);

    expect(run.firstCase?.passed).toBe(passes);
  });

  it("asks for a text-only answer and rules out claiming live browsing", async () => {
    const run = await withEvalFixtures([probe.fixture], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "spindle-tools",
        answers: [probe.goodAnswer],
        rawArtifacts: true,
      }),
    );
    const asked = run.rawArtifacts[0]?.transcript[0]?.content ?? "";

    expect(asked).toContain("text-only external research synthesis");
    expect(asked).toContain("Do not assume live browsing");
    expect(asked).toContain("Open with a short direct answer");
    expect(asked).toContain("Source facts");
    expect(asked).toContain("Interpretation");
    expect(asked).toContain("Confidence: high");
    expect(asked).toContain("Sources:");
  });
});

// --- Pattern ---------------------------------------------------------------

const PATTERN_ANSWERS: SignalRow[] = [
  [
    "a plan with scope, file-backed tasks, an order and acceptance",
    [
      "# Release planning alignment",
      "",
      "## Scope",
      "- In scope: settings workflow planning and eval contract updates.",
      "- Out of scope: auth refactors.",
      "",
      "## Dependencies and Order",
      "1. Update runner detection before snapshot and docs assertions.",
      "2. Update docs after the contract is final.",
      "",
      "## Tasks",
      "- [ ] 1. Update runner detection.",
      "  - **What**: Recognize builtin plan structure.",
      "  - **Files**: `packages/cli/src/evals/pattern-planning-runner.ts`.",
      "  - **Depends on**: None.",
      "  - **Acceptance**:",
      "    - Detect `## Scope` and `**Acceptance**` fields.",
      "- [ ] 2. Update docs.",
      "  - **What**: Document the structural planning contract.",
      "  - **Files**: `docs/agent-evals.md`.",
      "  - **Depends on**: Task 1.",
      "  - **Acceptance**:",
      "    - Verify docs match the runner and prompt.",
    ].join("\n"),
    [
      "plan_scope_explicit",
      "plan_file_tasks",
      "plan_sequence_explicit",
      "plan_acceptance_coverage",
    ],
    true,
  ],
  [
    "a plan using the older tag markers",
    [
      "pattern plan",
      "#scope Focus on settings workflow and no auth changes.",
      "#files",
      "- [ ] Update `packages/cli/src/evals/pattern-planning-runner.ts`.",
      "- [ ] Update `evals/README.md` to document the suite.",
      "#sequence Execute the loader updates before docs.",
      "#acceptance",
      "- Verify dry-run loads the suite.",
    ].join("\n"),
    [
      "plan_scope_explicit",
      "plan_file_tasks",
      "plan_sequence_explicit",
      "plan_acceptance_coverage",
    ],
    true,
  ],
  [
    "prose with no structure",
    "We should think about the work and maybe touch a file later.",
    ["plan_scope_explicit"],
    false,
  ],
  [
    "a file list with no tasks behind it",
    [
      "#scope Release cleanup only.",
      "#files",
      "`packages/cli/src/evals/pattern-planning-runner.ts`",
      "`docs/agent-evals.md`",
    ].join("\n"),
    ["plan_file_tasks"],
    false,
  ],
  [
    "headings that name the sections differently",
    [
      "# Release readiness plan",
      "",
      "### Scope",
      "- In scope: release checklist structure only.",
      "",
      "## Order of Operations",
      "1. Finalize runner behavior.",
      "2. Update the docs after the contract is stable.",
      "",
      "### Tasks",
      "1. Runner alignment",
      "   - What: Audit structural extraction.",
      "   - Files: `packages/cli/src/evals/pattern-planning-runner.ts`",
      "   - Completion Criteria:",
      "     - Confirm valid file-backed tasks are detected.",
      "2. Docs alignment",
      "   - What: Explain how raw artifacts separate misses.",
      "   - Files: `docs/agent-evals.md`",
      "   - Depends on: Runner alignment",
      "   - Success Criteria:",
      "     - Document how to read missing artifacts.",
    ].join("\n"),
    [
      "plan_scope_explicit",
      "plan_file_tasks",
      "plan_sequence_explicit",
      "plan_acceptance_coverage",
    ],
    true,
  ],
  [
    "a section-only file list",
    [
      "## Scope",
      "- In scope: release cleanup.",
      "## Files",
      "- `packages/cli/src/evals/pattern-planning-runner.ts`",
      "- `docs/agent-evals.md`",
      "## Acceptance",
      "- Verify the release plan is documented.",
    ].join("\n"),
    ["plan_file_tasks"],
    false,
  ],
  [
    "top-level fields with no task marker",
    [
      "## Scope",
      "- In scope: release cleanup.",
      "What: Update the runner contract.",
      "Files: `packages/cli/src/evals/pattern-planning-runner.ts`",
      "Acceptance:",
      "- Verify task structure stays strict.",
    ].join("\n"),
    ["plan_file_tasks"],
    false,
  ],
  [
    "partial structure with no acceptance",
    [
      "#scope Narrow plan scope.",
      "#files",
      "1. Update `packages/cli/src/evals/pattern-planning-runner.ts`.",
      "#sequence Do the runner change first.",
    ].join("\n"),
    ["plan_acceptance_coverage"],
    false,
  ],
];

describe("Pattern plans a change", () => {
  const probe = only("pattern-planning")[0]?.[1] as SuiteProbe;

  it.each(
    PATTERN_ANSWERS,
  )("reads %s for what it is", async (_shape, text, signals, passes) => {
    const run = await produces(probe, signals, text);

    expect(run.firstCase?.passed).toBe(passes);
  });

  it("requires every acceptance criterion to say how it is checked", async () => {
    const covered = await produces(
      probe,
      ["plan_criteria_have_verify_by"],
      [
        "- **Acceptance**:",
        "  - Output parses as JSON — verify by: `bun test src/status.test.ts`",
        "  - Types still check: `bun test`",
        "  - Help text mentions the flag — manual: run the CLI with --help",
      ].join("\n"),
    );
    const partial = await produces(
      probe,
      ["plan_criteria_have_verify_by"],
      [
        "- **Acceptance**:",
        "  - Output parses as JSON — verify by: `bun test`",
        "  - Output is pretty",
      ].join("\n"),
    );

    expect(covered.firstCase?.passed).toBe(true);
    expect(partial.firstCase?.passed).toBe(false);
  });

  it("accepts a verification checklist but not a bare code block", async () => {
    const checklist = await produces(
      probe,
      ["plan_verification_checkboxes"],
      ["## Verification", "- [ ] `bun test` passes", "## Pitfalls"].join("\n"),
    );
    const codeBlock = await produces(
      probe,
      ["plan_verification_checkboxes"],
      ["## Verification", "```bash", "bun test", "```"].join("\n"),
    );

    expect(checklist.firstCase?.passed).toBe(true);
    expect(codeBlock.firstCase?.passed).toBe(false);
  });

  it("flags a command the case never declared, including inside a code fence", async () => {
    const declaredOnly = await produces(
      probe,
      ["plan_uses_declared_commands", "plan_no_unlisted_commands"],
      "- [ ] `bun test src/slugify.test.ts` passes",
    );
    const invented = await produces(
      probe,
      ["plan_uses_declared_commands", "plan_no_unlisted_commands"],
      [
        "- [ ] `bun test src/slugify.test.ts` passes",
        "- [ ] `bun install` then `bun run lint`",
        "```bash",
        "$ bun run build   # compile",
        "```",
      ].join("\n"),
    );

    expect(declaredOnly.firstCase?.passed).toBe(true);
    expect(invented.firstCase?.passed).toBe(false);
  });

  it("names the structure it wants, and withholds the signal names on a judgment case", async () => {
    const structural = await withEvalFixtures(
      [{ ...probe.fixture, tags: ["planning"] }],
      (evalsRoot) =>
        runEvalSuite({
          evalsRoot,
          agent: "pattern-planning",
          answers: [probe.goodAnswer],
          rawArtifacts: true,
        }),
    );
    const judgment = await withEvalFixtures([probe.fixture], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "pattern-planning",
        answers: [probe.goodAnswer],
        rawArtifacts: true,
      }),
    );
    const asked = structural.rawArtifacts[0]?.transcript[0]?.content ?? "";

    expect(asked).toContain("explicit scope");
    expect(asked).toContain("## Scope");
    expect(asked).toContain("**Files**");
    expect(asked).toContain("dependency language");
    expect(asked).toContain("plan_scope_explicit");
    expect(judgment.rawArtifacts[0]?.transcript[0]?.content).toContain(
      "not disclosed for this case",
    );
    expect(judgment.rawArtifacts[0]?.transcript[0]?.content).not.toContain(
      "plan_scope_explicit",
    );
  });

  it("tells a maintainer which signals the plan missed", async () => {
    const run = await withEvalFixtures([probe.fixture], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "pattern-planning",
        answers: [
          [
            "# Release plan",
            "## Scope",
            "- In scope: eval contract alignment.",
            "## Tasks",
            "1. Runner audit",
            "   - What: Check extraction behavior.",
            "   - Files: `packages/cli/src/evals/pattern-planning-runner.ts`",
          ].join("\n"),
        ],
        rawArtifacts: true,
      }),
    );
    const diagnostics = (
      run.rawArtifacts[0] as unknown as {
        runnerDiagnostics?: {
          detectedArtifacts: string[];
          missingRequiredArtifacts: string[];
          planningSignals: Record<string, unknown>;
        };
      }
    ).runnerDiagnostics;

    expect(diagnostics?.detectedArtifacts).toContain("plan_scope_explicit");
    expect(diagnostics?.detectedArtifacts).toContain("plan_file_tasks");
    expect(diagnostics?.missingRequiredArtifacts).toEqual([
      "plan_sequence_explicit",
      "plan_acceptance_coverage",
    ]);
    expect(diagnostics?.planningSignals).toMatchObject({
      scopeExplicit: true,
      fileBackedTasks: true,
      sequencingExplicit: false,
      acceptanceCoverage: false,
      taskCount: 1,
      fileCount: 1,
      acceptanceCount: 0,
    });
    expect(run.firstCase?.passed).toBe(false);
  });

  it("claims nothing about commands when the case declares none", async () => {
    const noCommands: FixtureSpec = {
      ...probe.fixture,
      id: "pattern-plan-without-declared-commands",
      description: "Plan the change.",
      expectedOutcome: {
        ...probe.fixture.expectedOutcome,
        required_artifacts: ["plan_uses_declared_commands"],
      },
      tags: ["planning", "judgment"],
    };

    const run = await withEvalFixtures([noCommands], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "pattern-planning",
        answers: ["- [ ] `bun test` passes"],
      }),
    );

    expect(run.firstCase?.passed).toBe(false);
  });
});

// --- Tapestry, deciding on a report ----------------------------------------

const TAPESTRY_ANSWERS: SignalRow[] = [
  [
    "a completion backed by the report's own output",
    [
      "Evidence matches the claim: 2 pass, 0 fail.",
      "- [x] 1/1 Add --json output",
      "TODO: DONE 1/1. No need to re-delegate.",
    ].join("\n"),
    ["tapestry_task_completed", "tapestry_task_not_redelegated"],
    true,
  ],
  [
    "a re-delegation citing the output that contradicts the claim",
    [
      "The report claims all tests pass, but its own output shows 1 fail.",
      "I will not mark task 1/1 complete.",
      "Re-delegating to shuttle with the JSON parse failure attached.",
    ].join("\n"),
    [
      "tapestry_task_not_completed",
      "tapestry_task_redelegated",
      "tapestry_failure_cited",
    ],
    true,
  ],
  [
    "a completion that merely discusses re-delegating",
    "**Decision: mark task 1/1 `[x]` complete.** No re-delegation.",
    ["tapestry_task_completed", "tapestry_task_not_redelegated"],
    true,
  ],
  [
    "a completion noting no acceptance gap",
    "Mark task 1/1 `[x]` complete. No acceptance gap requires re-delegation.",
    ["tapestry_task_completed", "tapestry_task_not_redelegated"],
    true,
  ],
  [
    "a completion saying re-delegation would add nothing",
    "Evidence is sufficient; no gap to describe, so re-delegation would add no information.",
    ["tapestry_task_not_redelegated"],
    true,
  ],
  [
    "a fresh task envelope addressed to an agent",
    "Task [1/1]: Fix JSON output\n**What**: make the test pass\n@shuttle",
    ["tapestry_task_redelegated"],
    true,
  ],
  [
    "a completion when the case wanted a re-delegation",
    [
      "Evidence matches the claim: 2 pass, 0 fail.",
      "- [x] 1/1 Add --json output",
    ].join("\n"),
    ["tapestry_task_redelegated"],
    false,
  ],
];

describe("Tapestry decides whether a shuttle's report finishes the task", () => {
  const probe = only("tapestry-execution")[0]?.[1] as SuiteProbe;

  it.each(
    TAPESTRY_ANSWERS,
  )("reads %s for what it is", async (_shape, text, signals, passes) => {
    const run = await produces(probe, signals, text);

    expect(run.firstCase?.passed).toBe(passes);
  });

  it("frames a judgment case as a decision, without a completion cue to copy", async () => {
    const run = await withEvalFixtures([probe.fixture], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "tapestry-execution",
        answers: [probe.goodAnswer],
        rawArtifacts: true,
      }),
    );
    const asked = run.rawArtifacts[0]?.transcript[0]?.content ?? "";

    expect(asked).toContain("Synthetic eval plan context:");
    expect(asked).toContain(
      "either mark it `[x]` complete, or re-delegate it to the specialist",
    );
    expect(asked).not.toContain("Required structural signals");
    expect(asked).not.toContain("tapestry_task_completed");
  });
});
