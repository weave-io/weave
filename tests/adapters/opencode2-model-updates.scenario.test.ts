/**
 * Adapter scenarios — model recommendations on OpenCode 2 (Spec 39, item 6).
 *
 * Bucket: Adapters. A user opts in with `settings { model_updates { … } }`
 * and keeps working; what they observe is the running host: which model Loom
 * is registered on, the `status` the plan panel reads, and the
 * `models.changed` event the TUI turns into a notice. The seam is
 * `setupOpenCode2(context, dependencies)`, with the recommendations `fetch`
 * stubbed to serve lists signed by a throwaway key. Nothing touches the
 * network.
 *
 * The cache lives under the global config directory, so each scenario points
 * `WEAVE_GLOBAL_CONFIG_DIR` at its own empty temporary directory and puts it
 * back afterwards.
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modelRecommendationsCachePaths,
  signModelRecommendations,
} from "../../packages/config/src/index.js";
import {
  type OpenCode2Host,
  withWeaveOnOpenCode2,
} from "../support/opencode2.js";

const HOUR = 3_600_000;
const BASE_URL = "https://models.test/models";

/** Bare model ids, so the default section resolves each to one provider. */
const HOST_MODELS = [
  { providerID: "probe", id: "loom-a" },
  { providerID: "probe", id: "loom-b" },
];

interface Keys {
  readonly publicKey: string;
  readonly privateKey: string;
}

async function throwawayKeys(): Promise<Keys> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const base64 = (buffer: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buffer)));
  return {
    publicKey: base64(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateKey: base64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  };
}

function stamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A published list, issued `hoursAgo`, that puts Loom on `model`. */
async function publishedList(keys: Keys, hoursAgo: number, model: string) {
  const issued = new Date(Date.now() - hoursAgo * HOUR);
  const payload = JSON.stringify({
    schema: 1,
    channel: "stable",
    issued: stamp(issued),
    expires: stamp(new Date(issued.getTime() + 30 * 24 * HOUR)),
    evidence: "https://tryweave.io/evals/runs/scenario",
    default: { agents: { loom: { models: [model] } } },
  });
  const body = (
    await signModelRecommendations(payload, keys.privateKey)
  )._unsafeUnwrap();
  return { issued: stamp(issued), body };
}

/** The recommendations server: whatever list it holds now, and every GET. */
class StubServer {
  readonly requests: string[] = [];
  body = "";
  fetch = async (url: string): Promise<Response> => {
    this.requests.push(url);
    return new Response(this.body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        etag: `"${this.requests.length}"`,
      },
    });
  };
}

/** Waits for a condition the plugin reaches in the background. */
async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

async function removeTree(dir: string): Promise<void> {
  await Bun.spawn(["rm", "-rf", dir], { stdout: "ignore", stderr: "ignore" })
    .exited;
}

