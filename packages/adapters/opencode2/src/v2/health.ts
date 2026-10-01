import type { OpenCode2CatalogCandidate } from "./catalog.js";
import type { OpenCode2RefreshStatus } from "./config-refresh.js";
import type { OpenCode2ModelUpdates } from "./model-updates.js";

export interface OpenCode2HealthIssue {
  readonly code:
    | "materialization_failed"
    | "model_unavailable"
    | "variant_unavailable"
    | "skill_unavailable"
    | "model_updates_unavailable"
    | "agent_collision"
    | "config_invalid";
  readonly agentName?: string;
  readonly count?: number;
}

/**
 * The recommendations layer, as `status` reports it (Spec 39). `issued` is
 * there exactly when a list is applied.
 */
export type OpenCode2ModelUpdatesReport = Pick<
  OpenCode2ModelUpdates,
  "mode" | "channel"
> &
  (
    | { readonly state: "off" | "pending" | "unavailable" }
    | { readonly state: "applied"; readonly issued: string }
  );

function modelUpdatesReport(
  updates: OpenCode2ModelUpdates,
): OpenCode2ModelUpdatesReport {
  const base = { mode: updates.mode, channel: updates.channel };
  if (updates.state !== "applied") return { ...base, state: updates.state };
  // An applied layer always carries its list's `issued`; without one there
  // is nothing applied to name.
  if (updates.issued === undefined) return { ...base, state: "pending" };
  return { ...base, state: "applied", issued: updates.issued };
}

export interface OpenCode2HealthReport {
  readonly catalogRevision?: string;
  /** Absent until a catalog is published. */
  readonly modelUpdates?: OpenCode2ModelUpdatesReport;
  readonly refresh: OpenCode2RefreshStatus["state"];
  readonly agentCount: number;
  readonly issues: readonly OpenCode2HealthIssue[];
  readonly readiness: {
    readonly nativeAgents: boolean;
    readonly requestIntent: boolean;
    readonly foregroundPlans: boolean;
    readonly planDisplay: boolean;
    readonly nativeDelegation: boolean;
    readonly durableWorkflows: false;
  };
}

export interface OpenCode2RegistrationReadiness {
  readonly requestIntent: boolean;
  readonly foregroundPlans: boolean;
  readonly planDisplay: boolean;
}

const DEFAULT_REGISTRATION_READINESS: OpenCode2RegistrationReadiness = {
  requestIntent: true,
  foregroundPlans: true,
  planDisplay: true,
};

const MAX_HEALTH_ISSUES = 64;

/** Produce bounded adapter readiness without weakening the engine readiness profile. */
export function buildOpenCode2Health(
  catalog: OpenCode2CatalogCandidate | undefined,
  refresh: OpenCode2RefreshStatus,
  ownedAgents: ReadonlySet<string> = new Set(catalog?.agents.keys() ?? []),
  registration: OpenCode2RegistrationReadiness = DEFAULT_REGISTRATION_READINESS,
): OpenCode2HealthReport {
  const issues: OpenCode2HealthIssue[] = (catalog?.issues ?? [])
    .slice(0, MAX_HEALTH_ISSUES)
    .map((issue) => ({
      code: issue.code,
      agentName: issue.agentName,
      ...(issue.code === "skill_unavailable" ? { count: issue.count } : {}),
    }));
  const collisionCount = Math.max(
    0,
    (catalog?.agents.size ?? 0) - ownedAgents.size,
  );
  if (collisionCount > 0 && issues.length < MAX_HEALTH_ISSUES) {
    issues.push({ code: "agent_collision", count: collisionCount });
  }
  // A config that does not parse or validate loads nothing — falling back to
  // the builtins would silently drop the user's restrictions — so the reason
  // is reported instead of leaving only a failed refresh state.
  // It goes first, displacing the last stale catalog issue if the list is
  // full, because it is the one that explains why nothing else changes.
  if (
    refresh.state === "failed" &&
    refresh.lastErrorCode === "config_invalid"
  ) {
    issues.unshift({ code: "config_invalid" });
    issues.splice(MAX_HEALTH_ISSUES);
  }
  const ready = catalog !== undefined;
  const updates = catalog?.modelUpdates;
  return {
    catalogRevision: catalog?.revision,
    ...(updates === undefined
      ? {}
      : { modelUpdates: modelUpdatesReport(updates) }),
    refresh: refresh.state,
    agentCount: ownedAgents.size,
    issues,
    readiness: {
      nativeAgents: ready && ownedAgents.size > 0,
      requestIntent:
        ready && ownedAgents.size > 0 && registration.requestIntent,
      foregroundPlans:
        ownedAgents.has("tapestry") && registration.foregroundPlans,
      planDisplay: registration.planDisplay,
      nativeDelegation: ready && ownedAgents.size > 0,
      durableWorkflows: false,
    },
  };
}
