/**
 * Workflow sync tests — verify that `agent-evals.yml` allowlists are consistent
 * with `evals/model-matrix.json` and the case fixture IDs under `evals/cases/**`.
 *
 * # Purpose
 *
 * The GitHub Actions workflow at `.github/workflows/agent-evals.yml` contains
 * two hardcoded allowlists:
 *
 *   - `ALLOWED_MODELS` — must match the model IDs in `evals/model-matrix.json`.
 *   - `ALLOWED_CASES`  — must match the `id` fields in `evals/cases/**\/*.json`.
 *
 * These allowlists are maintained manually and can drift when new models or
 * cases are added. These tests detect drift early so CI catches it before the
 * workflow is used in production.
 *
 * # Approach
 *
 * The tests:
 *   1. Read and parse the YAML workflow file as plain text (no YAML parser
 *      dependency — Bun glob + Bun.file are sufficient for extracting the
 *      allowlist lines).
 *   2. Load `evals/model-matrix.json` via `loadModelMatrix()`.
 *   3. Glob all `evals/cases/**\/*.json` files and load their `id` fields.
 *   4. Assert that the workflow allowlists are supersets of (or identical to)
 *      the fixture IDs and model IDs so that every known model/case can be
 *      specified via workflow dispatch without being rejected.
 *
 * # Test isolation
 *
 * These tests read real files from the repo (no mocking). They are integration
 * tests that guard against manual maintenance drift and are expected to run
 * quickly (no network, no git, no LangChain calls).
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { EVALS_ROOT, loadCaseFile } from "../case-loader.js";
import { loadModelMatrix } from "../model-matrix.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "../../../../..");
const WORKFLOW_PATH = resolve(REPO_ROOT, ".github/workflows/agent-evals.yml");
const EVALS_DIR = EVALS_ROOT;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the workflow YAML file and extract the `ALLOWED_MODELS` shell variable
 * value as a space-separated list of model IDs.
 *
 * Looks for a line matching:
 *   ALLOWED_MODELS="<space-separated IDs>"
 *
 * Returns the list of model IDs found in the workflow, or an empty array if
 * the variable cannot be found.
 */
function extractWorkflowAllowedModels(workflowText: string): string[] {
  const match = workflowText.match(/ALLOWED_MODELS\s*=\s*"([^"]+)"/);
  if (match === null || match[1] === undefined) return [];
  return match[1].trim().split(/\s+/).filter(Boolean);
}

/**
 * Read the workflow YAML file and extract the `ALLOWED_CASES` shell variable
 * value as a space-separated list of case IDs.
 *
 * Returns the list of case IDs found in the workflow, or an empty array if
 * the variable cannot be found.
 */
function extractWorkflowAllowedCases(workflowText: string): string[] {
  const match = workflowText.match(/ALLOWED_CASES\s*=\s*"([^"]+)"/);
  if (match === null || match[1] === undefined) return [];
  return match[1].trim().split(/\s+/).filter(Boolean);
}

/**
 * Glob all `*.json` files under `evals/cases/` and return their paths.
 */
function discoverCaseFilePaths(): string[] {
  const glob = new Bun.Glob("**/*.json");
  const casesDir = resolve(EVALS_DIR, "cases");
  try {
    return Array.from(glob.scanSync(casesDir))
      .sort()
      .map((name) => resolve(casesDir, name));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workflow-sync — agent-evals.yml ALLOWED_MODELS matches model-matrix.json", () => {
  it("loads the workflow file without error", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("ALLOWED_MODELS");
  });

  it("ALLOWED_MODELS in workflow matches every model ID in model-matrix.json", async () => {
    const [workflowText, matrixResult] = await Promise.all([
      Bun.file(WORKFLOW_PATH).text(),
      loadModelMatrix(),
    ]);

    if (matrixResult.isErr()) {
      // model-matrix.json itself is invalid — fail with a clear message
      throw new Error(
        `model-matrix.json failed to load: ${matrixResult.error.message}`,
      );
    }

    const workflowModels = extractWorkflowAllowedModels(workflowText);
    const matrixModelIds = matrixResult.value.models.map((m) => m.id);

    expect(workflowModels.length).toBeGreaterThan(0);

    // Every model in the matrix should appear in the workflow allowlist.
    // If a model is added to the matrix but not to the workflow, the workflow
    // cannot dispatch runs for that model — this test catches the drift.
    for (const matrixId of matrixModelIds) {
      expect(workflowModels).toContain(matrixId);
    }
  });

  it("ALLOWED_MODELS in workflow does not contain model IDs absent from model-matrix.json", async () => {
    const [workflowText, matrixResult] = await Promise.all([
      Bun.file(WORKFLOW_PATH).text(),
      loadModelMatrix(),
    ]);

    if (matrixResult.isErr()) {
      throw new Error(
        `model-matrix.json failed to load: ${matrixResult.error.message}`,
      );
    }

    const workflowModels = extractWorkflowAllowedModels(workflowText);
    const matrixModelIds = new Set(matrixResult.value.models.map((m) => m.id));

    // Every model in the workflow allowlist should exist in the matrix.
    // Stale entries in the workflow (models removed from the matrix) would
    // silently match no cases and waste CI quota.
    for (const wfModel of workflowModels) {
      expect(matrixModelIds.has(wfModel)).toBe(true);
    }
  });
});