/** Runs `body` with an empty global config directory of its own. */
async function withGlobalDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(
    tmpdir(),
    `weave-opencode2-model-updates-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const previous = process.env.WEAVE_GLOBAL_CONFIG_DIR;
  process.env.WEAVE_GLOBAL_CONFIG_DIR = dir;
  try {
    return await body(dir);
  } finally {
    if (previous === undefined) delete process.env.WEAVE_GLOBAL_CONFIG_DIR;
    else process.env.WEAVE_GLOBAL_CONFIG_DIR = previous;
    await removeTree(dir);
  }
}

interface StatusReport {
  readonly modelUpdates?: Record<string, unknown>;
  readonly issues: readonly {
    readonly code: string;
    readonly agentName?: string;
  }[];
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

describe("a user opts in to automatic model updates and keeps working", () => {
  const run = once(async () => {
    const keys = await throwawayKeys();
    const server = new StubServer();
    const first = await publishedList(keys, 2, "loom-a");
    const second = await publishedList(keys, 1, "loom-b");
    // The refresher's clock: moved past the 24-hour throttle for the second
    // check. The lists' own dates stay real, so the catalog accepts them.
    let clockOffset = 0;
    server.body = first.body;
    return withGlobalDir(async (globalDir) => {
      const applied = modelRecommendationsCachePaths(
        "stable",
        globalDir,
      ).applied;
      const appliedIssued = async () => {
        const file = Bun.file(applied);
        if (!(await file.exists())) return undefined;
        return JSON.parse(JSON.parse(await file.text()).payload).issued;
      };
      return withWeaveOnOpenCode2(
        {
          config: "settings { model_updates { mode auto } }",
          host: {
            models: HOST_MODELS,
            sessionAgent: "loom",
            options: { refreshIntervalMs: 250 },
          },
          dependencies: {
            modelRecommendations: {
              fetch: (url) => server.fetch(url),
              publicKeys: [keys.publicKey],
              baseUrl: BASE_URL,
              now: () => new Date(Date.now() + clockOffset),
            },
          },
        },
        async (host: OpenCode2Host) => {
          const loomModel = () => host.agent("loom").model?.id;
          const atSetup = {
            loom: loomModel(),
            status: (await host.rpc("status")) as StatusReport,
          };

          // The first publish checked in the background and promoted the
          // list; the next prompt's refresh reloads Loom onto it.
          await eventually(
            async () => (await appliedIssued()) === first.issued,
          );
          await Bun.sleep(300);
          await host.promptSession();
          const afterFirst = {
            loom: loomModel(),
            fetches: server.requests.length,
          };

          // A day later a newer list is published. The prompt that checks
          // fetches it; a later prompt runs on it.
          server.body = second.body;
          clockOffset = 25 * HOUR;
          await Bun.sleep(300);
          await host.promptSession();
          await eventually(
            async () => (await appliedIssued()) === second.issued,
          );
          await Bun.sleep(300);
          await host.promptSession();
          return {
            atSetup,
            afterFirst,
            afterSecond: {
              loom: loomModel(),
              fetches: server.requests.length,
              status: (await host.rpc("status")) as StatusReport,
            },
            requests: [...server.requests],
            reloads: [...host.reloads],
            notices: host.planEvents.filter(
              (event) => event.name === "models.changed",
            ),
            issued: { first: first.issued, second: second.issued },
          };
        },
      );
    });
  });

  it("starts on the builtin lists and says recommendations are pending", async () => {
    const result = await run();
    expect(result.atSetup.loom).toBeUndefined();
    expect(result.atSetup.status.modelUpdates).toEqual({
      mode: "auto",
      channel: "stable",
      state: "pending",
    });
  });

  it("fetches the published list in the background and moves Loom onto it without a restart", async () => {
    const result = await run();
    expect(result.afterFirst).toEqual({ loom: "loom-a", fetches: 1 });
    expect(result.requests[0]).toBe(`${BASE_URL}/stable.v1.json`);
    expect(result.reloads).toContain("agent");
  });

  it("checks again on later work once the throttle allows, and moves Loom to the newer list", async () => {
    const result = await run();
    expect(result.afterSecond.loom).toBe("loom-b");
    expect(result.afterSecond.fetches).toBe(2);
    expect(result.afterSecond.status.modelUpdates).toEqual({
      mode: "auto",
      channel: "stable",
      state: "applied",
      issued: result.issued.second,
    });
    // The other builtins have no model on this host; Loom does, and the
    // applied list is usable.
    expect(result.afterSecond.status.issues).not.toContainEqual({
      code: "model_unavailable",
      agentName: "loom",
    });
    expect(
      result.afterSecond.status.issues.map((issue) => issue.code),
    ).not.toContain("model_updates_unavailable");
  });

  it("announces each move, naming the agent, its new model and the list", async () => {
    const result = await run();
    expect(result.notices).toEqual([
      {
        name: "models.changed",
        issued: result.issued.first,
        agents: [{ agent: "loom", providerID: "probe", model: "loom-a" }],
      },
      {
        name: "models.changed",
        issued: result.issued.second,
        agents: [{ agent: "loom", providerID: "probe", model: "loom-b" }],
      },
    ]);
  });
});

describe("a user leaves model updates off", () => {
  const run = once(async () => {
    const server = new StubServer();
    return withGlobalDir(() =>
      withWeaveOnOpenCode2(
        {
          config: "settings { model_updates { mode off } }",
          files: { ".weave/plans/release.md": "# Release\n\n- [ ] Ship it\n" },
          host: { models: HOST_MODELS, sessionAgent: "loom" },
          dependencies: {
            modelRecommendations: { fetch: (url) => server.fetch(url) },
          },
        },
        async (host) => {
          await host.promptSession();
          await host.runCommand("weave:start", "release");
          await Bun.sleep(50);
          return {
            requests: [...server.requests],
            // The plan start reached admission (and its catalog refresh).
            prompted: host.sessionCallNames().includes("prompt"),
            status: (await host.rpc("status")) as StatusReport,
          };
        },
      ),
    );
  });

  it("never asks the server for a list, on setup or on admitted work", async () => {
    const result = await run();
    expect(result.prompted).toBe(true);
    expect(result.requests).toEqual([]);
  });

  it("says model updates are off", async () => {
    expect((await run()).status.modelUpdates).toEqual({
      mode: "off",
      channel: "stable",
      state: "off",
    });
  });
});
