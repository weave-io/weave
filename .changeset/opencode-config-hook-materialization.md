---
"@weaveio/weave-adapter-opencode": minor
---

Materialize OpenCode agents through the config hook with fail-closed name collisions.

- Existing same-name agent entries remain unchanged, and copied metadata never authorizes replacement.
- The config hook trusts OpenCode's parsed JSON/JSONC records, preserves every existing own same-name entry, and injects only absent entries; it does not attempt proxy detection, reflection-based ownership proofs, or rollback claims.
- The plugin registers only prompt-based `/weave:start` and `/start-work`; prompts require explicit plan input or user selection plus repository-file validation, and they do not claim system-authorized state, plan authentication, work creation, or live `RuntimeCommandProjection` delivery.
- Agent, primary-agent, delegated-specialist, and command-entrypoint readiness remain degraded because the config-hook contract does not prove durable ownership across processes.
- Read, glob, grep, list, and task permissions preserve allow, deny, and ask exactly.
- The obsolete SDK client facade and reconciliation exports are removed from the package root.

Breaking: Remove the former `OpenCodeClientFacade`, `SdkOpenCodeClient`, and reconciliation helpers. Use the config hook and explicit runtime command projections instead.
