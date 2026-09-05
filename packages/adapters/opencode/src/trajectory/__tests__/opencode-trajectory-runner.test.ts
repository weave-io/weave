import { describe, expect, it } from "bun:test";
import type { TrajectoryCase, TrajectoryWorkspace } from "@weaveio/weave-core";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { parseTrajectoryEvents } from "../log-parser.js";
import {
  type LogParser,
  OpenCodeTrajectoryRunner,
  type PromptProvider,
  type TrajectoryWorkspaceFactory,
} from "../opencode-trajectory-runner.js";
import type {
  PodmanClient,
  PodmanClientError,
  PodmanRunResult,
} from "../podman-client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CANNED_STDERR = `timestamp=2026-09-03T17:21:35.726Z level=INFO run=abc message=created id=ses_parent slug=x version=1.18.27 projectID=global directory=/workspace path=workspace workspaceID=undefined parentID=undefined title="root" agent=loom model=undefined metadata=undefined cost=0 tokens.input=0 tokens.output=0 tokens.reasoning=0 tokens.cache.read=0 tokens.cache.write=0 time.created=1 time.updated=1
timestamp=2026-09-03T17:21:37.618Z level=INFO run=abc message=evaluated permission=task pattern=shuttle action.permission=task action.action=allow action.pattern=*
timestamp=2026-09-03T17:21:37.618Z level=INFO run=abc message=created id=ses_child slug=y version=1.18.27 projectID=global directory=/workspace path=workspace workspaceID=undefined parentID=ses_parent title="child" agent=shuttle model=undefined metadata=undefined cost=0 tokens.input=0 tokens.output=0 tokens.reasoning=0 tokens.cache.read=0 tokens.cache.write=0 time.created=1 time.updated=1
timestamp=2026-09-03T17:21:38.760Z level=INFO run=abc message=evaluated permission=edit pattern=workspace/src/index.js action.permission=edit action.action=allow action.pattern=*
timestamp=2026-09-03T17:21:39.764Z level=INFO run=abc message="exiting loop" session.id=ses_child
`;

function buildTestCase(
  overrides: Partial<TrajectoryCase> = {},
): TrajectoryCase {
  return {
    testCaseId: "tc-1",
    expectedSpawns: ["shuttle"],
    expectedTools: ["edit"],
    maxDurationSeconds: 1,
    sandboxProfile: "opencode-default",
    ...overrides,
  };
}

const WORKSPACE: TrajectoryWorkspace = {
  root: "/tmp/fake-root",
  artifactsDir: "/tmp/fake-artifacts",
};

class MockPromptProvider implements PromptProvider {
  getPrompt(
    _testCase: TrajectoryCase,
  ): ReturnType<PromptProvider["getPrompt"]> {
    return okAsync("do the thing");
  }
}

class MockWorkspaceFactory implements TrajectoryWorkspaceFactory {
  create(
    _testCaseId: string,
    _prompt: string,
  ): ReturnType<TrajectoryWorkspaceFactory["create"]> {
    return okAsync(WORKSPACE);
  }
}

class StubLogParser implements LogParser {
  parse(stderr: string): ReturnType<LogParser["parse"]> {
    return parseTrajectoryEvents(stderr);
  }
}

class MockPodmanClient implements PodmanClient {
  killCalls: string[] = [];
  runCalls: string[][] = [];

  constructor(
    private readonly behavior:
      | { kind: "resolve"; result: PodmanRunResult }
      | { kind: "reject"; error: PodmanClientError }
      | { kind: "hang" },
  ) {}

  run(args: string[]): ResultAsync<PodmanRunResult, PodmanClientError> {
    this.runCalls.push(args);
    if (this.behavior.kind === "resolve") {
      return okAsync(this.behavior.result);
    }
    if (this.behavior.kind === "reject") {
      return errAsync(this.behavior.error);
    }
    // Never resolves — simulates a hung container for timeout tests.
    return ResultAsync.fromPromise(
      new Promise<PodmanRunResult>(() => {}),
      (): PodmanClientError => ({
        type: "PodmanSpawnFailed",
        message: "unreachable",
      }),
    );
  }

  kill(containerName: string): ResultAsync<void, PodmanClientError> {
    this.killCalls.push(containerName);
    return okAsync(undefined);
  }
}

function buildRunner(podmanClient: PodmanClient): OpenCodeTrajectoryRunner {
  return new OpenCodeTrajectoryRunner({
    podmanClient,
    logParser: new StubLogParser(),
    promptProvider: new MockPromptProvider(),
    workspaceFactory: new MockWorkspaceFactory(),
    openRouterApiKey: "test-key",
    repoRoot: "/fake/repo",
    // Keep the post-kill drain grace short so the timeout test finishes
    // well within Bun's default 5s per-test ceiling even when the mocked
    // `podman run` promise hangs forever.
    timeoutDrainGraceMs: 50,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenCodeTrajectoryRunner", () => {
  it("returns a TrajectoryResult with the exact four-field publishable summary on success", async () => {
    const podman = new MockPodmanClient({
      kind: "resolve",
      result: { exitCode: 0, stderr: CANNED_STDERR },
    });
    const runner = buildRunner(podman);

    const result = await runner.run(
      buildTestCase(),
      "openai/gpt-4o-mini",
      WORKSPACE,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { summary, events, rawArtifactRef } = result.value;

    expect(Object.keys(summary).sort()).toEqual(
      [
        "harnessDelegatedCorrectly",
        "observedSpawns",
        "observedToolCalls",
        "harnessCompletedWithoutError",
      ].sort(),
    );

    expect(summary.harnessDelegatedCorrectly).toBe(true);
    expect(summary.observedSpawns).toEqual(["shuttle"]);
    expect(summary.observedToolCalls).toBe(0); // fixture has no tool-call-after events
    expect(summary.harnessCompletedWithoutError).toBe(true);

    expect(events.length).toBeGreaterThan(0);
    expect(rawArtifactRef.path).toBe("tc-1/stderr.log");

    // Raw event stream must never be structurally embedded in the summary.
    expect((summary as unknown as { events?: unknown }).events).toBeUndefined();

    // The podman run invocation must mount the repo's .weave/ config
    // directory read-only, and forward the model via env var, so OpenCode
    // routes through Loom/Shuttle instead of falling back to its baked-in
    // `build` default agent. The Weave plugin itself is installed globally
    // inside the sandbox image (from npm), not bind-mounted from the repo.
    expect(podman.runCalls.length).toBe(1);
    const runArgs = podman.runCalls[0]!;
    expect(runArgs).toContain("-v");
    expect(runArgs).toContain("/fake/repo/.weave:/workspace/.weave:ro");
    expect(runArgs).toContain("-e");
    expect(runArgs).toContain("WEAVE_TRAJECTORY_MODEL=openai/gpt-4o-mini");
    // The old /opt/weave-plugin bind mount was removed; make sure no test
    // regresses to reintroducing it.
    expect(runArgs.some((arg) => arg.includes("/opt/weave-plugin"))).toBe(
      false,
    );
  });

  it("computes harnessDelegatedCorrectly=false when an expected spawn was not observed", async () => {
    const podman = new MockPodmanClient({
      kind: "resolve",
      result: { exitCode: 0, stderr: CANNED_STDERR },
    });
    const runner = buildRunner(podman);

    const result = await runner.run(
      buildTestCase({ expectedSpawns: ["shuttle", "warp"] }),
      "openai/gpt-4o-mini",
      WORKSPACE,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.summary.harnessDelegatedCorrectly).toBe(false);
  });

  it("returns HarnessCrashed when the sandbox exits non-zero", async () => {
    const podman = new MockPodmanClient({
      kind: "resolve",
      result: { exitCode: 1, stderr: CANNED_STDERR },
    });
    const runner = buildRunner(podman);

    const result = await runner.run(
      buildTestCase(),
      "openai/gpt-4o-mini",
      WORKSPACE,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("HarnessCrashed");
  });

  it("returns SandboxStartFailed when podman run fails outright", async () => {
    const podman = new MockPodmanClient({
      kind: "reject",
      error: { type: "PodmanSpawnFailed", message: "no such image" },
    });
    const runner = buildRunner(podman);

    const result = await runner.run(
      buildTestCase(),
      "openai/gpt-4o-mini",
      WORKSPACE,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("SandboxStartFailed");
  });

  it("returns SandboxStartFailed for an unknown sandbox_profile", async () => {
    const podman = new MockPodmanClient({
      kind: "resolve",
      result: { exitCode: 0, stderr: CANNED_STDERR },
    });
    const runner = buildRunner(podman);

    const result = await runner.run(
      buildTestCase({ sandboxProfile: "not-a-real-profile" }),
      "openai/gpt-4o-mini",
      WORKSPACE,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("SandboxStartFailed");
    // podman.run must never have been invoked for an unresolved profile.
    expect(podman.runCalls.length).toBe(0);
  });

  it("returns TimeoutExceeded and calls podman kill when max_duration_seconds is exceeded", async () => {
    const podman = new MockPodmanClient({ kind: "hang" });
    const runner = buildRunner(podman);

    const result = await runner.run(
      buildTestCase({ maxDurationSeconds: 0.05 }),
      "openai/gpt-4o-mini",
      WORKSPACE,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("TimeoutExceeded");
    expect(podman.killCalls.length).toBe(1);
  });
});
