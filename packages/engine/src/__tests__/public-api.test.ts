import { describe, expect, it } from "bun:test";
import * as engine from "../index.js";
import { createInMemoryRuntimeStore } from "../runtime/memory-store.js";

describe("engine public API", () => {
  it("exports the permission facade without durable repository internals", () => {
    expect(typeof engine.createPermissionService).toBe("function");
    expect(typeof engine.PermissionService).toBe("function");
    expect(typeof engine.PermissionSession).toBe("function");
    expect(typeof engine.PermissionRegistryBuilder).toBe("function");
    expect(typeof engine.PermissionRegistryGeneration).toBe("function");
    expect(typeof engine.verifyPermissionCoverage).toBe("function");
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

  it("does not expose permission mutation on RuntimeStore instances", () => {
    const store = createInMemoryRuntimeStore();
    expect("permissions" in store).toBe(false);
    expect(Object.keys(store)).not.toContain("permissions");
  });
});
