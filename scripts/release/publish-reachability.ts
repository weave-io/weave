/**
 * Semantic release-boundary lint.
 *
 * This checker is deliberately independent of YAML and package-build
 * machinery. It walks workflow commands, local composite/reusable actions,
 * package-script aliases, and relative TypeScript imports. It does not trust a
 * filename convention: an executable release root must be in the checked-in
 * inventory, and only the trusted workflow may invoke `publish-main.ts`.
 */
import { dirname, join, relative, resolve } from "node:path";
import { err, ok, Result, ResultAsync } from "neverthrow";
import {
  CUTOVER_NIGHTLY_CRON,
  RELEASE_ATTEST_WORKFLOW_PATH,
  RELEASE_PUBLISH_WORKFLOW_PATH,
  RELEASE_STABLE_PREPARE_WORKFLOW_PATH,
  RELEASE_STABLE_REGENERATE_WORKFLOW_PATH,
} from "./constants.js";
import {
  discoverProductionReleaseEntrypoints,
  type EntrypointInventoryError,
  isTestOnlyRoot,
  type ProductionRoot,
  scriptAliases,
  scriptCommandPaths,
} from "./entrypoint-inventory.js";
import {
  STABLE_PUBLISH_CHAIN,
  STABLE_PUBLISH_CHAIN_NEEDS,
} from "./publish-chain.js";

export const TRUSTED_PUBLISH_WORKFLOW = RELEASE_PUBLISH_WORKFLOW_PATH;
export const INDEPENDENT_ATTEST_WORKFLOW = RELEASE_ATTEST_WORKFLOW_PATH;
export const PUBLISH_ENTRYPOINT = "scripts/release/publish-main.ts";
export const PUBLISH_EXECUTOR_MODULE = "scripts/release/publish-executor.ts";
export const INCIDENT_INTEGRATION_TEST =
  "scripts/release/__tests__/incident-recovery.integration.test.ts";
export const INCIDENT_SEAM_PATH =
  "scripts/release/__tests__/fixtures/local-registry";

/** Unrelated identities outside the release paths. A named policy exception,
 * not a permission wildcard. The cutover removed the old publisher. */
export const ALLOWED_UNRELATED_ID_TOKEN_WORKFLOWS = new Set([
  ".github/workflows/deploy-docs.yml",
]);

export const DOCS_AUDIT_WORKFLOW_PATH =
  ".github/workflows/docs-audit.yml" as const;
export const DOCS_AUDIT_FOLLOWUP_WORKFLOW_PATH =
  ".github/workflows/docs-audit-followup.yml" as const;

/** The six Phase C workflows covered by the release security contract. */
export const PHASE_C_WORKFLOW_PATHS = [
  RELEASE_STABLE_PREPARE_WORKFLOW_PATH,
  RELEASE_STABLE_REGENERATE_WORKFLOW_PATH,
  RELEASE_PUBLISH_WORKFLOW_PATH,
  RELEASE_ATTEST_WORKFLOW_PATH,
  DOCS_AUDIT_WORKFLOW_PATH,
  DOCS_AUDIT_FOLLOWUP_WORKFLOW_PATH,
] as const;
export type PhaseCWorkflowPath = (typeof PHASE_C_WORKFLOW_PATHS)[number];

export type WorkflowPermissionMap = Readonly<Record<string, string>>;
export type WorkflowPermissionContract = Readonly<{
  root: WorkflowPermissionMap;
  jobs: Readonly<Record<string, WorkflowPermissionMap>>;
}>;

/**
 * Exact job-level permissions for the Phase C workflows. Keep this contract
 * next to the reachability checker so a workflow cannot silently broaden a
 * boundary while its documentation still describes the old one.
 */
const workflowExpression = (body: string): string =>
  ["$", "{{ ", body, " }}"].join("");
const NIGHTLY_OR_RELEASE_APP_ENVIRONMENT = workflowExpression(
  "(inputs.channel == 'nightly' || github.event_name == 'schedule') && '' || 'release-app'",
);
const NIGHTLY_OR_HARNESS_PROOF_ENVIRONMENT = workflowExpression(
  "(inputs.channel == 'nightly' || github.event_name == 'schedule') && '' || 'harness-proof'",
);
const CHANNEL_APPROVAL_ENVIRONMENT = workflowExpression(
  "inputs.channel == 'next' && 'prerelease' || ((inputs.channel == 'nightly' || github.event_name == 'schedule') && '' || 'release')",
);

export const PHASE_C_PERMISSION_CONTRACTS = {
  [RELEASE_STABLE_PREPARE_WORKFLOW_PATH]: {
    root: {},
    jobs: {
      authorize: { contents: "read" },
      plan: { contents: "read", checks: "read" },
      "docs-release-audit": { contents: "read" },
      "changelog-ai": { contents: "read" },
      "open-pr": {
        contents: "write",
        "pull-requests": "write",
        checks: "read",
      },
      "plan-2": { contents: "read", checks: "read" },
      "docs-release-audit-2": { contents: "read" },
      "changelog-ai-2": { contents: "read" },
      "open-pr-2": {
        contents: "write",
        "pull-requests": "write",
        checks: "read",
      },
      "plan-3": { contents: "read", checks: "read" },
      "docs-release-audit-3": { contents: "read" },
      "changelog-ai-3": { contents: "read" },
      "open-pr-3": {
        contents: "write",
        "pull-requests": "write",
        checks: "read",
      },
      "recovery-summary": {},
    },
  },
  [RELEASE_STABLE_REGENERATE_WORKFLOW_PATH]: {
    root: {},
    jobs: {
      "manual-authorize": { contents: "read" },
      detect: {
        contents: "read",
        checks: "read",
        "pull-requests": "read",
      },
      plan: { contents: "read", checks: "read" },
      "docs-release-audit": { contents: "read", checks: "write" },
      "changelog-ai": { contents: "read" },
      "update-pr": {
        contents: "write",
        "pull-requests": "write",
        checks: "write",
      },
      "recovery-summary": {},
    },
  },
  [RELEASE_PUBLISH_WORKFLOW_PATH]: {
    root: {},
    jobs: {
      route: { contents: "read", "pull-requests": "read" },
      recompute: { contents: "read", checks: "read" },
      "build-bind": { contents: "read", actions: "write" },
      "await-attest": {
        contents: "read",
        actions: "write",
        checks: "read",
      },
      "consumer-proof": { contents: "read", actions: "read" },
      "harness-proof": { contents: "read", actions: "read" },
      "release-approval": { contents: "read", checks: "read" },
      publish: { actions: "write", contents: "read", "id-token": "write" },
      "registry-verification": { contents: "read", actions: "read" },
      "refs-cleanup": { contents: "write", "pull-requests": "write" },
    },
  },
  [RELEASE_ATTEST_WORKFLOW_PATH]: {
    root: {},
    jobs: {
      attest: {
        actions: "read",
        attestations: "write",
        checks: "write",
        contents: "read",
        "id-token": "write",
      },
    },
  },
  [DOCS_AUDIT_WORKFLOW_PATH]: {
    root: {},
    jobs: {
      "docs-deterministic": { contents: "read" },
      "docs-ai-audit": { contents: "read" },
      "docs-ai-fork-skip": {},
      "docs-audit": { contents: "read", checks: "write" },
    },
  },
  [DOCS_AUDIT_FOLLOWUP_WORKFLOW_PATH]: {
    root: {},
    jobs: {
      "followup-audit": { contents: "read", "pull-requests": "read" },
      "followup-post": {
        contents: "read",
        "pull-requests": "write",
        checks: "write",
      },
      "docs-audit": { contents: "read", checks: "write" },
      "apply-patches": { contents: "write", "pull-requests": "write" },
    },
  },
} as const satisfies Readonly<
  Record<PhaseCWorkflowPath, WorkflowPermissionContract>
>;

/** Exact environment gate (or null) for every Phase C job. */
export const PHASE_C_ENVIRONMENT_CONTRACTS: Readonly<
  Record<PhaseCWorkflowPath, Readonly<Record<string, string | null>>>
