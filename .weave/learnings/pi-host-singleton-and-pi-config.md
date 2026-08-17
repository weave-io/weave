# Learnings: pi-host-singleton-and-pi-config

## Task 14: full repository validation (2026-08-17)

- **Status**: PASS. Every required command exited `0`.
- **Subject**: repository HEAD `81dd8d0` (`docs(pi): document the host singleton and child extension config`), branch `feat/pi-native-child-stream-rendering`.
- **Environment**: Bun `1.4.0` (test runner reported `1.4.0-canary.1`), TypeScript `5.9.3`, Pi host `0.84.2` at `/Users/jose/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`, macOS.
- **Working tree note**: the checkout also carried unrelated, uncommitted config-activation work owned by another session (`docs/adapters/pi.md`, `packages/adapters/pi/src/config-activator.ts`, `src/extension-impl.ts`, `src/safe-initializer.ts`, `src/config-activation-diagnostics.ts`, and two of their tests). Every command below ran against those current bytes. The files were verified byte-identical before and after this task and were never staged.

### Command results

| Command | Exit | Result |
| --- | --- | --- |
| `bun test` | 0 | 9647 pass, 11 skip, 0 fail; 9658 tests across 338 files |
| `bun run --filter '@weaveio/weave-adapter-pi' test` | 0 | **3420 pass, 0 fail** across 160 Pi package test files |
| `bun run typecheck` | 0 | no errors across the root, `scripts/`, and every workspace |
| `bun run lint` | 0 | Biome: 0 errors (362 warnings, 71 infos, all pre-existing); declaration validation clean |
| `bun run build` | 0 | public packages plus the docs site; both Pi extension artifacts emitted |
| `bun run docs:check-links` | 0 | `Checked local documentation links` |
| `bun run validate-config` | 0 | `Weave config is valid.` |
| `bun run changeset:check` | 0 | `Changeset policy passed` |
| `bun run verify:pi-host-singleton` | 0 | `PASS`, positive `single-copy`, negative control `duplicate-detected` |

`bun test` at the repository root is Bun's own runner over the whole workspace, so it prints one aggregate summary and no per-package count. The Pi package count above therefore comes from the package's own `test` script (`bun test src`), run against the same bytes.

### Build artifacts

Rebuilt before the singleton proof so the script inspected current bytes.

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `packages/adapters/pi/dist/extension.js` | 486 | `39204d150dff6cd54cc0187f281c1466b46f6356333caab38f38ed44bf381aae` |
| `packages/adapters/pi/dist/extension-impl.js` | 1903627 | `0308179f56bb1541a93c5c9da8d91c3cb47ad508c0f99cfa4ae996cb9d65c259` |

`grep -c "@earendil-works/" packages/adapters/pi/dist/extension.js` returned `0`, so the shipped loader entry still carries no bare Pi import.

### Host singleton proof

`bun run verify:pi-host-singleton` reported:

```
PASS hostVersion=0.84.2
artifactSha256=39204d150dff6cd54cc0187f281c1466b46f6356333caab38f38ed44bf381aae
positive=single-copy negative=duplicate-detected
```

The digest in the proof line equals the freshly built `dist/extension.js` digest, so the proof and the recorded artifact are the same bytes. The negative control (`WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT=1`) still detects the duplicate, so the detector is not vacuously passing. No spawned `pi` process survived the run.

### Notes

- No production or test file was modified for this task. No validation failure was traced to this plan, so no fix was needed.
- This is a repository-level proof only. Task 15 still owns the real interactive Pi host proof (readiness, `/weave:pi-config`, child argv, `lsof` mapping, lease state).
- Task 14 is the only checkbox changed in `.weave/plans/pi-host-singleton-and-pi-config.md`.
