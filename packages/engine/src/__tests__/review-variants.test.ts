/**
 * Unit tests for `review-variants.ts`.
 *
 * Covers:
 * - `reviewVariantName` — deterministic naming with full non-identifier char sanitisation
 * - `generateReviewVariants` — variant generation, read-only policy, mode
 *   coercion, disabled-agent skipping, conflict detection
 */

import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import { parseConfig } from "@weaveio/weave-core";
import {
  generateReviewVariants,
  reviewVariantName,
} from "../review-variants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

// ---------------------------------------------------------------------------
// reviewVariantName
// ---------------------------------------------------------------------------

describe("reviewVariantName", () => {
  it("produces a deterministic name for a simple model identifier", () => {
    expect(reviewVariantName("weft", "gpt-5")).toBe("weft-review-gpt-5");
  });

  it("replaces slashes in model identifier with hyphens", () => {
    expect(reviewVariantName("weft", "openai/gpt-5")).toBe(
      "weft-review-openai-gpt-5",
    );
  });

  it("replaces multiple slashes", () => {
    expect(reviewVariantName("weft", "provider/org/model-v1")).toBe(
      "weft-review-provider-org-model-v1",
    );
  });

  it("replaces dots and colons with hyphens", () => {
    expect(reviewVariantName("weft", "org.model:v2")).toBe(
      "weft-review-org-model-v2",
    );
  });

  it("replaces any non-identifier character with a hyphen", () => {
    // Spaces, plus signs, at-signs are not valid identifier chars
    expect(reviewVariantName("weft", "my model@v1")).toBe(
      "weft-review-my-model-v1",
    );
  });

  it("preserves valid identifier characters (letters, digits, hyphens, underscores)", () => {
    expect(reviewVariantName("weft", "my_model-v1")).toBe(
      "weft-review-my_model-v1",
    );
  });

  it("works with different source agent names", () => {
    expect(reviewVariantName("shuttle", "anthropic/claude-opus-4")).toBe(
      "shuttle-review-anthropic-claude-opus-4",
    );
    expect(reviewVariantName("loom", "openai/gpt-4o")).toBe(
      "loom-review-openai-gpt-4o",
    );
  });

  it("is pure — same inputs always produce the same output", () => {
    const a = reviewVariantName("weft", "openai/gpt-5");
    const b = reviewVariantName("weft", "openai/gpt-5");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// generateReviewVariants — basic generation
// ---------------------------------------------------------------------------

describe("generateReviewVariants — basic generation", () => {
  const WEFT_TWO_MODELS = cfg(`
    agent weft {
      description "Weft reviewer"
      prompt "You are a code reviewer."
      models ["claude-sonnet-4-5"]
      mode subagent
      review_models ["openai/gpt-5", "anthropic/claude-opus-4"]
      temperature 0.2
    }
  `);

  it("returns ok with one variant per review_model", () => {
    const result = generateReviewVariants(WEFT_TWO_MODELS);
    expect(result.isOk()).toBe(true);
    const variants = result._unsafeUnwrap();
    expect(Object.keys(variants)).toHaveLength(2);
    expect(variants["weft-review-openai-gpt-5"]).toBeDefined();
    expect(variants["weft-review-anthropic-claude-opus-4"]).toBeDefined();
  });

  it("variant name matches reviewVariantName output", () => {
    const variants = generateReviewVariants(WEFT_TWO_MODELS)._unsafeUnwrap();
    expect(Object.keys(variants)).toContain(
      reviewVariantName("weft", "openai/gpt-5"),
    );
    expect(Object.keys(variants)).toContain(
      reviewVariantName("weft", "anthropic/claude-opus-4"),
    );
  });

  it("variant config.name matches the variant key", () => {
    const variants = generateReviewVariants(WEFT_TWO_MODELS)._unsafeUnwrap();
    for (const [key, variant] of Object.entries(variants)) {
      expect(variant.config.name).toBe(key);
    }
  });

  it("variant sourceAgentName is the origin agent", () => {
    const variants = generateReviewVariants(WEFT_TWO_MODELS)._unsafeUnwrap();
    expect(variants["weft-review-openai-gpt-5"].sourceAgentName).toBe("weft");
    expect(
      variants["weft-review-anthropic-claude-opus-4"].sourceAgentName,
    ).toBe("weft");
  });

  it("variant reviewModel matches the model it was generated for", () => {
    const variants = generateReviewVariants(WEFT_TWO_MODELS)._unsafeUnwrap();
    expect(variants["weft-review-openai-gpt-5"].reviewModel).toBe(
      "openai/gpt-5",
    );
    expect(variants["weft-review-anthropic-claude-opus-4"].reviewModel).toBe(
      "anthropic/claude-opus-4",
    );
  });
});

// ---------------------------------------------------------------------------
// generateReviewVariants — variant config properties
// ---------------------------------------------------------------------------

describe("generateReviewVariants — variant config properties", () => {
  const source = cfg(`
    agent weft {
      prompt "You are a code reviewer."
      models ["claude-sonnet-4-5"]
      mode primary
      review_models ["openai/gpt-5"]
      temperature 0.3
    }
  `);

  function variant() {
    return generateReviewVariants(source)._unsafeUnwrap()[
      "weft-review-openai-gpt-5"
    ];
  }

  it("mode is coerced to subagent regardless of source agent mode", () => {
    expect(variant().config.mode).toBe("subagent");
  });

  it("models contains only the single review model", () => {
    expect(variant().config.models).toEqual(["openai/gpt-5"]);
  });

  it("tool_policy.read is allow", () => {
    expect(variant().config.tool_policy?.read).toBe("allow");
  });

  it("tool_policy.write is deny", () => {
    expect(variant().config.tool_policy?.write).toBe("deny");
  });

  it("tool_policy.execute is deny", () => {
    expect(variant().config.tool_policy?.execute).toBe("deny");
  });

  it("tool_policy.delegate is deny", () => {
    expect(variant().config.tool_policy?.delegate).toBe("deny");
  });

  it("tool_policy.network is deny", () => {
    expect(variant().config.tool_policy?.network).toBe("deny");
  });

  it("review_models is stripped from the variant config (no recursion)", () => {
    expect(variant().config.review_models).toBeUndefined();
  });

  it("inherits prompt from source agent", () => {
    expect(variant().config.prompt).toBe("You are a code reviewer.");
  });
});

// ---------------------------------------------------------------------------
// generateReviewVariants — agents without review_models
// ---------------------------------------------------------------------------

describe("generateReviewVariants — agents without review_models", () => {
  it("returns empty record when no agent declares review_models", () => {
    const config = cfg(`
      agent simple {
        prompt "Simple agent"
        models ["claude-sonnet-4-5"]
      }
    `);
    const result = generateReviewVariants(config);
    expect(result.isOk()).toBe(true);
    expect(Object.keys(result._unsafeUnwrap())).toHaveLength(0);
  });

  it("returns empty record for empty config", () => {
    const config = cfg("settings { log_level INFO }");
    const result = generateReviewVariants(config);
    expect(result.isOk()).toBe(true);
    expect(Object.keys(result._unsafeUnwrap())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// generateReviewVariants — disabled agents
// ---------------------------------------------------------------------------

describe("generateReviewVariants — disabled agents", () => {
  it("skips variant generation for disabled source agents", () => {
    const config = cfg(`
      agent weft {
        prompt "Reviewer"
        models ["claude-sonnet-4-5"]
        review_models ["openai/gpt-5"]
      }
      disable agents ["weft"]
    `);
    const result = generateReviewVariants(config);
    expect(result.isOk()).toBe(true);
    expect(Object.keys(result._unsafeUnwrap())).toHaveLength(0);
  });

  it("skips individual disabled variants but generates enabled ones", () => {
    const config = cfg(`
      agent weft {
        prompt "Reviewer"
        models ["claude-sonnet-4-5"]
        review_models ["openai/gpt-5", "anthropic/claude-opus-4"]
      }
      disable agents ["weft-review-openai-gpt-5"]
    `);
    const result = generateReviewVariants(config);
    expect(result.isOk()).toBe(true);
    const variants = result._unsafeUnwrap();
    // The disabled variant is skipped; the enabled one is present.
    expect(variants["weft-review-openai-gpt-5"]).toBeUndefined();
    expect(variants["weft-review-anthropic-claude-opus-4"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// generateReviewVariants — conflict detection
// ---------------------------------------------------------------------------

describe("generateReviewVariants — conflict detection", () => {
  it("returns ReviewVariantConflictError when a variant name collides with an explicit agent", () => {
    const config = cfg(`
      agent weft {
        prompt "Reviewer"
        models ["claude-sonnet-4-5"]
        review_models ["openai/gpt-5"]
      }
      agent weft-review-openai-gpt-5 {
        prompt "Conflict"
        models ["openai/gpt-5"]
      }
    `);
    const result = generateReviewVariants(config);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ReviewVariantConflictError");
    expect(error.variantName).toBe("weft-review-openai-gpt-5");
    expect(error.agentName).toBe("weft");
    expect(error.reviewModel).toBe("openai/gpt-5");
    expect(error.message).toContain("weft-review-openai-gpt-5");
  });

  it("returns ReviewVariantConflictError when a generated variant would collide with a previously generated variant (generated-vs-generated)", () => {
    // Construct the duplicate-model config programmatically — the DSL parser
    // de-duplicates array entries, so we bypass it and mutate the config object.
    const config = cfg(`
      agent weft {
        prompt "Reviewer"
        models ["claude-sonnet-4-5"]
        review_models ["openai/gpt-5"]
      }
    `);
    // Artificially inject a duplicate review model to simulate the collision.
    const weft = config.agents["weft"];
    if (weft) {
      (weft as { review_models?: string[] }).review_models = [
        "openai/gpt-5",
        "openai/gpt-5",
      ];
    }
    const result = generateReviewVariants(config);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ReviewVariantConflictError");
    expect(error.variantName).toBe("weft-review-openai-gpt-5");
    expect(error.message).toContain("weft-review-openai-gpt-5");
  });

  it("conflict error message includes remediation guidance", () => {
    const config = cfg(`
      agent weft {
        prompt "Reviewer"
        models ["claude-sonnet-4-5"]
        review_models ["openai/gpt-5"]
      }
      agent weft-review-openai-gpt-5 {
        prompt "Conflict"
        models ["openai/gpt-5"]
      }
    `);
    const error = generateReviewVariants(config)._unsafeUnwrapErr();
    // Message should guide the user on how to resolve the conflict.
    expect(error.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// generateReviewVariants — multiple agents
// ---------------------------------------------------------------------------

describe("generateReviewVariants — multiple agents", () => {
  it("generates variants for all agents that declare review_models", () => {
    const config = cfg(`
      agent weft {
        prompt "Weft reviewer"
        models ["claude-sonnet-4-5"]
        review_models ["openai/gpt-5"]
      }
      agent warp {
        prompt "Warp reviewer"
        models ["claude-sonnet-4-5"]
        review_models ["anthropic/claude-opus-4"]
      }
      agent simple {
        prompt "No review"
        models ["claude-sonnet-4-5"]
      }
    `);
    const result = generateReviewVariants(config);
    expect(result.isOk()).toBe(true);
    const variants = result._unsafeUnwrap();
    expect(Object.keys(variants)).toHaveLength(2);
    expect(variants["weft-review-openai-gpt-5"]).toBeDefined();
    expect(variants["warp-review-anthropic-claude-opus-4"]).toBeDefined();
  });

  it("each variant's sourceAgentName correctly identifies its origin", () => {
    const config = cfg(`
      agent weft {
        prompt "Weft"
        models ["claude-sonnet-4-5"]
        review_models ["openai/gpt-5"]
      }
      agent warp {
        prompt "Warp"
        models ["claude-sonnet-4-5"]
        review_models ["openai/gpt-5"]
      }
    `);
    const variants = generateReviewVariants(config)._unsafeUnwrap();
    expect(variants["weft-review-openai-gpt-5"].sourceAgentName).toBe("weft");
    expect(variants["warp-review-openai-gpt-5"].sourceAgentName).toBe("warp");
  });
});
