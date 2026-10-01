import { describe, expect, it } from "bun:test";
import {
  MAX_MODEL_RECOMMENDATIONS_BYTES,
  ModelRecommendationsEnvelopeSchema,
  type ModelRecommendationsFile,
  ModelRecommendationsFileSchema,
  selectRecommendationsSection,
} from "../model-recommendations.js";
import { ModelRecommendationsVerifier } from "../model-recommendations-verifier.js";

/** A list that passes every rule; each test below breaks one. */
function validList(): Record<string, unknown> {
  return {
    schema: 1,
    channel: "stable",
    issued: "2026-10-01T09:00:00Z",
    expires: "2026-12-30T09:00:00Z",
    min_config_version: "0.2.0",
    evidence: "https://tryweave.io/evals/runs/run-1",
    default: {
      agents: {
        shuttle: {
          models: ["claude-sonnet-5.5", "claude-sonnet-5-5", "gpt-6-sol"],
        },
      },
    },
    harnesses: {
      opencode2: {
        agents: {
          shuttle: {
            models: [
              "claude-sonnet-5.5",
              "openrouter/anthropic/claude-sonnet-5.5",
              "gpt-6-sol",
            ],
          },
        },
      },
      "claude-code": { agents: { shuttle: { models: ["sonnet"] } } },
      pi: { agents: { shuttle: { models: ["claude-sonnet-5-5"] } } },
    },
  };
}

function issuesFor(value: unknown): string[] {
  const parsed = ModelRecommendationsFileSchema.safeParse(value);
  if (parsed.success) return [];
  return parsed.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
}

function withAgents(count: number): Record<string, { models: string[] }> {
  const agents: Record<string, { models: string[] }> = {};
  for (let i = 0; i < count; i++) agents[`agent-${i}`] = { models: ["m"] };
  return agents;
}

describe("ModelRecommendationsFileSchema", () => {
  it("accepts a list that follows every rule", () => {
    expect(issuesFor(validList())).toEqual([]);
  });

  it("accepts a list with only the required fields", () => {
    const { min_config_version: _v, harnesses: _h, ...minimal } = validList();
    expect(issuesFor(minimal)).toEqual([]);
  });

  it.each([
    "0.2.0",
    "1.2.3-rc.1",
    "1.2.3+build.7",
    "1.2.3-0a.1+b",
  ])("accepts the semver min_config_version %s", (version) => {
    expect(issuesFor({ ...validList(), min_config_version: version })).toEqual(
      [],
    );
  });

  it.each([
    "1.2",
    "01.2.3",
    "1.2.3-01",
    "1.2.3-",
    "1.2.3+",
    "v1.2.3",
  ])("rejects the non-semver min_config_version %s", (version) => {
    expect(
      issuesFor({ ...validList(), min_config_version: version }).join("\n"),
    ).toContain("min_config_version");
  });

  it("accepts both channels", () => {
    expect(issuesFor({ ...validList(), channel: "next" })).toEqual([]);
  });

  it.each([
    ["schema 2", { schema: 2 }, "schema"],
    ["a string schema", { schema: "1" }, "schema"],
    ["an unknown channel", { channel: "beta" }, "channel"],
    ["a non-UTC issued", { issued: "2026-10-01T09:00:00+02:00" }, "issued"],
    ["a date-only issued", { issued: "2026-10-01" }, "issued"],
    ["a non-UTC expires", { expires: "2026-12-30" }, "expires"],
    ["expires before issued", { expires: "2026-09-30T09:00:00Z" }, "expires"],
    ["expires equal to issued", { expires: "2026-10-01T09:00:00Z" }, "expires"],
    [
      "expires more than 90 days after issued",
      { expires: "2026-12-30T09:00:01Z" },
      "expires",
    ],
    [
      "a non-semver min_config_version",
      { min_config_version: "1.2" },
      "min_config_version",
    ],
    [
      "an http evidence URL",
      { evidence: "http://tryweave.io/evals/runs/1" },
      "evidence",
    ],
    ["a non-URL evidence", { evidence: "see the eval run" }, "evidence"],
    [
      "an evidence URL over 256 characters",
      { evidence: `https://tryweave.io/${"a".repeat(240)}` },
      "evidence",
    ],
    ["an unknown top-level field", { prompts: {} }, ""],
    [
      "an unknown harness",
      { harnesses: { copilot: { agents: { loom: { models: ["x"] } } } } },
      "harnesses",
    ],
  ])("rejects %s", (_name, override, path) => {
    const issues = issuesFor({ ...validList(), ...override });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.startsWith(`${path}`))).toBe(true);
  });

  it.each([
    "schema",
    "channel",
    "issued",
    "expires",
    "evidence",
    "default",
  ])("rejects a list without %s", (field) => {
    const list = validList();
    delete list[field];
    expect(issuesFor(list).some((issue) => issue.startsWith(field))).toBe(true);
  });

  it("rejects an unknown field inside an agent entry", () => {
    const list = validList();
    list.default = {
      agents: { shuttle: { models: ["gpt-6-sol"], temperature: 0.1 } },
    };
    expect(issuesFor(list).join("\n")).toContain("default.agents.shuttle");
  });

  it("rejects an unknown field inside a section", () => {
    const list = validList();
    list.default = {
      agents: { shuttle: { models: ["gpt-6-sol"] } },
      categories: {},
    };
    expect(issuesFor(list).join("\n")).toContain("default");
  });

  it("rejects a section with no agents and one with more than 32", () => {
    expect(issuesFor({ ...validList(), default: { agents: {} } })).not.toEqual(
      [],
    );
    expect(
      issuesFor({ ...validList(), default: { agents: withAgents(33) } }),
    ).not.toEqual([]);
    expect(
      issuesFor({ ...validList(), default: { agents: withAgents(32) } }),
    ).toEqual([]);
  });

  it("rejects an agent with no models and one with more than 8", () => {
    const models = (n: number) => ({
      ...validList(),
      default: {
        agents: {
          shuttle: { models: Array.from({ length: n }, (_, i) => `m-${i}`) },
        },
      },
    });
    expect(issuesFor(models(0))).not.toEqual([]);
    expect(issuesFor(models(9))).not.toEqual([]);
    expect(issuesFor(models(8))).toEqual([]);
  });

  it.each([
    ["an empty entry", ""],
    ["an entry with whitespace", "gpt 6"],
    ["an entry over 128 characters", "m".repeat(129)],
  ])("rejects %s", (_name, entry) => {
    expect(
      issuesFor({
        ...validList(),
        default: { agents: { shuttle: { models: [entry] } } },
      }),
    ).not.toEqual([]);
  });

  it.each([
    "Shuttle",
    "shuttle\n",
    "1loom",
    "-loom",
  ])("rejects the agent name %j", (name) => {
    expect(
      issuesFor({
        ...validList(),
        default: { agents: { [name]: { models: ["gpt-6-sol"] } } },
      }),
    ).not.toEqual([]);
  });

  it("takes bare IDs in default and pi, and provider-qualified IDs only in opencode2", () => {
    const qualified = "github-copilot/gpt-6-sol";
    expect(
      issuesFor({
        ...validList(),
        default: { agents: { shuttle: { models: [qualified] } } },
      }).join("\n"),
    ).toContain("only the opencode2 section may name a provider");
    expect(
      issuesFor({
        ...validList(),
        harnesses: { pi: { agents: { shuttle: { models: [qualified] } } } },
      }),
    ).not.toEqual([]);
    expect(
      issuesFor({
        ...validList(),
        harnesses: {
          opencode2: { agents: { shuttle: { models: [qualified] } } },
        },
      }),
    ).toEqual([]);
  });

  it("limits claude-code entries to opus, sonnet and haiku", () => {
    for (const tier of ["opus", "sonnet", "haiku"]) {
      expect(
        issuesFor({
          ...validList(),
          harnesses: {
            "claude-code": { agents: { shuttle: { models: [tier] } } },
          },
        }),
      ).toEqual([]);
    }
    expect(
      issuesFor({
        ...validList(),
        harnesses: {
          "claude-code": {
            agents: { shuttle: { models: ["claude-sonnet-5-5"] } },
          },
        },
      }).join("\n"),
    ).toContain("claude-code entries must be opus, sonnet or haiku");
  });
});

