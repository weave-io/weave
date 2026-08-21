import { describe, expect, it } from "bun:test";
import * as engine from "../index.js";
import { createInMemoryRuntimeStore } from "../runtime/memory-store.js";

describe("engine public API", () => {
  it("exports the permission facade without durable repository internals", () => {
    expect(engine.createPermissionService).toBeDefined();
    expect(engine.PermissionService).toBeDefined();
    expect(engine.PermissionSession).toBeDefined();
    expect(engine.PermissionRegistryBuilder).toBeDefined();
    expect(engine.PermissionRegistryGeneration).toBeDefined();
    expect(engine.verifyPermissionCoverage).toBeDefined();
    expect("InMemoryPermissionApprovalRepository" in engine).toBe(false);
    expect("SqlitePermissionApprovalRepository" in engine).toBe(false);
    expect("createPermissionRegistryBuilderForTesting" in engine).toBe(false);
    expect("activatePermissionSessionForTesting" in engine).toBe(false);
    expect("lookupRegistryRegistration" in engine).toBe(false);
    expect("readRegistryInventory" in engine).toBe(false);
    expect("readRegistryGenerationMeta" in engine).toBe(false);
    expect("fromToken" in engine.PermissionRegistryGeneration).toBe(false);
    expect(Object.isFrozen(engine.PermissionRegistryGeneration)).toBe(true);
    expect(Object.isFrozen(engine.PermissionRegistryGeneration.prototype)).toBe(
      true,
    );
  });

  it("re-exports the model-thinking API for adapters", () => {
    expect(engine.THINKING_LEVEL_VALUES).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(
      engine.parseModelIntentEntry("provider/model#high")._unsafeUnwrap(),
    ).toEqual({ baseModel: "provider/model", thinkingLevel: "high" });
  });

  it("does not expose permission mutation on RuntimeStore instances", () => {
    const store = createInMemoryRuntimeStore();
    expect("permissions" in store).toBe(false);
    expect(Object.keys(store)).not.toContain("permissions");
  });
});
