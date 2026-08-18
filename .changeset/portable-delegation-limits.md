---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
"@weaveio/weave-adapter-claude-code": minor
---

Cap delegation with portable limits that every harness can enforce.

- Merged caps are validated where they are declared, so an invalid limit fails at configuration time.
- Effective limits resolve deterministically from the merged configuration.
- Delegation authorization is harness-neutral, so the same limits hold across adapters.
