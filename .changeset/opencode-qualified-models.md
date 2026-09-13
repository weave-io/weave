---
"@weaveio/weave-adapter-opencode": minor
---

Never hand OpenCode an unqualified model ID.

Builtin agents declare the harness-neutral default `claude-sonnet-4-5`. OpenCode read that as provider `claude-sonnet-4-5` with an empty model ID, so `opencode run --agent loom` failed with `ProviderModelNotFoundError` for every user who had not set a model. The adapter now only uses `provider/model` preferences and otherwise omits `model`, so OpenCode uses the user's selected or default model.

`resolveModelForAgent()` now returns `Result<string | undefined, ModelResolutionError>`; `undefined` means "omit the model".
