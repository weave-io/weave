/**
 * Workflow sync tests — verify that `agent-evals.yml` mirrors the shared eval
 * registry and current fixture/model allowlists.
 *
 * # Purpose
 *
 * The GitHub Actions workflow at `.github/workflows/agent-evals.yml` contains
 * dispatch allowlists that must stay aligned with repo-owned sources:
 *
 *   - `ALLOWED_MODELS` — must match the model IDs in `evals/model-matrix.json`.
 *   - `ALLOWED_CASES`  — must match the `id` fields in `evals/cases/**\/*.json`.
 *
 * These allowlists are maintained in workflow YAML, while the canonical suite
 * surface lives in the shared registry under `packages/cli/src/evals/types.ts`.
 * These tests detect drift early so CI catches it before the workflow is used
 * in production.
 *
 * # Approach
 *
 * The tests:
 *   1. Read and parse the YAML workflow file as plain text (no YAML parser
 *      dependency, Bun glob + Bun.file are sufficient for extracting the
 *      allowlist lines).
 *   1a. Read the shared eval suite registry so workflow agent validation stays
 *       aligned with the same source the CLI and prompt snapshots use.
 *   2. Load `evals/model-matrix.json` via `loadModelMatrix()`.
 *   3. Glob all `evals/cases/**\/*.json` files and load their `id` fields.
 *   4. Assert that the workflow allowlists are supersets of, or identical to,
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
import { MAX_EVAL_REPEAT } from "../input-validation.js";
import { loadModelMatrix, MODEL_SET_NAMES } from "../model-matrix.js";
import { EVAL_AGENT_FILTERS, EVAL_SUITE_REGISTRY } from "../types.js";

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

function extractWorkflowAllowedAgents(workflowText: string): string[] {
  const match = workflowText.match(/ALLOWED_AGENTS\s*=\s*"([^"]+)"/);
  if (match === null || match[1] === undefined) return [];
  return match[1].trim().split(/\s+/).filter(Boolean);
}

/**
 * Read the workflow YAML file and extract the `ALLOWED_TRAJECTORY_CASES`
 * shell variable value as a space-separated list of case IDs.
 */
function extractWorkflowAllowedTrajectoryCases(workflowText: string): string[] {
  const match = workflowText.match(/ALLOWED_TRAJECTORY_CASES\s*=\s*"([^"]+)"/);
  if (match === null || match[1] === undefined) return [];
  return match[1].trim().split(/\s+/).filter(Boolean);
}

/**
 * Read the workflow YAML file and extract the `ALLOWED_TRAJECTORY_MODELS`
 * shell variable value as a space-separated list of model IDs.
 */
function extractWorkflowAllowedTrajectoryModels(
  workflowText: string,
): string[] {
  const match = workflowText.match(/ALLOWED_TRAJECTORY_MODELS\s*=\s*"([^"]+)"/);
  if (match === null || match[1] === undefined) return [];
  return match[1].trim().split(/\s+/).filter(Boolean);
}

/**
 * Read the workflow YAML file and extract the `ALLOWED_SANDBOX_PROFILES`
 * shell variable value as a space-separated list of sandbox profile names.
 */
function extractWorkflowAllowedSandboxProfiles(workflowText: string): string[] {
  const match = workflowText.match(/ALLOWED_SANDBOX_PROFILES\s*=\s*"([^"]+)"/);
  if (match === null || match[1] === undefined) return [];
  return match[1].trim().split(/\s+/).filter(Boolean);
}

/**
 * Read the workflow YAML file and extract the image tag passed to
 * `podman build -t <tag>` in the "Build sandbox image" step.
 *
 * Returns `undefined` if no `podman build -t` invocation is found.
 */
function extractWorkflowSandboxImageTag(
  workflowText: string,
): string | undefined {
  const match = workflowText.match(/podman build -t (\S+) /);
  return match?.[1];
}

/**
 * Load every case fixture under evals/cases/** and return only those whose
 * `expected_outcome.kind` is `"harness_trajectory"` — the trajectory track.
 */
