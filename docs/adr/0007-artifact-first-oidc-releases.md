# ADR 0007 — Artifact-First OIDC Releases

## Context

Public packages must be published without long-lived npm automation credentials while preserving a verifiable link from protected release control to registry tarballs and GitHub releases.

## Decision

We release only the CLI, OpenCode adapter, and nightly standalone Claude Code adapter. Core, config, and engine remain internal bundled layers. Protected workflow control builds sanitized public packs, binds their digests to immutable Actions artifact identity, and publishes `nightly` or `next` through npm trusted publishing (OIDC) from `weave-io/weave` `publish.yml`.

`latest` remains a two-maintainer interactive MFA promotion after the OIDC `next` verification; no token-based workaround is permitted. Immutable GitHub Releases retain the exact `.tgz` files and SHA-256 checksums. We accept platform immutable-release attestations, but deliberately exclude custom attestations and SBOMs. Published versions are never unpublished or replaced.

## Consequences

- Operators follow [RELEASING.md](../../RELEASING.md) and [Release Automation](../release-automation.md), including recovery and protected-main evidence.
- Consumers install supported public packages only and verify immutable version/checksum records rather than trusting tags alone.
- `preview` is retired; historical preview versions remain published but are not recommended.
- Release PRs link their related issue so the immutable release record has review context.
