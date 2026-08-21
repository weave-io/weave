import "../../../types/md.d.ts";

import type { ConfigError, WeaveConfig } from "@weaveio/weave-core";
import { parseConfig } from "@weaveio/weave-core";
import type { Result } from "neverthrow";

// ---------------------------------------------------------------------------
// Embedded builtin prompt contents
//
// Imported as text at build time via Bun's `with { type: "text" }` import
// assertion. This embeds the file contents directly into the bundle, making
// builtin prompt resolution fully bundle-safe — no filesystem access required
// at runtime, regardless of where the bundle is executed from.
//
// This is the fix for the `import.meta.dir` bundling problem: when
// `@weaveio/weave-config` is bundled into `@weaveio/weave-adapter-opencode/dist/plugin.js`,
// `import.meta.dir` in `loader.ts` resolves to the adapter's dist directory
// rather than `packages/config/`. By embedding prompt content here, we
// eliminate the runtime filesystem dependency for builtins entirely.
// ---------------------------------------------------------------------------

import loomPrompt from "../prompts/loom.md" with { type: "text" };
import patternPrompt from "../prompts/pattern.md" with { type: "text" };
import shuttlePrompt from "../prompts/shuttle.md" with { type: "text" };
import spindlePrompt from "../prompts/spindle.md" with { type: "text" };
import tapestryPrompt from "../prompts/tapestry.md" with { type: "text" };
import threadPrompt from "../prompts/thread.md" with { type: "text" };
import warpPrompt from "../prompts/warp.md" with { type: "text" };
import weftPrompt from "../prompts/weft.md" with { type: "text" };

/**
 * Embedded builtin prompt contents, keyed by agent name.
 *
 * These are the same files referenced by `prompt_file` in
 * `BUILTIN_WEAVE_SOURCE`, but embedded at build time so that the bundle
 * does not need to read them from the filesystem at runtime.
 *
 * Used by `loader.ts` to inline prompt content into the builtin config
 * before merging, replacing `prompt_file` references with `prompt` values.
 */
interface BuiltinPromptContents {
  readonly [agentName: string]: string;
  readonly loom: string;
  readonly tapestry: string;
  readonly shuttle: string;
  readonly pattern: string;
  readonly thread: string;
  readonly spindle: string;
  readonly weft: string;
  readonly warp: string;
}

export const BUILTIN_PROMPT_CONTENTS: BuiltinPromptContents = {
  loom: loomPrompt,
  tapestry: tapestryPrompt,
  shuttle: shuttlePrompt,
  pattern: patternPrompt,
  thread: threadPrompt,
  spindle: spindlePrompt,
  weft: weftPrompt,
  warp: warpPrompt,
};

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
 * `resolvePromptPaths()` before merging, OR replaced with embedded inline
 * content from `BUILTIN_PROMPT_CONTENTS` when running from a bundle.
 *
 * Note: `review_models` is intentionally omitted from the weft and warp
 * builtin agents. Including extra review models would increase cost for all
 * users by default. Users who want multi-model review can add `review_models`
 * to their project or global `config.weave` to override these defaults.
 */
export const BUILTIN_WEAVE_SOURCE = `
agent loom {
  description "Main orchestrator: classifies open-ended requests, routes bounded work straight to specialists, and hands plan-sized work to pattern; may read, write, execute, and delegate; select for open-ended user requests that need coordination across several agents"
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
  description "Plan execution coordinator: drives an existing plan file task by task, delegating every step and verifying acceptance criteria; may read, write, execute, and delegate, but never implements itself; select when an approved plan must be executed end to end"
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
  description "General implementation worker: bounded coding, testing, debugging, and refactoring tasks; may read, write, and run commands, but cannot delegate; select for scoped changes when no category shuttle matches the work"
  prompt_file "shuttle.md"
  models ["claude-sonnet-4-5"]
  mode subagent
  temperature 0.2

  tool_policy {
    read allow
    write allow
    execute allow
    network deny
    delegate deny
  }

  triggers [
    "Use for a scoped change only when no listed category shuttle clearly matches the work"
    "Use when an edit crosses category boundaries and splitting it would cost more than doing it once"
    "Use for build, script, CI, and manifest files that no category covers"
  ]
}

agent pattern {
  description "Strategic planner: turns a goal into a file-backed, sequenced plan with per-task acceptance criteria; writes plan files only, cannot execute commands or delegate; select before multi-file features or refactors that span five or more steps"
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
    "Use for multi-file features, complex refactors, or work spanning 5+ steps"
    "Use when system design decisions need to be made before implementation"
    "Use when a large goal needs to be broken into an actionable plan"
  ]
}

agent thread {
  description "Codebase explorer: traces symbols, call graphs, and data flow to answer where-is and how-does-this-work questions with exact file and line evidence; read-only, cannot execute or delegate; select for cheap internal investigation before planning or editing"
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
    "Use for fast codebase exploration — read-only and cheap"
    "Use when answering 'where is X' or 'how does Y work' questions"
    "Use to gather evidence before routing to implementation agents"
  ]
}

agent spindle {
  description "External researcher: fetches and synthesizes official documentation, specifications, and library APIs with citations; network access but no writes, execution, or delegation; select when a decision depends on facts outside this repository"
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
    "Use for external docs and research — read-only"
    "Use when facts need verification against official sources"
    "Use when exploring external options, libraries, or standards"
  ]
}

agent weft {
  description "Code reviewer: judges correctness, quality, and maintainability of a changeset and returns an approve or request-changes verdict; read-only, cannot execute or delegate; select as a quality gate after non-trivial changes"
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
    "Use after non-trivial changes (3+ files, or when quality matters)"
    "Use as a quality gate before considering work complete"
    "Use when structured feedback is needed on plans or designs"
  ]
}

agent warp {
  description "Security auditor: audits a changeset for vulnerabilities, unsafe patterns, and specification compliance, returning an approve or block verdict; read-only, cannot execute or delegate; select whenever changes touch auth, crypto, tokens, secrets, sessions, CORS, CSP, or input validation"
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
    "MANDATORY when changes touch auth, crypto, tokens, secrets, sessions, CORS, CSP, or input validation"
    "Use as security gate before shipping security-sensitive changes"
    "Use when security implications of a design need analysis"
  ]
}

workflow plan-and-execute {
  description "Research, plan, implement, and review a feature end-to-end"
  version 1

  extension_points {
    before-plan
  }

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
    role planning
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
  description "Execute an existing named plan end-to-end, then review"
  version 1

  step execute {
    name "Execute the existing plan"
    type autonomous
    agent shuttle
    prompt "Execute the existing plan named {{instance.slug}} for: {{instance.goal}}"
    completion plan_complete {
      plan_name "{{instance.slug}}"
    }
  }

  step review {
    name "Code review after execution"
    type gate
    agent weft
    prompt "Review all changes made during plan execution for: {{instance.goal}}"
    completion review_verdict
    on_reject pause
  }

  step security {
    name "Security audit after execution"
    type gate
    agent warp
    prompt "Security audit of all changes made during plan execution for: {{instance.goal}}"
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
