# CI/CD Pipelines

## GitHub Actions (10 workflows)

| Workflow | Triggers | Jobs | Deploy | Environments |
|---|---|---|---|---|
| Agent Evals | workflow_dispatch | 2 | — | — |
| CI | push, pull_request | 3 | — | — |
| Deploy Docs | push, workflow_dispatch | 2 | — | github-pages |
| Docs audit follow-up | workflow_dispatch | 4 | — | release-ai, release-app, docs-audit-patch |
| Docs audit | pull_request | 4 | — | release-ai |
| Publish control plane | schedule, workflow_dispatch | 8 | — | ${{ needs.preflight.outputs.operation == 'stable-publish' && 'release' \|\| '' }}, release, release-refs |
| Attest stable release artifacts | workflow_dispatch | 1 | — | — |
| Publish stable release | pull_request, workflow_dispatch | 10 | — | ${{ inputs.channel == 'nightly' && '' \|\| 'release-app' }}, ${{ inputs.channel == 'nightly' && '' \|\| 'harness-proof' }}, ${{ inputs.channel == 'next' && 'prerelease' \|\| (inputs.channel == 'nightly' && '' \|\| 'release') }} |
| Prepare stable release PR | workflow_dispatch | 14 | — | release-app, release-ai |
| Regenerate stable release PR | push, workflow_dispatch | 7 | — | release-app, release-ai |

### Agent Evals

> `.github/workflows/agent-evals.yml`

- **validate-inputs** on `ubuntu-latest` — 1 steps
- **run-evals** on `ubuntu-latest` — 7 steps (needs: validate-inputs)
  - `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02`

### CI

> `.github/workflows/ci.yml`

> Concurrency: `${{ github.workflow }}-${{ github.ref }}`

- **ci** on `ubuntu-latest` — 11 steps
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
- **release-policy** on `ubuntu-latest` — 4 steps
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
- **api-reports** on `ubuntu-latest` — 5 steps
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`

### Deploy Docs

> `.github/workflows/deploy-docs.yml`

> Concurrency: `github-pages`

- **build** on `ubuntu-latest` — 6 steps
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/upload-pages-artifact@b8130d9ab958b325bbde9786d62f2c97a9885a0e`
- **deploy** on `ubuntu-latest` — 1 steps (needs: build)
  - `actions/deploy-pages@1f0c5cde4bc74cd7e1254d0cb4de8d49e9068c7d`

### Docs audit follow-up

> `.github/workflows/docs-audit-followup.yml`

- **followup-audit** on `ubuntu-latest` — 5 steps
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **followup-post** on `ubuntu-latest` — 5 steps (needs: followup-audit)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
- **docs-audit** on `ubuntu-latest` — 5 steps (needs: followup-audit, followup-post)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
- **apply-patches** on `ubuntu-latest` — 6 steps (needs: followup-audit)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`

### Docs audit

> `.github/workflows/docs-audit.yml`

- **docs-deterministic** on `ubuntu-latest` — 5 steps
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **docs-ai-audit** on `ubuntu-latest` — 5 steps (needs: docs-deterministic)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **docs-ai-fork-skip** on `ubuntu-latest` — 1 steps (needs: docs-deterministic)
- **docs-audit** on `ubuntu-latest` — 6 steps (needs: docs-deterministic, docs-ai-audit)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`

### Publish control plane

> `.github/workflows/publish.yml`

> Concurrency: `publish`

- **preflight** on `ubuntu-latest` — 4 steps
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
- **build** on `ubuntu-latest` — 9 steps (needs: preflight)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **bind** on `ubuntu-latest` — 7 steps (needs: preflight, build)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **publish** on `ubuntu-latest` — 10 steps (needs: preflight, build, bind)
  - `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
- **stable-plan** on `ubuntu-latest` — 4 steps (needs: preflight)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
- **metadata-replay-plan** on `ubuntu-latest` — 5 steps (needs: preflight)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
- **stable-finalize** on `ubuntu-latest` — 4 steps (needs: preflight)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
- **release-refs** on `ubuntu-latest` — 5 steps (needs: preflight, stable-finalize)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`

### Publish stable release

> `.github/workflows/release-publish.yml`

> Concurrency: `release-publish-${{ inputs.channel || 'stable' }}`