async function discoverTrajectoryCases() {
  const casePaths = discoverCaseFilePaths();
  const results = await Promise.all(casePaths.map((p) => loadCaseFile(p)));
  const trajectoryCases: Array<{
    id: string;
    model: string[];
    sandboxProfile: string;
  }> = [];
  for (const result of results) {
    if (result.isErr()) {
      throw new Error(`Failed to load case fixture: ${result.error.message}`);
    }
    const evalCase = result.value;
    if (evalCase.expected_outcome.kind !== "harness_trajectory") continue;
    trajectoryCases.push({
      id: evalCase.id,
      model: evalCase.allowed_models,
      sandboxProfile: evalCase.expected_outcome.sandbox_profile,
    });
  }
  return trajectoryCases;
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

describe("workflow-sync — agent-evals.yml derives its model allowlist", () => {
  it("loads the workflow file without error", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("ALLOWED_MODELS");
  });

  it("reads the allowlist from model-matrix.json rather than restating it", async () => {
    const [text, matrixResult] = await Promise.all([
      Bun.file(WORKFLOW_PATH).text(),
      loadModelMatrix(),
    ]);
    if (matrixResult.isErr())
      throw new Error("model-matrix.json failed to load");

    // A literal list would drift the moment a model is added to the matrix,
    // so no ALLOWED_*MODELS assignment may name a model directly. The separate
    // TRAJECTORY_MODEL pin is deliberate — it chooses which cheap model CI
    // runs by default — and is not an allowlist, so it is not covered here.
    expect(text).toContain("evals/model-matrix.json");

    const allowlistAssignments = [
      // Match to end of line, not to the next double quote: the derived
      // assignments embed a jq program containing quotes, so a `"[^"]*"`
      // match would truncate and miss anything after it.
      ...text.matchAll(/ALLOWED_\w*MODELS=.*/g),
    ]
      .map((m) => m[0])
      .join("\n");
    expect(allowlistAssignments.length).toBeGreaterThan(0);

    const restated = matrixResult.value.models
      .map((m) => m.id)
      .filter((id) => allowlistAssignments.includes(id));
    expect(restated).toEqual([]);
  });

  it("checks out the repo before reading the matrix", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    const validateJob = text.slice(
      text.indexOf("validate-inputs:"),
      text.indexOf("run-evals:"),
    );

    expect(validateJob).toContain("actions/checkout@");
    expect(validateJob.indexOf("actions/checkout@")).toBeLessThan(
      validateJob.indexOf("ALLOWED_MODELS="),
    );
  });

  it("fails the run when the matrix yields no model IDs", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();

    // Without this guard a malformed matrix would silently produce an empty
    // allowlist, rejecting every model with a confusing "Unknown model" error.
    expect(text).toContain(
      "Could not read model IDs from evals/model-matrix.json",
    );
  });

  it("still loads the matrix it derives from", async () => {
    const matrixResult = await loadModelMatrix();

    expect(matrixResult.isOk()).toBe(true);
    if (matrixResult.isErr()) return;
    expect(matrixResult.value.models.length).toBeGreaterThan(0);
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
  it("workflow ALLOWED_AGENTS exactly matches the shared eval registry", async () => {
    const workflowText = await Bun.file(WORKFLOW_PATH).text();

    const allowedAgents = extractWorkflowAllowedAgents(workflowText);

    expect(allowedAgents.sort()).toEqual([...EVAL_AGENT_FILTERS].sort());
  });

  it("workflow ALLOWED_CASES covers every suite present in the shared registry", async () => {
    const workflowText = await Bun.file(WORKFLOW_PATH).text();
    const allowedCases = extractWorkflowAllowedCases(workflowText);

    const fixtureLoadResults = await Promise.all(
      discoverCaseFilePaths().map((path) => loadCaseFile(path)),
    );
    const workflowCaseSet = new Set(allowedCases);

    const suitesWithWorkflowCases = new Set<string>();
    for (const result of fixtureLoadResults) {
      if (result.isErr()) {
        throw new Error(`Failed to load case fixture: ${result.error.message}`);
      }
      if (workflowCaseSet.has(result.value.id)) {
        suitesWithWorkflowCases.add(result.value.suite);
      }
    }

    expect([...suitesWithWorkflowCases].sort()).toEqual(
      EVAL_SUITE_REGISTRY.map((suite) => suite.suiteId).sort(),
    );
  });
});

