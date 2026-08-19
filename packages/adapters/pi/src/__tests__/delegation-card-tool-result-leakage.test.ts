/**
 * The delegation card is a PARENT boundary, and a child tool result is child
 * payload.
 *
 * Every frame the card publishes carries two things across that boundary: the
 * model-visible activity line the parent model reads as ordinary tool output,
 * and the `details` payload Pi persists with the transcript entry and replays
 * in a later session. A child tool result is arbitrary bytes - a shell
 * transcript, a file the child read, a raw provider error body, an exception
 * with stack frames. None of it may be copied into either surface.
 *
 * The user's standing scope exception covers ordinary tool output INSIDE the
 * child transcript, which the human opens deliberately. It does not permit
 * copying those same bytes into the parent's model-visible activity or into
 * persisted delegation-card details, so both are asserted here.
 *
 * The guarantee is structural: tool payload prose and tool activity are never
 * read into the parent card model at all, so these tests do not check that a
 * redactor caught a pattern. They check that a payload known to contain a
 * hostile value cannot appear in either surface, and that partial card frames
 * stay the adapter-authored content-free marker.
 */
import { describe, expect, it } from "bun:test";
import {
  PiChildCardProjection,
  type PiChildCardProjectionConfig,
} from "../child-card-model.js";
import type { PiChildSessionEvent } from "../child-session-events.js";
import type { TimerHandle, TimerPort } from "../child-timer.js";
import {
  boundDelegationCardDetails,
  PiDelegationCardStream,
} from "../delegation-tool.js";
import type { PiToolResult } from "../types.js";

class ImmediateTimerPort implements TimerPort {
  private pending: (() => void)[] = [];
  schedule(callback: () => void, _delayMs: number): TimerHandle {
    let live = true;
    this.pending.push(() => {
      if (live) callback();
    });
    return {
      cancel: () => {
        live = false;
      },
    };
  }
  fireAll(maxRounds = 8): void {
    for (let round = 0; round < maxRounds && this.pending.length > 0; round++) {
      const due = this.pending;
      this.pending = [];
      for (const tick of due) tick();
    }
  }
}

function clock(): () => number {
  let now = 1_000;
  return () => {
    now += 25;
    return now;
  };
}

function projectionConfig(): PiChildCardProjectionConfig {
  return {
    threadId: "thread-opaque-1",
    agentName: "shuttle",
    assignment: "Repair the failing settlement gate.",
    runNumber: 1,
    action: "start",
    now: clock(),
  };
}

function toolCall(toolName: string, id = "call-1"): PiChildSessionEvent {
  return {
    type: "tool_call",
    toolCallId: id,
    toolName,
    arguments: { path: "/Users/secretuser/projects/acme/src/index.ts" },
  } as unknown as PiChildSessionEvent;
}

function toolResult(result: unknown, id = "call-1"): PiChildSessionEvent {
  return {
    type: "tool_result",
    toolCallId: id,
    result,
  } as unknown as PiChildSessionEvent;
}

function toolPartial(partial: unknown, id = "call-1"): PiChildSessionEvent {
  return {
    type: "tool_partial_result",
    toolCallId: id,
    partialResult: partial,
  } as unknown as PiChildSessionEvent;
}

function toolError(message: string, id = "call-1"): PiChildSessionEvent {
  return {
    type: "tool_error",
    toolCallId: id,
    error: message,
  } as unknown as PiChildSessionEvent;
}

/**
 * Everything one card publishes across the parent boundary, as one string:
 * the model-visible text of every frame plus the persisted details bytes.
 */
function publishedSurface(events: readonly PiChildSessionEvent[]): {
  readonly modelVisible: string;
  readonly persisted: string;
} {
  const updates: PiToolResult[] = [];
  const timer = new ImmediateTimerPort();
  const stream = new PiDelegationCardStream({
    ...projectionConfig(),
    timerPort: timer,
    onUpdate: (update) => updates.push(update),
  });
  stream.start();
  // Every frame is flushed, not only the last one: an intermediate frame is
  // published to the model and persisted exactly like a final one.
  for (const event of events) {
    stream.applyEvent(event);
    timer.fireAll();
  }
  stream.settle({
    outcome: "completed",
    assistantOutput: "done",
  } as never);
  timer.fireAll();
  stream.dispose();

  const modelVisible = updates
    .flatMap((update) => update.content.map((part) => part.text))
    .join("\n");
  const persisted = JSON.stringify(
    updates.map((update) => update.details ?? null),
  );
  return { modelVisible, persisted };
}

