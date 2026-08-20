---
"@weaveio/weave-adapter-opencode": minor
---

Materialize OpenCode agents through the config hook with fail-closed name collisions.

- Existing same-name agent entries remain unchanged, and copied metadata never authorizes replacement.
- Read, glob, grep, list, and task permissions preserve allow, deny, and ask exactly.
- The obsolete SDK client facade and reconciliation exports are removed from the package root.

Breaking: Remove the former `OpenCodeClientFacade`, `SdkOpenCodeClient`, and reconciliation helpers. Use the config hook and explicit runtime command projections instead.
