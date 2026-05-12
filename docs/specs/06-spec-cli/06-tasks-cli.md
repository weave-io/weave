## Relevant Files

| File                                                       | Why It Is Relevant                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `package.json`                                             | Root workspace manifest; must add `packages/cli`, update scripts, and keep package-runner assumptions aligned.    |
| `tsconfig.json`                                            | Root typecheck include/paths; must include CLI source and `@weave/cli` path alias if needed.                      |
| `tsconfig.build.json`                                      | Root build references; must include the CLI package build config.                                                 |
| `biome.json`                                               | Lint scope; must include CLI source while preserving no-console and filename rules.                               |
| `README.md`                                                | User-facing package list and CLI invocation documentation.                                                        |
| `docs/cli.md`                                              | New detailed CLI guide covering install, package runners, init, validate, and non-goals.                          |
| `docs/specs/06-spec-cli/06-spec-cli.md`                    | Source specification for requirement traceability.                                                                |
| `packages/cli/package.json`                                | New CLI package manifest, `bin` entry, scripts, dependencies, and package metadata.                               |
| `packages/cli/tsconfig.json`                               | CLI package typecheck configuration.                                                                              |
| `packages/cli/tsconfig.build.json`                         | CLI package declaration/build configuration.                                                                      |
| `packages/cli/src/index.ts`                                | CLI package public exports for command handlers and testable modules.                                             |
| `packages/cli/src/main.ts`                                 | Executable entry point that invokes the CLI boundary and exits with the returned code.                            |
| `packages/cli/src/cli.ts`                                  | Top-level CLI router for global flags, command dispatch, and unknown-command behavior.                            |
| `packages/cli/src/args.ts`                                 | Argument parsing helpers for `--help`, `--version`, `init`, `validate`, and compatibility handling for `run`.     |
| `packages/cli/src/errors.ts`                               | Shared discriminated-union CLI error types and formatting helpers.                                                |
| `packages/cli/src/io/terminal.ts`                          | Centralized terminal output boundary for stdout/stderr without scattering `console.*`.                            |
| `packages/cli/src/theme/ascii-logo.ts`                     | Checked-in Weave ASCII logo derived from the referenced logo.                                                     |
| `packages/cli/src/theme/colors.ts`                         | Theme tokens and `NO_COLOR`/TTY color decision helpers.                                                           |
| `packages/cli/src/theme/render.ts`                         | Banner/help rendering helpers for themed and plain-text output.                                                   |
| `packages/cli/src/commands/validate.ts`                    | `weave validate` implementation.                                                                                  |
| `packages/cli/src/commands/init.ts`                        | `weave init` orchestration for scope/location selection, scaffolding, prompts, detection, and installer handoff.  |
| `packages/cli/src/commands/run.ts`                         | Optional compatibility shim that rejects `weave run` with a product-vision-aligned message.                       |
| `packages/cli/src/config/starter-config.ts`                | Generated starter `.weave` DSL template for global, local, or custom-location config scaffolding.                 |
| `packages/cli/src/fs/file-system.ts`                       | Injectable file-system abstraction for Bun-backed and in-memory implementations.                                  |
| `packages/cli/src/prompt/index.ts`                         | Prompt wrapper around interactive prompt library behavior returning `Result` values.                              |
| `packages/cli/src/detect/index.ts`                         | Public harness detection API.                                                                                     |
| `packages/cli/src/detect/probes.ts`                        | Injectable file/process probes used by detection.                                                                 |
| `packages/cli/src/installers/index.ts`                     | Shared `HarnessInstaller` interface, optional adapter module metadata, and installer registry.                    |
| `packages/cli/src/installers/opencode.ts`                  | Supported OpenCode installer implementation, optional module definitions, or fixture-backed first implementation. |
| `packages/cli/src/installers/unsupported.ts`               | Unsupported-harness installer behavior for Claude Code/Pi until support exists.                                   |
| `packages/cli/src/__fixtures__/valid.weave`                | Valid config fixture for CLI validation tests and proof artifacts.                                                |
| `packages/cli/src/__fixtures__/invalid.weave`              | Invalid config fixture for validation error tests and proof artifacts.                                            |
| `packages/cli/src/__tests__/routing.test.ts`               | Top-level CLI routing tests.                                                                                      |
| `packages/cli/src/__tests__/theme.test.ts`                 | ASCII logo, themed output, and `NO_COLOR` fallback tests.                                                         |
| `packages/cli/src/commands/__tests__/validate.test.ts`     | `validate` command tests with mocked file reads.                                                                  |
| `packages/cli/src/commands/__tests__/init.test.ts`         | `init` command tests with mocked home/config directories.                                                         |
| `packages/cli/src/prompt/__tests__/prompt.test.ts`         | Prompt wrapper TTY, non-TTY, `--yes`, and cancellation tests.                                                     |
| `packages/cli/src/detect/__tests__/detect.test.ts`         | Harness detection tests using injected probes.                                                                    |
| `packages/cli/src/installers/__tests__/installers.test.ts` | Installer idempotency, unsupported-harness, and error tests.                                                      |

