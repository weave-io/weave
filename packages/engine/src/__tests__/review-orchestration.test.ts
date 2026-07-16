import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import { parseConfig } from "@weaveio/weave-core";
import type { ReviewExecutionResult } from "../review-orchestration.js";
import {
  collate,
  fanOut,
  ReviewOrchestrator,
} from "../review-orchestration.js";

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
    expect(variantNames).toContain("weft-openai-gpt-5");
    expect(variantNames).toContain("weft-anthropic-claude-opus-4");
    expect(variantNames).toHaveLength(2);
  });

  it("variant descriptors have mode=subagent, read-only policy, and single model", () => {
    const config = cfg(WEFT_CONFIG);
    const plan = new ReviewOrchestrator(config).fanOut("weft")._unsafeUnwrap();

    const variant = plan.variants["weft-openai-gpt-5"];
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
      agent weft-openai-gpt-5 {
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
      makeResult("weft-openai-gpt-5", "openai/gpt-5", true, "LGTM"),
      makeResult(
        "weft-anthropic-claude-opus-4",
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
      makeResult("weft-openai-gpt-5", "openai/gpt-5", true, "LGTM"),
      makeResult(
        "weft-anthropic-claude-opus-4",
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
      "weft-anthropic-claude-opus-4",
    );
    expect(collated.warnings[0].errorMessage).toBe("timeout");
    expect(collated.collatedOutput).toContain("LGTM");
  });

  it("fails with CollatedReviewAllFailedError when all variants fail", () => {
    const results = [
      makeResult(
        "weft-openai-gpt-5",
        "openai/gpt-5",
        false,
        undefined,
        "error A",
      ),
      makeResult(
        "weft-anthropic-claude-opus-4",
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
      makeResult("weft-openai-gpt-5", "openai/gpt-5", true, "ok"),
    ];
    const result = collate(results);
    expect(result.isOk()).toBe(true);
  });

  it("collated output includes headers for each successful variant", () => {
    const results = [
      makeResult("weft-openai-gpt-5", "openai/gpt-5", true, "Review output A"),
    ];
    const collated = ReviewOrchestrator.collate(results)._unsafeUnwrap();
    expect(collated.collatedOutput).toContain("weft-openai-gpt-5");
    expect(collated.collatedOutput).toContain("openai/gpt-5");
    expect(collated.collatedOutput).toContain("Review output A");
  });
});
