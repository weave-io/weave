---
"@weaveio/weave-adapter-opencode2": patch
---

An agent's `variant` no longer costs it the model you named. When the selected model does not offer the variant — `variant none` on a Claude model, for example, since Claude models have no `none` variant — the agent keeps that model and runs without the variant, and `status` reports `variant_unavailable`. Before, the model was rejected, so the agent fell to a builtin fallback model or to no model at all, and an OpenCode 2 subagent then ran on its parent's model. A `#variant` written on a model entry still has to exist for that entry to be used.
