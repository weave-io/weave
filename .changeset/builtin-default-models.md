---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
"@weaveio/weave-adapter-opencode2": minor
"@weaveio/weave-adapter-claude-code": minor
---

The builtin agents have new default models. Each agent names one Anthropic and one OpenAI model, and harnesses use the first one they can run:

| Agent | Default models |
| --- | --- |
| Loom, Tapestry, Pattern | `claude-opus-5-5`, then `gpt-6-sol` |
| Shuttle | `claude-sonnet-5`, then `gpt-6-sol` |
| Thread | `claude-haiku-4-5`, then `gpt-6-luna` |
| Spindle | `gpt-6-luna`, then `claude-haiku-4-5` |
| Weft, Warp | `gpt-6-sol`, then `claude-opus-5-5` |

Every agent used to declare only `claude-sonnet-4-5`. Against Sonnet 4.5 on each agent's eval suite, GPT 6 Sol scored 9/12 against 6/12 on Weft and 11/12 against 6/12 on Warp, and Sonnet 5 scored 8/9 against 3/9 on Shuttle. Opus 5.5 matched Sonnet 4.5 on Loom, Tapestry and Pattern. Haiku for Thread is unmeasured. See `docs/artifacts/eval-default-models-2026-09-25.md`.

Claude Code now maps `claude-opus-5-5`, `claude-sonnet-5` and `claude-haiku-4-5` to its `opus`, `sonnet` and `haiku` aliases. On Claude Code, Weft and Warp run on `opus` and Spindle runs on `haiku`. Models you declare in your own config still come first.