describe("workflow-sync — agent-evals.yml trajectory-track allowlists match harness_trajectory fixtures", () => {
  it("loads the workflow file and finds all three trajectory allowlists", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    expect(text).toContain("ALLOWED_TRAJECTORY_CASES");
    expect(text).toContain("ALLOWED_TRAJECTORY_MODELS");
    expect(text).toContain("ALLOWED_SANDBOX_PROFILES");
  });

  it("ALLOWED_TRAJECTORY_CASES lists every harness_trajectory case ID under evals/cases/**", async () => {
    const workflowText = await Bun.file(WORKFLOW_PATH).text();
    const workflowCases = extractWorkflowAllowedTrajectoryCases(workflowText);
    const trajectoryCases = await discoverTrajectoryCases();

    expect(trajectoryCases.length).toBeGreaterThan(0);

    for (const trajectoryCase of trajectoryCases) {
      expect(workflowCases).toContain(trajectoryCase.id);
    }
  });

  it("ALLOWED_TRAJECTORY_CASES does not contain stale/unknown case IDs", async () => {
    const workflowText = await Bun.file(WORKFLOW_PATH).text();
    const workflowCases = extractWorkflowAllowedTrajectoryCases(workflowText);
    const trajectoryCases = await discoverTrajectoryCases();
    const knownIds = new Set(trajectoryCases.map((c) => c.id));

    for (const wfCase of workflowCases) {
      expect(knownIds.has(wfCase)).toBe(true);
    }

    // Exact count parity: every trajectory fixture must be listed and no
    // stale entries may remain.
    expect(workflowCases.length).toBe(trajectoryCases.length);
  });

  it("ALLOWED_TRAJECTORY_MODELS is derived from the fixtures rather than restated", async () => {
    const workflowText = await Bun.file(WORKFLOW_PATH).text();
    const trajectoryCases = await discoverTrajectoryCases();

    const fixtureModels = new Set<string>();
    for (const trajectoryCase of trajectoryCases) {
      for (const model of trajectoryCase.model) fixtureModels.add(model);
    }
    expect(fixtureModels.size).toBeGreaterThan(0);

    // The workflow computes this union with jq at run time, so a trajectory
    // case gaining a model needs no workflow edit. A literal list here would
    // silently reject that model instead.
    const assignment = extractWorkflowAllowedTrajectoryModels(workflowText);
    const restated = [...fixtureModels].filter((model) =>
      assignment.includes(model),
    );
    expect(restated).toEqual([]);
    expect(workflowText).toContain("harness_trajectory");
  });

  it("ALLOWED_SANDBOX_PROFILES lists every sandbox profile referenced by a harness_trajectory case", async () => {
    const workflowText = await Bun.file(WORKFLOW_PATH).text();
    const workflowProfiles =
      extractWorkflowAllowedSandboxProfiles(workflowText);
    const trajectoryCases = await discoverTrajectoryCases();

    const fixtureProfiles = new Set<string>();
    for (const trajectoryCase of trajectoryCases) {
      fixtureProfiles.add(trajectoryCase.sandboxProfile);
    }

    expect(fixtureProfiles.size).toBeGreaterThan(0);

    for (const profile of fixtureProfiles) {
      expect(workflowProfiles).toContain(profile);
    }
    for (const wfProfile of workflowProfiles) {
      expect(fixtureProfiles.has(wfProfile)).toBe(true);
    }
  });

  it("the podman build -t image tag matches resolveSandboxProfileImage() for every referenced sandbox profile", async () => {
    // This is the regression guard for the drift where CI built
    // `weave-sandbox-opencode` but the runner resolved `sandbox_profile`
    // "opencode-default" to `weave-sandbox-opencode-default`, so the image
    // the harness looked for was never the one CI built.
    //
    // The single sanctioned import site for the adapter's trajectory surface
    // is packages/cli/src/evals/opencode-trajectory-runner-adapter.ts (dynamic
    // import). This test dynamically imports the same module directly to
    // stay consistent with that isolation policy while deriving the expected
    // tag from the real source-of-truth mapping instead of a literal.
    const { resolveSandboxProfileImage } = await import(
      "@weaveio/weave-adapter-opencode"
    );

    const workflowText = await Bun.file(WORKFLOW_PATH).text();
    const workflowImageTag = extractWorkflowSandboxImageTag(workflowText);
    const trajectoryCases = await discoverTrajectoryCases();

    expect(workflowImageTag).toBeDefined();
    expect(trajectoryCases.length).toBeGreaterThan(0);

    for (const trajectoryCase of trajectoryCases) {
      const expectedTag = resolveSandboxProfileImage(
        trajectoryCase.sandboxProfile,
      );
      expect(expectedTag).toBeDefined();
      expect(workflowImageTag).toBe(expectedTag);
    }
  });

  it("ALLOWED_TRAJECTORY_AGENTS names exactly the suites that can hold trajectory cases", async () => {
    const workflowText = await Bun.file(WORKFLOW_PATH).text();
    const match = workflowText.match(
      /ALLOWED_TRAJECTORY_AGENTS\s*=\s*"([^"]+)"/,
    );
    const workflowAgents = (match?.[1] ?? "").trim().split(/\s+/);
    const registryAgents = EVAL_SUITE_REGISTRY.filter((suite) =>
      suite.allowedExpectedOutcomeKinds.includes("harness_trajectory"),
    ).flatMap((suite) => [suite.suiteId, suite.shortAgentFilter]);

    expect(workflowAgents.sort()).toEqual([...new Set(registryAgents)].sort());
  });
});

