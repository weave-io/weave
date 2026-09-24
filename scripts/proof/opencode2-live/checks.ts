/**
 * Verdicts for the OpenCode 2 live check.
 *
 * Everything here is pure: it reads what the real host reported (plugin,
 * agent and command lists from `opencode2 api`) and what the scripted model
 * provider received, and decides whether Weave works on that host. The
 * process work that gathers those observations lives in `host.ts`.
 *
 * See docs/testing/opencode2-verification.md ("Live host check").
 */

import { err, ok, type Result } from "neverthrow";

export const LIVE_CHECK_IDS = [
  "host_version",
  "plugin_active",
  "agents_registered",
  "start_command",
  "loom_prompt",
  "delegation_offered",
  "delegation_ran",
  "delegation_returned",
  "subagent_policy",
] as const;

export type LiveCheckId = (typeof LIVE_CHECK_IDS)[number];

export interface LiveVerdict {
  readonly id: LiveCheckId;
  readonly status: "passed" | "failed" | "skipped";
  readonly evidence: string;
}

/** One entry of `opencode2 api plugin.list`. */
export interface HostPlugin {
  readonly id?: string;
  readonly source: {
    readonly type: string;
    readonly target?: string;
    readonly version?: string;
    readonly path?: string;
  };
  readonly state: { readonly status: string; readonly error?: string };
}

/** One entry of `opencode2 api agent.list`. */
export interface HostAgent {
  readonly id: string;
  readonly mode?: string;
  readonly description?: string | null;
  readonly system?: string | null;
}

/** A chat-completions request body the scripted provider received. */
export interface CapturedRequest {
  readonly body: unknown;
}

export interface LiveObservation {
  readonly hostVersion: string;
  /** Set when the run asked for an exact host version. */
  readonly expectedHostVersion?: string;
  readonly plugins: readonly HostPlugin[];
  readonly agents: readonly HostAgent[];
  readonly commands: readonly string[];
  /** `null` when the agent run was not attempted. */
  readonly run: {
    readonly exitCode: number;
    readonly requests: readonly CapturedRequest[];
  } | null;
}

export interface LiveCheckOptions {
  /** Agents the loaded Weave config declares; each must be registered. */
  readonly expectedAgents: readonly string[];
  readonly ownershipMarker: string;
  /** The primary agent the run starts in. */
  readonly primary: string;
  /** The subagent the scripted model delegates to. */
  readonly delegate: string;
  readonly startCommand: string;
  readonly delegationTool: string;
  /** Tools a delegated subagent must not be offered. */
  readonly subagentForbiddenTools: readonly string[];
}

interface ParsedRequest {
  readonly system: string;
  readonly tools: ReadonlyMap<string, string>;
  /** Ids of earlier assistant calls to the delegation tool. */
  readonly delegationCalls: ReadonlySet<string>;
  /** `tool_call_id`s of the tool results the request carries. */
  readonly toolResults: ReadonlySet<string>;
}

const MAX_EVIDENCE = 300;

