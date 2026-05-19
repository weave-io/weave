import type { ConfigError, WeaveConfig } from "@weave/core";
import { parseConfig } from "@weave/core";
import type { Result } from "neverthrow";

/**
 * Ordered list of all built-in agent names.
 *
 * These names match the `agent` blocks in `BUILTIN_WEAVE_SOURCE` and are
 * exported so consumers can check whether a given name is a builtin without
 * needing to call `getBuiltinConfig()`.
 */
export const BUILTIN_AGENT_NAMES: readonly string[] = [
  "loom",
  "tapestry",
  "shuttle",
  "pattern",
  "thread",
  "spindle",
  "weft",
  "warp",
];

/**
 * The canonical `.weave` DSL source that declares all 8 built-in agents.
 *
 * This constant is the single source of truth for default agent configuration.
 * It is parsed through the same `parseConfig` pipeline used for user-authored
 * configs, validating the DSL-first principle: built-ins are just well-known
 * named entries — there is no separate code path for them.
 *
 * Prompt file paths are relative to the `prompts/` directory shipped inside
 * `packages/config/`. They are resolved to absolute paths by
 * `resolvePromptPaths()` before merging.
 */
export const BUILTIN_WEAVE_SOURCE = `
agent loom {
  description "Loom (Main Orchestrator)"
  prompt_file "loom.md"
  models ["claude-sonnet-4-5"]
  mode primary
  temperature 0.1

  tool_policy {
    read allow
    write allow
    execute allow
    network ask
    delegate allow
  }
}


agent tapestry {
  description "Tapestry (Plan Execution)"
  prompt_file "tapestry.md"
  models ["claude-sonnet-4-5"]
  mode primary
  temperature 0.1

  tool_policy {
    read allow
    write allow
    execute allow
    network deny
    delegate allow
  }
}

agent shuttle {
  description "Shuttle (Domain Specialist)"
  prompt_file "shuttle.md"
  models ["claude-sonnet-4-5"]
  mode all
  temperature 0.2

  tool_policy {
    read allow
    write allow
    execute allow
    network deny
    delegate deny
  }

  triggers [
    { domain "Implementation" trigger "Bounded coding tasks, file edits, feature work" }
    { domain "Testing" trigger "Writing and running tests" }
    { domain "Debugging" trigger "Diagnosing and fixing bugs in a specific area" }
    { domain "Refactoring" trigger "Improving code structure without changing behavior" }
  ]
}

agent pattern {
  description "Pattern (Strategic Planner)"
  prompt_file "pattern.md"
  models ["claude-sonnet-4-5"]
  mode subagent
  temperature 0.3

  tool_policy {
    read allow
    write allow
    execute deny
    network deny
    delegate deny
  }

  triggers [
    { domain "Planning" trigger "Creating structured implementation plans before execution" }
    { domain "Architecture" trigger "Designing system structure, component boundaries, and data flow" }
    { domain "Decomposition" trigger "Breaking complex goals into discrete, sequenced tasks" }
  ]
}

agent thread {
  description "Thread (Codebase Explorer)"
  prompt_file "thread.md"
  models ["claude-sonnet-4-5"]
  mode subagent
  temperature 0.0

  tool_policy {
    read allow
    write deny
    execute deny
    network deny
    delegate deny
  }

  triggers [
    { domain "Exploration" trigger "Tracing symbols, call graphs, and data flow across the codebase" }
    { domain "Discovery" trigger "Locating where a concept, pattern, or behavior is implemented" }
    { domain "Audit" trigger "Surveying existing code before planning a change" }
  ]
}

agent spindle {
  description "Spindle (External Researcher)"
  prompt_file "spindle.md"
  models ["claude-sonnet-4-5"]
  mode subagent
  temperature 0.1

  tool_policy {
    read allow
    write deny
    execute deny
    network allow
    delegate deny
  }

  triggers [
    { domain "Research" trigger "Fetching external documentation, API references, or library guides" }
    { domain "Verification" trigger "Confirming facts, versions, or behaviors against authoritative sources" }
    { domain "Discovery" trigger "Finding relevant third-party tools, packages, or standards" }
  ]
}

agent weft {
  description "Weft (Reviewer)"
  prompt_file "weft.md"
  models ["claude-sonnet-4-5"]
  mode subagent
  temperature 0.1

  tool_policy {
    read allow
    write deny
    execute deny
    network deny
    delegate deny
  }

  triggers [
    { domain "Code Review" trigger "Reviewing code quality, correctness, and maintainability" }
    { domain "Gate" trigger "Approving or requesting changes before a task is considered complete" }
    { domain "Feedback" trigger "Providing structured critique on a plan, design, or implementation" }
  ]
}

agent warp {
  description "Warp (Security Auditor)"
  prompt_file "warp.md"
  models ["claude-sonnet-4-5"]
  mode subagent
  temperature 0.1

  tool_policy {
    read allow
    write deny
    execute deny
    network deny
    delegate deny
  }

  triggers [
    { domain "Security" trigger "Auditing code for vulnerabilities, misconfigurations, or unsafe patterns" }
    { domain "Gate" trigger "Security approval checkpoint before shipping or merging" }
    { domain "Threat Modeling" trigger "Identifying attack surfaces and risk areas in a design or implementation" }
  ]
}

workflow plan-and-execute {
  description "Research, plan, implement, and review a feature end-to-end"
  version 1

  step research {
    name "Research the codebase and external context"
    type autonomous
    agent thread
    prompt "Explore the codebase to understand the relevant area for: {{instance.goal}}"
    completion agent_signal
  }

  step external-research {
    name "Fetch external documentation if needed"
    type autonomous
    agent spindle
    prompt "Research external APIs, libraries, or standards relevant to: {{instance.goal}}"
    completion agent_signal
  }

  step plan {
    name "Create implementation plan"
    type autonomous
    agent pattern
    prompt "Create a detailed implementation plan for: {{instance.goal}}"
    completion plan_created {
      plan_name "{{instance.slug}}"
    }
    outputs [
      { name "plan_path" description "Path to the generated plan file" }
    ]
  }

  step implement {
    name "Execute the plan"
    type autonomous
    agent tapestry
    prompt "Execute the plan at {{artifacts.plan_path}} for: {{instance.goal}}"
    completion plan_complete {
      plan_name "{{instance.slug}}"
    }
    inputs [
      { name "plan_path" description "Path to the plan to execute" }
    ]
  }

  step review {
    name "Code review"
    type gate
    agent weft
    prompt "Review all changes for: {{instance.goal}}"
    completion review_verdict
    on_reject pause
  }

  step security {
    name "Security audit"
    type gate
    agent warp
    prompt "Perform a security audit of all changes for: {{instance.goal}}"
    completion review_verdict
    on_reject pause
  }
}

workflow quick-fix {
  description "Fix a bug and get it reviewed"
  version 1

  step fix {
    name "Implement the fix"
    type autonomous
    agent shuttle
    prompt "Fix the following issue: {{instance.goal}}"
    completion agent_signal
  }

  step review {
    name "Code review"
    type gate
    agent weft
    prompt "Review the fix for: {{instance.goal}}"
    completion review_verdict
    on_reject pause
  }
}

workflow tapestry-execution {
  description "Standard plan execution sequence used by Tapestry"
  version 1

  step execute {
    name "Execute each plan task"
    type autonomous
    agent shuttle
    prompt "Execute the delegated task from the plan"
    completion agent_signal
  }

  step review {
    name "Code review after execution"
    type gate
    agent weft
    prompt "Review all changes made during plan execution"
    completion review_verdict
    on_reject pause
  }

  step security {
    name "Security audit after execution"
    type gate
    agent warp
    prompt "Security audit of all changes made during plan execution"
    completion review_verdict
    on_reject pause
  }
}
`;

/**
 * Parse and return the built-in agent configuration.
 *
 * Calls `parseConfig(BUILTIN_WEAVE_SOURCE)` and returns the result directly.
 * An `err` result always indicates a bug in this file — the built-in DSL
 * must be valid at all times.
 *
 * @returns `ok(WeaveConfig)` with all 8 built-in agents, or
 *          `err(ConfigError[])` if the DSL is malformed (indicates a bug).
 */
export function getBuiltinConfig(): Result<WeaveConfig, ConfigError[]> {
  return parseConfig(BUILTIN_WEAVE_SOURCE);
}
