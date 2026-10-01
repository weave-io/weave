---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode2": minor
"@weaveio/weave-adapter-claude-code": minor
---

Load applied model recommendations, and accept Claude Code's tier names as
`models` entries.

- An agent's `models` list can now name `opus`, `sonnet` or `haiku`. Claude
  Code maps each tier to its current model, so the Claude Code adapter treats
  them as always available and writes them into the agent's `model:`
  frontmatter unchanged:

  ```weave
  agent shuttle {
    models ["sonnet"]
  }
  ```

- With `settings { model_updates { mode notify } }` or `mode auto`, the
  OpenCode 2 adapter and `weave compose --adapter claude-code` merge an
  already applied, signed recommendations list for the builtin agents' models
  (Spec 39), ahead of the builtin lists and behind the user's own entries.
  Nothing fetches a list yet, so this changes nothing until that lands.
  Without the setting no recommendations file is read.
- OpenCode 2 `status` reports `model_updates_unavailable` when an opted-in
  user's applied list cannot be used; the agents keep their builtin lists.

Bundled-source: @weaveio/weave-config
