---
"@weaveio/weave-adapter-opencode2": patch
---

Loom and Tapestry are offered only agents that actually reached OpenCode. Previously a category whose prompt failed to compose, or a Weave agent whose name another plugin already held (for example `shuttle-web`), still appeared in the delegation table, so delegating to it failed. The adapter now reads the host's agent list, reports Weave agents whose id is already taken, and leaves them out of the delegation targets with a warning.
