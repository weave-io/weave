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
  EVALS_ROOT,
  KNOWN_AGENTS,
  loadCaseFile,
  loadRubricFile,
  loadSuiteCases,
  loadSuiteRubrics,
  validateCaseFilter,
} from "../case-loader.js";
import type { EvalCase } from "../types.js";
import { EVAL_SUITE_REGISTRY } from "../types.js";

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
        suite: "tapestry-execution",
        allowed_agents: ["tapestry", "shuttle"],
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

  it("loads a valid shuttle-execution task_completion fixture", async () => {
    const filePath = await writeTempJson(
      "valid-shuttle-execution",
      makeCase({
        suite: "shuttle-execution",
        allowed_agents: ["shuttle"],
        expected_outcome: {
          kind: "task_completion",
          description:
            "Final shuttle report reflects task structure and evidence.",
          required_artifacts: [
            "shuttle_task_intake_structured",
            "shuttle_files_acknowledged",
            "shuttle_acceptance_confirmed",
            "shuttle_evidence_reported",
          ],
        },
        transcript_expectations: [
          {
            check: "content_contains",
            role: "assistant",
            contains: "Files changed",
          },
          { check: "agent_mentioned", agent_name: "shuttle" },
        ],
      }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isOk()).toBe(true);
    const c = result._unsafeUnwrap();
    expect(c.suite).toBe("shuttle-execution");
    expect(c.allowed_agents).toEqual(["shuttle"]);
  });

  it("loads a valid delegation_chain case fixture", async () => {
    const filePath = await writeTempJson(
      "valid-delegation",
      makeCase({
        suite: "tapestry-execution",
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

  it("loads a valid pattern-planning task_completion fixture", async () => {
    const filePath = await writeTempJson(
      "valid-pattern-planning",
      makeCase({
        suite: "pattern-planning",
        allowed_agents: ["pattern"],
        expected_outcome: {
          kind: "task_completion",
          description: "Plan includes explicit structural signals",
          required_artifacts: [
            "plan_scope_explicit",
            "plan_file_tasks",
            "plan_sequence_explicit",
            "plan_acceptance_coverage",
          ],
        },
        transcript_expectations: [
          { check: "content_contains", role: "assistant", contains: "#scope" },
          { check: "agent_mentioned", agent_name: "pattern" },
        ],
      }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isOk()).toBe(true);
    const c = result._unsafeUnwrap();
    expect(c.suite).toBe("pattern-planning");
    expect(c.allowed_agents).toEqual(["pattern"]);
  });

  it("loads a valid spindle-tools task_completion fixture", async () => {
    const filePath = await writeTempJson(
      "valid-spindle-tools",
      makeCase({
        suite: "spindle-tools",
        allowed_agents: ["spindle"],
        expected_outcome: {
          kind: "task_completion",
          description:
            "Research answer contains citations, separated facts, and confidence.",
          required_artifacts: [
            "spindle_inline_citations_present",
            "spindle_source_facts_separated",
            "spindle_confidence_reported",
            "spindle_sources_list_present",
          ],
        },
        transcript_expectations: [
          {
            check: "content_contains",
            role: "assistant",
            contains: "Source facts",
          },
          {
            check: "content_contains",
            role: "assistant",
            contains: "Confidence:",
          },
        ],
      }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isOk()).toBe(true);
    const c = result._unsafeUnwrap();
    expect(c.suite).toBe("spindle-tools");
    expect(c.allowed_agents).toEqual(["spindle"]);
  });

  it("loads a valid weft-review task_completion fixture", async () => {
    const filePath = await writeTempJson(
      "valid-weft-review",
      makeCase({
        suite: "weft-review",
        allowed_agents: ["weft"],
        expected_outcome: {
          kind: "task_completion",
          description: "Review contains verdict and blocker/file discipline",
          required_artifacts: [
            "review_verdict_present",
            "review_file_refs_present",
          ],
        },
        transcript_expectations: [
          {
            check: "content_contains",
            role: "assistant",
            contains: "[APPROVE]",
          },
        ],
      }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isOk()).toBe(true);
    const c = result._unsafeUnwrap();
    expect(c.suite).toBe("weft-review");
    expect(c.allowed_agents).toEqual(["weft"]);
  });

  it("loads a valid warp-security task_completion fixture", async () => {
    const filePath = await writeTempJson(
      "valid-warp-security",
      makeCase({
        suite: "warp-security",
        allowed_agents: ["warp"],
        expected_outcome: {
          kind: "task_completion",
          description:
            "Security review contains verdict, capped blocker count, and evidence-backed findings.",
          required_artifacts: [
            "security_verdict_present",
            "security_blocker_count_capped",
            "security_findings_evidence_backed",
          ],
        },
        transcript_expectations: [
          { check: "content_contains", role: "assistant", contains: "BLOCK" },
        ],
      }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isOk()).toBe(true);
    const c = result._unsafeUnwrap();
    expect(c.suite).toBe("warp-security");
    expect(c.allowed_agents).toEqual(["warp"]);
  });

  it("rejects a tool_call case fixture for a text-only suite", async () => {
    const filePath = await writeTempJson(
      "invalid-tool-call",
      makeCase({
        expected_outcome: {
          kind: "tool_call",
          tool_name: "delegate",
          payload_contains: { target: "shuttle" },
        },
      }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("UnsupportedTextEvalAssertion");
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
          { check: "agent_mentioned", agent_name: "shuttle" },
        ],
      }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isOk()).toBe(true);
    const c = result._unsafeUnwrap();
    expect(c.transcript_expectations).toHaveLength(2);
  });

  it("rejects runtime-only transcript expectations for text-only suites", async () => {
    const filePath = await writeTempJson(
      "runtime-transcript-expectations",
      makeCase({
        transcript_expectations: [
          { check: "tool_called", tool_name: "delegate" },
          { check: "no_tool_called", tool_name: "dangerous_tool" },
          { check: "content_contains", role: "tool", contains: "delegate" },
        ],
      }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("UnsupportedTextEvalAssertion");
    if (e.type === "UnsupportedTextEvalAssertion") {
      expect(e.issues).toHaveLength(3);
    }
  });

  it("rejects spindle-tools network-event assertions via the shared text-only contract", async () => {
    const filePath = await writeTempJson(
      "spindle-network-assertions",
      makeCase({
        suite: "spindle-tools",
        allowed_agents: ["spindle"],
        expected_outcome: {
          kind: "tool_call",
          tool_name: "web_search",
        },
        transcript_expectations: [
          { check: "tool_called", tool_name: "web_search" },
          { check: "no_tool_called", tool_name: "browser_open" },
          { check: "content_contains", role: "tool", contains: "GET https://" },
        ],
      }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.type).toBe("UnsupportedTextEvalAssertion");
    if (e.type === "UnsupportedTextEvalAssertion") {
      expect(e.suite).toBe("spindle-tools");
      expect(e.issues).toHaveLength(4);
    }
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

  it("returns UnknownEvalSuite for a fixture with an unregistered suite", async () => {
    const filePath = await writeTempJson(
      "unknown-suite",
      makeCase({ suite: "unknown-suite" }),
    );
    const result = await loadCaseFile(filePath);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("UnknownEvalSuite");
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

  it("returns empty array for a known suite whose directory does not exist", async () => {
    const evalsRoot = resolve(TEMP_DIR, `evals-root-nonexistent-${uid()}`);
    const result = await loadSuiteCases("loom-routing", evalsRoot);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(0);
  });

  it("rejects an unregistered suite before discovery", async () => {
    const evalsRoot = resolve(TEMP_DIR, `evals-root-unknown-suite-${uid()}`);
    const result = await loadSuiteCases("unknown-suite", evalsRoot);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("UnknownEvalSuite");
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

  it("rejects an unregistered rubric suite before discovery", async () => {
    const evalsRoot = resolve(TEMP_DIR, `evals-root-bad-rubric-suite-${uid()}`);
    const result = await loadSuiteRubrics("unknown-suite", evalsRoot);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("UnknownEvalSuite");
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

// ---------------------------------------------------------------------------
// Real fixture inventory drift checks
// ---------------------------------------------------------------------------

describe("real fixture inventory stays in sync with the shared eval registry", () => {
  const expectedSuites = EVAL_SUITE_REGISTRY.map(
    (suite) => suite.suiteId,
  ).sort();

  function discoverSuiteDirNames(kind: "cases" | "rubrics"): string[] {
    const suiteRoot = resolve(EVALS_ROOT, kind);
    const glob = new Bun.Glob("*/*.json");

    try {
      return [
        ...new Set(
          Array.from(glob.scanSync(suiteRoot))
            .map((name) => name.split("/")[0])
            .filter(
              (name): name is string => name !== undefined && name.length > 0,
            ),
        ),
      ].sort();
    } catch {
      return [];
    }
  }

  it("cases/ and rubrics/ directories exactly match the registered suite IDs", () => {
    expect(discoverSuiteDirNames("cases")).toEqual(expectedSuites);
    expect(discoverSuiteDirNames("rubrics")).toEqual(expectedSuites);
  });

  it("every registered suite has at least one real case fixture and one matching rubric", async () => {
    for (const suite of expectedSuites) {
      const casesResult = await loadSuiteCases(suite, EVALS_ROOT);
      const rubricsResult = await loadSuiteRubrics(suite, EVALS_ROOT);

      expect(casesResult.isOk()).toBe(true);
      expect(rubricsResult.isOk()).toBe(true);
      if (casesResult.isErr() || rubricsResult.isErr()) continue;

      const cases = casesResult.value;
      const rubrics = rubricsResult.value;

      expect(cases.length).toBeGreaterThan(0);
      expect(rubrics.length).toBe(cases.length);

      const rubricIds = new Set(rubrics.map((rubric) => rubric.case_id));
      for (const evalCase of cases) {
        expect(evalCase.suite).toBe(suite);
        expect(rubricIds.has(evalCase.id)).toBe(true);
      }
    }
  });
});

describe("phase 1B fairness fixtures stay aligned with text-only runner contracts", () => {
  it("loom and tapestry fixtures no longer encode legacy shuttle alternates or thread pre-hops", async () => {
    const loomBackend = await loadCaseFile(
      resolve(EVALS_ROOT, "cases/loom-routing/loom-route-backend-api.json"),
    );
    const loomFrontend = await loadCaseFile(
      resolve(EVALS_ROOT, "cases/loom-routing/loom-route-frontend-ui.json"),
    );
    const loomAmbiguous = await loadCaseFile(
      resolve(
        EVALS_ROOT,
        "cases/loom-routing/loom-route-ambiguous-direct-shuttle.json",
      ),
    );
    const tapestryDelegate = await loadCaseFile(
      resolve(
        EVALS_ROOT,
        "cases/tapestry-execution/tapestry-delegate-to-shuttle.json",
      ),
    );

    expect(loomBackend.isOk()).toBe(true);
    expect(loomFrontend.isOk()).toBe(true);
    expect(loomAmbiguous.isOk()).toBe(true);
    expect(tapestryDelegate.isOk()).toBe(true);
    if (
      loomBackend.isErr() ||
      loomFrontend.isErr() ||
      loomAmbiguous.isErr() ||
      tapestryDelegate.isErr()
    ) {
      return;
    }

    expect(loomBackend.value.accepted_alternates).toEqual([]);
    expect(loomFrontend.value.accepted_alternates).toEqual([]);
    expect(loomBackend.value.allowed_agents).not.toContain("shuttle-backend");
    expect(loomFrontend.value.allowed_agents).not.toContain("shuttle-frontend");

    if (loomAmbiguous.value.expected_outcome.kind === "agent_routing") {
      expect(loomAmbiguous.value.expected_outcome.via).toEqual([]);
    }

    expect(tapestryDelegate.value.accepted_alternates).toEqual([]);
    expect(tapestryDelegate.value.allowed_agents).toEqual([
      "tapestry",
      "shuttle",
    ]);
  });

  it("pattern planning fixtures rely on structural artifacts instead of exact tag transcript checks", async () => {
    const settingsCase = await loadCaseFile(
      resolve(
        EVALS_ROOT,
        "cases/pattern-planning/pattern-plan-settings-refactor.json",
      ),
    );
    const releaseCase = await loadCaseFile(
      resolve(
        EVALS_ROOT,
        "cases/pattern-planning/pattern-plan-release-checklist.json",
      ),
    );

    expect(settingsCase.isOk()).toBe(true);
    expect(releaseCase.isOk()).toBe(true);
    if (settingsCase.isErr() || releaseCase.isErr()) {
      return;
    }

    expect(settingsCase.value.transcript_expectations).toEqual([]);
    expect(releaseCase.value.transcript_expectations).toEqual([]);

    if (settingsCase.value.expected_outcome.kind === "task_completion") {
      expect(settingsCase.value.expected_outcome.required_artifacts).toEqual([
        "plan_scope_explicit",
        "plan_file_tasks",
        "plan_sequence_explicit",
        "plan_acceptance_coverage",
      ]);
    }
  });

  it("warp and weft rubrics describe fairness intent around observable assistant-text structure", async () => {
    const warpBlock = await loadRubricFile(
      resolve(
        EVALS_ROOT,
        "rubrics/warp-security/warp-security-block-evidence-findings.json",
      ),
    );
    const warpApprove = await loadRubricFile(
      resolve(
        EVALS_ROOT,
        "rubrics/warp-security/warp-security-fast-exit-approve.json",
      ),
    );
    const weftReject = await loadRubricFile(
      resolve(
        EVALS_ROOT,
        "rubrics/weft-review/weft-review-reject-blocker-citation.json",
      ),
    );
    const weftApprove = await loadRubricFile(
      resolve(
        EVALS_ROOT,
        "rubrics/weft-review/weft-review-clean-approval.json",
      ),
    );

    expect(warpBlock.isOk()).toBe(true);
    expect(warpApprove.isOk()).toBe(true);
    expect(weftReject.isOk()).toBe(true);
    expect(weftApprove.isOk()).toBe(true);
    if (
      warpBlock.isErr() ||
      warpApprove.isErr() ||
      weftReject.isErr() ||
      weftApprove.isErr()
    ) {
      return;
    }

    expect(warpBlock.value.scoring.notes).toContain("Fairness/alignment");
    expect(warpApprove.value.scoring.notes).toContain("assistant-text");
    expect(weftReject.value.scoring.notes).toContain("assistant text");
    expect(weftApprove.value.scoring.notes).toContain("Fairness/alignment");
  });
});
