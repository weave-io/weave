import { describe, expect, it } from "bun:test";
import type { FileReader } from "@weaveio/weave-config";
import type {
  AgentDescriptor,
  EffectiveToolPolicy,
} from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";
import { PiConfigActivator } from "../config-activator.js";
import {
  decidePiPrimaryContract,
  PI_PRIMARY_CONTRACT_FACETS,
  type PiPrimaryContractCandidate,
  type PiPrimaryContractFacet,
  toPiPrimaryContractCandidate,
} from "../primary-contract.js";
import {
  DEFAULT_PRIMARY_AGENT_NAME,
  type PiSkillResolutionPort,
  renderWeavePromptBlock,
} from "../primary-session.js";
import { PiSkillCatalog } from "../skill-catalog.js";
import type { PiSkillInfo } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POLICY: EffectiveToolPolicy = {
  read: "allow",
  write: "allow",
  execute: "allow",
  delegate: "allow",
  network: "ask",
};

const AVAILABLE_SKILLS: readonly PiSkillInfo[] = [
  { name: "tdd", filePath: "/skills/tdd/SKILL.md" },
  { name: "code-review", filePath: "/skills/code-review/SKILL.md" },
];

function descriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    name: DEFAULT_PRIMARY_AGENT_NAME,
    composedPrompt: "You are Loom, the orchestrator.",
    models: ["anthropic/claude-sonnet-4-5#high"],
    mode: "primary",
    effectiveToolPolicy: POLICY,
    rawToolPolicy: undefined,
    delegationTargets: [
      {
        name: "shuttle",
        description: "worker",
        triggers: [],
        isCategory: false,
      },
      {
        name: "weft",
        description: "reviewer",
        triggers: [],
        isCategory: false,
      },
    ],
    skills: ["tdd"],
    ...overrides,
  };
}

function catalogOf(
  ...descriptors: readonly AgentDescriptor[]
): ReadonlyMap<string, AgentDescriptor> {
  return new Map(descriptors.map((entry) => [entry.name, entry]));
}

function candidateOf(
  overrides: Partial<PiPrimaryContractCandidate> = {},
): PiPrimaryContractCandidate {
  return {
    descriptors: catalogOf(descriptor()),
    disabledAgents: [],
    disabledSkills: [],
    ...overrides,
  };
}

const SKILLS = new PiSkillCatalog(AVAILABLE_SKILLS);

interface DecideOverrides {
  readonly primary?: AgentDescriptor | undefined;
  readonly disabledSkills?: readonly string[];
  readonly candidate?: PiPrimaryContractCandidate;
  readonly skills?: PiSkillResolutionPort;
}

function decide(overrides: DecideOverrides = {}) {
  return decidePiPrimaryContract({
    primary: "primary" in overrides ? overrides.primary : descriptor(),
    disabledSkills: overrides.disabledSkills ?? [],
    candidate: overrides.candidate ?? candidateOf(),
    skills: overrides.skills ?? SKILLS,
  });
}

/** Facets of the returned decision; `[]` means `publishable`. */
function facets(
  decision: ReturnType<typeof decidePiPrimaryContract>,
): readonly PiPrimaryContractFacet[] {
  return decision.decision === "publishable" ? [] : decision.changedFacets;
}

// ---------------------------------------------------------------------------
// Table-driven facet coverage
// ---------------------------------------------------------------------------

interface FacetCase {
  readonly name: string;
  /** Overrides applied to the committed primary descriptor. */
  readonly current?: Partial<AgentDescriptor>;
  /** Overrides applied to the candidate's descriptor of the same name. */
  readonly next?: Partial<AgentDescriptor>;
  readonly currentDisabledSkills?: readonly string[];
  readonly candidateDisabledSkills?: readonly string[];
  /** Replaces the candidate catalog entirely (removal / demotion cases). */
  readonly candidate?: PiPrimaryContractCandidate;
  /** `[]` means the candidate is publishable. */
  readonly expected: readonly PiPrimaryContractFacet[];
}