- **route** on `ubuntu-latest` — 5 steps
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
- **recompute** on `ubuntu-latest` — 6 steps (needs: route)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **build-bind** on `ubuntu-latest` — 6 steps (needs: recompute)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **await-attest** on `ubuntu-latest` — 6 steps (needs: build-bind)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
- **consumer-proof** on `ubuntu-latest` — 5 steps (needs: await-attest)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
- **harness-proof** on `ubuntu-latest` — 5 steps (needs: consumer-proof)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
- **release-approval** on `ubuntu-latest` — 6 steps (needs: harness-proof)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
- **publish** on `ubuntu-latest` — 6 steps (needs: release-approval)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **registry-verification** on `ubuntu-latest` — 5 steps (needs: publish)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
- **refs-cleanup** on `ubuntu-latest` — 5 steps (needs: registry-verification)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`

### Prepare stable release PR

> `.github/workflows/release-stable-prepare.yml`

- **authorize** on `ubuntu-latest` — 4 steps
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
- **plan** on `ubuntu-latest` — 5 steps (needs: authorize)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **docs-release-audit** on `ubuntu-latest` — 6 steps (needs: plan)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **changelog-ai** on `ubuntu-latest` — 7 steps (needs: plan, docs-release-audit)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **open-pr** on `ubuntu-latest` — 7 steps (needs: authorize, plan, docs-release-audit, changelog-ai)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
- **plan-2** on `ubuntu-latest` — 5 steps (needs: open-pr)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **docs-release-audit-2** on `ubuntu-latest` — 6 steps (needs: plan-2)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **changelog-ai-2** on `ubuntu-latest` — 7 steps (needs: plan-2, docs-release-audit-2)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **open-pr-2** on `ubuntu-latest` — 7 steps (needs: plan-2, docs-release-audit-2, changelog-ai-2)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
- **plan-3** on `ubuntu-latest` — 5 steps (needs: open-pr-2)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **docs-release-audit-3** on `ubuntu-latest` — 6 steps (needs: plan-3)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **changelog-ai-3** on `ubuntu-latest` — 7 steps (needs: plan-3, docs-release-audit-3)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **open-pr-3** on `ubuntu-latest` — 7 steps (needs: plan-3, docs-release-audit-3, changelog-ai-3)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
- **recovery-summary** on `ubuntu-latest` — 1 steps (needs: authorize, plan, docs-release-audit, changelog-ai, open-pr, plan-2, docs-release-audit-2, changelog-ai-2, open-pr-2, plan-3, docs-release-audit-3, changelog-ai-3, open-pr-3)

### Regenerate stable release PR

> `.github/workflows/release-stable-regenerate.yml`

- **manual-authorize** on `ubuntu-latest` — 4 steps
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
- **detect** on `ubuntu-latest` — 5 steps (needs: manual-authorize)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
- **plan** on `ubuntu-latest` — 5 steps (needs: detect)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **docs-release-audit** on `ubuntu-latest` — 6 steps (needs: plan)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **changelog-ai** on `ubuntu-latest` — 7 steps (needs: plan, docs-release-audit)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/upload-artifact@0b7f8abb1508181956e8e162db84b466c27e18ce`
- **update-pr** on `ubuntu-latest` — 7 steps (needs: detect, plan, docs-release-audit, changelog-ai)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
  - `actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093`
- **recovery-summary** on `ubuntu-latest` — 1 steps (needs: manual-authorize, detect, plan, docs-release-audit, changelog-ai, update-pr)

### Secrets

- `EVAL_RESULTS_REPO_TOKEN`
- `OPENROUTER_API_KEY`
- `RELEASE_APP_TOKEN`
- `WEAVE_RELEASE_AI_API_KEY`

---
_Source: .github/workflows/agent-evals.yml, .github/workflows/ci.yml, .github/workflows/deploy-docs.yml, .github/workflows/docs-audit-followup.yml, .github/workflows/docs-audit.yml, .github/workflows/publish.yml, .github/workflows/release-attest.yml, .github/workflows/release-publish.yml, .github/workflows/release-stable-prepare.yml, .github/workflows/release-stable-regenerate.yml_
_Generated by codesight-cicd-plugin_
