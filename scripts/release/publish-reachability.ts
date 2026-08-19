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
  RELEASE_ATTEST_WORKFLOW_PATH,
  RELEASE_PUBLISH_WORKFLOW_PATH,
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

/** Existing pre-cutover identities. They are named policy exceptions, not a
 * permission wildcard. Task 35 removes the old publisher exception. */
export const ALLOWED_UNRELATED_ID_TOKEN_WORKFLOWS = new Set([
  ".github/workflows/publish.yml",
  ".github/workflows/deploy-docs.yml",
]);

export type WorkflowPermissionMap = Readonly<Record<string, string>>;

export interface WorkflowJobShape {
  readonly id: string;
  readonly needs: readonly string[];
  readonly permissions: WorkflowPermissionMap;
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
  if (workflow.scheduled)
    return err({
      type: "WorkflowPermissionViolation",
      path: workflow.path,
      reason: "Task 25 trusted workflow must not declare a schedule trigger",
    });
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
  return { id, needs, permissions, runs, localUses };
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
