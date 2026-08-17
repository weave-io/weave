import { describe, expect, it } from "bun:test";
import type { ConfigLoadError, FileReader } from "@weaveio/weave-config";
import type { WeaveConfig } from "@weaveio/weave-core";
import type {
  MaterializationPlan,
  PromptFileReader,
} from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import {
  defaultPiConfigLoaderPort,
  defaultPiMaterializerPort,
  PiConfigActivator,
  type PiConfigLoaderPort,
  type PiMaterializerPort,
} from "../config-activator.js";
import {
  buildPiConfigRefreshCandidate,
  type PiConfigCatalogState,
  type PiConfigRefreshDeps,
  refreshPiConfigCandidate,
} from "../config-refresh.js";
import {
  createPiConfigSourceManifest,
  discoverPromptSourcePaths,
  hashConfigSourceContent,
  type PiConfigSourceFsError,
  type PiConfigSourceFsPort,
  type PiConfigSourceIdentity,
  type PiConfigSourceRefresh,
  refreshConfigSourceManifest,
  resolvePiConfigSourcePaths,
} from "../config-source-digests.js";

// ---------------------------------------------------------------------------
// Fake filesystem port — never touches the real filesystem
// ---------------------------------------------------------------------------

interface FakeFile {
  readonly content: string;
  readonly mtimeMs: number;
}

type FakeFiles = Record<string, FakeFile>;

interface FakeFs extends PiConfigSourceFsPort {
  readonly statCalls: string[];
  readonly readCalls: string[];
}

function fakeFs(
  files: FakeFiles,
  failures: {
    readonly stat?: Record<string, string>;
    readonly read?: Record<string, string>;
  } = {},
): FakeFs {
  const statCalls: string[] = [];
  const readCalls: string[] = [];

  return {
    statCalls,
    readCalls,
    statFile: (path) => {
      statCalls.push(path);
      const failure = failures.stat?.[path];
      if (failure !== undefined) {
        return errAsync<undefined, PiConfigSourceFsError>({
          type: "StatFailed",
          path,
          message: failure,
        });
      }
      const file = files[path];
      if (file === undefined) return okAsync(undefined);
      return okAsync({ size: file.content.length, mtimeMs: file.mtimeMs });
    },
    readFile: (path) => {
      readCalls.push(path);
      const failure = failures.read?.[path];
      if (failure !== undefined) {
        return errAsync<string, PiConfigSourceFsError>({
          type: "ReadFailed",
          path,
          message: failure,
        });
      }
      const file = files[path];
      if (file === undefined) {
        return errAsync<string, PiConfigSourceFsError>({
          type: "ReadFailed",
          path,
          message: "missing",
        });
      }
      return okAsync(file.content);
    },
  };
}

/** In-memory `FileReader` used only to seed the "current" activation. */
function memoryFileReader(files: FakeFiles): FileReader {
  return {
    exists: async (path) => path in files,
    read: (path) => {
      const file = files[path];
      if (file === undefined) {
        return errAsync<string, ConfigLoadError>({
          type: "FileReadError",
          path,
          cause: new Error("not found"),
        });
      }
      return okAsync(file.content);
    },
  };
}

/** In-memory `PromptFileReader` used only to seed the "current" activation. */
function memoryPromptFileReader(files: FakeFiles): PromptFileReader {
  return {
    read: (path) => {
      const file = files[path];
      if (file === undefined) return errAsync({ message: "not found" });
      return okAsync(file.content);
    },
  };
}

function countingLoader(): {
  readonly port: PiConfigLoaderPort;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    port: {
      load: (projectRoot, fileReader) => {
        calls.push(projectRoot);
        return defaultPiConfigLoaderPort.load(projectRoot, fileReader);
      },
    },
  };
}

