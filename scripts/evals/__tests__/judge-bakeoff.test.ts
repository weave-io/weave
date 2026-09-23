import { describe, expect, it } from "bun:test";
import { StubLangChainJudge } from "../../../packages/cli/src/evals/langchain-agent-evals.js";
import {
  type EvalCase,
  EvalCaseSchema,
  type EvalRubric,
  EvalRubricSchema,
} from "../../../packages/cli/src/evals/types.js";
import {
  agreement,
  type BakeoffItem,
  BakeoffScorer,
  buildItem,
  buildJevRequest,
  compare,
  type FetchLike,
  type HumanLabel,
  type ItemVerdicts,
  JEV_MAX_STATE_CHARS,
  JevClient,
  judgeAcceptance,
  parseJevResponse,
  parseLabelSheet,
  renderComparison,
  renderLabelSheet,
  SonnetBakeoffJudge,
} from "../judge-bakeoff.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function evalCase(overrides: Record<string, unknown>): EvalCase {
  return {
    ...EvalCaseSchema.parse({
      id: "weft-review-clean-approval",
      description: "Approve a clean change.",
      suite: "weft-review",
      allowed_agents: ["weft"],
      expected_outcome: {
        kind: "task_completion",
        description: "Emit an approval review.",
        required_artifacts: ["review_verdict_present", "review_custom_signal"],
      },
      accepted_alternates: [],
      transcript_expectations: [],
      ...overrides,
    }),
    allowed_models: ["test/model"],
  };
}

function rubric(
  required: boolean,
  notes = "Score structure only.",
): EvalRubric {
  return EvalRubricSchema.parse({
    case_id: "weft-review-clean-approval",
    suite: "weft-review",
    scoring: {
      outcome_weight: 0.7,
      per_expectation_weight: 0.3,
      required,
      notes,
    },
  });
}

const RAW = {
  caseId: "weft-review-clean-approval",
  modelId: "test/model",
  transcript: [
    { role: "user" as const, content: "Review this change." },
    { role: "assistant" as const, content: "[APPROVE]" },
  ],
  rawContent: "[APPROVE]\nReviewed files: a.ts",
};

function taskItem(id = "B01"): BakeoffItem {
  return buildItem(
    { id, raw: "unused" },
    RAW,
    evalCase({}),
    rubric(true),
  )._unsafeUnwrap();
}

function routingCase(): EvalCase {
  return evalCase({
    id: "tcr-01-exact-match",
    suite: "tapestry-category-routing",
    allowed_agents: ["tapestry", "shuttle-client-frontend"],
    expected_outcome: {
      kind: "agent_routing",
      target_agent: "shuttle-client-frontend",
      via: [],
    },
    accepted_alternates: ["shuttle"],
  });
}

function jevBody(overall: number, criteria: Record<string, number>): unknown {
  const answers: Record<string, unknown> = {
    overall: { type: "noul", noul: overall },
    quality: { type: "score", score: 2.4, probabilities: {}, confidence: 0.8 },
  };
  for (const [key, noul] of Object.entries(criteria)) {
    answers[key] = { type: "noul", noul };
  }
  return {
    model: "typesafe/jev-1.13-20260917",
    answers,
    usage: { input_tokens: 10, output_tokens: 2, cost: 0.00001 },
  };
}

function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

// ---------------------------------------------------------------------------
// Item construction
// ---------------------------------------------------------------------------

