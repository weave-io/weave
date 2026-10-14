import { describe, expect, it } from "bun:test";
import {
  classifySessionErrors,
  MessageEmittedEventSchema,
  recoveredErrorWarnings,
  SessionCompletedEventSchema,
  SessionCreatedEventSchema,
  SessionErroredEventSchema,
  SubagentSpawnedEventSchema,
  ToolCallAfterEventSchema,
  ToolCallBeforeEventSchema,
  ToolCallDetailSchema,
  type TrajectoryEvent,
  TrajectoryEventSchema,
  TrajectoryResultSchema,
  TrajectorySummarySchema,
} from "../trajectory-events.js";

const TS = "2026-09-03T12:00:00Z";

describe("TrajectoryEvent schemas — valid instances", () => {
  it("accepts a valid session-created event", () => {
    const event = {
      sessionId: "s1",
      timestamp: TS,
      kind: "session-created",
      agentName: "loom",
      model: "claude-sonnet-4-5",
    };
    expect(SessionCreatedEventSchema.safeParse(event).success).toBe(true);
    expect(TrajectoryEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a valid subagent-spawned event", () => {
    const event = {
      sessionId: "s1",
      timestamp: TS,
      kind: "subagent-spawned",
      parentAgentName: "loom",
      childAgentName: "shuttle",
    };
    expect(SubagentSpawnedEventSchema.safeParse(event).success).toBe(true);
    expect(TrajectoryEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a valid tool-call-before event", () => {
    const event = {
      sessionId: "s1",
      timestamp: TS,
      kind: "tool-call-before",
      toolName: "edit",
      agentName: "shuttle",
    };
    expect(ToolCallBeforeEventSchema.safeParse(event).success).toBe(true);
    expect(TrajectoryEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a valid tool-call-after event", () => {
    const event = {
      sessionId: "s1",
      timestamp: TS,
      kind: "tool-call-after",
      toolName: "edit",
      agentName: "shuttle",
      succeeded: true,
    };
    expect(ToolCallAfterEventSchema.safeParse(event).success).toBe(true);
    expect(TrajectoryEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a valid message-emitted event", () => {
    const event = {
      sessionId: "s1",
      timestamp: TS,
      kind: "message-emitted",
      role: "assistant",
      agentName: "spindle",
    };
    expect(MessageEmittedEventSchema.safeParse(event).success).toBe(true);
    expect(TrajectoryEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a valid session-completed event", () => {
    const event = {
      sessionId: "s1",
      timestamp: TS,
      kind: "session-completed",
      agentName: "loom",
      durationMs: 1234,
    };
    expect(SessionCompletedEventSchema.safeParse(event).success).toBe(true);
    expect(TrajectoryEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a valid session-errored event", () => {
    const event = {
      sessionId: "s1",
      timestamp: TS,
      kind: "session-errored",
      agentName: "loom",
      errorKind: "timeout",
    };
    expect(SessionErroredEventSchema.safeParse(event).success).toBe(true);
    expect(TrajectoryEventSchema.safeParse(event).success).toBe(true);
  });
});

describe("TrajectoryEvent schemas — invalid discriminant", () => {
  it("rejects an unknown kind value", () => {
    const event = {
      sessionId: "s1",
      timestamp: TS,
      kind: "session-teleported",
      agentName: "loom",
    };
    const result = TrajectoryEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("rejects an event with a missing kind field", () => {
    const event = {
      sessionId: "s1",
      timestamp: TS,
      agentName: "loom",
      model: "claude-sonnet-4-5",
    };
    const result = TrajectoryEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });
});

describe("TrajectoryEvent schemas — malformed timestamp", () => {
  it("rejects a non-ISO-8601 timestamp on session-created", () => {
    const event = {
      sessionId: "s1",
      timestamp: "not-a-date",
      kind: "session-created",
      agentName: "loom",
      model: "claude-sonnet-4-5",
    };
    const result = SessionCreatedEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });

  it("rejects a bare date without time on session-completed", () => {
    const event = {
      sessionId: "s1",
      timestamp: "2026-09-03",
      kind: "session-completed",
      agentName: "loom",
      durationMs: 100,
    };
    const result = SessionCompletedEventSchema.safeParse(event);
    expect(result.success).toBe(false);
  });
});

describe("TrajectorySummary", () => {
  it("accepts exactly the four publishable fields", () => {
    const summary = {
      harnessDelegatedCorrectly: true,
      observedSpawns: ["shuttle"],
      observedToolCalls: 3,
      harnessCompletedWithoutError: true,
    };
    expect(TrajectorySummarySchema.safeParse(summary).success).toBe(true);
  });

  it("rejects an extra unlisted field (strict mode)", () => {
    const summary = {
      harnessDelegatedCorrectly: true,
      observedSpawns: [],
      observedToolCalls: 0,
      harnessCompletedWithoutError: false,
      rationale: "should not be here",
    };
    expect(TrajectorySummarySchema.safeParse(summary).success).toBe(false);
  });
});

describe("TrajectoryResult", () => {
  it("accepts a full valid result with event stream, summary, and raw artifact ref", () => {
    const result = {
      events: [
        {
          sessionId: "s1",
          timestamp: TS,
          kind: "session-created",
          agentName: "loom",
          model: "claude-sonnet-4-5",
        },
      ],
      summary: {
        harnessDelegatedCorrectly: true,
        observedSpawns: ["shuttle"],
        observedToolCalls: 2,
        harnessCompletedWithoutError: true,
      },
      rawArtifactRef: { path: "loom-routing/trajectory.jsonl" },
    };
    expect(TrajectoryResultSchema.safeParse(result).success).toBe(true);
  });

  it("accepts an optional local-only verifier outcome and rejects unknown keys in it", () => {
    const base = {
      events: [],
      summary: {
        harnessDelegatedCorrectly: true,
        observedSpawns: [],
        observedToolCalls: 0,
        harnessCompletedWithoutError: true,
      },
      rawArtifactRef: { path: "shuttle-execution/stderr.log" },
    };
    expect(
      TrajectoryResultSchema.safeParse({ ...base, verifier: { passed: true } })
        .success,
    ).toBe(true);
    expect(
      TrajectoryResultSchema.safeParse({
        ...base,
        verifier: { passed: false, output: "raw verifier text" },
      }).success,
    ).toBe(false);
  });
});

describe("Tool-call detail", () => {
  const after = {
    sessionId: "s2",
    timestamp: TS,
    kind: "tool-call-after",
    toolName: "bash",
    agentName: "shuttle",
    succeeded: false,
  };

  it("accepts command and exit code on tool-call-after and command on tool-call-before", () => {
    expect(
      ToolCallAfterEventSchema.safeParse({
        ...after,
        detail: { command: "bun test", exitCode: 1 },
      }).success,
    ).toBe(true);
    expect(
      ToolCallBeforeEventSchema.safeParse({
        sessionId: "s2",
        timestamp: TS,
        kind: "tool-call-before",
        toolName: "bash",
        agentName: "shuttle",
        detail: { command: "bun test" },
      }).success,
    ).toBe(true);
  });

  it("rejects unknown detail keys, over-long commands, and non-integer exit codes", () => {
    expect(
      ToolCallDetailSchema.safeParse({ command: "bun test", output: "x" })
        .success,
    ).toBe(false);
    expect(
      ToolCallDetailSchema.safeParse({ command: "x".repeat(501) }).success,
    ).toBe(false);
    expect(ToolCallDetailSchema.safeParse({ exitCode: 1.5 }).success).toBe(
      false,
    );
  });

  it("keeps detail out of the publishable summary", () => {
    expect(
      TrajectorySummarySchema.safeParse({
        harnessDelegatedCorrectly: true,
        observedSpawns: [],
        observedToolCalls: 1,
        harnessCompletedWithoutError: true,
        detail: { command: "bun test", exitCode: 0 },
      }).success,
    ).toBe(false);
  });
});

describe("classifySessionErrors (issue #324)", () => {
  const errored = (sessionId: string, timestamp: string): TrajectoryEvent => ({
    sessionId,
    timestamp,
    kind: "session-errored",
    agentName: "loom",
    errorKind: "stream error",
  });
  const completed = (
    sessionId: string,
    timestamp: string,
  ): TrajectoryEvent => ({
    sessionId,
    timestamp,
    kind: "session-completed",
    agentName: "loom",
    durationMs: 1,
  });

  it("treats an error followed by its session's completion as recovered", () => {
    const events = [
      errored("a", "2026-01-01T00:00:01Z"),
      completed("a", "2026-01-01T00:00:02Z"),
    ];
    const { recovered, unrecovered } = classifySessionErrors(events);
    expect(recovered).toHaveLength(1);
    expect(unrecovered).toHaveLength(0);
    expect(recoveredErrorWarnings(events)).toEqual([
      "loom session logged an error and recovered (a later session-completed followed)",
    ]);
  });

  it("treats an error with no later completion of the same session as unrecovered", () => {
    const events = [
      completed("a", "2026-01-01T00:00:00Z"),
      errored("a", "2026-01-01T00:00:01Z"),
      completed("b", "2026-01-01T00:00:02Z"),
    ];
    const { recovered, unrecovered } = classifySessionErrors(events);
    expect(recovered).toHaveLength(0);
    expect(unrecovered).toHaveLength(1);
    expect(recoveredErrorWarnings(events)).toEqual([]);
  });
});

describe("TrajectorySummarySchema warnings (issue #324)", () => {
  const base = {
    harnessDelegatedCorrectly: true,
    observedSpawns: [],
    observedToolCalls: 0,
    harnessCompletedWithoutError: true,
  };
  it("accepts optional warnings and rejects non-string entries", () => {
    expect(
      TrajectorySummarySchema.safeParse({ ...base, warnings: ["w"] }).success,
    ).toBe(true);
    expect(TrajectorySummarySchema.safeParse(base).success).toBe(true);
    expect(
      TrajectorySummarySchema.safeParse({ ...base, warnings: [1] }).success,
    ).toBe(false);
  });
});
