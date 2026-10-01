/**
 * The model recommendations layer of `loadConfigDetailed` (Spec 39, item 3).
 *
 * Every file access goes through an in-memory `FileReader`, and every signed
 * envelope is signed with a throwaway key made for this run, passed in through
 * `publicKeys`. Nothing here touches the disk or the network.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import { errAsync, okAsync } from "neverthrow";
import { getBuiltinConfig } from "../builtins.js";
import type { ConfigLoadDiagnostic } from "../diagnostics.js";
import {
  describeModelRecommendationsSkipReason,
  type ModelRecommendationsSkipReason,
} from "../diagnostics.js";
import {
  discoverAndParse,
  type FileReader,
  GLOBAL_CONFIG_DIR_ENV,
} from "../discovery.js";
import {
  getResolvedBuiltinConfig,
  type LoadConfigOptions,
  loadConfig,
  loadConfigDetailed,
} from "../loader.js";
import { mergeConfigsResult } from "../merge.js";
import { MODEL_RECOMMENDATIONS_CLIENT_VERSION } from "../model-recommendations.js";
import {
  DEFAULT_MODEL_UPDATES_CHANNEL,
  modelRecommendationsCachePaths,
  resolveModelUpdates,
} from "../model-recommendations-cache.js";
import {
  encodeBase64,
  signModelRecommendations,
} from "../model-recommendations-verifier.js";
import { resolvePromptPaths } from "../resolve.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GLOBAL_DIR = "/home/tester/.weave";
const PROJECT = "/work/project";
const GLOBAL_PATH = `${GLOBAL_DIR}/config.weave`;
const PROJECT_PATH = `${PROJECT}/.weave/config.weave`;
const STABLE_APPLIED = `${GLOBAL_DIR}/cache/model-recommendations/stable/applied.json`;
const NEXT_APPLIED = `${GLOBAL_DIR}/cache/model-recommendations/next/applied.json`;
const NOW = new Date("2026-10-02T12:00:00Z");

const BUILTINS = getBuiltinConfig()._unsafeUnwrap();
const BUILTIN_LOOM = BUILTINS.agents.loom?.models ?? [];

type FileMap = Record<string, string | "ERROR">;

/** An in-memory reader that remembers every path it was asked about. */
class RecordingReader implements FileReader {
  readonly touched: string[] = [];
  constructor(private readonly files: FileMap) {}
  exists(path: string): Promise<boolean> {
    this.touched.push(path);
    return Promise.resolve(path in this.files);
  }
  read(path: string) {
    this.touched.push(path);
    const content = this.files[path];
    if (content === undefined || content === "ERROR")
      return errAsync({
        type: "FileReadError" as const,
        path,
        cause: new Error("disk failure"),
      });
    return okAsync(content);
  }
  cacheReads(): string[] {
    return this.touched.filter((path) => path.includes("/cache/"));
  }
}

/** Run `fn` with the global scope at `GLOBAL_DIR`, restoring the env after. */
function withGlobalDir<T>(fn: () => T, dir = GLOBAL_DIR): T {
  const original = process.env[GLOBAL_CONFIG_DIR_ENV];
  process.env[GLOBAL_CONFIG_DIR_ENV] = dir;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[GLOBAL_CONFIG_DIR_ENV];
    else process.env[GLOBAL_CONFIG_DIR_ENV] = original;
  }
}

interface TestKeys {
  publicKey: string;
  privateKey: string;
}

let keys: TestKeys;
let otherKeys: TestKeys;

async function generateKeys(): Promise<TestKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return {
    publicKey: encodeBase64(new Uint8Array(raw)),
    privateKey: encodeBase64(new Uint8Array(pkcs8)),
  };
}

beforeAll(async () => {
  keys = await generateKeys();
  otherKeys = await generateKeys();
});

function list(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1,
    channel: "stable",
    issued: "2026-10-01T09:00:00Z",
    expires: "2026-12-30T09:00:00Z",
    evidence: "https://tryweave.io/evals/runs/run-1",
    default: {
      agents: { loom: { models: ["rec-default", "claude-opus-5-5"] } },
    },
    harnesses: {
      opencode2: {
        agents: { loom: { models: ["github-copilot/rec-oc2"] } },
      },
      "claude-code": { agents: { loom: { models: ["opus"] } } },
    },
    ...overrides,
  });
}

