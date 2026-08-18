# Config

## Environment Variables

- `BASE_PATH` (has default) — packages/docs/astro.config.mjs
- `BUN_INSTALL` (has default) — scripts/pi/child-stream-capture.ts
- `GITHUB_OUTPUT` **required** — scripts/release/stable-finalize.ts
- `GITHUB_TOKEN` **required** — scripts/release/bind-artifacts.ts
- `HOME` (has default) — packages/adapters/pi/src/__tests__/config-activator.test.ts
- `LOG_LEVEL` (has default) — packages/config/src/logger.ts
- `PATH` **required** — packages/adapters/pi/src/__tests__/child-env.test.ts
- `PI_BIN` (has default) — scripts/release/pi-child-inspection-smoke.ts
- `PI_CHILD_SMOKE_DEBUG` **required** — scripts/release/pi-child-inspection-smoke.ts
- `PI_CHILD_SMOKE_RUN_ATTEMPT` (has default) — scripts/release/pi-child-inspection-smoke.ts
- `PI_CODING_AGENT_DIR` (has default) — scripts/release/pi-child-inspection-smoke.ts
- `PWD` (has default) — packages/adapters/opencode/dist-types/adapter.d.ts
- `RELEASE_APP_TOKEN` **required** — scripts/release/release-refs-main.ts
- `RELEASE_AWAITING_STABLE_TRAIN` **required** — scripts/release/release-refs-main.ts
- `RELEASE_CONTROL_DRY_RUN` **required** — scripts/release/control-main.ts
- `RELEASE_GITHUB_API_URL` **required** — scripts/release/control-main.ts
- `RELEASE_HEAD_REF` **required** — scripts/release/control-main.ts
- `RELEASE_HEAD_SHA` **required** — scripts/release/control-main.ts
- `RELEASE_METADATA_REPLAY_INPUT` **required** — scripts/release/metadata-replay-main.ts
- `RELEASE_OPERATION` **required** — scripts/release/packager.ts
- `RELEASE_PAYLOAD_DIRECTORY` **required** — scripts/release/release-refs-main.ts
- `RELEASE_PLANNED_VERSIONS` **required** — scripts/release/packager.ts
- `RELEASE_PROGRESSED_STABLE_TRAIN` **required** — scripts/release/release-refs-main.ts
- `RELEASE_PROMOTION_AUTHORIZATION` **required** — scripts/release/release-refs-main.ts
- `RELEASE_PUBLISH_ENABLED` **required** — scripts/release/dry-run-nightly.ts
- `RELEASE_RELEASE_NOTES` **required** — scripts/release/release-refs-main.ts
- `RELEASE_RUN_ATTEMPT` **required** — scripts/release/control-main.ts
- `RELEASE_RUN_ID` **required** — scripts/release/control-main.ts
- `RELEASE_STABLE_PLAN_INPUT` **required** — scripts/release/stable-plan-main.ts
- `RELEASE_STABLE_TRAIN` **required** — scripts/release/stable-finalize.ts
- `RELEASE_SUBJECT_SHA` **required** — scripts/release/write-artifact-manifest.ts
- `RELEASE_WORKFLOW_SHA` **required** — scripts/release/control-main.ts
- `RUN_HARNESS_SMOKE` **required** — packages/adapters/opencode/src/__tests__/category-routing-smoke.test.ts
- `SECRET_VALUE` **required** — scripts/pi/__tests__/child-stream-capture.test.ts
- `SITE_URL` (has default) — packages/docs/astro.config.mjs
- `USERPROFILE` (has default) — packages/adapters/pi/src/config-source-digests.ts
- `VOLTA_HOME` (has default) — scripts/release/pi-child-inspection-smoke.ts
- `WEAVE_CLI_VERSION` (has default) — packages/cli/src/theme/render.ts
- `WEAVE_LOG_FILE` **required** — packages/engine/src/env.ts
- `WEAVE_PI_DESCRIPTOR_RELATIVE_SESSION_IO` **required** — packages/adapters/pi/src/__tests__/required-capability-gate.test.ts
- `WEAVE_PI_UNSAFE_ENABLE_SESSION_IO` **required** — packages/adapters/pi/src/__tests__/required-capability-gate.test.ts
- `WEAVE_RELEASE_FORCE_SCENARIO_FAILURE` **required** — scripts/release/verification-harness.ts

## Config Files

- `tsconfig.json`