function occurrences(values: readonly string[], value: string): number {
  return values.filter((entry) => entry === value).length;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ROOT = "/my/project";
const HOME = process.env.HOME ?? "/home/testuser";
const GLOBAL_CONFIG = `${HOME}/.weave/config.weave`;
const PROJECT_CONFIG = `${PROJECT_ROOT}/.weave/config.weave`;
const PROMPT_ALPHA = `${PROJECT_ROOT}/.weave/prompts/alpha.md`;
const PROMPT_BETA = `${PROJECT_ROOT}/.weave/prompts/beta.md`;
const PROMPT_GAMMA = `${PROJECT_ROOT}/.weave/prompts/gamma.md`;

const TRUSTED_IDENTITY: PiConfigSourceIdentity = {
  projectRoot: PROJECT_ROOT,
  trust: "trusted",
};
const WITHHELD_IDENTITY: PiConfigSourceIdentity = {
  projectRoot: PROJECT_ROOT,
  trust: "withheld",
};

const GLOBAL_TEXT = `
agent gamma {
  prompt "global gamma"
  models ["m1"]
  mode subagent
}
`;

const PROJECT_TEXT_V1 = `
agent alpha {
  prompt_file "alpha.md"
  models ["m1"]
  mode subagent
}

agent beta {
  prompt "inline beta v1"
  prompt_append_file "beta.md"
  models ["m1"]
  mode subagent
}
`;

const PROJECT_TEXT_INLINE_V2 = PROJECT_TEXT_V1.replace(
  '"inline beta v1"',
  '"inline beta v2"',
);

const PROJECT_TEXT_MULTILINE = `
agent alpha {
  prompt_file "alpha.md"
  models ["m1"]
  mode subagent
}

agent beta {
  prompt """
      beta line one

      beta line two
  """
  prompt_append_file "beta.md"
  models ["m1"]
  mode subagent
}
`;

const PROJECT_TEXT_UNTERMINATED = `
agent alpha {
  prompt_file "alpha.md"
  models ["m1"]
  mode subagent
}

agent beta {
  prompt """
      beta line one
  models ["m1"]
  mode subagent
}
`;

const PROJECT_TEXT_REPOINTED = PROJECT_TEXT_V1.replace(
  'prompt_file "alpha.md"',
  'prompt_file "gamma.md"',
);

const ALPHA_V1 = "alpha prompt v1\n";
const ALPHA_V2 = "alpha prompt v2\n";
const BETA_APPEND = "beta append v1\n";
const GAMMA_PROMPT = "gamma prompt v1\n";

function trustedFiles(): FakeFiles {
  return {
    [GLOBAL_CONFIG]: { content: GLOBAL_TEXT, mtimeMs: 1_000 },
    [PROJECT_CONFIG]: { content: PROJECT_TEXT_V1, mtimeMs: 2_000 },
    [PROMPT_ALPHA]: { content: ALPHA_V1, mtimeMs: 3_000 },
    [PROMPT_BETA]: { content: BETA_APPEND, mtimeMs: 4_000 },
  };
}

/**
 * Builds the "currently published" catalog state through the real pipeline,
 * with every read served from the in-memory fixture.
 */
async function seedState(
  files: FakeFiles,
  identity: PiConfigSourceIdentity = TRUSTED_IDENTITY,
): Promise<PiConfigCatalogState> {
  const activation = (
    await new PiConfigActivator({
      fileReader: memoryFileReader(files),
      promptFileReader: memoryPromptFileReader(files),
    }).activate({
      projectRoot: identity.projectRoot,
      trust: identity.trust,
    })
  )._unsafeUnwrap();

  const paths = resolvePiConfigSourcePaths({ identity });
  const empty = createPiConfigSourceManifest({
    identity,
    globalConfigPath: paths.globalConfigPath,
    projectConfigPath: paths.projectConfigPath,
    promptFilePaths: discoverPromptSourcePaths(activation.config),
  });

  const seeded = (
    await refreshConfigSourceManifest(empty, fakeFs(files))
  )._unsafeUnwrap();

  return {
    activation,
    manifest: seeded.manifest,
    contents: new Map(
      seeded.reads.map((read) => [
        read.path,
        { content: read.content, sha256: read.sha256 },
      ]),
    ),
  };
}

function snapshot(state: PiConfigCatalogState): string {
  return JSON.stringify({
    manifest: state.manifest,
    contents: [...state.contents.entries()].sort(),
    order: state.activation.descriptors.order,
    prompts: state.activation.descriptors.order.map(
      (name) => state.activation.descriptors.byName.get(name)?.composedPrompt,
    ),
  });
}

function composedPrompt(
  state: PiConfigCatalogState,
  agentName: string,
): string {
  return (
    state.activation.descriptors.byName.get(agentName)?.composedPrompt ?? ""
  );
}

function digestOf(state: PiConfigCatalogState, path: string): string {
  return state.manifest.files.find((file) => file.path === path)?.sha256 ?? "";
}

// ---------------------------------------------------------------------------
// Unchanged fast path
// ---------------------------------------------------------------------------

describe("refreshPiConfigCandidate — unchanged", () => {
  it("returns the current activation by reference with zero reads and zero parses", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    const before = snapshot(state);
    const fs = fakeFs(files);
    const loader = countingLoader();

    const result = await refreshPiConfigCandidate(state, {
      fs,
      configLoader: loader.port,
    });

    const candidate = result._unsafeUnwrap();
    expect(candidate.change).toBe("unchanged");
    expect(candidate.changedPaths).toEqual([]);
    expect(candidate.next.activation).toBe(state.activation);
    expect(fs.readCalls).toEqual([]);
    expect(loader.calls).toEqual([]);
    expect(fs.statCalls.length).toBe(state.manifest.files.length);
    expect(snapshot(state)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// prompt-only
// ---------------------------------------------------------------------------

describe("refreshPiConfigCandidate — prompt-only", () => {
  it("performs zero config parses and exactly one read of the changed prompt file", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    const before = snapshot(state);
    files[PROMPT_ALPHA] = { content: ALPHA_V2, mtimeMs: 3_500 };

    const fs = fakeFs(files);
    const loader = countingLoader();
    const result = await refreshPiConfigCandidate(state, {
      fs,
      configLoader: loader.port,
    });

    const candidate = result._unsafeUnwrap();
    expect(candidate.change).toBe("prompt-only");
    expect(candidate.changedPaths).toEqual([PROMPT_ALPHA]);
    // Zero parses: the loader port was never consulted.
    expect(loader.calls).toEqual([]);
    // Exactly one read, of the changed path only. Unchanged prompt bytes and
    // config bytes came from the content cache.
    expect(fs.readCalls).toEqual([PROMPT_ALPHA]);

    expect(composedPrompt(candidate.next, "alpha")).toContain(ALPHA_V2.trim());
    expect(composedPrompt(candidate.next, "beta")).toContain(
      BETA_APPEND.trim(),
    );
    expect(candidate.next.manifest.files).toContainEqual({
      kind: "prompt-file",
      path: PROMPT_ALPHA,
      presence: "present",
      size: ALPHA_V2.length,
      mtimeMs: 3_500,
      sha256: hashConfigSourceContent(ALPHA_V2),
    });
    expect(candidate.next.contents.get(PROMPT_ALPHA)?.content).toBe(ALPHA_V2);

    // The merged config and the Pi-local settings are carried, not recomputed.
    expect(candidate.next.activation.config).toBe(state.activation.config);
    expect(candidate.next.activation.childLifecycleSettings).toBe(
      state.activation.childLifecycleSettings,
    );
    expect(candidate.next.activation.childInspectionSettings).toBe(
      state.activation.childInspectionSettings,
    );

    // Nothing about the current catalog moved.
    expect(snapshot(state)).toBe(before);
    expect(composedPrompt(state, "alpha")).toContain(ALPHA_V1.trim());
  });

  it("builds the same candidate from an already-classified refresh", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    files[PROMPT_ALPHA] = { content: ALPHA_V2, mtimeMs: 3_500 };

    const probeFs = fakeFs(files);
    const classified = (
      await refreshConfigSourceManifest(state.manifest, probeFs)
    )._unsafeUnwrap();
    expect(classified.change.kind).toBe("prompt-only");

    const buildFs = fakeFs(files);
    const loader = countingLoader();
    const candidate = (
      await buildPiConfigRefreshCandidate(state, classified, {
        fs: buildFs,
        configLoader: loader.port,
      })
    )._unsafeUnwrap();

    // The bytes the manifest layer already read are reused verbatim: the
    // candidate build itself reads nothing and parses nothing.
    expect(buildFs.readCalls).toEqual([]);
    expect(loader.calls).toEqual([]);
    expect(composedPrompt(candidate.next, "alpha")).toContain(ALPHA_V2.trim());
  });

  it("re-reads an unchanged prompt file only when its bytes are not cached", async () => {
    const files = trustedFiles();
    const seeded = await seedState(files);
    const state: PiConfigCatalogState = { ...seeded, contents: new Map() };
    files[PROMPT_ALPHA] = { content: ALPHA_V2, mtimeMs: 3_500 };

    const fs = fakeFs(files);
    const candidate = (
      await refreshPiConfigCandidate(state, { fs })
    )._unsafeUnwrap();

    expect(candidate.change).toBe("prompt-only");
    expect(occurrences(fs.readCalls, PROMPT_ALPHA)).toBe(1);
    expect(occurrences(fs.readCalls, PROMPT_BETA)).toBe(1);
    expect(candidate.next.contents.get(PROMPT_BETA)?.content).toBe(BETA_APPEND);
  });
});

// ---------------------------------------------------------------------------
// config-changed
// ---------------------------------------------------------------------------

describe("refreshPiConfigCandidate — config-changed", () => {
  it("reparses once and reads each changed file exactly once", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    const before = snapshot(state);
    files[PROJECT_CONFIG] = {
      content: PROJECT_TEXT_INLINE_V2,
      mtimeMs: 2_500,
    };

    const fs = fakeFs(files);
    const loader = countingLoader();
    const materializeCalls: (PromptFileReader | undefined)[] = [];
    const candidate = (
      await refreshPiConfigCandidate(state, {
        fs,
        configLoader: loader.port,
        materializer: {
          materialize: (config, promptFileReader) => {
            materializeCalls.push(promptFileReader);
            return defaultPiMaterializerPort.materialize(
              config,
              promptFileReader,
            );
          },
        },
      })
    )._unsafeUnwrap();

    expect(candidate.change).toBe("config-changed");
    // One activation: one parse, one materialization.
    expect(loader.calls).toEqual([PROJECT_ROOT]);
    expect(materializeCalls).toHaveLength(1);
    expect(materializeCalls[0]).toBeDefined();
    expect(fs.readCalls).toEqual([PROJECT_CONFIG]);
    expect(composedPrompt(candidate.next, "beta")).toContain("inline beta v2");
    expect(digestOf(candidate.next, PROJECT_CONFIG)).toBe(
      hashConfigSourceContent(PROJECT_TEXT_INLINE_V2),
    );
    expect(snapshot(state)).toBe(before);
  });

  it("detects a multiline inline prompt edit through the owning config digest", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    files[PROJECT_CONFIG] = {
      content: PROJECT_TEXT_MULTILINE,
      mtimeMs: 2_600,
    };

    const fs = fakeFs(files);
    const candidate = (
      await refreshPiConfigCandidate(state, { fs })
    )._unsafeUnwrap();

    expect(candidate.change).toBe("config-changed");
    expect(composedPrompt(candidate.next, "beta")).toContain(
      "beta line one\n\nbeta line two",
    );
  });

  it("rediscovers prompt references: new files are read and hashed, dropped ones leave the manifest", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    files[PROJECT_CONFIG] = { content: PROJECT_TEXT_REPOINTED, mtimeMs: 2_700 };
    files[PROMPT_GAMMA] = { content: GAMMA_PROMPT, mtimeMs: 5_000 };

    const fs = fakeFs(files);
    const candidate = (
      await refreshPiConfigCandidate(state, { fs })
    )._unsafeUnwrap();

    const paths = candidate.next.manifest.files.map((file) => file.path);
    expect(paths).toContain(PROMPT_GAMMA);
    expect(paths).not.toContain(PROMPT_ALPHA);
    expect(digestOf(candidate.next, PROMPT_GAMMA)).toBe(
      hashConfigSourceContent(GAMMA_PROMPT),
    );
    expect(occurrences(fs.readCalls, PROMPT_GAMMA)).toBe(1);
    expect(occurrences(fs.readCalls, PROJECT_CONFIG)).toBe(1);
    expect(candidate.next.contents.has(PROMPT_ALPHA)).toBe(false);
    expect(candidate.next.contents.get(PROMPT_GAMMA)?.content).toBe(
      GAMMA_PROMPT,
    );
    expect(composedPrompt(candidate.next, "alpha")).toContain(
      GAMMA_PROMPT.trim(),
    );
  });

  it("threads a prompt reader into materialization that serves the already-hashed bytes", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    files[PROJECT_CONFIG] = {
      content: PROJECT_TEXT_INLINE_V2,
      mtimeMs: 2_500,
    };

    let captured: PromptFileReader | undefined;
    const materializer: PiMaterializerPort = {
      materialize: (_config, promptFileReader) => {
        captured = promptFileReader;
        return okAsync<MaterializationPlan, never>({ agents: [], errors: [] });
      },
    };

    const fs = fakeFs(files);
    const result = await refreshPiConfigCandidate(state, { fs, materializer });
    expect(result.isOk()).toBe(true);
    expect(captured).toBeDefined();

    const readsBefore = fs.readCalls.length;
    const served = await (captured as PromptFileReader).read(PROMPT_ALPHA);
    expect(served._unsafeUnwrap()).toBe(ALPHA_V1);
    expect(fs.readCalls.length).toBe(readsBefore);
  });
});