> = {
  [RELEASE_STABLE_PREPARE_WORKFLOW_PATH]: {
    authorize: "release-app",
    plan: null,
    "docs-release-audit": "release-ai",
    "changelog-ai": "release-ai",
    "open-pr": "release-app",
    "plan-2": null,
    "docs-release-audit-2": "release-ai",
    "changelog-ai-2": "release-ai",
    "open-pr-2": "release-app",
    "plan-3": null,
    "docs-release-audit-3": "release-ai",
    "changelog-ai-3": "release-ai",
    "open-pr-3": "release-app",
    "recovery-summary": null,
  },
  [RELEASE_STABLE_REGENERATE_WORKFLOW_PATH]: {
    "manual-authorize": "release-app",
    detect: null,
    plan: null,
    "docs-release-audit": "release-ai",
    "changelog-ai": "release-ai",
    "update-pr": "release-app",
    "recovery-summary": null,
  },
  [RELEASE_PUBLISH_WORKFLOW_PATH]: {
    route: NIGHTLY_OR_RELEASE_APP_ENVIRONMENT,
    recompute: null,
    "build-bind": null,
    "await-attest": null,
    "consumer-proof": null,
    "harness-proof": NIGHTLY_OR_HARNESS_PROOF_ENVIRONMENT,
    "release-approval": CHANNEL_APPROVAL_ENVIRONMENT,
    publish: CHANNEL_APPROVAL_ENVIRONMENT,
    "registry-verification": null,
    "refs-cleanup": NIGHTLY_OR_RELEASE_APP_ENVIRONMENT,
  },
  [RELEASE_ATTEST_WORKFLOW_PATH]: { attest: null },
  [DOCS_AUDIT_WORKFLOW_PATH]: {
    "docs-deterministic": null,
    "docs-ai-audit": "release-ai",
    "docs-ai-fork-skip": null,
    "docs-audit": null,
  },
  [DOCS_AUDIT_FOLLOWUP_WORKFLOW_PATH]: {
    "followup-audit": "release-ai",
    "followup-post": "release-app",
    "docs-audit": "release-app",
    "apply-patches": "docs-audit-patch",
  },
};

export const GITHUB_APP_TOKEN_ACTION_REF =
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1" as const;
export const RELEASE_APP_INSTALLATION_TOKEN_ENV =
  "RELEASE_APP_INSTALLATION_TOKEN" as const;
const GITHUB_APP_TOKEN_OUTPUT =
  "steps.release-app-token.outputs.token" as const;
const RELEASE_APP_ID_SECRET_REF = "secrets.RELEASE_APP_ID" as const;
const RELEASE_APP_PRIVATE_KEY_SECRET_REF =
  "secrets.RELEASE_APP_PRIVATE_KEY" as const;
const OBSOLETE_APP_TOKEN_SECRET_REF = `secrets.${[
  "RELEASE",
  "APP",
  "TOKEN",
].join("_")}`;

type AppTokenJobContract = Readonly<{
  environment: string;
  permissions: Readonly<Record<string, string>>;
  condition?: string;
}>;

/**
 * Every job that receives App authority is listed explicitly. A job not in
 * this map must not mint or receive an App token.
 */
const APP_TOKEN_JOB_CONTRACTS: Readonly<
  Record<string, Readonly<Record<string, AppTokenJobContract>>>
> = {
  [RELEASE_STABLE_PREPARE_WORKFLOW_PATH]: {
    authorize: {
      environment: "release-app",
      permissions: { members: "read" },
    },
    "open-pr": {
      environment: "release-app",
      permissions: {
        contents: "write",
        "pull-requests": "write",
        checks: "read",
      },
    },
    "open-pr-2": {
      environment: "release-app",
      permissions: {
        contents: "write",
        "pull-requests": "write",
        checks: "read",
      },
    },
    "open-pr-3": {
      environment: "release-app",
      permissions: {
        contents: "write",
        "pull-requests": "write",
        checks: "read",
      },
    },
  },
  [RELEASE_STABLE_REGENERATE_WORKFLOW_PATH]: {
    "manual-authorize": {
      environment: "release-app",
      permissions: { members: "read" },
    },
    "update-pr": {
      environment: "release-app",
      permissions: {
        contents: "write",
        "pull-requests": "write",
        checks: "write",
      },
    },
  },
  [RELEASE_PUBLISH_WORKFLOW_PATH]: {
    route: {
      environment: NIGHTLY_OR_RELEASE_APP_ENVIRONMENT,
      permissions: { contents: "write" },
      condition:
        "inputs.channel != 'nightly' && github.event_name != 'schedule'",
    },
    "refs-cleanup": {
      environment: NIGHTLY_OR_RELEASE_APP_ENVIRONMENT,
      permissions: { contents: "write", "pull-requests": "write" },
      condition:
        "inputs.channel != 'nightly' && github.event_name != 'schedule'",
    },
  },
  [DOCS_AUDIT_FOLLOWUP_WORKFLOW_PATH]: {
    "followup-post": {
      environment: "release-app",
      permissions: {
        contents: "read",
        "pull-requests": "write",
        checks: "write",
      },
    },
    "docs-audit": {
      environment: "release-app",
      permissions: { contents: "read", checks: "write" },
    },
    "apply-patches": {
      environment: "docs-audit-patch",
      permissions: { contents: "write", "pull-requests": "write" },
    },
  },
  ".github/workflows/publish.yml": {
    "release-refs": {
      environment: "release-refs",
      permissions: { contents: "write", "pull-requests": "write" },
    },
  },
};

export interface WorkflowJobShape {
  readonly id: string;
  readonly needs: readonly string[];
  readonly permissions: WorkflowPermissionMap;
  readonly environment: string | null;
  readonly runs: readonly string[];
  readonly localUses: readonly string[];
}

export interface WorkflowShape {
  readonly path: string;
  readonly text: string;
  readonly rootPermissions: WorkflowPermissionMap | null;
  readonly workflowCalls: boolean;
  readonly scheduled: boolean;
  readonly jobs: readonly WorkflowJobShape[];
}

export type ReachabilityFailureKind =
  | "AlternatePublishInvocation"
  | "SecondPublishEntrypoint"
  | "AttestationPublishReachability"
  | "WorkflowCallForbidden"
  | "WorkflowPermissionViolation"
  | "UnlistedIdToken"
  | "DirectPublishInvocation"
  | "DeprecateInvocation"
  | "FixtureSeamReachability"
  | "IntegrationTestInvocation"
  | "CredentialBoundaryViolation"
  | "PullRequestTargetForbidden"
  | "WorkflowReadFailed"
  | "ModuleReadFailed";

export type PublishReachabilityError =
  | {
      type: "UnknownProductionEntrypoint";
      path: string;
      discoveredFrom: string;
    }
  | {
      type: "PublishReachabilityViolation";
      kind: ReachabilityFailureKind;
      origin: string;
      target?: string;
      reason: string;
    }
  | {
      type: "WorkflowPermissionViolation";
      path: string;
      job?: string;
      reason: string;
    }
  | { type: "DeprecateInvocationDetected"; origin: string; command: string }
  | { type: "FixtureSeamReachability"; origin: string; target: string }
  | { type: "IntegrationTestInvocation"; origin: string }
  | { type: "WorkflowReadFailed"; path: string; reason: string }
  | { type: "ModuleReadFailed"; path: string; reason: string }
  | { type: "ReachabilityBoundExceeded"; bound: string }
  | EntrypointInventoryError;

export interface PublishReachabilityReport {
  readonly workflows: readonly WorkflowShape[];
  readonly invocations: readonly {
    origin: string;
    command: string;
    target: string;
  }[];
  readonly publishOrigins: readonly string[];
  readonly inventoryRoots: readonly ProductionRoot[];
}

const EMPTY_PERMISSIONS: WorkflowPermissionMap = {};
const MAX_MODULES = 1_024;
const MAX_LOCAL_USE_DEPTH = 8;

