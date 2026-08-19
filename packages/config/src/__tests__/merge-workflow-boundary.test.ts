import { describe, expect, it } from "bun:test";
import type { WeaveConfig, WorkflowConfig } from "@weaveio/weave-core";
import { parseConfig } from "@weaveio/weave-core";
import { mergeWorkflow } from "../merge.js";

function wf(source: string) {
  const result = parseConfig(source);
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  const workflows = result.value.workflows;
  const keys = Object.keys(workflows);
  const name = keys[0];
  if (name === undefined) throw new Error("No workflow in source");
  const config = workflows[name];
  if (config === undefined) throw new Error("No workflow in source");
  return { name, config };
}

describe("mergeWorkflow — public boundary", () => {
  it("rejects the Warp override.extends accessor reproduction before reading it", () => {
    const baseWf = wf(`
      workflow plan-and-execute {
        version 1
        step plan {
          type autonomous
          agent pattern
          prompt "Plan"
          completion agent_signal
        }
      }
    `);
    const overrideWf = wf(`
      workflow plan-and-execute {
        version 1
        step implement {
          type autonomous
          agent tapestry
          prompt "Implement"
          completion agent_signal
        }
      }
    `);
    let getterExecutions = 0;
    Object.defineProperty(overrideWf.config, "extends", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        return "plan-and-execute";
      },
    });

    const result = mergeWorkflow(
      "plan-and-execute",
      baseWf.config,
      overrideWf.config,
      { "plan-and-execute": baseWf.config },
    );

    expect(result.isErr()).toBe(true);
    expect(getterExecutions).toBe(0);
    if (result.isErr()) expect(result.error.type).toBe("UnsafeWorkflowInput");
  });

  it("rejects a workflow-map accessor without executing its getter", () => {
    const baseWf = wf(`
      workflow plan-and-execute {
        version 1
        step plan {
          type autonomous
          agent pattern
          prompt "Plan"
          completion agent_signal
        }
      }
    `);
    const overrideWf = wf(`
      workflow plan-and-execute {
        version 1
        extends "plan-and-execute"
        step implement {
          type autonomous
          agent tapestry
          prompt "Implement"
          completion agent_signal
        }
      }
    `);
    let getterExecutions = 0;
    const workflowMap: WeaveConfig["workflows"] = {
      "plan-and-execute": baseWf.config,
    };
    Object.defineProperty(workflowMap, "plan-and-execute", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        return baseWf.config;
      },
    });

    const result = mergeWorkflow(
      "plan-and-execute",
      baseWf.config,
      overrideWf.config,
      workflowMap,
    );

    expect(result.isErr()).toBe(true);
    expect(getterExecutions).toBe(0);
    if (result.isErr()) expect(result.error.type).toBe("UnsafeWorkflowInput");
  });

  it("rejects forbidden workflow-map keys without prototype mutation", () => {
    const baseWf = wf(`
      workflow plan-and-execute {
        version 1
        step plan {
          type autonomous
          agent pattern
          prompt "Plan"
          completion agent_signal
        }
      }
    `);
    const overrideWf = wf(`
      workflow plan-and-execute {
        version 1
        extends "plan-and-execute"
        step implement {
          type autonomous
          agent tapestry
          prompt "Implement"
          completion agent_signal
        }
      }
    `);
    const workflowMap: WeaveConfig["workflows"] = {};
    Object.defineProperty(workflowMap, "__proto__", {
      configurable: true,
      enumerable: true,
      value: baseWf.config,
      writable: true,
    });

    const result = mergeWorkflow(
      "plan-and-execute",
      baseWf.config,
      overrideWf.config,
      workflowMap,
    );

    expect(result.isErr()).toBe(true);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    if (result.isErr()) expect(result.error.type).toBe("UnsafeWorkflowInput");
  });

  it("rebuilds a valid workflow map without invoking inherited setters", () => {
    const baseWf = wf(`
      workflow helper {
        version 1
        step plan {
          name "Plan"
          type autonomous
          agent pattern
          prompt "Plan"
          completion agent_signal
        }
      }
    `);
    const overrideWf = wf(`
      workflow helper {
        extends "helper"
        version 1
        step implement {
          name "Implement"
          type autonomous
          agent shuttle
          prompt "Implement"
          completion agent_signal
        }
      }
    `);
    const workflowMap = { helper: baseWf.config };
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

      const result = mergeWorkflow(
        "helper",
        baseWf.config,
        overrideWf.config,
        workflowMap,
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.steps.map((step) => step.name)).toEqual([
          "plan",
          "implement",
        ]);
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

  it("rejects an accessor on a workflow step before trusted merge logic reads it", () => {
    const baseWf = wf(`
      workflow plan-and-execute {
        version 1
        step plan {
          type autonomous
          agent pattern
          prompt "Plan"
          completion agent_signal
        }
      }
    `);
    const overrideWf = wf(`
      workflow plan-and-execute {
        version 1
        step implement {
          type autonomous
          agent tapestry
          prompt "Implement"
          completion agent_signal
        }
      }
    `);
    const step = overrideWf.config.steps[0];
    if (step === undefined) throw new Error("No override step");
    let getterExecutions = 0;
    Object.defineProperty(step, "prompt", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecutions += 1;
        return "unsafe";
      },
    });

    const result = mergeWorkflow(
      "plan-and-execute",
      baseWf.config,
      overrideWf.config,
      { "plan-and-execute": baseWf.config },
    );

    expect(result.isErr()).toBe(true);
    expect(getterExecutions).toBe(0);
    if (result.isErr()) expect(result.error.type).toBe("UnsafeWorkflowInput");
  });

  it("fails closed before schema parsing when Object.prototype.description has a setter", () => {
    const baseWf = wf(`
      workflow helper {
        description "Base description"
        version 1
        step plan {
          type autonomous
          agent pattern
          prompt "Plan"
          completion agent_signal
        }
      }
    `);
    const overrideWf = wf(`
      workflow helper {
        description "Override description"
        extends "helper"
        version 1
        step implement {
          type autonomous
          agent shuttle
          prompt "Implement"
          completion agent_signal
        }
      }
    `);
    const previous = Object.getOwnPropertyDescriptor(
      Object.prototype,
      "description",
    );
    let setterExecutions = 0;

    try {
      Object.defineProperty(Object.prototype, "description", {
        configurable: true,
        enumerable: false,
        set() {
          setterExecutions += 1;
        },
      });

      const result = mergeWorkflow("helper", baseWf.config, overrideWf.config, {
        helper: baseWf.config,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe("UnsafeWorkflowInput");
      }
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(Object.prototype, "description");
      } else {
        Object.defineProperty(Object.prototype, "description", previous);
      }
    }

    expect(setterExecutions).toBe(0);
  });

  it("fails closed for an inherited numeric array setter without invoking it", () => {
    const baseWf = wf(`
      workflow helper {
        version 1
        step plan {
          type autonomous
          agent pattern
          prompt "Plan"
          completion agent_signal
        }
      }
    `);
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    let setterExecutions = 0;
    let thrown: unknown;
    let result: ReturnType<typeof mergeWorkflow> | undefined;

    try {
      Object.defineProperty(Array.prototype, "0", {
        configurable: true,
        enumerable: false,
        set() {
          setterExecutions += 1;
        },
      });
      try {
        result = mergeWorkflow("helper", baseWf.config, baseWf.config, {
          helper: baseWf.config,
        });
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
      expect(result.error.type).toBe("UnsafeWorkflowInput");
    }
    expect(setterExecutions).toBe(0);
  });

  it("preserves base extension-point fields when the override omits them", () => {
    const baseWf = wf(`
      workflow plan-and-execute {
        version 1
        extension_points { before-plan }
        step plan {
          type autonomous
          role planning
          agent pattern
          prompt "Plan"
          completion agent_signal
        }
      }
    `);
    const overrideWf = wf(`
      workflow plan-and-execute {
        extends "plan-and-execute"
        version 1
        step implement {
          type autonomous
          agent tapestry
          prompt "Implement"
          completion agent_signal
        }
      }
    `);
    const override = {
      ...overrideWf.config,
      extension_points: {},
    } satisfies WorkflowConfig;

    const result = mergeWorkflow("plan-and-execute", baseWf.config, override, {
      "plan-and-execute": baseWf.config,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().extension_points).toEqual({
      before_plan: true,
    });
  });
});