/** The same facts read straight off the projection, without the stream. */
function projectedSurface(events: readonly PiChildSessionEvent[]): string {
  const projection = new PiChildCardProjection(projectionConfig());
  for (const event of events) projection.applySessionEvent(event);
  return JSON.stringify(boundDelegationCardDetails(projection.facts()));
}

interface LeakCase {
  readonly name: string;
  /** The hostile payload a child tool result carries. */
  readonly payload: unknown;
  /** Substrings that must not survive into either parent surface. */
  readonly forbidden: readonly string[];
}

const POSIX_PATH = "/Users/jose/projects/acme/.env.production";
const WINDOWS_PATH = "C:\\Users\\jose\\AppData\\Roaming\\acme\\creds.json";
const URL_CREDENTIALS = "https://deploy:hunter2@internal.acme.test/artifacts";
const URL_QUERY_TOKEN =
  "https://api.acme.test/v1/jobs?access_token=eyJhbGciOiJIUzI1NiJ9.payload.sig";
const OPENAI_KEY = "sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GITHUB_TOKEN = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";
const PEM_BLOCK =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx7Qm\n-----END RSA PRIVATE KEY-----";
const STACK_FRAME =
  "TypeError: cannot read x\n    at load (/Users/jose/projects/acme/src/load.ts:42:11)\n    at run (node:internal/main:12:3)";
const RAW_PROVIDER_JSON =
  '{"error":{"type":"invalid_request_error","message":"org org-acme-9931 exceeded quota","param":"api_key sk-live-9931"}}';
const ANSI_OSC = "\u001b[31mfailed\u001b[0m\u001b]8;;file:///etc/shadow\u0007";

const LEAK_CASES: readonly LeakCase[] = [
  {
    name: "an absolute POSIX path",
    payload: `read 412 lines from ${POSIX_PATH}`,
    forbidden: [POSIX_PATH, "/Users/jose", ".env.production"],
  },
  {
    name: "an absolute Windows path",
    payload: `wrote ${WINDOWS_PATH}`,
    forbidden: [WINDOWS_PATH, "AppData", "creds.json"],
  },
  {
    name: "URL credentials",
    payload: `fetched ${URL_CREDENTIALS}`,
    forbidden: [URL_CREDENTIALS, "hunter2", "internal.acme.test"],
  },
  {
    name: "a URL query token",
    payload: URL_QUERY_TOKEN,
    forbidden: [URL_QUERY_TOKEN, "access_token", "eyJhbGciOiJIUzI1NiJ9"],
  },
  {
    name: "an OpenAI-shaped API key",
    payload: `authenticated with ${OPENAI_KEY}`,
    forbidden: [OPENAI_KEY, "sk-proj-"],
  },
  {
    name: "an AWS access key id",
    payload: `AWS_ACCESS_KEY_ID=${AWS_KEY}`,
    forbidden: [AWS_KEY, "AWS_ACCESS_KEY_ID"],
  },
  {
    name: "a GitHub token",
    payload: `remote rejected: ${GITHUB_TOKEN}`,
    forbidden: [GITHUB_TOKEN, "ghp_"],
  },
  {
    name: "PEM private-key text",
    payload: PEM_BLOCK,
    forbidden: ["BEGIN RSA PRIVATE KEY", "MIIEowIBAAKCAQEAx7Qm"],
  },
  {
    name: "stack frames",
    payload: STACK_FRAME,
    forbidden: ["    at load", "load.ts:42:11", "node:internal/main"],
  },
  {
    name: "a raw JSON provider error body",
    payload: RAW_PROVIDER_JSON,
    forbidden: [
      "invalid_request_error",
      "org-acme-9931",
      "sk-live-9931",
      "exceeded quota",
    ],
  },
  {
    name: "ANSI and OSC control sequences",
    payload: ANSI_OSC,
    forbidden: ["\u001b[31m", "\u001b]8;;", "/etc/shadow"],
  },
  {
    name: "a structured result object",
    payload: { stdout: POSIX_PATH, token: OPENAI_KEY },
    forbidden: [POSIX_PATH, OPENAI_KEY, "stdout"],
  },
];