// ---------------------------------------------------------------------------
// The trajectory job runs on manual dispatch (Spec 37, 20.2)
// ---------------------------------------------------------------------------

/** The text of one top-level job, from its key to the next job's. */
function jobBlock(workflowText: string, job: string): string {
  const start = workflowText.indexOf(`\n  ${job}:\n`);
  if (start === -1) return "";
  const rest = workflowText.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("workflow-sync — agent-evals.yml runs the trajectory job on manual dispatch", () => {
  it("has no changed-paths gate, which skipped every dispatch from main", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    const job = jobBlock(text, "trajectory-evals");

    expect(job).toContain("runs-on: ubuntu-latest");
    expect(job).not.toContain("git diff");
    expect(job).not.toContain("steps.filter");
    expect(job).not.toContain("fetch-depth");
  });

  it("gates the job only on the validated run_trajectory output", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    const job = jobBlock(text, "trajectory-evals");

    expect(job).toContain(
      "if: always() && needs.validate-inputs.result == 'success' && needs.validate-inputs.outputs.run_trajectory == 'true'",
    );
    expect(text).toContain(
      "run_trajectory: ${{ steps.check.outputs.run_trajectory }}",
    );
  });

  it("publishes after the text job, never beside it, so run IDs cannot collide", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    const job = jobBlock(text, "trajectory-evals");

    expect(job).toContain("needs: [validate-inputs, run-evals]");
    expect(job).toContain("if: always() &&");
  });

  it("offers a boolean trajectory input that is on by default", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    const block = text.slice(
      text.indexOf("      trajectory:\n"),
      text.indexOf("\n# Minimal permissions"),
    );

    expect(block).toContain("type: boolean");
    expect(block).toContain("default: true");
  });

  it("runs each track in its own job, never both in one", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    const textJob = jobBlock(text, "run-evals");
    const trajectoryJob = jobBlock(text, "trajectory-evals");

    expect(textJob.match(/WEAVE_EVAL_TRACK: "text"/g)).toHaveLength(2);
    expect(textJob).not.toContain('WEAVE_EVAL_TRACK: "trajectory"');
    expect(trajectoryJob.match(/WEAVE_EVAL_TRACK: "trajectory"/g)).toHaveLength(
      2,
    );
    expect(trajectoryJob).not.toContain('WEAVE_EVAL_TRACK: "text"');
  });

  it("forwards the validated filters to the trajectory job instead of a fixed case", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    const job = jobBlock(text, "trajectory-evals");

    for (const filter of ["agent", "model", "models", "case", "repeat"]) {
      expect(
        job.match(
          new RegExp(
            `WEAVE_EVAL_${filter.toUpperCase()}:\\s+\\$\\{\\{ needs\\.validate-inputs\\.outputs\\.${filter} \\}\\}`,
            "g",
          ),
        ),
      ).toHaveLength(2);
    }
    expect(job).not.toContain("eval:trajectory");
  });

  it("dry-runs the trajectory selection before the step that holds secrets", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    const job = jobBlock(text, "trajectory-evals");
    const dryRun = job.indexOf("eval run --dry-run");
    const firstSecret = job.indexOf("${{ secrets.");

    expect(dryRun).toBeGreaterThan(-1);
    expect(firstSecret).toBeGreaterThan(dryRun);
    expect(jobBlock(text, "validate-inputs")).not.toContain("${{ secrets.");
  });
});

