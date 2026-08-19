/**
 * Runtime gate for the release workflow.
 *
 * A route is safe only when the checked-in rollout declaration, the external
 * RELEASE_ROLLOUT_MODE value, and the observed workflow topology agree. This
 * module performs no build, proof, OIDC, npm, or GitHub mutation.
 */
import { resolve } from "node:path";
import {
  err,
  ok,
  type Result,
  ResultAsync,
  type ResultAsync as ResultAsyncType,
} from "neverthrow";
import { z } from "zod";
import {
  RELEASE_CONTROL_REF,
  RELEASE_PUBLISH_WORKFLOW_PATH,
  RELEASE_REPOSITORY,
} from "./constants.js";
import {
  parseReleaseRolloutMode,
  ROLLOUT_STAGE_DECLARATION,
  type RolloutTuple,
  type RolloutTupleError,
  validateRolloutTuple,
  validateWorkflowTopology,
  type WorkflowTopology,
} from "./rollout-stage.js";

export const STABLE_ROUTE_CHANNELS = [
  "stable-merge",
  "stable-resume",
  "incident-resolution",
] as const;
export type StableRouteChannel = (typeof STABLE_ROUTE_CHANNELS)[number];

const FULL_SHA = /^[0-9a-f]{40}$/;
const RepoSchema = z.literal(RELEASE_REPOSITORY);
const _RefSchema = z.literal(RELEASE_CONTROL_REF);

const PullRequestRouteSchema = z
  .object({
    number: z.number().int().positive(),
    action: z.literal("closed"),
    merged: z.boolean(),
    baseRef: z.literal("main"),
    baseRepository: RepoSchema,
    labels: z.array(z.string().min(1).max(128)),
    mergeCommitSha: z.string().regex(FULL_SHA).nullable(),
  })
  .strict();

export const StableRouteEventSchema = z
  .object({
    repository: RepoSchema,
    eventName: z.enum(["pull_request", "workflow_dispatch", "schedule"]),
    action: z.string().min(1).max(64),
    ref: z.string().min(1).max(256),
    actor: z.string().min(1).max(128),
    maintainerAuthorized: z.boolean().optional(),
    channel: z.string().optional(),
    releasedSha: z.string().regex(FULL_SHA).optional(),
    pullRequest: PullRequestRouteSchema.nullable(),
  })
  .strict();

export type StableRouteEvent = z.infer<typeof StableRouteEventSchema>;

export type RolloutGateError =
  | { type: "InvalidStableRoute"; issues: readonly string[] }
  | { type: "WrongRepository"; repository: string }
  | { type: "WrongMainLineage"; reason: string }
  | { type: "UnauthorizedStableRoute"; actor: string }
  | { type: "UnsupportedReleaseEvent"; eventName: string }
  | { type: "UnsupportedReleaseChannel"; channel: string }
  | { type: "RolloutDisabled"; channel: StableRouteChannel }
  | {
      type: "RolloutInvalidState";
      reason: string;
      stage?: string;
      mode?: string;
    }
  | {
      type: "InvalidRolloutTopology";
      issues: readonly string[];
    };

export interface StableRoute {
  readonly channel: StableRouteChannel;
  readonly eventName: "pull_request" | "workflow_dispatch";
  readonly merged: boolean;
  readonly releasedSha: string | null;
  readonly pullRequestNumber: number | null;
  readonly markerCleanupRequired: boolean;
}

export interface RolloutDecision {
  readonly tuple: RolloutTuple;
  readonly work: boolean;
  readonly publish: boolean;
  readonly outcome: "ready" | "dry-run" | "RolloutDisabled";
}

export interface GuardedStableRoute extends StableRoute {
  readonly rollout: RolloutDecision;
}

/**
 * Validates the event and its main lineage before reading a plan or touching a
 * marker. Closed unmerged PRs are valid cleanup-only routes.
 */
