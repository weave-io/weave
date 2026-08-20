/**
 * Stable OpenCode configuration types used by the adapter.
 *
 * This is the only adapter module that imports OpenCode SDK types directly.
 * The pinned SDK's v2 schema is the source of truth for agent permissions:
 * `read`, `glob`, `grep`, `list`, and `task` are permission fields, not
 * boolean entries in the agent `tools` map.
 */

import type {
  PermissionActionConfig,
  PermissionRuleConfig,
  AgentConfig as SdkOpenCodeAgentConfig,
} from "@opencode-ai/sdk/v2";

/** Permission actions accepted by OpenCode. */
export type OpenCodePermissionAction = PermissionActionConfig;

/**
 * Agent permission fields used by this adapter.
 *
 * The v2 OpenCode schema uses named permission rules. The scalar fields that
 * the plugin package still declares remain scalar here so the translated
 * config is assignable to the plugin config-hook input. Path-specific rules
 * remain available where OpenCode supports them.
 */
export interface OpenCodeAgentPermission {
  read?: PermissionRuleConfig;
  edit?: PermissionActionConfig;
  glob?: PermissionRuleConfig;
  grep?: PermissionRuleConfig;
  list?: PermissionRuleConfig;
  bash?: PermissionRuleConfig;
  task?: PermissionRuleConfig;
  webfetch?: PermissionActionConfig;
}

/** OpenCode agent config fields translated by Weave. */
export type OpenCodeAgentConfig = Pick<
  SdkOpenCodeAgentConfig,
  | "model"
  | "temperature"
  | "top_p"
  | "prompt"
  | "tools"
  | "disable"
  | "description"
  | "mode"
  | "color"
  | "maxSteps"
  | "options"
> & {
  permission?: OpenCodeAgentPermission;
};
