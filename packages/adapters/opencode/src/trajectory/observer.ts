/**
 * Tool-call observer for OpenCode trajectory runs (Channel B, Spec 35).
 *
 * OpenCode's DEBUG log (Channel A) shows which tool a session asked to run,
 * but not how it ended. Its `tool.execute.after` plugin hook does, for every
 * session including sub-agents. The runner therefore writes a small observer
 * plugin into the workspace's `.opencode/plugin/` directory, which OpenCode
 * auto-loads. The observer appends one JSON line per completed tool call to
 * `/artifacts/tool-calls.jsonl`. After the session, the runner parses those
 * lines and joins them to the Channel-A event stream by session id.
 *
 * See docs/artifacts/verification-trajectory-spike.md for the hook payload
 * this module depends on.
 */

import type { TrajectoryEvent } from "@weaveio/weave-core";
import { redactSecrets } from "@weaveio/weave-engine";
import { z } from "zod";

/** Workspace-relative path the observer plugin is written to. */
export const OBSERVER_PLUGIN_PATH =
  ".opencode/plugin/weave-trajectory-observer.ts";

/** Artifacts-relative file the observer appends to. */
export const OBSERVER_RECORDS_FILE = "tool-calls.jsonl";

/** Upper bound on command text carried in `detail.command`. */
export const OBSERVER_COMMAND_MAX_CHARS = 500;

/**
 * OpenCode tools whose `command` argument is a shell command. Other tools
 * can carry a `command` argument too (the `task` tool's holds a delegation
 * prompt), which must never read as a command that ran.
 */
export const OBSERVER_SHELL_TOOLS: ReadonlySet<string> = new Set(["bash"]);

/**
 * OpenCode tools that change files. The observer records the path they
 * changed so scoring can tell code edits from bookkeeping (for example
 * Tapestry ticking a plan's checkboxes under `.weave/`). `apply_patch`
 * carries its paths inside the patch text.
 */
export const OBSERVER_FILE_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "patch",
  "multiedit",
  "apply_patch",
]);

/**
 * Source of the observer plugin. It runs inside OpenCode's own runtime, not
 * Weave's, so it depends only on what that runtime provides. It must never
 * throw: an exception while OpenCode loads plugins can make it skip plugin
 * loading and fall back to its default agent. `appendFileSync` keeps every
 * record on disk even if the container is killed at the timeout.
 */
export const OBSERVER_PLUGIN_SOURCE = `// Written by the Weave trajectory eval runner (Spec 35). Do not edit.
import { appendFileSync } from "node:fs";

const OUT = "/artifacts/${OBSERVER_RECORDS_FILE}";

export const WeaveTrajectoryObserver = async () => ({
  "tool.execute.after": async (input, output) => {
    try {
      const tool = String(input?.tool ?? "");
      const shell = ${JSON.stringify([...OBSERVER_SHELL_TOOLS])}.includes(tool);
      const file = ${JSON.stringify([...OBSERVER_FILE_TOOLS])}.includes(tool);
      const args = input?.args ?? {};
      const exit = output?.metadata?.exit;
      const patchText = [args.patchText, args.patch, args.input].find((v) => typeof v === "string");
      const patchPath = patchText?.match(/\\*\\*\\* (?:Add|Update|Delete) File: (.+)/)?.[1];
      const path = [args.filePath, args.path, patchPath].find((v) => typeof v === "string");
      const record = {
        sessionID: String(input?.sessionID ?? ""),
        callID: String(input?.callID ?? ""),
        tool,
        timestamp: new Date().toISOString(),
        ...(shell && typeof args.command === "string" ? { command: args.command } : {}),
        ...(shell && typeof exit === "number" ? { exitCode: exit } : {}),
        ...(file && path !== undefined ? { path } : {}),
      };
      appendFileSync(OUT, JSON.stringify(record) + "\\n");
    } catch {
      // Observation is best effort; never disturb the session.
    }
  },
});
`;

export const ObserverRecordSchema = z
  .object({
    sessionID: z.string().min(1),
    callID: z.string(),
    tool: z.string().min(1),
    timestamp: z.iso.datetime({ offset: true }),
    command: z.string().optional(),
    exitCode: z.number().int().optional(),
    path: z.string().optional(),
  })
  .strict();

export type ObserverRecord = z.infer<typeof ObserverRecordSchema>;

export interface ParsedObserverRecords {
  records: ObserverRecord[];
  /** Lines that were not valid JSON or did not match the record schema. */
  malformedLines: number;
}

/**
 * Parses the observer's JSONL output. Tolerant by design: a malformed line
 * (for example one truncated by a timeout kill) is counted and skipped, not
 * fatal.
 */
export function parseObserverRecords(jsonl: string): ParsedObserverRecords {
  const records: ObserverRecord[] = [];
  let malformedLines = 0;

  for (const line of jsonl.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    const parsed = ObserverRecordSchema.safeParse(candidate);
    if (!parsed.success) {
      malformedLines += 1;
      continue;
    }
    records.push(parsed.data);
  }

  return { records, malformedLines };
}

function boundCommand(command: string): string {
  const redacted = redactSecrets(command);
  return redacted.length > OBSERVER_COMMAND_MAX_CHARS
    ? redacted.slice(0, OBSERVER_COMMAND_MAX_CHARS)
    : redacted;
}

/** Session id → agent name, from the Channel-A session events. */
function sessionAgents(
  events: readonly TrajectoryEvent[],
): Map<string, string> {
  const agents = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "session-created") {
      agents.set(event.sessionId, event.agentName);
    }
    if (event.kind === "subagent-spawned") {
      agents.set(event.sessionId, event.childAgentName);
    }
  }
  return agents;
}

/**
 * Merges observer records into the Channel-A event stream as
 * `tool-call-after` events carrying `detail`, ordered by timestamp. Agent
 * names come from the session events; a record for an unknown session gets
 * `"unknown"`. Command text is secret-redacted and bounded before it enters
 * an event.
 */
export function joinObserverRecords(
  events: readonly TrajectoryEvent[],
  records: readonly ObserverRecord[],
): TrajectoryEvent[] {
  const agents = sessionAgents(events);

  const afterEvents: TrajectoryEvent[] = records.map((record) => {
    // Only shell tools carry command detail, even if an older observer
    // recorded a `command` argument for another tool.
    const shell = OBSERVER_SHELL_TOOLS.has(record.tool);
    const detail = {
      ...(shell && record.command !== undefined
        ? { command: boundCommand(record.command) }
        : {}),
      ...(shell && record.exitCode !== undefined
        ? { exitCode: record.exitCode }
        : {}),
      ...(OBSERVER_FILE_TOOLS.has(record.tool) && record.path !== undefined
        ? { path: record.path.slice(0, OBSERVER_COMMAND_MAX_CHARS) }
        : {}),
    };
    return {
      kind: "tool-call-after",
      sessionId: record.sessionID,
      timestamp: record.timestamp,
      toolName: record.tool,
      agentName: agents.get(record.sessionID) ?? "unknown",
      succeeded:
        !shell || record.exitCode === undefined || record.exitCode === 0,
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    };
  });

  // Stable merge by timestamp: Array.prototype.sort is stable, so events
  // with equal timestamps keep log order, with observer events after them.
  return [...events, ...afterEvents].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
}