export function validateStableRouteEvent(
  input: unknown,
): Result<StableRoute, RolloutGateError> {
  const parsed = StableRouteEventSchema.safeParse(input);
  if (!parsed.success)
    return err({
      type: "InvalidStableRoute",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  const event = parsed.data;
  if (event.repository !== RELEASE_REPOSITORY)
    return err({ type: "WrongRepository", repository: event.repository });

  if (event.eventName === "pull_request") {
    if (event.action !== "closed")
      return err({
        type: "UnsupportedReleaseEvent",
        eventName: `${event.eventName}:${event.action}`,
      });
    if (event.pullRequest === null)
      return err({
        type: "WrongMainLineage",
        reason: "pull_request route requires a pull request payload",
      });
    if (event.ref !== `refs/pull/${event.pullRequest.number}/merge`)
      return err({
        type: "WrongMainLineage",
        reason: "closed pull request route must use its merge ref",
      });
    if (event.channel !== undefined && event.channel.length > 0)
      return err({
        type: "UnsupportedReleaseChannel",
        channel: event.channel,
      });
    if (!event.pullRequest.labels.includes("release:stable"))
      return err({
        type: "UnsupportedReleaseChannel",
        channel: "pull_request without release:stable",
      });
    if (event.pullRequest.merged && event.pullRequest.mergeCommitSha === null)
      return err({
        type: "WrongMainLineage",
        reason: "merged release PR has no merge commit SHA",
      });
    if (event.pullRequest.merged && event.pullRequest.mergeCommitSha !== null)
      return ok({
        channel: "stable-merge",
        eventName: "pull_request",
        merged: true,
        releasedSha: event.pullRequest.mergeCommitSha,
        pullRequestNumber: event.pullRequest.number,
        markerCleanupRequired: true,
      });
    return ok({
      channel: "stable-merge",
      eventName: "pull_request",
      merged: false,
      releasedSha: null,
      pullRequestNumber: event.pullRequest.number,
      markerCleanupRequired: true,
    });
  }

  if (event.action !== "workflow_dispatch")
    return err({
      type: "UnsupportedReleaseEvent",
      eventName: `${event.eventName}:${event.action}`,
    });
  if (event.ref !== RELEASE_CONTROL_REF)
    return err({
      type: "WrongMainLineage",
      reason: `workflow route must run on ${RELEASE_CONTROL_REF}`,
    });
  if (event.eventName === "schedule")
    return err({
      type: "UnsupportedReleaseEvent",
      eventName: event.eventName,
    });
  const channel = event.channel;
  if (channel !== "stable-resume" && channel !== "incident-resolution")
    return err({
      type: "UnsupportedReleaseChannel",
      channel: channel ?? "",
    });
  if (event.maintainerAuthorized !== true)
    return err({ type: "UnauthorizedStableRoute", actor: event.actor });
  if (event.releasedSha === undefined)
    return err({
      type: "WrongMainLineage",
      reason: "manual stable routes require the merged released SHA",
    });
  return ok({
    channel,
    eventName: "workflow_dispatch",
    merged: true,
    releasedSha: event.releasedSha,
    pullRequestNumber: null,
    markerCleanupRequired: false,
  });
}

/** Validates the full rollout tuple and applies the external mode policy. */
export function evaluateRolloutGate(input: {
  readonly route: StableRoute;
  readonly declaration?: unknown;
  readonly mode: unknown;
  readonly topology: unknown;
}): Result<RolloutDecision, RolloutGateError> {
  const mode = parseReleaseRolloutMode(input.mode);
  if (mode.isErr())
    return err({
      type: "RolloutInvalidState",
      reason: "RELEASE_ROLLOUT_MODE is not disabled, dry-run, or enabled",
      mode: String(input.mode),
    });
  const topology = validateWorkflowTopology(input.topology);
  if (topology.isErr()) return err(toTopologyError(topology.error));
  const tuple = validateRolloutTuple(
    input.declaration ?? ROLLOUT_STAGE_DECLARATION,
    mode.value,
    topology.value,
  );
  if (tuple.isErr()) {
    if (tuple.error.type === "RolloutInvalidState")
      return err({
        type: "RolloutInvalidState",
        reason: tuple.error.reason,
        stage: tuple.error.stage,
        mode: tuple.error.mode,
      });
    return err({
      type: "RolloutInvalidState",
      reason: tuple.error.type,
      mode: mode.value,
    });
  }
  if (!input.route.merged)
    return ok({
      tuple: tuple.value,
      work: false,
      publish: false,
      outcome: "RolloutDisabled",
    });
  if (mode.value === "disabled")
    return ok({
      tuple: tuple.value,
      work: false,
      publish: false,
      outcome: "RolloutDisabled",
    });
  if (mode.value === "dry-run")
    return ok({
      tuple: tuple.value,
      work: true,
      publish: false,
      outcome: "dry-run",
    });
  return ok({
    tuple: tuple.value,
    work: true,
    publish: true,
    outcome: "ready",
  });
}

/** Combines event and rollout checks. No downstream work is authorized here. */
export function guardStableRoute(input: {
  readonly event: unknown;
  readonly declaration?: unknown;
  readonly mode: unknown;
  readonly topology: unknown;
}): Result<GuardedStableRoute, RolloutGateError> {
  return validateStableRouteEvent(input.event).andThen((route) =>
    evaluateRolloutGate({
      route,
      declaration: input.declaration,
      mode: input.mode,
      topology: input.topology,
    }).map((rollout) => ({ ...route, rollout })),
  );
}

export interface LocalTopologyReadError {
  type: "RolloutTopologyReadFailed";
  path: string;
  reason: string;
}

/** Reads only workflow topology from a protected checkout. */
export function readLocalWorkflowTopology(
  root: string,
): ResultAsyncType<WorkflowTopology, LocalTopologyReadError> {
  const oldPath = resolve(root, ".github/workflows/publish.yml");
  const newPath = resolve(root, RELEASE_PUBLISH_WORKFLOW_PATH);
  const attestPath = resolve(root, ".github/workflows/release-attest.yml");
  return ResultAsync.fromThrowable(
    async () => {
      const oldPresent = await Bun.file(oldPath).exists();
      const newPresent = await Bun.file(newPath).exists();
      const attestPresent = await Bun.file(attestPath).exists();
      const oldText = oldPresent ? await Bun.file(oldPath).text() : "";
      const newText = newPresent ? await Bun.file(newPath).text() : "";
      const attestText = attestPresent ? await Bun.file(attestPath).text() : "";
      return {
        oldWorkflowPresent: oldPresent,
        oldWorkflowScheduled: hasSchedule(oldText),
        newWorkflowPresent: newPresent,
        newWorkflowScheduled: hasSchedule(newText),
        newWorkflowGateDisabled: newPresent
          ? newText.includes("RELEASE_ROLLOUT_MODE")
          : undefined,
        attestationWorkflowPresent: attestPresent,
        attestationWorkflowCalls: attestText.includes("workflow_call:"),
      } satisfies WorkflowTopology;
    },
    (cause): LocalTopologyReadError => ({
      type: "RolloutTopologyReadFailed",
      path: root,
      reason: String(cause),
    }),
  )();
}

function hasSchedule(text: string): boolean {
  return /^\s*schedule\s*:/m.test(stripYamlComments(text));
}

function stripYamlComments(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trimStart().startsWith("#") ? "" : line))
    .join("\n");
}

