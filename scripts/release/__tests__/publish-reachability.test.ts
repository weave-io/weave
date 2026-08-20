import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  analyzePublishReachability,
  assertAttestationWorkflowContract,
  assertStableWorkflowGraph,
  GITHUB_APP_TOKEN_ACTION_REF,
  INCIDENT_INTEGRATION_TEST,
  INCIDENT_SEAM_PATH,
  INDEPENDENT_ATTEST_WORKFLOW,
  lintPhaseCSecurity,
  lintWorkflowPermissions,
  PHASE_C_ENVIRONMENT_CONTRACTS,
  PHASE_C_PERMISSION_CONTRACTS,
  PHASE_C_WORKFLOW_PATHS,
  PUBLISH_ENTRYPOINT,
  parseWorkflowShape,
  relativeModuleSpecifiers,
  scanReleaseCommands,
  TRUSTED_PUBLISH_WORKFLOW,
} from "../publish-reachability.js";

const ROOT = resolve(import.meta.dir, "../../..");
const trusted = `on:\n  pull_request:\n    types: [closed]\n  workflow_dispatch:\npermissions: {}\njobs:\n  route:\n    needs: []\n    permissions:\n      contents: read\n    steps:\n      - run: echo route\n  recompute:\n    needs: [route]\n  build-bind:\n    needs: [recompute]\n  await-attest:\n    needs: [build-bind]\n  consumer-proof:\n    needs: [await-attest]\n  harness-proof:\n    needs: [consumer-proof]\n  release-approval:\n    needs: [harness-proof]\n  publish:\n    needs: [release-approval]\n    permissions:\n      contents: read\n      id-token: write\n  registry-verification:\n    needs: [publish]\n  refs-cleanup:\n    needs: [registry-verification]\n`;
const attest = `on:\n  workflow_dispatch:\npermissions: {}\njobs:\n  attest:\n    permissions:\n      contents: read\n      actions: read\n      checks: write\n      id-token: write\n      attestations: write\n`;
const secretRef = (name: string) => ["$", "{{ secrets.", name, " }}"].join("");
const variableRef = (name: string) => ["$", "{{ vars.", name, " }}"].join("");
const shellVar = ["${", "NPM_TOKEN:-}"].join("");

