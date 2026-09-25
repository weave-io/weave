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

import { err, ok, Result } from "neverthrow";

export const LIVE_CHECK_IDS = [
  "host_version",
  "plugin_active",
  "agents_registered",
  "start_command",
  "run_completed",
  "loom_prompt",
  "delegation_offered",
  "delegation_ran",
  "delegation_returned",
  "subagent_policy",
  "builtins_hidden",
  "builtin_refused",
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
  /**
   * A host built-in subagent the scripted model asks the primary to spawn
   * before it delegates to `delegate`. The host must refuse it (Spec 38
   * item 5).
   */
  readonly refusedBuiltin: string;
}

interface ParsedRequest {
  readonly system: string;
  readonly tools: ReadonlyMap<string, string>;
  /** Earlier assistant calls to the delegation tool: call id → agent. */
  readonly delegationCalls: ReadonlyMap<string, string>;
  /** The tool results the request carries: `tool_call_id` → content. */
  readonly toolResults: ReadonlyMap<string, string>;
}

const MAX_EVIDENCE = 300;

/**
 * The error type OpenCode 2 puts in a tool result when a permission rule
 * denies the call (host 2.0.16:
 * `{"error":{"type":"permission.rejected","message":"Permission denied: subagent"}}`).
 */
const PERMISSION_REJECTED = "permission.rejected";

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

/** The `agent` argument of one tool call, or `""` when it has none. */
function callAgent(fn: Record<string, unknown> | undefined): string {
  if (typeof fn?.arguments !== "string") return "";
  const parsed = Result.fromThrowable(
    () => JSON.parse(fn.arguments as string) as unknown,
    () => undefined,
  )();
  if (parsed.isErr()) return "";
  const agent = asRecord(parsed.value)?.agent;
  return typeof agent === "string" ? agent : "";
}

/** The message's calls to the delegation tool, as `[call id, agent]`. */
function delegationCalls(
  message: Record<string, unknown>,
  tool: string,
): Array<[string, string]> {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls.flatMap((call): Array<[string, string]> => {
    const record = asRecord(call);
    const fn = asRecord(record?.function);
    if (fn?.name !== tool || typeof record?.id !== "string") return [];
    return [[record.id, callAgent(fn)]];
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
  const calls = new Map<string, string>();
  const toolResults = new Map<string, string>();
  for (const message of messages) {
    const record = asRecord(message);
    if (record === undefined) continue;
    if (record.role === "system") system.push(contentText(record.content));
    if (record.role === "assistant") {
      for (const [id, agent] of delegationCalls(record, delegationTool))
        calls.set(id, agent);
    }
    if (record.role === "tool" && typeof record.tool_call_id === "string") {
      toolResults.set(record.tool_call_id, contentText(record.content));
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
  return {
    system: system.join("\n"),
    tools,
    delegationCalls: calls,
    toolResults,
  };
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
      "run_completed",
      "loom_prompt",
      "delegation_offered",
      "delegation_ran",
      "delegation_returned",
      "subagent_policy",
      "builtins_hidden",
      "builtin_refused",
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
      this.runCompleted(observation.run.exitCode),
      this.primaryPrompt(observation.run, primary, requests, primaryRequests),
      this.delegationOffered(primaryRequests),
      this.delegationRan(delegate, delegateRequests),
      this.delegationReturned(primaryRequests),
      this.subagentPolicy(delegateRequests),
      this.builtinsHidden(observation.agents, primaryRequests),
      this.builtinRefused(observation.agents, requests, primaryRequests),
    ];
  }

  /** The host's own subagents: subagent-mode agents Weave does not own. */
  private hostBuiltins(agents: readonly HostAgent[]): HostAgent[] {
    return agents.filter(
      (agent) =>
        agent.mode === "subagent" &&
        !(agent.description ?? "").startsWith(this.options.ownershipMarker),
    );
  }

  private builtinsHidden(
    agents: readonly HostAgent[],
    primaryRequests: readonly ParsedRequest[],
  ): LiveVerdict {
    const { delegationTool, primary } = this.options;
    const builtins = this.hostBuiltins(agents).map((agent) => agent.id);
    if (builtins.length === 0) {
      return this.failed(
        "builtins_hidden",
        "host reported no built-in subagents, so there is nothing to check",
      );
    }
    const offered = primaryRequests.flatMap((request) => {
      const description = request.tools.get(delegationTool);
      return description === undefined ? [] : [description];
    });
    if (offered.length === 0) {
      return this.skipped(
        "builtins_hidden",
        `${primary} was not offered ${delegationTool}`,
      );
    }
    // The host lists each subagent the caller may spawn as `- <id>: …`.
    const listed = builtins.filter((id) =>
      offered.some((description) =>
        new RegExp(`^- ${escapeRegExp(id)}:`, "m").test(description),
      ),
    );
    if (listed.length > 0) {
      return this.failed(
        "builtins_hidden",
        `${primary}'s ${delegationTool} tool lists host built-ins: ${listed.join(", ")}`,
      );
    }
    return this.passed(
      "builtins_hidden",
      `${primary}'s ${delegationTool} tool lists none of the host's built-in subagents (${builtins.join(", ")})`,
    );
  }

  private builtinRefused(
    agents: readonly HostAgent[],
    requests: readonly ParsedRequest[],
    primaryRequests: readonly ParsedRequest[],
  ): LiveVerdict {
    const { refusedBuiltin: builtin, primary } = this.options;
    if (!this.hostBuiltins(agents).some((agent) => agent.id === builtin)) {
      return this.failed(
        "builtin_refused",
        `host holds no built-in subagent named ${builtin}`,
      );
    }
    const system = systemOf(agents, builtin);
    if (system === undefined) {
      return this.failed(
        "builtin_refused",
        `host reported no system prompt for ${builtin}, so whether it ran cannot be told`,
      );
    }
    if (requests.some((request) => request.system.includes(system))) {
      return this.failed(
        "builtin_refused",
        `${builtin} ran in a child session when ${primary} asked for it`,
      );
    }
    const result = callResult(primaryRequests, builtin);
    if (result === undefined) {
      return this.failed(
        "builtin_refused",
        `no result came back for ${primary}'s call to ${builtin}`,
      );
    }
    // Any other outcome ("agent not found", a plain answer) would not show
    // that the host refused the call because of the caller's permissions.
    if (!result.includes(PERMISSION_REJECTED)) {
      return this.failed(
        "builtin_refused",
        `${primary}'s call to ${builtin} was not refused by a permission rule: ${result}`,
      );
    }
    return this.passed(
      "builtin_refused",
      `${primary}'s call to ${builtin} was refused: ${result}`,
    );
  }

  private runCompleted(exitCode: number): LiveVerdict {
    if (exitCode !== 0) {
      return this.failed(
        "run_completed",
        `opencode2 run --agent ${this.options.primary} exited ${exitCode}`,
      );
    }
    return this.passed(
      "run_completed",
      `opencode2 run --agent ${this.options.primary} exited 0`,
    );
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
    const returned =
      callResult(primaryRequests, this.options.delegate) !== undefined;
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

/**
 * The result a request carries for a delegation call to `agent`, or
 * `undefined` when no request carries one.
 */
function callResult(
  requests: readonly ParsedRequest[],
  agent: string,
): string | undefined {
  for (const request of requests) {
    for (const [id, target] of request.delegationCalls) {
      const result = request.toolResults.get(id);
      if (target === agent && result !== undefined) return result;
    }
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
