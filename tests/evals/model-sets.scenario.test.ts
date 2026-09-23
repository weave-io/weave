/**
 * Eval scenarios — choosing which models a run spends money on.
 *
 * Bucket: evals. A maintainer iterating on a prompt, a case or a rubric wants
 * a cheap run; a baseline wants the full matrix. `--models dev` selects the
 * `dev: true` entries of `evals/model-matrix.json`, a plain run the
 * `default: true` ones (Spec 37, 17.1).
 *
 * The matrix here is the repo's own — `loadModelMatrix()` reads it from a fixed
 * path — so these scenarios read it too, and assert against whichever models
 * it marks, not a hard-coded list that would go stale with the next edit.
 */

import { describe, expect, it } from "bun:test";
import { loadModelMatrix } from "../../packages/cli/src/evals/model-matrix.js";
import {
  type FixtureSpec,
  runEvalSuite,
  withEvalFixtures,
} from "../support/evals.js";

/** An ordinary case: it omits `allowed_models`, like the whole corpus. */
const ORDINARY_CASE: FixtureSpec = {
  id: "loom-route-shuttle",
  suite: "loom-routing",
  description: "Route this backend API task.",
  allowedAgents: ["loom", "shuttle", "thread"],
  expectedOutcome: { kind: "agent_routing", target_agent: "shuttle", via: [] },
  tags: ["routing"],
  inheritModels: true,
};

const GOOD_ANSWER = "→ shuttle for the implementation.";

async function matrixIds(select: "default" | "dev"): Promise<string[]> {
  const matrix = (await loadModelMatrix())._unsafeUnwrap();
  return matrix.models.filter((m) => m[select]).map((m) => m.id);
}

describe("a maintainer runs the cheap development subset", () => {
  it("runs the case on the dev models and no others", async () => {
    const devModels = await matrixIds("dev");

    const run = await withEvalFixtures([ORDINARY_CASE], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "loom-routing",
        answers: [GOOD_ANSWER],
        modelSet: "dev",
      }),
    );

    expect(run.exitCode).toBe(0);
    expect(run.partialFailures).toEqual([]);
    expect(run.modelCalls.map((call) => call.model)).toEqual(devModels);
  });

  it("reaches an ordinary case without the case naming the dev models", async () => {
    const devModels = await matrixIds("dev");

    const run = await withEvalFixtures([ORDINARY_CASE], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "loom-routing",
        answers: [GOOD_ANSWER],
        modelSet: "dev",
      }),
    );

    expect(run.cases.map((c) => c.modelId).sort()).toEqual(
      [...devModels].sort(),
    );
    expect(run.cases.every((c) => c.caseId === ORDINARY_CASE.id)).toBe(true);
  });

  it("does not run a case that pins itself to a model outside the subset", async () => {
    const pinned: FixtureSpec = {
      ...ORDINARY_CASE,
      id: "loom-route-pinned",
      inheritModels: false,
      allowedModels: ["openai/gpt-4o-mini"],
    };

    const run = await withEvalFixtures([pinned], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "loom-routing",
        answers: [GOOD_ANSWER],
        modelSet: "dev",
      }),
    );

    expect(run.modelCalls).toEqual([]);
    expect(run.partialFailures[0]?.type).toBe("NoCasesFound");
    expect(run.exitCode).toBe(1);
  });
});

describe("a maintainer runs the full matrix, as a plain eval run does", () => {
  it("runs the default models, and not a dev model the defaults leave out", async () => {
    const defaultModels = await matrixIds("default");
    const devOnly = (await matrixIds("dev")).filter(
      (id) => !defaultModels.includes(id),
    );

    const run = await withEvalFixtures([ORDINARY_CASE], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "loom-routing",
        answers: [GOOD_ANSWER],
        wholeMatrix: true,
      }),
    );

    const called = run.modelCalls.map((call) => call.model);
    expect(called).toEqual(defaultModels);
    for (const id of devOnly) {
      expect(called).not.toContain(id);
    }
  });

  it("means the same thing when --models default is spelled out", async () => {
    const defaultModels = await matrixIds("default");

    const run = await withEvalFixtures([ORDINARY_CASE], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "loom-routing",
        answers: [GOOD_ANSWER],
        modelSet: "default",
      }),
    );

    expect(run.modelCalls.map((call) => call.model)).toEqual(defaultModels);
  });
});
