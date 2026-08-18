import { describe, expect, it } from "bun:test";
import type { ConfigLoadError, FileReader } from "@weaveio/weave-config";
import type { WeaveConfig } from "@weaveio/weave-core";
import type {
  AgentDescriptor,
  MaterializationPlan,
  PromptFileReader,
} from "@weaveio/weave-engine";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { createPiCatalogCell, type PiCatalogCell } from "../catalog-cell.js";
import {
  defaultPiConfigLoaderPort,
  defaultPiMaterializerPort,
  PiConfigActivator,
  type PiConfigLoaderPort,
  type PiMaterializerPort,
} from "../config-activator.js";
import {
  buildPiConfigRefreshCandidate,
  createPiConfigRefreshCoordinator,
  PI_CONFIG_REFRESH_DEFERRAL_MESSAGE,
  type PiConfigCatalogState,
  type PiConfigRefreshCoordinator,
  type PiConfigRefreshDeps,
  type PiConfigRefreshNotice,
  type PiConfigRefreshOutcome,
  refreshPiConfigCandidate,
  renderPiConfigRefreshStatusLine,
  toPiConfigRefreshPublicReason,
  toPiConfigRefreshPublicState,
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
import type {
  PiDelegationController,
  PiDelegationRequest,
} from "../delegation-controller.js";
import { buildDelegationToolRegistration } from "../delegation-tool.js";
import {
  makeConfigRefreshFailedFailure,
  PI_CONFIG_REFRESH_FAILURE_REASONS,
  type PiAdapterFailure,
} from "../errors.js";
import { createOpenSessionMutationGate } from "../required-capability-gate.js";
import type { PiChildSettlement } from "../rpc-child.js";
import { PiSkillCatalog } from "../skill-catalog.js";
import type { PiSessionContext, PiToolRegistration } from "../types.js";

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

function countingMaterializer(): {
  readonly port: PiMaterializerPort;
  readonly calls: Array<{
    readonly config: WeaveConfig;
    readonly promptFileReader: PromptFileReader | undefined;
  }>;
} {
  const calls: Array<{
    readonly config: WeaveConfig;
    readonly promptFileReader: PromptFileReader | undefined;
  }> = [];
  return {
    calls,
    port: {
      materialize: (config, promptFileReader) => {
        calls.push({ config, promptFileReader });
        return defaultPiMaterializerPort.materialize(config, promptFileReader);
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

// ---------------------------------------------------------------------------
// Delegation-boundary coordinator
// ---------------------------------------------------------------------------

/**
 * A config with two eligible primaries: `loom` delegates to everything, and
 * `scribe` delegates to nothing. A newly added subagent therefore changes
 * `loom`'s delegation-target set while leaving `scribe`'s contract intact,
 * which is exactly the difference a primary switch is allowed to publish.
 */
const PRIMARY_CONFIG_V1 = `
agent loom {
  description "orchestrator"
  prompt "loom prompt v1"
  models ["m1"]
  mode primary

  tool_policy {
    read allow
    write allow
    execute allow
    network deny
    delegate allow
  }
}

agent scribe {
  description "second primary"
  prompt "scribe prompt"
  models ["m1"]
  mode primary

  tool_policy {
    read allow
    write deny
    execute deny
    network deny
    delegate deny
  }
}

agent alpha {
  description "alpha subagent"
  prompt_file "alpha.md"
  models ["m1"]
  mode subagent
}
`;

const PRIMARY_CONFIG_PRIMARY_PROMPT_EDIT = PRIMARY_CONFIG_V1.replace(
  '"loom prompt v1"',
  '"loom prompt v2"',
);

const PRIMARY_CONFIG_WITH_DELTA = `${PRIMARY_CONFIG_V1}
agent delta {
  description "delta subagent"
  prompt "delta prompt"
  models ["m1"]
  mode subagent
}
`;

function primaryFiles(): FakeFiles {
  return {
    [GLOBAL_CONFIG]: { content: GLOBAL_TEXT, mtimeMs: 1_000 },
    [PROJECT_CONFIG]: { content: PRIMARY_CONFIG_V1, mtimeMs: 2_000 },
    [PROMPT_ALPHA]: { content: ALPHA_V1, mtimeMs: 3_000 },
  };
}

interface CoordinatorHarness {
  readonly files: FakeFiles;
  readonly seeded: PiConfigCatalogState;
  readonly cell: PiCatalogCell;
  readonly fs: FakeFs;
  readonly loader: { readonly calls: string[] };
  readonly materializer: {
    readonly calls: Array<{
      readonly config: WeaveConfig;
      readonly promptFileReader: PromptFileReader | undefined;
    }>;
  };
  readonly coordinator: PiConfigRefreshCoordinator;
  readonly control: {
    owns: boolean;
    nowMs: number;
    primary: AgentDescriptor | undefined;
    disabledSkills: readonly string[];
    readonly outcomes: PiConfigRefreshOutcome[];
    readonly notices: PiConfigRefreshNotice[];
    readonly statFailures: Record<string, string>;
  };
}

async function coordinatorHarness(
  options: {
    readonly files?: FakeFiles;
    readonly minIntervalMs?: number;
    readonly statFailures?: Record<string, string>;
  } = {},
): Promise<CoordinatorHarness> {
  const files = options.files ?? primaryFiles();
  const seeded = await seedState(files);
  const cell = createPiCatalogCell({
    generationId: "gen-1",
    activation: seeded.activation,
    manifest: seeded.manifest,
    contents: seeded.contents,
  });
  // Mutable so a test can clear a failure and prove recovery.
  const statFailures: Record<string, string> = { ...options.statFailures };
  const fs = fakeFs(files, { stat: statFailures });
  const loader = countingLoader();
  const materializer = countingMaterializer();
  const control: CoordinatorHarness["control"] = {
    owns: true,
    nowMs: 0,
    primary: seeded.activation.descriptors.byName.get("loom"),
    disabledSkills: [],
    outcomes: [],
    notices: [],
    statFailures,
  };
  const coordinator = createPiConfigRefreshCoordinator({
    catalog: cell,
    ownsGeneration: () => control.owns,
    fs,
    configLoader: loader.port,
    materializer: materializer.port,
    primary: () => control.primary,
    primaryDisabledSkills: () => control.disabledSkills,
    // Pi discovered no skills, so both sides of the guard render the same way.
    skills: () => new PiSkillCatalog([]),
    clock: { now: () => control.nowMs },
    minIntervalMs: options.minIntervalMs ?? 0,
    onOutcome: (outcome) => control.outcomes.push(outcome),
    onNotice: (notice) => control.notices.push(notice),
  });
  return {
    files,
    seeded,
    cell,
    fs,
    loader,
    materializer,
    coordinator,
    control,
  };
}

function publishedPrompt(
  cell: PiCatalogCell,
  agentName: string,
): string | undefined {
  return cell.descriptors().get(agentName)?.composedPrompt;
}

describe("PiConfigRefreshCoordinator — unchanged fast path", () => {
  it("probes metadata only, publishes nothing, and stays total", async () => {
    const { cell, fs, loader, coordinator } = await coordinatorHarness();
    const published = cell.publication();

    const result = await coordinator.ensureFresh();

    expect(result.isOk()).toBe(true);
    // Zero reads, zero hashes, zero parses, zero materializations.
    expect(fs.readCalls).toEqual([]);
    expect(loader.calls).toEqual([]);
    expect(fs.statCalls.length).toBe(cell.manifest()?.files.length ?? 0);
    // Nothing was published: the publication object itself is untouched.
    expect(cell.publication()).toBe(published);
    expect(coordinator.lastOutcome()).toEqual({ kind: "unchanged" });
  });

  it("joins concurrent boundaries into exactly one probe and one build", async () => {
    const { files, cell, fs, loader, coordinator } = await coordinatorHarness();
    files[PROMPT_ALPHA] = { content: ALPHA_V2, mtimeMs: 9_000 };
    const sourceCount = cell.manifest()?.files.length ?? 0;

    await Promise.all([
      coordinator.ensureFresh(),
      coordinator.ensureFresh(),
      coordinator.ensureFresh(),
    ]);

    // One probe: one stat per known source, not three.
    expect(fs.statCalls.length).toBe(sourceCount);
    expect(fs.readCalls).toEqual([PROMPT_ALPHA]);
    // A prompt-only change never re-parses config.
    expect(loader.calls).toEqual([]);
    expect(publishedPrompt(cell, "alpha")).toContain("alpha prompt v2");
  });

  it("updates metadata after one identical-content read, then returns to the pure fast path", async () => {
    const { files, cell, fs, loader, materializer, coordinator } =
      await coordinatorHarness();
    const sourceCount = cell.manifest()?.files.length ?? 0;
    const activation = cell.activation();
    files[PROMPT_ALPHA] = { content: ALPHA_V1, mtimeMs: 9_000 };

    await coordinator.ensureFresh();

    expect(fs.statCalls).toHaveLength(sourceCount);
    expect(fs.readCalls).toEqual([PROMPT_ALPHA]);
    expect(loader.calls).toEqual([]);
    expect(materializer.calls).toEqual([]);
    expect(coordinator.lastOutcome()).toEqual({
      kind: "published",
      change: "unchanged",
      changedPaths: [],
    });
    expect(cell.activation()).toBe(activation);
    expect(
      cell.manifest()?.files.find((source) => source.path === PROMPT_ALPHA),
    ).toMatchObject({
      mtimeMs: 9_000,
      sha256: hashConfigSourceContent(ALPHA_V1),
    });

    fs.statCalls.length = 0;
    fs.readCalls.length = 0;
    await coordinator.ensureFresh();

    expect(fs.statCalls).toHaveLength(sourceCount);
    expect(fs.readCalls).toEqual([]);
    expect(loader.calls).toEqual([]);
    expect(materializer.calls).toEqual([]);
    expect(coordinator.lastOutcome()).toEqual({ kind: "unchanged" });
  });

  it("spaces probes by the injected minimum interval", async () => {
    const { files, fs, coordinator, control } = await coordinatorHarness({
      minIntervalMs: 1_000,
    });
    await coordinator.ensureFresh();
    const afterFirstProbe = fs.statCalls.length;
    files[PROMPT_ALPHA] = { content: ALPHA_V2, mtimeMs: 9_000 };

    control.nowMs = 500;
    await coordinator.ensureFresh();

    expect(fs.statCalls.length).toBe(afterFirstProbe);
    expect(coordinator.lastOutcome()).toEqual({ kind: "skipped" });

    control.nowMs = 1_500;
    await coordinator.ensureFresh();

    expect(fs.statCalls.length).toBe(afterFirstProbe * 2);
    expect(coordinator.lastOutcome()?.kind).toBe("published");
  });
});

describe("PiConfigRefreshCoordinator — publishing", () => {
  it("publishes a subagent prompt edit and leaves the primary alone", async () => {
    const { files, cell, coordinator, control } = await coordinatorHarness();
    const committedPrimary = control.primary;
    files[PROMPT_ALPHA] = { content: ALPHA_V2, mtimeMs: 9_000 };

    await coordinator.ensureFresh();

    expect(coordinator.lastOutcome()).toEqual({
      kind: "published",
      change: "prompt-only",
      changedPaths: [PROMPT_ALPHA],
    });
    expect(publishedPrompt(cell, "alpha")).toContain("alpha prompt v2");
    // The committed primary descriptor is the object it always was.
    expect(control.primary).toBe(committedPrimary);
    expect(publishedPrompt(cell, "loom")).toContain("loom prompt v1");
    expect(cell.deferred()).toBeUndefined();
  });

  it("publishes a config edit that leaves every primary facet intact", async () => {
    const { files, cell, loader, coordinator } = await coordinatorHarness();
    files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_V1.replace(
        'prompt_file "alpha.md"',
        'prompt "inline alpha v2"',
      ),
      mtimeMs: 9_000,
    };

    await coordinator.ensureFresh();

    expect(coordinator.lastOutcome()?.kind).toBe("published");
    expect(loader.calls).toEqual([PROJECT_ROOT]);
    expect(publishedPrompt(cell, "alpha")).toContain("inline alpha v2");
    // The dropped prompt reference left the manifest with the config change.
    expect(cell.manifest()?.files.map((file) => file.path)).toEqual([
      GLOBAL_CONFIG,
      PROJECT_CONFIG,
    ]);
  });
});

describe("PiConfigRefreshCoordinator — primary-contract deferral", () => {
  it("defers a primary prompt edit and keeps the current catalog serving", async () => {
    const { files, cell, coordinator } = await coordinatorHarness();
    files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_PRIMARY_PROMPT_EDIT,
      mtimeMs: 9_000,
    };

    await coordinator.ensureFresh();

    expect(coordinator.lastOutcome()).toEqual({
      kind: "deferred",
      changedFacets: ["prompt"],
      changedPaths: [PROJECT_CONFIG],
    });
    expect(publishedPrompt(cell, "loom")).toContain("loom prompt v1");
    expect(cell.deferred()?.changedFacets).toEqual(["prompt"]);
    // The manifest was not advanced, so the next boundary re-derives it.
    expect(
      cell.manifest()?.files.find((file) => file.path === PROJECT_CONFIG)
        ?.sha256,
    ).toBe(digestOf(await seedState(primaryFiles()), PROJECT_CONFIG));
  });

  it("defers a change to the active primary's delegation targets", async () => {
    const { files, cell, coordinator } = await coordinatorHarness();
    files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_WITH_DELTA,
      mtimeMs: 9_000,
    };

    await coordinator.ensureFresh();

    expect(coordinator.lastOutcome()).toEqual({
      kind: "deferred",
      changedFacets: ["delegation-targets"],
      changedPaths: [PROJECT_CONFIG],
    });
    // A new agent aimed at the active primary is not delegable yet.
    expect(cell.descriptors().has("delta")).toBe(false);
    expect(
      cell
        .descriptors()
        .get("loom")
        ?.delegationTargets.map((t) => t.name),
    ).not.toContain("delta");
  });

  it("re-derives the same deferral on every later boundary", async () => {
    const { files, cell, coordinator } = await coordinatorHarness();
    files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_PRIMARY_PROMPT_EDIT,
      mtimeMs: 9_000,
    };

    await coordinator.ensureFresh();
    await coordinator.ensureFresh();

    expect(coordinator.lastOutcome()?.kind).toBe("deferred");
    expect(publishedPrompt(cell, "loom")).toContain("loom prompt v1");
  });
});

describe("PiConfigRefreshCoordinator — explicit primary reactivation", () => {
  it("publishes a deferred prompt edit once a matching primary commits", async () => {
    const { files, cell, coordinator, control } = await coordinatorHarness();
    files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_PRIMARY_PROMPT_EDIT,
      mtimeMs: 9_000,
    };
    await coordinator.ensureFresh();
    expect(coordinator.lastOutcome()?.kind).toBe("deferred");

    // The explicit Alt+A switch committed `scribe`, whose prompt, model
    // intent, tool policy and (empty) target set the candidate preserves.
    control.primary = cell.descriptors().get("scribe");
    await coordinator.refreshAfterPrimaryReactivation();

    expect(coordinator.lastOutcome()?.kind).toBe("published");
    expect(publishedPrompt(cell, "loom")).toContain("loom prompt v2");
    expect(cell.deferred()).toBeUndefined();
  });

  it("publishes a deferred target-set change after a matching switch", async () => {
    const { files, cell, coordinator, control } = await coordinatorHarness();
    files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_WITH_DELTA,
      mtimeMs: 9_000,
    };
    await coordinator.ensureFresh();
    expect(coordinator.lastOutcome()?.kind).toBe("deferred");

    control.primary = cell.descriptors().get("scribe");
    await coordinator.refreshAfterPrimaryReactivation();

    expect(coordinator.lastOutcome()?.kind).toBe("published");
    expect(cell.descriptors().has("delta")).toBe(true);
    expect(
      cell
        .descriptors()
        .get("loom")
        ?.delegationTargets.map((t) => t.name),
    ).toContain("delta");
  });

  it("rebuilds from current sources instead of publishing the held snapshot", async () => {
    const { files, cell, fs, coordinator, control } =
      await coordinatorHarness();
    files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_WITH_DELTA,
      mtimeMs: 9_000,
    };
    await coordinator.ensureFresh();
    const deferred = cell.deferred();
    expect(deferred).toBeDefined();

    // The held snapshot goes stale before the switch: both sources moved
    // again while the candidate sat unpublished.
    files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_WITH_DELTA.replace(
        '"delta prompt"',
        '"delta prompt v2"',
      ),
      mtimeMs: 11_000,
    };
    files[PROMPT_ALPHA] = { content: ALPHA_V2, mtimeMs: 12_000 };
    const statsBefore = fs.statCalls.length;

    control.primary = cell.descriptors().get("scribe");
    await coordinator.refreshAfterPrimaryReactivation();

    // A fresh probe ran, and what landed is what is on disk now - not the
    // snapshot the guard held back.
    expect(fs.statCalls.length).toBeGreaterThan(statsBefore);
    expect(publishedPrompt(cell, "delta")).toContain("delta prompt v2");
    expect(publishedPrompt(cell, "alpha")).toContain("alpha prompt v2");
    expect(cell.refreshState()?.activation).not.toBe(
      deferred?.state.activation,
    );
  });

  it("keeps deferring when the newly committed primary is also affected", async () => {
    const { files, cell, coordinator } = await coordinatorHarness();
    files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_WITH_DELTA,
      mtimeMs: 9_000,
    };
    await coordinator.ensureFresh();

    // Re-committing the same primary changes nothing about the contract.
    await coordinator.refreshAfterPrimaryReactivation();

    expect(coordinator.lastOutcome()?.kind).toBe("deferred");
    expect(cell.descriptors().has("delta")).toBe(false);
  });
});

