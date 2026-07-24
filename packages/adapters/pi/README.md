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

This package currently ships the activation foundation: exact host
compatibility checks, TUI-only and project-trust-aware safe initialization,
effective capability health reporting, and health-only mode gating for the
`/weave:*` command shells. Agent materialization, workflows, delegation, and
plan/artifact support land in later releases.
