---
"@weaveio/weave-adapter-opencode2": patch
"@weaveio/weave-cli": patch
---

Model recommendations fixes found by Spec 39's live proof.

- OpenCode 2: the `weave.status` RPC no longer fails with
  `InvalidRequestError: Expected JSON value` while an unusable `applied.json`
  is skipped. It returns `modelUpdates` with `state: unavailable` and the
  `model_updates_unavailable` issue, as documented (#303).
- The request for a recommendations list now sends a fixed
  `User-Agent: weave-model-recommendations/1`, the same from every harness and
  from `weave models update`. Before, the runtime's default went out, and on
  OpenCode 2 that named the harness and its version
  (`opencode/latest/2.0.16/cli`) (#304).

Bundled-source: @weaveio/weave-config
