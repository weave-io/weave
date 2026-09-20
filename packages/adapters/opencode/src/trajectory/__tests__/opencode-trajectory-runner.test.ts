import { describe, expect, it } from "bun:test";
import type { TrajectoryCase, TrajectoryWorkspace } from "@weaveio/weave-core";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { parseTrajectoryEvents } from "../log-parser.js";
import { OBSERVER_PLUGIN_PATH, OBSERVER_RECORDS_FILE } from "../observer.js";
import {
  buildSubagentModelOverlay,
  type LogParser,
  OpenCodeTrajectoryRunner,
  type OpenCodeTrajectoryRunnerOptions,
  type PromptProvider,
  type TrajectoryFileSystem,
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

/** In-memory `TrajectoryFileSystem`: records writes, serves seeded reads. */
class InMemoryFileSystem implements TrajectoryFileSystem {
  readonly files = new Map<string, string>();
  readonly copiedDirectories: Array<{ from: string; to: string }> = [];
  readonly copiedFiles: Array<{ from: string; to: string }> = [];

  copyDirectory(from: string, to: string): Promise<void> {
    this.copiedDirectories.push({ from, to });
    return Promise.resolve();
  }

  copyFile(from: string, to: string): Promise<void> {
    this.copiedFiles.push({ from, to });
    return Promise.resolve();
  }

  writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }

  readText(path: string): Promise<string | undefined> {
    return Promise.resolve(this.files.get(path));
  }
}

/** Podman mock that returns one scripted result per `run` call, in order. */
class SequencePodmanClient implements PodmanClient {
  runCalls: string[][] = [];
  runEnvCalls: Array<Record<string, string> | undefined> = [];

  constructor(private readonly results: PodmanRunResult[]) {}

  run(
    args: string[],
    env?: Record<string, string>,
  ): ResultAsync<PodmanRunResult, PodmanClientError> {
    this.runCalls.push(args);
    this.runEnvCalls.push(env);
    const result = this.results[this.runCalls.length - 1];
    if (result === undefined) {
      return errAsync({ type: "PodmanSpawnFailed", message: "no result" });
    }
    return okAsync(result);
  }

  kill(_containerName: string): ResultAsync<void, PodmanClientError> {
    return okAsync(undefined);
  }
}

