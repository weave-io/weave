import type { OpenCode2CatalogCandidate } from "./catalog.js";
import type { OpenCode2RefreshStatus } from "./config-refresh.js";

export interface OpenCode2HealthIssue {
  readonly code:
    | "materialization_failed"
    | "model_unavailable"
    | "variant_unavailable"
    | "skill_unavailable"
    | "agent_collision"
    | "config_invalid";
  readonly agentName?: string;
  readonly count?: number;
}

export interface OpenCode2HealthReport {
  readonly catalogRevision?: string;
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
  return {
    catalogRevision: catalog?.revision,
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