/** Parse the subset of YAML needed for the security contract. */
export function parseWorkflowShape(
  path: string,
  text: string,
): Result<WorkflowShape, PublishReachabilityError> {
  const lines = withoutYamlComments(text).split("\n");
  const workflowCalls = lines.some(
    (line) =>
      /^\s*workflow_call\s*:/.test(line) && !line.trimStart().startsWith("#"),
  );
  const scheduled = lines.some((line) => /^\s*schedule\s*:/.test(line));
  const jobsLine = lines.findIndex((line) => line.trim() === "jobs:");
  const rootPermissions = readRootPermissions(lines, jobsLine);
  const jobs: WorkflowJobShape[] = [];
  if (jobsLine >= 0) {
    for (let index = jobsLine + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const match = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
      if (match === null) continue;
      const id = match[1];
      if (id === undefined) continue;
      const end = nextJobLine(lines, index + 1);
      jobs.push(parseJob(id, lines, index + 1, end));
      index = end - 1;
    }
  }
  return ok({ path, text, rootPermissions, workflowCalls, scheduled, jobs });
}

export function lintWorkflowPermissions(
  workflows: readonly WorkflowShape[],
): Result<void, PublishReachabilityError> {
  const trusted = workflows.find(
    (workflow) => workflow.path === TRUSTED_PUBLISH_WORKFLOW,
  );
  if (trusted === undefined)
    return err({
      type: "WorkflowPermissionViolation",
      path: TRUSTED_PUBLISH_WORKFLOW,
      reason: "trusted publish workflow is missing",
    });
  if (trusted.workflowCalls)
    return err({
      type: "PublishReachabilityViolation",
      kind: "WorkflowCallForbidden",
      origin: trusted.path,
      reason: "the trusted publisher must not declare workflow_call",
    });
  if (
    trusted.rootPermissions === null ||
    Object.keys(trusted.rootPermissions).length !== 0
  )
    return err({
      type: "WorkflowPermissionViolation",
      path: trusted.path,
      reason: "trusted publish workflow must declare root permissions: {}",
    });
  const trustedJobs = trusted.jobs.filter(
    (job) => job.permissions["id-token"] === "write",
  );
  if (trustedJobs.length !== 1 || trustedJobs[0]?.id !== "publish")
    return err({
      type: "WorkflowPermissionViolation",
      path: trusted.path,
      reason: "exactly the publish job may declare id-token: write",
    });
  if (
    trusted.jobs.some(
      (job) =>
        job.id !== "publish" && job.permissions["id-token"] !== undefined,
    )
  )
    return err({
      type: "WorkflowPermissionViolation",
      path: trusted.path,
      reason: "only the publish job may declare an id-token permission",
    });
  const publish = trusted.jobs.find((job) => job.id === "publish");
  if (publish === undefined)
    return err({
      type: "WorkflowPermissionViolation",
      path: trusted.path,
      job: "publish",
      reason: "publish job is missing",
    });
  if (publish.permissions.contents !== "read")
    return err({
      type: "WorkflowPermissionViolation",
      path: trusted.path,
      job: "publish",
      reason: "publish job must grant contents: read",
    });

  const attest = workflows.find(
    (workflow) => workflow.path === INDEPENDENT_ATTEST_WORKFLOW,
  );
  if (attest === undefined)
    return err({
      type: "WorkflowPermissionViolation",
      path: INDEPENDENT_ATTEST_WORKFLOW,
      reason: "independent attestation workflow is missing",
    });
  if (attest.workflowCalls)
    return err({
      type: "PublishReachabilityViolation",
      kind: "WorkflowCallForbidden",
      origin: attest.path,
      reason: "the attestation workflow must not declare workflow_call",
    });
  if (
    attest.rootPermissions === null ||
    Object.keys(attest.rootPermissions).length !== 0
  )
    return err({
      type: "WorkflowPermissionViolation",
      path: attest.path,
      reason: "attestation workflow must declare root permissions: {}",
    });
  if (attest.jobs.length !== 1 || attest.jobs[0]?.id !== "attest")
    return err({
      type: "WorkflowPermissionViolation",
      path: attest.path,
      reason: "attestation workflow must contain exactly one attest job",
    });
  const expected = {
    actions: "read",
    attestations: "write",
    checks: "write",
    contents: "read",
    "id-token": "write",
  } as const;
  const actual = attest.jobs[0]?.permissions ?? EMPTY_PERMISSIONS;
  if (!samePermissionMap(actual, expected))
    return err({
      type: "WorkflowPermissionViolation",
      path: attest.path,
      job: "attest",
      reason: `attest permissions must be exactly ${Object.keys(expected).join(", ")}`,
    });

  for (const workflow of workflows) {
    if (workflow.rootPermissions?.["id-token"] === "write") {
      if (
        workflow.path !== TRUSTED_PUBLISH_WORKFLOW &&
        workflow.path !== INDEPENDENT_ATTEST_WORKFLOW &&
        !ALLOWED_UNRELATED_ID_TOKEN_WORKFLOWS.has(workflow.path)
      )
        return err({
          type: "PublishReachabilityViolation",
          kind: "UnlistedIdToken",
          origin: `${workflow.path}#root`,
          reason:
            "id-token: write is not in the explicit unrelated-workflow allowlist",
        });
    }
    for (const job of workflow.jobs) {
      if (job.permissions["id-token"] !== "write") continue;
      if (
        workflow.path !== TRUSTED_PUBLISH_WORKFLOW &&
        workflow.path !== INDEPENDENT_ATTEST_WORKFLOW &&
        !ALLOWED_UNRELATED_ID_TOKEN_WORKFLOWS.has(workflow.path)
      )
        return err({
          type: "PublishReachabilityViolation",
          kind: "UnlistedIdToken",
          origin: `${workflow.path}#${job.id}`,
          reason:
            "id-token: write is not in the explicit unrelated-workflow allowlist",
        });
    }
  }
  return ok(undefined);
}

/**
 * Check the exact Phase C job permission matrix and credential/execution
 * boundaries. The broader id-token inventory remains in
 * lintWorkflowPermissions so this function can also be used by focused
 * workflow-shape tests.
 */
export function lintPhaseCSecurity(
  workflows: readonly WorkflowShape[],
): Result<void, PublishReachabilityError> {
  for (const path of PHASE_C_WORKFLOW_PATHS) {
    const workflow = workflows.find((candidate) => candidate.path === path);
    if (workflow === undefined)
      return err({
        type: "WorkflowPermissionViolation",
        path,
        reason: "Phase C workflow is missing from the security contract",
      });
    const expected = PHASE_C_PERMISSION_CONTRACTS[path];
    if (
      workflow.rootPermissions === null ||
      !samePermissionMap(workflow.rootPermissions, expected.root)
    )
      return err({
        type: "WorkflowPermissionViolation",
        path,
        reason: "workflow root permissions do not match the Phase C contract",
      });
    const expectedJobs = Object.keys(expected.jobs);
    const actualJobs = workflow.jobs.map((job) => job.id);
    if (
      actualJobs.length !== expectedJobs.length ||
      actualJobs.some((job) => !expectedJobs.includes(job))
    )
      return err({
        type: "WorkflowPermissionViolation",
        path,
        reason: `job set must be exactly ${expectedJobs.join(", ")}`,
      });
    for (const [jobId, permissions] of Object.entries(expected.jobs)) {
      const job = workflow.jobs.find((candidate) => candidate.id === jobId);
      if (job === undefined)
        return err({
          type: "WorkflowPermissionViolation",
          path,
          job: jobId,
          reason: "job is missing from the Phase C permission contract",
        });
      if (!samePermissionMap(job.permissions, permissions))
        return err({
          type: "WorkflowPermissionViolation",
          path,
          job: jobId,
          reason: "job permissions do not match the Phase C contract",
        });
      const expectedEnvironment =
        PHASE_C_ENVIRONMENT_CONTRACTS[path][jobId] ?? null;
      if (job.environment !== expectedEnvironment)
        return err({
          type: "WorkflowPermissionViolation",
          path,
          job: jobId,
          reason: "job environment does not match the Phase C gate contract",
        });
    }
  }
  const credentialLint = lintWorkflowCredentialBoundaries(workflows);
  if (credentialLint.isErr()) return credentialLint;
  return lintAppTokenSecurity(workflows);
}

/**
 * Verify the short-lived App-token boundary independently of GitHub's YAML
 * parser. This catches credential movement that the permission/environment
 * shape alone cannot see: missing mint steps, stale direct secrets, token use
 * before minting, and App credentials crossing into non-App jobs.
 */
