/**
 * Channel-A trajectory log parser.
 *
 * Maps OpenCode's `key=value` DEBUG/INFO stderr log lines to normalized
 * `TrajectoryEvent` records (see @weaveio/weave-core `trajectory-events.ts`).
 *
 * Design notes:
 * - OpenCode's plain-text log lines do not carry an explicit "kind" field.
 *   This parser recognizes a small set of `message=` values and field
 *   combinations and maps them onto the TrajectoryEvent union:
 *     - `message=created` with `parentID` set (not "undefined") -> subagent-spawned
 *     - `message=created` with no parent -> session-created (pass-through)
 *     - `message=evaluated` with a `permission=` field -> tool-call-before
 *       (the permission check that gates a tool call is used as the
 *       "before" signal; `permission` value becomes `toolName`)
 *     - `message="exiting loop"` -> session-completed (durationMs computed
 *       from the tracked session-created timestamp)
 *     - `level=ERROR` -> session-errored (pass-through, `errorKind` taken
 *       from the `message` field)
 *     - `message=process` (has a `messageID` field) -> message-emitted
 *       (pass-through, minimal fields only)
 *   Any other recognized-but-unmapped line is silently skipped (not an
 *   error): OpenCode logs many operational lines (LSP status, watcher
 *   backend, formatting, etc.) that carry no trajectory-relevant signal.
 * - Lines that do not start with `timestamp=` are treated as decorative
 *   terminal output (banners, spinners, checkmarks) and skipped, not
 *   treated as parse errors.
 * - Lines that start with `timestamp=` but fail to tokenize (unterminated
 *   quote, stray token without `=`) produce a typed `TrajectoryParseError`.
 * - Lines that tokenize but produce a payload that fails
 *   `TrajectoryEventSchema` validation (e.g. malformed timestamp) also
 *   produce a typed `TrajectoryParseError`.
 * - Session/agent context (`sessionAgent`, `sessionCreatedAt`,
 *   `currentSessionId`) is tracked across lines in-memory only, for the
 *   duration of this pure function call. No I/O, no external state.
 *
 * Errors accumulate across the whole input; parsing does not stop at the
 * first malformed line. The final Result is `err` iff at least one error
 * was accumulated, otherwise `ok` with all successfully parsed events.
 */

import {
  type TrajectoryEvent,
  type TrajectoryEventParseError,
  TrajectoryEventSchema,
} from "@weaveio/weave-core";
import { err, ok, type Result } from "neverthrow";

export type TrajectoryParseError = TrajectoryEventParseError;

const UNDEFINED_TOKEN = "undefined";

/**
 * Tokenizes a single `key=value` log line into a flat string record.
 * Values may be double-quoted (with backslash-escaped inner quotes);
 * unquoted values run until the next whitespace.
 */
