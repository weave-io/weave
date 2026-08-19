---
"@weaveio/weave-adapter-pi": patch
---

Run delegated Pi agents as authenticated ephemeral RPC children.

- A delegated agent runs as a `pi --mode rpc --no-session` child with strict LF framing and HMAC-authenticated control envelopes.
- Bootstrap context, model and active-tool projection, and budgets stay bounded and portable, with per-parent queues, nested delegation relay, cancellation, cleanup, and usage accounting.
- The TUI exposes the child tree, and ordinary delegation returns the child's bounded final assistant output.
- The Pi AI and TUI peer packages are now required, because the transport imports their TypeBox and key-matching APIs at runtime.
