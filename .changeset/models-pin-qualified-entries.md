---
"@weaveio/weave-cli": patch
---

`weave models pin` leaves provider-qualified entries (such as
`openrouter/anthropic/claude-opus-5.5`) out of the global config by default
and says which and why: every harness reads that file, and OpenCode V1 uses
the first provider-qualified entry without checking that the provider is
connected. `--include-qualified` keeps them, with the same explanation as a
warning. An agent whose recommended entries are all provider-qualified keeps
its existing `models` lines.
