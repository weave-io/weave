/**
 * Adapter scenarios — model recommendations on Claude Code (Spec 39, item 6b).
 *
 * Bucket: Adapters. The Claude Code bootstrap plugin's `SessionStart` hook
 * runs `weave compose --adapter claude-code`, so each "session start" here is
 * that command, driven through the CLI's `run()`. What a user observes is the
 * generated bundle (the model in Loom's agent file), the hook's exit code, and
 * what it prints on stdout (which Claude Code adds to the session's context)
 * and stderr. The project is a virtual disk; the network, the clock and the
 * recommendations cache are fakes, and lists are signed with a throwaway key
 * made for this run.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import {
  globalConfigDir,
  modelRecommendationsCachePaths,
} from "@weaveio/weave-config";
import { run } from "../../packages/cli/src/cli.js";
import { MemoryFileSystem } from "../../packages/cli/src/fs/file-system.js";
import { BufferTerminal } from "../../packages/cli/src/io/terminal.js";
import {
  generateSigningKeys,
  MemoryRecommendationsCache,
  ScriptedFetch,
  type SigningKeys,
  signedEnvelope,
} from "../support/model-recommendations.js";

const PROJECT_DIR = "/project";
const HOME_DIR = "/home/user";
const LOOM_FILE = `${PROJECT_DIR}/.weave/plugins/claude-code/agents/loom.md`;
const HOUR = 3_600_000;

let keys: SigningKeys;

beforeAll(async () => {
  keys = await generateSigningKeys();
});

/** A published list issued on `day` October 2026, putting Loom on `tier`. */
function list(day: number, tier: string) {
  return {
    schema: 1,
    channel: "stable",
    issued: `2026-10-0${day}T09:00:00Z`,
    expires: "2026-12-20T09:00:00Z",
    evidence: `https://tryweave.io/evals/runs/run-${day}`,
    default: { agents: { loom: { models: ["gpt-6-sol"] } } },
    harnesses: { "claude-code": { agents: { loom: { models: [tier] } } } },
  };
}

interface SessionStart {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The `model:` Loom's generated agent file names. */
  readonly loom: string | undefined;
  readonly ms: number;
}

/** One user's machine: their project, the recommendations cache and the site. */
class Machine {
  readonly fs: MemoryFileSystem;
  readonly cache: MemoryRecommendationsCache;
  readonly site = new ScriptedFetch();
  /** The machine's clock; scenarios move it past the refresh throttle. */
  now = new Date("2026-10-02T12:00:00Z");
  /** Replaces the site's `fetch`, for a server that is down or never answers. */
  fetch?: (url: string) => Promise<Response>;

  constructor(mode: "auto" | "notify" | "off") {
    this.fs = new MemoryFileSystem(
      {
        [`${PROJECT_DIR}/.weave/config.weave`]: `settings { model_updates { mode ${mode} } }\n`,
      },
      PROJECT_DIR,
      HOME_DIR,
    );
    this.cache = new MemoryRecommendationsCache(() => this.now);
  }

  async publish(published: unknown): Promise<void> {
    this.site.serve(await signedEnvelope(published, keys));
  }

  /** A Claude Code session start: the bootstrap hook's compose. */
  async sessionStart(): Promise<SessionStart> {
    const terminal = new BufferTerminal();
    const started = Date.now();
    const result = await run({
      argv: ["bun", "weave", "compose", "--adapter", "claude-code"],
      terminal,
      colorEnabled: false,
      fs: this.fs,
      now: () => this.now,
      modelRecommendations: {
        fetch: this.fetch ?? this.site.fetch,
        files: this.cache,
        shell: this.cache,
        publicKeys: [keys.publicKey],
        baseUrl: "https://models.test/models",
      },
    });
    const loomFile = this.fs.snapshot()[LOOM_FILE];
    return {
      exitCode: result._unsafeUnwrap(),
      stdout: terminal.out.join("\n"),
      stderr: terminal.err.join("\n"),
      loom:
        loomFile === undefined
          ? undefined
          : /^model: (.+)$/m.exec(loomFile)?.[1],
      ms: Date.now() - started,
    };
  }
}

/** Runs a scenario once, on first use. */
function once<T>(start: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  return () => {
    running ??= start();
    return running;
  };
}