// ---------------------------------------------------------------------------
// Typed failures — no candidate, no side effect
// ---------------------------------------------------------------------------

describe("refreshPiConfigCandidate — typed failures", () => {
  it("maps an unterminated multiline edit to ConfigParseFailed and leaves the catalog untouched", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    const before = snapshot(state);
    files[PROJECT_CONFIG] = {
      content: PROJECT_TEXT_UNTERMINATED,
      mtimeMs: 2_800,
    };

    const fs = fakeFs(files);
    const failure = (
      await refreshPiConfigCandidate(state, { fs })
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "ConfigParseFailed",
      errorCount: 1,
      errorTypes: ["ParseError"],
    });

    // The underlying core diagnostic really is the lexer's UnterminatedString.
    const direct = await defaultPiConfigLoaderPort.load(
      PROJECT_ROOT,
      memoryFileReader(files),
    );
    const loadErrors = direct._unsafeUnwrapErr();
    const parseError = loadErrors.find((error) => error.type === "ParseError");
    expect(
      parseError?.type === "ParseError"
        ? parseError.errors.map((error) => error.type)
        : [],
    ).toContain("UnterminatedString");

    expect(snapshot(state)).toBe(before);
    expect(state.contents.get(PROJECT_CONFIG)?.content).toBe(PROJECT_TEXT_V1);
    expect(composedPrompt(state, "beta")).toContain("inline beta v1");
  });

  it("maps a stat failure on a known source to SourceReadFailed", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    const before = snapshot(state);

    const fs = fakeFs(files, { stat: { [PROMPT_BETA]: "permission denied" } });
    const failure = (
      await refreshPiConfigCandidate(state, { fs })
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "SourceReadFailed",
      kind: "prompt-file",
      path: PROMPT_BETA,
      message: "permission denied",
    });
    expect(snapshot(state)).toBe(before);
  });

  it("maps a read failure on a changed config to SourceReadFailed", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    const before = snapshot(state);
    files[PROJECT_CONFIG] = {
      content: PROJECT_TEXT_INLINE_V2,
      mtimeMs: 2_500,
    };

    const fs = fakeFs(files, { read: { [PROJECT_CONFIG]: "io error" } });
    const loader = countingLoader();
    const failure = (
      await refreshPiConfigCandidate(state, { fs, configLoader: loader.port })
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "SourceReadFailed",
      kind: "project-config",
      path: PROJECT_CONFIG,
      message: "io error",
    });
    expect(loader.calls).toEqual([]);
    expect(snapshot(state)).toBe(before);
  });

  it("maps a deleted known prompt file to PromptFileMissing", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    const before = snapshot(state);
    delete files[PROMPT_ALPHA];

    const fs = fakeFs(files);
    const failure = (
      await refreshPiConfigCandidate(state, { fs })
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "PromptFileMissing",
      path: PROMPT_ALPHA,
    });
    expect(snapshot(state)).toBe(before);
  });

  it("maps a newly referenced but missing prompt file to PromptFileMissing", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    const before = snapshot(state);
    // Repoints alpha at gamma.md, which does not exist.
    files[PROJECT_CONFIG] = { content: PROJECT_TEXT_REPOINTED, mtimeMs: 2_700 };

    const fs = fakeFs(files);
    const failure = (
      await refreshPiConfigCandidate(state, { fs })
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "PromptFileMissing",
      path: PROMPT_GAMMA,
    });
    expect(snapshot(state)).toBe(before);
  });

  it("maps a failed read of a newly referenced prompt file to SourceReadFailed", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    const before = snapshot(state);
    files[PROJECT_CONFIG] = { content: PROJECT_TEXT_REPOINTED, mtimeMs: 2_700 };
    files[PROMPT_GAMMA] = { content: GAMMA_PROMPT, mtimeMs: 5_000 };

    const fs = fakeFs(files, { read: { [PROMPT_GAMMA]: "io error" } });
    const failure = (
      await refreshPiConfigCandidate(state, { fs })
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "SourceReadFailed",
      kind: "prompt-file",
      path: PROMPT_GAMMA,
      message: "io error",
    });
    expect(occurrences(fs.readCalls, PROMPT_GAMMA)).toBe(1);
    expect(snapshot(state)).toBe(before);
  });

  it("maps a throwing materializer to MaterializationFailed", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    const before = snapshot(state);
    files[PROJECT_CONFIG] = {
      content: PROJECT_TEXT_INLINE_V2,
      mtimeMs: 2_500,
    };

    const materializer: PiMaterializerPort = {
      materialize: () => {
        throw new Error("boom");
      },
    };
    const fs = fakeFs(files);
    const failure = (
      await refreshPiConfigCandidate(state, { fs, materializer })
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "MaterializationFailed",
      reason: "materialize-threw",
    });
    expect(snapshot(state)).toBe(before);
  });

  it("maps a throwing materializer on the prompt-only path to MaterializationFailed", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    files[PROMPT_ALPHA] = { content: ALPHA_V2, mtimeMs: 3_500 };

    const materializer: PiMaterializerPort = {
      materialize: () =>
        Promise.reject(new Error("boom")) as unknown as ReturnType<
          PiMaterializerPort["materialize"]
        >,
    };
    const fs = fakeFs(files);
    const failure = (
      await refreshPiConfigCandidate(state, { fs, materializer })
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "MaterializationFailed",
      reason: "materialize-threw",
    });
  });

  it("maps invalid Pi lifecycle settings to LifecycleSettingsInvalid", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    const before = snapshot(state);
    files[PROJECT_CONFIG] = {
      content: PROJECT_TEXT_INLINE_V2,
      mtimeMs: 2_500,
    };

    const invalidConfig = {
      agents: {},
      disabled: { agents: [], skills: [] },
      settings: { adapters: "not-an-object" },
    } as unknown as WeaveConfig;

    const fs = fakeFs(files);
    const failure = (
      await refreshPiConfigCandidate(state, {
        fs,
        configLoader: { load: () => okAsync(invalidConfig) },
        materializer: {
          materialize: () =>
            okAsync<MaterializationPlan, never>({ agents: [], errors: [] }),
        },
      })
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "LifecycleSettingsInvalid",
      issueCount: 1,
    });
    expect(snapshot(state)).toBe(before);
  });

  it("maps a loader that reports merge errors to ConfigParseFailed with the real discriminants", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    files[PROJECT_CONFIG] = {
      content: PROJECT_TEXT_INLINE_V2,
      mtimeMs: 2_500,
    };

    const loadErrors: ConfigLoadError[] = [
      { type: "MergeError", errors: [] },
      { type: "MergeError", errors: [] },
    ];
    const fs = fakeFs(files);
    const failure = (
      await refreshPiConfigCandidate(state, {
        fs,
        configLoader: { load: () => errAsync(loadErrors) },
      })
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "ConfigParseFailed",
      errorCount: 2,
      errorTypes: ["MergeError"],
    });
  });

  it("maps a throwing filesystem port to a typed SourceReadFailed", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    const fs: PiConfigSourceFsPort = {
      statFile: () => {
        throw new Error("port exploded");
      },
      readFile: () => {
        throw new Error("port exploded");
      },
    };

    const failure = (
      await refreshPiConfigCandidate(state, { fs })
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "SourceReadFailed",
      kind: "unknown",
      path: undefined,
      message: "source-port-threw",
    });
  });
});

