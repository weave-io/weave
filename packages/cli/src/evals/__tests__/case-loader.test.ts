/**
 * Tests for `case-loader.ts`.
 *
 * Verifies:
 *   - `loadCaseFile()` parses valid fixture files and validates them against
 *     `EvalCaseSchema`.
 *   - `loadCaseFile()` rejects files with schema violations, unknown agents,
 *     missing fields, and invalid identifiers — each with a typed error that
 *     includes the offending file path.
 *   - `loadRubricFile()` parses valid rubric files.
 *   - `loadRubricFile()` rejects invalid rubric files with typed errors.
 *   - `loadSuiteCases()` loads all case files in a suite directory.
 *   - `loadSuiteRubrics()` loads all rubric files in a suite directory.
 *   - `validateCaseFilter()` matches by exact case id and returns a typed
 *     error for unknown ids.
 *
 * Test isolation:
 *   - All I/O uses files written to the temp directory — no network, git, or
 *     shell calls.
 *   - Fixture directories are created inline in each test using `Bun.write`.
 *
 * No mocking of `Bun.file` is required because the loaders take explicit
 * file paths and we write real temp files.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  KNOWN_AGENTS,
  loadCaseFile,
  loadRubricFile,
  loadSuiteCases,
  loadSuiteRubrics,
  validateCaseFilter,
} from "../case-loader.js";
import type { EvalCase } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEMP_DIR = tmpdir();

let _counter = 0;
function uid(): string {
  return String(Date.now()) + String(++_counter);
}

async function writeTempJson(name: string, content: unknown): Promise<string> {
  const filePath = resolve(TEMP_DIR, `case-loader-test-${name}-${uid()}.json`);
  await Bun.write(filePath, JSON.stringify(content));
  return filePath;
}

/** Create a minimal valid case fixture object. */
function makeCase(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "test-case-01",
    description: "A test eval case",
    suite: "loom-routing",
    allowed_agents: ["loom", "shuttle"],
    allowed_models: ["anthropic/claude-sonnet-4-5"],
    expected_outcome: {
      kind: "agent_routing",
      target_agent: "shuttle",
      via: ["loom"],
    },
    accepted_alternates: [],
    transcript_expectations: [],
    tags: [],
    ...overrides,
  };
}

/** Create a minimal valid rubric fixture object. */
function makeRubric(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    case_id: "test-case-01",
    suite: "loom-routing",
    scoring: {
      outcome_weight: 0.8,
      per_expectation_weight: 0.2,
      required: true,
    },
    ...overrides,
  };
}

/** Write a suite of case files and return the evalsRoot temp path. */
async function writeSuiteCases(
  suite: string,
  cases: Record<string, unknown>[],
): Promise<string> {
  const evalsRoot = resolve(TEMP_DIR, `evals-root-${uid()}`);
  const casesDir = resolve(evalsRoot, "cases", suite);
  for (const c of cases) {
    const id = String(c.id ?? uid());
    await Bun.write(resolve(casesDir, `${id}.json`), JSON.stringify(c));
  }
  return evalsRoot;
}

/** Write a suite of rubric files and return the evalsRoot temp path. */
async function writeSuiteRubrics(
  suite: string,
  rubrics: Record<string, unknown>[],
  evalsRoot?: string,
): Promise<string> {
  const root = evalsRoot ?? resolve(TEMP_DIR, `evals-root-${uid()}`);
  const rubricsDir = resolve(root, "rubrics", suite);
  for (const r of rubrics) {
    const id = String(r.case_id ?? uid());
    await Bun.write(resolve(rubricsDir, `${id}.json`), JSON.stringify(r));
  }
  return root;
}

// ---------------------------------------------------------------------------
// loadCaseFile — happy paths
// ---------------------------------------------------------------------------

