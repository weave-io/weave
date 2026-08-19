/**
 * Stable route controller.
 *
 * It performs the event/rollout decision and, for a closed stable PR, attempts
 * the marker cleanup before returning. Marker cleanup is deliberately
 * best-effort: a merge continues through the publication chain when deletion
 * fails, and the returned `markerCleanupPending` bit is the durable recovery
 * signal consumed by Task 14 resume.
 */
import { resolve } from "node:path";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type { GitHubRefWriteError } from "./github-client.js";
import { GitHubRestClient } from "./github-client.js";
import {
  evaluateRolloutGate,
  type GuardedStableRoute,
  parseStableRouteEnvironment,
  type RolloutGateError,
  readLocalWorkflowTopology,
  validateStableRouteEvent,
} from "./rollout-gate.js";
import { ROLLOUT_STAGE_DECLARATION } from "./rollout-stage.js";

export interface MarkerCleanupPort {
  readMarker(): ResultAsync<string | null, MarkerCleanupError>;
  deleteMarker(expectedSha: string): ResultAsync<void, MarkerCleanupError>;
}

export type MarkerCleanupError =
  | { type: "MarkerReadFailed"; reason: string }
  | { type: "MarkerDeleteFailed"; reason: string };

export interface MarkerCleanupResult {
  attempted: boolean;
  pending: boolean;
  markerSha: string | null;
  error?: MarkerCleanupError;
}

export interface StableRouteControllerResult extends GuardedStableRoute {
  markerCleanup: MarkerCleanupResult;
}

/** Best-effort deletion with a server-side expected-head lease. */
export function cleanupSettledMarker(
  route: Pick<GuardedStableRoute, "markerCleanupRequired">,
  port: MarkerCleanupPort,
): ResultAsync<MarkerCleanupResult, never> {
  if (!route.markerCleanupRequired)
    return okAsync({ attempted: false, pending: false, markerSha: null });
  return port
    .readMarker()
    .andThen((markerSha) => {
      if (markerSha === null)
        return okAsync({
          attempted: true,
          pending: false,
          markerSha: null,
        });
      return port
        .deleteMarker(markerSha)
        .map(
          () =>
            ({
              attempted: true,
              pending: false,
              markerSha,
            }) satisfies MarkerCleanupResult,
        )
        .orElse((error) =>
          okAsync({
            attempted: true,
            pending: true,
            markerSha,
            error,
          }),
        );
    })
    .orElse((error) =>
      okAsync({
        attempted: true,
        pending: true,
        markerSha: null,
        error,
      }),
    );
}

export function runStableRoute(
  input: {
    event: unknown;
    declaration?: unknown;
    mode: unknown;
    topology: unknown;
  },
  marker?: MarkerCleanupPort,
): ResultAsync<StableRouteControllerResult, RolloutGateError> {
  const route = validateStableRouteEvent(input.event);
  if (route.isErr()) return errAsync(route.error);
  const cleanup: ResultAsync<MarkerCleanupResult, never> =
    marker === undefined
      ? okAsync<MarkerCleanupResult, never>({
          attempted: false,
          pending: false,
          markerSha: null,
        })
      : cleanupSettledMarker(route.value, marker);
  return cleanup.andThen((markerCleanup: MarkerCleanupResult) =>
    evaluateRolloutGate({
      route: route.value,
      declaration: input.declaration ?? ROLLOUT_STAGE_DECLARATION,
      mode: input.mode,
      topology: input.topology,
    }).map((rollout) => ({
      ...route.value,
      rollout,
      markerCleanup,
    })),
  );
}

/** GitHub REST marker port used only by the route job. */
export function createGitHubMarkerCleanupPort(input: {
  repository: string;
  token: string;
  apiUrl?: string;
}): MarkerCleanupPort {
  const client = new GitHubRestClient(
    input.repository,
    input.token,
    fetch,
    input.apiUrl ?? "https://api.github.com",
  );
  return {
    readMarker: () =>
      client.readRefOptional("release-pr/stable").mapErr((error) => ({
        type: "MarkerReadFailed" as const,
        reason: `${error.operation}: ${error.message}`,
      })),
    deleteMarker: (expectedSha) =>
      client
        .deleteRefWithLease("release-pr/stable", expectedSha)
        .mapErr((error: GitHubRefWriteError) => ({
          type: "MarkerDeleteFailed" as const,
          reason: describeRefWriteError(error),
        })),
  };
}

function describeRefWriteError(error: GitHubRefWriteError): string {
  if (error.type === "ReferenceLeaseLost")
    return `${error.type}: expected ${error.expectedSha}, actual ${error.actualSha ?? "absent"}`;
  if (error.type === "ReferenceAlreadyExists") return error.type;
  return `${error.operation}: ${error.message}`;
}

if (import.meta.main) {
  const env = Bun.env;
  const event = parseStableRouteEnvironment(env);
  if (event.isErr()) {
    process.exitCode = 2;
  } else {
    const root = resolve(import.meta.dir, "../..");
    const topology = await readLocalWorkflowTopology(root);
    if (topology.isErr()) {
      process.exitCode = 2;
    } else {
      const markerToken =
        env.RELEASE_APP_INSTALLATION_TOKEN ?? env.GITHUB_TOKEN;
      const marker =
        markerToken === undefined || env.GITHUB_REPOSITORY === undefined
          ? undefined
          : createGitHubMarkerCleanupPort({
              repository: env.GITHUB_REPOSITORY,
              token: markerToken,
              apiUrl: env.GITHUB_API_URL,
            });
      const result = await runStableRoute(
        {
          event: event.value,
          declaration: ROLLOUT_STAGE_DECLARATION,
          mode: env.RELEASE_ROLLOUT_MODE ?? "disabled",
          topology: topology.value,
        },
        marker,
      );
      const output = result.match(
        (value) => ({
          channel: value.channel,
          work: value.rollout.work,
          publish: value.rollout.publish,
          merged: value.merged,
          releasedSha: value.releasedSha ?? "",
          markerCleanupPending: value.markerCleanup.pending,
          markerCleanupError: value.markerCleanup.error?.type ?? "",
          outcome: value.rollout.outcome,
        }),
        (error) => ({
          channel: event.value.channel ?? "",
          work: false,
          publish: false,
          merged: false,
          releasedSha: "",
          markerCleanupPending: false,
          markerCleanupError: "",
          outcome: error.type,
        }),
      );
      const lines = Object.entries(output).map(
        ([key, value]) => `${key}=${String(value)}`,
      );
      if (env.GITHUB_OUTPUT !== undefined)
        await Bun.write(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
      process.exitCode = result.isErr() ? 1 : 0;
    }
  }
}