async function signed(
  payload: string,
  privateKey = keys.privateKey,
): Promise<string> {
  return (await signModelRecommendations(payload, privateKey))._unsafeUnwrap();
}

function options(overrides: LoadConfigOptions = {}): LoadConfigOptions {
  return {
    harness: "opencode2",
    now: () => NOW,
    publicKeys: [keys.publicKey],
    ...overrides,
  };
}

async function load(files: FileMap, opts: LoadConfigOptions = options()) {
  const reader = new RecordingReader(files);
  const result = await withGlobalDir(() =>
    loadConfigDetailed(PROJECT, reader, opts),
  );
  return { reader, loaded: result._unsafeUnwrap() };
}

/** Today's pipeline, built independently: builtins, global, project. */
async function today(files: FileMap): Promise<WeaveConfig> {
  const reader = new RecordingReader(files);
  const discovered = (
    await withGlobalDir(() => discoverAndParse(PROJECT, reader))
  )._unsafeUnwrap();
  return mergeConfigsResult(
    getResolvedBuiltinConfig()._unsafeUnwrap(),
    ...discovered.map(({ config, scope }) => resolvePromptPaths(config, scope)),
  )._unsafeUnwrap();
}

function dedupe(entries: readonly string[]): string[] {
  return [...new Set(entries)];
}

const OPT_IN = `settings { model_updates { mode auto } }`;

// ---------------------------------------------------------------------------
// Settings and paths
// ---------------------------------------------------------------------------

describe("resolveModelUpdates", () => {
  it("treats an absent block and mode off as no recommendations", () => {
    expect(resolveModelUpdates(undefined)).toBeUndefined();
    expect(resolveModelUpdates({ mode: "off", channel: "next" })).toBe(
      undefined,
    );
  });

  it("reads an unset channel as stable", () => {
    expect(resolveModelUpdates({ mode: "notify" })).toEqual({
      mode: "notify",
      channel: DEFAULT_MODEL_UPDATES_CHANNEL,
    });
    expect(DEFAULT_MODEL_UPDATES_CHANNEL).toBe("stable");
  });

  it("keeps a set channel", () => {
    expect(resolveModelUpdates({ mode: "auto", channel: "next" })).toEqual({
      mode: "auto",
      channel: "next",
    });
  });
});

describe("modelRecommendationsCachePaths", () => {
  it("lays the cache out per channel under the global config directory", () => {
    expect(modelRecommendationsCachePaths("next", "/g/.weave")).toEqual({
      dir: "/g/.weave/cache/model-recommendations/next",
      latest: "/g/.weave/cache/model-recommendations/next/latest.json",
      applied: "/g/.weave/cache/model-recommendations/next/applied.json",
      state: "/g/.weave/cache/model-recommendations/next/state.json",
      lock: "/g/.weave/cache/model-recommendations/next/lock",
    });
  });

  it("honours WEAVE_GLOBAL_CONFIG_DIR by default", () => {
    const paths = withGlobalDir(
      () => modelRecommendationsCachePaths("stable"),
      "C:\\Users\\t\\.weave",
    );
    expect(paths.applied).toBe(
      "C:/Users/t/.weave/cache/model-recommendations/stable/applied.json",
    );
  });
});

// ---------------------------------------------------------------------------
// Off or absent: nothing changes
// ---------------------------------------------------------------------------

