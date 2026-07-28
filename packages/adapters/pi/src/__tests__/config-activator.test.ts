import { describe, expect, it } from "bun:test";
import type { ConfigLoadError, FileReader } from "@weaveio/weave-config";
import { loadConfig } from "@weaveio/weave-config";
import type { WeaveConfig } from "@weaveio/weave-core";
import type { MaterializationPlan } from "@weaveio/weave-engine";
import { materializeAgents } from "@weaveio/weave-engine";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  buildDescriptorCatalog,
  createTrustWithheldFileReader,
  logMaterializationErrors,
  PiConfigActivator,
} from "../config-activator.js";
import { RecordingLogger } from "./fakes/fake-pi-host.js";

// ---------------------------------------------------------------------------
// In-memory FileReader fixture (never touches the real filesystem)
// ---------------------------------------------------------------------------

type FileMap = Record<string, string>;

function mockReader(files: FileMap): FileReader {
  return {
    exists: async (path) => path in files,
    read: (path) => {
      const content = files[path];
      if (content === undefined) {
        return errAsync<string, ConfigLoadError>({
          type: "FileReadError",
          path,
          cause: new Error("not found"),
        });
      }
      return okAsync(content);
    },
  };
}

const PROJECT_ROOT = "/my/project";
const GLOBAL_CONFIG_PATH = `${process.env.HOME ?? "/home/testuser"}/.weave/config.weave`;
const PROJECT_CONFIG_PATH = `${PROJECT_ROOT}/.weave/config.weave`;

const PROJECT_DSL = `
agent loom {
  prompt "You are Loom."
  models ["claude-sonnet-4-5"]
  mode primary
}
`;

describe("createTrustWithheldFileReader", () => {
  it("blocks exists() for any path under the project's .weave directory", async () => {
    const inner = mockReader({ [PROJECT_CONFIG_PATH]: PROJECT_DSL });
    const wrapped = createTrustWithheldFileReader(inner, PROJECT_ROOT);
    expect(await wrapped.exists(PROJECT_CONFIG_PATH)).toBe(false);
    expect(await wrapped.exists(`${PROJECT_ROOT}/.weave/prompts/loom.md`)).toBe(
      false,
    );
  });

  it("blocks read() for any path under the project's .weave directory", async () => {
    const inner = mockReader({ [PROJECT_CONFIG_PATH]: PROJECT_DSL });
    const wrapped = createTrustWithheldFileReader(inner, PROJECT_ROOT);
    const result = await wrapped.read(PROJECT_CONFIG_PATH);
    expect(result.isErr()).toBe(true);
  });

  it("delegates untouched to the inner reader for paths outside the project's .weave directory", async () => {
    const inner = mockReader({ [GLOBAL_CONFIG_PATH]: PROJECT_DSL });
    const wrapped = createTrustWithheldFileReader(inner, PROJECT_ROOT);
    expect(await wrapped.exists(GLOBAL_CONFIG_PATH)).toBe(true);
    const result = await wrapped.read(GLOBAL_CONFIG_PATH);
    expect(result.isOk()).toBe(true);
  });
});