function lintAppTokenSecurity(
  workflows: readonly WorkflowShape[],
): Result<void, PublishReachabilityError> {
  for (const workflow of workflows) {
    const source = withoutYamlComments(workflow.text);
    if (source.includes(OBSOLETE_APP_TOKEN_SECRET_REF))
      return appTokenViolation(
        workflow.path,
        "workflow still references the obsolete stored App token secret",
      );

    const expectedJobs = APP_TOKEN_JOB_CONTRACTS[workflow.path] ?? {};
    for (const job of workflow.jobs) {
      const contract = expectedJobs[job.id];
      const block = workflowJobBlock(workflow, job.id);
      if (block === undefined)
        return appTokenViolation(
          workflow.path,
          `cannot read the ${job.id} job block for App-token validation`,
        );
      const hasMint = block.includes(`uses: ${GITHUB_APP_TOKEN_ACTION_REF}`);
      const hasInstallationToken = block.includes(
        RELEASE_APP_INSTALLATION_TOKEN_ENV,
      );
      const hasMintedOutput = block.includes(GITHUB_APP_TOKEN_OUTPUT);
      const hasAppCredential =
        block.includes(RELEASE_APP_ID_SECRET_REF) ||
        block.includes(RELEASE_APP_PRIVATE_KEY_SECRET_REF);
      if (contract === undefined) {
        if (
          hasMint ||
          hasInstallationToken ||
          hasMintedOutput ||
          hasAppCredential
        )
          return appTokenViolation(
            workflow.path,
            `${job.id} is not authorized to mint or receive an App token or protected App credential`,
          );
        continue;
      }
      if (job.environment !== contract.environment)
        return appTokenViolation(
          workflow.path,
          `${job.id} App credentials are not behind the exact ${contract.environment} environment gate`,
        );
      if (!hasMint)
        return appTokenViolation(
          workflow.path,
          `${job.id} must mint its App token with the pinned official action`,
        );
      if (!block.includes(RELEASE_APP_ID_SECRET_REF))
        return appTokenViolation(
          workflow.path,
          `${job.id} must read RELEASE_APP_ID from its protected environment`,
        );
      if (!block.includes(RELEASE_APP_PRIVATE_KEY_SECRET_REF))
        return appTokenViolation(
          workflow.path,
          `${job.id} must read RELEASE_APP_PRIVATE_KEY from its protected environment`,
        );
      const mintIndex = block.indexOf(`uses: ${GITHUB_APP_TOKEN_ACTION_REF}`);
      const outputIndex = block.indexOf(GITHUB_APP_TOKEN_OUTPUT);
      if (outputIndex < 0 || mintIndex < 0 || mintIndex >= outputIndex)
        return appTokenViolation(
          workflow.path,
          `${job.id} must use only the minted action output after the mint step`,
        );
      if (!block.includes(`id: release-app-token`))
        return appTokenViolation(
          workflow.path,
          `${job.id} must expose the pinned mint step as release-app-token`,
        );
      const requestedPermissions = readActionPermissions(block);
      if (!samePermissionMap(requestedPermissions, contract.permissions))
        return appTokenViolation(
          workflow.path,
          `${job.id} must request only its contracted App permissions`,
        );
      for (const match of block.matchAll(
        /^\s*(RELEASE_APP_INSTALLATION_TOKEN|GH_TOKEN):\s*(.+?)\s*$/gm,
      )) {
        const value = match[2];
        if (value === undefined || !value.includes(GITHUB_APP_TOKEN_OUTPUT))
          return appTokenViolation(
            workflow.path,
            `${job.id} must pass only the minted action output to its controller or gh step`,
          );
      }
      if (
        contract.condition !== undefined &&
        !block.includes(contract.condition)
      )
        return appTokenViolation(
          workflow.path,
          `${job.id} must keep its App mint behind ${contract.condition}`,
        );
    }

    for (const jobId of Object.keys(expectedJobs)) {
      const job = workflow.jobs.find((candidate) => candidate.id === jobId);
      if (job === undefined)
        return appTokenViolation(
          workflow.path,
          `${jobId} is missing from the App-token contract`,
        );
    }

    let outsideJobSource = source;
    for (const job of workflow.jobs) {
      const block = workflowJobBlock(workflow, job.id);
      if (block !== undefined)
        outsideJobSource = outsideJobSource.replace(block, "");
    }
    if (
      outsideJobSource.includes(GITHUB_APP_TOKEN_ACTION_REF) ||
      outsideJobSource.includes(RELEASE_APP_INSTALLATION_TOKEN_ENV) ||
      outsideJobSource.includes(GITHUB_APP_TOKEN_OUTPUT) ||
      outsideJobSource.includes(RELEASE_APP_ID_SECRET_REF) ||
      outsideJobSource.includes(RELEASE_APP_PRIVATE_KEY_SECRET_REF)
    )
      return appTokenViolation(
        workflow.path,
        "App token action, output, or protected credentials must stay inside an authorized job",
      );
  }
  return ok(undefined);
}

function appTokenViolation(
  origin: string,
  reason: string,
): Result<never, PublishReachabilityError> {
  return err({
    type: "PublishReachabilityViolation",
    kind: "CredentialBoundaryViolation",
    origin,
    target: RELEASE_APP_INSTALLATION_TOKEN_ENV,
    reason,
  });
}