describe("loadConfigDetailed without an opt-in", () => {
  const fixtures: Record<string, FileMap> = {
    "no user files": {},
    "a project override": { [PROJECT_PATH]: `agent loom { temperature 0.5 }` },
    "a global custom agent": {
      [GLOBAL_PATH]: `agent my-helper { prompt "I help" models ["gpt-4o"] }`,
    },
    "both layers": {
      [GLOBAL_PATH]: `settings { log_level INFO }`,
      [PROJECT_PATH]: `settings { log_level DEBUG }\nagent loom { temperature 0.9 }`,
    },
    "a user prompt_file": {
      [PROJECT_PATH]: `agent loom { prompt_file "loom.md" }`,
    },
    "mode off": {
      [GLOBAL_PATH]: `settings { model_updates { mode off channel next } }`,
    },
    "a project mode off over a global mode auto": {
      [GLOBAL_PATH]: OPT_IN,
      [PROJECT_PATH]: `settings { model_updates { mode off } }`,
    },
  };

  for (const [name, files] of Object.entries(fixtures)) {
    it(`returns today's config and reads no cache: ${name}`, async () => {
      const { reader, loaded } = await load({
        ...files,
        [STABLE_APPLIED]: "not even read",
        [NEXT_APPLIED]: "not even read",
      });
      expect(loaded.config).toEqual(await today(files));
      expect(loaded.diagnostics).toEqual([]);
      expect(reader.cacheReads()).toEqual([]);
    });
  }

  it("keeps loadConfig's output equal to today's for every fixture", async () => {
    for (const files of Object.values(fixtures)) {
      const reader = new RecordingReader(files);
      const config = (
        await withGlobalDir(() => loadConfig(PROJECT, reader))
      )._unsafeUnwrap();
      expect(config).toEqual(await today(files));
    }
  });
});

// ---------------------------------------------------------------------------
// A valid applied list
// ---------------------------------------------------------------------------