describe("a Claude Code user opts in to automatic model updates", () => {
  const scenario = once(async () => {
    const machine = new Machine("auto");
    await machine.publish(list(1, "sonnet"));
    const sessions: SessionStart[] = [];
    const fetches: number[] = [];
    const start = async () => {
      sessions.push(await machine.sessionStart());
      fetches.push(machine.site.urls.length);
    };
    await start();
    await start();
    // A day later a newer list is published.
    await machine.publish(list(3, "haiku"));
    machine.now = new Date(machine.now.getTime() + 25 * HOUR);
    await start();
    await start();
    return { sessions, fetches, urls: [...machine.site.urls] };
  });

  it("composes the first session on the builtin lists and fetches the published list once", async () => {
    const { sessions, fetches, urls } = await scenario();
    expect(sessions[0]?.exitCode).toBe(0);
    expect(sessions[0]?.loom).toBe("opus");
    expect(fetches[0]).toBe(1);
    expect(urls[0]).toBe("https://models.test/models/stable.v1.json");
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
    expect(fetches[3]).toBe(2);
    expect(sessions[3]?.loom).toBe("haiku");
  });

  it("says in the summary whether a recommended list was applied", async () => {
    const { sessions } = await scenario();
    expect(sessions[0]?.stdout).toMatch(
      /Recommendations: +none applied yet \(stable\)/,
    );
    expect(sessions[1]?.stdout).toMatch(
      /Recommendations: +applied \(stable, issued 2026-10-01T09:00:00Z\)/,
    );
  });

  it("notes a newly applied list on stderr only, never on the hook's stdout", async () => {
    const { sessions } = await scenario();
    expect(sessions[0]?.stderr).toContain(
      "Model recommendations issued 2026-10-01T09:00:00Z were applied; they take effect at the next session.",
    );
    for (const session of sessions)
      expect(session.stdout).not.toContain("Model recommendations issued");
  });
});

describe("a Claude Code user is notified of model updates instead", () => {
  const scenario = once(async () => {
    const machine = new Machine("notify");
    await machine.publish(list(1, "sonnet"));
    const first = await machine.sessionStart();
    const second = await machine.sessionStart();
    return { first, second, fetches: machine.site.urls.length };
  });

  it("downloads the list at session start but keeps composing on the builtin lists", async () => {
    const { first, second, fetches } = await scenario();
    expect(fetches).toBe(1);
    expect(first.stderr).toContain(
      "Model recommendations issued 2026-10-01T09:00:00Z were downloaded; run `weave models apply` to use them.",
    );
    expect(second.loom).toBe("opus");
  });
});

describe("a Claude Code user leaves model updates off", () => {
  const scenario = once(async () => {
    const machine = new Machine("off");
    await machine.publish(list(1, "sonnet"));
    const session = await machine.sessionStart();
    return {
      session,
      urls: [...machine.site.urls],
      cacheFiles: [...machine.cache.files.keys()],
    };
  });

  it("never asks the server for a list and writes no cache", async () => {
    const { urls, cacheFiles } = await scenario();
    expect(urls).toEqual([]);
    expect(cacheFiles).toEqual([]);
  });

  it("composes on the builtin lists and says nothing about recommendations", async () => {
    const { session } = await scenario();
    expect(session.exitCode).toBe(0);
    expect(session.loom).toBe("opus");
    expect(session.stdout).not.toContain("Recommendations");
  });
});

describe("a Claude Code user's recommendations check fails", () => {
  const scenario = once(async () => {
    const offlineMachine = new Machine("auto");
    offlineMachine.fetch = () =>
      Promise.reject(new Error("getaddrinfo ENOTFOUND"));
    const offline = await offlineMachine.sessionStart();

    const hangingMachine = new Machine("auto");
    // A server that never answers, and ignores the abort.
    hangingMachine.fetch = () => new Promise<Response>(() => undefined);
    const hanging = await hangingMachine.sessionStart();
    return { offline, hanging };
  });

  it("still composes and exits cleanly when the server cannot be reached", async () => {
    const { offline } = await scenario();
    expect(offline.exitCode).toBe(0);
    expect(offline.loom).toBe("opus");
    expect(offline.stderr).toContain("the check failed");
    expect(offline.stdout).not.toContain("the check failed");
  });

  it("holds the session start for at most the refresh bound when the server never answers", async () => {
    const { hanging } = await scenario();
    expect(hanging.exitCode).toBe(0);
    expect(hanging.loom).toBe("opus");
    expect(hanging.ms).toBeLessThan(3_000);
  });
});

describe("a Claude Code user's applied list cannot be used", () => {
  const scenario = once(async () => {
    const machine = new Machine("auto");
    const paths = modelRecommendationsCachePaths("stable", globalConfigDir());
    machine.cache.files.set(paths.applied, "not a signed list");
    // A recent check, so this session start does not fetch.
    machine.cache.files.set(
      paths.state,
      JSON.stringify({ version: 1, lastCheck: "2026-10-02T11:00:00Z" }),
    );
    const session = await machine.sessionStart();
    return { session, fetches: machine.site.urls.length };
  });

  it("warns that the list was skipped, and composes on the builtin lists", async () => {
    const { session, fetches } = await scenario();
    expect(fetches).toBe(0);
    expect(session.exitCode).toBe(0);
    expect(session.loom).toBe("opus");
    expect(session.stderr).toContain(
      "Warning: model recommendations (stable) skipped:",
    );
    expect(session.stdout).toMatch(
      /Recommendations: +skipped \(stable, see the warning above\)/,
    );
  });
});