function toTopologyError(error: RolloutTupleError): RolloutGateError {
  if ("issues" in error)
    return { type: "InvalidRolloutTopology", issues: error.issues };
  return { type: "InvalidRolloutTopology", issues: [error.type] };
}

/** Converts the workflow environment into the strict route input. */
export function parseStableRouteEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Result<StableRouteEvent, RolloutGateError> {
  const labels = (env.PR_LABELS ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  const merged = env.PR_MERGED;
  const mergedValue = merged === undefined ? undefined : merged === "true";
  const mergeCommitSha = env.PR_MERGE_COMMIT_SHA;
  const pullRequest =
    env.GITHUB_EVENT_NAME === "pull_request"
      ? {
          number: Number(env.PR_NUMBER ?? "0"),
          action: "closed" as const,
          merged: mergedValue === true,
          baseRef: env.PR_BASE_REF ?? "",
          baseRepository: env.PR_BASE_REPOSITORY ?? "",
          labels,
          mergeCommitSha:
            mergeCommitSha === undefined || mergeCommitSha === ""
              ? null
              : mergeCommitSha,
        }
      : null;
  let eventName: StableRouteEvent["eventName"];
  if (env.GITHUB_EVENT_NAME === "pull_request") eventName = "pull_request";
  else if (env.GITHUB_EVENT_NAME === "workflow_dispatch")
    eventName = "workflow_dispatch";
  else eventName = "schedule";
  const candidate = {
    repository: env.GITHUB_REPOSITORY ?? "",
    eventName,
    action:
      env.GITHUB_EVENT_ACTION ??
      (env.GITHUB_EVENT_NAME === "workflow_dispatch"
        ? "workflow_dispatch"
        : "closed"),
    ref: env.GITHUB_REF ?? "",
    actor: env.GITHUB_ACTOR ?? "",
    maintainerAuthorized: env.RELEASE_MAINTAINER_AUTHORIZED === "true",
    channel: env.INPUT_CHANNEL || undefined,
    releasedSha:
      env.INPUT_RELEASED_SHA === undefined || env.INPUT_RELEASED_SHA === ""
        ? undefined
        : env.INPUT_RELEASED_SHA,
    pullRequest,
  };
  const parsed = StableRouteEventSchema.safeParse(candidate);
  if (!parsed.success)
    return err({
      type: "InvalidStableRoute",
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    });
  return ok(parsed.data);
}

if (import.meta.main) {
  const env = Bun.env;
  const event = parseStableRouteEnvironment(env);
  if (event.isErr()) {
    // This branch is only reachable for a malformed controller environment.
    // Use the shared logger in the real workflow wrapper; process status is the
    // machine-readable boundary here.
    process.exitCode = 2;
  } else {
    const root = resolve(import.meta.dir, "../..");
    const topology = await readLocalWorkflowTopology(root);
    if (topology.isErr()) {
      process.exitCode = 2;
    } else {
      const guarded = guardStableRoute({
        event: event.value,
        declaration: ROLLOUT_STAGE_DECLARATION,
        mode: env.RELEASE_ROLLOUT_MODE ?? "disabled",
        topology: topology.value,
      });
      const output = guarded.match(
        (value) => ({
          channel: value.channel,
          work: value.rollout.work,
          publish: value.rollout.publish,
          merged: value.merged,
          releasedSha: value.releasedSha ?? "",
          markerCleanupRequired: value.markerCleanupRequired,
          outcome: value.rollout.outcome,
        }),
        (error) => ({
          channel: event.value.channel ?? "",
          work: false,
          publish: false,
          merged: false,
          releasedSha: "",
          markerCleanupRequired: false,
          outcome: error.type,
        }),
      );
      const lines = Object.entries(output).map(
        ([key, value]) => `${key}=${String(value)}`,
      );
      const outputPath = env.GITHUB_OUTPUT;
      if (outputPath !== undefined)
        await Bun.write(outputPath, `${lines.join("\n")}\n`);
      process.exitCode = guarded.isErr() ? 1 : 0;
    }
  }
}