describe("loadConfigDetailed with a valid applied list", () => {
  it("orders each builtin's models user first, then recommended, then builtin, without duplicates", async () => {
    const { loaded } = await load(
      {
        [GLOBAL_PATH]: `${OPT_IN}\nagent loom { models ["my-model", "claude-opus-5-5"] }`,
        [STABLE_APPLIED]: await signed(list()),
      },
      options({ harness: "pi" }),
    );
    const models = loaded.config.agents.loom?.models ?? [];
    expect(models).toEqual(
      dedupe([
        "my-model",
        "claude-opus-5-5",
        "rec-default",
        "claude-opus-5-5",
        ...BUILTIN_LOOM,
      ]),
    );
    expect(new Set(models).size).toBe(models.length);
  });

  it("puts a project's entries ahead of the global's and the recommended ones", async () => {
    const { loaded } = await load(
      {
        [GLOBAL_PATH]: `${OPT_IN}\nagent loom { models ["global-model"] }`,
        [PROJECT_PATH]: `agent loom { models ["project-model"] }`,
        [STABLE_APPLIED]: await signed(list()),
      },
      options({ harness: "pi" }),
    );
    expect(loaded.config.agents.loom?.models?.slice(0, 3)).toEqual([
      "project-model",
      "global-model",
      "rec-default",
    ]);
  });

  it("uses the harness's own section when the file has one", async () => {
    const { loaded } = await load({
      [GLOBAL_PATH]: OPT_IN,
      [STABLE_APPLIED]: await signed(list()),
    });
    expect(loaded.config.agents.loom?.models).toEqual(
      dedupe(["github-copilot/rec-oc2", ...BUILTIN_LOOM]),
    );
    expect(loaded.diagnostics).toEqual([
      {
        type: "ModelRecommendationsApplied",
        channel: "stable",
        harness: "opencode2",
        section: "opencode2",
        path: STABLE_APPLIED,
        issued: "2026-10-01T09:00:00Z",
        expires: "2026-12-30T09:00:00Z",
        evidence: "https://tryweave.io/evals/runs/run-1",
        agents: ["loom"],
        skippedAgents: [],
      },
    ]);
  });

  it("gives Claude Code its tier entries", async () => {
    const { loaded } = await load(
      { [GLOBAL_PATH]: OPT_IN, [STABLE_APPLIED]: await signed(list()) },
      options({ harness: "claude-code" }),
    );
    expect(loaded.config.agents.loom?.models?.[0]).toBe("opus");
  });

  it("falls back to the default section for a harness without one", async () => {
    const { loaded } = await load(
      { [GLOBAL_PATH]: OPT_IN, [STABLE_APPLIED]: await signed(list()) },
      options({ harness: "pi" }),
    );
    expect(loaded.config.agents.loom?.models?.[0]).toBe("rec-default");
    const [diagnostic] = loaded.diagnostics;
    expect(diagnostic?.type === "ModelRecommendationsApplied").toBe(true);
    if (diagnostic?.type === "ModelRecommendationsApplied")
      expect(diagnostic.section).toBe("default");
  });

  it("adds no layer and reads no cache when the caller passes no harness", async () => {
    const files: FileMap = {
      [GLOBAL_PATH]: OPT_IN,
      [STABLE_APPLIED]: await signed(list()),
    };
    const { reader, loaded } = await load(
      files,
      options({ harness: undefined }),
    );
    expect(loaded.config).toEqual(await today(files));
    expect(loaded.diagnostics).toEqual([]);
    expect(reader.cacheReads()).toEqual([]);
  });

  it("leaves loadConfig without the layer, as a caller with no harness", async () => {
    const files: FileMap = {
      [GLOBAL_PATH]: OPT_IN,
      [STABLE_APPLIED]: await signed(list()),
    };
    const reader = new RecordingReader(files);
    const config = (
      await withGlobalDir(() => loadConfig(PROJECT, reader))
    )._unsafeUnwrap();
    expect(config).toEqual(await today(files));
    expect(reader.cacheReads()).toEqual([]);
  });

  it("skips and reports an agent that is not a builtin", async () => {
    const payload = list({
      harnesses: undefined,
      default: {
        agents: {
          loom: { models: ["rec-default"] },
          ghost: { models: ["rec-ghost"] },
        },
      },
    });
    const { loaded } = await load(
      { [GLOBAL_PATH]: OPT_IN, [STABLE_APPLIED]: await signed(payload) },
      options({ harness: "pi" }),
    );
    expect(loaded.config.agents.ghost).toBeUndefined();
    expect(loaded.config.agents.loom?.models?.[0]).toBe("rec-default");
    const [diagnostic] = loaded.diagnostics;
    if (diagnostic?.type !== "ModelRecommendationsApplied")
      throw new Error("expected an applied diagnostic");
    expect(diagnostic.agents).toEqual(["loom"]);
    expect(diagnostic.skippedAgents).toEqual(["ghost"]);
  });

  it("does not skip an agent a user defines that is not a builtin either", async () => {
    const payload = list({
      harnesses: undefined,
      default: { agents: { "my-helper": { models: ["rec-helper"] } } },
    });
    const { loaded } = await load(
      {
        [GLOBAL_PATH]: `${OPT_IN}\nagent my-helper { prompt "I help" models ["gpt-4o"] }`,
        [STABLE_APPLIED]: await signed(payload),
      },
      options({ harness: "pi" }),
    );
    expect(loaded.config.agents["my-helper"]?.models).toEqual(["gpt-4o"]);
  });

  it("leaves `disable agents` in force", async () => {
    const payload = list({
      harnesses: undefined,
      default: { agents: { warp: { models: ["rec-warp"] } } },
    });
    const { loaded } = await load(
      {
        [GLOBAL_PATH]: `${OPT_IN}\ndisable agents ["warp"]`,
        [STABLE_APPLIED]: await signed(payload),
      },
      options({ harness: "pi" }),
    );
    expect(loaded.config.disabled.agents).toContain("warp");
    expect(loaded.config.agents.warp?.models?.[0]).toBe("rec-warp");
  });

  it("changes nothing but builtin agents' models", async () => {
    const files: FileMap = {
      [GLOBAL_PATH]: `${OPT_IN}\nagent loom { temperature 0.4 }`,
      [STABLE_APPLIED]: await signed(list()),
    };
    const { loaded } = await load(files, options({ harness: "pi" }));
    const base = await today(files);
    const { loom: recommendedLoom, ...otherAgents } = loaded.config.agents;
    const { loom: baseLoom, ...baseOthers } = base.agents;
    expect(otherAgents).toEqual(baseOthers);
    expect({ ...recommendedLoom, models: undefined }).toEqual({
      ...baseLoom,
      models: undefined,
    });
    expect({ ...loaded.config, agents: {} }).toEqual({ ...base, agents: {} });
  });

  it("reads the channel the merged setting names, project over global", async () => {
    const { reader, loaded } = await load(
      {
        [GLOBAL_PATH]: `settings { model_updates { mode auto channel next } }`,
        [PROJECT_PATH]: `settings { model_updates { mode notify } }`,
        [NEXT_APPLIED]: await signed(list({ channel: "next" })),
      },
      options({ harness: "pi" }),
    );
    expect(reader.cacheReads()).toContain(NEXT_APPLIED);
    expect(reader.cacheReads()).not.toContain(STABLE_APPLIED);
    expect(loaded.config.agents.loom?.models?.[0]).toBe("rec-default");
  });

  it("accepts a list whose min_config_version is this client's version", async () => {
    const payload = list({
      min_config_version: MODEL_RECOMMENDATIONS_CLIENT_VERSION,
    });
    const { loaded } = await load({
      [GLOBAL_PATH]: OPT_IN,
      [STABLE_APPLIED]: await signed(payload),
    });
    expect(loaded.diagnostics[0]?.type).toBe("ModelRecommendationsApplied");
  });

  it("does not check rollback: there is no older list to compare with at load", async () => {
    const { loaded } = await load({
      [GLOBAL_PATH]: OPT_IN,
      [STABLE_APPLIED]: await signed(list()),
    });
    expect(loaded.diagnostics[0]?.type).toBe("ModelRecommendationsApplied");
  });
});

