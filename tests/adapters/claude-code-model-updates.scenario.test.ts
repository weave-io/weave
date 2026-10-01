/**
 * Adapter scenarios — model recommendations on Claude Code (Spec 39, item 6b).
 *
 * Bucket: Adapters. The Claude Code bootstrap plugin's `SessionStart` hook
 * runs `weave compose --adapter claude-code`, so each "session start" here is
 * that command, driven through the CLI's `run()`. What a user observes is the
 * generated bundle (the model in Loom's agent file), the hook's exit code, and
 * what it prints. The recommendations `fetch` is stubbed to serve lists signed
 * by a throwaway key; nothing touches the network.
 *
 * The project lives in a `MemoryFileSystem`. The recommendations cache lives
 * under the global config directory, which each scenario points at an empty
 * temporary directory on disk: the refresh writes it there, and the overlay
 * filesystem below lets compose's config loader read it back.
 */

import { describe, expect, it } from "bun:test";
import type { ResultAsync } from "neverthrow";
import { run } from "../../packages/cli/src/cli.js";
import {
  BunFileSystem,
  type FileSystemError,
  MemoryFileSystem,
} from "../../packages/cli/src/fs/file-system.js";
import { BufferTerminal } from "../../packages/cli/src/io/terminal.js";
import type { ComposeModelRecommendationsDeps } from "../../packages/cli/src/models/compose-refresh.js";
import { modelRecommendationsCachePaths } from "../../packages/config/src/index.js";
import {
  HOUR,
  type Keys,
  STUB_BASE_URL,
  StubServer,
  signedList,
  throwawayKeys,
  withGlobalDir,
} from "../support/model-recommendations.js";

const PROJECT_DIR = "/project";
const HOME_DIR = "/home/user";
const LOOM_FILE = `${PROJECT_DIR}/.weave/plugins/claude-code/agents/loom.md`;

/**
 * The project in memory, the global config directory (and so the
 * recommendations cache) on disk.
 */
class ProjectInMemory extends MemoryFileSystem {
  private readonly disk = new BunFileSystem();

  constructor(
    files: Record<string, string>,
    private readonly globalDir: string,
  ) {
    super(files, PROJECT_DIR, HOME_DIR);
  }

  override exists(path: string): ResultAsync<boolean, FileSystemError> {
    if (this.onDisk(path)) return this.disk.exists(path);
    return super.exists(path);
  }

  override readText(path: string): ResultAsync<string, FileSystemError> {
    if (this.onDisk(path)) return this.disk.readText(path);
    return super.readText(path);
  }

  private onDisk(path: string): boolean {
    return path.startsWith(`${this.globalDir}/`);
  }
}

/** The project's config: model updates in the given mode. */
function configWith(mode: "auto" | "notify" | "off"): Record<string, string> {
  return {
    [`${PROJECT_DIR}/.weave/config.weave`]: `settings { model_updates { mode ${mode} } }\n`,
  };
}

/** A list whose `claude-code` section puts Loom on `tier`. */
function claudeCodeList(keys: Keys, hoursAgo: number, tier: string) {
  return signedList(keys, hoursAgo, {
    default: { agents: { loom: { models: ["gpt-6-sol"] } } },
    harnesses: { "claude-code": { agents: { loom: { models: [tier] } } } },
  });
}

interface SessionStart {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The `model:` Loom's generated agent file names. */
  readonly loom: string | undefined;
  readonly ms: number;
}

/** One Claude Code session start: the bootstrap hook's compose. */
async function sessionStart(
  fs: MemoryFileSystem,
  modelRecommendations: ComposeModelRecommendationsDeps,
): Promise<SessionStart> {
  const terminal = new BufferTerminal();
  const started = Date.now();
  const result = await run({
    argv: ["bun", "weave", "compose", "--adapter", "claude-code"],
    terminal,
    colorEnabled: false,
    fs,
    modelRecommendations,
  });
  const loomFile = await fs.readText(LOOM_FILE);
  return {
    exitCode: result._unsafeUnwrap(),
    stdout: terminal.out.join("\n"),
    stderr: terminal.err.join("\n"),
    loom: loomFile.isOk()
      ? /^model: (.+)$/m.exec(loomFile.value)?.[1]
      : undefined,
    ms: Date.now() - started,
  };
}

/**
 * Runs a scenario once, on first use. Scenarios must not overlap: each one
 * owns `WEAVE_GLOBAL_CONFIG_DIR` while it runs.
 */
function once<T>(start: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  return () => {
    running ??= start();
    return running;
  };
}