describe("workflow-sync — agent-evals.yml ALLOWED_CASES matches evals/cases/**", () => {
  it("loads the workflow file without error", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    expect(text).toContain("ALLOWED_CASES");
  });

  it("ALLOWED_CASES in workflow matches every case fixture ID under evals/cases/**", async () => {
    const [workflowText] = await Promise.all([Bun.file(WORKFLOW_PATH).text()]);

    const workflowCases = extractWorkflowAllowedCases(workflowText);
    const casePaths = discoverCaseFilePaths();

    expect(workflowCases.length).toBeGreaterThan(0);
    expect(casePaths.length).toBeGreaterThan(0);

    // Load each case fixture and check its `id` field against the workflow allowlist.
    const fixtureLoadResults = await Promise.all(
      casePaths.map((p) => loadCaseFile(p)),
    );

    for (const result of fixtureLoadResults) {
      if (result.isErr()) {
        throw new Error(`Failed to load case fixture: ${result.error.message}`);
      }
      const fixtureId = result.value.id;
      expect(workflowCases).toContain(fixtureId);
    }
  });

  it("ALLOWED_CASES in workflow does not contain case IDs absent from evals/cases/**", async () => {
    const [workflowText] = await Promise.all([Bun.file(WORKFLOW_PATH).text()]);

    const workflowCases = extractWorkflowAllowedCases(workflowText);
    const casePaths = discoverCaseFilePaths();

    // Build the set of known case IDs from fixtures
    const fixtureLoadResults = await Promise.all(
      casePaths.map((p) => loadCaseFile(p)),
    );

    const knownIds = new Set<string>();
    for (const result of fixtureLoadResults) {
      if (result.isErr()) continue; // skip load failures
      knownIds.add(result.value.id);
    }

    // Every case in the workflow allowlist should have a matching fixture.
    // Stale entries in the workflow (cases deleted from fixtures) would cause
    // confusing "case not found" errors when dispatched.
    for (const wfCase of workflowCases) {
      expect(knownIds.has(wfCase)).toBe(true);
    }
  });

  it("workflow ALLOWED_CASES count matches the number of case fixture files", async () => {
    const [workflowText] = await Promise.all([Bun.file(WORKFLOW_PATH).text()]);

    const workflowCases = extractWorkflowAllowedCases(workflowText);
    const casePaths = discoverCaseFilePaths();

    // The workflow must list exactly as many cases as there are fixture files.
    // A count mismatch indicates that a case was added/removed from one but
    // not the other.
    expect(workflowCases.length).toBe(casePaths.length);
  });
});

describe("workflow-sync — agent-evals.yml ALLOWED_AGENTS matches known eval agents", () => {
  it("workflow ALLOWED_AGENTS contains loom, tapestry, loom-routing, tapestry-execution", async () => {
    const workflowText = await Bun.file(WORKFLOW_PATH).text();

    // Extract the ALLOWED_AGENTS variable value from the workflow script
    const match = workflowText.match(/ALLOWED_AGENTS\s*=\s*"([^"]+)"/);
    expect(match).not.toBeNull();

    const allowedAgents =
      match !== null && match[1] !== undefined
        ? match[1].trim().split(/\s+/).filter(Boolean)
        : [];

    expect(allowedAgents).toContain("loom");
    expect(allowedAgents).toContain("tapestry");
    expect(allowedAgents).toContain("loom-routing");
    expect(allowedAgents).toContain("tapestry-execution");
  });
});
