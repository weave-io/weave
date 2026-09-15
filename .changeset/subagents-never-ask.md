---
"@weaveio/weave-cli": patch
"@weaveio/weave-adapter-opencode": patch
"@weaveio/weave-adapter-opencode2": patch
"@weaveio/weave-adapter-copilot": patch
"@weaveio/weave-adapter-claude-code": patch
"@weaveio/weave-adapter-pi": patch
---

Subagents no longer pause a delegated run to ask the user a question.

- OpenCode and OpenCode 2: Weave now sets the `question` permission on every agent it registers. Subagents get `deny`; primary and `all` agents get `allow`. Before, Weave left it unset, so a global `"permission": "allow"` let every subagent open a question that blocked the run until the user answered or aborted it, and without that setting Loom and Tapestry could not ask either.
- Shuttle, Pattern, Thread, Spindle, Weft, and Warp prompts tell the agent it runs as a delegated task and no one can reply until it returns, so it resolves ambiguity with a stated assumption or reports a blocker. Pattern no longer asks a clarifying question when a goal is underspecified; it records its reading under `Constraints / assumptions` and lists any decision the caller needs to confirm.

Bundled-source: @weaveio/weave-config
