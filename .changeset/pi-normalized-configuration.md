---
"@weaveio/weave-adapter-pi": minor
---

Project normalized Weave configuration into a Pi session.

- Activation is trust-aware, and materialization runs in a deterministic order.
- Loom holds primary state, and the composed prompt is appended exactly.
- Skill and model context stay Pi-owned, and model intent is deterministic.
- A model or temperature the host cannot honor degrades visibly instead of silently.
