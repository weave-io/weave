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

This package currently ships the activation and normalized-configuration
slices: exact host checks, TUI-only and project-trust-aware safe initialization,
effective capability health reporting, health-only command gating, ordered
agent materialization, Loom primary activation, exact composed-prompt append,
Pi-owned skill/model context, deterministic model intent, and visible
model/temperature degradation. Tool-policy enforcement, workflows, delegation,
and plan/artifact projection land in later releases.