function readActionPermissions(block: string): WorkflowPermissionMap {
  const permissions: Record<string, string> = {};
  for (const match of block.matchAll(
    /^\s+permission-([A-Za-z0-9-]+):\s*([^\s#]+)\s*$/gm,
  )) {
    const permission = match[1];
    const value = match[2];
    if (permission !== undefined && value !== undefined)
      permissions[permission] = value;
  }
  return permissions;
}

function workflowJobBlock(
  workflow: WorkflowShape,
  jobId: string,
): string | undefined {
  const lines = withoutYamlComments(workflow.text).split("\n");
  const start = lines.findIndex(
    (line) => line === `  ${jobId}:` || line.startsWith(`  ${jobId}: `),
  );
  if (start < 0) return undefined;
  return lines.slice(start, nextJobLine(lines, start + 1)).join("\n");
}

/** Alias used by CI and by external boundary tests. */
export const validatePhaseCSecurity = lintPhaseCSecurity;

/** Alias used by security checks that describe this as workflow security. */
export const lintWorkflowSecurity = lintPhaseCSecurity;

/** Alias used by CI and by external boundary tests. */
export const validateWorkflowPermissions = lintWorkflowPermissions;

export function assertStableWorkflowGraph(
  workflow: WorkflowShape,
): Result<void, PublishReachabilityError> {
  if (workflow.workflowCalls)
    return err({
      type: "PublishReachabilityViolation",
      kind: "WorkflowCallForbidden",
      origin: workflow.path,
      reason: "release-publish.yml must not declare workflow_call",
    });
  const actual = new Map(workflow.jobs.map((job) => [job.id, job.needs]));
  if (
    workflow.jobs.length !== STABLE_PUBLISH_CHAIN.length ||
    workflow.jobs.some(
      (job) => !(STABLE_PUBLISH_CHAIN as readonly string[]).includes(job.id),
    )
  )
    return err({
      type: "WorkflowPermissionViolation",
      path: workflow.path,
      reason: "stable workflow must contain exactly the ordered chain jobs",
    });
  for (const step of STABLE_PUBLISH_CHAIN) {
    const needs = actual.get(step);
    if (needs === undefined)
      return err({
        type: "WorkflowPermissionViolation",
        path: workflow.path,
        job: step,
        reason: `stable chain job ${step} is missing`,
      });
    const expected = STABLE_PUBLISH_CHAIN_NEEDS[step];
    if (JSON.stringify(needs) !== JSON.stringify(expected))
      return err({
        type: "WorkflowPermissionViolation",
        path: workflow.path,
        job: step,
        reason: `${step} needs must be ${expected.join(",") || "empty"}`,
      });
  }
  // Task 35's cutover moves the nightly cron onto the trusted workflow. The
  // schedule is allowed, but only as the exact single nightly cron: any other
  // or additional cron would widen the automatic entry into the publish chain.
  if (workflow.scheduled) {
    const crons = [
      ...withoutYamlComments(workflow.text).matchAll(
        /^\s*-\s*cron:\s*["']?([^"'\n]+?)["']?\s*$/gm,
      ),
    ].map((match) => match[1]);
    if (crons.length !== 1 || crons[0] !== CUTOVER_NIGHTLY_CRON)
      return err({
        type: "WorkflowPermissionViolation",
        path: workflow.path,
        reason: `trusted workflow schedule must be exactly "${CUTOVER_NIGHTLY_CRON}"`,
      });
  }
  if (!/pull_request\s*:/m.test(withoutYamlComments(workflow.text)))
    return err({
      type: "WorkflowPermissionViolation",
      path: workflow.path,
      reason: "stable workflow must trigger on pull_request",
    });
  if (!/workflow_dispatch\s*:/m.test(withoutYamlComments(workflow.text)))
    return err({
      type: "WorkflowPermissionViolation",
      path: workflow.path,
      reason: "stable workflow must trigger on workflow_dispatch",
    });
  return ok(undefined);
}

export const validateStableWorkflowGraph = assertStableWorkflowGraph;

export function assertAttestationWorkflowContract(
  workflow: WorkflowShape,
): Result<void, PublishReachabilityError> {
  if (workflow.path !== INDEPENDENT_ATTEST_WORKFLOW)
    return err({
      type: "WorkflowPermissionViolation",
      path: workflow.path,
      reason: "attestation contract applied to the wrong workflow",
    });
  if (workflow.workflowCalls)
    return err({
      type: "PublishReachabilityViolation",
      kind: "WorkflowCallForbidden",
      origin: workflow.path,
      reason: "the attestation workflow must not declare workflow_call",
    });
  const expected = {
    actions: "read",
    attestations: "write",
    checks: "write",
    contents: "read",
    "id-token": "write",
  } as const;
  if (
    workflow.rootPermissions === null ||
    Object.keys(workflow.rootPermissions).length !== 0 ||
    workflow.jobs.length !== 1 ||
    workflow.jobs[0]?.id !== "attest" ||
    !samePermissionMap(
      workflow.jobs[0]?.permissions ?? EMPTY_PERMISSIONS,
      expected,
    )
  )
    return err({
      type: "WorkflowPermissionViolation",
      path: workflow.path,
      job: "attest",
      reason:
        "attestation workflow does not match its exact permission contract",
    });
  return ok(undefined);
}

export function scanReleaseCommands(
  origin: string,
  command: string,
  workflowOrigin: string | undefined,
): Result<void, PublishReachabilityError> {
  const cleaned = withoutShellComments(command);
  if (/\bnpm\s+deprecate\b/.test(cleaned))
    return err({
      type: "DeprecateInvocationDetected",
      origin,
      command: cleaned,
    });
  if (cleaned.includes(INCIDENT_SEAM_PATH))
    return err({
      type: "FixtureSeamReachability",
      origin,
      target: INCIDENT_SEAM_PATH,
    });
  if (cleaned.includes(INCIDENT_INTEGRATION_TEST))
    return err({ type: "IntegrationTestInvocation", origin });
  if (/\bnpm\s+publish\b/.test(cleaned))
    return err({
      type: "PublishReachabilityViolation",
      kind: "DirectPublishInvocation",
      origin,
      reason:
        "workflows and package scripts must invoke publish-main, not npm publish directly",
    });
  void workflowOrigin;
  return ok(undefined);
}

/** Scan all commands in a parsed workflow, including block scalar runs. */
export function scanWorkflowCommands(
  workflow: WorkflowShape,
): Result<void, PublishReachabilityError> {
  for (const job of workflow.jobs) {
    for (const command of job.runs) {
      const checked = scanReleaseCommands(
        `${workflow.path}#${job.id}`,
        command,
        workflow.path,
      );
      if (checked.isErr()) return checked;
    }
  }
  return ok(undefined);
}

/**
 * Reject credential names which would bypass trusted publishing or provide a
 * subscription/OAuth session to an AI or harness job. Shell guards that only
 * inspect inherited state are intentionally not env assignments and remain
 * valid in the legacy publisher workflow.
 */
function lintWorkflowCredentialBoundaries(
  workflows: readonly WorkflowShape[],
): Result<void, PublishReachabilityError> {
  for (const workflow of workflows) {
    const source = withoutYamlComments(workflow.text);
    if (/^\s*pull_request_target\s*:/m.test(source))
      return err({
        type: "PublishReachabilityViolation",
        kind: "PullRequestTargetForbidden",
        origin: workflow.path,
        reason: "CI must not use pull_request_target",
      });

    for (const match of source.matchAll(
      /^\s*(?:"([A-Za-z_][A-Za-z0-9_-]*)"|'([A-Za-z_][A-Za-z0-9_-]*)'|([A-Za-z_][A-Za-z0-9_-]*))\s*:/gm,
    )) {
      const name = match[1] ?? match[2] ?? match[3];
      if (name === undefined) continue;
      const reason = credentialBoundaryViolation(name);
      if (reason !== undefined)
        return err({
          type: "PublishReachabilityViolation",
          kind: "CredentialBoundaryViolation",
          origin: workflow.path,
          target: name,
          reason,
        });
    }

    for (const match of source.matchAll(
      /\b(secrets|vars)\.([A-Za-z_][A-Za-z0-9_-]*)\b/g,
    )) {
      const namespace = match[1];
      const name = match[2];
      if (namespace === undefined || name === undefined) continue;
      const reason = credentialBoundaryViolation(name);
      if (reason !== undefined)
        return err({
          type: "PublishReachabilityViolation",
          kind: "CredentialBoundaryViolation",
          origin: workflow.path,
          target: `${namespace}.${name}`,
          reason,
        });
    }
  }
  return ok(undefined);
}

const ALLOWED_SERVICE_CREDENTIAL_NAMES = new Set([
  "EVAL_RESULTS_REPO_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "RELEASE_APP_INSTALLATION_TOKEN",
]);

function credentialBoundaryViolation(name: string): string | undefined {
  const normalized = name.toUpperCase();
  if (ALLOWED_SERVICE_CREDENTIAL_NAMES.has(normalized)) return undefined;
  if (
    normalized === "NPM_TOKEN" ||
    normalized === "NODE_AUTH_TOKEN" ||
    normalized.startsWith("NPM_CONFIG_") ||
    /^(?:NPM|NODE_AUTH)(?:_|$).*(?:TOKEN|AUTH|CREDENTIAL|PASSWORD|SECRET)/.test(
      normalized,
    ) ||
    normalized.includes("CREDENTIAL_HELPER") ||
    normalized.includes("KEYCHAIN")
  )
    return "npm credentials and credential helpers are forbidden in CI";
  if (
    normalized.includes("OAUTH") ||
    normalized.includes("SUBSCRIPTION") ||
    normalized.includes("REFRESH_TOKEN") ||
    normalized.includes("SESSION_TOKEN")
  )
    return "OAuth, subscription, refresh-token, and persisted-session authentication are forbidden in CI";
  if (
    /(?:^|_)(?:AI|OPENAI|ANTHROPIC|CLAUDE|OPENCODE|OPENROUTER|HARNESS|PI)(?:_|$)/.test(
      normalized,
    ) &&
    /(?:TOKEN|CREDENTIAL|SESSION|AUTH|SECRET|PASSWORD|KEY)/.test(normalized) &&
    !normalized.endsWith("_API_KEY")
  )
    return "AI and harness authentication must use an API key, not a token or session";
  return undefined;
}

export interface ModuleReachability {
  readonly files: readonly string[];
  readonly reachedPublishExecutor: boolean;
  readonly reachedPublishEntrypoint: boolean;
  /** Test-only mutation seams are never valid production dependencies. */
  readonly reachedIncidentSeam?: boolean;
  readonly reachedIncidentIntegrationTest?: boolean;
}

/** Walk relative TS imports and dynamic/spawn edges from one entrypoint. */
export async function walkModuleGraph(
  root: string,
  entry: string,
): Promise<Result<ModuleReachability, PublishReachabilityError>> {
  const queue = [resolve(root, entry)];
  const seen = new Set<string>();
  let reachedPublishExecutor = false;
  let reachedPublishEntrypoint = false;
  let reachedIncidentSeam = false;
  let reachedIncidentIntegrationTest = false;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    const normalized = resolve(current);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (seen.size > MAX_MODULES)
      return err({ type: "ReachabilityBoundExceeded", bound: "module graph" });
    const text = await readText(normalized);
    if (text.isErr()) return err(text.error);
    const relativePath = posixPath(relative(root, normalized));
    if (relativePath === PUBLISH_EXECUTOR_MODULE) reachedPublishExecutor = true;
    if (relativePath === PUBLISH_ENTRYPOINT) reachedPublishEntrypoint = true;
    if (
      relativePath === INCIDENT_INTEGRATION_TEST ||
      relativePath.endsWith(`/${INCIDENT_INTEGRATION_TEST}`)
    )
      reachedIncidentIntegrationTest = true;
    if (
      relativePath === INCIDENT_SEAM_PATH ||
      relativePath.startsWith(`${INCIDENT_SEAM_PATH}/`)
    )
      reachedIncidentSeam = true;
    if (isTestOnlyRoot(relativePath)) continue;
    for (const specifier of relativeModuleSpecifiers(text.value)) {
      const target = resolveModuleSpecifier(root, normalized, specifier);
      if (target !== undefined) queue.push(target);
    }
    for (const spawned of spawnedReleasePaths(text.value)) {
      const target = resolveDiscoveredPath(
        root,
        dirname(relativePath),
        spawned,
      );
      if (target !== undefined) queue.push(resolve(root, target));
    }
  }
  return ok({
    files: [...seen].map((file) => posixPath(relative(root, file))),
    reachedPublishExecutor,
    reachedPublishEntrypoint,
    reachedIncidentSeam,
    reachedIncidentIntegrationTest,
  });
}

export async function analyzePublishReachability(
  root: string,
): Promise<Result<PublishReachabilityReport, PublishReachabilityError>> {
  const workflows = await readWorkflowShapes(root);
  if (workflows.isErr()) return err(workflows.error);
  const permissionLint = lintWorkflowPermissions(workflows.value);
  if (permissionLint.isErr()) return err(permissionLint.error);
  const phaseCSecurityLint = lintPhaseCSecurity(workflows.value);
  if (phaseCSecurityLint.isErr()) return err(phaseCSecurityLint.error);
  const stable = workflows.value.find(
    (workflow) => workflow.path === TRUSTED_PUBLISH_WORKFLOW,
  );
  if (stable === undefined)
    return err({
      type: "WorkflowPermissionViolation",
      path: TRUSTED_PUBLISH_WORKFLOW,
      reason: "trusted workflow is missing",
    });
  const stableGraph = assertStableWorkflowGraph(stable);
  if (stableGraph.isErr()) return err(stableGraph.error);
  for (const workflow of workflows.value) {
    const commandLint = scanWorkflowCommands(workflow);
    if (commandLint.isErr()) return err(commandLint.error);
  }

  const manifests = await readPackageManifests(root);
  if (manifests.isErr()) return err(manifests.error);
  const invocations: { origin: string; command: string; target: string }[] = [];
  const publishOrigins: string[] = [];
  const packageScripts = collectPackageScripts(manifests.value);
  const visitedAliases = new Set<string>();
  for (const scripts of packageScripts.values()) {
    for (const script of scripts) {
      const commandLint = scanReleaseCommands(
        script.source,
        script.command,
        undefined,
      );
      if (commandLint.isErr()) return err(commandLint.error);
    }
  }

  for (const workflow of workflows.value) {
    const workflowRoot = workflow.path;
    for (const job of workflow.jobs) {
      for (const command of job.runs) {
        const commandResult = await inspectCommand(
          root,
          command,
          `${workflowRoot}#${job.id}`,
          workflowRoot,
          packageScripts,
          visitedAliases,
        );
        if (commandResult.isErr()) return err(commandResult.error);
        invocations.push(...commandResult.value.invocations);
        publishOrigins.push(...commandResult.value.publishOrigins);
      }
      for (const localUse of job.localUses) {
        const actionResult = await inspectLocalUse(
          root,
          localUse,
          `${workflow.path}#${job.id}`,
          workflow.path,
          packageScripts,
          visitedAliases,
        );
        if (actionResult.isErr()) return err(actionResult.error);
        invocations.push(...actionResult.value.invocations);
        publishOrigins.push(...actionResult.value.publishOrigins);
      }
    }
  }

  const inventory = await discoverProductionReleaseEntrypoints(root);
  if (inventory.isErr()) return err(mapInventoryError(inventory.error));

  // Inventory roots are part of the semantic graph. A second root that imports
  // the executor is forbidden even if no current workflow happens to invoke it.
  for (const entry of inventory.value.roots) {
    if (
      !entry.path.startsWith("scripts/release/") ||
      isTestOnlyRoot(entry.path)
    )
      continue;
    const graph = await walkModuleGraph(root, entry.path);
    if (graph.isErr()) return err(graph.error);
    if (graph.value.reachedPublishExecutor && entry.path !== PUBLISH_ENTRYPOINT)
      return err({
        type: "PublishReachabilityViolation",
        kind: "SecondPublishEntrypoint",
        origin: entry.path,
        target: PUBLISH_EXECUTOR_MODULE,
        reason: "only publish-main may import the publication executor",
      });
    if (graph.value.reachedIncidentSeam)
      return err({
        type: "FixtureSeamReachability",
        origin: entry.path,
        target: INCIDENT_SEAM_PATH,
      });
    if (graph.value.reachedIncidentIntegrationTest)
      return err({
        type: "IntegrationTestInvocation",
        origin: entry.path,
      });
  }

  for (const origin of publishOrigins) {
    if (origin !== TRUSTED_PUBLISH_WORKFLOW)
      return err({
        type: "PublishReachabilityViolation",
        kind: "AlternatePublishInvocation",
        origin,
        target: PUBLISH_ENTRYPOINT,
        reason: "only release-publish.yml may invoke publish-main",
      });
  }
  if (
    workflows.value.some(
      (workflow) =>
        workflow.path === INDEPENDENT_ATTEST_WORKFLOW &&
        workflow.jobs.some((job) =>
          job.runs.some((run) => run.includes(PUBLISH_ENTRYPOINT)),
        ),
    )
  )
    return err({
      type: "PublishReachabilityViolation",
      kind: "AttestationPublishReachability",
      origin: INDEPENDENT_ATTEST_WORKFLOW,
      target: PUBLISH_ENTRYPOINT,
      reason: "independent attestation cannot reach publish-main",
    });

  return ok({
    workflows: workflows.value,
    invocations,
    publishOrigins: [...new Set(publishOrigins)],
    inventoryRoots: inventory.value.roots,
  });
}

export const checkPublishReachability = analyzePublishReachability;
export const validatePublishReachability = analyzePublishReachability;

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../..");
  const result = await analyzePublishReachability(root);
  if (result.isErr()) process.exitCode = 1;
}