### Notes

- Planning assumption: use `@weave/cli` as the package name because `README.md` says all packages are published under the `@weave` scope. If the publishing scope changes, update `packages/cli/package.json`, docs, and package-runner proof commands together.
- Planning assumption: hosted `curl | sh` installation is out of scope. This plan covers local PATH installation and package-runner compatibility for a publishable package.
- Planning assumption: `weave init --scope <global|local>` and `--install-dir <path>` refer to where Weave config is scaffolded, not where the CLI binary itself is installed.
- Unit tests should live alongside CLI modules in `packages/cli/src/**/__tests__/` to match existing package test patterns.
- Use Bun for package scripts and tests: `bun run build`, `bun run typecheck`, `bun run lint`, and `bun test`.
- Keep external dependencies mockable: no real user home directory writes, harness config mutation, or harness process launch in tests.
- Follow repository standards: `neverthrow` for fallible business logic, explicit error unions, pino logger for logs, centralized CLI output, and no Node runtime APIs beyond allowed `node:path`/`node:os` helpers.

## Tasks

### [x] 1.0 Create the CLI package, executable entry point, and Weave-branded presentation layer

#### 1.0 Proof Artifact(s)

- CLI: `command -v weave` returns a path after the documented local install flow, demonstrating the executable is available on `PATH`.
- CLI: `weave --help` exits `0`, lists `init` and `validate`, and shows the themed ASCII Weave logo banner, demonstrating the command surface and brand presentation.
- CLI: `NO_COLOR=1 weave --help` exits `0` and prints readable uncolored output, demonstrating accessibility and automation-safe fallback behavior.
- CLI: `weave --version` exits `0` and prints the CLI package version, demonstrating package metadata wiring.
- CLI: `bunx @weave/cli --help`, `npx @weave/cli --help`, `npm exec @weave/cli -- --help`, and `pnpm dlx @weave/cli --help` are documented and pass once the package is publishable, demonstrating package-runner compatibility.
- Test: `bun test packages/cli/src/__tests__/routing.test.ts packages/cli/src/__tests__/theme.test.ts` passes, demonstrating command routing, ASCII banner rendering, and color fallback behavior.
- Build: `bun run build` and `bun run typecheck` pass, demonstrating workspace integration.

#### 1.0 Tasks

