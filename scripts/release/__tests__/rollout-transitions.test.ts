import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { readLocalWorkflowTopology } from "../rollout-gate.js";
import {
  createRolloutActivationRecord,
  createRolloutFreezeRecord,
  ROLLOUT_STAGE_DECLARATION,
  type RolloutStageDeclaration,
  validateRolloutTuple,
  type WorkflowTopology,
} from "../rollout-stage.js";

const ROOT = resolve(import.meta.dir, "../../..");

const preCutover: RolloutStageDeclaration = {
  schemaVersion: 1,
  stage: "pre-cutover",
  freezeRecord: null,
  activationRecord: null,
};

const freezeRecord = createRolloutFreezeRecord({
  commitSha: "c".repeat(40),
  committedAt: "2026-08-20T00:00:00.000Z",
  quiescenceEvidence: "old scheduled publisher was quiescent",
})._unsafeUnwrap();

const activationRecord = createRolloutActivationRecord({
  commitSha: "d".repeat(40),
  committedAt: "2026-08-20T00:01:00.000Z",
  greenReport: "nightly chain passed independent proof",
})._unsafeUnwrap();

const frozen: RolloutStageDeclaration = {
  schemaVersion: 1,
  stage: "frozen",
  freezeRecord,
  activationRecord: null,
};

const ready: RolloutStageDeclaration = {
  schemaVersion: 1,
  stage: "ready",
  freezeRecord,
  activationRecord,
};

const preTopology: WorkflowTopology = {
  oldWorkflowPresent: true,
  oldWorkflowScheduled: true,
  newWorkflowPresent: true,
  newWorkflowScheduled: false,
  newWorkflowGateDisabled: true,
};

const frozenTopology: WorkflowTopology = {
  oldWorkflowPresent: false,
  oldWorkflowScheduled: false,
  newWorkflowPresent: true,
  newWorkflowScheduled: true,
  newWorkflowGateDisabled: true,
};

function invalidTuple(
  declaration: unknown,
  mode: unknown,
  topology: unknown,
): string {
  const result = validateRolloutTuple(declaration, mode, topology);
  expect(result.isErr()).toBe(true);
  if (result.isOk()) throw new Error("expected an invalid rollout tuple");
  return result.error.type === "RolloutInvalidState"
    ? result.error.reason
    : result.error.type;
}

describe("release rollout topology transitions", () => {
  it("removes the old publisher, lands the new schedule, and stays unpublishable until the freeze record", async () => {
    const observed = await readLocalWorkflowTopology(ROOT);
    const topology = observed._unsafeUnwrap();

    // Cutover code shape: the old publisher is gone and the nightly cron now
    // lives on release-publish.yml.
    expect(topology).toMatchObject(frozenTopology);
    expect(
      await Bun.file(resolve(ROOT, ".github/workflows/publish.yml")).exists(),
    ).toBe(false);
    const newWorkflow = await Bun.file(
      resolve(ROOT, ".github/workflows/release-publish.yml"),
    ).text();
    expect(newWorkflow).toMatch(/^\s+schedule:/m);
    expect(newWorkflow).toContain('- cron: "17 0 * * *"');

    // The checked-in declaration is deliberately still `pre-cutover`: the
    // freeze record needs quiescence evidence that only the freeze protocol
    // can produce. Until it lands, no mode yields a valid tuple, so the new
    // schedule cannot reach attestation, proof, OIDC, or publish.
    expect(ROLLOUT_STAGE_DECLARATION.stage).toBe("pre-cutover");
    for (const mode of ["disabled", "dry-run", "enabled"] as const)
      expect(
        validateRolloutTuple(ROLLOUT_STAGE_DECLARATION, mode, topology).isErr(),
      ).toBe(true);
    expect(invalidTuple(preCutover, "disabled", topology)).toContain(
      "pre-cutover requires the old scheduled workflow",
    );
    expect(invalidTuple(preCutover, "enabled", topology)).toContain(
      "before cutover",
    );
  });

  it("permits the frozen handoff only after old removal and new schedule activation", () => {
    expect(
      validateRolloutTuple(frozen, "disabled", frozenTopology).isOk(),
    ).toBe(true);
    expect(
      validateRolloutTuple(frozen, "dry-run", frozenTopology).isErr(),
    ).toBe(true);
    expect(invalidTuple(frozen, "enabled", frozenTopology)).toContain(
      "remain disabled",
    );

    expect(
      invalidTuple(frozen, "disabled", {
        ...frozenTopology,
        oldWorkflowPresent: true,
      }),
    ).toContain("publish.yml to be absent");
    expect(
      invalidTuple(frozen, "disabled", {
        ...frozenTopology,
        newWorkflowScheduled: false,
      }),
    ).toContain("neither publication workflow");
  });

  it("allows ready disabled as a safe intermediate and enabled only after activation", () => {
    expect(validateRolloutTuple(ready, "disabled", frozenTopology).isOk()).toBe(
      true,
    );
    const active = validateRolloutTuple(ready, "enabled", frozenTopology);
    expect(active.isOk()).toBe(true);
    if (active.isOk()) expect(active.value.publicationCapable).toBe(true);

    expect(
      invalidTuple(
        { ...ready, activationRecord: null },
        "enabled",
        frozenTopology,
      ),
    ).toBe("InvalidRolloutStageDeclaration");
    expect(invalidTuple(preCutover, "enabled", frozenTopology)).toContain(
      "before cutover",
    );
  });

  it("rejects dual, neither, orphaned schedules, gate drift, and stage drift", () => {
    expect(
      invalidTuple(preCutover, "disabled", {
        ...preTopology,
        newWorkflowScheduled: true,
      }),
    ).toContain("old and new publication workflows");
    expect(
      invalidTuple(preCutover, "disabled", {
        ...preTopology,
        oldWorkflowPresent: false,
        oldWorkflowScheduled: false,
        newWorkflowScheduled: false,
      }),
    ).toContain("neither publication workflow");
    expect(
      invalidTuple(preCutover, "disabled", {
        ...preTopology,
        oldWorkflowPresent: false,
      }),
    ).toContain("old workflow schedule");
    expect(
      invalidTuple(preCutover, "disabled", {
        ...preTopology,
        newWorkflowPresent: false,
        newWorkflowScheduled: true,
      }),
    ).toContain("new workflow schedule");
    expect(
      invalidTuple(preCutover, "disabled", {
        ...preTopology,
        newWorkflowGateDisabled: false,
      }),
    ).toContain("rollout gate");
    expect(
      invalidTuple(
        {
          ...preCutover,
          stage: "frozen",
          freezeRecord: null,
        },
        "disabled",
        frozenTopology,
      ),
    ).toBe("InvalidRolloutStageDeclaration");
    expect(invalidTuple(ready, "dry-run", frozenTopology)).toContain(
      "only disabled or enabled",
    );
  });
});
