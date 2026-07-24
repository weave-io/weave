# @weaveio/weave-adapter-pi

Pi adapter for the Weave orchestration framework. Targets the Earendil Works
Pi fork (`@earendil-works/pi-coding-agent`, `>=0.81.1 <0.82.0`) in interactive
TUI parent sessions only.

Install as a Pi package:

```bash
pi install npm:@weaveio/weave-adapter-pi
```

See `docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md` in the Weave
repository for the full normative contract this package implements.

## Status

This package currently ships the activation, normalized-configuration, and
registered-tool-policy slices: exact host checks, trust-aware safe initialization,
effective capability health reporting, ordered agent materialization, Loom
primary activation, exact composed-prompt append, Pi-owned skill/model context,
and deterministic model intent. It also provides provenance-aware native-tool
coverage, input-aware permission resolvers, allow/deny/ask enforcement, bounded
approval UI, single-use permit consumption, and unmanaged third-party tool
passthrough. Durable approvals, concrete Weave-owned tools, workflows,
delegation, persistence, and plan/artifact projection land in later releases.
