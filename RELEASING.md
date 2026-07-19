# Releasing Weave

This is the operator runbook for public Weave releases. The durable design is in
[release automation](docs/release-automation.md).

## Non-negotiable rules

Every release PR must link its related issue. The clean room creates sanitized
public packs only: CLI and OpenCode publish on stable/nightly trains; standalone
Claude is nightly-only and Claude is bundled in the CLI. Core, config, and engine
are private bundled layers and must never be recommended as npm installs.

Before first publication configure npm trusted publishing for `weave-io/weave`
`publish.yml`, protect `main` and release environments, and record GitHub App
release-ref authority. `preview` is retired; historical versions remain under the
no-unpublish policy.

- Public artifacts are immutable. Never republish a version or replace a tarball.
- GitHub Actions publishes `nightly` and stable-train `next` artifacts with npm
  trusted publishing (OIDC). It never receives an npm automation token.
- **Fully automatic tokenless `latest` promotion is impossible today.** npm
  trusted publishing cannot execute `npm dist-tag add`; see
  [npm/cli#8547](https://github.com/npm/cli/issues/8547). Do not work around
  this with a token.
- The interactive MFA exception requires two maintainers to approve the
  exception/block state. If either declines, mark the train blocked and do not
  promote. Task 22 records the live evidence.

If policy later forbids this exception, hard-disable stable promotion until npm
officially supports trusted-publisher dist-tag mutation and the entire behavior
has been retested. Never introduce an automation token.

## Normal lifecycle

1. **Nightly:** dispatch or wait for `nightly`; install and test the immutable
   nightly packages as needed.
2. **Cut:** dispatch `stable-cut`, review its plan, and create the protected
   stable train reference using the approved release-ref procedure.
3. **Fix:** apply any train fix through `stable-fix`; rebind/rebuild after every
   fix because old artifact identity is invalid.
4. **Publish next:** approve the `release` environment for `stable-publish`.
   The OIDC job publishes CLI and OpenCode only under `next` and proves both
   registry tarball SHA-256 values.
5. **Dual verification:** save the emitted promotion-authorization JSON. It
   binds subject SHA, package names, versions, and artifact digests. Do not
   proceed if either `next` tag or tarball digest disagrees.
6. **Second-maintainer MFA promotion:** a different maintainer signs in to npm
   interactively with MFA, records prior `latest`, then moves both tags.
7. **Finalize:** dispatch `stable-finalize` with the exact saved authorization
   JSON. Its read-only job verifies both `latest` versions and unauthenticated
   registry tarball SHA-256s. It finalizes nothing on a mismatch.
8. **Post-finalize:** the isolated `release-refs` environment downloads the
   verified payload by numeric artifact ID and uses its GitHub App token (not
   `GITHUB_TOKEN`) to create create-once tags and immutable releases. A
   lightweight App tag is recorded as `unsigned` when GitHub exposes no
   signature verification; this accepted fallback is not a failure. GitHub's
   platform-generated immutable-release attestation must be present. Then create
   the metadata replay PR and clean up the train branch only through its approved
   workflow.

## Manual promotion and rollback

The second maintainer must first record both outputs in the release evidence:

```bash
npm dist-tag ls @weaveio/weave-cli --json
npm dist-tag ls @weaveio/weave-adapter-opencode --json
```

After the authorization record has been reverified, run its exact pinned output:

```bash
npm dist-tag add @weaveio/weave-cli@X.Y.Z latest
npm dist-tag add @weaveio/weave-adapter-opencode@A.B.C latest
```

Replace neither version with `latest`, `next`, or a range. If the second move
fails, do not dispatch finalize. Restore the first tag to the **recorded** prior
value, mark the train `partial`, and preserve evidence:

```bash
npm dist-tag add @weaveio/weave-cli@RECORDED_PRIOR_X.Y.Z latest
# Or, if OpenCode was the first move:
npm dist-tag add @weaveio/weave-adapter-opencode@RECORDED_PRIOR_A.B.C latest
```

Use the promotion-rollback verifier only after this interactive restore; it
proves the registry is back at both recorded prior versions.

## STOP evidence checklist

Stop and block the train if any item is absent or mismatched:

- Task 1: protected-control identity and approved release environment evidence.
- Task 12: approved release-ref/App authority evidence (manual until recorded).
- Task 16: approved npm trusted-publisher/OIDC environment evidence (manual
  until recorded).
- Stable-publish authorization, both `next` tags, and both tarball SHA-256s.
- Two maintainer approvals plus prior-`latest` capture and interactive MFA
  proof.

## Failure, recovery, and cleanup

- A train may be cleanly abandoned only before publication (`prepared`, `built`,
  or `bound`). An expired train may only be abandoned; cut a new train from
  current `main`. Do not publish, finalize, or apply a train fix after expiry.
- Every rebuild, rerun (including a new Actions attempt), and approved fix
  invalidates the prior artifact IDs and manifest digest. Bind the new identity
  before publication.
- If npm publication or promotion is partial, mark the train `partial`: never
  promote or finalize it. Write the content-addressed recovery metadata with all
  consumed versions, restore only the affected `latest` dist-tag interactively,
  fix on `main`, and cut fresh. The planner skips reserved versions; npm versions
  are never reused.
- A blocked metadata collision serializes trains. Resolve it through the metadata
  replay path; delete `release/*` only after the metadata PR is merged. A draft
  release may be reconciled or abandoned while still a draft; published releases
  are immutable.
- After promotion/finalization, all fixes are main-first patches and a new cut.
  Never mutate a train, npm version, GitHub tag/release, or attestation in place.

## Two-person break-glass

Break-glass is an incident response, never a standing bypass. Create and link an
incident, then name four distinct accountable roles: **approver**, **executor**,
**recorder**, and **restorer**. Two maintainers must approve the specific,
time-bounded change before execution. The recorder logs the expected Git head,
artifact checksums, commands, start/end time, and both approvals.

Immediately after the narrowly scoped change, the restorer returns normal
controls, rotates any used key, revokes temporary access, and records proof.
Publish a postmortem with the incident timeline and follow-up actions. Never use
break-glass to force-update an immutable ref or mutate npm versions, GitHub tags,
releases, or attestations. An emergency interactive rollback moves **only npm
dist-tags**; those immutable records remain unchanged.
