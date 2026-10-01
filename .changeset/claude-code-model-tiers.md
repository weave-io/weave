---
"@weaveio/weave-adapter-claude-code": minor
---

Accept Claude Code's tier names as `models` entries.

An agent's `models` list can now name `opus`, `sonnet` or `haiku`. Claude Code
maps each tier to its current model, so the adapter treats them as always
available and writes them into the agent's `model:` frontmatter unchanged:

```weave
agent shuttle {
  models ["sonnet"]
}
```

This is the form a `claude-code` section of the opt-in model recommendations
uses (Spec 39).
