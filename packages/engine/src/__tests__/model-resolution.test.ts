import { describe, expect, it } from "bun:test";
import {
  DEFAULT_FALLBACK_MODEL,
  resolveAdapterModelIntent,
} from "../model-resolution.js";

describe("resolveAdapterModelIntent", () => {
  describe("priority 1: override", () => {
    it("(a) overrideModel wins over all other inputs", () => {
      const result = resolveAdapterModelIntent({
        agentName: "loom",
        agentMode: "primary",
        agentModels: ["agent-model"],
        categoryModels: ["category-model"],
        overrideModel: "override-model",
        uiSelectedModel: "ui-model",
        systemDefault: "system-model",
      });

      expect(result).toEqual({ model: "override-model", source: "override" });
    });

    it("(b) overrideModel wins even when uiSelectedModel is also provided", () => {
      const result = resolveAdapterModelIntent({
        agentName: "loom",
        overrideModel: "override-model",
        uiSelectedModel: "ui-model",
      });

      expect(result).toEqual({ model: "override-model", source: "override" });
    });
  });

  describe("priority 2: ui-selected model", () => {
    it("(a) uiSelectedModel used when mode is primary", () => {
      const result = resolveAdapterModelIntent({
        agentName: "loom",
        agentMode: "primary",
        agentModels: ["agent-model"],
        uiSelectedModel: "ui-model",
      });

      expect(result).toEqual({ model: "ui-model", source: "ui-selected" });
    });

    it("(b) uiSelectedModel used when mode is all", () => {
      const result = resolveAdapterModelIntent({
        agentName: "shuttle",
        agentMode: "all",
        agentModels: ["agent-model"],
        uiSelectedModel: "ui-model",
      });

      expect(result).toEqual({ model: "ui-model", source: "ui-selected" });
    });

    it("(c) uiSelectedModel used when mode is undefined", () => {
      const result = resolveAdapterModelIntent({
        agentName: "legacy-agent",
        agentModels: ["agent-model"],
        uiSelectedModel: "ui-model",
      });

      expect(result).toEqual({ model: "ui-model", source: "ui-selected" });
    });

    it("(d) uiSelectedModel is SKIPPED when mode is subagent — falls to next priority", () => {
      const result = resolveAdapterModelIntent({
        agentName: "thread",
        agentMode: "subagent",
        agentModels: ["agent-model"],
        uiSelectedModel: "ui-model",
      });

      expect(result).toEqual({
        model: "agent-model",
        source: "agent-preference",
      });
    });
  });

  describe("priority 3: category preference", () => {
    it("(a) first categoryModels entry is returned when available", () => {
      const result = resolveAdapterModelIntent({
        agentName: "shuttle-frontend",
        categoryModels: ["category-model", "category-backup"],
        agentModels: ["agent-model"],
      });

      expect(result).toEqual({
        model: "category-model",
        source: "category-preference",
      });
    });

    it("(b) second categoryModels entry used when first is unavailable", () => {
      const result = resolveAdapterModelIntent({
        agentName: "shuttle-frontend",
        categoryModels: ["missing-model", "category-backup"],
        agentModels: ["agent-model"],
        availableModels: new Set(["category-backup", "agent-model"]),
      });

      expect(result).toEqual({
        model: "category-backup",
        source: "category-preference",
      });
    });

    it("(c) category preference skipped when mode is subagent and no uiSelectedModel — falls to category then agent", () => {
      const result = resolveAdapterModelIntent({
        agentName: "shuttle-backend",
        agentMode: "subagent",
        categoryModels: ["category-model"],
        agentModels: ["agent-model"],
      });

      expect(result).toEqual({
        model: "category-model",
        source: "category-preference",
      });
    });
  });

  describe("priority 4: agent preference", () => {
    it("(a) first agentModels entry returned when no higher priority matches", () => {
      const result = resolveAdapterModelIntent({
        agentName: "warp",
        agentModels: ["agent-model", "agent-backup"],
      });

      expect(result).toEqual({
        model: "agent-model",
        source: "agent-preference",
      });
    });

    it("(b) second agentModels entry used when first is unavailable", () => {
      const result = resolveAdapterModelIntent({
        agentName: "warp",
        agentModels: ["missing-model", "agent-backup"],
        availableModels: new Set(["agent-backup"]),
      });

      expect(result).toEqual({
        model: "agent-backup",
        source: "agent-preference",
      });
    });
  });

  describe("priority 5: system default", () => {
    it("(a) systemDefault returned when all preferences are absent", () => {
      const result = resolveAdapterModelIntent({
        agentName: "loom",
        systemDefault: "system-model",
      });

      expect(result).toEqual({
        model: "system-model",
        source: "system-default",
      });
    });
  });

  describe("priority 6: constant fallback", () => {
    it("(a) DEFAULT_FALLBACK_MODEL returned when nothing else is provided", () => {
      const result = resolveAdapterModelIntent({ agentName: "loom" });

      expect(result).toEqual({
        model: DEFAULT_FALLBACK_MODEL,
        source: "constant-fallback",
      });
    });

    it("(b) returned model equals DEFAULT_FALLBACK_MODEL constant value", () => {
      const result = resolveAdapterModelIntent({ agentName: "loom" });

      expect(result.model).toBe("claude-sonnet-4-5");
      expect(result.model).toBe(DEFAULT_FALLBACK_MODEL);
    });
  });

  describe("review variant semantics", () => {
    it("(a) single-model review variant resolves to exact review model via agent-preference", () => {
      // Simulates a variant generated by generateReviewVariants():
      //   mode: "subagent", models: [reviewModel], no categoryModels
      const result = resolveAdapterModelIntent({
        agentName: "shuttle-review-o3",
        agentMode: "subagent",
        agentModels: ["openai/o3"],
        uiSelectedModel: "claude-sonnet-4-5", // ignored for subagents
      });

      expect(result).toEqual({
        model: "openai/o3",
        source: "agent-preference",
      });
    });

    it("(b) review variant is unaffected by ui-selected model — subagent mode bypasses ui-selected", () => {
      const result = resolveAdapterModelIntent({
        agentName: "shuttle-review-gpt4o",
        agentMode: "subagent",
        agentModels: ["openai/gpt-4o"],
        uiSelectedModel: "some-other-model",
        systemDefault: "fallback-model",
      });

      expect(result.model).toBe("openai/gpt-4o");
      expect(result.source).toBe("agent-preference");
    });

    it("(c) review variant respects availability — falls to system default if model unavailable", () => {
      const result = resolveAdapterModelIntent({
        agentName: "shuttle-review-o3",
        agentMode: "subagent",
        agentModels: ["openai/o3"],
        systemDefault: "claude-sonnet-4-5",
        availableModels: new Set(["claude-sonnet-4-5"]), // o3 not available
      });

      expect(result).toEqual({
        model: "claude-sonnet-4-5",
        source: "system-default",
      });
    });
  });

  describe("availability filtering", () => {
    it("(a) empty availableModels set means no model passes — falls to systemDefault", () => {
      const result = resolveAdapterModelIntent({
        agentName: "shuttle-frontend",
        categoryModels: ["category-model"],
        agentModels: ["agent-model"],
        systemDefault: "system-model",
        availableModels: new Set(),
      });

      expect(result).toEqual({
        model: "system-model",
        source: "system-default",
      });
    });

    it("(b) unavailable category model skipped; available agent model returned", () => {
      const result = resolveAdapterModelIntent({
        agentName: "shuttle-frontend",
        categoryModels: ["missing-category-model"],
        agentModels: ["agent-model"],
        availableModels: new Set(["agent-model"]),
      });

      expect(result).toEqual({
        model: "agent-model",
        source: "agent-preference",
      });
    });
  });
});