// ---------------------------------------------------------------------------
// A skipped layer
// ---------------------------------------------------------------------------

describe("loadConfigDetailed with an applied list it cannot use", () => {
  type Case = {
    readonly name: string;
    readonly reason: ModelRecommendationsSkipReason["type"];
    readonly files: () => Promise<FileMap>;
    readonly options?: LoadConfigOptions;
  };

  const cases: Case[] = [
    {
      name: "unreadable",
      reason: "Unreadable",
      files: async () => ({ [STABLE_APPLIED]: "ERROR" }),
    },
    {
      name: "signed by an unknown key",
      reason: "SignatureInvalid",
      files: async () => ({
        [STABLE_APPLIED]: await signed(list(), otherKeys.privateKey),
      }),
    },
    {
      name: "tampered after signing",
      reason: "SignatureInvalid",
      files: async () => {
        const envelope = JSON.parse(await signed(list()));
        return {
          [STABLE_APPLIED]: JSON.stringify({
            ...envelope,
            payload: envelope.payload.replace("rec-oc2", "rec-evil"),
          }),
        };
      },
    },
    {
      name: "not an envelope",
      reason: "EnvelopeInvalid",
      files: async () => ({ [STABLE_APPLIED]: "{ torn" }),
    },
    {
      name: "signed but schema-invalid",
      reason: "SchemaInvalid",
      files: async () => ({
        [STABLE_APPLIED]: await signed(list({ schema: 2 })),
      }),
    },
    {
      name: "expired",
      reason: "Expired",
      files: async () => ({ [STABLE_APPLIED]: await signed(list()) }),
      options: { now: () => new Date("2027-01-01T00:00:00Z") },
    },
    {
      name: "older than this release's builtins",
      reason: "OlderThanBuiltins",
      files: async () => ({
        [STABLE_APPLIED]: await signed(
          list({
            issued: "2026-09-01T00:00:00Z",
            expires: "2026-11-01T00:00:00Z",
          }),
        ),
      }),
    },
    {
      name: "issued too far in the future",
      reason: "IssuedInFuture",
      files: async () => ({
        [STABLE_APPLIED]: await signed(
          list({
            issued: "2026-10-05T00:00:00Z",
            expires: "2026-12-30T00:00:00Z",
          }),
        ),
      }),
    },
    {
      name: "too new for this client",
      reason: "ClientTooOld",
      files: async () => ({
        [STABLE_APPLIED]: await signed(list({ min_config_version: "1.0.1" })),
      }),
    },
    {
      name: "for another channel",
      reason: "ChannelMismatch",
      files: async () => ({
        [STABLE_APPLIED]: await signed(list({ channel: "next" })),
      }),
    },
  ];

  for (const testCase of cases) {
    it(`skips the layer and says why: ${testCase.name}`, async () => {
      const files: FileMap = {
        [GLOBAL_PATH]: `${OPT_IN}\nagent loom { models ["my-model"] }`,
        ...(await testCase.files()),
      };
      const { loaded } = await load(files, options(testCase.options));
      expect(loaded.config).toEqual(await today(files));
      expect(loaded.diagnostics).toHaveLength(1);
      const [diagnostic] = loaded.diagnostics as ConfigLoadDiagnostic[];
      if (diagnostic?.type !== "ModelRecommendationsSkipped")
        throw new Error("expected a skipped diagnostic");
      expect(diagnostic.reason.type).toBe(testCase.reason);
      expect(diagnostic.path).toBe(STABLE_APPLIED);
      expect(diagnostic.channel).toBe("stable");
      expect(diagnostic.harness).toBe("opencode2");
      expect(
        describeModelRecommendationsSkipReason(diagnostic.reason).length,
      ).toBeGreaterThan(0);
    });
  }

  it("reports an opted-in channel with nothing applied yet as pending, not skipped", async () => {
    const files: FileMap = {
      [GLOBAL_PATH]: `${OPT_IN}\nagent loom { models ["my-model"] }`,
    };
    const { loaded } = await load(files);
    expect(loaded.config).toEqual(await today(files));
    expect(loaded.diagnostics).toEqual([
      {
        type: "ModelRecommendationsPending",
        channel: "stable",
        harness: "opencode2",
        path: STABLE_APPLIED,
      },
    ]);
  });

  it("compares min_config_version with MODEL_RECOMMENDATIONS_CLIENT_VERSION by default", async () => {
    const { loaded } = await load({
      [GLOBAL_PATH]: OPT_IN,
      [STABLE_APPLIED]: await signed(list({ min_config_version: "99.0.0" })),
    });
    const [diagnostic] = loaded.diagnostics;
    if (diagnostic?.type !== "ModelRecommendationsSkipped")
      throw new Error("expected a skipped diagnostic");
    expect(diagnostic.reason).toEqual({
      type: "ClientTooOld",
      required: "99.0.0",
      actual: MODEL_RECOMMENDATIONS_CLIENT_VERSION,
    });
  });

  it("lets a caller pass its own client version", async () => {
    const { loaded } = await load(
      {
        [GLOBAL_PATH]: OPT_IN,
        [STABLE_APPLIED]: await signed(list({ min_config_version: "2.0.0" })),
      },
      options({ clientVersion: "2.1.0" }),
    );
    expect(loaded.diagnostics[0]?.type).toBe("ModelRecommendationsApplied");
  });

  it("never fails the load because of the cache", async () => {
    const reader: FileReader = {
      exists: (path) =>
        path.includes("/cache/")
          ? Promise.reject(new Error("permission denied"))
          : Promise.resolve(path === GLOBAL_PATH),
      read: () => okAsync(OPT_IN),
    };
    const result = await withGlobalDir(() =>
      loadConfigDetailed(PROJECT, reader, options()),
    );
    const [diagnostic] = result._unsafeUnwrap().diagnostics;
    if (diagnostic?.type !== "ModelRecommendationsSkipped")
      throw new Error("expected a skipped diagnostic");
    expect(diagnostic.reason.type).toBe("Unreadable");
  });

  it("reports a reader that throws synchronously as unreadable", async () => {
    const reader: FileReader = {
      exists: (path) => {
        if (path.includes("/cache/")) throw new Error("sync failure");
        return Promise.resolve(path === GLOBAL_PATH);
      },
      read: () => okAsync(OPT_IN),
    };
    const result = await withGlobalDir(() =>
      loadConfigDetailed(PROJECT, reader, options()),
    );
    const [diagnostic] = result._unsafeUnwrap().diagnostics;
    if (diagnostic?.type !== "ModelRecommendationsSkipped")
      throw new Error("expected a skipped diagnostic");
    expect(diagnostic.reason.type).toBe("Unreadable");
  });
});
