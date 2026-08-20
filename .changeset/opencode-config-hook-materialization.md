---
"@weaveio/weave-adapter-opencode": minor
---

Materialize OpenCode agents through the config hook with fail-closed name collisions.

- Existing same-name agent entries remain unchanged, and copied metadata never authorizes replacement.
- Config-hook ownership follows bounded safe-map and exact post-mutation descriptor proofs; accessors, proxies with unproven mutations, symbols, oversize maps, absorbed assignments, mismatches, and descriptor churn fail closed.
- The plugin registers only prompt-based `/weave:start` and `/start-work`; it does not claim `/weave:run` or live `RuntimeCommandProjection` delivery.
- Read, glob, grep, list, and task permissions preserve allow, deny, and ask exactly.
- The obsolete SDK client facade and reconciliation exports are removed from the package root.

Breaking: Remove the former `OpenCodeClientFacade`, `SdkOpenCodeClient`, and reconciliation helpers. Use the config hook and explicit runtime command projections instead.
