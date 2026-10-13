---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode2": minor
"@weaveio/weave-adapter-claude-code": minor
---

Stable 0.3.0 on `latest`:

- **Claude-first default models.** Weft and Warp run on Opus 5.5, Spindle on Sonnet 5.5 and Thread on Claude Haiku 5.5. Loom, Tapestry and Pattern stay on Opus 5.5, and Shuttle on Sonnet 5.5. Each change was chosen with evals (`docs/artifacts/eval-default-models-2026-10-12.md`).
- **Opt-in model recommendations (Spec 39).** Add `settings { model_updates { mode notify } }` (or `auto`) to have the builtin agents' model lists follow a signed list published on tryweave.io, without upgrading Weave. New `weave models status | update | apply | pin | check` commands. Off by default.
- **Fixes.** OpenCode 2's `weave.status` keeps working when a recommendations list can't be used (#303), and the recommendations request sends a fixed User-Agent (#304).
