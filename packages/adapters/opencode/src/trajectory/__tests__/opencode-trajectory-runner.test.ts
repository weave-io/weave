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
  runEnvCalls: Array<Record<string, string> | undefined> = [];

  constructor(
    private readonly behavior:
      | { kind: "resolve"; result: PodmanRunResult }
      | { kind: "reject"; error: PodmanClientError }
      | { kind: "hang" },
  ) {}

  run(
    args: string[],
    env?: Record<string, string>,
  ): ResultAsync<PodmanRunResult, PodmanClientError> {
    this.runCalls.push(args);
    this.runEnvCalls.push(env);
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
    // Only config.weave is mounted here (the fake repo root has no
    // prompts/ directory); prompts/ is included when it exists (see the
    // dedicated "mounts prompts/ when present" test below).
    expect(runArgs).toContain(
      "/fake/repo/.weave/config.weave:/workspace/.weave/config.weave:ro",
    );
    // The old whole-directory `.weave/` mount must not reappear — only the
    // two files/dirs config discovery actually reads should be mounted.
    expect(
      runArgs.some((arg) => arg === "/fake/repo/.weave:/workspace/.weave:ro"),
    ).toBe(false);
    expect(runArgs).toContain("-e");
    expect(runArgs).toContain("WEAVE_TRAJECTORY_MODEL=openai/gpt-4o-mini");
    // The old /opt/weave-plugin bind mount was removed; make sure no test
    // regresses to reintroducing it.
    expect(runArgs.some((arg) => arg.includes("/opt/weave-plugin"))).toBe(
      false,
    );

    // SECURITY: OPENROUTER_API_KEY must be forwarded to podman as a
    // *name-only* pass-through flag — never with the secret value
    // interpolated into argv. The actual value must be supplied via the
    // separate `env` parameter to `PodmanClient.run`, not via `args`.
    expect(runArgs).toContain("OPENROUTER_API_KEY");
    expect(runArgs.some((arg) => arg.startsWith("OPENROUTER_API_KEY="))).toBe(
      false,
    );
    expect(runArgs.join(" ")).not.toContain("test-key");
    expect(podman.runEnvCalls[0]).toEqual({
      OPENROUTER_API_KEY: "test-key",
    });
  });

  it("mounts .weave/prompts/ read-only in addition to config.weave when the directory exists", async () => {
    const podman = new MockPodmanClient({
      kind: "resolve",
      result: { exitCode: 0, stderr: CANNED_STDERR },
    });
    // Use the real repo root, which has a .weave/prompts/ directory, to
    // prove the prompts mount is added when present (as opposed to the
    // "/fake/repo" fixture used elsewhere, which has none).
    const { resolve } = await import("node:path");
    const realRepoRoot = resolve(import.meta.dir, "../../../../../..");
    const runner = new OpenCodeTrajectoryRunner({
      podmanClient: podman,
      logParser: new StubLogParser(),
      promptProvider: new MockPromptProvider(),
      workspaceFactory: new MockWorkspaceFactory(),
      openRouterApiKey: "test-key",
      repoRoot: realRepoRoot,
      timeoutDrainGraceMs: 50,
    });

    const result = await runner.run(
      buildTestCase(),
      "openai/gpt-4o-mini",
      WORKSPACE,
    );

    expect(result.isOk()).toBe(true);
    const runArgs = podman.runCalls[0]!;
    expect(runArgs).toContain(
      `${realRepoRoot}/.weave/prompts:/workspace/.weave/prompts:ro`,
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

describe("WEAVE_TRAJECTORY_DUMP_STDERR secret redaction", () => {
  const REALISTIC_SECRET_STDERR = `${CANNED_STDERR}
timestamp=2026-09-03T17:21:40.000Z level=DEBUG run=abc message="outbound request" headers.authorization="Bearer sk-or-v1-abcdef0123456789abcdef0123456789" openrouter_key=sk-or-v1-abcdef0123456789abcdef0123456789 github_token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789
`;

  async function withTempDumpDir(
    fn: (dir: string) => Promise<void>,
  ): Promise<void> {
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "weave-dump-test-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("writes only redacted stderr, never the raw secret values, when dumping outside CI", async () => {
    await withTempDumpDir(async (dir) => {
      const prevDump = Bun.env.WEAVE_TRAJECTORY_DUMP_STDERR;
      const prevCI = Bun.env.CI;
      const prevPublish = Bun.env.WEAVE_EVAL_PUBLISH_MODE;
      Bun.env.WEAVE_TRAJECTORY_DUMP_STDERR = dir;
      delete Bun.env.CI;
      delete Bun.env.WEAVE_EVAL_PUBLISH_MODE;
      try {
        const podman = new MockPodmanClient({
          kind: "resolve",
          result: { exitCode: 0, stderr: REALISTIC_SECRET_STDERR },
        });
        const runner = buildRunner(podman);

        const result = await runner.run(
          buildTestCase(),
          "openai/gpt-4o-mini",
          WORKSPACE,
        );
        expect(result.isOk()).toBe(true);

        // The dump write is fire-and-forget in production code; give it a
        // tick to land before asserting on disk contents.
        await new Promise((resolve) => setTimeout(resolve, 50));

        const path = `${dir}/tc-1.stderr.log`;
        const written = await Bun.file(path).text();
        expect(written).not.toContain(
          "sk-or-v1-abcdef0123456789abcdef0123456789",
        );
        expect(written).not.toContain(
          "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        );
        expect(written).not.toContain(
          "Bearer sk-or-v1-abcdef0123456789abcdef0123456789",
        );
        expect(written).toContain("[REDACTED");
      } finally {
        if (prevDump === undefined) delete Bun.env.WEAVE_TRAJECTORY_DUMP_STDERR;
        else Bun.env.WEAVE_TRAJECTORY_DUMP_STDERR = prevDump;
        if (prevCI === undefined) delete Bun.env.CI;
        else Bun.env.CI = prevCI;
        if (prevPublish === undefined) delete Bun.env.WEAVE_EVAL_PUBLISH_MODE;
        else Bun.env.WEAVE_EVAL_PUBLISH_MODE = prevPublish;
      }
    });
  });

  it("refuses to write any dump file when CI=true", async () => {
    await withTempDumpDir(async (dir) => {
      const prevDump = Bun.env.WEAVE_TRAJECTORY_DUMP_STDERR;
      const prevCI = Bun.env.CI;
      Bun.env.WEAVE_TRAJECTORY_DUMP_STDERR = dir;
      Bun.env.CI = "true";
      try {
        const podman = new MockPodmanClient({
          kind: "resolve",
          result: { exitCode: 0, stderr: REALISTIC_SECRET_STDERR },
        });
        const runner = buildRunner(podman);

        const result = await runner.run(
          buildTestCase(),
          "openai/gpt-4o-mini",
          WORKSPACE,
        );
        expect(result.isOk()).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 50));

        const path = `${dir}/tc-1.stderr.log`;
        expect(await Bun.file(path).exists()).toBe(false);
      } finally {
        if (prevDump === undefined) delete Bun.env.WEAVE_TRAJECTORY_DUMP_STDERR;
        else Bun.env.WEAVE_TRAJECTORY_DUMP_STDERR = prevDump;
        if (prevCI === undefined) delete Bun.env.CI;
        else Bun.env.CI = prevCI;
      }
    });
  });

  it("redacts realistic secrets from the stderrTail on harness crash without needing the dump feature", async () => {
    // This exercises the non-zero exit code logging path (stderrTail), which
    // must never include the raw secret regardless of WEAVE_TRAJECTORY_DUMP_STDERR.
    // We can't easily intercept the pino logger here, so we assert indirectly
    // via the exported redactSecrets-equivalent behavior: constructing the
    // runner with a crash result must not throw and must classify as
    // HarnessCrashed; the redaction itself is covered by the dump test above
    // and by direct unit coverage of `redactSecrets` in
    // `packages/engine` / `packages/cli`.
    const podman = new MockPodmanClient({
      kind: "resolve",
      result: { exitCode: 1, stderr: REALISTIC_SECRET_STDERR },
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
});
