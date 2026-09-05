import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTrajectoryEvents } from "../log-parser.js";

const fixturePath = resolve(
  import.meta.dir,
  "fixtures/spike-stderr-sample.txt",
);

function readFixture(): string {
  return readFileSync(fixturePath, "utf8");
}

describe("parseTrajectoryEvents", () => {
  it("parses the spike fixture without errors", () => {
    const result = parseTrajectoryEvents(readFixture());
    expect(result.isOk()).toBe(true);
  });

  it("produces a subagent-spawned event with childAgentName 'shuttle'", () => {
    const result = parseTrajectoryEvents(readFixture());
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const spawnEvents = result.value.filter(
      (e) => e.kind === "subagent-spawned",
    );
    expect(spawnEvents.length).toBeGreaterThanOrEqual(1);
    expect(spawnEvents.some((e) => e.childAgentName === "shuttle")).toBe(true);
  });

  it("produces at least one tool-call-before event", () => {
    const result = parseTrajectoryEvents(readFixture());
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const toolCalls = result.value.filter((e) => e.kind === "tool-call-before");
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("does not contain any bearer-token-shaped or sk- API key substrings", () => {
    const content = readFixture();
    expect(/Bearer\s+\S+/.test(content)).toBe(false);
    expect(/sk-[a-zA-Z0-9-]{20,}/.test(content)).toBe(false);
  });

  it("accumulates a typed error for an unterminated quoted value without throwing", () => {
    const malformed =
      'timestamp=2026-09-03T17:21:35.726Z level=INFO message="unterminated value';
    const result = parseTrajectoryEvents(malformed);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.length).toBeGreaterThanOrEqual(1);
    expect(result.error[0]?.type).toBe("TrajectoryEventParseError");
  });

  it("accumulates a typed error for a stray token without '='", () => {
    const malformed = "timestamp=2026-09-03T17:21:35.726Z level=INFO strayword";
    const result = parseTrajectoryEvents(malformed);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.length).toBeGreaterThanOrEqual(1);
  });

  it("accumulates errors across multiple malformed lines instead of failing fast", () => {
    const malformed = [
      'timestamp=2026-09-03T17:21:35.726Z level=INFO message="unterminated one',
      "timestamp=2026-09-03T17:21:36.000Z level=INFO strayword",
    ].join("\n");
    const result = parseTrajectoryEvents(malformed);
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.length).toBe(2);
  });

  it("does not throw, no I/O, and produces session-completed for a synthetic 'exiting loop' line", () => {
    const synthetic = [
      'timestamp=2026-09-03T17:21:35.726Z level=INFO message=created id=ses_a slug=x version=1 projectID=g directory=/w path=w workspaceID=undefined parentID=undefined title="t" agent=loom model=undefined',
      'timestamp=2026-09-03T17:21:36.726Z level=INFO message="exiting loop" session.id=ses_a',
    ].join("\n");
    const result = parseTrajectoryEvents(synthetic);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const completed = result.value.filter(
      (e) => e.kind === "session-completed",
    );
    expect(completed.length).toBe(1);
    expect(completed[0]?.agentName).toBe("loom");
    expect(completed[0]?.durationMs).toBe(1000);
  });

  it("produces session-errored for a level=ERROR line", () => {
    const synthetic =
      'timestamp=2026-09-03T17:21:35.726Z level=ERROR message="boom" session.id=ses_b';
    const result = parseTrajectoryEvents(synthetic);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const errored = result.value.filter((e) => e.kind === "session-errored");
    expect(errored.length).toBe(1);
    expect(errored[0]?.errorKind).toBe("boom");
  });

  it("skips decorative non-log lines without treating them as errors", () => {
    const synthetic = ["", "> loom · openai/gpt-4o-mini", "✓ done"].join("\n");
    const result = parseTrajectoryEvents(synthetic);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.length).toBe(0);
  });
});