interface CommandInspection {
  readonly invocations: readonly {
    origin: string;
    command: string;
    target: string;
  }[];
  readonly publishOrigins: readonly string[];
}

interface LocalExecutionShape {
  readonly runs: readonly string[];
  readonly localUses: readonly string[];
}

async function inspectLocalUse(
  root: string,
  use: string,
  origin: string,
  workflowOrigin: string,
  packageScripts: ReadonlyMap<
    string,
    readonly { name: string; command: string; source: string }[]
  >,
  visitedAliases: Set<string>,
  seenUses = new Set<string>(),
  depth = 0,
): Promise<Result<CommandInspection, PublishReachabilityError>> {
  if (depth >= MAX_LOCAL_USE_DEPTH)
    return err({
      type: "ReachabilityBoundExceeded",
      bound: "local action graph",
    });
  const actionFiles = await localActionFiles(root, use);
  if (actionFiles.isErr()) return err(actionFiles.error);
  const invocations: { origin: string; command: string; target: string }[] = [];
  const publishOrigins: string[] = [];
  for (const action of actionFiles.value) {
    const relativeAction = posixPath(relative(root, action));
    if (seenUses.has(relativeAction)) continue;
    seenUses.add(relativeAction);
    const actionText = await readText(action);
    if (actionText.isErr()) return err(actionText.error);
    const execution = parseLocalExecutionShape(actionText.value);
    const actionOrigin = `${origin}->${relativeAction}`;
    for (const command of execution.runs) {
      const commandResult = await inspectCommand(
        root,
        command,
        actionOrigin,
        workflowOrigin,
        packageScripts,
        visitedAliases,
      );
      if (commandResult.isErr()) return err(commandResult.error);
      invocations.push(...commandResult.value.invocations);
      publishOrigins.push(...commandResult.value.publishOrigins);
    }
    for (const nestedUse of execution.localUses) {
      const nested = await inspectLocalUse(
        root,
        nestedUse,
        actionOrigin,
        workflowOrigin,
        packageScripts,
        visitedAliases,
        seenUses,
        depth + 1,
      );
      if (nested.isErr()) return err(nested.error);
      invocations.push(...nested.value.invocations);
      publishOrigins.push(...nested.value.publishOrigins);
    }
  }
  return ok({ invocations, publishOrigins });
}