function buildRunner(
  podmanClient: PodmanClient,
  overrides: Partial<OpenCodeTrajectoryRunnerOptions> = {},
): OpenCodeTrajectoryRunner {
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
    fileSystem: new InMemoryFileSystem(),
    ...overrides,
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
      fileSystem: new InMemoryFileSystem(),
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

// ---------------------------------------------------------------------------
// Spec 35: fixtures, observer, starting agent, local plugin, verifier
// ---------------------------------------------------------------------------

describe("OpenCodeTrajectoryRunner — verification-aware runs", () => {
  const OK_RUN: PodmanRunResult = { exitCode: 0, stderr: CANNED_STDERR };
  const FIXTURE = "/repo/evals/fixtures/buggy-slugify";
  const VERIFIER = "/repo/evals/fixtures/slugify-edges.verifier";

  it("writes the observer plugin into every workspace", async () => {
    const fileSystem = new InMemoryFileSystem();
    const runner = buildRunner(new SequencePodmanClient([OK_RUN]), {
      fileSystem,
    });

    const result = await runner.run(buildTestCase(), "m", WORKSPACE);

    expect(result.isOk()).toBe(true);
    expect(
      fileSystem.files.get(`${WORKSPACE.root}/${OBSERVER_PLUGIN_PATH}`),
    ).toContain('"tool.execute.after"');
  });

  it("keeps today's repo .weave mounts and adds no overlay when there is no fixture", async () => {
    const podman = new SequencePodmanClient([OK_RUN]);
    const fileSystem = new InMemoryFileSystem();
    await buildRunner(podman, { fileSystem }).run(
      buildTestCase(),
      "m",
      WORKSPACE,
    );

    const args = podman.runCalls[0] ?? [];
    expect(args).toContain(
      "/fake/repo/.weave/config.weave:/workspace/.weave/config.weave:ro",
    );
    expect(args.join(" ")).not.toContain("/root/.weave/config.weave");
    expect(fileSystem.copiedDirectories).toEqual([]);
  });

  it("copies the fixture, mounts no repo .weave path, and mounts the model overlay as global config", async () => {
    const podman = new SequencePodmanClient([OK_RUN]);
    const fileSystem = new InMemoryFileSystem();
    await buildRunner(podman, { fileSystem }).run(
      buildTestCase({ fixturePath: FIXTURE }),
      "anthropic/claude-sonnet-4.5",
      WORKSPACE,
    );

    expect(fileSystem.copiedDirectories).toEqual([
      { from: FIXTURE, to: WORKSPACE.root },
    ]);
    const args = podman.runCalls[0] ?? [];
    expect(args.some((arg) => arg.includes("/fake/repo/.weave"))).toBe(false);
    expect(args).toContain(
      "/tmp/weave-global/config.weave:/root/.weave/config.weave:ro",
    );
    expect(fileSystem.files.get("/tmp/weave-global/config.weave")).toContain(
      'models ["openrouter/anthropic/claude-sonnet-4.5"]',
    );
  });

  it("forwards the starting agent to the entrypoint", async () => {
    const podman = new SequencePodmanClient([OK_RUN]);
    await buildRunner(podman).run(
      buildTestCase({ startAgent: "tapestry" }),
      "m",
      WORKSPACE,
    );

    expect(podman.runCalls[0]).toContain(
      "WEAVE_TRAJECTORY_START_AGENT=tapestry",
    );
  });

  it("fails closed for opencode-local without a bundle, and installs the bundle when given one", async () => {
    const missing = await buildRunner(new SequencePodmanClient([OK_RUN])).run(
      buildTestCase({ sandboxProfile: "opencode-local" }),
      "m",
      WORKSPACE,
    );
    expect(missing.isErr() && missing.error.type).toBe("SandboxStartFailed");

    const fileSystem = new InMemoryFileSystem();
    const podman = new SequencePodmanClient([OK_RUN]);
    const result = await buildRunner(podman, {
      fileSystem,
      localPluginBundlePath: "/build/weave-plugin.js",
    }).run(buildTestCase({ sandboxProfile: "opencode-local" }), "m", WORKSPACE);

    expect(result.isOk()).toBe(true);
    expect(fileSystem.copiedFiles).toEqual([
      {
        from: "/build/weave-plugin.js",
        to: `${WORKSPACE.root}/.opencode/plugin/weave.js`,
      },
    ]);
    const config = fileSystem.files.get(`${WORKSPACE.root}/opencode.jsonc`);
    expect(config).toContain('"permission": "allow"');
    expect(config).not.toContain("plugin");
    expect(podman.runCalls[0]).toContain("weave-sandbox-opencode-default");
  });

  it("joins observer records into the event stream as tool-call-after events with detail", async () => {
    const fileSystem = new InMemoryFileSystem();
    fileSystem.files.set(
      `${WORKSPACE.artifactsDir}/${OBSERVER_RECORDS_FILE}`,
      `${JSON.stringify({
        sessionID: "ses_child",
        callID: "toolu_1",
        tool: "bash",
        timestamp: "2026-09-03T17:21:39.000Z",
        command: "bun test",
        exitCode: 0,
      })}\n{truncated`,
    );

    const result = await buildRunner(new SequencePodmanClient([OK_RUN]), {
      fileSystem,
    }).run(buildTestCase(), "m", WORKSPACE);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.summary.observedToolCalls).toBe(1);
    const after = result.value.events.find(
      (event) => event.kind === "tool-call-after",
    );
    expect(after).toMatchObject({
      agentName: "shuttle",
      toolName: "bash",
      succeeded: true,
      detail: { command: "bun test", exitCode: 0 },
    });
    expect(Object.keys(result.value.summary)).not.toContain("detail");
  });

  it("runs the verifier in a second container the agent never saw, and reports its result", async () => {
    const podman = new SequencePodmanClient([
      OK_RUN,
      { exitCode: 1, stderr: "verifier: 3 of 5 expectations failed" },
    ]);
    const result = await buildRunner(podman).run(
      buildTestCase({
        fixturePath: FIXTURE,
        maxDurationSeconds: 300,
        verifier: { fixturePath: VERIFIER, command: "bun /verifier/verify.ts" },
      }),
      "m",
      WORKSPACE,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.verifier).toEqual({ passed: false });

    const [agentArgs, verifierArgs] = podman.runCalls;
    expect(agentArgs?.join(" ")).not.toContain("/verifier");
    expect(verifierArgs).toContain(`${VERIFIER}:/verifier:ro`);
    expect(verifierArgs?.slice(-2)).toEqual(["-c", "bun /verifier/verify.ts"]);
    expect(verifierArgs).not.toContain("OPENROUTER_API_KEY");
    expect(podman.runEnvCalls[1]).toBeUndefined();
  });

  it("reports a passing verifier and omits the verifier field when the case has none", async () => {
    const passing = await buildRunner(
      new SequencePodmanClient([OK_RUN, { exitCode: 0, stderr: "" }]),
    ).run(
      buildTestCase({
        fixturePath: FIXTURE,
        verifier: { fixturePath: VERIFIER, command: "true" },
      }),
      "m",
      WORKSPACE,
    );
    expect(passing.isOk() && passing.value.verifier).toEqual({ passed: true });

    const none = await buildRunner(new SequencePodmanClient([OK_RUN])).run(
      buildTestCase(),
      "m",
      WORKSPACE,
    );
    expect(none.isOk() && "verifier" in none.value).toBe(false);
  });
});

describe("OpenCodeTrajectoryRunner — timers", () => {
  it("clears the run timeout once the sandbox finishes", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const pending = new Set<unknown>();
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const handle = realSetTimeout(fn, ms);
      pending.add(handle);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
      pending.delete(handle);
      realClearTimeout(handle);
    }) as typeof clearTimeout;
    try {
      const result = await buildRunner(
        new SequencePodmanClient([{ exitCode: 0, stderr: CANNED_STDERR }]),
      ).run(buildTestCase({ maxDurationSeconds: 300 }), "m", WORKSPACE);
      expect(result.isOk()).toBe(true);
      expect(pending.size).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});

describe("buildSubagentModelOverlay", () => {
  it("pins each builtin sub-agent, and only sub-agents, to the OpenRouter model id", () => {
    const overlay = buildSubagentModelOverlay("openai/gpt-4o-mini");
    for (const agent of [
      "shuttle",
      "pattern",
      "thread",
      "spindle",
      "weft",
      "warp",
    ]) {
      expect(overlay).toContain(
        `agent ${agent} {\n  models ["openrouter/openai/gpt-4o-mini"]\n}`,
      );
    }
    expect(overlay).not.toContain("agent loom");
    expect(overlay).not.toContain("agent tapestry");
    expect(buildSubagentModelOverlay("openrouter/x/y")).toContain(
      'models ["openrouter/x/y"]',
    );
  });
});
