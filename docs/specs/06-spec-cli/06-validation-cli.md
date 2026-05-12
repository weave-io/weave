# Spec 06 Validation Report - CLI

**Validation Completed:** 2026-05-12  
**Validation Performed By:** AI Model  
**Spec:** [`06-spec-cli.md`](./06-spec-cli.md)  
**Tasks:** [`06-tasks-cli.md`](./06-tasks-cli.md)  
**Implementation Commit:** `05d7457 feat(cli): add weave command surface`

## 1) Executive Summary

- **Overall:** PASS
- **Implementation Ready:** Yes — all functional requirements are verified by accessible proof artifacts, source inspection, CLI checks, and repository quality gates.
- **Gates:**
  - Gate A: PASS — no CRITICAL or HIGH issues found.
  - Gate B: PASS — no `Unknown` entries in functional requirement coverage.
  - Gate C: PASS — all proof artifacts exist and contain working evidence.
  - Gate D: PASS — all core source/runtime changes map to Spec 06 tasks; unlisted supporting `.codesight/` files are generated metadata and have no runtime impact.
  - Gate E: PASS — repository standards are met by lint, typecheck, build, and test gates.
  - Gate F: PASS — no real credentials found in proof artifacts.
- **Key metrics:**
  - Requirements Verified: 100% (43/43 grouped functional requirements)
  - Proof Artifacts Working: 100% (5/5 proof files verified)
  - Files Changed vs Expected: 54 changed files; core changes are mapped to task relevant files or explicit CLI requirements. Supporting docs/proofs/generated metadata are linked to validation evidence.

## 2) Coverage Matrix

### Functional Requirements

