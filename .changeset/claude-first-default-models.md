---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
"@weaveio/weave-adapter-opencode2": minor
"@weaveio/weave-adapter-claude-code": minor
---

Every builtin agent now tries a Claude model first:

| Agent | Default models |
| --- | --- |
| Loom, Tapestry, Pattern | `claude-opus-5.5`, `claude-opus-5-5`, then `gpt-6-sol` (unchanged) |
| Weft, Warp | `claude-opus-5.5`, `claude-opus-5-5`, then `gpt-6-sol` |
| Shuttle | `claude-sonnet-5.5`, `claude-sonnet-5-5`, then `gpt-6-sol` (unchanged) |
| Spindle | `claude-sonnet-5.5`, `claude-sonnet-5-5`, then `gpt-6-luna` |
| Thread | `claude-haiku-5.5`, `claude-haiku-5-5`, `claude-haiku-4.5`, `claude-haiku-4-5`, then `gpt-6-luna` |

Weft and Warp move from GPT 6 Sol to Opus 5.5, which passed every attempt on both reviewer suites (Sol 58/60 and 56/60). Spindle moves from GPT 6 Luna to Sonnet 5.5 (59/60 against 60/60, within noise) after its report was told to keep only the facts that answer the question. Thread moves to Claude Haiku 5.5, released on 7 October 2026, which passed 65/65 on the new Thread suite against 52/65 for Haiku 4.5. On Claude Code, Weft and Warp run on `opus`, Spindle on `sonnet` and Thread on `haiku`. Models you declare in your own config still come first.

A published model recommendations list issued before this change is now older than the builtins and is skipped.

Bundled-source: @weaveio/weave-config
