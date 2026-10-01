---
"@weaveio/weave-cli": minor
---

Opted-in Claude Code users get new model recommendations at their next
session (Spec 39).

- With `settings { model_updates { mode auto } }` (or `notify`),
  `weave compose --adapter claude-code`, which the bootstrap plugin's
  `SessionStart` hook runs, checks for a newer signed list once it has written
  the plugin. The check is throttled (at most once a day after a success, once
  an hour after a failure), bounded to about two seconds, and never changes
  the hook's exit code or what it prints on stdout. It never runs with
  `mode off` or without the block.
- In `auto` mode a newer list is applied, and the next session's agents are
  composed from its `claude-code` section (`opus`, `sonnet` or `haiku`).
- Compose's summary says which model lists the agents were composed from, and
  an applied list that cannot be used is a `Warning:` on stderr instead of a
  log line.