const FACET_CASES: readonly FacetCase[] = [
  {
    name: "identical descriptors publish",
    expected: [],
  },
  {
    name: "a composed-prompt edit is a prompt change",
    next: { composedPrompt: "You are Loom, the orchestrator. Be terse." },
    expected: ["prompt"],
  },
  {
    name: "a base-model change is a model change",
    next: { models: ["openai/gpt-5.6#high"] },
    expected: ["models"],
  },
  {
    name: "reordering the model intent is a model change",
    current: { models: ["openai/gpt-5.6", "anthropic/claude-sonnet-4-5"] },
    next: { models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5.6"] },
    expected: ["models"],
  },
  {
    name: "a thinking-level suffix change is a thinking change only",
    next: { models: ["anthropic/claude-sonnet-4-5#low"] },
    expected: ["thinking"],
  },
  {
    name: "adding a thinking level where none was declared is a thinking change",
    current: { models: ["anthropic/claude-sonnet-4-5"] },
    next: { models: ["anthropic/claude-sonnet-4-5#high"] },
    expected: ["thinking"],
  },
  {
    name: "an invalid thinking suffix is compared as part of the base model",
    current: { models: ["anthropic/claude-sonnet-4-5#bogus"] },
    next: { models: ["anthropic/claude-sonnet-4-5#high"] },
    expected: ["models", "thinking"],
  },
  {
    name: "a declared temperature change is a temperature change",
    current: { temperature: 0.2 },
    next: { temperature: 0.7 },
    expected: ["temperature"],
  },
  {
    name: "dropping a declared temperature is a temperature change",
    current: { temperature: 0.2 },
    candidate: candidateOf({ descriptors: catalogOf(descriptor()) }),
    expected: ["temperature"],
  },
  {
    name: "declaring fast is a fast change",
    next: { fast: true },
    expected: ["fast"],
  },
  {
    name: "dropping fast is a fast change",
    current: { fast: true },
    candidate: candidateOf({ descriptors: catalogOf(descriptor()) }),
    expected: ["fast"],
  },
  {
    name: "an effective tool-policy change is a tool-policy change",
    next: { effectiveToolPolicy: { ...POLICY, network: "allow" } },
    expected: ["tool-policy"],
  },
  {
    name: "an added delegation target is a target change",
    next: {
      delegationTargets: [
        ...descriptor().delegationTargets,
        {
          name: "warp",
          description: "auditor",
          triggers: [],
          isCategory: false,
        },
      ],
    },
    expected: ["delegation-targets"],
  },
  {
    name: "a removed delegation target is a target change",
    next: {
      delegationTargets: [
        {
          name: "shuttle",
          description: "worker",
          triggers: [],
          isCategory: false,
        },
      ],
    },
    expected: ["delegation-targets"],
  },
  {
    name: "a delegation-target description change is a target change",
    next: {
      delegationTargets: [
        {
          name: "shuttle",
          description: "worker (revised)",
          triggers: [],
          isCategory: false,
        },
        {
          name: "weft",
          description: "reviewer",
          triggers: [],
          isCategory: false,
        },
      ],
    },
    expected: ["delegation-targets"],
  },
  {
    name: "reordered delegation targets publish",
    next: {
      delegationTargets: [
        {
          name: "weft",
          description: "reviewer",
          triggers: [],
          isCategory: false,
        },
        {
          name: "shuttle",
          description: "worker",
          triggers: [],
          isCategory: false,
        },
      ],
    },
    expected: [],
  },
  {
    name: "trigger-only delegation-target edits publish",
    next: {
      delegationTargets: [
        {
          name: "shuttle",
          description: "worker",
          triggers: ["build it"],
          isCategory: false,
        },
        {
          name: "weft",
          description: "reviewer",
          triggers: [],
          isCategory: false,
        },
      ],
    },
    expected: [],
  },
  {
    name: "disabling a skill the primary renders is a prompt change",
    candidateDisabledSkills: ["tdd"],
    expected: ["prompt"],
  },
  {
    name: "disabling a skill the primary never requested publishes",
    candidateDisabledSkills: ["code-review"],
    expected: [],
  },
  {
    name: "re-enabling a previously disabled rendered skill is a prompt change",
    currentDisabledSkills: ["tdd"],
    expected: ["prompt"],
  },
  {
    name: "a skill absent from Pi's catalog renders identically and publishes",
    current: { skills: ["tdd", "nonexistent"] },
    next: { skills: ["tdd", "nonexistent"] },
    expected: [],
  },
  {
    name: "a removed primary is reported alone",
    candidate: candidateOf({ descriptors: catalogOf() }),
    expected: ["primary-missing"],
  },
  {
    name: "a disabled primary is reported alone",
    candidate: candidateOf({
      descriptors: catalogOf(),
      disabledAgents: [DEFAULT_PRIMARY_AGENT_NAME],
    }),
    expected: ["primary-disabled"],
  },
  {
    name: "a demoted primary is reported alone",
    candidate: candidateOf({
      descriptors: catalogOf(
        descriptor({ mode: "subagent", composedPrompt: "demoted" }),
      ),
    }),
    expected: ["primary-demoted"],
  },
  {
    name: "every simultaneous facet is reported in declaration order",
    current: { temperature: 0.2 },
    next: {
      composedPrompt: "Rewritten.",
      models: ["openai/gpt-5.6#low"],
      temperature: 0.9,
      fast: true,
      effectiveToolPolicy: { ...POLICY, write: "deny" },
      delegationTargets: [],
    },
    expected: [
      "prompt",
      "models",
      "thinking",
      "temperature",
      "fast",
      "tool-policy",
      "delegation-targets",
    ],
  },
];

describe("decidePiPrimaryContract facets", () => {
  for (const testCase of FACET_CASES) {
    it(testCase.name, () => {
      const current = descriptor(testCase.current);
      const candidate =
        testCase.candidate ??
        candidateOf({
          descriptors: catalogOf(
            descriptor({ ...testCase.current, ...testCase.next }),
          ),
          disabledSkills: testCase.candidateDisabledSkills ?? [],
        });

      const decision = decidePiPrimaryContract({
        primary: current,
        disabledSkills: testCase.currentDisabledSkills ?? [],
        candidate,
        skills: SKILLS,
      });

      expect(facets(decision)).toEqual(testCase.expected);
      expect(decision.decision).toBe(
        testCase.expected.length === 0 ? "publishable" : "primary-affecting",
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Rendered-output equality
// ---------------------------------------------------------------------------

describe("rendered-output equality", () => {
  it("publishes a single-line to multiline rewrite that renders identically", () => {
    // Both sources render the same composed text: the single-line source used
    // explicit \n escapes, the multiline `"""` source used real line breaks.
    const rendered = "Line one.\n\nLine two.";
    const current = descriptor({ composedPrompt: rendered });
    const next = descriptor({
      composedPrompt: ["Line one.", "", "Line two."].join("\n"),
    });

    expect(next.composedPrompt).toBe(current.composedPrompt);
    expect(
      decide({
        primary: current,
        candidate: candidateOf({ descriptors: catalogOf(next) }),
      }),
    ).toEqual({ decision: "publishable" });
  });

  it("flags a multiline rewrite whose rendered text gained trailing whitespace", () => {
    const current = descriptor({ composedPrompt: "Line one.\n\nLine two." });
    const next = descriptor({ composedPrompt: "Line one.\n\nLine two.\n" });

    expect(
      decide({
        primary: current,
        candidate: candidateOf({ descriptors: catalogOf(next) }),
      }),
    ).toEqual({
      decision: "primary-affecting",
      changedFacets: ["prompt"],
    });
  });

  it("compares exactly the block the harness receives", () => {
    const current = descriptor();
    const rendered = renderWeavePromptBlock(current, [
      { name: "tdd", skillInfo: { name: "tdd" } },
    ]);
    const next = descriptor({ composedPrompt: rendered });

    // The candidate's *composed* prompt is the current *rendered* block, which
    // is not the same harness-visible block once rendered again.
    expect(
      facets(
        decide({
          primary: current,
          candidate: candidateOf({ descriptors: catalogOf(next) }),
        }),
      ),
    ).toEqual(["prompt"]);
  });
});

// ---------------------------------------------------------------------------
// Eligibility with no committed primary
// ---------------------------------------------------------------------------

describe("no committed primary", () => {
  it("publishes when the default primary is present and eligible", () => {
    expect(decide({ primary: undefined })).toEqual({
      decision: "publishable",
    });
  });

  it("publishes even when the default primary's own facets differ", () => {
    expect(
      decide({
        primary: undefined,
        candidate: candidateOf({
          descriptors: catalogOf(
            descriptor({ composedPrompt: "rewritten", models: ["other"] }),
          ),
        }),
      }),
    ).toEqual({ decision: "publishable" });
  });

  it("flags a missing default-primary descriptor", () => {
    expect(
      decide({
        primary: undefined,
        candidate: candidateOf({ descriptors: catalogOf() }),
      }),
    ).toEqual({
      decision: "primary-affecting",
      changedFacets: ["primary-missing"],
    });
  });

  it("flags a disabled default primary", () => {
    expect(
      facets(
        decide({
          primary: undefined,
          candidate: candidateOf({
            descriptors: catalogOf(),
            disabledAgents: [DEFAULT_PRIMARY_AGENT_NAME],
          }),
        }),
      ),
    ).toEqual(["primary-disabled"]);
  });

  it("flags a demoted default primary", () => {
    expect(
      facets(
        decide({
          primary: undefined,
          candidate: candidateOf({
            descriptors: catalogOf(descriptor({ mode: "subagent" })),
          }),
        }),
      ),
    ).toEqual(["primary-demoted"]);
  });
});

// ---------------------------------------------------------------------------
// A non-default active primary
// ---------------------------------------------------------------------------

describe("non-default active primary", () => {
  const active = descriptor({ name: "tapestry", mode: "all" });

  it("compares the active primary's own name, not the default", () => {
    expect(
      decide({
        primary: active,
        candidate: candidateOf({
          descriptors: catalogOf(descriptor(), active),
        }),
      }),
    ).toEqual({ decision: "publishable" });
  });

  it("ignores changes to other agents", () => {
    expect(
      decide({
        primary: active,
        candidate: candidateOf({
          descriptors: catalogOf(
            descriptor({ composedPrompt: "loom rewritten", fast: true }),
            active,
          ),
        }),
      }),
    ).toEqual({ decision: "publishable" });
  });

  it("flags the active primary's removal even when the default survives", () => {
    expect(
      facets(
        decide({
          primary: active,
          candidate: candidateOf({ descriptors: catalogOf(descriptor()) }),
        }),
      ),
    ).toEqual(["primary-missing"]);
  });
});

// ---------------------------------------------------------------------------
// Result shape and purity
// ---------------------------------------------------------------------------

describe("result shape and purity", () => {
  it("returns only the decision and a closed facet enum", () => {
    const decision = decide({
      candidate: candidateOf({
        descriptors: catalogOf(descriptor({ composedPrompt: "secret text" })),
      }),
    });

    expect(Object.keys(decision).sort()).toEqual(["changedFacets", "decision"]);
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain("secret text");
    expect(serialized).not.toContain(DEFAULT_PRIMARY_AGENT_NAME);
    for (const facet of facets(decision)) {
      expect(PI_PRIMARY_CONTRACT_FACETS).toContain(facet);
    }
  });

  it("is synchronous and repeatable for the same inputs", () => {
    const input = {
      primary: descriptor(),
      disabledSkills: [] as readonly string[],
      candidate: candidateOf({
        descriptors: catalogOf(descriptor({ models: ["openai/gpt-5.6#high"] })),
      }),
      skills: SKILLS,
    };

    const first = decidePiPrimaryContract(input);
    const second = decidePiPrimaryContract(input);

    expect(first).not.toBeInstanceOf(Promise);
    expect(first).toEqual(second);
    expect(facets(first)).toEqual(["models"]);
  });

  it("fails closed on a skill port that throws", () => {
    const hostile: PiSkillResolutionPort = {
      resolveForAgent: () => {
        throw new Error("catalog exploded");
      },
    };

    expect(facets(decide({ skills: hostile }))).toEqual(["prompt"]);
  });

  it("does not mutate the descriptors it compares", () => {
    const current = descriptor();
    const next = descriptor({
      delegationTargets: [...descriptor().delegationTargets].reverse(),
    });
    const currentTargets = current.delegationTargets.map(
      (target) => target.name,
    );
    const nextTargets = next.delegationTargets.map((target) => target.name);

    decide({
      primary: current,
      candidate: candidateOf({ descriptors: catalogOf(next) }),
    });

    expect(current.delegationTargets.map((target) => target.name)).toEqual(
      currentTargets,
    );
    expect(next.delegationTargets.map((target) => target.name)).toEqual(
      nextTargets,
    );
  });
});

// ---------------------------------------------------------------------------
// Candidate derivation from an activation
// ---------------------------------------------------------------------------

function memoryFileReader(files: Record<string, string>): FileReader {
  return {
    exists: async (path) => path in files,
    read: (path) => {
      const content = files[path];
      if (content === undefined) {
        return errAsync({
          type: "FileReadError" as const,
          path,
          cause: new Error("not found"),
        });
      }
      return okAsync(content);
    },
  };
}

describe("toPiPrimaryContractCandidate", () => {
  const projectRoot = "/my/project";
  const projectConfig = `${projectRoot}/.weave/config.weave`;
  const configText = `
agent alpha {
  prompt "alpha"
  models ["m1"]
  mode subagent
}

agent beta {
  prompt "beta"
  models ["m1"]
  mode subagent
}

disable agents ["beta"]
disable skills ["tdd"]
`;

  it("reads the descriptors and both disabled lists from a candidate activation", async () => {
    const activator = new PiConfigActivator({
      fileReader: memoryFileReader({ [projectConfig]: configText }),
    });
    const activation = (
      await activator.activate({ projectRoot, trust: "trusted" })
    ).match(
      (value) => value,
      (failure) => {
        throw new Error(`activation failed: ${failure.code}`);
      },
    );

    const candidate = toPiPrimaryContractCandidate(activation);

    expect(candidate.descriptors).toBe(activation.descriptors.byName);
    expect(candidate.descriptors.has("alpha")).toBe(true);
    expect(candidate.descriptors.has("beta")).toBe(false);
    expect(candidate.disabledAgents).toContain("beta");
    expect(candidate.disabledSkills).toContain("tdd");
  });

  it("feeds the guard directly from an activation", async () => {
    const activator = new PiConfigActivator({
      fileReader: memoryFileReader({ [projectConfig]: configText }),
    });
    const activation = (
      await activator.activate({ projectRoot, trust: "trusted" })
    ).match(
      (value) => value,
      (failure) => {
        throw new Error(`activation failed: ${failure.code}`);
      },
    );

    const alpha = activation.descriptors.byName.get("alpha");
    expect(alpha).toBeDefined();
    if (alpha === undefined) return;

    // `alpha` is a subagent, so it can never serve as the active primary.
    expect(
      facets(
        decidePiPrimaryContract({
          primary: alpha,
          disabledSkills: [],
          candidate: toPiPrimaryContractCandidate(activation),
          skills: SKILLS,
        }),
      ),
    ).toEqual(["primary-demoted"]);

    // The disabled agent is reported as disabled, not merely missing.
    const beta = descriptor({ name: "beta" });
    expect(
      facets(
        decidePiPrimaryContract({
          primary: beta,
          disabledSkills: [],
          candidate: toPiPrimaryContractCandidate(activation),
          skills: SKILLS,
        }),
      ),
    ).toEqual(["primary-disabled"]);
  });
});
