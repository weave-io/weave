/**
 * What is left of `pattern-planning-runner.ts`'s unit tests.
 *
 * Every structural signal a plan produces, and everything a run publishes,
 * moved to
 * [`tests/evals/suite-runners.scenario.test.ts`](../../../../../tests/evals/suite-runners.scenario.test.ts),
 * which drives the real runner through `EvalOrchestrator` and asserts the
 * score a plan earns.
 *
 * What stays is the acceptance-criteria reader. The list it returns is never
 * published: only the derived `plan_criteria_have_verify_by` signal is, and a
 * miscollected criterion can still produce the right signal. These layouts —
 * nested under a task, flat, bold labels with the colon inside — are what a
 * plan actually looks like, and nothing outside the module reveals whether
 * they were read correctly.
 */

import { describe, expect, it } from "bun:test";
import { extractAcceptanceCriteria } from "../pattern-planning-runner.js";

describe("extractAcceptanceCriteria", () => {
  it("collects nested criteria per task and stops at the next task or field", () => {
    const criteria = extractAcceptanceCriteria(
      [
        "- [ ] 1. First",
        "  - **Acceptance**:",
        "    - A passes",
        "      and wraps",
        "    - B passes",
        "  - **Depends on**: None",
        "- [ ] 2. Second",
        "  - **Acceptance**: C passes",
        "## Verification",
        "- [ ] `bun test`",
      ].join("\n"),
    );
    expect(criteria).toEqual(["A passes and wraps", "B passes", "C passes"]);
  });

  it("handles a flat layout and bold labels with the colon inside", () => {
    const criteria = extractAcceptanceCriteria(
      [
        "**Acceptance:**",
        "- A passes",
        "- **Files:** `src/a.ts`",
        "- not a criterion",
      ].join("\n"),
    );
    expect(criteria).toEqual(["A passes"]);
  });
});
