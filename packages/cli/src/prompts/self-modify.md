# Weave Self-Modification Guide

You are modifying Weave's own configuration. This command is the sole detailed
self-modification contract. Other agent prompts should direct you here instead
of duplicating this procedure.

This guide tells you exactly which files to read, what rules to follow, and how
to verify your changes.

---

## Scope: {{{scope}}}

**Config file**: `{{{configPath}}}`
**Prompt files directory**: `{{{promptsDir}}}`

---

## Before you start

- [ ] Read `docs/reference/dsl.md` — canonical DSL syntax reference
- [ ] Read `docs/reference/configuration.md` — three-layer merge rules, builtin agents,
      prompt-file resolution, and config discovery
- [ ] If your change touches prompt text, `prompt_file`, `prompt_append`, or
      `prompt_append_file`: also read `docs/reference/prompts.md`

> **`docs/` and `packages/docs/` serve different audiences.**
> Use the repo-root references above for internal configuration and composition
> contracts. `packages/docs/` owns public user guidance. If a change affects
> both audiences, update both surfaces; neither one is a mirror of the other.

---

## Target-specific rules

{{#isGlobal}}

### Global scope (`~/.weave/`)

- Changes here apply to **all projects** on this machine.
- Prefer project-scope overrides for project-specific behaviour.
- Builtin agents (loom, tapestry, shuttle, …) are defined in
  `packages/config/src/builtins.ts` — they are not in `~/.weave/config.weave`.
  Override a builtin by re-declaring the agent block in your config file;
  only the fields you specify are overridden (deep-merge semantics).
- Prompt files referenced by `prompt_file` must exist at
  `~/.weave/prompts/<filename>` before the config is loaded.
{{/isGlobal}}
{{#isLocal}}

### Project scope (`.weave/`)

- Changes here apply to **this project only** and override global config.
- Builtin agents (loom, tapestry, shuttle, …) are defined in
  `packages/config/src/builtins.ts` — they are not in `.weave/config.weave`.
  Override a builtin by re-declaring the agent block in your config file;
  only the fields you specify are overridden (deep-merge semantics).
- Prompt files referenced by `prompt_file` must exist at
  `.weave/prompts/<filename>` before the config is loaded.
- Category blocks auto-generate `shuttle-<name>` agent descriptors — you do
  not need to declare them manually.
{{/isLocal}}

---

## Workflow

1. **Identify the change** — agent override, new agent, category, workflow,
   settings, or disable block.
2. **Read the relevant DSL section** in `docs/reference/dsl.md`.
3. **Edit `{{{configPath}}}`** using the DSL syntax (block-structured, no
   semicolons, double-quoted strings, bare enums).
4. **Place prompt files** (if any) in `{{{promptsDir}}}`.
5. **Validate** — run `weave validate` to confirm the config parses cleanly.
6. **Inspect** — run `weave prompt inspect <agent>` to verify the composed
   prompt looks correct.

---

## Common patterns

### Override a builtin agent field

```weave
agent loom {
  temperature 0.3
}
```

Only `temperature` changes; all other loom fields remain from the builtin layer.

### Add a custom agent with an inline prompt

```weave
agent my-helper {
  prompt "You are a concise assistant."
  models ["claude-sonnet-4-5"]
  mode subagent
  temperature 0.3
}
```

### Add a custom agent with a prompt file

```weave
agent my-helper {
  prompt_file "my-helper.md"
  models ["claude-sonnet-4-5"]
  mode subagent
}
```

Place the prompt at `{{{promptsDir}}}/my-helper.md`.

### Disable a builtin agent

```weave
disable agents ["warp"]
```

### Add a category

```weave
category backend {
  description "Backend APIs and services"
  models ["claude-sonnet-4-5"]
  triggers ["Use for API contracts, services, and persistence"]
  temperature 0.2
}
```

This auto-generates a `shuttle-backend` agent descriptor.

---

## Prompt-related changes

If you are editing prompt text or `prompt_file` / `prompt_append` values:

{{=<% %>=}}
- [ ] Read `docs/reference/prompts.md` for the supported Mustache template
      context and composition rules.
- [ ] Use `{{#delegation.targets}}` to iterate over eligible delegation targets;
      inside the loop, use fields such as `{{name}}` and `{{description}}`.
- [ ] `{{#triggers}}` iterates a target's ordered trigger strings; render each
      entry with `{{.}}`. There is no `domains` field.
- [ ] `prompt` and `prompt_file` are mutually exclusive per agent.
- [ ] `prompt_append` and `prompt_append_file` are mutually exclusive per agent.
- [ ] Unsupported Mustache features (partials, helpers, lambdas) are rejected
      at composition time.
<%={{ }}=%>

---

## Verify

```bash
weave validate                          # config parses and validates
weave prompt list                       # all expected agents appear
weave prompt inspect <agent>            # composed prompt looks correct
weave prompt inspect <agent> --json     # full descriptor including tool policy
```