| Requirement ID/Name                                                                             | Status   | Evidence                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1-FR1 Workspace includes CLI in Bun workflows                                                  | Verified | `package.json`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`; proof `06-task-01-proofs.md`; `bun run build`, `bun run typecheck` pass.                             |
| U1-FR2 CLI package exposes `weave` executable                                                   | Verified | `packages/cli/package.json` bin entry; `packages/cli/src/main.ts`; validation command `command -v weave` returned temporary proof binary.                                  |
| U1-FR3 Local PATH install is documented                                                         | Verified | `README.md`, `docs/cli.md`; proof `06-task-01-proofs.md`.                                                                                                                  |
| U1-FR4 Package-runner invocation examples are documented                                        | Verified | `README.md`, `docs/cli.md`; proof grep output in `06-task-01-proofs.md`.                                                                                                   |
| U1-FR5 PATH/package-runner command behavior uses same CLI surface                               | Verified | Single `bin` entry to built CLI; router in `packages/cli/src/cli.ts`; package-runner docs target same `--help` surface.                                                    |
| U1-FR6 `weave --help` lists commands and global flags                                           | Verified | `packages/cli/src/theme/render.ts`; routing/theme tests pass; independent `NO_COLOR=1 weave --help` showed `init` and `validate`.                                          |
| U1-FR7 Branded ASCII banner appears on primary entry points                                     | Verified | `packages/cli/src/theme/ascii-logo.ts`, `renderBanner`; proof `06-task-01-proofs.md`; theme tests pass.                                                                    |
| U1-FR8 Weave terminal theme is applied when color is supported                                  | Verified | `packages/cli/src/theme/colors.ts`; theme test verifies ANSI color output.                                                                                                 |
| U1-FR9 Plain text fallback works when color is disabled                                         | Verified | `NO_COLOR=1 weave --help` proof and independent validation command; theme tests verify no ANSI escapes.                                                                    |
| U1-FR10 `weave --version` prints package version                                                | Verified | `packages/cli/src/theme/render.ts`; independent command printed `0.0.1`; routing tests pass.                                                                               |
| U1-FR11 Exit codes for help/version/unknown command                                             | Verified | `packages/cli/src/__tests__/routing.test.ts`; proof `06-task-01-proofs.md`.                                                                                                |
| U2-FR1 Default `weave validate` validates effective project config                              | Verified | `packages/cli/src/commands/validate.ts` calls `loadConfig(fs.cwd())`; validate tests pass.                                                                                 |
| U2-FR2 `weave validate --global` validates global config                                        | Verified | Independent CLI validation and `06-task-02-proofs.md`; tests cover global validation.                                                                                      |
| U2-FR3 `weave validate --project` validates project config                                      | Verified | Independent CLI validation and `06-task-02-proofs.md`; tests cover project validation.                                                                                     |
| U2-FR4 `weave validate --path <file>` validates explicit file                                   | Verified | `validateExplicitPath` in `packages/cli/src/commands/validate.ts`; tests and proof artifacts.                                                                              |
| U2-FR5 `weave validate --json` emits valid JSON                                                 | Verified | `06-task-02-proofs.md` shows JSON parsed to counts; validate test parses JSON.                                                                                             |
| U2-FR6 Validation errors use file/line/column and exit `1`                                      | Verified | Independent invalid fixture command returned `invalid_exit=1` and `file:1:1`; `06-task-02-proofs.md`.                                                                      |
| U2-FR7 Success summary includes counts and log level without leaking content                    | Verified | `formatSummary` in `validate.ts`; proof summaries show agents/categories/workflows/disabled/log_level only.                                                                |
| U2-FR8 Root validation script delegates to CLI                                                  | Verified | `package.json` script `validate-config`: `bun packages/cli/src/main.ts validate --project`; pre-commit output passed.                                                      |
| U3-FR1 `weave init` creates `config.weave` and `prompts/`                                       | Verified | `packages/cli/src/commands/init.ts`; `06-task-03-proofs.md` file listings.                                                                                                 |
| U3-FR2 Global install defaults to `~/.weave`                                                    | Verified | `defaultInstallDir` in `init.ts`; tests and docs cover global scope.                                                                                                       |
| U3-FR3 Local install defaults to `<projectRoot>/.weave`                                         | Verified | `defaultInstallDir` in `init.ts`; tests and docs cover local scope.                                                                                                        |
| U3-FR4 Custom install directory via `--install-dir`                                             | Verified | Argument parser and init tests; proof uses fixture install directories.                                                                                                    |
| U3-FR5 Non-interactive `--scope <global\|local>`                                                | Verified | Argument parser, init command, and proof CLI invocations.                                                                                                                  |
| U3-FR6 Starter config validates and covers supported DSL concepts                               | Verified | `packages/cli/src/config/starter-config.ts`; generated config validated in tests and proof.                                                                                |
| U3-FR7 Existing config is not overwritten without `--force`                                     | Verified | `scaffoldConfig` skip path; `06-task-03-proofs.md` idempotent run.                                                                                                         |
| U3-FR8 `--force` creates `config.weave.bak` before overwrite                                    | Verified | `scaffoldConfig` backup path; `06-task-03-proofs.md` backup listing.                                                                                                       |
| U3-FR9 `--yes` / `-y` accepts safe defaults                                                     | Verified | `packages/cli/src/args.ts`, `init.ts`, init tests and CLI proofs.                                                                                                          |
| U3-FR10 Interactive wizard runs in TTY without decisive flags                                   | Verified | `createPlan` in `init.ts`; prompt wrapper tests cover prompt branches and cancellation.                                                                                    |
| U3-FR11 Wizard explains scope, install dir, harness detection/modules, confirmation, next steps | Verified | `init.ts` prompt flow; `prompt.test.ts`; `06-task-03-proofs.md` summary output.                                                                                            |
| U3-FR12 Non-TTY fallback does not hang and prints notice                                        | Verified | `init.test.ts` non-TTY fallback; proof task 03.                                                                                                                            |
| U3-FR13 Prompt cancellation exits code `0` with message                                         | Verified | `init.test.ts` cancellation test; prompt wrapper explicit result.                                                                                                          |
| U4-FR1 Detection returns `ResultAsync<DetectedHarness[], DetectionError>`                       | Verified | `packages/cli/src/detect/index.ts`; typecheck passes.                                                                                                                      |
| U4-FR2 Detected harness includes `id`, absolute `configPath`, optional `version`                | Verified | `DetectedHarness` type and detection tests for version/path.                                                                                                               |
| U4-FR3 Detection IDs include OpenCode, Claude Code, Pi and unsupported install reporting        | Verified | `SupportedHarnessId`; installer registry marks Claude Code/Pi unsupported.                                                                                                 |
| U4-FR4 Detection is side-effect free                                                            | Verified | `detect.test.ts` no-write assertion; `06-task-04-proofs.md` fixture config remains `{}`.                                                                                   |
| U4-FR5 Detection uses injectable file/process probes                                            | Verified | `packages/cli/src/detect/probes.ts`, `MemoryDetectionProbes`; tests pass.                                                                                                  |
| U4-FR6 Shared installer interface returns explicit `ResultAsync` errors                         | Verified | `packages/cli/src/installers/index.ts`; returns `ResultAsync<InstallResult, InstallError>` (richer success payload than spec text, same explicit error model); tests pass. |
| U4-FR7 Installers declare optional adapter modules                                              | Verified | `OpenCodeInstaller.optionalModules`; installer tests cover optional module install.                                                                                        |
| U4-FR8 Harness writes require confirmation or explicit flags                                    | Verified | `init.ts` uses selected harnesses only for explicit `--harness`/`--all-harnesses` or interactive confirmation; detection-only proof does not mutate config.                |
| U4-FR9 Installers are idempotent                                                                | Verified | `OpenCodeInstaller`; installer idempotency test and `06-task-05-proofs.md`.                                                                                                |
| U4-FR10 Unsupported/undetected explicit harnesses report clear errors and exit `1`              | Verified | `weave init --harness pi --yes` proof exits `1`; unsupported installer tests.                                                                                              |
| U4-FR11 `weave run` is not a runtime command                                                    | Verified | `packages/cli/src/commands/run.ts`, router message, `06-task-05-proofs.md` exits `1`.                                                                                      |

### Repository Standards

| Standard Area                            | Status   | Evidence & Compliance Notes                                                                                                    |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Bun-only runtime/package/test workflow   | Verified | `bun run lint`, `bun run typecheck`, `bun run build`, `bun test` all pass; package scripts use Bun.                            |
| `neverthrow` fallible APIs               | Verified | CLI command helpers and filesystem/detection/installers use `Result`/`ResultAsync`; typecheck passes.                          |
| Mockable file/process/harness boundaries | Verified | `MemoryFileSystem`, `MemoryDetectionProbes`, `StaticPromptAdapter`; tests use fixtures and no real harness process.            |
| No scattered `console.*`                 | Verified | Output centralized in `packages/cli/src/io/terminal.ts` with Biome ignore at the boundary; `bun run lint` passes.              |
| Adapter boundary compliance              | Verified | Detection/installer logic remains in `@weave/cli`; no core/engine harness discovery changes.                                   |
| Tests alongside modules                  | Verified | CLI tests live under `packages/cli/src/**/__tests__/`; full suite passes 298 tests.                                            |
| Documentation updated                    | Verified | `docs/cli.md` and `README.md` cover CLI install, package runners, `init`, `validate`, no runtime execution, security guidance. |
| Proof security                           | Verified | Secret grep over proof docs found no credential patterns; only documentation mentions placeholders/security terms.             |

### Proof Artifacts

| Unit/Task                        | Proof Artifact                                          | Status   | Verification Result                                                                                                                 |
| -------------------------------- | ------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1.0 CLI package/executable/theme | `docs/specs/06-spec-cli/06-proofs/06-task-01-proofs.md` | Verified | Exists, front-loads context, shows PATH `weave`, help/version/NO_COLOR, package-runner docs, routing/theme tests, build/typecheck.  |
| 2.0 Validate command             | `docs/specs/06-spec-cli/06-proofs/06-task-02-proofs.md` | Verified | Exists, shows project/global/path/JSON validation, invalid fixture exit `1`, validate tests pass.                                   |
| 3.0 Init scaffolding/prompt flow | `docs/specs/06-spec-cli/06-proofs/06-task-03-proofs.md` | Verified | Exists, shows global/local init, generated validation, idempotency, backup, init/prompt tests.                                      |
| 4.0 Harness detection            | `docs/specs/06-spec-cli/06-proofs/06-task-04-proofs.md` | Verified | Exists, shows detection tests, no-write assertion, fixture-backed detection-only init preserving config.                            |
| 5.0 Installer/docs/run behavior  | `docs/specs/06-spec-cli/06-proofs/06-task-05-proofs.md` | Verified | Exists, shows installer tests, OpenCode install, Pi unsupported exit `1`, bulk skip, `weave run` exit `1`, docs review, full gates. |

## 3) Validation Issues

No CRITICAL, HIGH, MEDIUM, or LOW validation issues were found.

Notes that do not require action:

- `.codesight/*` files were changed by the repository's pre-commit `codesight` hook. They are supporting generated metadata, not runtime source/config, and do not trip Gate D.
- `HarnessInstaller.install` returns `ResultAsync<InstallResult, InstallError>` instead of the spec prose's narrower `ResultAsync<void, InstallError>`. This is traceable to Task 5.1's explicit `InstallResult` type and improves CLI messaging while preserving explicit `ResultAsync` error handling.
- `docs/cli.md` received a formatting-only table cleanup in the validation commit; it is supporting documentation formatting and does not affect spec compliance.

## 4) Evidence Appendix

### Git commits analyzed

```text
05d7457 feat(cli): add weave command surface
- Adds @weave/cli package, init/validate/run commands, prompt wrapper, detection, installers, tests, docs, and proof artifacts.
- Commit message footer: Related to T1-T5 in Spec 06.

cd3583a docs(cli): validate spec implementation
- Adds this validation report and formatting-only CLI documentation cleanup.
```

### Changed-file classification

- **Core implementation/runtime files:** `package.json`, `bun.lock`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`, `packages/cli/package.json`, and `packages/cli/src/**` production modules. All map to Spec 06 Tasks 1.1-5.11.
- **Supporting verification files:** `packages/cli/src/**/__tests__/**`, `packages/cli/src/__fixtures__/**`, `docs/specs/06-spec-cli/06-proofs/**`, `docs/cli.md`, `README.md`, and Spec 06 planning files. All support CLI proof and requirement verification.
- **Generated metadata:** `.codesight/**` from pre-commit analysis. No runtime impact.

### Commands executed during validation

```bash
find ./docs/specs -maxdepth 2 -type f -name '*-tasks-*.md' | sort
git log --stat -10 --oneline
git show --name-only --format='' 05d7457
bun run lint
bun run typecheck
bun run build
bun test
```

Validation gate output summary:

```text
bun run lint       -> PASS (Checked 70 files)
bun run typecheck  -> PASS (@weave/core, @weave/config, @weave/engine, @weave/adapter-opencode, @weave/cli)
bun run build      -> PASS (all workspace packages build)
bun test           -> PASS (298 pass, 0 fail, 754 expect() calls)
```

Independent CLI checks:

```text
command -v weave -> /tmp validation proof binary
weave --version -> 0.0.1
NO_COLOR=1 weave --help -> lists init and validate
weave validate --project -> valid summary
weave validate --global -> valid summary
weave validate --path invalid.weave -> file:1:1 error, exit 1
```

### Security scan

Command:

```bash
grep -R -nE '(api[_-]?key|access[_-]?token|secret|password|BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]|ghp_[A-Za-z0-9]|xox[baprs]-)' docs/specs/06-spec-cli/06-proofs docs/cli.md README.md packages/cli || true
```

Result: no credential material found in proof artifacts. Matches are documentation/security guidance terms only; ignored `.pi-lens` cache matches are local generated analysis metadata and are gitignored.
