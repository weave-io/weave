---
"@weaveio/weave-adapter-opencode2": patch
---

A Weave agent now runs on the model your `.weave` config gives it even when the client selects no model. OpenCode 2 runs a turn on the session's model and otherwise falls back to the host default, never the agent's own model, so `opencode2 run` without `-m` ran Loom and Tapestry on the host default. When a session has no model and its agent is one Weave registered, Weave now selects that agent's model before the turn. A session started without an agent uses the host's default agent (Loom, unless you set `default_agent`). A model you choose with `-m` or in the TUI is never replaced.