function parseLocalExecutionShape(text: string): LocalExecutionShape {
  const workflow = parseWorkflowShape("local-action", text);
  if (workflow.isOk() && workflow.value.jobs.length > 0) {
    return {
      runs: workflow.value.jobs.flatMap((job) => job.runs),
      localUses: workflow.value.jobs.flatMap((job) => job.localUses),
    };
  }
  const lines = withoutYamlComments(text).split("\n");
  const runs: string[] = [];
  const localUses: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const runMatch = line.match(/^\s*(?:-\s*)?run:\s*(.*)$/);
    if (runMatch !== null) {
      const value = runMatch[1] ?? "";
      if (["|", ">", "|-", ">-"].includes(value)) {
        const block: string[] = [];
        for (let next = index + 1; next < lines.length; next += 1) {
          const body = lines[next] ?? "";
          if (body.trim().length > 0 && indentation(body) <= indentation(line))
            break;
          if (body.trim().length > 0) block.push(body.trim());
          index = next;
        }
        runs.push(block.join("\n"));
      } else runs.push(unquoteYaml(value));
    }
    const usesMatch = line.match(/^\s*(?:-\s*)?uses:\s*(.*)$/);
    if (usesMatch !== null) {
      const value = unquoteYaml(usesMatch[1] ?? "");
      if (value.startsWith("./")) localUses.push(value.slice(2));
    }
  }
  return { runs, localUses };
}

async function inspectCommand(
  root: string,
  command: string,
  origin: string,
  workflowOrigin: string,
  packageScripts: ReadonlyMap<
    string,
    readonly { name: string; command: string; source: string }[]
  >,
  visitedAliases: Set<string>,
): Promise<Result<CommandInspection, PublishReachabilityError>> {
  const lint = scanReleaseCommands(origin, command, workflowOrigin);
  if (lint.isErr()) return err(lint.error);
  const invocations: { origin: string; command: string; target: string }[] = [];
  const publishOrigins: string[] = [];
  const paths = scriptCommandPaths(withoutShellComments(command));
  for (const path of paths) {
    const normalized = normalizeReleasePath(path);
    if (normalized === undefined) continue;
    invocations.push({ origin, command, target: normalized });
    const graph = await walkModuleGraph(root, normalized);
    if (graph.isErr()) return err(graph.error);
    if (graph.value.reachedPublishExecutor) {
      if (normalized !== PUBLISH_ENTRYPOINT)
        return err({
          type: "PublishReachabilityViolation",
          kind: "SecondPublishEntrypoint",
          origin,
          target: normalized,
          reason: "a non-publish entrypoint reaches the publication executor",
        });
      publishOrigins.push(workflowOrigin);
    }
    if (normalized === PUBLISH_ENTRYPOINT) publishOrigins.push(workflowOrigin);
  }
  for (const alias of scriptAliases(withoutShellComments(command))) {
    const key = `${origin}:${alias}`;
    if (visitedAliases.has(key)) continue;
    visitedAliases.add(key);
    const entries = packageScripts.get(alias) ?? [];
    for (const script of entries) {
      const nested = await inspectCommand(
        root,
        script.command,
        `${script.source} (via ${origin})`,
        workflowOrigin,
        packageScripts,
        visitedAliases,
      );
      if (nested.isErr()) return err(nested.error);
      invocations.push(...nested.value.invocations);
      publishOrigins.push(...nested.value.publishOrigins);
    }
  }
  return ok({ invocations, publishOrigins });
}

async function readWorkflowShapes(
  root: string,
): Promise<Result<readonly WorkflowShape[], PublishReachabilityError>> {
  const files = await Array.fromAsync(
    new Bun.Glob(".github/workflows/*.{yml,yaml}").scan({
      cwd: root,
      onlyFiles: true,
    }),
  );
  const shapes: WorkflowShape[] = [];
  for (const file of files.sort()) {
    const path = posixPath(file);
    const text = await readText(resolve(root, file));
    if (text.isErr()) return err(text.error);
    const shape = parseWorkflowShape(path, text.value);
    if (shape.isErr()) return err(shape.error);
    shapes.push(shape.value);
  }
  return ok(shapes);
}

async function readPackageManifests(
  root: string,
): Promise<
  Result<
    readonly { path: string; value: Record<string, unknown> }[],
    PublishReachabilityError
  >
> {
  const files = ["package.json"];
  const workspaceManifest = await readJson(resolve(root, "package.json"));
  if (workspaceManifest.isErr()) return err(workspaceManifest.error);
  const workspaces = workspaceManifest.value.workspaces;
  let patterns: string[] = [];
  if (Array.isArray(workspaces)) {
    patterns = workspaces.filter(
      (value): value is string => typeof value === "string",
    );
  } else if (
    workspaces !== null &&
    typeof workspaces === "object" &&
    Array.isArray((workspaces as { packages?: unknown }).packages)
  ) {
    patterns = (workspaces as { packages: string[] }).packages;
  }
  for (const pattern of patterns) {
    const glob = pattern.endsWith("/*")
      ? `${pattern.slice(0, -2)}/*/package.json`
      : `${pattern}/package.json`;
    for (const match of await Array.fromAsync(
      new Bun.Glob(glob).scan({ cwd: root, onlyFiles: true }),
    ))
      files.push(match);
  }
  const result: { path: string; value: Record<string, unknown> }[] = [];
  for (const file of [...new Set(files)].sort()) {
    const value =
      file === "package.json"
        ? workspaceManifest
        : await readJson(resolve(root, file));
    if (value.isErr()) return err(value.error);
    result.push({ path: posixPath(file), value: value.value });
  }
  return ok(result);
}

function collectPackageScripts(
  manifests: readonly { path: string; value: Record<string, unknown> }[],
): Map<string, readonly { name: string; command: string; source: string }[]> {
  const map = new Map<
    string,
    { name: string; command: string; source: string }[]
  >();
  for (const manifest of manifests) {
    const scripts = manifest.value.scripts;
    if (
      scripts === null ||
      typeof scripts !== "object" ||
      Array.isArray(scripts)
    )
      continue;
    for (const [name, value] of Object.entries(
      scripts as Record<string, unknown>,
    )) {
      if (typeof value !== "string" || isTestScript(name, value)) continue;
      const current = map.get(name) ?? [];
      current.push({
        name,
        command: value,
        source: `${manifest.path}#scripts.${name}`,
      });
      map.set(name, current);
    }
  }
  return map;
}