describe("delegation card tool-result leakage", () => {
  for (const leak of LEAK_CASES) {
    it(`never publishes ${leak.name} from a tool result`, () => {
      const events = [toolCall("bash"), toolResult(leak.payload)];
      const { modelVisible, persisted } = publishedSurface(events);
      for (const forbidden of leak.forbidden) {
        expect(modelVisible).not.toContain(forbidden);
        expect(persisted).not.toContain(forbidden);
        expect(projectedSurface(events)).not.toContain(forbidden);
      }
    });

    it(`never publishes ${leak.name} from a tool error`, () => {
      const payload =
        typeof leak.payload === "string"
          ? leak.payload
          : JSON.stringify(leak.payload);
      const events = [toolCall("bash"), toolError(payload)];
      const { modelVisible, persisted } = publishedSurface(events);
      for (const forbidden of leak.forbidden) {
        expect(modelVisible).not.toContain(forbidden);
        expect(persisted).not.toContain(forbidden);
        expect(projectedSurface(events)).not.toContain(forbidden);
      }
    });

    it(`never publishes ${leak.name} from a partial tool result`, () => {
      const events = [toolCall("bash"), toolPartial(leak.payload)];
      const { modelVisible, persisted } = publishedSurface(events);
      for (const forbidden of leak.forbidden) {
        expect(modelVisible).not.toContain(forbidden);
        expect(persisted).not.toContain(forbidden);
        expect(projectedSurface(events)).not.toContain(forbidden);
      }
    });
  }

  it("never publishes benign tool output or tool activity", () => {
    const events = [
      toolCall("bash"),
      toolPartial("18 of 24 files scanned"),
      toolResult("1 replacement · +6 −3"),
    ];
    const { modelVisible, persisted } = publishedSurface(events);

    // Omission is unconditional: nothing decides that some payloads are safe.
    for (const surface of [modelVisible, persisted]) {
      expect(surface).not.toContain("18 of 24");
      expect(surface).not.toContain("1 replacement");
      expect(surface).not.toContain("bash");
    }
    // Every partial model update is the adapter-authored marker, not a child
    // tool row or status sentence.
    expect(modelVisible).toMatch(/^(…\n?)+$/u);
  });

  it("reports a failed tool without tool activity or its error payload", () => {
    const events = [toolCall("edit"), toolError(`EACCES ${POSIX_PATH}`)];
    const { modelVisible, persisted } = publishedSurface(events);

    expect(modelVisible).not.toContain("edit");
    expect(modelVisible).not.toContain("failed");
    expect(modelVisible).not.toContain("EACCES");
    expect(persisted).not.toContain("edit");
    expect(persisted).not.toContain("EACCES");
  });

  it("keeps the completed card's settlement evidence free of tool payload", () => {
    const timer = new ImmediateTimerPort();
    const updates: PiToolResult[] = [];
    const stream = new PiDelegationCardStream({
      ...projectionConfig(),
      timerPort: timer,
      onUpdate: (update) => updates.push(update),
    });
    stream.start();
    stream.applyEvent(toolCall("bash"));
    stream.applyEvent(
      toolResult(`token ${OPENAI_KEY} written to ${POSIX_PATH}`),
    );
    timer.fireAll();
    const details = stream.settle({
      outcome: "completed",
      assistantOutput: "repaired the gate",
    } as never);
    stream.dispose();

    const terminal = details?.facts.terminal;
    expect(terminal?.outcome).toBe("completed");
    // Settlement framing names only the authoritative settlement, never the
    // last child tool or anything it printed.
    expect(terminal?.evidence).toBe("authoritative settlement");
    expect(JSON.stringify(details)).not.toContain(OPENAI_KEY);
    expect(JSON.stringify(details)).not.toContain(POSIX_PATH);
  });
});
