/**
 * Artifact Integrity Verification Tests — Task 3.4
 *
 * Verifies consumption-time integrity verification in `dispatchStep`:
 *
 * 1. When an artifact has stored `integrity.digest` and the caller supplies a
 *    matching digest via `artifactDigests`, dispatch succeeds.
 * 2. When the supplied digest does not match the stored digest, `dispatchStep`
 *    returns a `policy_decision` error (fail closed).
 * 3. When no digest is supplied for an artifact with stored integrity, the
 *    check is skipped (opt-in verification).
 * 4. When an artifact has no stored `integrity` field, supplying a digest has
 *    no effect (no check performed).
 * 5. Malformed digest format (not 64 lowercase hex chars) returns a
 *    `validation` error before any comparison.
 * 6. Integrity verification applies to pinned artifacts (retry path) — pinning
 *    does not bypass tamper detection.
 * 7. Informational inputs with stored integrity are also verified when a
 *    digest is supplied.
 *
 * All tests use createInMemoryRuntimeStore — no SQLite, no filesystem.
 */

import { describe, expect, it } from "bun:test";
import { parseConfig } from "@weave/core";
import {
  createExecutionLeaseId,
  createInMemoryRuntimeStore,
  createWorkflowInstanceId,
  dispatchStep,
  startExecution,
  type ConsumedArtifactRecord,
  type WorkflowExecutionContext,
} from "@weave/engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a .weave source string and unwrap — throws on invalid input. */
function cfg(source: string) {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/** Build a WorkflowExecutionContext from a parsed config. */
function makeContext(
  config: ReturnType<typeof cfg>,
  workflowName: string,
  goal = "test goal",
  slug = "test-goal",
): WorkflowExecutionContext {
  return {
    workflowName,
    goal,
    slug,
    workflows: config.workflows ?? {},
  };
}

/** Create a running instance and return { store, instanceId, leaseId }. */
async function setupRunningInstance(
  workflowName: string,
  config: ReturnType<typeof cfg>,
) {
  const store = createInMemoryRuntimeStore();
  const instanceId = createWorkflowInstanceId(`wf-${workflowName}`);
  const context = makeContext(config, workflowName);

  const startResult = await startExecution(
    {
      workflowInstanceId: instanceId,
      ownerId: "owner-test",
      authorizationSource: "user",
      context,
    },
    store,
  );
  if (startResult.isErr()) {
    throw new Error(`startExecution failed: ${startResult.error.message}`);
  }
  const { leaseId } = startResult.value;
  return { store, instanceId, leaseId };
}

/** A valid SHA-256 hex digest (64 lowercase hex chars). */
const DIGEST_MATCHING =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A different valid SHA-256 hex digest (simulates tampered content). */
const DIGEST_TAMPERED =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Workflow with one normative input that has stored integrity metadata. */
const WORKFLOW_WITH_INTEGRITY_INPUT = cfg(`
workflow integrity-flow {
  description "Flow with integrity-verified input"
  version 1

  step produce {
    name "Produce artifact"
    type autonomous
    agent shuttle
    prompt "Produce the artifact for: {{instance.goal}}"
    completion agent_signal

    outputs [
      { name "plan_path" description "Path to the generated plan file" }
    ]
  }

  step consume {
    name "Consume artifact"
    type autonomous
    agent warp
    prompt "Consume the artifact at {{artifacts.plan_path}}"
    completion agent_signal

    inputs [
      { name "plan_path" description "Path to the plan to consume" }
    ]
  }
}
`);

/**
 * Workflow with one normative input (used for informational-style tests by
 * adding the artifact before dispatch). The DSL does not expose `role` on
 * inputs — informational role is an engine-level concept applied via
 * `ArtifactInputDecl`. These tests use a normative input with the artifact
 * present to exercise the integrity check on a present input.
 */
const WORKFLOW_WITH_INFORMATIONAL_INPUT = cfg(`
workflow info-flow {
  description "Flow with normative input (used for integrity tests)"
  version 1

  step produce {
    name "Produce artifact"
    type autonomous
    agent shuttle
    prompt "Produce the artifact for: {{instance.goal}}"
    completion agent_signal
  }

  step consume {
    name "Consume artifact"
    type autonomous
    agent warp
    prompt "Consume the artifact"
    completion agent_signal

    inputs [
      { name "hint_path" description "Optional hint file" }
    ]
  }
}
`);

// ---------------------------------------------------------------------------
// 1. Matching digest — dispatch succeeds
// ---------------------------------------------------------------------------

describe("integrity verification — matching digest allows dispatch", () => {
  it("dispatch succeeds when supplied digest matches stored digest", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    // Add artifact with stored integrity metadata
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    // Dispatch with matching digest
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: { plan_path: DIGEST_MATCHING },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().stepName).toBe("consume");
  });

  it("dispatch succeeds when artifact has integrity but no digest is supplied (opt-in)", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    // Add artifact with stored integrity metadata
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    // Dispatch without supplying any digest — check is skipped (opt-in)
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        // No artifactDigests — integrity check is opt-in
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  it("dispatch succeeds when artifact has no stored integrity and a digest is supplied", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    // Add artifact WITHOUT integrity metadata
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      // No integrity field
    });

    // Supplying a digest for an artifact without stored integrity — no check
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: { plan_path: DIGEST_MATCHING },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Mismatched digest — fail closed
// ---------------------------------------------------------------------------

describe("integrity verification — mismatched digest fails closed", () => {
  it("dispatch returns policy_decision error when digest does not match stored digest", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    // Add artifact with stored integrity metadata
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    // Dispatch with a DIFFERENT digest (simulates tampered artifact)
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: { plan_path: DIGEST_TAMPERED },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("policy_decision");
    expect(error.message).toContain("plan_path");
    expect(error.message.toLowerCase()).toContain("integrity");
    expect(error.message.toLowerCase()).toContain("tamper");
  });

  it("error message references the artifact name and revision", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: { plan_path: DIGEST_TAMPERED },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("policy_decision");
    // Should mention the artifact name
    expect(error.message).toContain("plan_path");
    // Should mention revision
    expect(error.message).toContain("revision");
    // Should reference the rule
    if ("rule" in error) {
      expect((error as { rule?: string }).rule).toBe("artifact_integrity");
    }
  });

  it("dispatch does not proceed when integrity check fails (no step attempt recorded)", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    // Dispatch with tampered digest
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: { plan_path: DIGEST_TAMPERED },
      },
      store,
    );

    expect(result.isErr()).toBe(true);

    // No step attempt should have been recorded (fail closed = no side effects)
    const instance = (
      await store.instances.getById(instanceId)
    )._unsafeUnwrap();
    expect(instance.stepAttempts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Malformed digest format
// ---------------------------------------------------------------------------

describe("integrity verification — malformed digest format", () => {
  it("returns validation error for digest that is too short", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: { plan_path: "tooshort" },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("validation");
  });

  it("returns validation error for digest with uppercase hex characters", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    // Uppercase hex — not valid (must be lowercase)
    const uppercaseDigest = DIGEST_MATCHING.toUpperCase();
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: { plan_path: uppercaseDigest },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("validation");
  });

  it("returns validation error for digest with non-hex characters", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    // 64 chars but with non-hex characters
    const invalidDigest = "z".repeat(64);
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: { plan_path: invalidDigest },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("validation");
  });

  it("validation error field references the artifact name", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: { plan_path: "bad" },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("validation");
    if ("field" in error) {
      expect((error as { field?: string }).field).toContain("plan_path");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Pinned artifacts — integrity still verified
// ---------------------------------------------------------------------------

describe("integrity verification — pinned artifacts (retry path)", () => {
  it("integrity check applies to pinned artifacts — mismatch fails closed", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    // Add artifact with stored integrity
    const withArtifact = (
      await store.instances.addArtifact(instanceId, {
        name: "plan_path",
        path: ".weave/plans/test.md",
        integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
      })
    )._unsafeUnwrap();
    const artifactId = withArtifact.artifacts[0].id;

    // First dispatch succeeds (no digest supplied)
    await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
      },
      store,
    );

    // Retry with explicit pin but tampered digest — should fail
    const pin: ConsumedArtifactRecord = {
      artifactId,
      name: "plan_path",
      revision: 1,
    };

    const retryResult = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        pinnedArtifactRevisions: [pin],
        artifactDigests: { plan_path: DIGEST_TAMPERED },
      },
      store,
    );

    expect(retryResult.isErr()).toBe(true);
    expect(retryResult._unsafeUnwrapErr().type).toBe("policy_decision");
  });

  it("integrity check passes for pinned artifacts with matching digest", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    // Add artifact with stored integrity
    const withArtifact = (
      await store.instances.addArtifact(instanceId, {
        name: "plan_path",
        path: ".weave/plans/test.md",
        integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
      })
    )._unsafeUnwrap();
    const artifactId = withArtifact.artifacts[0].id;

    // First dispatch
    await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
      },
      store,
    );

    // Retry with explicit pin and MATCHING digest — should succeed
    const pin: ConsumedArtifactRecord = {
      artifactId,
      name: "plan_path",
      revision: 1,
    };

    const retryResult = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        pinnedArtifactRevisions: [pin],
        artifactDigests: { plan_path: DIGEST_MATCHING },
      },
      store,
    );

    expect(retryResult.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Informational inputs — integrity verified when digest supplied
// ---------------------------------------------------------------------------

describe("integrity verification — informational inputs", () => {
  it("informational input with stored integrity fails closed on mismatch", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "info-flow",
      WORKFLOW_WITH_INFORMATIONAL_INPUT,
    );
    const context = makeContext(WORKFLOW_WITH_INFORMATIONAL_INPUT, "info-flow");

    // Add informational artifact with stored integrity
    await store.instances.addArtifact(instanceId, {
      name: "hint_path",
      path: ".weave/hints/test.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    // Dispatch with tampered digest for informational input
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: { hint_path: DIGEST_TAMPERED },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("policy_decision");
  });

  it("informational input with stored integrity succeeds with matching digest", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "info-flow",
      WORKFLOW_WITH_INFORMATIONAL_INPUT,
    );
    const context = makeContext(WORKFLOW_WITH_INFORMATIONAL_INPUT, "info-flow");

    // Add informational artifact with stored integrity
    await store.instances.addArtifact(instanceId, {
      name: "hint_path",
      path: ".weave/hints/test.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    // Dispatch with matching digest
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: { hint_path: DIGEST_MATCHING },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  it("normative input dispatch fails when artifact is absent (not_found)", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "info-flow",
      WORKFLOW_WITH_INFORMATIONAL_INPUT,
    );
    const context = makeContext(WORKFLOW_WITH_INFORMATIONAL_INPUT, "info-flow");

    // No artifact added — normative input is required
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
      },
      store,
    );

    // Normative input is absent — dispatch fails with not_found
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// 6. Multiple artifacts — first mismatch fails fast
// ---------------------------------------------------------------------------

describe("integrity verification — multiple artifacts", () => {
  it("first integrity mismatch fails fast without checking remaining artifacts", async () => {
    // Workflow with two normative inputs
    const twoInputConfig = cfg(`
workflow two-input-flow {
  description "Flow with two normative inputs"
  version 1

  step produce {
    name "Produce artifacts"
    type autonomous
    agent shuttle
    prompt "Produce artifacts for: {{instance.goal}}"
    completion agent_signal
  }

  step consume {
    name "Consume artifacts"
    type autonomous
    agent warp
    prompt "Consume the artifacts"
    completion agent_signal

    inputs [
      { name "artifact_a" description "First artifact" }
      { name "artifact_b" description "Second artifact" }
    ]
  }
}
`);

    const { store, instanceId, leaseId } = await setupRunningInstance(
      "two-input-flow",
      twoInputConfig,
    );
    const context = makeContext(twoInputConfig, "two-input-flow");

    // Add both artifacts with stored integrity
    await store.instances.addArtifact(instanceId, {
      name: "artifact_a",
      path: ".weave/plans/a.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });
    await store.instances.addArtifact(instanceId, {
      name: "artifact_b",
      path: ".weave/plans/b.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    // First artifact has tampered digest, second is correct
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: {
          artifact_a: DIGEST_TAMPERED,
          artifact_b: DIGEST_MATCHING,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("policy_decision");
    expect(error.message).toContain("artifact_a");
  });
});

// ---------------------------------------------------------------------------
// 7. Backward compatibility — existing tests unaffected
// ---------------------------------------------------------------------------

describe("integrity verification — backward compatibility", () => {
  it("dispatch without artifactDigests behaves identically to pre-3.4 behavior", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    // Add artifact with stored integrity — but no digest supplied
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    // No artifactDigests — should behave exactly as before (no check)
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        // artifactDigests omitted
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  it("dispatch without artifactDigests and without stored integrity succeeds", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    // Add artifact WITHOUT integrity metadata
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
    });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  it("empty artifactDigests map is treated as no digests supplied", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    // Empty map — no digests supplied for any artifact
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: {},
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. verifyArtifactIntegrity — unit-level edge cases
// ---------------------------------------------------------------------------

describe("integrity verification — edge cases", () => {
  it("supplying digest for artifact not in step inputs has no effect", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/test.md",
    });

    // Supply a digest for a non-existent artifact name — should be ignored
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: {
          plan_path: DIGEST_MATCHING, // no stored integrity — skipped
          nonexistent_artifact: DIGEST_TAMPERED, // not in step inputs — ignored
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  it("integrity check uses the latest revision when multiple revisions exist", async () => {
    const { store, instanceId, leaseId } = await setupRunningInstance(
      "integrity-flow",
      WORKFLOW_WITH_INTEGRITY_INPUT,
    );
    const context = makeContext(
      WORKFLOW_WITH_INTEGRITY_INPUT,
      "integrity-flow",
    );

    // Add v1 with one digest
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/v1.md",
      integrity: { algorithm: "sha256", digest: DIGEST_TAMPERED },
    });

    // Add v2 with a different digest (DIGEST_MATCHING)
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/v2.md",
      integrity: { algorithm: "sha256", digest: DIGEST_MATCHING },
    });

    // Supply the digest for v2 (the latest) — should succeed
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId,
        stepName: "consume",
        context,
        artifactDigests: { plan_path: DIGEST_MATCHING },
      },
      store,
    );

    // Note: v2 is pending (no prior approval), so dispatch may fail due to
    // approval invalidation (v1 was never approved, so no invalidation).
    // The integrity check itself should pass.
    // v1 was never approved, so isApprovalInvalidated returns false.
    expect(result.isOk()).toBe(true);
  });
});
