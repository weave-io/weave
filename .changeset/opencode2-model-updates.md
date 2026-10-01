---
"@weaveio/weave-adapter-opencode2": minor
---

Opted-in users get new model recommendations on OpenCode 2 without a restart
(Spec 39).

- With `settings { model_updates { mode auto } }` (or `notify`), the plugin
  checks for a newer signed list in the background: once after its first
  catalog publish, and on each prompt or plan start. The check is throttled
  (at most once a day after a success, once an hour after a failure), never
  delays the prompt, and never runs with `mode off` or without the block.
- In `auto` mode a promoted list reloads the agents on the next due refresh,
  so a later turn runs on the new model. A live session keeps the model it
  has.
- `status` gains a `modelUpdates` object: `mode`, `channel`, `state`
  (`off`, `pending`, `applied` or `unavailable`) and the applied list's
  `issued` date.
- A reload that moves agents to a newly applied list emits a
  `models.changed` RPC event, and the TUI plan panel shows it as a notice, for
  example "Loom now runs on claude-opus-5.6 (model recommendations of 1 Oct
  2026)".

Bundled-source: @weaveio/weave-config
