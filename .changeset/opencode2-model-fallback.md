---
"@weaveio/weave-adapter-opencode2": minor
---

Keep agents whose declared model cannot be resolved.

An agent that declared a model the live catalog could not serve was dropped
from the host. Because every builtin declares the bare model
`claude-sonnet-4-5`, a host whose catalog does not carry it lost all eight
builtins, and `/weave:start` with them, since command readiness requires an
owned Tapestry. The only record was a `model_unavailable` issue in the
`status` RPC.

An unresolvable declared model now costs the agent its model, not its
existence: the agent is registered without a model ref and OpenCode applies
its own native model selection. The per-agent `model_unavailable` issue is
still reported, so `status` names every agent whose declared model did not
resolve.

The agent runs on a model the user did not name, which `status` is the only
record of. That replaces a failure that removed the whole product from the
host.