describe("PiConfigRefreshCoordinator — failure and staleness", () => {
  it("keeps the catalog and manifest when a probe fails", async () => {
    const { cell, coordinator } = await coordinatorHarness({
      statFailures: { [PROJECT_CONFIG]: "permission denied" },
    });
    const published = cell.publication();

    const result = await coordinator.ensureFresh();

    expect(result.isOk()).toBe(true);
    expect(cell.publication()).toBe(published);
    expect(coordinator.lastOutcome()).toEqual({
      kind: "failed",
      failure: {
        type: "SourceReadFailed",
        kind: "project-config",
        path: PROJECT_CONFIG,
        message: "permission denied",
      },
    });
  });

  it("keeps the catalog when a changed config no longer parses", async () => {
    const { files, cell, coordinator } = await coordinatorHarness();
    files[PROJECT_CONFIG] = {
      content: PROJECT_TEXT_UNTERMINATED,
      mtimeMs: 9_000,
    };
    const published = cell.publication();

    await coordinator.ensureFresh();

    expect(cell.publication()).toBe(published);
    expect(coordinator.lastOutcome()?.kind).toBe("failed");
    // The next boundary retries the probe from the manifest it kept.
    expect(cell.manifest()).toBe(published?.manifest);
  });

  it("discards a candidate whose generation was replaced mid-refresh", async () => {
    const { files, cell, coordinator, control } = await coordinatorHarness();
    files[PROMPT_ALPHA] = { content: ALPHA_V2, mtimeMs: 9_000 };

    const running = coordinator.ensureFresh();
    // Session replacement lands while the candidate is still being built.
    control.owns = false;
    cell.invalidate();
    await running;

    expect(coordinator.lastOutcome()).toEqual({ kind: "stale" });
    expect(cell.publication()).toBeUndefined();
    expect(cell.deferred()).toBeUndefined();
    expect(cell.isLive()).toBe(false);
  });

  it("records nothing and writes nothing after dispose", async () => {
    const { files, cell, coordinator } = await coordinatorHarness();
    files[PROMPT_ALPHA] = { content: ALPHA_V2, mtimeMs: 9_000 };
    const published = cell.publication();

    const running = coordinator.ensureFresh();
    coordinator.dispose();
    await running;

    expect(coordinator.lastOutcome()).toBeUndefined();
    expect(cell.publication()).toBe(published);
    expect(publishedPrompt(cell, "alpha")).toContain("alpha prompt v1");
    // A later boundary on a disposed coordinator is a no-op, not a throw.
    expect((await coordinator.ensureFresh()).isOk()).toBe(true);
  });

  it("does nothing for a generation that carries no source manifest", async () => {
    const { seeded, fs } = await coordinatorHarness();
    const cell = createPiCatalogCell({
      generationId: "gen-2",
      activation: seeded.activation,
    });
    const coordinator = createPiConfigRefreshCoordinator({
      catalog: cell,
      ownsGeneration: () => true,
      fs,
      primary: () => undefined,
      primaryDisabledSkills: () => [],
      skills: () => new PiSkillCatalog([]),
      clock: { now: () => 0 },
    });

    await coordinator.ensureFresh();

    expect(coordinator.lastOutcome()).toEqual({
      kind: "unavailable",
      reason: "no-source-manifest",
    });
    expect(fs.statCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bounded public diagnostics
// ---------------------------------------------------------------------------

/** Everything a rendered diagnostic must never contain. */
const SENTINELS = [
  PROJECT_CONFIG,
  GLOBAL_CONFIG,
  PROMPT_ALPHA,
  "permission denied",
  "loom prompt v1",
  "loom prompt v2",
  "alpha prompt v1",
  "SourceReadFailed",
  "ConfigParseFailed",
] as const;

function expectNoSentinels(rendered: string): void {
  for (const sentinel of SENTINELS) {
    expect(rendered).not.toContain(sentinel);
  }
}

describe("PiConfigRefreshCoordinator — bounded public diagnostics", () => {
  it("starts fresh with nothing published", async () => {
    const { coordinator } = await coordinatorHarness();

    expect(coordinator.diagnostics()).toEqual({
      state: { kind: "fresh" },
      publishCount: 0,
    });
    expect(renderPiConfigRefreshStatusLine(coordinator.diagnostics())).toBe(
      "config refresh: fresh; published 0",
    );
  });

  it("counts publications and stays fresh without notifying", async () => {
    const { files, coordinator, control } = await coordinatorHarness();

    // A probe that changes nothing publishes nothing.
    await coordinator.ensureFresh();
    expect(coordinator.diagnostics().publishCount).toBe(0);

    files[PROMPT_ALPHA] = { content: ALPHA_V2, mtimeMs: 9_000 };
    await coordinator.ensureFresh();

    expect(coordinator.diagnostics()).toEqual({
      state: { kind: "fresh" },
      publishCount: 1,
    });
    const rendered = renderPiConfigRefreshStatusLine(coordinator.diagnostics());
    expect(rendered).toBe("config refresh: fresh; published 1");
    expectNoSentinels(rendered);
    expect(control.notices).toEqual([]);
  });

  it("renders a deferral as primary-affecting with its facet names", async () => {
    const { files, coordinator, control } = await coordinatorHarness();
    files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_PRIMARY_PROMPT_EDIT,
      mtimeMs: 9_000,
    };

    await coordinator.ensureFresh();

    expect(coordinator.diagnostics()).toEqual({
      state: { kind: "deferred", facets: ["prompt"] },
      publishCount: 0,
    });
    const rendered = renderPiConfigRefreshStatusLine(coordinator.diagnostics());
    expect(rendered).toBe(
      "config refresh: deferred: primary-affecting; published 0; facets prompt",
    );
    expectNoSentinels(rendered);
    expect(control.notices).toEqual([
      {
        state: { kind: "deferred", facets: ["prompt"] },
        message: PI_CONFIG_REFRESH_DEFERRAL_MESSAGE,
      },
    ]);
    expectNoSentinels(PI_CONFIG_REFRESH_DEFERRAL_MESSAGE);
    // Fixed and actionable.
    expect(PI_CONFIG_REFRESH_DEFERRAL_MESSAGE).toContain("active primary");
    expect(PI_CONFIG_REFRESH_DEFERRAL_MESSAGE).toContain(
      "switch primary or restart to apply",
    );
  });

  it("renders a failure as a closed reason with no source detail", async () => {
    const { coordinator, control } = await coordinatorHarness({
      statFailures: { [PROJECT_CONFIG]: "permission denied" },
    });

    await coordinator.ensureFresh();

    expect(coordinator.diagnostics()).toEqual({
      state: { kind: "failed", reason: "source-unreadable" },
      publishCount: 0,
    });
    const rendered = renderPiConfigRefreshStatusLine(coordinator.diagnostics());
    expect(rendered).toBe(
      "config refresh: failed: source-unreadable; published 0",
    );
    expectNoSentinels(rendered);
    // The internal outcome may still name the source; the notice may not.
    expect(coordinator.lastOutcome()).toMatchObject({
      kind: "failed",
      failure: { path: PROJECT_CONFIG, message: "permission denied" },
    });
    expect(control.notices).toHaveLength(1);
    const notice = control.notices[0];
    expect(notice?.state).toEqual({
      kind: "failed",
      reason: "source-unreadable",
    });
    expect(notice?.message).toBe(
      makeConfigRefreshFailedFailure("source-unreadable").safeMessage,
    );
    expectNoSentinels(notice?.message ?? "");
    expect(JSON.stringify(notice)).not.toContain(PROJECT_CONFIG);
  });

  it("notifies once for an identical failure repeated at every boundary", async () => {
    const { coordinator, control } = await coordinatorHarness({
      statFailures: { [PROJECT_CONFIG]: "permission denied" },
    });

    await coordinator.ensureFresh();
    await coordinator.ensureFresh();
    await coordinator.ensureFresh();

    expect(
      control.outcomes.filter((outcome) => outcome.kind === "failed"),
    ).toHaveLength(3);
    expect(control.notices).toHaveLength(1);
  });

  it("notifies once for a deferral re-derived at every boundary", async () => {
    const { files, coordinator, control } = await coordinatorHarness();
    files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_PRIMARY_PROMPT_EDIT,
      mtimeMs: 9_000,
    };

    await coordinator.ensureFresh();
    await coordinator.ensureFresh();
    await coordinator.ensureFresh();

    expect(
      control.outcomes.filter((outcome) => outcome.kind === "deferred"),
    ).toHaveLength(3);
    expect(control.notices).toHaveLength(1);
  });

  it("notifies again when the classification genuinely changes", async () => {
    const { files, coordinator, control } = await coordinatorHarness();
    files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_PRIMARY_PROMPT_EDIT,
      mtimeMs: 9_000,
    };
    await coordinator.ensureFresh();
    await coordinator.ensureFresh();

    // The same file, now unreadable: a different state, one more notice.
    control.statFailures[PROJECT_CONFIG] = "permission denied";
    await coordinator.ensureFresh();
    await coordinator.ensureFresh();

    expect(control.notices.map((notice) => notice.state.kind)).toEqual([
      "deferred",
      "failed",
    ]);
  });

  it("clears a failed state on recovery and re-notifies a later failure", async () => {
    const { coordinator, control } = await coordinatorHarness({
      statFailures: { [PROJECT_CONFIG]: "permission denied" },
    });
    await coordinator.ensureFresh();
    expect(coordinator.diagnostics().state).toEqual({
      kind: "failed",
      reason: "source-unreadable",
    });

    delete control.statFailures[PROJECT_CONFIG];
    await coordinator.ensureFresh();

    // Recovery rewrites the rendered state; no trace of the old reason.
    expect(coordinator.lastOutcome()).toEqual({ kind: "unchanged" });
    const recovered = renderPiConfigRefreshStatusLine(
      coordinator.diagnostics(),
    );
    expect(recovered).toBe("config refresh: fresh; published 0");
    expect(recovered).not.toContain("failed");
    expect(recovered).not.toContain("deferred");
    expectNoSentinels(recovered);
    expect(control.notices).toHaveLength(1);

    // The same failure after a recovery is a new state, so it speaks once.
    control.statFailures[PROJECT_CONFIG] = "permission denied";
    await coordinator.ensureFresh();
    await coordinator.ensureFresh();

    expect(control.notices).toHaveLength(2);
    expect(coordinator.diagnostics()).toEqual({
      state: { kind: "failed", reason: "source-unreadable" },
      publishCount: 0,
    });
  });

  it("clears a deferred state once an explicit reactivation publishes it", async () => {
    const { files, coordinator, control } = await coordinatorHarness();
    files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_PRIMARY_PROMPT_EDIT,
      mtimeMs: 9_000,
    };
    await coordinator.ensureFresh();
    expect(coordinator.diagnostics().state.kind).toBe("deferred");

    control.primary = undefined;
    await coordinator.refreshAfterPrimaryReactivation();

    const rendered = renderPiConfigRefreshStatusLine(coordinator.diagnostics());
    expect(rendered).toBe("config refresh: fresh; published 1");
    expect(rendered).not.toContain("primary-affecting");
    expectNoSentinels(rendered);
  });

  it("leaves the rendered state untouched for a debounced or stale attempt", async () => {
    const { files, coordinator, control } = await coordinatorHarness({
      minIntervalMs: 1_000,
    });
    files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_PRIMARY_PROMPT_EDIT,
      mtimeMs: 9_000,
    };
    await coordinator.ensureFresh();
    const deferred = coordinator.diagnostics();

    // Inside the debounce window: nothing was probed, so nothing was learned.
    await coordinator.ensureFresh();
    expect(coordinator.lastOutcome()).toEqual({ kind: "skipped" });
    expect(coordinator.diagnostics()).toEqual(deferred);

    // A revoked generation writes nothing and reports nothing new either.
    control.owns = false;
    control.nowMs = 10_000;
    await coordinator.ensureFresh();
    expect(coordinator.lastOutcome()).toEqual({
      kind: "unavailable",
      reason: "stale-generation",
    });
    expect(coordinator.diagnostics()).toEqual(deferred);
    expect(control.notices).toHaveLength(1);
  });

  it("drops the diagnostic state on dispose", async () => {
    const { files, coordinator } = await coordinatorHarness();
    files[PROMPT_ALPHA] = { content: ALPHA_V2, mtimeMs: 9_000 };
    await coordinator.ensureFresh();
    expect(coordinator.diagnostics().publishCount).toBe(1);

    coordinator.dispose();

    expect(coordinator.diagnostics()).toEqual({
      state: { kind: "fresh" },
      publishCount: 0,
    });
  });
});

