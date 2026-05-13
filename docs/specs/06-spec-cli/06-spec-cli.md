# 06-spec-cli.md

## Introduction/Overview

The Weave CLI provides the first user-facing command surface for creating, validating, and installing Weave configuration into supported third-party agent harnesses. This spec covers GitHub issue [#26](https://github.com/weave-io/weave/issues/26) and its linked sub-issues [#29](https://github.com/weave-io/weave/issues/29), [#30](https://github.com/weave-io/weave/issues/30), [#31](https://github.com/weave-io/weave/issues/31), [#32](https://github.com/weave-io/weave/issues/32), [#33](https://github.com/weave-io/weave/issues/33), and [#34](https://github.com/weave-io/weave/issues/34).

The primary goal is to make Weave usable both as a `weave` executable on the user's `PATH` and as an on-demand package executable through common package runners such as `bunx`, `npx`/`npm exec`, and `pnpm dlx`. This must preserve the product vision: Weave configures third-party harnesses through APIs and adapters; it does not directly run those harnesses. The historical `weave run` wording in #26 is superseded by an installation/configuration flow that hands normalized Weave intent to harness integrations.

## Goals

- Add a `packages/cli` workspace package that exposes a `weave` executable with clear `--help` and `--version` output.
- Support both PATH-installed usage and package-runner usage, including `bunx`, `npx`/`npm exec`, and `pnpm dlx` once the package is publishable.
- Provide a safe local installation path so `weave` can be invoked from the user's `PATH` during development and validation.
- Implement `weave validate` for project, global, arbitrary-path, and JSON validation workflows with clear parse/validation errors.
- Implement `weave init` to scaffold global, local, or custom-location Weave configuration and guide harness installation through interactive and non-interactive flows.
- Add testable harness detection and installer interfaces that keep harness-specific behavior outside core engine code.

## User Stories

- **As a Weave user**, I want to run Weave with `weave`, `bunx`, `npx`, or `pnpm dlx` so that I can choose the invocation style that fits my environment.
- **As a Weave user**, I want `weave init` to create a valid starter configuration so that I can begin customizing agents, categories, workflows, and prompts from a known-good baseline.
- **As a Weave user**, I want `weave validate` to show every config error with file, line, and column context so that I can fix `.weave` files quickly.
- **As a Weave user**, I want guided harness installation when supported harnesses are detected so that Weave can configure my existing tools without duplicating or corrupting harness config.
- **As a Weave maintainer**, I want CLI behavior to be testable with mocked file-system, process, and harness dependencies so that the CLI can evolve without running real harnesses in tests.

## Demoable Units of Work

### Unit 1: CLI Package and Executable Invocation

**Purpose:** Establish the `packages/cli` workspace package and make the `weave` executable available through both shell PATH installation and package-runner invocation so every later command has a stable entry point.

**Functional Requirements:**

- The system shall add `packages/cli` to the Bun workspace and wire it into root `build`, `typecheck`, and `test` workflows.
- The system shall expose a `weave` executable through the CLI package `bin` configuration.
- The system shall document local PATH installation for development without requiring a published remote release.
- The system shall document package-runner invocation examples for the publishable package, including `bunx <package> --help`, `npx <package> --help`, `npm exec <package> -- --help`, and `pnpm dlx <package> --help`.
- The system shall keep command behavior identical whether invoked through a PATH-installed `weave` binary or through a package runner.
- The system shall print usage information for `weave --help` that lists supported commands and global flags.
- The system shall render a Weave-branded CLI banner that includes ASCII art derived from `https://tryweave.io/assets/weave_logo.png` on primary entry points such as top-level help and interactive init.
- The system shall apply the Weave visual theme from `/Users/jose/Library/Application Support/CleanShot/media/media_pUm4rPPMAW/CleanShot 2026-05-12 at 15.17.15.png` when terminal color is supported.
- The system shall provide a readable plain-text fallback when color is disabled, unsupported, or inappropriate for automation.
- The system shall print the CLI package version for `weave --version`.
- The system shall return exit code `0` for successful `--help` and `--version` invocations, and exit code `1` for unknown commands.

**Proof Artifacts:**

- CLI: `command -v weave` demonstrates the executable is installed on the user's `PATH`.
- CLI: `weave --help` demonstrates the PATH-installed command surface is discoverable and shows the themed ASCII Weave logo banner.
- Screenshot or terminal capture: themed `weave --help` output demonstrates the dark/cyan/blue/purple/magenta Weave brand direction is applied in color-capable terminals.
- CLI: `NO_COLOR=1 weave --help` demonstrates the uncolored fallback remains readable.
- CLI: `bunx <package> --help` demonstrates Bun package-runner invocation works once the package is publishable.
- CLI: `npx <package> --help` or `npm exec <package> -- --help` demonstrates npm package-runner invocation works once the package is publishable.
- CLI: `pnpm dlx <package> --help` demonstrates pnpm package-runner invocation works once the package is publishable.
- CLI: `weave --version` demonstrates package metadata is wired to the executable.
- Test: CLI routing tests pass, demonstrating command dispatch works without invoking real harnesses.
- Build: `bun run build` and `bun run typecheck` pass, demonstrating workspace integration is valid.

### Unit 2: Config Validation Command

**Purpose:** Replace the dev-only validation script with a first-class `weave validate` command that users and automation can run against global, project, merged, or explicit config inputs.

**Functional Requirements:**

- The system shall implement `weave validate` with default behavior that validates the effective Weave config for the current project using the repository config-loading pipeline.
- The system shall support `weave validate --global` to validate `~/.weave/config.weave` explicitly.
- The system shall support `weave validate --project` to validate `.weave/config.weave` explicitly.
- The system shall support `weave validate --path <file>` to validate an arbitrary `.weave` file without treating it as a merged project/global config.
- The system shall support `weave validate --json` to print valid JSON for the parsed or loaded `WeaveConfig` on success.
- The system shall print human-readable errors with `file:line:col: message` context and exit code `1` on missing files, read failures, parse failures, or validation failures.
- The system shall print a success summary with agent count, category count, workflow count, disabled entries, and log level when validation succeeds without `--json`.
- The system shall remove or replace `scripts/validate-config.ts` usage so the root validation script delegates to `weave validate --project` or an equivalent CLI invocation.

**Proof Artifacts:**

- CLI: `weave validate --project` against a valid `.weave/config.weave` exits `0` and prints a summary, demonstrating project validation works.
- CLI: `weave validate --path <invalid-file>` exits `1` and prints line/column errors, demonstrating failure reporting works.
- CLI: `weave validate --json` emits parseable JSON, demonstrating machine-readable output works.
- Test: validation command tests with mocked file reads pass, demonstrating validation behavior without touching the real home directory.

### Unit 3: Init Command, Starter Config, and Interactive Flow

**Purpose:** Give users a safe way to create global, local, or custom-location Weave config and prompts directories, with interactive guidance in terminals and deterministic flag-driven behavior in scripts.

**Functional Requirements:**

- The system shall implement `weave init` to create a Weave config directory containing `config.weave` and `prompts/` on first run.
- The system shall support global installation, which defaults to `~/.weave/` and applies shared user-level config across projects.
- The system shall support local installation, which defaults to `<projectRoot>/.weave/` and applies project-level config for the current repository.
- The system shall support a custom installation directory through a non-interactive argument such as `--install-dir <path>`.
- The system shall support a non-interactive scope argument such as `--scope <global|local>` so scripts can choose global or local installation without prompts.
- The system shall generate a well-commented starter `config.weave` that passes validation for its selected scope with zero errors.
- The generated starter config shall demonstrate all currently supported top-level DSL concepts: agents, categories, workflows, disables, logging, continuation settings, and analytics settings.
- The system shall not overwrite an existing `~/.weave/config.weave` unless `--force` is provided.
- The system shall create `~/.weave/config.weave.bak` before overwriting an existing config with `--force`.
- The system shall support `weave init --yes` / `weave init -y` to accept safe defaults without prompts.
- The system shall launch an interactive wizard when run in a TTY without decisive flags.
- The interactive wizard shall ask whether to perform a global or local installation and shall describe the difference before the user chooses.
- The interactive wizard shall ask which directory to install the Weave config into, prefilled with the selected scope's default directory, so the user can override the default location.
- The interactive wizard shall show the Weave version, explain pending file writes, show detected harnesses, allow selecting all/some/none of the supported harness targets, and for each selected harness with adapter-defined optional modules, allow selecting which modules to install.
- The interactive wizard shall confirm before writing selected-scope config, harness config, or adapter module files, and shall print next steps.
- The system shall skip prompts without hanging when stdin is not a TTY and shall print a clear notice that interactive mode is unavailable.
- The system shall handle prompt cancellation cleanly with exit code `0` and a cancellation message.

**Proof Artifacts:**

- CLI: `weave init --scope global --install-dir <fixture-home>/.weave --yes` creates `config.weave` and `prompts/`, demonstrating non-interactive global scaffolding works.
- CLI: `weave init --scope local --install-dir <fixture-project>/.weave --yes` creates project-local `config.weave` and `prompts/`, demonstrating non-interactive local scaffolding works.
- CLI: `weave validate --global` after global init exits `0`, demonstrating generated global config is valid.
- CLI: `weave validate --project` after local init exits `0`, demonstrating generated local config is valid.
- CLI: running `weave init` twice without `--force` exits `0` and reports no overwrite, demonstrating idempotency.
- CLI: `weave init --force` creates `config.weave.bak`, demonstrating safe overwrite behavior.
- Test: prompt wrapper cancellation tests pass, demonstrating Ctrl-C/cancel handling is explicit.

### Unit 4: Harness Detection and Configuration Installation

**Purpose:** Detect supported harnesses and install Weave integration entries only where support exists, while keeping harness-specific logic isolated from core packages.

**Functional Requirements:**

- The system shall expose a harness detection module that returns `ResultAsync<DetectedHarness[], DetectionError>`.
- Each detected harness shall include `id`, absolute `configPath`, and optional `version` when version data is available.
- The system shall support detection IDs for `opencode`, `claude-code`, and `pi` while allowing unsupported harnesses to be reported as not installable until their adapter/installer support exists.
- Detection shall be side-effect free: it may read/probe, but it shall not create, modify, or delete files.
- Detection shall use injectable file-system and process probes so tests can cover all-detected, none-detected, partial-detected, unreadable-path, and PATH-binary scenarios without real harness installs.
- The system shall define a shared `HarnessInstaller` interface whose installer methods return `ResultAsync<void, InstallError>`.
- The system shall allow harness installers to declare optional adapter modules that can be selected during interactive `weave init`.
- Real harness or adapter module file writes shall happen only after explicit user confirmation in interactive mode or explicit non-interactive flags such as `--harness <name>`, `--all-harnesses`, and/or `--yes`.
- Installers shall be idempotent: rerunning without `--force` shall not duplicate Weave entries in harness config files.
- Installers shall print clear messages for detected-but-unsupported harnesses and shall exit `1` for explicitly requested unsupported or undetected harness names.
- The CLI shall not implement `weave run` as a harness runtime command. If a `run` command path is encountered for compatibility during transition, it shall fail with a clear message directing users to `weave init` and harness-specific launch instructions.

**Proof Artifacts:**

- Test: detection tests pass for all-detected, none-detected, partial-detected, unreadable-path, and PATH-binary cases, demonstrating probe behavior is isolated and deterministic.
- Test: installer idempotency tests pass with in-memory harness config fixtures, demonstrating repeated installs do not duplicate entries.
- CLI: `weave init --harness <supported-harness> --yes` reports a successful install in a fixture-backed environment, demonstrating non-interactive installation works.
- CLI: `weave init --harness <unsupported-harness> --yes` exits `1` with a clear message, demonstrating unsupported harness handling works.
- CLI: `weave run` exits `1` with an explanatory message if present, or `weave --help` omits `run`, demonstrating the CLI follows the product vision and does not run third-party harnesses directly.

## Non-Goals (Out of Scope)

1. **Direct harness runtime execution:** The CLI will not start, supervise, or drive OpenCode, Claude Code, Pi, or any other harness runtime. Weave configures harness integrations; harnesses run themselves.
2. **Full adapter implementation:** This spec does not implement the OpenCode adapter from #15 or create full Claude Code/Pi adapter packages. It only defines CLI handoff, detection, and installer boundaries.
3. **Remote production installer distribution:** A public `curl | sh` installer is not required until release artifacts, checksums/signatures, and hosting are defined. This spec requires local/development PATH installation and package-runner compatibility, but not a hosted shell installer.
4. **New DSL features:** The CLI must use the existing `.weave` DSL and config-loading APIs; adding DSL keywords or changing schema behavior is out of scope.
5. **Real harness invocation in tests:** Unit and integration tests must not launch real harness processes or modify real user harness configuration.

## Design Considerations

- CLI output should be concise, task-oriented, and readable in a terminal.
- The CLI should follow the provided Weave landing-page theme screenshot: dark navy background feel, soft muted gray secondary text, bright cyan-to-blue-to-purple-to-magenta accents, rounded/status-pill-inspired grouping where appropriate, and a confident but minimal visual hierarchy.
- The CLI banner should include ASCII art derived from the Weave logo at `https://tryweave.io/assets/weave_logo.png`. The source image must be treated as a design reference; the runtime CLI should use checked-in/generated text or source assets, not fetch the image from the network.
- The ASCII logo should be recognizable at typical terminal widths and should degrade gracefully for narrow terminals.
- Colorized output should use the Weave accent direction: cyan/blue for setup and discovery, purple for primary Weave identity, magenta for emphasis, green for successful status, amber/yellow for warnings, and red only for errors.
- The design must honor terminal accessibility conventions such as `NO_COLOR`, non-TTY output, and readable contrast in light or unknown terminal themes.
- `--help` output must show commands, common flags, and one-line examples for `init` and `validate`.
- Interactive prompts should use a lightweight prompt layer such as `@clack/prompts`, wrapped behind project-owned functions so cancellation and non-TTY behavior are consistent.
- The init wizard should use progressive disclosure: branded banner first, then installation scope explanation, global/local choice, install-directory choice, harness detection, harness selection, optional adapter module selection for selected harnesses, file writes, and next steps.
- Error messages should be actionable for junior users, including the file path, line/column when available, what failed, and the next command to try.

## Repository Standards

- Runtime, package manager, bundler, and tests must use Bun only.
- File I/O must use `Bun.file()` and `Bun.write()` where Bun supports the operation; any directory/process operations must be isolated behind mockable wrappers.
- `node:path` and `node:os` are allowed for path and home-directory helpers; Node runtime APIs such as `fs`, `child_process`, `ts-node`, and `@types/node` are not allowed.
- Fallible business logic must return `Result<T, E>` or `ResultAsync<T, E>` from `neverthrow`.
- Expected errors must use explicit discriminated-union error types, not bare strings or `unknown`.
- Tests that cross process, file-system, package, or harness boundaries must use mocks or fixtures instead of real external dependencies.
- Logging must use the shared pino logger exported from `@weave/engine`.
- User-facing CLI output must be centralized at the CLI boundary so repository `noConsole` lint rules remain enforceable.
- Source files must follow existing Biome formatting: two-space indentation, double quotes, trailing commas, semicolons, and kebab-case or snake_case filenames.
- Documentation changes must be reflected in `docs/` for non-trivial behavior, especially CLI command contracts and installer boundary decisions.
- Pull requests must mention the related GitHub issue, especially #26 and any completed linked sub-issues.

## Technical Considerations

- The CLI package should depend on existing workspace packages instead of duplicating parser, validator, config loader, or engine behavior.
- `weave validate` should reuse `@weave/core` formatting for parse/validation errors and `@weave/config` loading behavior for effective config validation.
- The CLI must preserve the engine/adapter boundary: detection and installation may live in the CLI package, but harness-specific mutation and adapter module definitions must be isolated behind installer modules and must not be moved into `@weave/core`, `@weave/config`, or `@weave/engine`.
- The historical `weave run --adapter <...>` text in #26 conflicts with the current product vision. This spec resolves the conflict by treating direct runtime execution as out of scope and using `init`/installer behavior as the CLI's harness handoff.
- Bun current guidance supports `Bun.argv` for command arguments, `bun run` for scripts, workspaces for monorepos, `bun test` for tests, `Bun.file()`/`Bun.write()` for optimized file I/O, and `bun build --compile` for future single-file executable distribution.
- npm current guidance supports `npx` and `npm exec` for running commands from local or remote packages without permanent installation; npm may fetch the package into its cache and add the package binary to `PATH` for the duration of execution.
- pnpm current guidance supports `pnpm dlx` for fetching a package from the registry and running its default command binary without adding it as a project dependency.
- `@clack/prompts` current guidance supports grouped prompts, `confirm`, `select`, `multiselect`, and explicit cancellation handling with `isCancel`/`cancel`; the CLI wrapper should adapt those APIs into `Result` or `ResultAsync` values.
- CLI theme rendering should be centralized in a small presentation module so command logic can be tested separately from ANSI styling and ASCII art output.
- Logo ASCII art should be generated or curated from the referenced Weave logo and checked into the repository with tests/snapshots that verify it appears in branded entry points.
- Supply-chain guidance such as SLSA emphasizes verifying artifacts, provenance, signatures, and trusted builders. A future remote installer should not pipe arbitrary scripts into a shell without checksum/signature verification and clear source transparency.
- A compiled single-file Bun executable is allowed as a future enhancement, but this spec's first delivery target is a workspace CLI with a `bin` entry, documented local PATH installation, and documented package-runner invocation paths.

## Security Considerations

- The CLI must not print secrets, API keys, tokens, or full sensitive config contents in normal success output.
- Proof artifacts must avoid committing real user home-directory paths, real harness configs, tokens, or private prompts.
- The CLI must not fetch the remote logo URL at runtime. Any logo-derived ASCII art or theme assets must be generated during development and committed or packaged with the CLI.
- `weave init --force` must create a backup before overwriting config in the selected installation directory and must report the backup path.
- Harness installers must be idempotent and must avoid duplicate or malformed config entries that could break a user's existing harness setup.
- Adapter module installers must be idempotent and must avoid duplicate or malformed module entries/files.
- Harness and adapter module file writes must be explicit: either confirmed interactively or requested through non-interactive flags.
- Detection must not execute arbitrary files found in harness directories. If binary probing is needed, it must be wrapped and tested with controlled command arguments.
- A future `curl | sh` installer must use HTTPS, pinned release URLs, checksum/signature verification, and clear install-path disclosure before it is documented as a recommended installation method.

## Success Metrics

1. **Command availability:** `command -v weave`, `weave --help`, `weave --version`, and documented package-runner help invocations all succeed in their intended local or publishable-package contexts.
2. **Brand presentation:** `weave --help` and interactive `weave init` show a recognizable ASCII Weave logo and theme-aligned colored output in color-capable terminals, with a readable `NO_COLOR=1` fallback.
3. **Validation reliability:** `weave validate` exits `0` for valid generated config and exits `1` with line/column errors for invalid config fixtures.
4. **Init safety:** `weave init` is idempotent by default, supports global/local/custom install locations, backs up before forced overwrite, and produces config that validates with zero errors.
5. **Harness boundary compliance:** Detection and installer tests run entirely with mocks/fixtures and do not launch or mutate real harnesses.
6. **Product vision alignment:** The CLI provides configuration and installation workflows without directly running third-party harness runtimes.

## Open Questions

1. The existing issue text uses package name `@weave-io/cli`, while current workspace packages use the `@weave/*` scope. Should the package be named `@weave-io/cli`, `@weave/cli`, or another final publishing scope?
2. When release packaging is ready, should the preferred permanent PATH installation method be a compiled Bun executable, a package-manager global install, a Homebrew-style formula, or a verified shell installer?
