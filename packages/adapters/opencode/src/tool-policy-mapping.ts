/**
 * Maps Weave tool capabilities to the pinned OpenCode permission schema.
 *
 * OpenCode's permission object has named rules for `read`, `glob`, `grep`,
 * `list`, `edit`, `bash`, `task`, and `webfetch`. Read permissions must use
 * those fields directly: omitting `read: ask` would silently enable reads
 * through the harness default, so this adapter never treats `ask` as an
 * omission.
 *
 * The engine sees only abstract Weave capabilities. OpenCode names remain in
 * this adapter boundary.
 */

import type { EffectiveToolPolicy } from "@weaveio/weave-engine";
import type { OpenCodePermissionAction } from "./sdk-types.js";

/** The scalar permission values accepted by OpenCode. */
export type OpenCodePermissionValue = OpenCodePermissionAction;

/** The concrete OpenCode permission names implementing Weave's read policy. */
export const READ_PERMISSION_NAMES = ["read", "glob", "grep", "list"] as const;

export type ReadPermissionName = (typeof READ_PERMISSION_NAMES)[number];

/** The complete permission projection for one translated agent. */
export interface OpenCodeToolPermissions {
  readonly read: OpenCodePermissionValue;
  readonly glob: OpenCodePermissionValue;
  readonly grep: OpenCodePermissionValue;
  readonly list: OpenCodePermissionValue;
  readonly edit: OpenCodePermissionValue;
  readonly bash: OpenCodePermissionValue;
  readonly task: OpenCodePermissionValue;
  readonly webfetch: OpenCodePermissionValue;
}

/** Mapping returned to the translator. */
export interface OpenCodeToolPolicyMapping {
  readonly permission: OpenCodeToolPermissions;
}

/** Convert one Weave permission to the equivalent OpenCode action. */
export function toOpenCodePermission(
  permission: OpenCodePermissionAction,
): OpenCodePermissionValue {
  return permission;
}

/** Build the four exact OpenCode fields for the abstract read capability. */
export function buildReadPermissionEntries(
  readPermission: OpenCodePermissionAction,
): Pick<OpenCodeToolPermissions, ReadPermissionName> {
  return {
    read: toOpenCodePermission(readPermission),
    glob: toOpenCodePermission(readPermission),
    grep: toOpenCodePermission(readPermission),
    list: toOpenCodePermission(readPermission),
  };
}

/** Map a resolved Weave policy to the OpenCode permission block. */
export function mapToolPolicy(
  policy: EffectiveToolPolicy,
): OpenCodeToolPolicyMapping {
  return {
    permission: {
      ...buildReadPermissionEntries(policy.read),
      edit: toOpenCodePermission(policy.write),
      bash: toOpenCodePermission(policy.execute),
      task: toOpenCodePermission(policy.delegate),
      webfetch: toOpenCodePermission(policy.network),
    },
  };
}