describe("workflow-sync — agent-evals.yml passes --repeat through", () => {
  it("validates repeat against the CLI's maximum before any eval job", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    const validate = jobBlock(text, "validate-inputs");

    expect(validate).toContain(`MAX_REPEAT=${MAX_EVAL_REPEAT}`);
    expect(validate).toContain("RAW_REPEAT: ${{ github.event.inputs.repeat }}");
    expect(text).toContain("repeat: ${{ steps.check.outputs.repeat }}");
  });

  it("forwards the validated repeat count to both jobs, dry run and live", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    const forwards = text.match(
      /WEAVE_EVAL_REPEAT: \$\{\{ needs\.validate-inputs\.outputs\.repeat \}\}/g,
    );

    expect(forwards).toHaveLength(4);
    // The raw input is read once, by validate-inputs; jobs see only its output.
    expect(text.match(/github\.event\.inputs\.repeat/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The model set dispatch input (Spec 37, 17.1)
// ---------------------------------------------------------------------------

describe("workflow-sync — agent-evals.yml can choose the dev model subset", () => {
  function extractAllowedModelSets(workflowText: string): string[] {
    const match = workflowText.match(/ALLOWED_MODEL_SETS\s*=\s*"([^"]+)"/);
    if (match === null || match[1] === undefined) return [];
    return match[1].trim().split(/\s+/).filter(Boolean);
  }

  function extractModelsChoiceOptions(workflowText: string): string[] {
    const start = workflowText.indexOf("      models:\n");
    const end = workflowText.indexOf("      case:\n", start);
    const block = workflowText.slice(start, end);
    const options = block.slice(block.indexOf("options:"));
    return [...options.matchAll(/^\s+- (\S+)$/gm)].map((m) => m[1] ?? "");
  }

  it("ALLOWED_MODEL_SETS matches MODEL_SET_NAMES exactly", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    expect(extractAllowedModelSets(text)).toEqual([...MODEL_SET_NAMES]);
  });

  it("offers every model set as a dispatch choice, defaulting to the full matrix", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    expect(extractModelsChoiceOptions(text)).toEqual([...MODEL_SET_NAMES]);
    const block = text.slice(
      text.indexOf("      models:\n"),
      text.indexOf("      case:\n"),
    );
    expect(block).toContain("type: choice");
    expect(block).toContain('default: "default"');
  });

  it("forwards the validated model set to the dry run and the live run of both jobs", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    const forwards = text.match(
      /WEAVE_EVAL_MODELS: \$\{\{ needs\.validate-inputs\.outputs\.models \}\}/g,
    );
    expect(forwards).toHaveLength(4);
    expect(text).toContain("models: ${{ steps.check.outputs.models }}");
  });

  it("rejects the dev set combined with a model ID before any eval runs", async () => {
    const text = await Bun.file(WORKFLOW_PATH).text();
    expect(text).toContain(
      'if [ "${MODELS_OUT}" = "dev" ] && [ -n "${MODEL_OUT}" ]; then',
    );
  });

  it("never names the dev models in the workflow — they come from the matrix", async () => {
    const [text, matrixResult] = await Promise.all([
      Bun.file(WORKFLOW_PATH).text(),
      loadModelMatrix(),
    ]);
    if (matrixResult.isErr())
      throw new Error("model-matrix.json failed to load");
    const devIds = matrixResult.value.models
      .filter((m) => m.dev)
      .map((m) => m.id);
    expect(devIds.length).toBeGreaterThan(0);
    for (const id of devIds) {
      expect(text).not.toContain(id);
    }
  });
});
