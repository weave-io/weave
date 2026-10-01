export function starterConfig(scope: "global" | "local"): string {
  const scopeDescription =
    scope === "global"
      ? "Shared user-level defaults for every project."
      : "Project-level defaults for this repository.";

  return `# Weave starter config (${scope})
# ${scopeDescription}
# Edit this file to describe agents, categories, workflows, and settings.

# The builtin agents (loom, tapestry, shuttle, pattern, thread, spindle, weft,
# warp) are already configured with full prompts and tool policies. Declaring
# one here merges into the builtin, and a value you set replaces the
# builtin's: setting \`prompt\` replaces Loom's whole orchestration prompt.
# To add guidance without losing the builtin prompt, use \`prompt_append\`:
#
# agent loom {
#   prompt_append "Prefer small, reviewable changes."
# }
#
# Declare a new agent under its own name:
#
# agent docs-writer {
#   description "Writes and updates project documentation"
#   prompt "Keep documentation accurate, short, and linked to the code."
#   mode subagent
#   triggers ["Use for README and docs/ changes"]
# }

# Each category adds a shuttle-<name> specialist that Loom and Tapestry can
# delegate to. Without \`models\`, it runs on Shuttle's models. To pin one,
# list models your harness offers, most preferred first, for example
# models ["anthropic/claude-sonnet-5-5"].

category backend {
  description "Backend APIs, services, persistence, and data integrity"
  triggers ["Use for backend APIs, services, persistence, and data integrity"]
  prompt_append "Prioritize API contracts, migrations, and backwards compatibility."
}

category frontend {
  description "Frontend UI, styling, accessibility, and user interaction"
  triggers ["Use for frontend UI, styling, accessibility, and user interaction"]
  prompt_append "Preserve accessibility and responsive behavior."
}

workflow quick-fix {
  description "Fix a bug, then review the result"
  version 1

  step fix {
    name "Implement the fix"
    type autonomous
    agent shuttle
    prompt "Fix the following issue: {{instance.goal}}"
    completion agent_signal
  }

  step review {
    name "Review the fix"
    type gate
    agent weft
    prompt "Review the fix for: {{instance.goal}}"
    completion review_verdict
    on_reject pause
  }
}

disable agents []
disable hooks []
disable skills []

settings {
  log_level INFO
}

continuation {
  recovery {
    compaction true
  }
  idle {
    enabled true
    work true
    workflow true
  }
}

analytics {
  enabled false
  use_fingerprint false
}
`;
}
