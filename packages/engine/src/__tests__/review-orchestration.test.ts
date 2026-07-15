import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import { parseConfig } from "@weaveio/weave-core";
import { errAsync, okAsync } from "neverthrow";
import type {
  HarnessAdapter,
  ReviewFanOutAdapterError,
  ReviewVariantDescriptor,
} from "../adapter.js";
import type { AgentDescriptor } from "../compose.js";
import type { ReviewExecutionResult } from "../review-orchestration.js";
import {
  collate,
  fanOut,
  ReviewOrchestrator,
} from "../review-orchestration.js";
import type { SkillInfo } from "../skill-resolution.js";

function cfg(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const WEFT_CONFIG = `
  agent weft {
    description "Weft reviewer"
    prompt "You are a code reviewer."
    models ["claude-sonnet-4-5"]
    mode subagent
    review_models ["openai/gpt-5", "anthropic/claude-opus-4"]
  }
`;

describe("ReviewOrchestrator.fanOut", () => {
  it("returns primary + all variant descriptors for an agent with review_models", () => {
    const config = cfg(WEFT_CONFIG);
    const result = new ReviewOrchestrator(config).fanOut("weft");
    expect(result.isOk()).toBe(true);
    const plan = result._unsafeUnwrap();

    expect(plan.agentName).toBe("weft");
    expect(plan.primary.name).toBe("weft");
    expect(plan.primary.config).toBeDefined();
    expect(plan.primary.config.models).toEqual(["claude-sonnet-4-5"]);
    expect(plan.primary.reviewModel).toBeNull();

    const variantNames = Object.keys(plan.variants);
    expect(variantNames).toContain("weft-review-openai-gpt-5");
    expect(variantNames).toContain("weft-review-anthropic-claude-opus-4");
    expect(variantNames).toHaveLength(2);
  });

  it("variant descriptors have mode=subagent, read-only policy, and single model", () => {
    const config = cfg(WEFT_CONFIG);
    const plan = new ReviewOrchestrator(config).fanOut("weft")._unsafeUnwrap();

    const variant = plan.variants["weft-review-openai-gpt-5"];
    expect(variant).toBeDefined();
    expect(variant.config.mode).toBe("subagent");
    expect(variant.config.models).toEqual(["openai/gpt-5"]);
    expect(variant.config.tool_policy?.read).toBe("allow");
    expect(variant.config.tool_policy?.write).toBe("deny");
    expect(variant.config.review_models).toBeUndefined();
  });

  it("returns ReviewOrchestrationAgentNotFoundError for unknown agent", () => {
    const config = cfg(WEFT_CONFIG);
    const result = new ReviewOrchestrator(config).fanOut("nonexistent");
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ReviewOrchestrationAgentNotFoundError");
  });

  it("returns ReviewVariantConflictError when a variant name collides with an explicit agent", () => {
    const source = `
      agent weft {
        prompt "Reviewer"
        models ["claude-sonnet-4-5"]
        review_models ["openai/gpt-5"]
      }
      agent weft-review-openai-gpt-5 {
        prompt "Conflict"
        models ["openai/gpt-5"]
      }
    `;
    const config = cfg(source);
    const result = new ReviewOrchestrator(config).fanOut("weft");
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("ReviewVariantConflictError");
  });

  it("fanOut() convenience function works identically", () => {
    const config = cfg(WEFT_CONFIG);
    const result = fanOut("weft", config);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().agentName).toBe("weft");
  });

  it("returns empty variants for an agent without review_models", () => {
    const source = `
      agent simple {
        prompt "Simple agent"
        models ["claude-sonnet-4-5"]
      }
    `;
    const config = cfg(source);
    const plan = new ReviewOrchestrator(config)
      .fanOut("simple")
      ._unsafeUnwrap();
    expect(Object.keys(plan.variants)).toHaveLength(0);
  });
});

