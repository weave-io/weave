/**
 * MockAdapter — a test double for `HarnessAdapter`.
 *
 * Records every method call in a typed `calls` log so tests can assert on
 * what the runner invoked, in what order, and with what arguments — without
 * requiring a real harness or performing harness resource discovery.
 *
 * Usage:
 * ```ts
 * const adapter = new MockAdapter();
 * await new WeaveRunner(config, adapter).run();
 *
 * expect(adapter.callsTo("init")).toHaveLength(1);
 * expect(adapter.callsTo("spawnSubagent")[0]?.name).toBe("loom");
 * ```
 */

import type { AgentConfig } from "@weave/core";
import type { HarnessAdapter, HookConfig, SkillConfig } from "../adapter.js";

// `HookConfig` and `SkillConfig` are transitional adapter-boundary types.
// Tests should not treat them as proof that engine code owns concrete hook
// registration or harness skill discovery/loading.

// ---------------------------------------------------------------------------
// Typed call record
// ---------------------------------------------------------------------------

/** One entry per adapter method call, in the order they were made. */
export type MockCall =
  | { method: "init" }
  | { method: "spawnSubagent"; name: string; config: AgentConfig }
  | { method: "registerHook"; hook: HookConfig }
  | { method: "loadSkill"; skill: SkillConfig };

// ---------------------------------------------------------------------------
// MockAdapter
// ---------------------------------------------------------------------------

export class MockAdapter implements HarnessAdapter {
  /** Ordered log of every call made to this adapter instance. */
  readonly calls: MockCall[] = [];

  async init(): Promise<void> {
    this.calls.push({ method: "init" });
  }

  async spawnSubagent(name: string, config: AgentConfig): Promise<void> {
    this.calls.push({ method: "spawnSubagent", name, config });
  }

  async registerHook(hook: HookConfig): Promise<void> {
    this.calls.push({ method: "registerHook", hook });
  }

  async loadSkill(skill: SkillConfig): Promise<void> {
    this.calls.push({ method: "loadSkill", skill });
  }

  /**
   * Return all calls to a specific method, narrowed to that method's type.
   * Convenience wrapper over `this.calls.filter(...)`.
   */
  callsTo<M extends MockCall["method"]>(
    method: M,
  ): Extract<MockCall, { method: M }>[] {
    return this.calls.filter(
      (c): c is Extract<MockCall, { method: M }> => c.method === method,
    );
  }
}
