import { describe, expect, it } from "bun:test";
import {
  BunChangesetFileSystem,
  ChangesetPolicyValidator,
  type ValidatedChangeset,
} from "../changeset-policy.js";
import type { PublicPackageName } from "../constants.js";
import {
  type BundledImpactMap,
  computeSelectionClosure,
  type SelectionClosure,
  type SelectionClosureInput,
  type SelectionSeed,
  type WorkspaceManifest,
} from "../selection-closure.js";

const CLI = "@weaveio/weave-cli";
const OPENCODE = "@weaveio/weave-adapter-opencode";
const CLAUDE_CODE = "@weaveio/weave-adapter-claude-code";
const PI = "@weaveio/weave-adapter-pi";

const CATALOG = [CLI, OPENCODE, CLAUDE_CODE, PI] as const;

/** The real workspace dependency graph, merged across dependency fields. */
const MANIFESTS: readonly WorkspaceManifest[] = [
  {
    name: CLI,
    dependencies: [
      "@weaveio/weave-config",
      "@weaveio/weave-core",
      "@weaveio/weave-engine",
      CLAUDE_CODE,
      PI,
      "neverthrow",
      "zod",
    ],
  },
  {
    name: OPENCODE,
    dependencies: [
      "@weaveio/weave-config",
      "@weaveio/weave-core",
      "@weaveio/weave-engine",
      "neverthrow",
    ],
  },
  {
    name: CLAUDE_CODE,
    dependencies: ["@weaveio/weave-core", "@weaveio/weave-engine", "mustache"],
  },
  {
    name: PI,
    dependencies: [
      "@weaveio/weave-config",
      "@weaveio/weave-core",
      "@weaveio/weave-engine",
      "kysely",
    ],
  },
  { name: "@weaveio/weave-core", dependencies: ["neverthrow"] },
  {
    name: "@weaveio/weave-config",
    dependencies: ["@weaveio/weave-core", "@weaveio/weave-engine"],
  },
  { name: "@weaveio/weave-engine", dependencies: ["@weaveio/weave-core"] },
];

/** Parses a fixture through the real policy so identities are real. */
function changeset(id: string, source: string): ValidatedChangeset {
  const result = new ChangesetPolicyValidator(
    new BunChangesetFileSystem(),
  ).validateFile(`.changeset/${id}.md`, new TextEncoder().encode(source));
  if (result.isErr())
    throw new Error(
      `Fixture changeset ${id} is invalid: ${JSON.stringify(result.error)}`,
    );
  return result.value;
}

const sharedChangeset = changeset(
  "portable-delegation-limits",
  `---
"${CLI}": minor
"${OPENCODE}": minor
---

Cap delegation with portable limits that every harness can enforce.
`,
);

const piChangeset = changeset(
  "pi-settlement-budget",
  `---
"${PI}": patch
---

Renew the settlement budget while a child is still reporting activity.
`,
);

const bundledConfigChangeset = changeset(
  "merged-prompt-paths",
  `---
"${CLI}": minor
"${OPENCODE}": minor
"${PI}": minor
---

Resolve prompt paths from the merged configuration.

Bundled-source: @weaveio/weave-config
`,
);

const emptyChangeset = changeset(
  "contributor-docs-only",
  `---
---

Reason: contributor documentation only; no published artifact changes.
`,
);

/** Claims config's change also reaches the Claude Code adapter. */
const WIDENED_IMPACTS: BundledImpactMap = {
  "@weaveio/weave-config": [CLI, OPENCODE, CLAUDE_CODE, PI],
};

function seedOf(...packages: readonly PublicPackageName[]): SelectionSeed {
  return {
    [CLI]: packages.includes(CLI),
    [OPENCODE]: packages.includes(OPENCODE),
    [CLAUDE_CODE]: packages.includes(CLAUDE_CODE),
    [PI]: packages.includes(PI),
  };
}

function closureOf(input: SelectionClosureInput): SelectionClosure {
  const result = computeSelectionClosure(input);
  if (result.isErr())
    throw new Error(
      `Unexpected closure failure: ${JSON.stringify(result.error)}`,
    );
  return result.value;
}