describe("ReviewOrchestrator.collate", () => {

  function makeResult(
    variantName: string,
    reviewModel: string,
    success: boolean,
    output?: string,
    errorMessage?: string,
  ): ReviewExecutionResult {
    return { variantName, reviewModel, success, output, errorMessage };
  }

  it("succeeds when all variants succeed, no warnings", () => {
    const results = [
      makeResult("weft-review-openai-gpt-5", "openai/gpt-5", true, "LGTM"),
      makeResult(
        "weft-review-anthropic-claude-opus-4",
        "anthropic/claude-opus-4",
        true,
        "Looks good",
      ),
    ];
    const result = ReviewOrchestrator.collate(results);
    expect(result.isOk()).toBe(true);
    const collated = result._unsafeUnwrap();
    expect(collated.success).toBe(true);
    expect(collated.warnings).toHaveLength(0);
    expect(collated.collatedOutput).toContain("LGTM");
    expect(collated.collatedOutput).toContain("Looks good");
  });

  it("succeeds with warnings when some variants fail (partial failure)", () => {
    const results = [
      makeResult("weft-review-openai-gpt-5", "openai/gpt-5", true, "LGTM"),
      makeResult(
        "weft-review-anthropic-claude-opus-4",
        "anthropic/claude-opus-4",
        false,
        undefined,
        "timeout",
      ),
    ];
    const result = ReviewOrchestrator.collate(results);
    expect(result.isOk()).toBe(true);
    const collated = result._unsafeUnwrap();
    expect(collated.success).toBe(true);
    expect(collated.warnings).toHaveLength(1);
    expect(collated.warnings[0].variantName).toBe(
      "weft-review-anthropic-claude-opus-4",
    );
    expect(collated.warnings[0].errorMessage).toBe("timeout");
    expect(collated.collatedOutput).toContain("LGTM");
  });

  it("fails with CollatedReviewAllFailedError when all variants fail", () => {
    const results = [
      makeResult(
        "weft-review-openai-gpt-5",
        "openai/gpt-5",
        false,
        undefined,
        "error A",
      ),
      makeResult(
        "weft-review-anthropic-claude-opus-4",
        "anthropic/claude-opus-4",
        false,
        undefined,
        "error B",
      ),
    ];
    const result = ReviewOrchestrator.collate(results);
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe("CollatedReviewAllFailedError");
    if (error.type === "CollatedReviewAllFailedError") {
      expect(error.failures).toHaveLength(2);
    }
  });

  it("collate() convenience function works", () => {
    const results = [
      makeResult("weft-review-openai-gpt-5", "openai/gpt-5", true, "ok"),
    ];
    const result = collate(results);
    expect(result.isOk()).toBe(true);
  });

  it("collated output includes headers for each successful variant", () => {
    const results = [
      makeResult(
        "weft-review-openai-gpt-5",
        "openai/gpt-5",
        true,
        "Review output A",
      ),
    ];
    const collated = ReviewOrchestrator.collate(results)._unsafeUnwrap();
    expect(collated.collatedOutput).toContain("weft-review-openai-gpt-5");
    expect(collated.collatedOutput).toContain("openai/gpt-5");
    expect(collated.collatedOutput).toContain("Review output A");
  });
});

// ---------------------------------------------------------------------------
// Mock adapter — spawnReviewVariants interface contract
// ---------------------------------------------------------------------------

/**
 * A mock adapter that supports the optional `spawnReviewVariants` method.
 *
 * Verifies the adapter boundary without a real harness: the engine expresses
 * fan-out intent via `ReviewFanOutIntent`; adapters implement
 * `spawnReviewVariants` to execute variants and return results; the engine
 * then calls `ReviewOrchestrator.collate` on those results.
 */
class MockReviewAdapter implements HarnessAdapter {
  readonly spawnCalls: ReviewVariantDescriptor[][] = [];

  private readonly _results: ReviewExecutionResult[] | ReviewFanOutAdapterError;

  constructor(
    results: ReviewExecutionResult[] | ReviewFanOutAdapterError = [],
  ) {
    this._results = results;
  }

  async init(): Promise<void> {}
  spawnSubagent(_descriptor: AgentDescriptor) {
    return okAsync<void, Error>(undefined);
  }
  async loadAvailableSkills(): Promise<SkillInfo[]> {
    return [];
  }

  spawnReviewVariants(variants: ReviewVariantDescriptor[]) {
    this.spawnCalls.push(variants);
    if (!Array.isArray(this._results)) {
      return errAsync(this._results);
    }
    return okAsync(this._results);
  }
}

