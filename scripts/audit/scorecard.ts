/**
 * Assembles the WS1 delegation metrics into one scorecard and renders it as
 * Markdown or JSON. Aggregate numbers only: no session titles, directories,
 * message text or error strings reach the output.
 */

import {
  type BuiltinDelegations,
  builtinAgentDelegations,
  type CategoryShuttleShare,
  categoryShuttleShare,
  categoryShuttleSuccess,
  configurationFailures,
  type DelegationCounts,
  delegations,
  type Fraction,
  type PlanTaskDelegation,
  planTaskDelegation,
  type RecoveredFailures,
  recoveredFailures,
  type TransientFailures,
  transientFailures,
} from "./delegation-metrics.js";
import type { AuditDataset, Harness } from "./session-store.js";

export interface Scorecard {
  readonly harness: Harness;
  readonly window: { readonly since: string; readonly until: string };
  readonly projectFilter: boolean;
  readonly sessions: {
    readonly total: number;
    readonly topLevel: number;
    readonly excludedTmp: number;
  };
  readonly delegations: DelegationCounts;
  readonly configurationFailures: Fraction;
  readonly categoryShuttleSuccess: Fraction;
  readonly categoryShuttleShare: CategoryShuttleShare;
  readonly builtinAgentDelegations: BuiltinDelegations;
  readonly transientFailures: TransientFailures;
  readonly recoveredFailures: RecoveredFailures;
  readonly planTaskDelegation: PlanTaskDelegation;
}

export interface ScorecardInput {
  readonly dataset: AuditDataset;
  readonly since: number;
  readonly until: number;
  readonly projectFilter: boolean;
  readonly definesCategories: (projectDir: string) => boolean;
}

const HARNESS_NAMES: Readonly<Record<Harness, string>> = {
  opencode: "OpenCode V1",
  opencode2: "OpenCode V2",
};

export function buildScorecard(input: ScorecardInput): Scorecard {
  const { dataset } = input;
  return {
    harness: dataset.harness,
    window: {
      since: new Date(input.since).toISOString(),
      until: new Date(input.until).toISOString(),
    },
    projectFilter: input.projectFilter,
    sessions: {
      total: dataset.sessions.length,
      topLevel: dataset.sessions.filter((s) => s.parentId === null).length,
      excludedTmp: dataset.excludedTmpSessions,
    },
    delegations: delegations(dataset),
    configurationFailures: configurationFailures(dataset),
    categoryShuttleSuccess: categoryShuttleSuccess(dataset),
    categoryShuttleShare: categoryShuttleShare(
      dataset,
      input.definesCategories,
    ),
    builtinAgentDelegations: builtinAgentDelegations(dataset),
    transientFailures: transientFailures(dataset),
    recoveredFailures: recoveredFailures(dataset),
    planTaskDelegation: planTaskDelegation(dataset),
  };
}

function percent(count: number, total: number): string {
  if (total === 0) return "";
  return ` (${((count / total) * 100).toFixed(1)}%)`;
}

function ratio(fraction: Fraction): string {
  return `${fraction.count} / ${fraction.total}${percent(fraction.count, fraction.total)}`;
}

export function renderMarkdown(card: Scorecard): string {
  const builtins = Object.entries(card.builtinAgentDelegations.byAgent)
    .map(([agent, n]) => `${agent} ${n}`)
    .join(", ");
  const transient = card.transientFailures;
  const recovered = card.recoveredFailures;
  const plan = card.planTaskDelegation;
  const scope = card.projectFilter ? " · one project" : "";
  const rows: [string, string][] = [
    ["Delegations", `${card.delegations.total}`],
    [
      "Configuration delegation failures",
      `${card.configurationFailures.count} of ${card.configurationFailures.total}`,
    ],
    ["Category-shuttle success", ratio(card.categoryShuttleSuccess)],
    [
      "Category-shuttle share (projects with categories)",
      `${ratio(card.categoryShuttleShare)} · projects: ${card.categoryShuttleShare.projects}`,
    ],
    [
      "Built-in agent delegations",
      `${card.builtinAgentDelegations.total} (${builtins})`,
    ],
    [
      "Transient failures not recovered",
      `${transient.total - transient.recovered} of ${transient.total}`,
    ],
    [
      "Recovered failures",
      `${recovered.recovered} of ${recovered.total} (transient ${recovered.transient.count}/${recovered.transient.total}, configuration ${recovered.configuration.count}/${recovered.configuration.total}) · ${recovered.allFailed} failed delegations in all`,
    ],
    [
      "Plan-task delegation by Loom",
      `Loom took turns in ${plan.sessionsWithLoomTurns} of ${plan.planSessions} plan sessions · ${plan.loomDelegationMessages} Loom messages with a delegation in ${plan.sessionsWithLoomDelegation} sessions`,
    ],
  ];
  return [
    `## WS1 delegation scorecard — ${HARNESS_NAMES[card.harness]}`,
    "",
    `Sessions created ${card.window.since} to ${card.window.until} (exclusive)${scope}: ${card.sessions.total} (${card.sessions.topLevel} top-level); ${card.sessions.excludedTmp} under \`/tmp/\` excluded.`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    ...rows.map(([metric, value]) => `| ${metric} | ${value} |`),
    "",
  ].join("\n");
}

export function renderJson(card: Scorecard): string {
  return `${JSON.stringify(card, null, 2)}\n`;
}
