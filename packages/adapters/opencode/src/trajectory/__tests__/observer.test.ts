import { describe, expect, it } from "bun:test";
import type { TrajectoryEvent } from "@weaveio/weave-core";
import {
  joinObserverRecords,
  OBSERVER_COMMAND_MAX_CHARS,
  OBSERVER_PLUGIN_SOURCE,
  type ObserverRecord,
  parseObserverRecords,
} from "../observer.js";

const LOOM_SESSION = "ses_loom";
const SHUTTLE_SESSION = "ses_shuttle";

const channelAEvents: TrajectoryEvent[] = [
  {
    kind: "session-created",
    sessionId: LOOM_SESSION,
    timestamp: "2026-09-12T22:21:29.000Z",
    agentName: "loom",
    model: "unknown",
  },
  {
    kind: "subagent-spawned",
    sessionId: SHUTTLE_SESSION,
    timestamp: "2026-09-12T22:21:34.000Z",
    parentAgentName: "loom",
    childAgentName: "shuttle",
  },
  {
    kind: "tool-call-before",
    sessionId: SHUTTLE_SESSION,
    timestamp: "2026-09-12T22:21:40.000Z",
    toolName: "bash",
    agentName: "shuttle",
  },
  {
    kind: "session-completed",
    sessionId: LOOM_SESSION,
    timestamp: "2026-09-12T22:21:56.000Z",
    agentName: "loom",
    durationMs: 27000,
  },
];

function record(overrides: Partial<ObserverRecord> = {}): ObserverRecord {
  return {
    sessionID: SHUTTLE_SESSION,
    callID: "toolu_1",
    tool: "bash",
    timestamp: "2026-09-12T22:21:44.000Z",
    command: "bun test",
    exitCode: 0,
    ...overrides,
  };
}

describe("parseObserverRecords", () => {
  it("keeps valid records and counts malformed or truncated lines", () => {
    const jsonl = [
      JSON.stringify(record()),
      "",
      "{not json",
      JSON.stringify({ sessionID: "s", tool: "bash" }),
      JSON.stringify(
        record({
          callID: "toolu_2",
          tool: "edit",
          command: undefined,
          exitCode: undefined,
        }),
      ),
      '{"sessionID":"ses_shuttle","callID":"toolu_3","tool":"ba',
    ].join("\n");

    const parsed = parseObserverRecords(jsonl);
    expect(parsed.records.map((r) => r.callID)).toEqual(["toolu_1", "toolu_2"]);
    expect(parsed.malformedLines).toBe(3);
  });

  it("rejects records with unknown keys such as raw output", () => {
    const parsed = parseObserverRecords(
      JSON.stringify({ ...record(), output: "raw tool output" }),
    );
    expect(parsed.records).toEqual([]);
    expect(parsed.malformedLines).toBe(1);
  });
});

