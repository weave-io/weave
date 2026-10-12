/**
 * Guards the `thread-exploration` case corpus itself (Spec 39, gap G10).
 *
 * Every case gives Thread a synthetic codebase excerpt (numbered files of a
 * small fake project) and one question, and tests one exploration behaviour.
 * The judge reads that behaviour from the case's expected outcome and rubric
 * notes, so the model must never see either. The excerpt's line numbers are
 * what the answer's `path:line` citations are judged against, so each case's
 * files must be numbered from 1 and every line the expected outcome cites
 * must exist. A fixture edit that broke the numbering, leaked the expected
 * behaviour into the brief or turned a case into a deterministic `judgment`
 * case would change what the suite measures without any scenario noticing: a
 * scenario brings its own corpus.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { isJudgmentCase } from "../judgment-cases.js";
import { buildUserMessage } from "../thread-exploration-runner.js";
import type { EvalCase } from "../types.js";

const evalsDir = join(import.meta.dir, "../../../../../evals");

/** The cases where a path and line are not what the answer is about. */
const CONFIDENCE_ONLY_CASES = ["thread-exploration-says-not-found"];

async function threadCases(): Promise<EvalCase[]> {
  const cases: EvalCase[] = [];
  for (const name of new Bun.Glob("*.json").scanSync(
    `${evalsDir}/cases/thread-exploration`,
  )) {
    cases.push(
      await Bun.file(`${evalsDir}/cases/thread-exploration/${name}`).json(),
    );
  }
  return cases;
}

function requiredSignals(evalCase: EvalCase): string[] {
  const outcome = evalCase.expected_outcome;
  return outcome.kind === "task_completion" ? outcome.required_artifacts : [];
}

async function rubricNotes(caseId: string): Promise<string> {
  const rubric = await Bun.file(
    `${evalsDir}/rubrics/thread-exploration/${caseId}.json`,
  ).json();
  expect(rubric.case_id).toBe(caseId);
  expect(rubric.scoring.required).toBe(true);
  return rubric.scoring.notes ?? "";
}

/** Each fenced file in a description as `[path, numbered lines]`. */
function shownFiles(description: string): Array<[string, string[]]> {
  const files: Array<[string, string[]]> = [];
  const re = /`([^`\n]+)`\n```\n([\s\S]*?)\n```/g;
  for (const match of description.matchAll(re)) {
    files.push([match[1] as string, (match[2] as string).split("\n")]);
  }
  return files;
}

describe("the thread-exploration corpus", () => {
  it("holds at least 12 text cases, the Spec 39 publication bar", async () => {
    expect((await threadCases()).length).toBeGreaterThanOrEqual(12);
  });

  it("asks for locations and a confidence statement, and leaves the verdict to the judge", async () => {
    for (const evalCase of await threadCases()) {
      expect(evalCase.id).toStartWith("thread-exploration-");
      expect(evalCase.allowed_agents).toEqual(["thread"]);
      expect(requiredSignals(evalCase)).toEqual(
        CONFIDENCE_ONLY_CASES.includes(evalCase.id)
          ? ["thread_confidence_stated"]
          : ["thread_locations_cited", "thread_confidence_stated"],
      );
      expect(isJudgmentCase(evalCase)).toBe(false);
    }
  });

  it("gives every case a question and numbered files, and rubric notes saying what fails", async () => {
    for (const evalCase of await threadCases()) {
      expect(evalCase.description).toStartWith("Exploration question:");
      expect(shownFiles(evalCase.description).length).toBeGreaterThan(0);
      expect(await rubricNotes(evalCase.id)).toContain("Fail the answer if");
    }
  });

  it("numbers every shown file from 1 in order, so cited lines can be checked", async () => {
    for (const evalCase of await threadCases()) {
      for (const [path, lines] of shownFiles(evalCase.description)) {
        lines.forEach((line, index) => {
          expect(
            line.startsWith(`${index + 1} |`),
            `${evalCase.id} ${path} line ${index + 1}`,
          ).toBe(true);
        });
      }
    }
  });

  it("cites in the expected outcome only lines the case's files have", async () => {
    for (const evalCase of await threadCases()) {
      const outcome = evalCase.expected_outcome;
      if (outcome.kind !== "task_completion") continue;
      const files = new Map(shownFiles(evalCase.description));
      for (const match of outcome.description.matchAll(
        /`([\w./-]+\.(?:ts|json)):(\d+)`/g,
      )) {
        const lines = files.get(match[1] as string);
        expect(lines, `${evalCase.id} cites ${match[1]}`).toBeDefined();
        expect(
          Number(match[2]),
          `${evalCase.id} ${match[1]}:${match[2]}`,
        ).toBeLessThanOrEqual(lines?.length ?? 0);
      }
    }
  });

  it("never shows the model a case's expected outcome or rubric notes", async () => {
    for (const evalCase of await threadCases()) {
      const outcome = evalCase.expected_outcome;
      if (outcome.kind !== "task_completion") continue;
      const message = buildUserMessage(evalCase);

      expect(message).toContain(evalCase.description);
      expect(message).not.toContain(outcome.description);
      expect(message).not.toContain(await rubricNotes(evalCase.id));
    }
  });
});