async function localActionFiles(
  root: string,
  use: string,
): Promise<Result<readonly string[], PublishReachabilityError>> {
  const candidate = resolve(root, use.replace(/^\.\//, ""));
  const rootPath = resolve(root);
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}/`))
    return err({
      type: "WorkflowReadFailed",
      path: candidate,
      reason: "local workflow/action reference escapes the repository",
    });
  const paths = /\.(?:yml|yaml)$/.test(candidate)
    ? [candidate]
    : [join(candidate, "action.yml"), join(candidate, "action.yaml")];
  const found: string[] = [];
  for (const path of paths) {
    if (await Bun.file(path).exists()) found.push(path);
  }
  if (found.length === 0)
    return err({
      type: "WorkflowReadFailed",
      path: candidate,
      reason: "local workflow/action reference does not exist",
    });
  return ok([...new Set(found)]);
}

function parseJob(
  id: string,
  lines: readonly string[],
  start: number,
  end: number,
): WorkflowJobShape {
  let needs: string[] = [];
  let permissions: WorkflowPermissionMap = {};
  let environment: string | null = null;
  const runs: string[] = [];
  const localUses: string[] = [];
  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? "";
    const needsMatch = line.match(/^ {4}needs:\s*(.*)$/);
    if (needsMatch !== null) needs = parseListValue(needsMatch[1] ?? "");
    const permissionsMatch = line.match(/^ {4}permissions:\s*(.*)$/);
    if (permissionsMatch !== null) {
      permissions = parsePermissionValue(
        permissionsMatch[1] ?? "",
        lines,
        index + 1,
        end,
        6,
      );
    }
    const environmentMatch = line.match(/^ {4}environment:\s*(.*)$/);
    if (environmentMatch !== null)
      environment = unquoteYaml((environmentMatch[1] ?? "").trim());
    const runMatch = line.match(/^\s*(?:-\s*)?run:\s*(.*)$/);
    if (runMatch !== null) {
      const value = runMatch[1] ?? "";
      if (value === "|" || value === ">" || value === "|-" || value === ">-") {
        const block: string[] = [];
        for (let next = index + 1; next < end; next += 1) {
          const body = lines[next] ?? "";
          if (body.trim().length > 0 && indentation(body) <= indentation(line))
            break;
          if (body.trim().length > 0) block.push(body.trim());
          index = next;
        }
        runs.push(block.join("\n"));
      } else runs.push(unquoteYaml(value));
    }
    const usesMatch = line.match(/^\s*(?:-\s*)?uses:\s*(.*)$/);
    if (usesMatch !== null) {
      const value = unquoteYaml(usesMatch[1] ?? "");
      if (value.startsWith("./")) localUses.push(value.slice(2));
    }
  }
  return { id, needs, permissions, environment, runs, localUses };
}

function readRootPermissions(
  lines: readonly string[],
  jobsLine: number,
): WorkflowPermissionMap | null {
  const limit = jobsLine < 0 ? lines.length : jobsLine;
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(/^permissions:\s*(.*)$/);
    if (match === null) continue;
    return parsePermissionValue(match[1] ?? "", lines, index + 1, limit, 2);
  }
  return null;
}

function parsePermissionValue(
  inline: string,
  lines: readonly string[],
  start: number,
  end: number,
  childIndent: number,
): WorkflowPermissionMap {
  const value = inline.trim();
  if (value === "{}") return {};
  if (value.length > 0 && value.startsWith("{")) {
    const result: Record<string, string> = {};
    for (const item of value.replace(/[{}]/g, "").split(",")) {
      const [key, permission] = item.split(":").map((part) => part.trim());
      if (key !== undefined && permission !== undefined && key.length > 0)
        result[key] = unquoteYaml(permission);
    }
    return result;
  }
  const result: Record<string, string> = {};
  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    if (indentation(line) < childIndent) break;
    if (indentation(line) !== childIndent) continue;
    const match = line.match(/^\s*([A-Za-z0-9-]+):\s*([^\s#]+)\s*$/);
    if (match?.[1] !== undefined && match[2] !== undefined)
      result[match[1]] = unquoteYaml(match[2]);
  }
  if (value.length > 0) result.__invalid__ = unquoteYaml(value);
  else if (Object.keys(result).length === 0) result.__invalid__ = "missing-map";
  return result;
}

function nextJobLine(lines: readonly string[], start: number): number {
  for (let index = start; index < lines.length; index += 1)
    if (/^ {2}[A-Za-z0-9_.-]+:\s*$/.test(lines[index] ?? "")) return index;
  return lines.length;
}

function parseListValue(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("["))
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  return trimmed.length === 0 ? [] : [unquoteYaml(trimmed)];
}

export function relativeModuleSpecifiers(text: string): readonly string[] {
  const found: string[] = [];
  const regex =
    /(?:import|export)\s+([\s\S]*?)\s+from\s+["'](\.[^"']+)["']|\bimport\s*["'](\.[^"']+)["']|\bimport\(\s*["'](\.[^"']+)["']\s*\)|\brequire\(\s*["'](\.[^"']+)["']\s*\)/g;
  for (const match of text.matchAll(regex)) {
    const full = match[0] ?? "";
    const specifier = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (specifier === undefined || /\b(?:import|export)\s+type\b/.test(full))
      continue;
    found.push(specifier);
  }
  return [...new Set(found)];
}

function spawnedReleasePaths(text: string): readonly string[] {
  const found: string[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/\b(?:Bun\.)?(?:spawn|spawnSync|exec|execFile)\b/.test(line)) continue;
    const window = lines.slice(index, index + 12).join("\n");
    for (const match of window.matchAll(
      /["']((?:\.\.\/|\.\/)*scripts\/release\/[A-Za-z0-9._/-]+\.ts)["']/g,
    )) {
      if (match[1] !== undefined) found.push(match[1]);
    }
  }
  return [...new Set(found)];
}

export function resolveModuleSpecifier(
  root: string,
  from: string,
  specifier: string,
): string | undefined {
  const candidate = resolve(dirname(from), specifier);
  const base = candidate.replace(/\.(?:mjs|cjs|js|jsx|tsx|ts)$/, "");
  const options = [
    candidate,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, "index.ts"),
  ];
  const rootPath = resolve(root);
  return options.find(
    (path) =>
      (path === rootPath || path.startsWith(`${rootPath}/`)) &&
      Bun.file(path).size !== 0,
  );
}

function resolveDiscoveredPath(
  root: string,
  directory: string,
  path: string,
): string | undefined {
  const candidate = path.startsWith(".")
    ? resolve(root, directory, path)
    : resolve(root, path);
  const relativePath = posixPath(relative(root, candidate));
  return relativePath.startsWith("..") ? undefined : relativePath;
}

function normalizeReleasePath(path: string): string | undefined {
  const normalized = path.replace(/^\.\//, "");
  return normalized.startsWith("scripts/release/") && normalized.endsWith(".ts")
    ? normalized
    : undefined;
}

function indentation(line: string): number {
  return line.match(/^\s*/)?.[0]?.length ?? 0;
}

function unquoteYaml(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function withoutYamlComments(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trimStart().startsWith("#") ? "" : line))
    .join("\n");
}

function withoutShellComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const index = line.indexOf(" #");
      return index >= 0 ? line.slice(0, index) : line;
    })
    .join("\n");
}

function isTestScript(name: string, command: string): boolean {
  return (
    /^(test|check|lint)(:|$)/.test(name) ||
    /\bbun\s+(?:x\s+)?test\b/.test(command)
  );
}

function samePermissionMap(
  actual: WorkflowPermissionMap,
  expected: WorkflowPermissionMap,
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => actual[key] === expected[key])
  );
}

function posixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function readText(
  path: string,
): Promise<Result<string, PublishReachabilityError>> {
  return ResultAsync.fromThrowable(
    () => Bun.file(path).text(),
    (cause): PublishReachabilityError => ({
      type: "ModuleReadFailed",
      path,
      reason: String(cause),
    }),
  )();
}

async function readJson(
  path: string,
): Promise<Result<Record<string, unknown>, PublishReachabilityError>> {
  const text = await readText(path);
  if (text.isErr())
    return err({
      type: "WorkflowReadFailed",
      path,
      reason: String(text.error),
    });
  const parsed = Result.fromThrowable(
    () => JSON.parse(text.value) as unknown,
    (cause): PublishReachabilityError => ({
      type: "WorkflowReadFailed",
      path,
      reason: String(cause),
    }),
  )();
  if (parsed.isErr()) return err(parsed.error);
  if (
    parsed.value === null ||
    typeof parsed.value !== "object" ||
    Array.isArray(parsed.value)
  )
    return err({
      type: "WorkflowReadFailed",
      path,
      reason: "manifest must be an object",
    });
  return ok(parsed.value as Record<string, unknown>);
}

function mapInventoryError(
  error: EntrypointInventoryError,
): PublishReachabilityError {
  return error;
}
