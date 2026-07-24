---
"@weaveio/weave-adapter-pi": patch
---

Add authenticated private RPC delegation transport to the Pi adapter.

Delegated agents now run as ephemeral `pi --mode rpc --no-session` children with strict LF framing, HMAC-authenticated control envelopes, bounded bootstrap context, exact model and active-tool projection, portable budgets, per-parent queues, nested delegation relay, cancellation, cleanup, usage accounting, and an inspectable TUI child tree. Ordinary delegation returns the child's bounded final assistant output.

Require the Pi AI and TUI peer packages because the transport now imports their TypeBox and key-matching APIs at runtime.
