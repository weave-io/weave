import { Agent } from "@opencode-ai/plugin";
import type { AgentEditor } from "./host-types.js";
import { OPENCODE2_MANAGED_PERMISSION_ACTIONS } from "./tool-policy-mapping.js";
import type { OpenCode2AgentProjection } from "./translate-agent.js";

export interface OpenCode2AgentCatalog {
  readonly agents: ReadonlyMap<string, OpenCode2AgentProjection>;
}

/** One replay callback. Presence in this editor is the foreign-ownership test. */
export function registerOpenCode2Agents(
  editor: AgentEditor,
  catalog: OpenCode2AgentCatalog,
  inserted: Set<string>,
  defaultAgent?: string,
): void {
  inserted.clear();
  for (const [id, projection] of catalog.agents) {
    if (editor.get(id) !== undefined) continue;
    editor.update(id, (agent) => {
      agent.name = Agent.Name.make(projection.displayName ?? id);
      agent.system = projection.system;
      agent.description = projection.description;
      agent.mode = projection.mode;
      if (projection.model === undefined) delete agent.model;
      else agent.model = projection.model;
      agent.permissions = [
        ...agent.permissions.filter(
          (rule) => !OPENCODE2_MANAGED_PERMISSION_ACTIONS.has(rule.action),
        ),
        ...projection.permissions,
      ];
    });
    inserted.add(id);
  }
  if (defaultAgent !== undefined && inserted.has(defaultAgent))
    editor.default(defaultAgent);
}