- [x] 1.1 Add `packages/cli` to the root workspace and update root build/typecheck/test scripts so the CLI package participates in normal Bun workflows.
- [x] 1.2 Create `packages/cli/package.json` with package name `@weave/cli`, version metadata, `bin` entry for `weave`, package scripts, and workspace dependencies on `@weave/core`, `@weave/config`, and `@weave/engine` as needed.
- [x] 1.3 Create `packages/cli/tsconfig.json` and `packages/cli/tsconfig.build.json` following existing package conventions.
- [x] 1.4 Update root `tsconfig.json`, `tsconfig.build.json`, and `biome.json` so CLI source, tests, and package references are included in typecheck/build/lint.
- [x] 1.5 Create `packages/cli/src/main.ts`, `packages/cli/src/index.ts`, and `packages/cli/src/cli.ts` with a testable command router that returns exit codes instead of directly exiting from business logic.
- [x] 1.6 Create `packages/cli/src/args.ts` for global flag and command parsing for `--help`, `--version`, `init`, `validate`, unknown commands, and optional `run` compatibility handling.
- [x] 1.7 Create `packages/cli/src/io/terminal.ts` as the centralized user-facing output boundary so package code avoids scattered `console.*` calls.
- [x] 1.8 Create `packages/cli/src/theme/ascii-logo.ts`, `packages/cli/src/theme/colors.ts`, and `packages/cli/src/theme/render.ts` for the checked-in ASCII Weave logo, theme tokens, banner rendering, and `NO_COLOR` fallback.
- [x] 1.9 Add routing and theme tests in `packages/cli/src/__tests__/routing.test.ts` and `packages/cli/src/__tests__/theme.test.ts` for help output, version output, unknown command errors, ASCII logo presence, colored output, and uncolored fallback.
- [x] 1.10 Document local PATH installation and package-runner invocation examples in `README.md` and/or `docs/cli.md`.
- [x] 1.11 Verify proof artifacts for task 1.0 with `bun test packages/cli/src/__tests__/routing.test.ts packages/cli/src/__tests__/theme.test.ts`, `bun run build`, and `bun run typecheck`.

### [x] 2.0 Implement `weave validate` for effective and explicit config validation

#### 2.0 Proof Artifact(s)

- CLI: `weave validate --project` against a valid `.weave/config.weave` exits `0` and prints agent/category/workflow/disabled/log-level summary counts, demonstrating project validation.
- CLI: `weave validate --global` in an isolated test home exits `0` after init creates a valid config, demonstrating global validation.
- CLI: `weave validate --path packages/cli/src/__fixtures__/invalid.weave` exits `1` and prints `file:line:col: message`, demonstrating parse/validation error reporting.
- CLI: `weave validate --json --path packages/cli/src/__fixtures__/valid.weave` emits parseable JSON, demonstrating machine-readable output.
- Test: `bun test packages/cli/src/commands/__tests__/validate.test.ts` passes with mocked file reads, demonstrating validation behavior without touching the real home directory.

#### 2.0 Tasks

- [x] 2.1 Add `packages/cli/src/__fixtures__/valid.weave` and `packages/cli/src/__fixtures__/invalid.weave` for deterministic validation tests.
- [x] 2.2 Create shared CLI error types in `packages/cli/src/errors.ts` for invalid arguments, missing files, read failures, parse failures, and validation failures.
- [x] 2.3 Create `packages/cli/src/fs/file-system.ts` with an injectable Bun-backed file-system interface and an in-memory test implementation pattern.
- [x] 2.4 Implement `packages/cli/src/commands/validate.ts` with `ResultAsync` return values for `--path`, `--global`, `--project`, default effective config validation, and `--json`.
- [x] 2.5 Reuse `formatError`/`parseConfig` from `@weave/core` for explicit file validation and `loadConfig` from `@weave/config` for effective project/global validation.
- [x] 2.6 Implement success summary formatting for agents, categories, workflows, disabled entries, and log level without leaking full private config content.
- [x] 2.7 Wire `validate` into the top-level router and help output.
- [x] 2.8 Replace the root `validate-config` script with an equivalent CLI invocation or document why the legacy script remains temporarily.
- [x] 2.9 Add `packages/cli/src/commands/__tests__/validate.test.ts` covering valid project/global/path validation, invalid DSL with line/column output, missing file errors, read failures, and `--json` output.
- [x] 2.10 Verify proof artifacts for task 2.0 with the validate test command plus representative CLI invocations against sanitized fixtures.

### [x] 3.0 Implement `weave init` config scaffolding, scope/location selection, and prompt flow

#### 3.0 Proof Artifact(s)

