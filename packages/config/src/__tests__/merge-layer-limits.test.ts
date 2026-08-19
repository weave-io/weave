import { describe, expect, it } from "bun:test";
import type { WeaveConfig, WorkflowConfig } from "@weaveio/weave-core";
import {
  MAX_CONFIG_ERROR_FIELD_LENGTH,
  MAX_CONFIG_ERROR_ISSUES,
  MAX_CONFIG_ERROR_PATH_LENGTH,
  parseConfig,
  WeaveConfigSchema,
  WorkflowConfigSchema,
} from "@weaveio/weave-core";
import { mergeConfigsResult, mergeWorkflow } from "../merge.js";
import { MAX_CONFIG_LAYERS } from "../merge-layer.js";

function cfg(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const emptyConfig = cfg("");

function schemaWorkflow(input: WorkflowConfig): WorkflowConfig {
  const parsed = WorkflowConfigSchema.safeParse(input);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.data;
}

function maximalArtifactList(prefix: string): Array<{
  name: string;
  description: string;
}> {
  return Array.from({ length: 512 }, (_, index) => ({
    name: `${prefix}-name-${index}`,
    description: `${prefix}-description-${index}`,
  }));
}

function twoStepMaximalWorkflow(): WorkflowConfig {
  return schemaWorkflow({
    version: 1,
    steps: Array.from({ length: 2 }, (_, index) => ({
      name: `step-${index}`,
      type: "autonomous" as const,
      agent: "helper",
      prompt: "run",
      completion: { method: "agent_signal" as const },
      inputs: maximalArtifactList(`step-${index}-input`),
      outputs: maximalArtifactList(`step-${index}-output`),
    })),
  });
}

function fiveHundredTwelveStepWorkflow(): WorkflowConfig {
  return schemaWorkflow({
    version: 1,
    steps: Array.from({ length: 512 }, (_, index) => ({
      name: `step-${index}`,
      type: "autonomous" as const,
      agent: "helper",
      prompt: "run",
      completion: { method: "agent_signal" as const },
    })),
  });
}

describe("mergeConfigsResult — layer limits", () => {
  it("accepts exactly 128 config layers", () => {
    const layers = Array.from({ length: MAX_CONFIG_LAYERS }, () => emptyConfig);
    const result = mergeConfigsResult(...layers);

    expect(MAX_CONFIG_LAYERS).toBe(128);
    expect(result.isOk()).toBe(true);
  });

  it("rejects 129 config layers with a bounded typed error", () => {
    const layers = Array.from(
      { length: MAX_CONFIG_LAYERS + 1 },
      () => emptyConfig,
    );
    const result = mergeConfigsResult(...layers);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual([
        {
          type: "ConfigValidationError",
          errors: [
            {
              path: "config",
              message: "config layer count exceeds maximum of 128",
            },
          ],
        },
      ]);
      const validation = result.error[0];
      if (validation?.type === "ConfigValidationError") {
        expect(validation.errors.length).toBeLessThanOrEqual(
          MAX_CONFIG_ERROR_ISSUES,
        );
        for (const issue of validation.errors) {
          expect(issue.path.length).toBeLessThanOrEqual(
            MAX_CONFIG_ERROR_PATH_LENGTH,
          );
          expect(issue.message.length).toBeLessThanOrEqual(
            MAX_CONFIG_ERROR_FIELD_LENGTH,
          );
        }
      }
    }
  });

  it("rejects a cross-layer list union that exceeds the authoritative bound", () => {
    const base: WeaveConfig = {
      ...emptyConfig,
      disabled: {
        ...emptyConfig.disabled,
        agents: Array.from({ length: 512 }, (_, index) => `base-${index}`),
      },
    };
    const override: WeaveConfig = {
      ...emptyConfig,
      disabled: {
        ...emptyConfig.disabled,
        agents: Array.from({ length: 512 }, (_, index) => `override-${index}`),
      },
    };

    const result = mergeConfigsResult(base, override);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      const validation = result.error[0];
      expect(validation?.type).toBe("ConfigValidationError");
      if (validation?.type !== "ConfigValidationError") return;
      expect(validation.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "disabled.agents" }),
        ]),
      );
    }
  });

  it("accepts the public maximum artifact lists at both merge seams", () => {
    const workflow = twoStepMaximalWorkflow();
    const config = WeaveConfigSchema.safeParse({
      workflows: { maximal: workflow },
    });
    expect(config.success).toBe(true);
    if (!config.success) return;

    const layerResult = mergeConfigsResult(config.data);
    expect(layerResult.isOk()).toBe(true);
    if (layerResult.isErr()) return;
    expect(layerResult.value.workflows.maximal?.steps).toHaveLength(2);
    expect(layerResult.value.workflows.maximal?.steps[0]?.inputs).toHaveLength(
      512,
    );
    expect(layerResult.value.workflows.maximal?.steps[0]?.outputs).toHaveLength(
      512,
    );

    const workflowResult = mergeWorkflow("maximal", workflow, workflow, {
      maximal: workflow,
    });
    expect(workflowResult.isOk()).toBe(true);
    if (workflowResult.isErr()) return;
    expect(workflowResult.value.steps).toHaveLength(2);
    expect(workflowResult.value.steps[1]?.inputs).toHaveLength(512);
    expect(workflowResult.value.steps[1]?.outputs).toHaveLength(512);
  });

  it("copies a schema-valid 512-step workflow through the merge layer", () => {
    const workflow = fiveHundredTwelveStepWorkflow();
    const config = WeaveConfigSchema.safeParse({
      workflows: { ordinary: workflow },
    });
    expect(config.success).toBe(true);
    if (!config.success) return;

    const result = mergeConfigsResult(config.data);

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(result.value.workflows.ordinary?.steps).toHaveLength(512);
  });

  it("returns only schema-valid output while preserving precedence and omission", () => {
    const base = cfg(
      `extend before-plan ["base-step"] agent helper { prompt "base" models ["base-model"] skills ["base-skill"] }`,
    );
    const override = cfg(`agent helper { models ["override-model"] }`);

    const result = mergeConfigsResult(base, override);

    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    expect(WeaveConfigSchema.safeParse(result.value).success).toBe(true);
    expect(result.value.agents.helper?.models).toEqual([
      "override-model",
      "base-model",
    ]);
    expect(result.value.agents.helper?.skills).toEqual(["base-skill"]);
    expect(result.value.agents.helper?.prompt).toBe("base");
  });
});
