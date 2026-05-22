/**
 * MockAdapter — a test double for `HarnessAdapter`.
 *
 * Records every method call in a typed `calls` log so tests can assert on
 * what the runner invoked, in what order, and with what arguments — without
 * requiring a real harness or performing harness resource discovery.
 *
 * Skill context is provided via the constructor `availableSkills` option.
 * `loadAvailableSkills()` returns that list without any filesystem access,
 * harness API calls, or directory scanning — proving the engine does not
 * need to discover skills itself.
 *
 * Usage (canonical bootstrap pattern):
 * ```ts
 * const adapter = new MockAdapter();
 * await adapter.init();
 * await adapter.loadAvailableSkills();
 * const plan = (await materializeAgents({ config })).value;
 * for (const { descriptor } of plan.agents) {
 *   await adapter.spawnSubagent(descriptor);
 * }
 *
 * expect(adapter.callsTo("init")).toHaveLength(1);
 * expect(adapter.callsTo("spawnSubagent")[0]?.descriptor.name).toBe("loom");
 * ```
 *
 * With available skills:
 * ```ts
 * const adapter = new MockAdapter({
 *   availableSkills: [{ name: "tdd" }, { name: "code-review" }],
 * });
 * const availableSkills = await adapter.loadAvailableSkills();
 * const skillResult = resolveSkillsForConfig({ config, availableSkills });
 * ```
 */

import type { HarnessAdapter, HookConfig, SkillConfig } from "../adapter.js";
import type { AgentDescriptor } from "../compose.js";
import type { SkillInfo } from "../skill-resolution.js";

// `HookConfig` and `SkillConfig` are transitional adapter-boundary types.
// Tests should not treat them as proof that engine code owns concrete hook
// registration or harness skill discovery/loading.

// ---------------------------------------------------------------------------
// MockAdapter options
// ---------------------------------------------------------------------------

export interface MockAdapterOptions {
  /**
   * Skills to return from `loadAvailableSkills()`.
   *
   * Defaults to an empty array — no skills available.
   * Provide this list to test skill resolution without any filesystem access
   * or harness-specific discovery.
   */
  availableSkills?: SkillInfo[];
}

// ---------------------------------------------------------------------------
// Typed call record
// ---------------------------------------------------------------------------

/** One entry per adapter method call, in the order they were made. */
export type MockCall =
  | { method: "init" }
  | { method: "spawnSubagent"; descriptor: AgentDescriptor }
  | { method: "registerHook"; hook: HookConfig }
  | { method: "loadSkill"; skill: SkillConfig }
  | { method: "loadAvailableSkills" };

// ---------------------------------------------------------------------------
// MockAdapter
// ---------------------------------------------------------------------------

export class MockAdapter implements HarnessAdapter {
  /** Ordered log of every call made to this adapter instance. */
  readonly calls: MockCall[] = [];

  private readonly _availableSkills: SkillInfo[];

  constructor(options: MockAdapterOptions = {}) {
    this._availableSkills = options.availableSkills ?? [];
  }

  async init(): Promise<void> {
    this.calls.push({ method: "init" });
  }

  async spawnSubagent(descriptor: AgentDescriptor): Promise<void> {
    this.calls.push({ method: "spawnSubagent", descriptor });
  }

  async registerHook(hook: HookConfig): Promise<void> {
    this.calls.push({ method: "registerHook", hook });
  }

  /**
   * @deprecated Transitional method. Use `loadAvailableSkills()` instead.
   */
  async loadSkill(skill: SkillConfig): Promise<void> {
    this.calls.push({ method: "loadSkill", skill });
  }

  /**
   * Return the adapter-provided available skills without any filesystem access,
   * harness API calls, or directory scanning.
   *
   * This proves the engine does not need to discover skills itself — it only
   * receives explicit adapter-provided context.
   */
  async loadAvailableSkills(): Promise<SkillInfo[]> {
    this.calls.push({ method: "loadAvailableSkills" });
    return this._availableSkills;
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
