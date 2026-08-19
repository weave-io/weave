import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  analyzePublishReachability,
  assertAttestationWorkflowContract,
  assertStableWorkflowGraph,
  INCIDENT_INTEGRATION_TEST,
  INCIDENT_SEAM_PATH,
  INDEPENDENT_ATTEST_WORKFLOW,
  lintWorkflowPermissions,
  PUBLISH_ENTRYPOINT,
  parseWorkflowShape,
  relativeModuleSpecifiers,
  scanReleaseCommands,
  TRUSTED_PUBLISH_WORKFLOW,
} from "../publish-reachability.js";

const ROOT = resolve(import.meta.dir, "../../..");
const trusted = `on:\n  pull_request:\n    types: [closed]\n  workflow_dispatch:\npermissions: {}\njobs:\n  route:\n    needs: []\n    permissions:\n      contents: read\n    steps:\n      - run: echo route\n  recompute:\n    needs: [route]\n  build-bind:\n    needs: [recompute]\n  await-attest:\n    needs: [build-bind]\n  consumer-proof:\n    needs: [await-attest]\n  harness-proof:\n    needs: [consumer-proof]\n  release-approval:\n    needs: [harness-proof]\n  publish:\n    needs: [release-approval]\n    permissions:\n      contents: read\n      id-token: write\n  registry-verification:\n    needs: [publish]\n  refs-cleanup:\n    needs: [registry-verification]\n`;
const attest = `on:\n  workflow_dispatch:\npermissions: {}\njobs:\n  attest:\n    permissions:\n      contents: read\n      actions: read\n      checks: write\n      id-token: write\n      attestations: write\n`;

describe("publish reachability boundary", () => {
  it("accepts the repository graph and records only the trusted publish origin", async () => {
    const result = await analyzePublishReachability(ROOT);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.publishOrigins).toEqual([TRUSTED_PUBLISH_WORKFLOW]);
      expect(
        result.value.invocations.some(
          (item) => item.target === PUBLISH_ENTRYPOINT,
        ),
      ).toBe(true);
    }
  });

  it("parses and checks the exact stable graph", () => {
    const shape = parseWorkflowShape(
      TRUSTED_PUBLISH_WORKFLOW,
      trusted,
    )._unsafeUnwrap();
    expect(assertStableWorkflowGraph(shape).isOk()).toBe(true);
    const attestShape = parseWorkflowShape(
      INDEPENDENT_ATTEST_WORKFLOW,
      attest,
    )._unsafeUnwrap();
    expect(assertAttestationWorkflowContract(attestShape).isOk()).toBe(true);
  });

  it("rejects schedule and reusable workflow changes", () => {
    const scheduled = parseWorkflowShape(
      TRUSTED_PUBLISH_WORKFLOW,
      trusted.replace(
        "workflow_dispatch:",
        "workflow_dispatch:\n  schedule:\n    - cron: '0 0 * * *'",
      ),
    )._unsafeUnwrap();
    expect(assertStableWorkflowGraph(scheduled).isErr()).toBe(true);
    const reusable = parseWorkflowShape(
      TRUSTED_PUBLISH_WORKFLOW,
      trusted.replace(
        "workflow_dispatch:",
        "workflow_dispatch:\n  workflow_call:",
      ),
    )._unsafeUnwrap();
    expect(assertStableWorkflowGraph(reusable).isErr()).toBe(true);
  });

  it("rejects permission broadening and unlisted OIDC identities", () => {
    const badTrusted = parseWorkflowShape(
      TRUSTED_PUBLISH_WORKFLOW,
      trusted.replace(
        "  registry-verification:",
        "  other:\n    permissions:\n      id-token: write\n  registry-verification:",
      ),
    )._unsafeUnwrap();
    const goodAttest = parseWorkflowShape(
      INDEPENDENT_ATTEST_WORKFLOW,
      attest,
    )._unsafeUnwrap();
    expect(lintWorkflowPermissions([badTrusted, goodAttest]).isErr()).toBe(
      true,
    );
    const badAttest = parseWorkflowShape(
      INDEPENDENT_ATTEST_WORKFLOW,
      attest.replace(
        "      checks: write",
        "      checks: write\n      packages: write",
      ),
    )._unsafeUnwrap();
    expect(
      lintWorkflowPermissions([
        parseWorkflowShape(TRUSTED_PUBLISH_WORKFLOW, trusted)._unsafeUnwrap(),
        badAttest,
      ]).isErr(),
    ).toBe(true);
  });

  it.each([
    [
      "deprecate",
      `echo npm deprecate @weaveio/weave-cli@1.0.0 "notice"`,
      "DeprecateInvocationDetected",
    ],
    [
      "seam",
      `bun scripts/release/__tests__/fixtures/local-registry/deprecation-seam.ts`,
      "FixtureSeamReachability",
    ],
    [
      "integration test",
      `bun test ${INCIDENT_INTEGRATION_TEST}`,
      "IntegrationTestInvocation",
    ],
    [
      "direct publish",
      "npm publish package.tgz",
      "PublishReachabilityViolation",
    ],
  ] as const)("rejects %s command paths", (_name, command, type) => {
    const result = scanReleaseCommands("fixture", command, "fixture");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(type);
  });

  it("keeps import type edges out of the production module graph", () => {
    const modules = relativeModuleSpecifiers(
      `import type { X } from './type-only.js';\nimport { Y } from './runtime.js';\nconst z = await import('./dynamic.js');`,
    );
    expect(modules).toEqual(["./runtime.js", "./dynamic.js"]);
    expect(INCIDENT_SEAM_PATH).toContain("local-registry");
  });
});
