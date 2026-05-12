export function starterConfig(scope: "global" | "local"): string {
  const scopeDescription =
    scope === "global"
      ? "Shared user-level defaults for every project."
      : "Project-level defaults for this repository.";

  return `# Weave starter config (${scope})
# ${scopeDescription}
# Edit this file to describe agents, categories, workflows, and settings.

agent loom {
  description "Primary orchestration agent"
  prompt "Coordinate the user's work, delegate when useful, and keep progress clear."
  models ["claude-sonnet-4-5", "gpt-4o"]
  mode primary
  temperature 0.1

  tool_policy {
    read allow
    write allow
    execute ask
    delegate allow
    network ask
  }

  triggers [
    { domain "Planning" trigger "Break complex work into safe steps" }
    { domain "Review" trigger "Coordinate specialist review" }
  ]

  skills ["code-review"]
}

agent shuttle {
  description "Focused implementation specialist"
  prompt "Implement focused changes carefully and report proof of work."
  models ["claude-sonnet-4-5"]
  mode subagent
  temperature 0.2

  tool_policy {
    read allow
    write allow
    execute ask
    delegate deny
    network ask
  }
}

category backend {
  description "Backend APIs, services, persistence, and data integrity"
  models ["claude-sonnet-4-5"]
  patterns ["src/api/**", "src/server/**", "src/db/**", "**/*.go"]
  prompt_append "Prioritize API contracts, migrations, and backwards compatibility."
  temperature 0.2
}

category frontend {
  description "Frontend UI, styling, accessibility, and user interaction"
  models ["gpt-4o"]
  patterns ["src/components/**", "src/pages/**", "**/*.tsx", "**/*.css"]
  prompt_append "Preserve accessibility and responsive behavior."
  temperature 0.2
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
    agent loom
    prompt "Review the fix for: {{instance.goal}}"
    completion review_verdict
    on_reject pause
  }
}

disable agents []
disable hooks []
disable skills []

log_level INFO

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
