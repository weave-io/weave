import { describe, expect, it } from "bun:test";
import {
  buildRequiredSignalsLine,
  extractCodeLocations,
  extractCodeMaterial,
  isJudgmentCase,
  isTracedFinding,
  isTracedThroughDeclaredSymbol,
  JUDGMENT_CASE_TAG,
} from "../judgment-cases.js";
import type { EvalCase } from "../types.js";

function makeCase(tags: string[]): EvalCase {
  return {
    id: "judgment-case",
    description: "Synthetic case.",
    suite: "weft-review",
    allowed_agents: ["weft"],
    allowed_models: ["anthropic/claude-sonnet-4.5"],
    expected_outcome: {
      kind: "task_completion",
      description: "Reach the right verdict.",
      required_artifacts: ["review_verdict_approve"],
    },
    accepted_alternates: [],
    transcript_expectations: [],
    tags,
  };
}

describe("isJudgmentCase", () => {
  it("is true only when the judgment tag is present", () => {
    expect(isJudgmentCase(makeCase([JUDGMENT_CASE_TAG]))).toBe(true);
    expect(isJudgmentCase(makeCase(["review"]))).toBe(false);
  });
});

describe("buildRequiredSignalsLine", () => {
  it("lists signals for structural cases and withholds them for judgment cases", () => {
    const signals = ["review_verdict_approve"];
    expect(buildRequiredSignalsLine(makeCase([]), signals)).toBe(
      "Required structural signals: review_verdict_approve",
    );
    expect(buildRequiredSignalsLine(makeCase([]), [])).toBe(
      "Required structural signals: none",
    );
    expect(
      buildRequiredSignalsLine(makeCase([JUDGMENT_CASE_TAG]), signals),
    ).not.toContain("review_verdict_approve");
  });
});

describe("extractCodeLocations", () => {
  it("reads path:line, ranges, and #L anchors as distinct locations", () => {
    expect(
      extractCodeLocations(
        "`src/a.ts:3` calls `src/b.ts:10-12`; see also lib/c.go#L7",
      ).sort(),
    ).toEqual(["lib/c.go:7", "src/a.ts:3", "src/b.ts:10"]);
  });

  it("reads prose line references after a path", () => {
    expect(
      extractCodeLocations(
        "`src/a.ts` (line 32) calls `src/b.ts` (lines 10-12); src/c.ts, at line 4; src/d.ts line 9",
      ).sort(),
    ).toEqual(["src/a.ts:32", "src/b.ts:10", "src/c.ts:4", "src/d.ts:9"]);
  });

  it("keeps two prose line references in the same file as two locations", () => {
    expect(
      extractCodeLocations("`src/a.ts` (line 3) flows to `src/a.ts` (line 9)"),
    ).toHaveLength(2);
  });

  it("drops a bare path already cited with a line number", () => {
    expect(extractCodeLocations("`src/a.ts` at `src/a.ts:3`")).toEqual([
      "src/a.ts:3",
    ]);
  });

  it("keeps two lines in the same file as two locations", () => {
    expect(extractCodeLocations("src/a.ts:3 flows to src/a.ts:9")).toHaveLength(
      2,
    );
  });

  it("ignores a bare file name that has neither a directory nor a line", () => {
    expect(
      extractCodeLocations(
        '`src/commands/__tests__/settings.test.ts:8` checks that saveSettings receives `"settings.json"`',
      ),
    ).toEqual(["src/commands/__tests__/settings.test.ts:8"]);
    expect(extractCodeLocations("see mean.ts:5")).toEqual(["mean.ts:5"]);
  });

  it("ignores member access that is not a file path", () => {
    expect(
      extractCodeLocations("ResultAsync.fromPromise and JSON.stringify"),
    ).toEqual([]);
  });
});

describe("isTracedFinding", () => {
  it("requires at least two distinct locations", () => {
    expect(isTracedFinding("`src/a.ts:3` reaches `src/b.ts:4`")).toBe(true);
    expect(isTracedFinding("`src/a.ts:3` is unsafe")).toBe(false);
  });
});

const MATERIAL = [
  "`src/settings/store.ts` (unchanged):",
  "```ts",
  "10 export function saveSettings(path: string): ResultAsync<void, E> {",
  "```",
  "`src/commands/settings.ts` (changed):",
  "```ts",
  "30 export async function runSettings(args: Args): Promise<number> {",
  "31   const spy = 1;",
  "32   saveSettings(args.path);",
  "```",
  "`src/commands/settings.test.ts` (added):",
  "```ts",
  '5 const spy = spyOn(store, "saveSettings");',
  "```",
].join("\n");

describe("extractCodeMaterial", () => {
  it("maps each function to the file whose block declares it", () => {
    expect([...extractCodeMaterial(MATERIAL).declared]).toEqual([
      ["saveSettings", "src/settings/store.ts"],
      ["runSettings", "src/commands/settings.ts"],
    ]);
  });

  it("records what each file calls, not what it declares", () => {
    const { calls } = extractCodeMaterial(MATERIAL);
    expect(calls.get("src/commands/settings.ts")?.has("saveSettings")).toBe(
      true,
    );
    expect(calls.get("src/commands/settings.ts")?.has("runSettings")).toBe(
      false,
    );
    expect(
      calls.get("src/commands/settings.test.ts")?.has("saveSettings"),
    ).toBe(false);
  });

  it("drops a name declared in two files", () => {
    const twice = `${MATERIAL}\n\`src/other.ts\`:\n\`\`\`ts\nfunction saveSettings() {}\n\`\`\``;
    expect(extractCodeMaterial(twice).declared.has("saveSettings")).toBe(false);
  });
});

describe("isTracedThroughDeclaredSymbol", () => {
  const code = extractCodeMaterial(MATERIAL);

  it("accepts a cited call site plus the function it calls from another file", () => {
    expect(
      isTracedThroughDeclaredSymbol(
        "`src/commands/settings.ts:32` drops the result of `saveSettings`",
        code,
      ),
    ).toBe(true);
  });

  it("rejects the enclosing function, a file that never calls it, or no path", () => {
    expect(
      isTracedThroughDeclaredSymbol(
        "`src/commands/settings.ts:32` in `runSettings` drops it",
        code,
      ),
    ).toBe(false);
    expect(
      isTracedThroughDeclaredSymbol(
        "`src/commands/settings.test.ts:5` only spies on `saveSettings`",
        code,
      ),
    ).toBe(false);
    expect(
      isTracedThroughDeclaredSymbol("`saveSettings` is not awaited", code),
    ).toBe(false);
  });
});