describe("loadCaseFile — happy paths", () => {
  it("loads a valid agent_routing case fixture", async () => {
    const filePath = await writeTempJson("valid-routing", makeCase());
    const result = await loadCaseFile(filePath);
    expect(result.isOk()).toBe(true);
    const c = result._unsafeUnwrap();
    expect(c.id).toBe("test-case-01");
    expect(c.suite).toBe("loom-routing");
  });

  it("loads a valid task_completion case fixture", async () => {
    const filePath = await writeTempJson(
      "valid-completion",
      makeCase({
        expected_outcome: {
          kind: "task_completion",
          description: "Task is done",
          required_artifacts: [],
        },
      }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isOk()).toBe(true);
    const c = result._unsafeUnwrap();
    expect(c.expected_outcome.kind).toBe("task_completion");
  });

  it("loads a valid delegation_chain case fixture", async () => {
    const filePath = await writeTempJson(
      "valid-delegation",
      makeCase({
        expected_outcome: {
          kind: "delegation_chain",
          chain: ["tapestry", "shuttle"],
        },
        allowed_agents: ["tapestry", "shuttle"],
      }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isOk()).toBe(true);
    const c = result._unsafeUnwrap();
    expect(c.expected_outcome.kind).toBe("delegation_chain");
  });

  it("loads a valid tool_call case fixture", async () => {
    const filePath = await writeTempJson(
      "valid-tool-call",
      makeCase({
        expected_outcome: {
          kind: "tool_call",
          tool_name: "delegate",
          payload_contains: { target: "shuttle" },
        },
      }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isOk()).toBe(true);
    const c = result._unsafeUnwrap();
    expect(c.expected_outcome.kind).toBe("tool_call");
  });

  it("applies defaults for optional array fields", async () => {
    const filePath = await writeTempJson("defaults", {
      id: "test-defaults",
      description: "Minimal fixture",
      suite: "loom-routing",
      allowed_agents: ["loom"],
      allowed_models: ["anthropic/claude-sonnet-4-5"],
      expected_outcome: {
        kind: "agent_routing",
        target_agent: "loom",
        via: [],
      },
    });
    const result = await loadCaseFile(filePath);
    expect(result.isOk()).toBe(true);
    const c = result._unsafeUnwrap();
    expect(c.accepted_alternates).toEqual([]);
    expect(c.transcript_expectations).toEqual([]);
    expect(c.tags).toEqual([]);
  });

  it("loads transcript_expectations correctly", async () => {
    const filePath = await writeTempJson(
      "transcript-expectations",
      makeCase({
        transcript_expectations: [
          { check: "content_contains", role: "assistant", contains: "hello" },
          { check: "tool_called", tool_name: "delegate" },
          { check: "agent_mentioned", agent_name: "shuttle" },
          { check: "no_tool_called", tool_name: "dangerous_tool" },
        ],
      }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isOk()).toBe(true);
    const c = result._unsafeUnwrap();
    expect(c.transcript_expectations).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// loadCaseFile — schema error paths
// ---------------------------------------------------------------------------

describe("loadCaseFile — schema validation failures", () => {
  it("returns FixtureValidationFailed for missing id", async () => {
    const filePath = await writeTempJson("missing-id", {
      description: "no id",
      suite: "loom-routing",
      allowed_agents: ["loom"],
      allowed_models: ["anthropic/claude-sonnet-4-5"],
      expected_outcome: {
        kind: "agent_routing",
        target_agent: "loom",
        via: [],
      },
    });
    const result = await loadCaseFile(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("FixtureValidationFailed");
    if (e.type === "FixtureValidationFailed") {
      expect(e.file).toBe(filePath);
      expect(e.issues.length).toBeGreaterThan(0);
    }
  });

  it("returns FixtureValidationFailed for invalid id characters", async () => {
    const filePath = await writeTempJson(
      "invalid-id-chars",
      makeCase({ id: "invalid id with spaces" }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("FixtureValidationFailed");
    if (e.type === "FixtureValidationFailed") {
      expect(e.file).toBe(filePath);
    }
  });

  it("returns FixtureValidationFailed for empty description", async () => {
    const filePath = await writeTempJson(
      "empty-desc",
      makeCase({ description: "" }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("FixtureValidationFailed");
  });

  it("returns FixtureValidationFailed for empty allowed_agents", async () => {
    const filePath = await writeTempJson(
      "empty-agents",
      makeCase({ allowed_agents: [] }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("FixtureValidationFailed");
  });

  it("returns FixtureValidationFailed for empty allowed_models", async () => {
    const filePath = await writeTempJson(
      "empty-models",
      makeCase({ allowed_models: [] }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("FixtureValidationFailed");
  });

  it("returns FixtureValidationFailed for unknown expected_outcome kind", async () => {
    const filePath = await writeTempJson(
      "unknown-kind",
      makeCase({ expected_outcome: { kind: "unknown_kind", target: "loom" } }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("FixtureValidationFailed");
  });

  it("returns FixtureValidationFailed for delegation_chain with fewer than 2 agents", async () => {
    const filePath = await writeTempJson(
      "short-chain",
      makeCase({
        expected_outcome: { kind: "delegation_chain", chain: ["tapestry"] },
        allowed_agents: ["tapestry"],
      }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("FixtureValidationFailed");
  });

  it("returns FixtureValidationFailed for unknown agent in allowed_agents", async () => {
    const filePath = await writeTempJson(
      "unknown-agent",
      makeCase({ allowed_agents: ["loom", "totally-unknown-agent"] }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("FixtureValidationFailed");
    if (e.type === "FixtureValidationFailed") {
      expect(e.file).toBe(filePath);
      expect(e.message).toContain("totally-unknown-agent");
    }
  });

  it("accepts current VNext category shuttles and thread", async () => {
    expect(KNOWN_AGENTS.has("thread")).toBe(true);
    expect(KNOWN_AGENTS.has("shuttle-core")).toBe(true);
    expect(KNOWN_AGENTS.has("shuttle-engine")).toBe(true);
    expect(KNOWN_AGENTS.has("shuttle-adapters")).toBe(true);
    expect(KNOWN_AGENTS.has("shuttle-docs")).toBe(true);
    expect(KNOWN_AGENTS.has("shuttle-scripts")).toBe(true);
  });

  it("keeps legacy category shuttles valid for historical fixtures", async () => {
    expect(KNOWN_AGENTS.has("shuttle-backend")).toBe(true);
    expect(KNOWN_AGENTS.has("shuttle-frontend")).toBe(true);
  });

  it("returns FixtureFileNotFound for a missing file path", async () => {
    const result = await loadCaseFile("/nonexistent/path/case.json");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("FixtureFileNotFound");
  });

  it("typed error includes the offending file path", async () => {
    const filePath = await writeTempJson(
      "error-path",
      makeCase({ id: "bad id!" }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    if (e.type === "FixtureValidationFailed") {
      expect(e.file).toBe(filePath);
    }
  });
});

// ---------------------------------------------------------------------------
// loadRubricFile — happy paths and errors
// ---------------------------------------------------------------------------

describe("loadRubricFile — happy paths", () => {
  it("loads a valid rubric fixture", async () => {
    const filePath = await writeTempJson("valid-rubric", makeRubric());
    const result = await loadRubricFile(filePath);
    expect(result.isOk()).toBe(true);
    const r = result._unsafeUnwrap();
    expect(r.case_id).toBe("test-case-01");
    expect(r.suite).toBe("loom-routing");
    expect(r.scoring.outcome_weight).toBe(0.8);
  });

  it("applies default for per_expectation_weight when omitted", async () => {
    const filePath = await writeTempJson(
      "rubric-defaults",
      makeRubric({ scoring: { outcome_weight: 0.9, required: true } }),
    );
    const result = await loadRubricFile(filePath);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().scoring.per_expectation_weight).toBe(0);
  });
});

describe("loadRubricFile — schema validation failures", () => {
  it("returns FixtureValidationFailed for missing case_id", async () => {
    const filePath = await writeTempJson("rubric-no-id", {
      suite: "loom-routing",
      scoring: { outcome_weight: 0.8, required: true },
    });
    const result = await loadRubricFile(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("FixtureValidationFailed");
    if (e.type === "FixtureValidationFailed") {
      expect(e.file).toBe(filePath);
    }
  });

  it("returns FixtureValidationFailed for outcome_weight > 1", async () => {
    const filePath = await writeTempJson(
      "rubric-bad-weight",
      makeRubric({ scoring: { outcome_weight: 1.5, required: true } }),
    );
    const result = await loadRubricFile(filePath);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("FixtureValidationFailed");
  });

  it("returns FixtureFileNotFound for a missing file", async () => {
    const result = await loadRubricFile("/nonexistent/rubric.json");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("FixtureFileNotFound");
  });
});

// ---------------------------------------------------------------------------
// loadSuiteCases
// ---------------------------------------------------------------------------

describe("loadSuiteCases", () => {
  it("loads all case files in a suite directory", async () => {
    const evalsRoot = await writeSuiteCases("loom-routing", [
      makeCase({ id: "case-a" }),
      makeCase({ id: "case-b" }),
      makeCase({ id: "case-c" }),
    ]);
    const result = await loadSuiteCases("loom-routing", evalsRoot);
    expect(result.isOk()).toBe(true);
    const cases = result._unsafeUnwrap();
    expect(cases).toHaveLength(3);
    const ids = cases.map((c) => c.id).sort();
    expect(ids).toEqual(["case-a", "case-b", "case-c"]);
  });

  it("returns empty array when suite directory has no JSON files", async () => {
    const evalsRoot = resolve(TEMP_DIR, `evals-root-empty-${uid()}`);
    // Create the directory but write no files into it
    await Bun.write(resolve(evalsRoot, "cases/loom-routing/.gitkeep"), "");
    const result = await loadSuiteCases("loom-routing", evalsRoot);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(0);
  });

  it("returns empty array for a non-existent suite directory", async () => {
    const evalsRoot = resolve(TEMP_DIR, `evals-root-nonexistent-${uid()}`);
    const result = await loadSuiteCases("nonexistent-suite", evalsRoot);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(0);
  });

  it("returns a FixtureValidationFailed error when one case file is invalid", async () => {
    const evalsRoot = await writeSuiteCases("loom-routing", [
      makeCase({ id: "valid-case" }),
      {
        id: "bad id with spaces",
        description: "invalid",
        suite: "loom-routing",
        allowed_agents: ["loom"],
        allowed_models: ["anthropic/claude-sonnet-4-5"],
        expected_outcome: {
          kind: "agent_routing",
          target_agent: "loom",
          via: [],
        },
      },
    ]);
    const result = await loadSuiteCases("loom-routing", evalsRoot);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("FixtureValidationFailed");
  });

  it("stops on the first invalid file and returns its path", async () => {
    const evalsRoot = await writeSuiteCases("loom-routing", [
      { no_id: true, suite: "loom-routing" }, // invalid - no id
    ]);
    const result = await loadSuiteCases("loom-routing", evalsRoot);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    if (e.type === "FixtureValidationFailed") {
      expect(e.file).toContain("loom-routing");
    }
  });
});

// ---------------------------------------------------------------------------
// loadSuiteRubrics
// ---------------------------------------------------------------------------

describe("loadSuiteRubrics", () => {
  it("loads all rubric files in a suite directory", async () => {
    const evalsRoot = await writeSuiteRubrics("tapestry-execution", [
      makeRubric({ case_id: "rubric-a", suite: "tapestry-execution" }),
      makeRubric({ case_id: "rubric-b", suite: "tapestry-execution" }),
    ]);
    const result = await loadSuiteRubrics("tapestry-execution", evalsRoot);
    expect(result.isOk()).toBe(true);
    const rubrics = result._unsafeUnwrap();
    expect(rubrics).toHaveLength(2);
  });

  it("returns empty array when suite directory has no rubric files", async () => {
    const evalsRoot = resolve(TEMP_DIR, `evals-root-no-rubrics-${uid()}`);
    await Bun.write(
      resolve(evalsRoot, "rubrics/tapestry-execution/.gitkeep"),
      "",
    );
    const result = await loadSuiteRubrics("tapestry-execution", evalsRoot);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(0);
  });

  it("returns FixtureValidationFailed for an invalid rubric file", async () => {
    const evalsRoot = await writeSuiteRubrics("tapestry-execution", [
      { no_case_id: true }, // invalid
    ]);
    const result = await loadSuiteRubrics("tapestry-execution", evalsRoot);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("FixtureValidationFailed");
  });
});

// ---------------------------------------------------------------------------
// validateCaseFilter
// ---------------------------------------------------------------------------

describe("validateCaseFilter", () => {
  const cases: EvalCase[] = [
    {
      id: "case-alpha",
      description: "First case",
      suite: "loom-routing",
      allowed_agents: ["loom", "shuttle"],
      allowed_models: ["anthropic/claude-sonnet-4-5"],
      expected_outcome: {
        kind: "agent_routing",
        target_agent: "shuttle",
        via: ["loom"],
      },
      accepted_alternates: [],
      transcript_expectations: [],
      tags: [],
    },
    {
      id: "case-beta",
      description: "Second case",
      suite: "loom-routing",
      allowed_agents: ["loom"],
      allowed_models: ["anthropic/claude-sonnet-4-5"],
      expected_outcome: {
        kind: "agent_routing",
        target_agent: "loom",
        via: [],
      },
      accepted_alternates: [],
      transcript_expectations: [],
      tags: [],
    },
  ];

  it("returns the matching EvalCase for a known case id", () => {
    const result = validateCaseFilter("case-alpha", cases);
    // result is EvalCase | FixtureSchemaError — check it's an EvalCase
    expect("id" in result).toBe(true);
    if ("id" in result) {
      expect(result.id).toBe("case-alpha");
    }
  });

  it("returns a FixtureSchemaError for an unknown case id", () => {
    const result = validateCaseFilter("case-unknown", cases);
    expect("type" in result).toBe(true);
    if ("type" in result) {
      expect(result.type).toBe("FixtureValidationFailed");
    }
  });

  it("error message includes the unknown case id", () => {
    const result = validateCaseFilter("my-unknown-case", cases);
    if ("type" in result && result.type === "FixtureValidationFailed") {
      expect(result.message).toContain("my-unknown-case");
    }
  });

  it("error message includes the list of known case ids", () => {
    const result = validateCaseFilter("missing-case", cases);
    if ("type" in result && result.type === "FixtureValidationFailed") {
      expect(result.message).toContain("case-alpha");
      expect(result.message).toContain("case-beta");
    }
  });

  it("returns FixtureSchemaError with issues array", () => {
    const result = validateCaseFilter("unknown-id", cases);
    if ("type" in result && result.type === "FixtureValidationFailed") {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].path).toBe("case");
    }
  });

  it("returns empty-case message when case list is empty", () => {
    const result = validateCaseFilter("any-case", []);
    if ("type" in result && result.type === "FixtureValidationFailed") {
      expect(result.message).toContain("(none)");
    }
  });
});
