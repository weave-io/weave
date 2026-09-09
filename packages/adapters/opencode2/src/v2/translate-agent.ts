import type { AgentDescriptor } from "@weaveio/weave-engine";
import type { V2Model as Model } from "../sdk-types.js";
import {
  mapOpenCode2ToolPolicy,
  type NativePermissionRule,
} from "./tool-policy-mapping.js";

export interface OpenCode2AgentProjection {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly system: string;
  readonly mode: "primary" | "subagent" | "all";
  readonly model?: Model.Ref;
  readonly temperature?: number;
  readonly fast?: boolean;
  readonly permissions: readonly NativePermissionRule[];
  readonly skillNames: readonly string[];
}

function nativeDelegationGuidance(descriptor: AgentDescriptor): string {
  if (descriptor.delegationTargets.length === 0) return "";
  return "\n\nUse OpenCode's native subagent tool for these specialists. Choose foreground when you need the result before continuing, or background when independent work can run while you continue.";
}

export function translateOpenCode2Agent(
  descriptor: AgentDescriptor,
  model: Model.Ref | undefined,
): OpenCode2AgentProjection {
  return {
    id: descriptor.name,
    displayName: descriptor.displayName,
    description: descriptor.description,
    system: `${descriptor.composedPrompt}${nativeDelegationGuidance(descriptor)}`,
    mode: descriptor.mode,
    model,
    temperature: descriptor.temperature,
    fast: descriptor.fast,
    permissions: mapOpenCode2ToolPolicy(
      descriptor.effectiveToolPolicy,
      descriptor.delegationTargets.map((target) => target.name),
    ),
    skillNames: [...descriptor.skills],
  };
}