- CLI: `weave init --scope global --install-dir <fixture-home>/.weave --yes` creates `<fixture-home>/.weave/config.weave` and `<fixture-home>/.weave/prompts/`, demonstrating non-interactive global scaffolding.
- CLI: `weave init --scope local --install-dir <fixture-project>/.weave --yes` creates `<fixture-project>/.weave/config.weave` and `<fixture-project>/.weave/prompts/`, demonstrating non-interactive local scaffolding.
- CLI: `weave validate --global` exits `0` after global init, and `weave validate --project` exits `0` after local init, demonstrating generated starter config validity for both scopes.
- CLI: running `weave init --scope global --install-dir <fixture-home>/.weave --yes` twice exits `0` and reports no overwrite, demonstrating idempotency.
- CLI: `weave init --scope global --install-dir <fixture-home>/.weave --force --yes` creates `<fixture-home>/.weave/config.weave.bak`, demonstrating safe overwrite behavior.
- Test: `bun test packages/cli/src/commands/__tests__/init.test.ts packages/cli/src/prompt/__tests__/prompt.test.ts` passes, demonstrating no-argument interactive global/local scope selection, install-directory selection, harness selection, optional adapter module selection, TTY, non-TTY, `--yes`, and cancellation behavior with mocked prompts and file I/O.

#### 3.0 Tasks

- [x] 3.1 Add the chosen lightweight prompt dependency if needed and keep it isolated behind `packages/cli/src/prompt/index.ts`.
- [x] 3.2 Implement `packages/cli/src/prompt/index.ts` so prompt answers, global/local scope selection, install-directory entry, cancellation, TTY detection, non-TTY fallback, and `--yes` behavior return explicit `Result` values.
- [x] 3.3 Create `packages/cli/src/config/starter-config.ts` containing a well-commented starter `.weave` config that covers agents, categories, workflows, disables, logging, continuation settings, and analytics settings.
- [x] 3.4 Implement install target resolution for init: `--scope global` defaults to `~/.weave`, `--scope local` defaults to `<projectRoot>/.weave`, and `--install-dir <path>` overrides the selected scope's default.
- [x] 3.5 Implement `packages/cli/src/commands/init.ts` scaffolding for `config.weave` and `prompts/` at the resolved installation directory using the injectable file-system layer.
- [x] 3.6 Implement idempotent behavior at the resolved installation directory: skip existing `config.weave` without `--force`, backup to `config.weave.bak` before forced overwrite, and report each outcome clearly.
- [x] 3.7 Add the no-argument interactive init wizard flow with themed banner, version display, global/local scope explanation and choice, install-directory prompt with default, file-write summary, detected harness selection, optional adapter module selection for selected harnesses, final confirmation, and next steps.
- [x] 3.8 Wire `init`, `--scope <global|local>`, `--install-dir <path>`, `--yes`/`-y`, `--force`, `--harness`, and `--all-harnesses` arguments into the top-level router and help output.
- [x] 3.9 Add `packages/cli/src/commands/__tests__/init.test.ts` covering clean global init, clean local init, custom install directory, idempotent second run, forced backup, generated config validation, non-TTY fallback, and no real home-directory writes.
- [x] 3.10 Add `packages/cli/src/prompt/__tests__/prompt.test.ts` covering no-argument TTY prompts, global/local description text, install-directory prompt defaults and overrides, multi-select harness prompts, adapter module prompts, non-TTY fallback, `--yes`, and cancellation returning exit code `0`.
- [x] 3.11 Verify proof artifacts for task 3.0 with init and prompt tests plus sanitized `--scope` and `--install-dir` CLI invocations.

### [x] 4.0 Add side-effect-free harness detection with injectable probes

#### 4.0 Proof Artifact(s)

- Test: `bun test packages/cli/src/detect/__tests__/detect.test.ts` passes for all-detected, none-detected, partial-detected, unreadable-path, and PATH-binary scenarios, demonstrating deterministic detection coverage.
- Test: the detection test fixture verifies no write probe is called, demonstrating detection is side-effect free.
- CLI: `weave init --yes` in a fixture-backed environment prints detected harness names and unsupported install notices without modifying real harness config, demonstrating safe detection integration.

#### 4.0 Tasks

