import { describe, expect, it } from "bun:test";
import { parseConfig, type WeaveConfig } from "@weaveio/weave-core";
import type {
  AgentDescriptor,
  MaterializationPlan,
} from "@weaveio/weave-engine";
import { okAsync } from "neverthrow";
import {
  clearPiCatalogCell,
  createPiCatalogCell,
  createPiCatalogCellHolder,
  derivePiCatalogSeedManifest,
} from "../catalog-cell.js";
import {
  type PiConfigActivationResult,
  PiConfigActivator,
} from "../config-activator.js";
import type { PiConfigCatalogState } from "../config-refresh.js";
import {
  createPiConfigSourceManifest,
  type PiConfigSourceIdentity,
  type PiConfigSourceManifest,
} from "../config-source-digests.js";

// ---------------------------------------------------------------------------
// Fixtures — no real filesystem, no real harness
// ---------------------------------------------------------------------------

const PROJECT_ROOT = "/my/project";
const HOME = "/home/testuser";

const TRUSTED_IDENTITY: PiConfigSourceIdentity = {
  projectRoot: PROJECT_ROOT,
  trust: "trusted",
};

function descriptor(name: string, composedPrompt: string): AgentDescriptor {
  return {
    name,
    composedPrompt,
    models: ["m1"],
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
  };
}

function config(text: string): WeaveConfig {
  const parsed = parseConfig(text);
  if (parsed.isErr()) {
    throw new Error(`test fixture failed to parse: ${parsed.error[0]?.type}`);
  }
  return parsed.value;
}

const CONFIG_V1 = config(`
agent alpha {
  prompt "alpha v1"
  models ["m1"]
  mode primary
}

workflow first {
  description "first flow"
  version 1

  step run {
    name "Run"
    type autonomous
    agent alpha
    prompt "Run it"
    completion agent_signal
  }
}
`);

const CONFIG_V2 = config(`
disable skills ["retired-skill"]

agent alpha {
  prompt "alpha v2"
  models ["m1"]
  mode primary
}

agent beta {
  prompt "beta v1"
  models ["m1"]
  mode primary
}

workflow second {
  description "second flow"
  version 1

  step run {
    name "Run"
    type autonomous
    agent alpha
    prompt "Run it"
    completion agent_signal
  }
}
`);

/** Builds a real activation result through the activator's own pipeline. */
async function activation(
  weaveConfig: WeaveConfig,
  agents: readonly { name: string; prompt: string }[],
): Promise<PiConfigActivationResult> {
  const plan: MaterializationPlan = {
    agents: agents.map((agent) => ({
      agentName: agent.name,
      source: "explicit" as const,
      descriptor: descriptor(agent.name, agent.prompt),
    })),
    errors: [],
  };
  const activated = await new PiConfigActivator({
    configLoader: { load: () => okAsync(weaveConfig) },
    materializer: { materialize: () => okAsync(plan) },
  }).activate({ projectRoot: PROJECT_ROOT, trust: "trusted" });
  return activated._unsafeUnwrap();
}

function emptyManifest(
  identity: PiConfigSourceIdentity = TRUSTED_IDENTITY,
): PiConfigSourceManifest {
  return createPiConfigSourceManifest({
    identity,
    globalConfigPath: `${HOME}/.weave/config.weave`,
    projectConfigPath: `${PROJECT_ROOT}/.weave/config.weave`,
    promptFilePaths: [],
  });
}

function state(
  next: PiConfigActivationResult,
  manifest: PiConfigSourceManifest = emptyManifest(),
  contents: PiConfigCatalogState["contents"] = new Map(),
): PiConfigCatalogState {
  return { activation: next, manifest, contents };
}