// ---------------------------------------------------------------------------
// Accumulated per-agent errors stay publishable
// ---------------------------------------------------------------------------

describe("refreshPiConfigCandidate — per-agent materialization errors", () => {
  it("keeps accumulated descriptor failures in the candidate instead of failing the attempt", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    files[PROJECT_CONFIG] = {
      content: PROJECT_TEXT_INLINE_V2,
      mtimeMs: 2_500,
    };

    const plan: MaterializationPlan = {
      agents: [],
      errors: [
        {
          type: "DescriptorCompositionFailure",
          agentName: "alpha",
          cause: {
            type: "PromptSourceMissingError",
            agentName: "alpha",
            message: "no prompt",
          },
        },
      ],
    };
    const fs = fakeFs(files);
    const candidate = (
      await refreshPiConfigCandidate(state, {
        fs,
        materializer: { materialize: () => okAsync(plan) },
      })
    )._unsafeUnwrap();

    expect(candidate.change).toBe("config-changed");
    expect(candidate.next.activation.descriptors.errors).toHaveLength(1);
    expect(candidate.next.activation.descriptors.byName.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

describe("refreshPiConfigCandidate — trust withheld", () => {
  it("never reads the project config or a project prompt path", async () => {
    const files: FakeFiles = {
      [GLOBAL_CONFIG]: { content: GLOBAL_TEXT, mtimeMs: 1_000 },
      [PROJECT_CONFIG]: { content: PROJECT_TEXT_V1, mtimeMs: 2_000 },
      [PROMPT_ALPHA]: { content: ALPHA_V1, mtimeMs: 3_000 },
    };
    const state = await seedState(files, WITHHELD_IDENTITY);

    // The project config is not even a source under withheld trust.
    expect(state.manifest.files.map((file) => file.path)).toEqual([
      GLOBAL_CONFIG,
    ]);

    files[GLOBAL_CONFIG] = {
      content: GLOBAL_TEXT.replace("global gamma", "global gamma v2"),
      mtimeMs: 1_500,
    };

    const fs = fakeFs(files);
    const emptyPlan: MaterializationPlan = { agents: [], errors: [] };
    const materializer: PiMaterializerPort = {
      materialize: (_config, promptFileReader) => {
        // A materializer that tries to reach a project prompt path must be
        // refused before the filesystem port is touched.
        const reader = promptFileReader ?? memoryPromptFileReader(files);
        return reader
          .read(PROMPT_ALPHA)
          .map(() => emptyPlan)
          .orElse(() => okAsync<MaterializationPlan, never>(emptyPlan));
      },
    };

    const failure = (
      await refreshPiConfigCandidate(state, { fs, materializer })
    )._unsafeUnwrapErr();

    expect(failure).toEqual({
      type: "SourceReadFailed",
      kind: "prompt-file",
      path: PROMPT_ALPHA,
      message: "project-trust-withheld",
    });
    expect(fs.readCalls).toEqual([GLOBAL_CONFIG]);
    expect(
      [...fs.statCalls, ...fs.readCalls].filter((path) =>
        path.startsWith(`${PROJECT_ROOT}/.weave/`),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Direct candidate builder contract
// ---------------------------------------------------------------------------

describe("buildPiConfigRefreshCandidate", () => {
  it("publishes nothing: the caller's state object is never mutated", async () => {
    const files = trustedFiles();
    const state = await seedState(files);
    const before = snapshot(state);
    files[PROJECT_CONFIG] = {
      content: PROJECT_TEXT_INLINE_V2,
      mtimeMs: 2_500,
    };

    const probeFs = fakeFs(files);
    const classified: PiConfigSourceRefresh = (
      await refreshConfigSourceManifest(state.manifest, probeFs)
    )._unsafeUnwrap();

    const deps: PiConfigRefreshDeps = { fs: fakeFs(files) };
    const candidate = (
      await buildPiConfigRefreshCandidate(state, classified, deps)
    )._unsafeUnwrap();

    expect(candidate.next).not.toBe(state);
    expect(candidate.next.manifest).not.toBe(state.manifest);
    expect(candidate.next.activation).not.toBe(state.activation);
    expect(snapshot(state)).toBe(before);
  });
});
