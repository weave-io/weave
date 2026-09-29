---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
"@weaveio/weave-adapter-opencode2": minor
"@weaveio/weave-adapter-claude-code": minor
---

The builtin agents now default to the models GitHub Copilot offers, and a Copilot host picks them up:

| Agent | Default models |
| --- | --- |
| Loom, Tapestry, Pattern | `claude-opus-5.5`, `claude-opus-5-5`, then `gpt-6-sol` |
| Weft, Warp | `gpt-6-sol`, then `claude-opus-5.5`, `claude-opus-5-5` |
| Shuttle | `claude-sonnet-5.5`, `claude-sonnet-5-5`, then `gpt-6-sol` |
| Spindle | `gpt-6-luna`, then `claude-haiku-4.5`, `claude-haiku-4-5` |
| Thread | `claude-haiku-4.5`, `claude-haiku-4-5`, then `gpt-6-luna` |

Copilot spells Claude versions with a dot (`claude-opus-5.5`) and Anthropic with a dash (`claude-opus-5-5`), so each Claude model is listed in both spellings, Copilot's first. Before, the defaults used only Anthropic's spelling, so on an OpenCode 2 host signed in to Copilot, Loom, Tapestry and Pattern ran on GPT 6 Sol instead of Opus 5.5, and Thread on GPT 6 Luna instead of Haiku 4.5.

Shuttle moves from Sonnet 5 to Sonnet 5.5 (9/9 against 8/9 on `shuttle-execution`). Weft and Warp now try GPT 6 Sol first (18/20 and 20/20 on the reviewer suites, against 19/20 and 20/20 for Opus 5.5). On Claude Code, which maps only Anthropic's spelling, Shuttle runs on `sonnet`, now including `claude-sonnet-5-5`. Models you declare in your own config still come first.