describe("HarnessAdapter.spawnReviewVariants — mock adapter contract", () => {
  const WEFT_CONFIG_SRC = `
    agent weft {
      description "Weft reviewer"
      prompt "You are a code reviewer."
      models ["claude-sonnet-4-5"]
      mode subagent
      review_models ["openai/gpt-5", "anthropic/claude-opus-4"]
    }
  `;

  it("adapter receives one descriptor per review variant", async () => {
    const successResults: ReviewExecutionResult[] = [
      {
        variantName: "weft-review-openai-gpt-5",
        reviewModel: "openai/gpt-5",
        success: true,
        output: "LGTM",
      },
      {
        variantName: "weft-review-anthropic-claude-opus-4",
        reviewModel: "anthropic/claude-opus-4",
        success: true,
        output: "Looks good",
      },
    ];
    const adapter = new MockReviewAdapter(successResults);

    // Simulate adapter workflow: get fan-out plan, build descriptors, spawn
    const config = cfg(WEFT_CONFIG_SRC);
    const plan = fanOut("weft", config)._unsafeUnwrap();

    const descriptors: ReviewVariantDescriptor[] = Object.entries(
      plan.variants,
    ).map(([, v]) => ({
      variantName: v.config.name ?? "",
      descriptor: { name: v.config.name ?? "", ...v.config } as AgentDescriptor,
      reviewModel: v.reviewModel,
    }));

    const spawnResult = await adapter.spawnReviewVariants!(descriptors);
    expect(spawnResult.isOk()).toBe(true);
    expect(adapter.spawnCalls).toHaveLength(1);
    expect(adapter.spawnCalls[0]).toHaveLength(2);
  });

  it("adapter results flow through collate to produce CollatedReview", async () => {
    const successResults: ReviewExecutionResult[] = [
      {
        variantName: "weft-review-openai-gpt-5",
        reviewModel: "openai/gpt-5",
        success: true,
        output: "LGTM",
      },
      {
        variantName: "weft-review-anthropic-claude-opus-4",
        reviewModel: "anthropic/claude-opus-4",
        success: true,
        output: "Looks good",
      },
    ];
    const adapter = new MockReviewAdapter(successResults);

    const config = cfg(WEFT_CONFIG_SRC);
    const plan = fanOut("weft", config)._unsafeUnwrap();

    const descriptors: ReviewVariantDescriptor[] = Object.entries(
      plan.variants,
    ).map(([, v]) => ({
      variantName: v.config.name ?? "",
      descriptor: { name: v.config.name ?? "", ...v.config } as AgentDescriptor,
      reviewModel: v.reviewModel,
    }));

    const spawnResult = await adapter.spawnReviewVariants!(descriptors);
    const results = spawnResult._unsafeUnwrap();

    const collated = ReviewOrchestrator.collate(results)._unsafeUnwrap();
    expect(collated.success).toBe(true);
    expect(collated.warnings).toHaveLength(0);
    expect(collated.collatedOutput).toContain("LGTM");
    expect(collated.collatedOutput).toContain("Looks good");
  });

  it("adapter partial failure is preserved through collate as a warning", async () => {
    const partialResults: ReviewExecutionResult[] = [
      {
        variantName: "weft-review-openai-gpt-5",
        reviewModel: "openai/gpt-5",
        success: true,
        output: "LGTM",
      },
      {
        variantName: "weft-review-anthropic-claude-opus-4",
        reviewModel: "anthropic/claude-opus-4",
        success: false,
        errorMessage: "model timeout",
      },
    ];
    const adapter = new MockReviewAdapter(partialResults);

    const config = cfg(WEFT_CONFIG_SRC);
    const descriptors: ReviewVariantDescriptor[] = [
      {
        variantName: "weft-review-openai-gpt-5",
        descriptor: {} as AgentDescriptor,
        reviewModel: "openai/gpt-5",
      },
      {
        variantName: "weft-review-anthropic-claude-opus-4",
        descriptor: {} as AgentDescriptor,
        reviewModel: "anthropic/claude-opus-4",
      },
    ];

    const spawnResult = await adapter.spawnReviewVariants!(descriptors);
    const results = spawnResult._unsafeUnwrap();
    const collated = ReviewOrchestrator.collate(results)._unsafeUnwrap();

    expect(collated.success).toBe(true);
    expect(collated.warnings).toHaveLength(1);
    expect(collated.warnings[0].errorMessage).toBe("model timeout");
  });

  it("adapter infrastructure error returns err(ReviewFanOutAdapterError)", async () => {
    const fatalError: ReviewFanOutAdapterError = {
      type: "ReviewFanOutUnsupportedError",
      message: "parallel review not supported in this harness",
    };
    const adapter = new MockReviewAdapter(fatalError);

    const spawnResult = await adapter.spawnReviewVariants!([]);
    expect(spawnResult.isErr()).toBe(true);
    const error = spawnResult._unsafeUnwrapErr();
    expect(error.type).toBe("ReviewFanOutUnsupportedError");
  });

  it("spawnReviewVariants is optional — adapter without it still satisfies HarnessAdapter", () => {
    // An adapter that omits spawnReviewVariants is valid.
    const minimalAdapter: HarnessAdapter = {
      async init() {},
      spawnSubagent() {
        return okAsync<void, Error>(undefined);
      },
      async loadAvailableSkills() {
        return [];
      },
      // No spawnReviewVariants
    };

    expect(minimalAdapter.spawnReviewVariants).toBeUndefined();
  });

  it("callers should check for spawnReviewVariants presence before invoking", async () => {
    // Demonstrates the recommended guard pattern.
    const adapter: HarnessAdapter = {
      async init() {},
      spawnSubagent() {
        return okAsync<void, Error>(undefined);
      },
      async loadAvailableSkills() {
        return [];
      },
    };

    let wasInvoked = false;
    if (adapter.spawnReviewVariants) {
      wasInvoked = true;
      await adapter.spawnReviewVariants([]);
    }
    expect(wasInvoked).toBe(false);
  });
});
