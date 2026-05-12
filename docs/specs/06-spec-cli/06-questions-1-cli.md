# 06 Questions Round 1 - CLI

Please answer each question below (select one or more options, or add your own notes). Feel free to add additional context under any question.

## 1. Spec Scope for Parent Issue #26

Issue #26 is an umbrella CLI issue, and issues #29-#34 are already linked as GitHub sub-issues. Should this spec cover the full umbrella scope or only the smallest first implementation slice?

- [x] (A) Full umbrella spec for #26, with demoable units aligned to #29-#34 plus a `run` command slice
- [ ] (B) First implementation slice only: package scaffold + `validate`, leaving `init`, harness installation, detection, prompts, and `run` to later specs
- [ ] (C) Spec only the already-linked sub-issues #29-#34 and exclude `run` because it does not currently have its own sub-issue
- [ ] (D) Split immediately into multiple specs: one for scaffold/validate, one for init/detection/prompts/installers, and one for run
- [ ] (E) Other (describe)

**Current best-practice context:** Spec-driven workflows work best when each spec produces small vertical slices with observable proof artifacts. The Bun docs support building CLI executables and monorepo package workflows, but the repository currently has no `packages/cli` package and only an empty OpenCode adapter package, so the full #26 scope spans package creation, command behavior, file I/O, harness installation, and runtime adapter orchestration.

**Recommended answer(s):** [(A)]

**Why these are recommended:**

- `(A)` preserves the user's intent to start issue #26 and uses the linked sub-issues as natural demoable-unit boundaries.
- `(A)` keeps the parent spec useful as the blueprint while allowing SDD task generation to break work into focused child tasks.
- `(B)` or `(D)` may be safer if you want the first implementation branch to be very small, but they would not fully describe issue #26.
- `(C)` avoids inventing `run` details, but it would leave a stated requirement from #26 unspecified.

## 2. `weave run` Adapter Support in the First Spec

Issue #26 says `weave run --adapter <opencode|claude-code|pi>`, but the repository currently only has an empty `packages/adapters/opencode` package and issue #15 for the OpenCode adapter is still open. How should the spec handle `run`?

- [ ] (A) Include `run` for OpenCode only in the first implementation, and require unsupported adapters to fail with clear messages until their packages exist
- [ ] (B) Include `run` for all three adapter names, creating placeholder adapter packages for Claude Code and Pi if needed
- [ ] (C) Include command parsing and validation for all three names, but defer actual `WeaveRunner` execution until adapter packages are implemented
- [ ] (D) Exclude `run` from this spec and create/link a separate sub-issue for it first
- [x] (E) Other (describe): there is no concept of run. If you look at the
  product vision, it doesnt run anything directly. It just configures third
  party harnesses through an api.

**Current best-practice context:** The repository's adapter-boundary docs say adapters own harness-specific discovery and materialization, while engine APIs should stay harness-agnostic. A CLI command can validate adapter names and delegate to adapter packages, but it should not embed harness-specific behavior in the CLI or engine.

**Recommended answer(s):** [(A)]

**Why these are recommended:**

- `(A)` provides a real end-to-end path once #15 is available while keeping unsupported harness behavior honest and explicit.
- `(A)` matches the issue dependency note: #26 depends on #15 or an equivalent adapter.
- `(B)` risks expanding the spec into adapter implementation work for packages that do not exist yet.
- `(C)` is easier to ship but may not satisfy the parent issue's intent that `run` drives `WeaveRunner`.
- `(D)` is valid if you want `run` tracked separately before specification, but it delays completion of #26.

## 3. `init` Harness Installation Depth

The linked sub-issues include both global config scaffolding (#30) and harness installation (#31). What should the first version of `weave init` install into harness configs?

- [x] (A) Install only to detected harnesses with existing adapter support, and print clear "not yet supported" messages for others
- [ ] (B) Install to OpenCode, Claude Code, and Pi config locations immediately, even if their adapters are incomplete
- [ ] (C) Scaffold only `~/.weave/config.weave` and `~/.weave/prompts/`; defer all harness config mutation to a later spec
- [x] (D) Add installer interfaces and mock/test fixtures now, but make real harness file writes opt-in behind `--harness` or `--all-harnesses`
- [ ] (E) Other (describe)

**Current best-practice context:** Current Bun guidance supports optimized file I/O with `Bun.file()` and `Bun.write()`. Repository testing standards require external dependencies and file I/O to be mockable, and adapter-boundary docs keep harness-specific config mutation in adapter/installer-owned code rather than core engine code.

**Recommended answer(s):** [(D), (A)]

**Why these are recommended:**

- `(D)` gives the CLI a testable installer surface without forcing real harness writes in unit tests.
- `(A)` keeps the user experience clear and prevents silently writing incomplete integrations.
- `(B)` can create broken user configurations if adapters are not ready.
- `(C)` is the smallest safe slice, but it would under-spec issue #31 and make the parent #26 spec incomplete.

## 4. Standalone Binary Acceptance Criteria

Issue #26 describes a "standalone Bun binary." What level of standalone packaging should the spec require for the first delivery?

- [ ] (A) A workspace package with a `bin` entry runnable through Bun during development, plus build output; compiled single-file executable can be a later enhancement
- [ ] (B) A compiled single-file executable using `bun build --compile` as part of the first delivery
- [ ] (C) Both: require a package `bin` entry and a compiled executable proof artifact in this spec
- [ ] (D) Defer packaging details and specify only command behavior
- [x] (E) Other (describe): A, but I need the binary to be in the PATH so it
  neets to be properly installed. Ive noticed most libraries now do a curl to sh
  with a pipe to bash

**Current best-practice context:** Bun's official docs support both package-script execution and standalone executables via `bun build --compile --outfile <name>`. The repository currently uses workspace packages and `bun run --filter`-style package scripts, so requiring the workspace package first fits existing project structure.

**Recommended answer(s):** [(A)]

**Why these are recommended:**

- `(A)` matches the existing monorepo pattern and makes command behavior testable before distribution packaging.
- `(A)` still leaves room to add `bun build --compile` after the CLI surface stabilizes.
- `(B)` or `(C)` may be appropriate if binary distribution is a hard requirement for #26, but they add packaging complexity before the command contracts are validated.
- `(D)` would make "standalone Bun binary" too vague for later acceptance testing.
