# @weave/core

Core DSL types, schema definitions, and config parser for the Weave multi-agent orchestration framework.

## Overview

This package provides the foundational type contracts used across the entire Weave ecosystem:

- **`WeaveConfig`** — top-level configuration shape (agents, hooks, skills, disabled lists)
- **`AgentConfig`** — per-agent configuration (name, model, temperature, tools, skills, prompt)
- **`SkillConfig`** — skill configuration (name, path, scope)
- **`HookConfig`** — hook configuration (name, enabled flag)
- **`defineConfig()`** — DSL identity helper for ergonomic config authoring with full type inference

## Usage

```ts
import { defineConfig } from "@weave/core";

export default defineConfig({
  agents: {
    coder: {
      name: "coder",
      model: "claude-sonnet-4-5",
      temperature: 0.2,
      tools: ["read", "edit", "bash"],
      skills: ["tdd"],
      prompt_append: "Always write tests first.",
    },
  },
  hooks: [{ name: "on-task-start", enabled: true }],
  skills: [{ name: "tdd", path: "./skills/tdd", scope: "project" }],
  disabled: [],
});
```
