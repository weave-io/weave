/**
 * Eval scenarios — which Weave config a run scores (Spec 39, task 0.1).
 *
 * Bucket: evals. A maintainer runs `weave eval run` inside a checkout that
 * has its own `.weave/`, as this repository does: it overrides Shuttle's and
 * Weft's prompts for work on Weave itself. A run cited as evidence for a
 * model or a prompt must score the prompts users get, so:
 *
 * - a run composes from the shipped builtins unless `--config project` is
 *   given, and sends the model the shipped prompt, not the checkout's;
 * - the run records which config it composed from, in `bundle-index.json`
 *   and `provenance-manifest.json`, so `weave eval compare` can refuse to
 *   compare runs made from different configs (`compare.scenario.test.ts`).
 *
 * The scenarios compose for real (`composePrompts`) from the repository
 * root, whose `.weave/` overrides Shuttle. Builtin mode reads no config file,
 * so they stay hermetic. Project mode would read the real checkout, so it is
 * covered by the fixture-backed unit tests in
 * `packages/cli/src/evals/__tests__/prompt-snapshots.test.ts` instead.
 */

import { describe, expect, it } from "bun:test";
import {
  type FixtureSpec,
  runEvalSuite,
  withEvalFixtures,
} from "../support/evals.js";

const SHUTTLE_CASE: FixtureSpec = {
  id: "shuttle-config-mode",
  suite: "shuttle-execution",
  description: "Task [1/1]: Update the docs. Files: `evals/README.md`.",
  allowedAgents: ["shuttle"],
  expectedOutcome: {
    kind: "task_completion",
    description: "Report the evidence honestly.",
    required_artifacts: ["shuttle_task_intake_structured"],
  },
  tags: ["execution"],
};

/** The opening of the shipped Shuttle prompt, rendered for Shuttle. */
const SHIPPED_SHUTTLE_ROLE =
  "You are **shuttle**, the domain specialist worker.";
/** The title of this repository's own Shuttle override. */
const REPO_SHUTTLE_TITLE = "(Weave Repo)";

describe("a maintainer runs the evals inside a checkout that overrides Shuttle's prompt", () => {
  const runShuttle = () =>
    withEvalFixtures([SHUTTLE_CASE], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "shuttle-execution",
        composePrompts: true,
      }),
    );

  it("sends the model the shipped Shuttle prompt, not the checkout's override", async () => {
    const run = await runShuttle();

    const system = run.modelCalls[0]?.messages.find(
      (message) => message.role === "system",
    )?.content;
    expect(system).toContain(SHIPPED_SHUTTLE_ROLE);
    expect(system).not.toContain(REPO_SHUTTLE_TITLE);
  });

  it("records that the prompts came from the builtin config", async () => {
    const run = await runShuttle();

    expect(run.bundleIndex?.configMode).toBe("builtin");
    expect(run.provenanceManifest?.configMode).toBe("builtin");
  });
});

describe("a maintainer runs the evals with --config project for prompt work", () => {
  it("records that the prompts came from the project config", async () => {
    const run = await withEvalFixtures([SHUTTLE_CASE], (evalsRoot) =>
      runEvalSuite({
        evalsRoot,
        agent: "shuttle-execution",
        configMode: "project",
      }),
    );

    expect(run.bundleIndex?.configMode).toBe("project");
    expect(run.provenanceManifest?.configMode).toBe("project");
  });
});
