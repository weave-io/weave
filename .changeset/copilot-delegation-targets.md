---
"@weaveio/weave-adapter-copilot": patch
---

Steer Loom and Tapestry toward Weave agents instead of Copilot's built-in subagents.

- Delegation references in Loom's and Tapestry's generated prompts now use the ids Copilot's `task` tool accepts (`weave:thread`, not `thread`).
- Both prompts end with a "Delegation targets (GitHub Copilot)" section that maps Copilot's built-in agents (`explore`, `task`, `general-purpose`, ...) to the Weave agent that replaces each one.
- Every other agent's file is unchanged, so sessions without Loom or Tapestry active behave as before.
- The adapter package now has a `test` script, so CI runs its tests.