function bounded(text: string): string {
  if (text.length <= MAX_EVIDENCE) return text;
  return `${text.slice(0, MAX_EVIDENCE - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as Record<string, unknown>;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const text = asRecord(part)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function delegationCallIds(
  message: Record<string, unknown>,
  tool: string,
): string[] {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls.flatMap((call) => {
    const record = asRecord(call);
    const name = asRecord(record?.function)?.name;
    return name === tool && typeof record?.id === "string" ? [record.id] : [];
  });
}

/** Reads the parts of an OpenAI-compatible request the checks rely on. */
export function parseRequest(
  request: CapturedRequest,
  delegationTool: string,
): ParsedRequest {
  const body = asRecord(request.body);
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system: string[] = [];
  const delegationCalls = new Set<string>();
  const toolResults = new Set<string>();
  for (const message of messages) {
    const record = asRecord(message);
    if (record === undefined) continue;
    if (record.role === "system") system.push(contentText(record.content));
    if (record.role === "assistant") {
      for (const id of delegationCallIds(record, delegationTool))
        delegationCalls.add(id);
    }
    if (record.role === "tool" && typeof record.tool_call_id === "string") {
      toolResults.add(record.tool_call_id);
    }
  }
  const tools = new Map<string, string>();
  const rawTools = Array.isArray(body?.tools) ? body.tools : [];
  for (const tool of rawTools) {
    const fn = asRecord(asRecord(tool)?.function);
    if (typeof fn?.name !== "string") continue;
    tools.set(
      fn.name,
      typeof fn.description === "string" ? fn.description : "",
    );
  }
  return { system: system.join("\n"), tools, delegationCalls, toolResults };
}

export class LiveChecks {
  constructor(private readonly options: LiveCheckOptions) {}

  evaluate(observation: LiveObservation): LiveVerdict[] {
    const verdicts: LiveVerdict[] = [
      this.hostVersion(observation),
      this.pluginActive(observation),
      this.agentsRegistered(observation),
      this.startCommand(observation),
    ];
    verdicts.push(...this.runChecks(observation));
    return verdicts;
  }

  /** `ok` only when every check passed; otherwise the non-passing ones. */
  static outcome(
    verdicts: readonly LiveVerdict[],
  ): Result<readonly LiveVerdict[], readonly LiveVerdict[]> {
    const notPassed = verdicts.filter((verdict) => verdict.status !== "passed");
    if (notPassed.length > 0) return err(notPassed);
    return ok(verdicts);
  }

  private hostVersion(observation: LiveObservation): LiveVerdict {
    const reported = observation.hostVersion.trim();
    const expected = observation.expectedHostVersion;
    const version = /\bv?(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/.exec(reported)?.[1];
    if (expected !== undefined && version !== expected) {
      return this.failed(
        "host_version",
        `expected ${expected}, host reported "${reported}"`,
      );
    }
    if (version === undefined || !version.startsWith("2.")) {
      return this.failed(
        "host_version",
        `host did not report a 2.x version: "${reported}"`,
      );
    }
    return this.passed("host_version", reported);
  }

  private pluginActive(observation: LiveObservation): LiveVerdict {
    const external = observation.plugins.filter(
      (plugin) => plugin.source.type !== "builtin",
    );
    if (external.length === 0) {
      return this.failed("plugin_active", "no non-builtin plugin was loaded");
    }
    const described = external.map(describePlugin).join("; ");
    const failed = external.find((plugin) => plugin.state.status !== "active");
    if (failed !== undefined) {
      return this.failed("plugin_active", described);
    }
    return this.passed("plugin_active", described);
  }

  private agentsRegistered(observation: LiveObservation): LiveVerdict {
    const missing = this.unownedOrMissing(observation.agents);
    if (missing.length > 0) {
      const seen = observation.agents.map((agent) => agent.id).join(", ");
      return this.failed(
        "agents_registered",
        `missing or not Weave-owned: ${missing.join(", ")}. Host agents: ${seen}`,
      );
    }
    return this.passed(
      "agents_registered",
      `all ${this.options.expectedAgents.length} declared agents registered as ${this.options.ownershipMarker}: ${this.options.expectedAgents.join(", ")}`,
    );
  }

  private startCommand(observation: LiveObservation): LiveVerdict {
    if (!observation.commands.includes(this.options.startCommand)) {
      return this.failed(
        "start_command",
        `${this.options.startCommand} absent; host commands: ${observation.commands.join(", ")}`,
      );
    }
    return this.passed(
      "start_command",
      `${this.options.startCommand} registered`,
    );
  }

  private runChecks(observation: LiveObservation): LiveVerdict[] {
    const runIds: LiveCheckId[] = [
      "loom_prompt",
      "delegation_offered",
      "delegation_ran",
      "delegation_returned",
      "subagent_policy",
    ];
    if (observation.run === null) {
      return runIds.map((id) =>
        this.skipped(id, "agent run not attempted: agents were not registered"),
      );
    }
    const primary = systemOf(observation.agents, this.options.primary);
    const delegate = systemOf(observation.agents, this.options.delegate);
    const requests = observation.run.requests.map((request) =>
      parseRequest(request, this.options.delegationTool),
    );
    const primaryRequests =
      primary === undefined
        ? []
        : requests.filter((request) => request.system.includes(primary));
    const delegateRequests =
      delegate === undefined
        ? []
        : requests.filter((request) => request.system.includes(delegate));
    return [
      this.primaryPrompt(observation.run, primary, requests, primaryRequests),
      this.delegationOffered(primaryRequests),
      this.delegationRan(delegate, delegateRequests),
      this.delegationReturned(primaryRequests),
      this.subagentPolicy(delegateRequests),
    ];
  }

  private primaryPrompt(
    run: NonNullable<LiveObservation["run"]>,
    primary: string | undefined,
    requests: readonly ParsedRequest[],
    primaryRequests: readonly ParsedRequest[],
  ): LiveVerdict {
    const name = this.options.primary;
    if (primary === undefined) {
      return this.failed(
        "loom_prompt",
        `host reported no system prompt for ${name}`,
      );
    }
    if (primaryRequests.length === 0) {
      return this.failed(
        "loom_prompt",
        `${requests.length} model requests (run exit ${run.exitCode}); none carried ${name}'s host-reported system prompt`,
      );
    }
    return this.passed(
      "loom_prompt",
      `${name}'s composed prompt (${primary.length} chars) reached the model in ${primaryRequests.length} request(s)`,
    );
  }

  private delegationOffered(
    primaryRequests: readonly ParsedRequest[],
  ): LiveVerdict {
    const { delegationTool, delegate, primary } = this.options;
    const first = primaryRequests[0];
    if (first === undefined) {
      return this.skipped("delegation_offered", `no ${primary} request`);
    }
    const description = first.tools.get(delegationTool);
    if (description === undefined) {
      return this.failed(
        "delegation_offered",
        `${primary} was not offered the ${delegationTool} tool; tools: ${[...first.tools.keys()].join(", ")}`,
      );
    }
    if (!description.includes(delegate)) {
      return this.failed(
        "delegation_offered",
        `${delegationTool} tool does not list ${delegate}`,
      );
    }
    return this.passed(
      "delegation_offered",
      `${primary} offered ${delegationTool} with ${delegate} as a target`,
    );
  }

  private delegationRan(
    delegate: string | undefined,
    delegateRequests: readonly ParsedRequest[],
  ): LiveVerdict {
    const name = this.options.delegate;
    if (delegate === undefined) {
      return this.failed(
        "delegation_ran",
        `host reported no system prompt for ${name}`,
      );
    }
    if (delegateRequests.length === 0) {
      return this.failed(
        "delegation_ran",
        `no model request carried ${name}'s host-reported system prompt`,
      );
    }
    return this.passed(
      "delegation_ran",
      `${name} ran in a child session with its composed prompt`,
    );
  }

  private delegationReturned(
    primaryRequests: readonly ParsedRequest[],
  ): LiveVerdict {
    const returned = primaryRequests.some((request) =>
      [...request.delegationCalls].some((id) => request.toolResults.has(id)),
    );
    if (!returned) {
      return this.failed(
        "delegation_returned",
        `no ${this.options.primary} request carried the result of its ${this.options.delegationTool} call`,
      );
    }
    return this.passed(
      "delegation_returned",
      `${this.options.delegate}'s result came back to ${this.options.primary}`,
    );
  }

  private subagentPolicy(
    delegateRequests: readonly ParsedRequest[],
  ): LiveVerdict {
    const name = this.options.delegate;
    if (delegateRequests.length === 0) {
      return this.skipped("subagent_policy", `no ${name} request`);
    }
    const offered = new Set<string>();
    for (const request of delegateRequests) {
      for (const tool of request.tools.keys()) offered.add(tool);
    }
    const forbidden = this.options.subagentForbiddenTools.filter((tool) =>
      offered.has(tool),
    );
    if (forbidden.length > 0) {
      return this.failed(
        "subagent_policy",
        `${name} was offered ${forbidden.join(", ")}`,
      );
    }
    return this.passed(
      "subagent_policy",
      `${name} tools: ${[...offered].sort().join(", ")}`,
    );
  }

  private unownedOrMissing(agents: readonly HostAgent[]): string[] {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const failures: string[] = [];
    for (const name of this.options.expectedAgents) {
      const agent = byId.get(name);
      if (agent === undefined) {
        failures.push(`${name} (absent)`);
        continue;
      }
      if (!(agent.description ?? "").startsWith(this.options.ownershipMarker)) {
        failures.push(`${name} (not Weave-owned)`);
      }
    }
    return failures;
  }

  private passed(id: LiveCheckId, evidence: string): LiveVerdict {
    return { id, status: "passed", evidence: bounded(evidence) };
  }

  private failed(id: LiveCheckId, evidence: string): LiveVerdict {
    return { id, status: "failed", evidence: bounded(evidence) };
  }

  private skipped(id: LiveCheckId, evidence: string): LiveVerdict {
    return { id, status: "skipped", evidence: bounded(evidence) };
  }
}

function systemOf(
  agents: readonly HostAgent[],
  id: string,
): string | undefined {
  const system = agents.find((agent) => agent.id === id)?.system?.trim();
  if (system === undefined || system.length === 0) return undefined;
  return system;
}

function describePlugin(plugin: HostPlugin): string {
  const source =
    plugin.source.target ?? plugin.source.path ?? plugin.source.type;
  const pinned = plugin.source.version;
  const version =
    pinned === undefined || source.endsWith(pinned) ? "" : ` (${pinned})`;
  const error =
    plugin.state.error === undefined ? "" : ` (${plugin.state.error})`;
  return `${plugin.id ?? source} ${source}${version}: ${plugin.state.status}${error}`;
}