describe("computeSelectionClosure", () => {
  it("rejects a seed that selects nothing", () => {
    const result = computeSelectionClosure({
      seed: seedOf(),
      changesets: [sharedChangeset],
      manifests: MANIFESTS,
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({ type: "EmptySelection" });
  });

  it("keeps a lone seed when no changeset forces more", () => {
    const closure = closureOf({
      seed: seedOf(OPENCODE),
      changesets: [emptyChangeset],
      manifests: MANIFESTS,
    });

    expect(closure.seed).toEqual([OPENCODE]);
    expect(closure.selected).toEqual([OPENCODE]);
    expect(closure.added).toEqual([]);
  });

  it("pulls in every member of a shared changeset and explains it", () => {
    const closure = closureOf({
      seed: seedOf(OPENCODE),
      changesets: [sharedChangeset, emptyChangeset],
      manifests: MANIFESTS,
    });

    expect(closure.selected).toEqual([CLI, OPENCODE]);
    expect(closure.added).toEqual([
      {
        package: CLI,
        reason: {
          kind: "shared-changeset",
          evidence: {
            changesetId: "portable-delegation-limits",
            sourceDigest: sharedChangeset.identity.sourceDigest,
            trigger: OPENCODE,
            members: [CLI, OPENCODE],
          },
        },
      },
    ]);
  });

  it("pulls in a package whose artifact bundles a changed dependency", () => {
    const closure = closureOf({
      seed: seedOf(PI),
      changesets: [piChangeset],
      manifests: MANIFESTS,
    });

    expect(closure.selected).toEqual([CLI, PI]);
    expect(closure.added).toEqual([
      {
        package: CLI,
        reason: {
          kind: "artifact-dependency",
          evidence: {
            changesetId: "pi-settlement-budget",
            sourceDigest: piChangeset.identity.sourceDigest,
            trigger: PI,
            source: PI,
            relationship: "manifest-dependency",
            dependencyPath: [CLI, PI],
          },
        },
      },
    ]);
  });

  it("pulls in the changed dependency itself when only a dependent is seeded", () => {
    const closure = closureOf({
      seed: seedOf(CLI),
      changesets: [piChangeset],
      manifests: MANIFESTS,
    });

    expect(closure.selected).toEqual([CLI, PI]);
    expect(closure.added).toEqual([
      {
        package: PI,
        reason: {
          kind: "artifact-dependency",
          evidence: {
            changesetId: "pi-settlement-budget",
            sourceDigest: piChangeset.identity.sourceDigest,
            trigger: CLI,
            source: PI,
            relationship: "changed-artifact",
            dependencyPath: [],
          },
        },
      },
    ]);
  });

  it("adds only the packages a bundled private source reaches", () => {
    const closure = closureOf({
      seed: seedOf(CLI),
      changesets: [bundledConfigChangeset],
      manifests: MANIFESTS,
    });

    expect(closure.selected).toEqual([CLI, OPENCODE, PI]);
    expect(closure.added.map((addition) => addition.package)).toEqual([
      OPENCODE,
      PI,
    ]);
    for (const addition of closure.added)
      expect(addition.reason.kind).toBe("shared-changeset");
  });

  it("adds a package the bundled-impact map declares without a manifest path", () => {
    const closure = closureOf({
      seed: seedOf(CLI),
      changesets: [bundledConfigChangeset],
      manifests: MANIFESTS,
      bundledImpacts: WIDENED_IMPACTS,
    });

    expect(closure.selected).toEqual([CLI, OPENCODE, CLAUDE_CODE, PI]);
    expect(
      closure.added.find((addition) => addition.package === CLAUDE_CODE)
        ?.reason,
    ).toEqual({
      kind: "artifact-dependency",
      evidence: {
        changesetId: "merged-prompt-paths",
        sourceDigest: bundledConfigChangeset.identity.sourceDigest,
        trigger: CLI,
        source: "@weaveio/weave-config",
        relationship: "declared-impact",
        dependencyPath: [],
      },
    });
  });

  it("adds nothing when all four packages are seeded", () => {
    const closure = closureOf({
      seed: seedOf(...CATALOG),
      changesets: [sharedChangeset, piChangeset, bundledConfigChangeset],
      manifests: MANIFESTS,
    });

    expect(closure.seed).toEqual([...CATALOG]);
    expect(closure.selected).toEqual([...CATALOG]);
    expect(closure.added).toEqual([]);
  });

  it("returns byte-identical output for identical input", () => {
    const input: SelectionClosureInput = {
      seed: seedOf(CLAUDE_CODE),
      changesets: [bundledConfigChangeset, piChangeset, sharedChangeset],
      manifests: MANIFESTS,
    };

    expect(JSON.stringify(closureOf(input))).toBe(
      JSON.stringify(closureOf(input)),
    );
  });

  it("ignores changeset input order", () => {
    const changesets = [sharedChangeset, piChangeset, bundledConfigChangeset];
    const forward = closureOf({
      seed: seedOf(OPENCODE),
      changesets,
      manifests: MANIFESTS,
    });
    const reversed = closureOf({
      seed: seedOf(OPENCODE),
      changesets: [...changesets].reverse(),
      manifests: MANIFESTS,
    });

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });
});

/** Every seed the closed catalog admits, including the empty one. */
function everySeed(): readonly (readonly PublicPackageName[])[] {
  const seeds: (readonly PublicPackageName[])[] = [];
  for (let mask = 0; mask < 1 << CATALOG.length; mask += 1)
    seeds.push(CATALOG.filter((_, index) => (mask & (1 << index)) !== 0));
  return seeds;
}

const NON_EMPTY_SEEDS = everySeed().filter((seed) => seed.length > 0);

const SCENARIOS: readonly {
  name: string;
  changesets: readonly ValidatedChangeset[];
  bundledImpacts?: BundledImpactMap;
}[] = [
  { name: "no changesets", changesets: [] },
  { name: "only an empty changeset", changesets: [emptyChangeset] },
  { name: "a shared changeset", changesets: [sharedChangeset] },
  { name: "a single-package changeset", changesets: [piChangeset] },
  { name: "a bundled-source changeset", changesets: [bundledConfigChangeset] },
  {
    name: "a bundled-source changeset with a widened impact map",
    changesets: [bundledConfigChangeset],
    bundledImpacts: WIDENED_IMPACTS,
  },
  {
    name: "every changeset at once",
    changesets: [
      sharedChangeset,
      piChangeset,
      bundledConfigChangeset,
      emptyChangeset,
    ],
  },
];

describe("selection closure invariants", () => {
  for (const scenario of SCENARIOS)
    for (const seed of NON_EMPTY_SEEDS) {
      const label = `${scenario.name} seeded with ${seed.join(", ")}`;

      it(`never removes a seed package: ${label}`, () => {
        const closure = closureOf({
          seed: seedOf(...seed),
          changesets: scenario.changesets,
          manifests: MANIFESTS,
          bundledImpacts: scenario.bundledImpacts,
        });

        expect(closure.seed).toEqual(CATALOG.filter((n) => seed.includes(n)));
        for (const packageName of seed)
          expect(closure.selected).toContain(packageName);
        for (const addition of closure.added)
          expect(seed).not.toContain(addition.package);
      });

      it(`is idempotent: ${label}`, () => {
        const input: SelectionClosureInput = {
          seed: seedOf(...seed),
          changesets: scenario.changesets,
          manifests: MANIFESTS,
          bundledImpacts: scenario.bundledImpacts,
        };
        const first = closureOf(input);
        const second = closureOf({ ...input, seed: seedOf(...first.selected) });

        expect(second.seed).toEqual(first.selected);
        expect(second.selected).toEqual(first.selected);
        expect(second.added).toEqual([]);
      });
    }
});

describe("workspace manifest validation", () => {
  it("rejects a manifest naming a workspace outside the repository", () => {
    const result = computeSelectionClosure({
      seed: seedOf(CLI),
      changesets: [],
      manifests: [...MANIFESTS, { name: "@acme/tool", dependencies: [] }],
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({
      type: "UnknownWorkspace",
      name: "@acme/tool",
    });
  });

  it("rejects a duplicated workspace manifest", () => {
    const result = computeSelectionClosure({
      seed: seedOf(CLI),
      changesets: [],
      manifests: [...MANIFESTS, { name: PI, dependencies: [] }],
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({
      type: "DuplicateWorkspaceManifest",
      name: PI,
    });
  });

  it("rejects a catalog package with no manifest", () => {
    const result = computeSelectionClosure({
      seed: seedOf(CLI),
      changesets: [],
      manifests: MANIFESTS.filter((manifest) => manifest.name !== CLAUDE_CODE),
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) return;
    expect(result.error).toEqual({
      type: "MissingWorkspaceManifest",
      packageName: CLAUDE_CODE,
    });
  });
});
