import { describe, expect, it } from "bun:test";
import type { WeaveConfig } from "@weaveio/weave-core";
import {
  MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE,
  MAX_CONFIG_ERROR_FIELD_LENGTH,
  MAX_CONFIG_ERROR_ISSUES,
  MAX_CONFIG_ERROR_PATH_LENGTH,
  parseConfig,
} from "@weaveio/weave-core";
import { mergeConfigsResult } from "../merge.js";

function cfg(source: string): WeaveConfig {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const emptyConfig = cfg("");

function nullPrototypeRecord<T extends object>(record: T): T {
  return Object.setPrototypeOf(record, null);
}

function expectRejectedLayer(layer: WeaveConfig): void {
  const result = mergeConfigsResult(layer);
  expect(result.isErr()).toBe(true);
  if (!result.isErr()) return;

  const validation = result.error[0];
  expect(validation?.type).toBe("ConfigValidationError");
  if (validation?.type !== "ConfigValidationError") return;
  expect(validation.errors.length).toBeLessThanOrEqual(MAX_CONFIG_ERROR_ISSUES);
  let diagnosticSize = 0;
  for (const issue of validation.errors) {
    expect(issue.path.length).toBeLessThanOrEqual(MAX_CONFIG_ERROR_PATH_LENGTH);
    expect(issue.message.length).toBeLessThanOrEqual(
      MAX_CONFIG_ERROR_FIELD_LENGTH,
    );
    diagnosticSize += issue.path.length + issue.message.length;
  }
  expect(diagnosticSize).toBeLessThanOrEqual(MAX_CONFIG_ERROR_DIAGNOSTIC_SIZE);
}

describe("mergeConfigs — hostile layer boundary", () => {
  it("merges null-prototype owner records with the same precedence and omission rules", () => {
    const baseAgent = { models: ["base-model"], skills: ["base-skill"] };
    const overrideAgent = { models: ["override-model"], temperature: 0.5 };
    const baseAdapter = nullPrototypeRecord({
      nested: nullPrototypeRecord({ base: true }),
      list: [1, 2],
      value: "base",
    });
    const overrideAdapter = nullPrototypeRecord({
      nested: nullPrototypeRecord({ override: true }),
      list: [2, 3],
      value: null,
    });
    const base: WeaveConfig = {
      ...emptyConfig,
      agents: nullPrototypeRecord({ helper: baseAgent }),
      settings: {
        ...emptyConfig.settings,
        adapters: nullPrototypeRecord({ generic: baseAdapter }),
      },
    };
    const override: WeaveConfig = {
      ...emptyConfig,
      agents: nullPrototypeRecord({ helper: overrideAgent }),
      settings: {
        ...emptyConfig.settings,
        adapters: nullPrototypeRecord({ generic: overrideAdapter }),
      },
    };

    const result = mergeConfigsResult(base, override);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;

    const merged = result.value;
    expect(merged.agents.helper?.models).toEqual([
      "override-model",
      "base-model",
    ]);
    expect(merged.agents.helper?.skills).toEqual(["base-skill"]);
    expect(merged.agents.helper?.temperature).toBe(0.5);
    expect(merged.settings.adapters?.generic).toEqual({
      nested: { base: true, override: true },
      list: [2, 3, 1],
      value: null,
    });
  });

  it("does not invoke inherited setters for dynamic config maps", () => {
    const baseAgent = { prompt: "base" };
    const overrideAgent = { prompt: "override" };
    const baseCategory = { description: "base category" };
    const overrideCategory = { description: "override category" };
    const base: WeaveConfig = {
      ...emptyConfig,
      agents: nullPrototypeRecord({ helper: baseAgent }),
      categories: nullPrototypeRecord({ helper: baseCategory }),
      settings: {
        ...emptyConfig.settings,
        adapters: nullPrototypeRecord({ helper: { base: true } }),
      },
    };
    const override: WeaveConfig = {
      ...emptyConfig,
      agents: nullPrototypeRecord({ helper: overrideAgent }),
      categories: nullPrototypeRecord({ helper: overrideCategory }),
      settings: {
        ...emptyConfig.settings,
        adapters: nullPrototypeRecord({ helper: { override: true } }),
      },
    };
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "helper",
    );
    let setterExecutions = 0;

    try {
      Object.defineProperty(Object.prototype, "helper", {
        configurable: true,
        enumerable: false,
        set() {
          setterExecutions += 1;
        },
      });

      const result = mergeConfigsResult(base, override);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const merged = result.value;
        expect(Object.getPrototypeOf(merged.agents)).toBe(null);
        expect(Object.getPrototypeOf(merged.categories)).toBe(null);
        expect(Object.getPrototypeOf(merged.settings.adapters)).toBe(null);
        expect(Object.getPrototypeOf(merged.settings.adapters?.helper)).toBe(
          null,
        );
        expect(Object.hasOwn(merged.agents, "helper")).toBe(true);
        expect(Object.hasOwn(merged.categories, "helper")).toBe(true);
        expect(Object.hasOwn(merged.settings.adapters ?? {}, "helper")).toBe(
          true,
        );
        expect(merged.agents.helper?.prompt).toBe("override");
        expect(merged.categories.helper?.description).toBe("override category");
        expect(merged.settings.adapters?.helper).toEqual({
          base: true,
          override: true,
        });
      }
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(Object.prototype, "helper");
      } else {
        Object.defineProperty(Object.prototype, "helper", previous);
      }
    }

    expect(setterExecutions).toBe(0);
  });

  it("fails closed for an inherited default-key setter without invoking it", () => {
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "agents",
    );
    let setterExecutions = 0;
    let thrown: unknown;
    let result: ReturnType<typeof mergeConfigsResult> | undefined;

    try {
      Object.defineProperty(Object.prototype, "agents", {
        configurable: true,
        enumerable: false,
        set() {
          setterExecutions += 1;
        },
      });
      try {
        result = mergeConfigsResult();
      } catch (error) {
        thrown = error;
      }
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(Object.prototype, "agents");
      } else {
        Object.defineProperty(Object.prototype, "agents", previous);
      }
    }

    expect(thrown).toBeUndefined();
    expect(result?.isErr()).toBe(true);
    if (result?.isErr()) {
      expect(result.error[0]?.type).toBe("ConfigValidationError");
    }
    expect(setterExecutions).toBe(0);
  });

  it("rejects accessors before merge logic can execute them", () => {
    let getterExecutions = 0;
    const layer = { ...emptyConfig };
    Object.defineProperty(layer, "settings", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        return emptyConfig.settings;
      },
    });

    expectRejectedLayer(layer);
    expect(getterExecutions).toBe(0);
  });

  it("bounds diagnostics without invoking a throwing numeric array setter", () => {
    const invalidLayer: WeaveConfig = {
      ...emptyConfig,
      settings: { ...emptyConfig.settings },
    };
    Object.defineProperty(invalidLayer.settings, "log_level", {
      configurable: true,
      enumerable: true,
      value: "NOT_A_LOG_LEVEL",
      writable: true,
    });
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    let setterExecutions = 0;
    let thrown: unknown;
    let result: ReturnType<typeof mergeConfigsResult> | undefined;

    try {
      Object.defineProperty(Array.prototype, "0", {
        configurable: true,
        enumerable: false,
        set() {
          setterExecutions += 1;
          throw new Error("numeric setter executed");
        },
      });
      try {
        result = mergeConfigsResult(invalidLayer);
      } catch (error) {
        thrown = error;
      }
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(Array.prototype, "0");
      } else {
        Object.defineProperty(Array.prototype, "0", previous);
      }
    }

    expect(thrown).toBeUndefined();
    expect(result?.isErr()).toBe(true);
    if (result?.isErr()) {
      expect(result.error[0]?.type).toBe("ConfigValidationError");
    }
    expect(setterExecutions).toBe(0);
  });

  it("rejects non-enumerable and non-writable data properties", () => {
    const nonEnumerable = { ...emptyConfig };
    Object.defineProperty(nonEnumerable, "settings", {
      configurable: true,
      enumerable: false,
      value: emptyConfig.settings,
      writable: true,
    });
    expectRejectedLayer(nonEnumerable);

    const nonWritable = { ...emptyConfig };
    Object.defineProperty(nonWritable, "settings", {
      configurable: true,
      enumerable: true,
      value: emptyConfig.settings,
      writable: false,
    });
    expectRejectedLayer(nonWritable);
  });

  it("rejects inherited config fields without executing inherited getters", () => {
    let getterExecutions = 0;
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "prompt",
    );
    try {
      Object.defineProperty(Object.prototype, "prompt", {
        configurable: true,
        enumerable: true,
        get() {
          getterExecutions += 1;
          return "unsafe";
        },
      });
      expectRejectedLayer(emptyConfig);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(Object.prototype, "prompt");
      } else {
        Object.defineProperty(Object.prototype, "prompt", previous);
      }
    }
    expect(getterExecutions).toBe(0);
  });

  it("rejects inherited properties and unexpected prototypes", () => {
    const inherited: WeaveConfig = Object.create({
      agents: emptyConfig.agents,
    });
    expectRejectedLayer(inherited);

    const unexpected = { ...emptyConfig };
    Object.setPrototypeOf(unexpected, { inherited: true });
    expectRejectedLayer(unexpected);
  });

  it("rejects symbols and dangerous keys without changing global prototypes", () => {
    const symbolLayer = { ...emptyConfig };
    Object.defineProperty(symbolLayer, Symbol("unsafe"), {
      configurable: true,
      enumerable: true,
      value: true,
      writable: true,
    });
    expectRejectedLayer(symbolLayer);

    const workflow = cfg(`
      workflow helper {
        version 1
        step plan {
          type autonomous
          agent pattern
          prompt "Plan"
          completion agent_signal
        }
      }
    `).workflows.helper;
    if (workflow === undefined) throw new Error("No workflow in source");

    for (const key of ["__proto__", "prototype", "constructor"]) {
      const agents = nullPrototypeRecord({ ...emptyConfig.agents });
      Object.defineProperty(agents, key, {
        configurable: true,
        enumerable: true,
        value: {},
        writable: true,
      });
      expectRejectedLayer({ ...emptyConfig, agents });

      const categories = nullPrototypeRecord({ ...emptyConfig.categories });
      Object.defineProperty(categories, key, {
        configurable: true,
        enumerable: true,
        value: { description: "category" },
        writable: true,
      });
      expectRejectedLayer({ ...emptyConfig, categories });

      const adapters = nullPrototypeRecord({ [key]: { value: true } });
      expectRejectedLayer({
        ...emptyConfig,
        settings: { ...emptyConfig.settings, adapters },
      });

      const workflows = nullPrototypeRecord({ [key]: workflow });
      expectRejectedLayer({ ...emptyConfig, workflows });
    }
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("rejects callable proxies before inspecting their properties", () => {
    let ownKeysTrapCalls = 0;
    const callable = (): void => {};
    const callableProxy = new Proxy(callable, {
      ownKeys() {
        ownKeysTrapCalls += 1;
        return [];
      },
    });
    const layer = { ...emptyConfig };
    Object.defineProperty(layer, "agents", {
      configurable: true,
      enumerable: true,
      value: callableProxy,
      writable: true,
    });

    expectRejectedLayer(layer);
    expect(ownKeysTrapCalls).toBe(0);
  });

  it("rejects cycles and sparse arrays", () => {
    const cyclic = { ...emptyConfig };
    Object.defineProperty(cyclic, "cycle", {
      configurable: true,
      enumerable: true,
      value: cyclic,
      writable: true,
    });
    expectRejectedLayer(cyclic);

    const sparse: string[] = [];
    sparse.length = 1;
    const sparseLayer: WeaveConfig = {
      ...emptyConfig,
      disabled: { ...emptyConfig.disabled, agents: sparse },
    };
    expectRejectedLayer(sparseLayer);
  });

  it("rejects oversized hostile layer graphs with bounded typed diagnostics", () => {
    const oversized: string[] = Array.from({ length: 513 }, () => "entry");
    const layer: WeaveConfig = {
      ...emptyConfig,
      disabled: { ...emptyConfig.disabled, agents: oversized },
    };

    expectRejectedLayer(layer);
  });

  it("rejects depth and aggregate property exhaustion before schema parsing", () => {
    type Nested = { next?: Nested };
    const deep: Nested = {};
    let current = deep;
    for (let index = 0; index <= 64; index += 1) {
      const next: Nested = {};
      current.next = next;
      current = next;
    }
    const deepLayer = { ...emptyConfig };
    Object.defineProperty(deepLayer, "deep", {
      configurable: true,
      enumerable: true,
      value: deep,
      writable: true,
    });
    expectRejectedLayer(deepLayer);

    const wideSettings = { ...emptyConfig.settings };
    for (let index = 0; index <= 512; index += 1) {
      Object.defineProperty(wideSettings, `field-${index}`, {
        configurable: true,
        enumerable: true,
        value: true,
        writable: true,
      });
    }
    expectRejectedLayer({ ...emptyConfig, settings: wideSettings });
  });
});