describe("buildItem", () => {
  it("turns each required signal of a task_completion case into a criterion", () => {
    const item = taskItem();
    expect(item.criteria.map((c) => c.key)).toEqual([
      "review_verdict_present",
      "review_custom_signal",
    ]);
    expect(item.criteria[0]?.question).toContain("explicit verdict tag");
    expect(item.criteria[1]?.question).toContain('"review custom signal"');
    expect(item.rubric).toContain("Reviewer notes: Score structure only.");
    expect(item.reference).toContain(
      "required signals: [review_verdict_present",
    );
    expect(item.task).toBe("Review this change.");
    expect(item.response).toBe(RAW.rawContent);
    expect(item.sonnetPassThreshold).toBe(0.5);
  });

  it("asks about the expected outcome when a case names no signals", () => {
    const noSignals = evalCase({
      expected_outcome: {
        kind: "task_completion",
        description: "Execute the plan step.",
        required_artifacts: [],
      },
    });
    const item = buildItem(
      { id: "B01", raw: "x" },
      RAW,
      noSignals,
      rubric(true),
    );
    expect(item._unsafeUnwrap().criteria.map((c) => c.key)).toEqual([
      "meets_expected_outcome",
    ]);
  });

  it("uses the qualitative gate for required category-routing cases only", () => {
    const required = buildItem(
      { id: "B01", raw: "x" },
      RAW,
      routingCase(),
      rubric(true),
    );
    const optional = buildItem(
      { id: "B02", raw: "x" },
      RAW,
      routingCase(),
      rubric(false),
    );
    expect(required._unsafeUnwrap().sonnetPassThreshold).toBe(0.7);
    expect(optional._unsafeUnwrap().sonnetPassThreshold).toBe(0.5);
    expect(required._unsafeUnwrap().criteria[0]?.question).toContain(
      '"shuttle-client-frontend", "shuttle"',
    );
    expect(required._unsafeUnwrap().reference).toBe(
      'Expected: route to "shuttle-client-frontend"; accepted alternates: [shuttle]',
    );
  });

  it("rejects an outcome kind the bake-off does not judge", () => {
    const delegation = evalCase({
      expected_outcome: {
        kind: "delegation_chain",
        chain: ["tapestry", "shuttle"],
      },
    });
    const item = buildItem(
      { id: "B01", raw: "x" },
      RAW,
      delegation,
      rubric(true),
    );
    expect(item._unsafeUnwrapErr().type).toBe("UnsupportedOutcomeKind");
  });

  it("rejects a run with no user message", () => {
    const item = buildItem(
      { id: "B01", raw: "x" },
      { ...RAW, transcript: [] },
      evalCase({}),
      rubric(true),
    );
    expect(item._unsafeUnwrapErr()).toEqual({
      type: "EmptyTranscript",
      itemId: "B01",
    });
  });
});

// ---------------------------------------------------------------------------
// Jev request and response
// ---------------------------------------------------------------------------

describe("buildJevRequest", () => {
  it("asks one noul per criterion, an overall noul and an anchored quality score", () => {
    const request = buildJevRequest(taskItem())._unsafeUnwrap();
    expect(request.model).toBe("typesafe/jev-1.13");
    expect(Object.keys(request.questions)).toEqual([
      "review_verdict_present",
      "review_custom_signal",
      "overall",
      "quality",
    ]);
    expect(request.questions.overall?.type).toBe("noul");
    const quality = request.questions.quality;
    expect(quality?.type === "score" && quality.criteria.length).toBe(4);
    expect(request.state).toContain("# Rubric");
    expect(request.state).toContain("# Agent response\n[APPROVE]");
  });

  it("marks a blank response instead of sending whitespace", () => {
    const item = { ...taskItem(), response: " \n" };
    expect(buildJevRequest(item)._unsafeUnwrap().state).toContain(
      "# Agent response\n(empty response)",
    );
  });

  it("refuses a state longer than Jev's context rather than truncating it", () => {
    const item = { ...taskItem(), response: "x".repeat(JEV_MAX_STATE_CHARS) };
    expect(buildJevRequest(item)._unsafeUnwrapErr().type).toBe("StateTooLong");
  });
});

describe("parseJevResponse", () => {
  const criteria = { review_verdict_present: 0.9, review_custom_signal: 0.3 };

  it("passes when the overall noul reaches the threshold", () => {
    const verdict = parseJevResponse(
      taskItem(),
      jevBody(0.5, criteria),
    )._unsafeUnwrap();
    expect(verdict.pass).toBe(true);
    expect(verdict.allCriteriaPass).toBe(false);
    expect(verdict.modelVersion).toBe("typesafe/jev-1.13-20260917");
    expect(verdict.criteria).toEqual(criteria);
    expect(verdict.quality).toBe(2.4);
    expect(verdict.cost).toBe(0.00001);
  });

  it("fails below the threshold", () => {
    const verdict = parseJevResponse(taskItem(), jevBody(0.49, criteria));
    expect(verdict._unsafeUnwrap().pass).toBe(false);
  });

  it("reports a missing criterion answer", () => {
    const verdict = parseJevResponse(
      taskItem(),
      jevBody(0.9, { review_verdict_present: 1 }),
    );
    expect(verdict._unsafeUnwrapErr()).toMatchObject({
      type: "JevResponseInvalid",
      message: 'answer "review_custom_signal" is missing or not a noul',
    });
  });

  it("reports a body that is not a decision", () => {
    const verdict = parseJevResponse(taskItem(), { error: "nope" });
    expect(verdict._unsafeUnwrapErr().type).toBe("JevResponseInvalid");
  });
});

