---
"@weaveio/weave-adapter-opencode2": patch
---

A partial or partly broken `.weave` config no longer leaves you with no Weave agents on OpenCode 2. An agent whose `prompt_file` cannot be read is left out on its own, and `status` names it; the other agents load as usual. Before, one missing prompt file registered no agents at all. A config that does not parse or validate still loads nothing, so nothing you restricted is silently loosened, but the plan panel now says "Weave config is invalid; run `weave validate`" and `status` reports a `config_invalid` issue, instead of only "Weave config refresh failed".