describe("ModelRecommendationsEnvelopeSchema", () => {
  it("accepts exactly payload and sig", () => {
    expect(
      ModelRecommendationsEnvelopeSchema.safeParse({ payload: "{}", sig: "x" })
        .success,
    ).toBe(true);
  });

  it("rejects a missing sig and an extra field", () => {
    expect(
      ModelRecommendationsEnvelopeSchema.safeParse({ payload: "{}" }).success,
    ).toBe(false);
    expect(
      ModelRecommendationsEnvelopeSchema.safeParse({
        payload: "{}",
        sig: "x",
        key: "y",
      }).success,
    ).toBe(false);
  });
});

describe("the 64 KiB limit", () => {
  const verifier = new ModelRecommendationsVerifier({
    publicKeys: [],
    now: () => new Date("2026-10-02T00:00:00Z"),
  });

  it("rejects a list over 64 KiB before parsing it", () => {
    const text = JSON.stringify({
      ...validList(),
      padding: "x".repeat(MAX_MODEL_RECOMMENDATIONS_BYTES),
    });
    const result = verifier.parseList(text);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "TooLarge",
      limit: MAX_MODEL_RECOMMENDATIONS_BYTES,
    });
  });

  it("counts UTF-8 bytes, not characters", () => {
    const text = "é".repeat(MAX_MODEL_RECOMMENDATIONS_BYTES / 2 + 1);
    expect(verifier.parseList(text)._unsafeUnwrapErr().type).toBe("TooLarge");
  });

  it("applies to the envelope as served", () => {
    const text = JSON.stringify({
      payload: "x".repeat(MAX_MODEL_RECOMMENDATIONS_BYTES),
      sig: "",
    });
    expect(verifier.parseEnvelope(text)._unsafeUnwrapErr().type).toBe(
      "TooLarge",
    );
  });
});

describe("selectRecommendationsSection", () => {
  const file = ModelRecommendationsFileSchema.parse(
    validList(),
  ) as ModelRecommendationsFile;

  it("returns a harness's own section when the file has one", () => {
    const section = selectRecommendationsSection(file, "claude-code");
    expect(section?.source).toBe("claude-code");
    expect(section?.agents.shuttle?.models).toEqual(["sonnet"]);
  });

  it("falls back to default when the harness has no section", () => {
    const { harnesses: _h, ...rest } = validList();
    const withoutHarnesses = ModelRecommendationsFileSchema.parse(rest);
    const section = selectRecommendationsSection(withoutHarnesses, "pi");
    expect(section?.source).toBe("default");
    expect(section?.agents.shuttle?.models[0]).toBe("claude-sonnet-5.5");
  });

  it("gives a caller with no harness ID no section at all", () => {
    expect(selectRecommendationsSection(file, undefined)).toBeUndefined();
  });
});