describe("JevClient", () => {
  it("posts the request with the API key to the decisions endpoint", async () => {
    const { calls, fetchImpl } = stubFetch(
      200,
      jevBody(0.8, { review_verdict_present: 1, review_custom_signal: 1 }),
    );
    const client = new JevClient("test-key", "typesafe/jev-1.13", fetchImpl);
    const verdict = await client.decide(taskItem());
    expect(verdict._unsafeUnwrap().pass).toBe(true);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(
      (calls[0]?.init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer test-key");
    expect(JSON.parse(String(calls[0]?.init.body)).model).toBe(
      "typesafe/jev-1.13",
    );
  });

  it("returns an HTTP error with the status", async () => {
    const { fetchImpl } = stubFetch(429, { error: "rate limited" });
    const client = new JevClient("k", "typesafe/jev-1.13", fetchImpl);
    const verdict = await client.decide(taskItem());
    expect(verdict._unsafeUnwrapErr()).toMatchObject({
      type: "JevHttpError",
      status: 429,
    });
  });
});

// ---------------------------------------------------------------------------
// Sonnet judge and scorer
// ---------------------------------------------------------------------------

describe("SonnetBakeoffJudge", () => {
  it("sends the same rubric, reference and response Jev sees", async () => {
    const stub = new StubLangChainJudge();
    stub.setDefaultOutput({ score: 0.5, rationale: "ok" });
    const item = taskItem();
    const verdict = await new SonnetBakeoffJudge(stub).decide(item);
    expect(verdict._unsafeUnwrap()).toEqual({
      ok: true,
      score: 0.5,
      pass: true,
      rationale: "ok",
    });
    expect(stub.calls[0]).toEqual({
      dimension: "executionCompleteness",
      rubricDescription: item.rubric,
      response: item.response,
      reference: item.reference,
    });
  });

  it("fails an item below its pass threshold", async () => {
    const stub = new StubLangChainJudge();
    stub.setDefaultOutput({ score: 0.69, rationale: "partial" });
    const item = { ...taskItem(), sonnetPassThreshold: 0.7 };
    const verdict = await new SonnetBakeoffJudge(stub).decide(item);
    expect(verdict._unsafeUnwrap().pass).toBe(false);
  });
});

describe("BakeoffScorer", () => {
  it("records a judge failure against the item and keeps scoring", async () => {
    const { fetchImpl } = stubFetch(500, { error: "down" });
    const stub = new StubLangChainJudge();
    stub.setDefaultOutput({ score: 1, rationale: "fine" });
    const scorer = new BakeoffScorer(
      new JevClient("k", "typesafe/jev-1.13", fetchImpl),
      new SonnetBakeoffJudge(stub),
    );
    const verdicts = await scorer.scoreAll([taskItem("B01"), taskItem("B02")]);
    expect(verdicts.map((v) => v.id)).toEqual(["B01", "B02"]);
    expect(verdicts.every((v) => !v.jev.ok && v.sonnet.ok)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Labelling sheet
// ---------------------------------------------------------------------------

describe("renderLabelSheet", () => {
  it("withholds the model id and fences responses that contain fences", () => {
    const item = {
      ...taskItem(),
      response: "Plan:\n```ts\ncode\n```\n## Heading",
    };
    const sheet = renderLabelSheet([item]);
    expect(sheet).not.toContain("test/model");
    expect(sheet).toContain("````text\nPlan:");
    expect(sheet).toContain("**Label (B01):** pass | fail");
  });
});

describe("parseLabelSheet", () => {
  it("reads labels and notes the maintainer filled in", () => {
    const sheet = renderLabelSheet([taskItem("B01"), taskItem("B02")])
      .replace("**Label (B01):** pass | fail", "**Label (B01):** Pass")
      .replace("**Label (B02):** pass | fail", "**Label (B02):** fail")
      .replace("**Note (B02):** ", "**Note (B02):** no file refs");
    const labels = parseLabelSheet(sheet)._unsafeUnwrap();
    expect(labels.get("B01")).toEqual({ verdict: "pass", note: "" });
    expect(labels.get("B02")).toEqual({
      verdict: "fail",
      note: "no file refs",
    });
  });

  it("lists items still unlabelled", () => {
    const sheet = renderLabelSheet([taskItem("B01"), taskItem("B02")]).replace(
      "**Label (B01):** pass | fail",
      "**Label (B01):** pass",
    );
    expect(parseLabelSheet(sheet)._unsafeUnwrapErr()).toEqual({
      type: "MissingLabels",
      ids: ["B02"],
    });
  });
});

// ---------------------------------------------------------------------------
// Agreement
// ---------------------------------------------------------------------------

describe("agreement", () => {
  it("counts the confusion matrix and Cohen's kappa", () => {
    const result = agreement("judge", [
      { human: "pass", judge: "pass" },
      { human: "pass", judge: "pass" },
      { human: "pass", judge: "fail" },
      { human: "fail", judge: "fail" },
      { human: "fail", judge: "pass" },
      { human: "fail", judge: "fail" },
    ]);
    expect(result).toMatchObject({
      n: 6,
      agree: 4,
      passPass: 2,
      failFail: 2,
      failPass: 1,
      passFail: 1,
      errors: 0,
    });
    expect(result.agreement).toBeCloseTo(4 / 6);
    // p_o = 4/6, p_e = 0.5 * 0.5 + 0.5 * 0.5 = 0.5
    expect(result.kappa).toBeCloseTo((4 / 6 - 0.5) / 0.5);
  });

  it("counts a judge error as a disagreement", () => {
    const result = agreement("judge", [
      { human: "pass", judge: "pass" },
      { human: "fail", judge: undefined },
    ]);
    expect(result.agree).toBe(1);
    expect(result.agreement).toBe(0.5);
    expect(result.errors).toBe(1);
  });

  it("leaves kappa undefined when every verdict is the same", () => {
    const result = agreement("judge", [
      { human: "pass", judge: "pass" },
      { human: "pass", judge: "pass" },
    ]);
    expect(result.kappa).toBeNull();
  });
});

function verdicts(
  id: string,
  jevPass: boolean,
  sonnetPass: boolean,
): ItemVerdicts {
  return {
    id,
    jev: {
      ok: true,
      modelVersion: "v",
      overall: jevPass ? 0.9 : 0.1,
      criteria: {},
      quality: 2,
      pass: jevPass,
      allCriteriaPass: jevPass,
      cost: 0,
    },
    sonnet: {
      ok: true,
      score: sonnetPass ? 1 : 0,
      pass: sonnetPass,
      rationale: "r",
    },
  };
}

function labels(
  entries: Array<[string, "pass" | "fail"]>,
): Map<string, HumanLabel> {
  return new Map(entries.map(([id, verdict]) => [id, { verdict, note: "" }]));
}

describe("compare", () => {
  const items = [taskItem("B01"), taskItem("B02")];

  it("reports Sonnet 5 alongside Jev as a reference only", () => {
    const report = compare(
      items,
      [verdicts("B01", true, true), verdicts("B02", true, false)],
      labels([
        ["B01", "pass"],
        ["B02", "fail"],
      ]),
    )._unsafeUnwrap();
    expect(report.jev.agree).toBe(1);
    expect(report.sonnet.agree).toBe(2);
    expect(report.acceptance.accepted).toBe(false);
    expect(report.suites).toEqual([
      { suite: "weft-review", n: 2, jevAgree: 1, sonnetAgree: 2 },
    ]);
  });

  it("states ACCEPTED with the agreement count, false passes and false fails", () => {
    const ids = Array.from(
      { length: 20 },
      (_, i) => `B${String(i + 1).padStart(2, "0")}`,
    );
    // 17 agree (15 pass, 2 fail), 2 false passes, 1 false fail.
    const human: Array<"pass" | "fail"> = ids.map((_, i) =>
      i < 16 ? "pass" : "fail",
    );
    const jevPass = ids.map((_, i) => i < 15 || i === 16 || i === 17);
    const report = compare(
      ids.map((id) => taskItem(id)),
      ids.map((id, i) => verdicts(id, jevPass[i] as boolean, true)),
      labels(ids.map((id, i) => [id, human[i] as "pass" | "fail"])),
    )._unsafeUnwrap();
    expect(report.acceptance).toEqual({
      accepted: true,
      n: 20,
      agree: 17,
      requiredAgree: 16,
      falsePasses: 2,
      maxFalsePasses: 2,
      falseFails: 1,
      errors: 0,
    });
    const markdown = renderComparison(
      report,
      ids.map((id) => taskItem(id)),
      ids.map((id, i) => verdicts(id, jevPass[i] as boolean, true)),
      labels(ids.map((id, i) => [id, human[i] as "pass" | "fail"])),
    );
    expect(markdown).toContain("**Jev: ACCEPTED.**");
    expect(markdown).toContain(
      "| Agrees with the labels | at least 16/20 | 17/20 | met |",
    );
    expect(markdown).toContain(
      "| False passes (Jev pass, human fail) | at most 2 | 2 | met |",
    );
    expect(markdown).toContain(
      "| False fails (Jev fail, human pass) | not limited | 1 | — |",
    );
    expect(markdown).toContain(
      "Sonnet 5, for reference only: 16/20 agree, 4 false passes, 0 false fails.",
    );
  });

  it("refuses to compare until every item is labelled and scored", () => {
    const unlabelled = compare(items, [], labels([["B01", "pass"]]));
    expect(unlabelled._unsafeUnwrapErr()).toEqual({
      type: "MissingLabels",
      ids: ["B02"],
    });
    const unscored = compare(
      items,
      [verdicts("B01", true, true)],
      labels([
        ["B01", "pass"],
        ["B02", "pass"],
      ]),
    );
    expect(unscored._unsafeUnwrapErr()).toEqual({
      type: "MissingVerdicts",
      ids: ["B02"],
    });
  });

  it("rejects a label for an item that does not exist", () => {
    const result = compare(items, [], labels([["B09", "pass"]]));
    expect(result._unsafeUnwrapErr()).toEqual({
      type: "UnknownLabelIds",
      ids: ["B09"],
    });
  });
});

/**
 * Pairs with the given counts: agreed passes, agreed fails, false passes
 * (judge pass, human fail), false fails (judge fail, human pass), errors.
 */
function pairs(counts: {
  passPass: number;
  failFail: number;
  falsePass: number;
  falseFail: number;
  errors?: number;
}): Array<{ human: "pass" | "fail"; judge: "pass" | "fail" | undefined }> {
  const repeat = (
    n: number,
    human: "pass" | "fail",
    judge: "pass" | "fail" | undefined,
  ) => Array.from({ length: n }, () => ({ human, judge }));
  return [
    ...repeat(counts.passPass, "pass", "pass"),
    ...repeat(counts.failFail, "fail", "fail"),
    ...repeat(counts.falsePass, "fail", "pass"),
    ...repeat(counts.falseFail, "pass", "fail"),
    ...repeat(counts.errors ?? 0, "fail", undefined),
  ];
}

describe("judgeAcceptance", () => {
  it("accepts 16/20 agreement with 2 false passes", () => {
    const a = agreement(
      "jev",
      pairs({ passPass: 12, failFail: 4, falsePass: 2, falseFail: 2 }),
    );
    expect(judgeAcceptance(a)).toMatchObject({
      accepted: true,
      agree: 16,
      requiredAgree: 16,
      falsePasses: 2,
      falseFails: 2,
    });
  });

  it("rejects 16/20 agreement with 3 false passes", () => {
    const a = agreement(
      "jev",
      pairs({ passPass: 12, failFail: 4, falsePass: 3, falseFail: 1 }),
    );
    expect(judgeAcceptance(a)).toMatchObject({
      accepted: false,
      agree: 16,
      falsePasses: 3,
    });
  });

  it("rejects 15/20 agreement even with no false passes", () => {
    const a = agreement(
      "jev",
      pairs({ passPass: 11, failFail: 4, falsePass: 0, falseFail: 5 }),
    );
    expect(judgeAcceptance(a)).toMatchObject({
      accepted: false,
      agree: 15,
      requiredAgree: 16,
      falsePasses: 0,
    });
  });

  it("counts a judge error against agreement but not as a false pass", () => {
    const a = agreement(
      "jev",
      pairs({
        passPass: 12,
        failFail: 4,
        falsePass: 2,
        falseFail: 1,
        errors: 1,
      }),
    );
    expect(judgeAcceptance(a)).toMatchObject({
      accepted: true,
      agree: 16,
      falsePasses: 2,
      errors: 1,
    });
  });
});