describe("PiConfigActivator (unit, fake ports)", () => {
  it("loads config and materializes it into a descriptor catalog", async () => {
    const config = {
      agents: {},
      disabled: { agents: [], skills: [] },
    } as unknown as WeaveConfig;
    const plan: MaterializationPlan = {
      agents: [
        {
          agentName: "loom",
          source: "explicit",
          descriptor: {
            name: "loom",
            composedPrompt: "You are Loom.",
            models: ["claude-sonnet-4-5"],
            mode: "primary",
            effectiveToolPolicy: {
              read: "allow",
              write: "allow",
              execute: "allow",
              delegate: "allow",
              network: "ask",
            },
            rawToolPolicy: undefined,
            delegationTargets: [],
            skills: [],
          },
        },
      ],
      errors: [],
    };

    const activator = new PiConfigActivator({
      configLoader: { load: () => okAsync(config) },
      materializer: { materialize: () => okAsync(plan) },
    });

    const result = await activator.activate({
      projectRoot: PROJECT_ROOT,
      trust: "trusted",
    });

    expect(result.isOk()).toBe(true);
    const activation = result._unsafeUnwrap();
    expect(activation.descriptors.order).toEqual(["loom"]);
    expect(activation.descriptors.byName.get("loom")?.composedPrompt).toBe(
      "You are Loom.",
    );
    expect(activation.trust).toBe("trusted");
  });

  it("returns Pi-local settings validation without rejecting unrelated adapter blocks", async () => {
    const config = {
      agents: {},
      disabled: { agents: [], skills: [] },
      settings: {
        adapters: {
          other_harness: { preserved: true },
          pi: {
            child_inspection: {
              max_bytes_per_child: 65_536,
              max_bytes_total: 65_535,
              unknown_limit: 1,
            },
          },
        },
      },
    } as unknown as WeaveConfig;
    const activator = new PiConfigActivator({
      configLoader: { load: () => okAsync(config) },
      materializer: { materialize: () => okAsync({ agents: [], errors: [] }) },
    });

    const result = await activator.activate({
      projectRoot: PROJECT_ROOT,
      trust: "trusted",
    });

    expect(result.isOk()).toBe(true);
    const settings = result._unsafeUnwrap().childInspectionSettings;
    expect(settings.status).toBe("invalid");
    if (settings.status === "invalid") {
      expect(settings.issues.length).toBe(2);
      expect(settings.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(
        true,
      );
    }
    expect(result._unsafeUnwrap().config).toBe(config);
  });

  it("maps a config load failure into an ActivationFailed PiAdapterFailure", async () => {
    const activator = new PiConfigActivator({
      configLoader: {
        load: () =>
          errAsync<WeaveConfig, ConfigLoadError[]>([
            { type: "FileReadError", path: "x", cause: new Error("boom") },
          ]),
      },
    });

    const result = await activator.activate({
      projectRoot: PROJECT_ROOT,
      trust: "trusted",
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe("ActivationFailed");
  });

  it("passes a trust-withheld file reader to the config loader when trust is withheld", async () => {
    let receivedProjectExists: boolean | undefined;
    const activator = new PiConfigActivator({
      fileReader: mockReader({ [PROJECT_CONFIG_PATH]: PROJECT_DSL }),
      configLoader: {
        load: (_root, fileReader) =>
          ResultAsync.fromSafePromise(
            fileReader.exists(PROJECT_CONFIG_PATH),
          ).andThen((exists) => {
            receivedProjectExists = exists;
            return okAsync({
              agents: {},
              disabled: { agents: [], skills: [] },
            } as unknown as WeaveConfig);
          }),
      },
      materializer: {
        materialize: () => okAsync({ agents: [], errors: [] }),
      },
    });

    await activator.activate({ projectRoot: PROJECT_ROOT, trust: "withheld" });

    expect(receivedProjectExists).toBe(false);
  });

  it("fails closed instead of throwing when the injected configLoader port throws synchronously, without leaking the thrown message into correlation", async () => {
    const activator = new PiConfigActivator({
      configLoader: {
        load: () => {
          throw new Error(
            "leaked: /Users/attacker/.ssh/id_rsa token=sk-super-secret-123",
          );
        },
      },
    });

    const result = await activator.activate({
      projectRoot: PROJECT_ROOT,
      trust: "trusted",
    });

    expect(result.isErr()).toBe(true);
    const failure = result._unsafeUnwrapErr();
    expect(failure.code).toBe("ActivationFailed");
    // The correlation reason is a fixed, closed-set literal - never the raw
    // thrown message, since that content cannot be trusted not to contain
    // private paths, environment values, or secrets (Pi adapter contract closed-failure
    // contract).
    expect(failure.correlation).toEqual({ reason: "config-load-threw" });
    expect(JSON.stringify(failure)).not.toContain("id_rsa");
    expect(JSON.stringify(failure)).not.toContain("sk-super-secret-123");
  });

  it("never throws itself when the injected configLoader port throws a hostile, unstringifiable object", async () => {
    const activator = new PiConfigActivator({
      configLoader: {
        load: () => {
          throw {
            toString(): string {
              throw new Error("toString exploded");
            },
          };
        },
      },
    });

    const result = await activator.activate({
      projectRoot: PROJECT_ROOT,
      trust: "trusted",
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().correlation).toEqual({
      reason: "config-load-threw",
    });
  });

  it("fails closed instead of an unhandled rejection when the injected materializer port rejects", async () => {
    const activator = new PiConfigActivator({
      configLoader: {
        load: () =>
          okAsync({
            agents: {},
            disabled: { agents: [], skills: [] },
          } as unknown as WeaveConfig),
      },
      materializer: {
        materialize: () =>
          Promise.reject(
            new Error("leaked: token=sk-super-secret-123"),
          ) as never,
      },
    });

    const result = await activator.activate({
      projectRoot: PROJECT_ROOT,
      trust: "trusted",
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().correlation).toEqual({
      reason: "materialize-threw",
    });
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain(
      "sk-super-secret-123",
    );
    expect(result._unsafeUnwrapErr().code).toBe("ActivationFailed");
  });
});

describe("PiConfigActivator (integration, real loadConfig + materializeAgents)", () => {
  it("trusted: merges and materializes the real project config", async () => {
    const reader = mockReader({ [PROJECT_CONFIG_PATH]: PROJECT_DSL });
    const activator = new PiConfigActivator({
      fileReader: reader,
      configLoader: { load: (root, fr) => loadConfig(root, fr) },
      materializer: { materialize: (config) => materializeAgents({ config }) },
    });

    const result = await activator.activate({
      projectRoot: PROJECT_ROOT,
      trust: "trusted",
    });

    expect(result.isOk()).toBe(true);
    const activation = result._unsafeUnwrap();
    expect(activation.descriptors.byName.get("loom")?.composedPrompt).toContain(
      "You are Loom.",
    );
  });

  it("withheld: never merges the real project config, even though it exists on disk", async () => {
    const reader = mockReader({ [PROJECT_CONFIG_PATH]: PROJECT_DSL });
    const activator = new PiConfigActivator({
      fileReader: reader,
      configLoader: { load: (root, fr) => loadConfig(root, fr) },
      materializer: { materialize: (config) => materializeAgents({ config }) },
    });

    const result = await activator.activate({
      projectRoot: PROJECT_ROOT,
      trust: "withheld",
    });

    expect(result.isOk()).toBe(true);
    const activation = result._unsafeUnwrap();
    // Project-only "loom" override never merges in; builtin/global descriptors
    // (if any) are all this activation can see.
    const loom = activation.descriptors.byName.get("loom");
    expect(loom === undefined || loom.composedPrompt !== "You are Loom.").toBe(
      true,
    );
  });
});

describe("buildDescriptorCatalog", () => {
  it("preserves plan.agents order and carries plan.errors through unchanged", () => {
    const plan: MaterializationPlan = {
      agents: [
        {
          agentName: "b",
          source: "explicit",
          descriptor: {
            name: "b",
            composedPrompt: "B",
            models: [],
            mode: "subagent",
            effectiveToolPolicy: {
              read: "allow",
              write: "allow",
              execute: "allow",
              delegate: "allow",
              network: "ask",
            },
            rawToolPolicy: undefined,
            delegationTargets: [],
            skills: [],
          },
        },
        {
          agentName: "a",
          source: "explicit",
          descriptor: {
            name: "a",
            composedPrompt: "A",
            models: [],
            mode: "subagent",
            effectiveToolPolicy: {
              read: "allow",
              write: "allow",
              execute: "allow",
              delegate: "allow",
              network: "ask",
            },
            rawToolPolicy: undefined,
            delegationTargets: [],
            skills: [],
          },
        },
      ],
      errors: [
        {
          type: "DescriptorCompositionFailure",
          agentName: "broken",
          cause: {
            type: "PromptSourceMissingError",
            agentName: "broken",
            message: "missing prompt",
          },
        },
      ],
    };

    const catalog = buildDescriptorCatalog(plan);
    expect(catalog.order).toEqual(["b", "a"]);
    expect(catalog.byName.get("broken")).toBeUndefined();
    expect(catalog.errors).toEqual(plan.errors);
  });
});

describe("logMaterializationErrors", () => {
  it("logs one warning per error, with error-specific fields", () => {
    const logger = new RecordingLogger();
    logMaterializationErrors(
      [
        {
          type: "CategoryShuttleConflict",
          conflict: {
            type: "CategoryShuttleConflictError",
            shuttleName: "shuttle-backend",
            categoryName: "backend",
            message: "conflict",
          },
        },
        {
          type: "ReviewVariantConflict",
          conflict: {
            type: "ReviewVariantConflictError",
            variantName: "weft-openai-gpt-5",
            agentName: "weft",
            reviewModel: "gpt-5",
            message: "conflict",
          },
        },
        {
          type: "DescriptorCompositionFailure",
          agentName: "broken",
          cause: {
            type: "PromptSourceMissingError",
            agentName: "broken",
            message: "missing prompt",
          },
        },
      ],
      logger,
    );

    expect(logger.entries).toHaveLength(3);
    expect(logger.entries[0]?.obj).toEqual({
      shuttleName: "shuttle-backend",
      categoryName: "backend",
    });
    expect(logger.entries[1]?.obj).toEqual({
      variantName: "weft-openai-gpt-5",
      agentName: "weft",
      reviewModel: "gpt-5",
    });
    expect(logger.entries[2]?.obj).toEqual({ agentName: "broken" });
  });
});