- [x] 4.1 Define `DetectedHarness`, supported harness IDs, and `DetectionError` discriminated unions in `packages/cli/src/detect/index.ts`.
- [x] 4.2 Create `packages/cli/src/detect/probes.ts` with injectable file-exists, file-readability, binary-on-PATH, version-read, and path-resolution probes.
- [x] 4.3 Implement side-effect-free detection for OpenCode, Claude Code, and Pi using configured directory probes and PATH binary probes.
- [x] 4.4 Ensure each detected harness includes `id`, absolute `configPath`, and optional `version` when available.
- [x] 4.5 Ensure no detection path creates directories, writes files, edits config, or launches harness runtimes.
- [x] 4.6 Add `packages/cli/src/detect/__tests__/detect.test.ts` covering all-detected, none-detected, partial-detected, unreadable config path, PATH-binary-only detection, and optional version data.
- [x] 4.7 Integrate detection summaries into `weave init` so interactive and `--yes` flows can report detected, supported, and unsupported harnesses.
- [x] 4.8 Verify proof artifacts for task 4.0 with detection tests and fixture-backed init output.

### [x] 5.0 Implement harness installer boundaries, safe installation, and CLI documentation

#### 5.0 Proof Artifact(s)

- Test: `bun test packages/cli/src/installers/__tests__/installers.test.ts` passes with in-memory harness config fixtures, demonstrating installer idempotency, optional adapter module selection, and `ResultAsync<void, InstallError>` behavior.
- CLI: `weave init --harness opencode --yes` in a fixture-backed environment reports a successful supported install, demonstrating non-interactive harness installation.
- CLI: `weave init --harness pi --yes` exits `1` with a clear unsupported or undetected message when Pi installer support is unavailable, demonstrating explicit unsupported-harness handling.
- CLI: `weave init --all-harnesses --yes` installs only supported detected harnesses and reports skipped unsupported harnesses, demonstrating safe bulk installation.
- CLI: `weave run` exits `1` with a message directing users to `weave init` and harness-specific launch instructions, or `weave --help` omits `run`, demonstrating product-vision alignment.
- Docs: `README.md` and/or `docs/cli.md` include local PATH install, package-runner invocation, `init`, `validate`, no-runtime-execution behavior, and proof-artifact security notes, demonstrating user-facing documentation.

#### 5.0 Tasks

- [x] 5.1 Define `HarnessInstaller`, `AdapterModule`, `InstallRequest`, `InstallResult`, and `InstallError` discriminated unions in `packages/cli/src/installers/index.ts`.
- [x] 5.2 Implement installer registry behavior that marks OpenCode as supported when an installer exists, exposes any adapter-defined optional modules, and marks Claude Code/Pi as unsupported until their installers are implemented.
- [x] 5.3 Implement `packages/cli/src/installers/opencode.ts` with fixture-backed idempotent config/module mutation behavior and no dependency on a live OpenCode process.
- [x] 5.4 Implement `packages/cli/src/installers/unsupported.ts` so unsupported or undetected harnesses return clear `ResultAsync` errors for explicit requests and clear skip notices for bulk installs.
- [x] 5.5 Integrate installer and optional module selection into `weave init` with no arguments, `weave init --harness <name>`, `weave init --all-harnesses`, interactive multi-select, `--force`, and `--yes` flows.
- [x] 5.6 Ensure real harness and adapter module file writes happen only after interactive confirmation or explicit non-interactive flags.
- [x] 5.7 Add installer idempotency checks so repeated installs without `--force` do not duplicate Weave entries or adapter module entries/files.
- [x] 5.8 Add optional `packages/cli/src/commands/run.ts` compatibility behavior that exits `1` with a message explaining Weave configures harnesses through `weave init` and does not run harness runtimes directly.
- [x] 5.9 Add `packages/cli/src/installers/__tests__/installers.test.ts` covering successful supported install, optional adapter module install, idempotent repeat install, forced reinstall, unsupported explicit harness, undetected explicit harness, and bulk install skip behavior.
- [x] 5.10 Update `README.md` and/or create `docs/cli.md` with local PATH installation, package-runner commands, `init`, `--scope`, `--install-dir`, global vs local installation descriptions, `validate`, no direct runtime execution, theme/NO_COLOR behavior, and safe proof artifact guidance.
- [x] 5.11 Verify proof artifacts for task 5.0 with installer tests, fixture-backed init commands, run compatibility behavior, docs review, `bun run lint`, `bun run typecheck`, `bun run build`, and `bun run test`.