async function phaseWorkflows() {
  return Promise.all(
    PHASE_C_WORKFLOW_PATHS.map(async (path) =>
      parseWorkflowShape(
        path,
        await Bun.file(resolve(ROOT, path)).text(),
      )._unsafeUnwrap(),
    ),
  );
}

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

  it("checks every Phase C job permission block line by line", async () => {
    const workflows = await phaseWorkflows();
    expect(lintPhaseCSecurity(workflows).isOk()).toBe(true);
    for (const workflow of workflows) {
      const contractPath =
        workflow.path as keyof typeof PHASE_C_PERMISSION_CONTRACTS;
      const contract = PHASE_C_PERMISSION_CONTRACTS[contractPath];
      expect(contract).toBeDefined();
      expect(workflow.rootPermissions).toEqual(contract.root);
      expect(
        Object.fromEntries(
          workflow.jobs.map((job) => [job.id, job.permissions]),
        ),
      ).toEqual(contract.jobs);
      expect(
        Object.fromEntries(
          workflow.jobs.map((job) => [job.id, job.environment]),
        ),
      ).toEqual(PHASE_C_ENVIRONMENT_CONTRACTS[contractPath]);
    }
  });

  it("rejects Phase C permission broadening", async () => {
    const workflows = await phaseWorkflows();
    const broadened = workflows.map((workflow) =>
      workflow.path === TRUSTED_PUBLISH_WORKFLOW
        ? {
            ...workflow,
            jobs: workflow.jobs.map((job) =>
              job.id === "publish"
                ? {
                    ...job,
                    permissions: { ...job.permissions, packages: "write" },
                  }
                : job,
            ),
          }
        : workflow,
    );
    expect(lintPhaseCSecurity(broadened).isErr()).toBe(true);
  });

  it("rejects environment gate drift", async () => {
    const workflows = await phaseWorkflows();
    const changed = workflows.map((workflow) =>
      workflow.path === TRUSTED_PUBLISH_WORKFLOW
        ? {
            ...workflow,
            jobs: workflow.jobs.map((job) =>
              job.id === "publish" ? { ...job, environment: "release" } : job,
            ),
          }
        : workflow,
    );
    expect(lintPhaseCSecurity(changed).isErr()).toBe(true);
  });

  it("rejects the obsolete stored App token and unauthorized App credentials", async () => {
    const workflows = await phaseWorkflows();
    const obsoleteName = ["RELEASE", "APP", "TOKEN"].join("_");
    const fixture = parseWorkflowShape(
      "fixture.yml",
      [
        "jobs:",
        "  unauthorized:",
        "    env:",
        `      APP_TOKEN: ${secretRef(obsoleteName)}`,
      ].join("\n"),
    )._unsafeUnwrap();
    expect(lintPhaseCSecurity([...workflows, fixture]).isErr()).toBe(true);
  });

  it("rejects an App-token output passed to a non-App job", async () => {
    const workflows = await phaseWorkflows();
    const fixture = parseWorkflowShape(
      "fixture.yml",
      [
        "jobs:",
        "  unauthorized:",
        "    steps:",
        "      - name: use token",
        "        env:",
        [
          "          GH_TOKEN: $",
          "{{ steps.release-app-token.outputs.token }}",
        ].join(""),
        "        run: gh api /user",
      ].join("\n"),
    )._unsafeUnwrap();
    expect(lintPhaseCSecurity([...workflows, fixture]).isErr()).toBe(true);
  });

  it("requires a pinned mint step before every App-token use", async () => {
    const workflows = await phaseWorkflows();
    const changed = workflows.map((workflow) =>
      workflow.path === TRUSTED_PUBLISH_WORKFLOW
        ? {
            ...workflow,
            text: workflow.text.replace(
              `uses: ${GITHUB_APP_TOKEN_ACTION_REF}`,
              "uses: ./local-action",
            ),
          }
        : workflow,
    );
    expect(lintPhaseCSecurity(changed).isErr()).toBe(true);
  });

  it("keeps the nightly route outside the App-token path", async () => {
    const workflows = await phaseWorkflows();
    const changed = workflows.map((workflow) =>
      workflow.path === TRUSTED_PUBLISH_WORKFLOW
        ? {
            ...workflow,
            text: workflow.text.replaceAll(
              "if: inputs.channel != 'nightly'",
              "if: always()",
            ),
          }
        : workflow,
    );
    expect(lintPhaseCSecurity(changed).isErr()).toBe(true);
  });

  it.each([
    ["npm token", `NPM_TOKEN: ${secretRef("NPM_TOKEN")}`],
    ["npm auth token", `NPM_AUTH_TOKEN: ${secretRef("NPM_AUTH_TOKEN")}`],
    ["npm variable", `SAFE_NAME: ${variableRef("NPM_TOKEN")}`],
    [
      "npm config",
      `NPM_CONFIG_USERCONFIG: ${secretRef("NPM_CONFIG_USERCONFIG")}`,
    ],
    ["OAuth", `OAUTH_TOKEN: ${secretRef("OAUTH_TOKEN")}`],
    ["AI subscription token", `OPENAI_TOKEN: ${secretRef("OPENAI_TOKEN")}`],
    ["harness token", `HARNESS_TOKEN: ${secretRef("HARNESS_TOKEN")}`],
  ] as const)("rejects %s credential paths", async (_name, assignment) => {
    const workflows = await phaseWorkflows();
    const fixture = parseWorkflowShape(
      "fixture.yml",
      `env:\n  ${assignment}\n`,
    )._unsafeUnwrap();
    expect(lintPhaseCSecurity([...workflows, fixture]).isErr()).toBe(true);
  });

  it("allows API-key authentication and keeps the legacy npm guard data-only", async () => {
    const workflows = await phaseWorkflows();
    const fixture = parseWorkflowShape(
      "fixture.yml",
      [
        "env:",
        `  OPENAI_API_KEY: ${secretRef("OPENAI_API_KEY")}`,
        "jobs:",
        "  guard:",
        "    steps:",
        `      - run: test -z "${shellVar}"`,
        "",
      ].join("\n"),
    )._unsafeUnwrap();
    expect(lintPhaseCSecurity([...workflows, fixture]).isOk()).toBe(true);
  });

  it("rejects pull_request_target in any workflow shape", async () => {
    const workflows = await phaseWorkflows();
    const fixture = parseWorkflowShape(
      "fixture.yml",
      "on:\n  pull_request_target:\n    types: [opened]\n",
    )._unsafeUnwrap();
    expect(lintPhaseCSecurity([...workflows, fixture]).isErr()).toBe(true);
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

  it("accepts only the exact nightly schedule and rejects reusable workflows", () => {
    const scheduled = parseWorkflowShape(
      TRUSTED_PUBLISH_WORKFLOW,
      trusted.replace(
        "workflow_dispatch:",
        "workflow_dispatch:\nschedule:\n  - cron: '17 0 * * *'",
      ),
    )._unsafeUnwrap();
    expect(assertStableWorkflowGraph(scheduled).isOk()).toBe(true);
    const wrongSchedule = parseWorkflowShape(
      TRUSTED_PUBLISH_WORKFLOW,
      trusted.replace(
        "workflow_dispatch:",
        "workflow_dispatch:\nschedule:\n  - cron: '0 0 * * *'",
      ),
    )._unsafeUnwrap();
    expect(assertStableWorkflowGraph(wrongSchedule).isErr()).toBe(true);
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