function tokenizeLogLine(
  line: string,
): Result<Record<string, string>, { message: string }> {
  const fields: Record<string, string> = {};
  let i = 0;
  const n = line.length;

  while (i < n) {
    while (i < n && line[i] === " ") i++;
    if (i >= n) break;

    const eqIndex = line.indexOf("=", i);
    if (eqIndex === -1) {
      return err({ message: `stray token without '=' near index ${i}` });
    }
    const key = line.slice(i, eqIndex);
    if (key.length === 0 || key.includes(" ")) {
      return err({ message: `invalid key near index ${i}` });
    }
    i = eqIndex + 1;

    if (i < n && line[i] === '"') {
      i++;
      let value = "";
      let closed = false;
      while (i < n) {
        const ch = line[i];
        if (ch === "\\" && i + 1 < n) {
          value += line[i + 1];
          i += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        value += ch;
        i++;
      }
      if (!closed) {
        return err({ message: `unterminated quoted value for key "${key}"` });
      }
      fields[key] = value;
      continue;
    }

    const spaceIndex = line.indexOf(" ", i);
    const end = spaceIndex === -1 ? n : spaceIndex;
    fields[key] = line.slice(i, end);
    i = end;
  }

  return ok(fields);
}

interface ParserState {
  sessionAgent: Map<string, string>;
  sessionCreatedAt: Map<string, string>;
  currentSessionId: string | undefined;
}

function resolveAgentName(
  state: ParserState,
  sessionId: string | undefined,
): string {
  if (sessionId === undefined) return "unknown";
  return state.sessionAgent.get(sessionId) ?? "unknown";
}

function buildEventForLine(
  fields: Record<string, string>,
  state: ParserState,
  lineNumber: number,
): Result<TrajectoryEvent | undefined, TrajectoryEventParseError> {
  const timestamp = fields["timestamp"];
  if (timestamp === undefined) {
    return err({
      type: "TrajectoryEventParseError",
      path: `line:${lineNumber}`,
      message: "missing required 'timestamp' field",
    });
  }

  if (fields["session.id"] !== undefined) {
    state.currentSessionId = fields["session.id"];
  }

  const message = fields["message"];

  if (message === "created" && fields["id"] !== undefined) {
    const sessionId = fields["id"];
    const agentName =
      fields["agent"] === UNDEFINED_TOKEN || fields["agent"] === undefined
        ? "unknown"
        : fields["agent"];
    const parentID = fields["parentID"];
    state.sessionAgent.set(sessionId, agentName);
    state.sessionCreatedAt.set(sessionId, timestamp);

    if (parentID !== undefined && parentID !== UNDEFINED_TOKEN) {
      const parentAgentName = resolveAgentName(state, parentID);
      const candidate = {
        kind: "subagent-spawned" as const,
        sessionId,
        timestamp,
        parentAgentName,
        childAgentName: agentName,
      };
      const parsed = TrajectoryEventSchema.safeParse(candidate);
      if (!parsed.success) {
        return err({
          type: "TrajectoryEventParseError",
          path: `line:${lineNumber}`,
          message: parsed.error.message,
        });
      }
      return ok(parsed.data);
    }

    const candidate = {
      kind: "session-created" as const,
      sessionId,
      timestamp,
      agentName,
      model:
        fields["model"] === UNDEFINED_TOKEN || fields["model"] === undefined
          ? "unknown"
          : fields["model"],
    };
    const parsed = TrajectoryEventSchema.safeParse(candidate);
    if (!parsed.success) {
      return err({
        type: "TrajectoryEventParseError",
        path: `line:${lineNumber}`,
        message: parsed.error.message,
      });
    }
    return ok(parsed.data);
  }

  if (message === "evaluated" && fields["permission"] !== undefined) {
    const sessionId = state.currentSessionId ?? "unknown";
    const candidate = {
      kind: "tool-call-before" as const,
      sessionId,
      timestamp,
      toolName: fields["permission"],
      agentName: resolveAgentName(state, sessionId),
    };
    const parsed = TrajectoryEventSchema.safeParse(candidate);
    if (!parsed.success) {
      return err({
        type: "TrajectoryEventParseError",
        path: `line:${lineNumber}`,
        message: parsed.error.message,
      });
    }
    return ok(parsed.data);
  }

  if (message === "exiting loop") {
    const sessionId =
      fields["session.id"] ?? state.currentSessionId ?? "unknown";
    const createdAt = state.sessionCreatedAt.get(sessionId);
    const durationMs =
      createdAt !== undefined
        ? Date.parse(timestamp) - Date.parse(createdAt)
        : 0;
    const candidate = {
      kind: "session-completed" as const,
      sessionId,
      timestamp,
      agentName: resolveAgentName(state, sessionId),
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    };
    const parsed = TrajectoryEventSchema.safeParse(candidate);
    if (!parsed.success) {
      return err({
        type: "TrajectoryEventParseError",
        path: `line:${lineNumber}`,
        message: parsed.error.message,
      });
    }
    return ok(parsed.data);
  }

  if (fields["level"] === "ERROR") {
    const sessionId =
      fields["session.id"] ?? state.currentSessionId ?? "unknown";
    const candidate = {
      kind: "session-errored" as const,
      sessionId,
      timestamp,
      agentName: resolveAgentName(state, sessionId),
      errorKind: message ?? "unknown",
    };
    const parsed = TrajectoryEventSchema.safeParse(candidate);
    if (!parsed.success) {
      return err({
        type: "TrajectoryEventParseError",
        path: `line:${lineNumber}`,
        message: parsed.error.message,
      });
    }
    return ok(parsed.data);
  }

  if (message === "process" && fields["messageID"] !== undefined) {
    const sessionId =
      fields["session.id"] ?? state.currentSessionId ?? "unknown";
    const candidate = {
      kind: "message-emitted" as const,
      sessionId,
      timestamp,
      role: "assistant" as const,
      agentName: resolveAgentName(state, sessionId),
    };
    const parsed = TrajectoryEventSchema.safeParse(candidate);
    if (!parsed.success) {
      return err({
        type: "TrajectoryEventParseError",
        path: `line:${lineNumber}`,
        message: parsed.error.message,
      });
    }
    return ok(parsed.data);
  }

  return ok(undefined);
}

/**
 * Parses OpenCode's Channel-A `key=value` DEBUG/INFO stderr log lines into
 * normalized `TrajectoryEvent` records. Pure function: no I/O, no process
 * spawning, no logger side effects.
 */
export function parseTrajectoryEvents(
  stderr: string,
): Result<TrajectoryEvent[], TrajectoryParseError[]> {
  const events: TrajectoryEvent[] = [];
  const errors: TrajectoryEventParseError[] = [];
  const state: ParserState = {
    sessionAgent: new Map(),
    sessionCreatedAt: new Map(),
    currentSessionId: undefined,
  };

  const lines = stderr.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith("timestamp=")) continue;

    const tokenized = tokenizeLogLine(trimmed);
    if (tokenized.isErr()) {
      errors.push({
        type: "TrajectoryEventParseError",
        path: `line:${lineNumber}`,
        message: tokenized.error.message,
      });
      continue;
    }

    const built = buildEventForLine(tokenized.value, state, lineNumber);
    if (built.isErr()) {
      errors.push(built.error);
      continue;
    }
    if (built.value !== undefined) {
      events.push(built.value);
    }
  }

  if (errors.length > 0) return err(errors);
  return ok(events);
}