describe("joinObserverRecords", () => {
  it("emits tool-call-after events with detail, attributed by session", () => {
    const events = joinObserverRecords(channelAEvents, [
      record({ exitCode: 1 }),
      record({
        callID: "toolu_x",
        sessionID: "ses_unknown",
        tool: "read",
        command: undefined,
        exitCode: undefined,
        timestamp: "2026-09-12T22:21:45.000Z",
      }),
    ]);

    const afters = events.filter((event) => event.kind === "tool-call-after");
    expect(afters).toHaveLength(2);
    expect(afters[0]).toEqual({
      kind: "tool-call-after",
      sessionId: SHUTTLE_SESSION,
      timestamp: "2026-09-12T22:21:44.000Z",
      toolName: "bash",
      agentName: "shuttle",
      succeeded: false,
      detail: { command: "bun test", exitCode: 1 },
    });
    expect(afters[1]).toMatchObject({
      toolName: "read",
      agentName: "unknown",
      succeeded: true,
    });
    expect(afters[1]).not.toHaveProperty("detail");
  });

  it("keeps command detail off non-shell tools such as task", () => {
    const [task] = joinObserverRecords(
      [],
      [
        record({
          tool: "task",
          command: "Delegate this: fix it, then run bun run check",
          exitCode: undefined,
        }),
      ],
    ).filter((event) => event.kind === "tool-call-after");
    expect(task).toMatchObject({ toolName: "task", succeeded: true });
    expect(task).not.toHaveProperty("detail");
  });

  it("orders merged events by timestamp", () => {
    const events = joinObserverRecords(channelAEvents, [record()]);
    expect(events.map((event) => event.kind)).toEqual([
      "session-created",
      "subagent-spawned",
      "tool-call-before",
      "tool-call-after",
      "session-completed",
    ]);
  });

  it("redacts secrets and bounds command text", () => {
    const secret = "sk-or-v1-0123456789abcdef0123456789abcdef";
    const [redacted] = joinObserverRecords(
      [],
      [record({ command: `curl -H "Authorization: Bearer ${secret}" x` })],
    ).filter((event) => event.kind === "tool-call-after");
    expect(JSON.stringify(redacted)).not.toContain(secret);

    const [bounded] = joinObserverRecords(
      [],
      // Non-hex filler: a long hex run would be redacted as a secret instead.
      [record({ command: `echo ${"z".repeat(2000)}` })],
    ).filter((event) => event.kind === "tool-call-after");
    const detail =
      bounded?.kind === "tool-call-after" ? bounded.detail : undefined;
    expect(detail?.command?.length).toBe(OBSERVER_COMMAND_MAX_CHARS);
  });
});

describe("OBSERVER_PLUGIN_SOURCE", () => {
  it("transpiles and exports the observer plugin", () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const scan = transpiler.scan(OBSERVER_PLUGIN_SOURCE);
    expect(scan.exports).toEqual(["WeaveTrajectoryObserver"]);
    expect(OBSERVER_PLUGIN_SOURCE).toContain('"tool.execute.after"');
    expect(OBSERVER_PLUGIN_SOURCE).toContain("/artifacts/tool-calls.jsonl");
  });

  it("records command and exit code only for shell tools", async () => {
    // Load the generated plugin with its file write swapped for a capture,
    // then drive the hook the way OpenCode does.
    const lines: string[] = [];
    const source = OBSERVER_PLUGIN_SOURCE.replace(
      'import { appendFileSync } from "node:fs";',
      "const appendFileSync = (_path, line) => globalThis.__observerLines.push(line);",
    );
    (globalThis as { __observerLines?: string[] }).__observerLines = lines;
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    const url = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
    const { WeaveTrajectoryObserver } = await import(url);
    const hooks = await WeaveTrajectoryObserver();
    const after = hooks["tool.execute.after"];

    await after(
      {
        tool: "bash",
        sessionID: "s",
        callID: "c1",
        args: { command: "bun test" },
      },
      { metadata: { exit: 1 } },
    );
    await after(
      {
        tool: "task",
        sessionID: "s",
        callID: "c2",
        args: { command: "run bun test" },
      },
      { metadata: {} },
    );

    await after(
      {
        tool: "edit",
        sessionID: "s",
        callID: "c3",
        args: { filePath: "/workspace/.weave/plans/p.md" },
      },
      { metadata: {} },
    );
    await after(
      {
        tool: "apply_patch",
        sessionID: "s",
        callID: "c4",
        args: {
          patchText: "*** Begin Patch\n*** Update File: src/slugify.ts\n@@",
        },
      },
      { metadata: {} },
    );

    const [bash, task, edit, patch] = lines.map((line) => JSON.parse(line));
    expect(edit).toMatchObject({ path: "/workspace/.weave/plans/p.md" });
    expect(patch).toMatchObject({ path: "src/slugify.ts" });
    expect(bash).toMatchObject({
      tool: "bash",
      command: "bun test",
      exitCode: 1,
    });
    expect(task).toMatchObject({ tool: "task" });
    expect(task).not.toHaveProperty("command");
  });
});