async function seededCell() {
  const first = await activation(CONFIG_V1, [
    { name: "alpha", prompt: "alpha v1" },
  ]);
  const cell = createPiCatalogCell({
    generationId: "generation-1",
    activation: first,
    manifest: emptyManifest(),
  });
  return { cell, first };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

describe("createPiCatalogCell — seeding", () => {
  it("serves the boot activation's descriptors, skills, and workflows", async () => {
    const { cell, first } = await seededCell();

    expect(cell.generationId).toBe("generation-1");
    expect(cell.isLive()).toBe(true);
    expect(cell.activation()).toBe(first);
    expect([...cell.descriptors().keys()]).toEqual(["alpha"]);
    expect(cell.disabledSkills()).toEqual([]);
    expect(Object.keys(cell.workflows())).toEqual(["first"]);
    expect(cell.deferred()).toBeUndefined();
  });

  it("reports no refresh state when it was seeded without a manifest", async () => {
    const first = await activation(CONFIG_V1, [
      { name: "alpha", prompt: "alpha v1" },
    ]);
    const cell = createPiCatalogCell({
      generationId: "generation-1",
      activation: first,
    });

    expect(cell.isLive()).toBe(true);
    expect(cell.activation()).toBe(first);
    expect(cell.manifest()).toBeUndefined();
    expect(cell.refreshState()).toBeUndefined();
    expect(cell.publication()?.contents).toBeUndefined();
  });

  it("exposes the seeded manifest and contents as one refresh state", async () => {
    const first = await activation(CONFIG_V1, [
      { name: "alpha", prompt: "alpha v1" },
    ]);
    const manifest = emptyManifest();
    const contents = new Map([
      [
        "/my/project/.weave/config.weave",
        { content: "x", sha256: "a".repeat(64) },
      ],
    ]);
    const cell = createPiCatalogCell({
      generationId: "generation-1",
      activation: first,
      manifest,
      contents,
    });

    expect(cell.manifest()).toBe(manifest);
    expect(cell.refreshState()).toEqual({
      activation: first,
      manifest,
      contents,
    });
  });
});

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

describe("PiCatalogCell — publication", () => {
  it("swaps the whole catalog in one assignment", async () => {
    const { cell, first } = await seededCell();
    const before = cell.publication();
    const next = await activation(CONFIG_V2, [
      { name: "alpha", prompt: "alpha v2" },
      { name: "beta", prompt: "beta v1" },
    ]);

    expect(cell.publish(state(next))).toBe("accepted");

    // Every facet moves together: descriptors, disabled skills, and
    // workflows all come from the newly published activation.
    expect(cell.activation()).toBe(next);
    expect([...cell.descriptors().keys()]).toEqual(["alpha", "beta"]);
    expect(cell.descriptors().get("alpha")?.composedPrompt).toBe("alpha v2");
    expect(cell.disabledSkills()).toEqual(["retired-skill"]);
    expect(Object.keys(cell.workflows())).toEqual(["second"]);

    // The replaced publication is a distinct, untouched object: nothing
    // mutated a live publication's fields in place.
    expect(cell.publication()).not.toBe(before);
    expect(before?.activation).toBe(first);
  });

  it("keeps reads consistent when publication fails to be observed midway", async () => {
    const { cell } = await seededCell();
    const next = await activation(CONFIG_V2, [
      { name: "alpha", prompt: "alpha v2" },
      { name: "beta", prompt: "beta v1" },
    ]);
    // A reader that captured the publication reference before the swap keeps
    // reading a whole, self-consistent catalog afterwards.
    const captured = cell.publication();
    cell.publish(state(next));

    expect(
      captured?.activation.descriptors.byName.get("alpha")?.composedPrompt,
    ).toBe("alpha v1");
    expect(captured?.activation.config.workflows).toEqual(
      CONFIG_V1.workflows ?? {},
    );
  });

  it("updates the refresh state to the published manifest and contents", async () => {
    const { cell } = await seededCell();
    const next = await activation(CONFIG_V2, [
      { name: "alpha", prompt: "alpha v2" },
    ]);
    const manifest = emptyManifest();
    const contents = new Map([
      [
        "/my/project/.weave/config.weave",
        { content: "y", sha256: "b".repeat(64) },
      ],
    ]);

    cell.publish(state(next, manifest, contents));

    expect(cell.refreshState()).toEqual({
      activation: next,
      manifest,
      contents,
    });
  });
});

// ---------------------------------------------------------------------------
// Deferred candidates
// ---------------------------------------------------------------------------

describe("PiCatalogCell — deferred candidates", () => {
  it("stores, reads, and consumes one deferred candidate", async () => {
    const { cell, first } = await seededCell();
    const next = await activation(CONFIG_V2, [
      { name: "alpha", prompt: "alpha v2" },
    ]);
    const candidate = {
      state: state(next),
      changedFacets: ["prompt"] as const,
      changedPaths: ["/my/project/.weave/config.weave"],
    };

    expect(cell.defer(candidate)).toBe("accepted");
    // Deferring changes nothing that serves a dispatch.
    expect(cell.activation()).toBe(first);
    expect(cell.deferred()).toBe(candidate);
    expect(cell.takeDeferred()).toBe(candidate);
    expect(cell.deferred()).toBeUndefined();
    expect(cell.takeDeferred()).toBeUndefined();
  });

  it("drops a deferred candidate the published state supersedes", async () => {
    const { cell } = await seededCell();
    const next = await activation(CONFIG_V2, [
      { name: "alpha", prompt: "alpha v2" },
    ]);
    cell.defer({
      state: state(next),
      changedFacets: ["prompt"],
      changedPaths: [],
    });

    cell.publish(state(next));

    expect(cell.deferred()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

describe("PiCatalogCell — invalidation", () => {
  it("reads nothing usable and refuses writes once invalidated", async () => {
    const { cell } = await seededCell();
    const next = await activation(CONFIG_V2, [
      { name: "alpha", prompt: "alpha v2" },
    ]);
    cell.defer({
      state: state(next),
      changedFacets: ["prompt"],
      changedPaths: [],
    });

    cell.invalidate();

    expect(cell.isLive()).toBe(false);
    expect(cell.publication()).toBeUndefined();
    expect(cell.activation()).toBeUndefined();
    expect(cell.descriptors().size).toBe(0);
    expect(cell.disabledSkills()).toEqual([]);
    expect(cell.workflows()).toEqual({});
    expect(cell.manifest()).toBeUndefined();
    expect(cell.refreshState()).toBeUndefined();
    expect(cell.deferred()).toBeUndefined();
    expect(cell.takeDeferred()).toBeUndefined();
    expect(cell.publish(state(next))).toBe("stale");
    expect(
      cell.defer({
        state: state(next),
        changedFacets: ["prompt"],
        changedPaths: [],
      }),
    ).toBe("stale");
    // A refused publish never resurrects the cell.
    expect(cell.isLive()).toBe(false);
  });

  it("is idempotent", async () => {
    const { cell } = await seededCell();
    cell.invalidate();
    cell.invalidate();
    expect(cell.isLive()).toBe(false);
  });

  it("invalidates the held cell when the holder is cleared", async () => {
    const { cell } = await seededCell();
    const holder = createPiCatalogCellHolder();
    holder.cell = cell;

    clearPiCatalogCell(holder);

    expect(holder.cell).toBeUndefined();
    // The stale reference a closure may still hold reads nothing.
    expect(cell.isLive()).toBe(false);
    expect(cell.descriptors().size).toBe(0);
  });

  it("clears an empty holder without failing", () => {
    const holder = createPiCatalogCellHolder();
    clearPiCatalogCell(holder);
    expect(holder.cell).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Seed manifest derivation
// ---------------------------------------------------------------------------

describe("derivePiCatalogSeedManifest", () => {
  it("records the trusted source graph as not yet observed", () => {
    const manifest = derivePiCatalogSeedManifest({
      identity: TRUSTED_IDENTITY,
      // `resolvePromptPaths` has already made every scope's prompt path
      // absolute by the time an activation's config reaches the cell.
      config: {
        ...CONFIG_V1,
        agents: {
          alpha: {
            ...CONFIG_V1.agents.alpha,
            prompt: undefined,
            prompt_file: `${PROJECT_ROOT}/.weave/prompts/alpha.md`,
          },
        },
      } as unknown as WeaveConfig,
      homeDir: HOME,
    });

    expect(manifest?.identity).toEqual(TRUSTED_IDENTITY);
    expect(manifest?.files.map((file) => [file.kind, file.path])).toEqual([
      ["global-config", `${HOME}/.weave/config.weave`],
      ["project-config", `${PROJECT_ROOT}/.weave/config.weave`],
      ["prompt-file", `${PROJECT_ROOT}/.weave/prompts/alpha.md`],
    ]);
    // Nothing was stat'ed, read, or hashed: the first probe must discover
    // every present source rather than assume it unchanged.
    expect(manifest?.files.every((file) => file.presence === "absent")).toBe(
      true,
    );
    expect(manifest?.files.every((file) => file.sha256 === undefined)).toBe(
      true,
    );
  });

  it("excludes the project config while trust is withheld", () => {
    const manifest = derivePiCatalogSeedManifest({
      identity: { projectRoot: PROJECT_ROOT, trust: "withheld" },
      config: CONFIG_V1,
      homeDir: HOME,
    });

    expect(manifest?.files.map((file) => file.kind)).toEqual(["global-config"]);
  });
});