describe("refresh diagnostic projections", () => {
  it("maps every internal failure onto a closed public reason", () => {
    expect(
      toPiConfigRefreshPublicReason({
        type: "SourceReadFailed",
        kind: "project-config",
        path: PROJECT_CONFIG,
        message: "permission denied",
      }),
    ).toBe("source-unreadable");
    expect(
      toPiConfigRefreshPublicReason({
        type: "ConfigParseFailed",
        errorCount: 2,
        errorTypes: ["ParseError"],
      }),
    ).toBe("config-invalid");
    expect(
      toPiConfigRefreshPublicReason({
        type: "PromptFileMissing",
        path: PROMPT_ALPHA,
      }),
    ).toBe("prompt-unavailable");
    expect(
      toPiConfigRefreshPublicReason({
        type: "LifecycleSettingsInvalid",
        issueCount: 1,
      }),
    ).toBe("settings-invalid");
    expect(
      toPiConfigRefreshPublicReason({
        type: "MaterializationFailed",
        reason: "materialize-threw",
      }),
    ).toBe("composition-failed");
  });

  it("reports no public state for outcomes that teach an operator nothing", () => {
    expect(toPiConfigRefreshPublicState({ kind: "skipped" })).toBeUndefined();
    expect(toPiConfigRefreshPublicState({ kind: "stale" })).toBeUndefined();
    expect(
      toPiConfigRefreshPublicState({
        kind: "unavailable",
        reason: "no-source-manifest",
      }),
    ).toBeUndefined();
    expect(toPiConfigRefreshPublicState({ kind: "unchanged" })).toEqual({
      kind: "fresh",
    });
  });

  it("bounds the facet names one status line renders", () => {
    const line = renderPiConfigRefreshStatusLine({
      state: {
        kind: "deferred",
        facets: [
          "prompt",
          "models",
          "thinking",
          "temperature",
          "fast",
          "tool-policy",
          "delegation-targets",
        ],
      },
      publishCount: 3,
    });

    expect(line).toBe(
      "config refresh: deferred: primary-affecting; published 3; facets prompt, models, thinking, temperature (+3)",
    );
    expect(line.split("\n")).toHaveLength(1);
    expectNoSentinels(line);
  });

  it("renders a deferral with no named facet as one plain line", () => {
    expect(
      renderPiConfigRefreshStatusLine({
        state: { kind: "deferred", facets: [] },
        publishCount: 0,
      }),
    ).toBe("config refresh: deferred: primary-affecting; published 0");
  });

  it("keeps every public failure reason free of source detail", () => {
    for (const reason of PI_CONFIG_REFRESH_FAILURE_REASONS) {
      const failure = makeConfigRefreshFailedFailure(reason);
      expect(failure.code).toBe("ConfigRefreshFailed");
      expect(failure.impact).toBe("degraded");
      expect(failure.correlation).toEqual({ reason });
      expectNoSentinels(failure.safeMessage);
      expectNoSentinels(
        renderPiConfigRefreshStatusLine({
          state: { kind: "failed", reason },
          publishCount: 0,
        }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The boundary the coordinator actually runs on
// ---------------------------------------------------------------------------

function toolSessionContext(): PiSessionContext {
  return {
    mode: "tui",
    cwd: PROJECT_ROOT,
    isProjectTrusted: () => true,
    isIdle: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      select: async () => undefined,
      confirm: async () => false,
    },
    hasUI: true,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
  } as unknown as PiSessionContext;
}

describe("the root weave_delegate boundary refreshes before it resolves", () => {
  /**
   * Wires the real coordinator into the real tool exactly as `extension-impl`
   * does: `ensureFresh` first, then the invocation context, the target, and
   * the bootstrap - each read live from the same catalog cell.
   */
  function delegationToolFor(harness: CoordinatorHarness): {
    readonly registration: PiToolRegistration;
    readonly dispatched: PiDelegationRequest[];
  } {
    const dispatched: PiDelegationRequest[] = [];
    const controller = {
      delegate: (
        request: PiDelegationRequest,
      ): ResultAsync<PiChildSettlement, PiAdapterFailure> => {
        dispatched.push(request);
        return okAsync({ outcome: "completed", assistantOutput: "done" });
      },
      threadStatus: () => undefined,
    } as unknown as PiDelegationController;

    const registration = buildDelegationToolRegistration({
      targets: [],
      ensureFresh: async () => {
        await harness.coordinator.ensureFresh();
      },
      getInvocationContext: () => {
        const primary = harness.control.primary?.name ?? "loom";
        const descriptor = harness.cell.descriptors().get(primary);
        if (descriptor === undefined) return undefined;
        return {
          parentAgentName: primary,
          targets: descriptor.delegationTargets,
        };
      },
      getController: () => controller,
      parentId: "root",
      parentDepth: 0,
      parentAgentName: "loom",
      idGenerator: { next: () => "child-1" },
      buildBootstrap: (target) => ({
        composedPrompt:
          harness.cell.descriptors().get(target.name)?.composedPrompt ?? "",
      }),
      buildEnv: () => ({}),
      getParentSessionState: () => ({
        persistence: "persistent",
        sessionId: "session-test",
        runtimeSessionId: "session-test",
        identitySource: "session-header",
        sessionFile: "/sessions/test.jsonl",
      }),
      sessionMutationGate: createOpenSessionMutationGate(),
    });
    return { registration, dispatched };
  }

  interface DelegationPayload {
    readonly ok: boolean;
    readonly error?: string;
    readonly settlement?: {
      readonly outcome: string;
      readonly finalOutput: string;
      readonly interventionCount: number;
    };
  }

  async function delegate(
    registration: PiToolRegistration,
    agent: string,
    callId = "call-1",
  ): Promise<DelegationPayload> {
    const result = await registration.execute(
      callId,
      { agent, task: "do it" },
      undefined,
      undefined,
      toolSessionContext(),
    );
    return JSON.parse(
      (result.content[0] as { text: string }).text,
    ) as DelegationPayload;
  }

  it("keeps N unchanged root boundaries read/parse/materialization-free with identical settlements", async () => {
    const harness = await coordinatorHarness();
    const { registration, dispatched } = delegationToolFor(harness);
    const sourceCount = harness.cell.manifest()?.files.length ?? 0;
    const boundaryCount = 5;

    const settlements: DelegationPayload[] = [];
    for (let index = 0; index < boundaryCount; index += 1) {
      settlements.push(
        await delegate(registration, "alpha", `unchanged-${index}`),
      );
    }

    expect(harness.fs.statCalls).toHaveLength(sourceCount * boundaryCount);
    expect(harness.fs.readCalls).toEqual([]);
    expect(harness.loader.calls).toEqual([]);
    expect(harness.materializer.calls).toEqual([]);
    expect(dispatched).toHaveLength(boundaryCount);
    expect(settlements).toEqual(
      Array.from({ length: boundaryCount }, () => ({
        ok: true,
        settlement: {
          outcome: "completed",
          finalOutput: "done",
          interventionCount: 0,
        },
      })),
    );
  });

  it("carries a subagent prompt edit into the next dispatch's bootstrap", async () => {
    const harness = await coordinatorHarness();
    const { registration, dispatched } = delegationToolFor(harness);
    harness.files[PROMPT_ALPHA] = { content: ALPHA_V2, mtimeMs: 9_000 };

    expect(await delegate(registration, "alpha")).toMatchObject({ ok: true });

    expect(harness.coordinator.lastOutcome()?.kind).toBe("published");
    expect(harness.fs.readCalls).toEqual([PROMPT_ALPHA]);
    expect(harness.loader.calls).toEqual([]);
    expect(harness.materializer.calls).toHaveLength(1);
    expect(
      (dispatched[0]?.bootstrap as { composedPrompt: string }).composedPrompt,
    ).toContain("alpha prompt v2");
  });

  it.each([
    [
      "single-line",
      PRIMARY_CONFIG_V1.replace(
        'prompt_file "alpha.md"',
        'prompt "alpha inline single v2"',
      ),
      "alpha inline single v2",
    ],
    [
      "triple-quoted multiline",
      PRIMARY_CONFIG_V1.replace(
        'prompt_file "alpha.md"',
        `prompt """
          alpha inline line one

          alpha inline line two
        """`,
      ),
      "alpha inline line one\n\nalpha inline line two",
    ],
  ] as const)("carries a %s config-owned prompt edit into the next bootstrap", async (_form, editedConfig, expectedPrompt) => {
    const harness = await coordinatorHarness();
    const { registration, dispatched } = delegationToolFor(harness);
    harness.files[PROJECT_CONFIG] = {
      content: editedConfig,
      mtimeMs: 9_000,
    };

    expect(await delegate(registration, "alpha")).toMatchObject({ ok: true });

    expect(harness.coordinator.lastOutcome()).toEqual({
      kind: "published",
      change: "config-changed",
      changedPaths: [PROJECT_CONFIG],
    });
    expect(harness.fs.readCalls).toEqual([PROJECT_CONFIG]);
    expect(harness.loader.calls).toEqual([PROJECT_ROOT]);
    expect(harness.materializer.calls).toHaveLength(1);
    expect(
      (dispatched[0]?.bootstrap as { composedPrompt: string }).composedPrompt,
    ).toContain(expectedPrompt);
  });

  it("repoints a prompt file atomically before the next bootstrap", async () => {
    const harness = await coordinatorHarness();
    const { registration, dispatched } = delegationToolFor(harness);
    harness.files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_V1.replace(
        'prompt_file "alpha.md"',
        'prompt_file "gamma.md"',
      ),
      mtimeMs: 9_000,
    };
    harness.files[PROMPT_GAMMA] = {
      content: GAMMA_PROMPT,
      mtimeMs: 10_000,
    };

    expect(await delegate(registration, "alpha")).toMatchObject({ ok: true });

    const manifestPaths =
      harness.cell.manifest()?.files.map((source) => source.path) ?? [];
    expect(manifestPaths).toContain(PROMPT_GAMMA);
    expect(manifestPaths).not.toContain(PROMPT_ALPHA);
    expect(harness.fs.readCalls).toEqual([PROJECT_CONFIG, PROMPT_GAMMA]);
    expect(occurrences(harness.fs.readCalls, PROMPT_GAMMA)).toBe(1);
    expect(
      (dispatched[0]?.bootstrap as { composedPrompt: string }).composedPrompt,
    ).toContain(GAMMA_PROMPT.trim());
  });

  it.each([
    [
      "a deleted prompt file",
      (harness: CoordinatorHarness) => {
        delete harness.files[PROMPT_ALPHA];
      },
      "PromptFileMissing",
    ],
    [
      "a corrupt config",
      (harness: CoordinatorHarness) => {
        harness.files[PROJECT_CONFIG] = {
          content: 'agent loom {\n  prompt "unterminated',
          mtimeMs: 9_000,
        };
      },
      "ConfigParseFailed",
    ],
    [
      "an unterminated triple-quoted edit",
      (harness: CoordinatorHarness) => {
        harness.files[PROJECT_CONFIG] = {
          content: PRIMARY_CONFIG_V1.replace(
            'prompt_file "alpha.md"',
            'prompt """\n  unfinished multiline prompt',
          ),
          mtimeMs: 9_000,
        };
      },
      "ConfigParseFailed",
    ],
  ] as const)("keeps stale-catalog delegation green for %s", async (_case, mutate, expectedFailure) => {
    const harness = await coordinatorHarness();
    const { registration, dispatched } = delegationToolFor(harness);
    mutate(harness);

    expect(await delegate(registration, "alpha")).toEqual({
      ok: true,
      settlement: {
        outcome: "completed",
        finalOutput: "done",
        interventionCount: 0,
      },
    });

    expect(harness.coordinator.lastOutcome()).toMatchObject({
      kind: "failed",
      failure: { type: expectedFailure },
    });
    expect(dispatched).toHaveLength(1);
    expect(
      (dispatched[0]?.bootstrap as { composedPrompt: string }).composedPrompt,
    ).toContain("alpha prompt v1");
    expect(harness.cell.deferred()).toBeUndefined();
  });

  it("refuses a target the active primary has not been authorized to gain", async () => {
    const harness = await coordinatorHarness();
    const { registration, dispatched } = delegationToolFor(harness);
    harness.files[PROJECT_CONFIG] = {
      content: PRIMARY_CONFIG_WITH_DELTA,
      mtimeMs: 9_000,
    };

    expect(await delegate(registration, "delta")).toEqual({
      ok: false,
      error: "invalid-delegation-target",
    });
    expect(harness.coordinator.lastOutcome()?.kind).toBe("deferred");
    expect(dispatched).toEqual([]);

    // The same stable tool reaches it once an explicit switch publishes it.
    harness.control.primary = harness.cell.descriptors().get("scribe");
    await harness.coordinator.refreshAfterPrimaryReactivation();
    harness.control.primary = harness.cell.descriptors().get("loom");

    expect(await delegate(registration, "delta")).toMatchObject({ ok: true });
    expect(dispatched[0]?.agentName).toBe("delta");
  });

  it("dispatches on the last valid catalog when the refresh fails", async () => {
    const harness = await coordinatorHarness({
      statFailures: { [PROJECT_CONFIG]: "permission denied" },
    });
    const { registration, dispatched } = delegationToolFor(harness);

    expect(await delegate(registration, "alpha")).toMatchObject({ ok: true });

    expect(harness.coordinator.lastOutcome()?.kind).toBe("failed");
    expect(
      (dispatched[0]?.bootstrap as { composedPrompt: string }).composedPrompt,
    ).toContain("alpha prompt v1");
  });
});