describe("a Claude Code user opts in to automatic model updates", () => {
  const scenario = once(async () => {
    const keys = await throwawayKeys();
    const server = new StubServer();
    const first = await claudeCodeList(keys, 2, "sonnet");
    const second = await claudeCodeList(keys, 1, "haiku");
    // The refresher's clock, moved past the 24-hour throttle before the third
    // session. The lists' own dates stay real, so the loader accepts them.
    let clockOffset = 0;
    server.body = first.body;
    return withGlobalDir("weave-claude-code-model-updates", async (dir) => {
      const fs = new ProjectInMemory(configWith("auto"), dir);
      const deps: ComposeModelRecommendationsDeps = {
        fetch: (url) => server.fetch(url),
        publicKeys: [keys.publicKey],
        baseUrl: STUB_BASE_URL,
        now: () => new Date(Date.now() + clockOffset),
      };
      const firstSession = await sessionStart(fs, deps);
      const afterFirst = server.requests.length;
      const secondSession = await sessionStart(fs, deps);
      const afterSecond = server.requests.length;
      server.body = second.body;
      clockOffset = 25 * HOUR;
      const thirdSession = await sessionStart(fs, deps);
      const afterThird = server.requests.length;
      const fourthSession = await sessionStart(fs, deps);
      return {
        sessions: [firstSession, secondSession, thirdSession, fourthSession],
        fetches: [afterFirst, afterSecond, afterThird],
        requests: [...server.requests],
        issued: { first: first.issued, second: second.issued },
      };
    });
  });

  it("composes the first session on the builtin lists and fetches the published list once", async () => {
    const { sessions, fetches, requests } = await scenario();
    expect(sessions[0]?.exitCode).toBe(0);
    expect(sessions[0]?.loom).toBe("opus");
    expect(fetches[0]).toBe(1);
    expect(requests[0]).toBe(`${STUB_BASE_URL}/stable.v1.json`);
  });

  it("composes the next session with the tier the claude-code section names", async () => {
    const { sessions } = await scenario();
    expect(sessions[1]?.loom).toBe("sonnet");
  });

  it("checks at most once a day, so a session start soon after does not fetch", async () => {
    const { fetches } = await scenario();
    expect(fetches[1]).toBe(1);
  });

  it("checks again at the first session start after the throttle, and applies the newer list at the session after", async () => {
    const { sessions, fetches } = await scenario();
    expect(fetches[2]).toBe(2);
    expect(sessions[2]?.loom).toBe("sonnet");
    expect(sessions[3]?.loom).toBe("haiku");
  });

  it("says in the summary which model lists the agents were composed from", async () => {
    const { sessions, issued } = await scenario();
    expect(sessions[0]?.stdout).toMatch(
      /Model lists: +builtin \(no stable recommendations applied yet\)/,
    );
    expect(sessions[1]?.stdout).toMatch(
      new RegExp(
        `Model lists: +recommended \\(stable, issued ${issued.first}\\)`,
      ),
    );
  });

  it("notes a newly applied list on stderr only, never on the hook's stdout", async () => {
    const { sessions, issued } = await scenario();
    expect(sessions[0]?.stderr).toContain(
      `Model recommendations issued ${issued.first} were applied; they take effect at the next session.`,
    );
    for (const session of sessions)
      expect(session.stdout).not.toContain("Model recommendations");
  });
});

describe("a Claude Code user leaves model updates off", () => {
  const scenario = once(async () => {
    const server = new StubServer();
    return withGlobalDir("weave-claude-code-model-updates", async (dir) => {
      const fs = new ProjectInMemory(configWith("off"), dir);
      const session = await sessionStart(fs, {
        fetch: (url) => server.fetch(url),
        baseUrl: STUB_BASE_URL,
      });
      return {
        session,
        requests: [...server.requests],
        cacheCreated: await Bun.file(
          modelRecommendationsCachePaths("stable", dir).state,
        ).exists(),
      };
    });
  });

  it("never asks the server for a list and writes no cache", async () => {
    const { requests, cacheCreated } = await scenario();
    expect(requests).toEqual([]);
    expect(cacheCreated).toBe(false);
  });

  it("composes on the builtin lists and says nothing about model lists", async () => {
    const { session } = await scenario();
    expect(session.exitCode).toBe(0);
    expect(session.loom).toBe("opus");
    expect(session.stdout).not.toContain("Model lists");
  });
});

describe("a Claude Code user's recommendations check fails", () => {
  const scenario = once(async () => {
    const offline = await withGlobalDir(
      "weave-claude-code-model-updates",
      (dir) =>
        sessionStart(new ProjectInMemory(configWith("auto"), dir), {
          fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
          baseUrl: STUB_BASE_URL,
        }),
    );
    const hanging = await withGlobalDir(
      "weave-claude-code-model-updates",
      (dir) =>
        sessionStart(new ProjectInMemory(configWith("auto"), dir), {
          // A server that never answers and ignores the abort.
          fetch: () => new Promise<Response>(() => undefined),
          baseUrl: STUB_BASE_URL,
          timeoutMs: 50,
        }),
    );
    return { offline, hanging };
  });

  it("still composes and exits cleanly when the server cannot be reached", async () => {
    const { offline } = await scenario();
    expect(offline.exitCode).toBe(0);
    expect(offline.loom).toBe("opus");
    expect(offline.stderr).toContain("the check failed");
    expect(offline.stdout).not.toContain("the check failed");
  });

  it("does not hold the session start for a server that never answers", async () => {
    const { hanging } = await scenario();
    expect(hanging.exitCode).toBe(0);
    expect(hanging.loom).toBe("opus");
    expect(hanging.ms).toBeLessThan(1_500);
  });
});

describe("a Claude Code user's applied list cannot be used", () => {
  const scenario = once(() =>
    withGlobalDir("weave-claude-code-model-updates", async (dir) => {
      const paths = modelRecommendationsCachePaths("stable", dir);
      await Bun.write(paths.applied, "not a signed list");
      // A recent check, so this session start does not fetch.
      await Bun.write(
        paths.state,
        JSON.stringify({ version: 1, lastCheck: new Date().toISOString() }),
      );
      const server = new StubServer();
      const session = await sessionStart(
        new ProjectInMemory(configWith("auto"), dir),
        { fetch: (url) => server.fetch(url), baseUrl: STUB_BASE_URL },
      );
      return { session, requests: [...server.requests] };
    }),
  );

  it("warns that the list was skipped, and composes on the builtin lists", async () => {
    const { session } = await scenario();
    expect(session.exitCode).toBe(0);
    expect(session.loom).toBe("opus");
    expect(session.stderr).toContain(
      "Warning: model recommendations (stable) skipped:",
    );
    expect(session.stdout).toMatch(
      /Model lists: +builtin \(stable recommendations skipped, see above\)/,
    );
  });
});
