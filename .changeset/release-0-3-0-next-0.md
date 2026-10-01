---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode2": minor
"@weaveio/weave-adapter-claude-code": minor
---

Pre-release 0.3.0-next.0 on the `next` channel: opt-in model recommendations (Spec 39). Add `settings { model_updates { mode notify } }` (or `auto`) to have the builtin agents' model lists follow a signed list published on tryweave.io, without upgrading Weave. Only model lists change; your own `models`, prompts and permissions are untouched. New `weave models status | update | apply | pin | check` commands. OpenCode 2 applies a new list without a restart; Claude Code at the next session. Off by default: without the setting, nothing changes and no request is made.
