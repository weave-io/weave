# Task 05 Proofs - Harness installer boundaries and CLI documentation

## Task Summary

This task implements harness installer interfaces, OpenCode fixture-backed installation, unsupported-harness behavior, bulk install skip handling, `weave run` compatibility messaging, and CLI documentation.

## What This Task Proves

- Installer tests pass for supported install, optional module install, idempotency, force, unsupported, and bulk skip behavior.
- `weave init --harness opencode --yes` installs the supported fixture integration.
- `weave init --harness pi --yes` exits `1` with unsupported messaging.
- `weave init --all-harnesses --yes` installs supported harnesses and skips unsupported ones.
- `weave run` exits `1` and explains Weave does not run harness runtimes.
- Docs cover PATH install, package runners, init, validate, no runtime execution, and proof security.
- Lint, typecheck, build, and full tests pass.

## Evidence Summary

All CLI installer proofs use isolated fixture `HOME` and `PATH` values. No real harness config or secrets are committed.

## Artifact: Installer CLI, docs, and quality gates

**What it proves:** Installer boundaries are explicit, safe, idempotent, documented, and covered by repository quality checks.

**Why it matters:** This preserves the engine/adapter boundary and product vision while enabling safe harness handoff.

```text
## installer tests
bun test v1.3.13 (bf2e2cec)

packages/cli/src/installers/__tests__/installers.test.ts:
(pass) harness installers > installs supported OpenCode integration [0.55ms]
(pass) harness installers > installs optional adapter modules [0.14ms]
(pass) harness installers > is idempotent without force [0.14ms]
(pass) harness installers > allows forced reinstall marker [0.06ms]
(pass) harness installers > returns unsupported explicit harness errors [0.09ms]
(pass) harness installers > bulk install skips unsupported harnesses [0.21ms]

 6 pass
 0 fail
 11 expect() calls
Ran 6 tests across 1 file. [19.00ms]

## weave init --harness opencode --yes
Installed Weave OpenCode integration entry.
Installed optional OpenCode Weave agent module.
Weave init complete
Created config: [repo]/tmp/task5-fixtures/project-opencode/.weave/config.weave
Created prompts directory: [repo]/tmp/task5-fixtures/project-opencode/.weave/prompts

Detected harnesses:
- opencode (opencode fixture 1.0.0): readable at [repo]/tmp/task5-fixtures/home/.config/opencode/config.json
- pi (pi fixture 1.0.0): readable at [repo]/tmp/task5-fixtures/home/.pi/config.json

Next steps:
- Edit [repo]/tmp/task5-fixtures/project-opencode/.weave/config.weave
- Run weave validate --project or weave validate --global
exit=0

## opencode config
{}

// weave:init:install

## weave init --harness pi --yes
pi installer support is not available yet.
Weave init complete
Created config: [repo]/tmp/task5-fixtures/project-pi/.weave/config.weave
Created prompts directory: [repo]/tmp/task5-fixtures/project-pi/.weave/prompts

Detected harnesses:
- opencode (opencode fixture 1.0.0): readable at [repo]/tmp/task5-fixtures/home/.config/opencode/config.json
- pi (pi fixture 1.0.0): readable at [repo]/tmp/task5-fixtures/home/.pi/config.json

Next steps:
- Edit [repo]/tmp/task5-fixtures/project-pi/.weave/config.weave
- Run weave validate --project or weave validate --global
exit=1

## weave init --all-harnesses --yes
OpenCode already contains a Weave entry; no changes made.
Installed optional OpenCode Weave agent module.
Skipped pi: pi installer support is not available yet.
Weave init complete
Created config: [repo]/tmp/task5-fixtures/project-all/.weave/config.weave
Created prompts directory: [repo]/tmp/task5-fixtures/project-all/.weave/prompts

Detected harnesses:
- opencode (opencode fixture 1.0.0): readable at [repo]/tmp/task5-fixtures/home/.config/opencode/config.json
- pi (pi fixture 1.0.0): readable at [repo]/tmp/task5-fixtures/home/.pi/config.json

Next steps:
- Edit [repo]/tmp/task5-fixtures/project-all/.weave/config.weave
- Run weave validate --project or weave validate --global
exit=0

## weave run
Weave does not run harness runtimes directly.

  Weave configures third-party harnesses through weave init.
  To start a harness, use its own launch command:

    $ opencode          # OpenCode
    $ claude             # Claude Code
    $ pi                 # Pi

  Run weave init to configure your harnesses.
  Run weave --help for available commands.
exit=1

## docs review
docs/cli.md:11:## Local PATH installation
docs/cli.md:25:## Package runners
docs/cli.md:46:## `weave validate`
docs/cli.md:48:Use `weave validate` to validate effective, scoped, or explicit Weave config.
docs/cli.md:51:weave validate                 # effective config for the current project
docs/cli.md:52:weave validate --project       # ./.weave/config.weave
docs/cli.md:53:weave validate --global        # ~/.weave/config.weave
docs/cli.md:54:weave validate --path file.weave
docs/cli.md:55:weave validate --path file.weave --json
docs/cli.md:74:## `weave init`
docs/cli.md:76:`weave init` creates a starter Weave config directory containing `config.weave` and `prompts/`.
docs/cli.md:79:weave init --scope local --yes
docs/cli.md:80:weave init --scope global --yes
docs/cli.md:81:weave init --scope local --install-dir ./custom-weave --yes
docs/cli.md:112:weave init --harness opencode --yes
docs/cli.md:113:weave init --harness pi --yes        # explicit unsupported/undetected failure until supported
docs/cli.md:114:weave init --all-harnesses --yes     # install supported detected harnesses, skip unsupported ones
docs/cli.md:119:## No runtime execution
docs/cli.md:121:Weave configures harnesses; harnesses run themselves. `weave run`, if encountered for transition compatibility, exits with a message directing users to `weave init` and harness-specific launch commands.
docs/cli.md:123:## Proof artifact security
README.md:89:weave init --scope local --yes
README.md:90:weave init --scope global --install-dir ~/.weave --yes
README.md:91:weave validate --project
README.md:92:weave validate --path .weave/config.weave --json

## quality gates
$ biome lint packages/
Checked 70 files in 59ms. No fixes applied.
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
@weave/cli typecheck: Exited with code 0
$ bun run --filter '@weave/core' build && bun run --filter '@weave/engine' --filter '@weave/config' build && bun run --filter '@weave/cli' build && bun run --filter '@weave/adapter-*' build
@weave/core build: Bundled 88 modules in 12ms
@weave/core build: 
@weave/core build:   index.js  0.58 MB  (entry point)
@weave/core build: 
@weave/core build: Exited with code 0
@weave/engine build: Bundled 115 modules in 12ms
@weave/engine build: 
@weave/engine build:   index.js  0.69 MB  (entry point)
@weave/engine build: 
@weave/config build: Bundled 125 modules in 14ms
@weave/config build: 
@weave/config build:   index.js  0.72 MB  (entry point)
@weave/config build: 
@weave/config build: Exited with code 0
@weave/engine build: Exited with code 0
@weave/cli build: Bundled 148 modules in 14ms
@weave/cli build: 
@weave/cli build:   index.js  0.83 MB  (entry point)
@weave/cli build:   main.js   0.83 MB  (entry point)
@weave/cli build: 
@weave/cli build: Exited with code 0
@weave/adapter-opencode build: Bundled 1 module in 2ms
@weave/adapter-opencode build: 
@weave/adapter-opencode build:   index.js  83 bytes  (entry point)
@weave/adapter-opencode build: 
@weave/adapter-opencode build: Exited with code 0
bun test v1.3.13 (bf2e2cec)

scripts/__tests__/validate-config.test.ts:
(pass) printSummary > prints agent and category counts — no workflows defined (regression) [5.34ms]
(pass) printSummary > prints multiple agents in declaration order (regression) [0.20ms]
(pass) printSummary > omits disabled line when nothing is disabled (regression) [0.17ms]
(pass) printSummary > omits log_level line when not set (regression) [0.14ms]
(pass) printSummary > omits the workflows line when no workflows are defined [0.14ms]
(pass) printSummary > shows workflow count and step count for a single-step workflow [1.40ms]
(pass) printSummary > uses plural 'steps' for workflows with more than one step [0.34ms]
(pass) printSummary > lists all workflows with individual step counts [1.31ms]
(pass) printSummary > workflow line appears between categories and disabled [0.86ms]
(pass) printSummary > prints disabled items spanning agents, hooks, and skills [0.21ms]
(pass) printSummary > prints log_level when set [0.07ms]
(pass) printSummary > includes the configPath in the summary header [0.03ms]
(pass) printSummary > defaults to .weave/config.weave when configPath is omitted [0.03ms]
(pass) printSummary > renders a complete config with all sections [0.58ms]
(pass) printSummary > scripts/fixtures/full-config.weave parses cleanly and summarises all sections [3.50ms]

packages/core/src/__tests__/errors.test.ts:
(pass) LexError variants > UnterminatedString — type discriminant narrows correctly [0.14ms]
(pass) LexError variants > InvalidNumber — holds value field [0.12ms]
(pass) LexError variants > UnexpectedCharacter — holds char field [0.03ms]
(pass) ParseError variants > UnexpectedToken — holds found and expected fields [0.04ms]
(pass) ParseError variants > MissingBlockName — holds blockType field [0.03ms]
(pass) ParseError variants > UnclosedBlock — minimal fields [0.05ms]
(pass) ValidationError > holds path and message [0.03ms]
(pass) ValidationError > accepts optional line and column [0.01ms]
(pass) ConfigError union type guards > narrows UnterminatedString variant from ConfigError [0.06ms]
(pass) ConfigError union type guards > narrows InvalidNumber variant from ConfigError [0.05ms]
(pass) ConfigError union type guards > narrows UnclosedBlock variant from ConfigError [0.02ms]
(pass) ConfigError union type guards > narrows ValidationError variant from ConfigError
(pass) formatError > formats UnterminatedString [0.11ms]
(pass) formatError > formats InvalidNumber [0.02ms]
(pass) formatError > formats UnexpectedCharacter
(pass) formatError > formats UnexpectedToken
(pass) formatError > formats MissingBlockName [0.02ms]
(pass) formatError > formats UnclosedBlock
(pass) formatError > formats ValidationError with path and no location
(pass) formatError > formats ValidationError with location [0.05ms]
(pass) formatError > formats ValidationError with empty path [0.03ms]

packages/core/src/__tests__/schema.test.ts:
(pass) ToolPolicySchema > accepts valid tool policy keys [0.11ms]
(pass) ToolPolicySchema > accepts execute and network permissions [0.27ms]
(pass) ToolPolicySchema > rejects unknown keys such as edit [0.61ms]
(pass) ToolPolicySchema > rejects unknown keys such as search [0.04ms]
(pass) WorkflowStepTypeSchema > accepts valid step types [0.02ms]
(pass) WorkflowStepTypeSchema > rejects invalid step type [0.02ms]
(pass) CompletionMethodSchema > accepts agent_signal (no extra fields)
(pass) CompletionMethodSchema > accepts user_confirm (no extra fields)
(pass) CompletionMethodSchema > accepts plan_created with plan_name [0.06ms]
(pass) CompletionMethodSchema > rejects plan_created without plan_name [0.14ms]
(pass) CompletionMethodSchema > accepts plan_complete with plan_name [0.02ms]
(pass) CompletionMethodSchema > rejects plan_complete without plan_name [0.04ms]
(pass) CompletionMethodSchema > accepts review_verdict (no extra fields)
(pass) CompletionMethodSchema > rejects unknown completion method [0.20ms]
(pass) CompletionMethodSchema > rejects missing method field [0.04ms]
(pass) OnRejectSchema > accepts pause, fail, retry
(pass) OnRejectSchema > rejects invalid value [0.04ms]
(pass) WorkflowStepSchema > accepts a valid step with required fields only [0.09ms]
(pass) WorkflowStepSchema > accepts a gate step with on_reject [0.03ms]
(pass) WorkflowStepSchema > rejects on_reject on a non-gate step [0.32ms]
(pass) WorkflowStepSchema > rejects missing required field: agent [0.25ms]
(pass) WorkflowStepSchema > rejects missing required field: prompt [0.09ms]
(pass) WorkflowStepSchema > rejects missing required field: completion [0.09ms]
(pass) WorkflowStepSchema > rejects invalid type value [0.05ms]
(pass) WorkflowStepSchema > accepts step with inputs and outputs arrays [0.08ms]
(pass) WorkflowStepSchema > accepts optional display_name [0.05ms]
(pass) WorkflowConfigSchema > accepts a valid workflow config [0.05ms]
(pass) WorkflowConfigSchema > rejects empty steps array [0.11ms]
(pass) WorkflowConfigSchema > rejects missing version [0.06ms]
(pass) WorkflowConfigSchema > rejects non-integer version [0.06ms]
(pass) WorkflowConfigSchema > rejects zero version (must be positive) [0.04ms]

packages/core/src/__tests__/lexer.test.ts:
(pass) Lexer — valid tokenization > tokenizes a simple agent block [0.46ms]
(pass) Lexer — valid tokenization > tokenizes double-quoted strings [0.09ms]
(pass) Lexer — valid tokenization > tokenizes triple-quoted strings and strips indentation [0.85ms]
(pass) Lexer — valid tokenization > tokenizes integer numbers [0.04ms]
(pass) Lexer — valid tokenization > tokenizes float numbers [0.05ms]
(pass) Lexer — valid tokenization > tokenizes zero [0.02ms]
(pass) Lexer — valid tokenization > tokenizes boolean identifiers as Identifier tokens [0.15ms]
(pass) Lexer — valid tokenization > skips line comments and tokenizes the next line [0.13ms]
(pass) Lexer — valid tokenization > tokenizes an array [0.06ms]
(pass) Lexer — valid tokenization > tokenizes nested braces [0.04ms]
(pass) Lexer — valid tokenization > collapses multiple blank lines into a single Newline token [0.13ms]
(pass) Lexer — valid tokenization > records correct line and column for tokens [0.05ms]
(pass) Lexer — valid tokenization > handles trailing commas in arrays naturally [0.05ms]
(pass) Lexer — valid tokenization > emits EOF as last token [0.03ms]
(pass) Lexer — errors > reports UnterminatedString for unclosed double-quoted string [0.34ms]
(pass) Lexer — errors > reports UnexpectedCharacter for @ [0.04ms]
(pass) Lexer — errors > collects multiple errors — does not stop at first [0.30ms]
(pass) Lexer — errors > reports correct line for error on second line [0.03ms]

packages/core/src/__tests__/parser.test.ts:
(pass) Parser — agent block > parses a minimal agent block [0.29ms]
(pass) Parser — agent block > parses agent with nested tool_policy block [0.08ms]
(pass) Parser — agent block > parses agent with triggers array of block objects [0.03ms]
(pass) Parser — category block > parses a category with patterns array [0.01ms]
(pass) Parser — disable directive > parses disable agents
(pass) Parser — disable directive > parses disable hooks [0.05ms]
(pass) Parser — disable directive > parses disable skills [0.02ms]
(pass) Parser — setting assignment > parses a top-level bare-identifier setting [0.02ms]
(pass) Parser — setting assignment > parses a top-level boolean setting [0.03ms]
(pass) Parser — setting assignment > parses a nested setting block (continuation.recovery.compaction) [0.02ms]
(pass) Parser — workflow block > parses a workflow with steps
(pass) Parser — multiple top-level blocks > parses multiple blocks in one source
(pass) Parser — named block value > completion plan_created { plan_name '...' } produces a BlockValue with __name
(pass) Parser — named block value > completion user_confirm (no block) still produces an IdentifierValue [0.07ms]
(pass) Parser — named block value > named block value pattern works for non-completion properties too (general purpose) [0.03ms]
(pass) Parser — errors > reports UnclosedBlock for missing closing brace
(pass) Parser — errors > reports MissingBlockName for agent without name [0.10ms]
(pass) Parser — errors > error recovery: second block parses correctly after first block error [0.02ms]

packages/core/src/__tests__/validate.test.ts:
(pass) validate — valid agent > valid agent with all fields [0.46ms]
(pass) validate — valid agent > agent with prompt_file (safe path) [0.16ms]
(pass) validate — valid category > category with patterns and tool_policy [0.18ms]
(pass) validate — mutual exclusivity errors > both prompt and prompt_file set → err [0.24ms]
(pass) validate — prompt_file path safety > prompt_file with '..' → err [0.14ms]
(pass) validate — prompt_file path safety > prompt_file with absolute path → err [0.16ms]
(pass) validate — schema constraint errors > invalid tool_policy value → err [0.10ms]
(pass) validate — schema constraint errors > temperature above 2.0 → err [0.14ms]
(pass) validate — schema constraint errors > invalid mode → err [0.05ms]
(pass) validate — schema constraint errors > empty patterns array on category → err [0.06ms]
(pass) validate — multiple agents, partial errors > one valid and one invalid agent → err with path [0.06ms]
(pass) validate — empty source > empty AST → ok with defaults [0.07ms]
(pass) validate — disable directives > disable agents is reflected in config.disabled [0.01ms]
(pass) validate — workflows > bare completion identifier (user_confirm) round-trips correctly [0.07ms]
(pass) validate — workflows > named block completion (plan_created) round-trips correctly [0.16ms]
(pass) validate — workflows > on_reject pause on a gate step is accepted
(pass) validate — workflows > on_reject on a non-gate step is rejected [0.16ms]
(pass) validate — workflows > missing required agent field produces clear error path [0.13ms]
(pass) validate — workflows > inputs and outputs arrays validate correctly
(pass) validate — workflows > step block name maps to name; inner name property maps to display_name [0.16ms]
(pass) validate — log_level setting > valid log_level is included in config [0.07ms]
(pass) validate — log_level setting > invalid log_level → err [0.07ms]

packages/core/src/__tests__/parse_config.test.ts:
(pass) parseConfig — valid sources > minimal valid source: single agent with inline prompt [0.15ms]
(pass) parseConfig — valid sources > full valid source: agents, categories, disable, log_level [0.33ms]
(pass) parseConfig — valid sources > AGENTS.md example: loom agent with tool_policy and triggers [0.10ms]
(pass) parseConfig — valid sources > empty source → ok with defaults [0.08ms]
(pass) parseConfig — lex errors > unterminated string → err with UnterminatedString [0.06ms]
(pass) parseConfig — lex errors > unexpected character → err with UnexpectedCharacter [0.03ms]
(pass) parseConfig — parse errors > unclosed block → err with UnclosedBlock [0.10ms]
(pass) parseConfig — parse errors > missing block name → err with MissingBlockName
(pass) parseConfig — validation errors > both prompt and prompt_file → err with ValidationError [0.09ms]
(pass) parseConfig — validation errors > temperature out of range → err with ValidationError including source info [0.11ms]
(pass) parseConfig — workflows > secure-feature workflow (4 steps) parses end-to-end with correct typed shape [0.30ms]
(pass) parseConfig — workflows > quick-fix workflow (2 steps) parses end-to-end correctly [0.11ms]
(pass) parseConfig — workflows > invalid step type returns err with ValidationError [0.15ms]
(pass) parseConfig — workflows > malformed completion block (no method identifier) returns err with ValidationError [0.07ms]
(pass) parseConfig — workflows > workflow mixed with agents and categories parses correctly [0.07ms]
(pass) parseConfig — source positions in errors > errors include line numbers where possible [0.02ms]

packages/config/src/__tests__/merge.test.ts:
(pass) mergeConfigs > (a) scalar override: last-defined log_level wins [0.17ms]
(pass) mergeConfigs > (b) three-layer scalar: only third layer sets log_level → third value wins [0.09ms]
(pass) mergeConfigs > (c) agent deep-merge: partial override preserves unset fields [0.17ms]
(pass) mergeConfigs > (d) agent addition: agents from different scopes both present in merged config [0.11ms]
(pass) mergeConfigs > (e) array union-merge (models): override entries first, then base [0.11ms]
(pass) mergeConfigs > (f) array union-merge (disabled.agents): union across scopes, override first [0.07ms]
(pass) mergeConfigs > (g) array union-merge dedup: duplicate model appears exactly once [0.07ms]
(pass) mergeConfigs > (h) empty config merges: valid empty config returned [0.01ms]
(pass) mergeConfigs > (i) single config: returns equivalent config [0.03ms]
(pass) mergeConfigs > (j) zero configs: returns default empty WeaveConfig [0.07ms]
(pass) mergeConfigs > (k) immutability: inputs are not mutated after merge [0.14ms]
(pass) mergeConfigs > (m) three-layer agent deep-merge: each layer contributes distinct fields [0.10ms]
(pass) mergeConfigs > (l) tool_policy deep-merge: base policy + extra key from override, all keys present [0.06ms]

packages/config/src/__tests__/load_config.test.ts:
(pass) loadConfig > (a) zero-config: no user files → returns ok with all 8 builtin agents [1.90ms]
(pass) loadConfig > (a) zero-config: prompt_file paths are absolute [0.75ms]
(pass) loadConfig > (b) project override: temperature overrides builtin, other fields preserved [0.52ms]
(pass) loadConfig > (c) global custom agent: merged config contains all 8 builtins + custom agent [0.43ms]
(pass) loadConfig > (d) both configs: three-layer merge — project log_level and loom temperature win [0.28ms]
(pass) loadConfig > (e) parse error: project config has invalid DSL → returns err with ParseError [0.40ms]
(pass) loadConfig > (f) I/O error: file read throws → returns err with FileReadError [0.27ms]
(pass) loadConfig > (g) all prompt_file values in returned config are absolute paths [0.78ms]

packages/config/src/__tests__/builtins.test.ts:
(pass) getBuiltinConfig > (a) returns ok — not err [0.31ms]
(pass) getBuiltinConfig > (b) result contains exactly 8 agents matching BUILTIN_AGENT_NAMES [0.28ms]
(pass) getBuiltinConfig > (c) loom has temperature 0.1 and prompt_file loom.md [0.19ms]
(pass) getBuiltinConfig > (d) shuttle has temperature 0.2 and prompt_file shuttle.md [0.47ms]
(pass) getBuiltinConfig > (e) thread has temperature 0.0 [0.14ms]
(pass) getBuiltinConfig > (f) pattern has temperature 0.3 [0.12ms]
(pass) getBuiltinConfig > (g) builtin config has no categories, workflows, or disabled entries [0.18ms]
(pass) getBuiltinConfig > (h) BUILTIN_WEAVE_SOURCE is valid DSL — parseConfig returns no errors [0.29ms]

packages/config/src/__tests__/discovery.test.ts:
(pass) discoverAndParse > (a) both files exist → returns 2 entries, global first [0.42ms]
(pass) discoverAndParse > (b) only global exists → returns 1 entry with kind global [0.19ms]
(pass) discoverAndParse > (c) only project exists → returns 1 entry with kind project [0.09ms]
(pass) discoverAndParse > (d) neither file exists → returns empty array, not an error [0.05ms]
(pass) discoverAndParse > (e) file exists but read fails → returns err with FileReadError containing the path [0.15ms]
(pass) discoverAndParse > (f) file reads but has invalid DSL → returns err with ParseError containing path and errors [0.07ms]
(pass) discoverAndParse > (g) global parse error does not prevent project discovery — errors aggregated [0.05ms]
(pass) discoverAndParse > (h) both files have invalid DSL → err with 2 errors, both paths present [0.10ms]

packages/config/src/__tests__/resolve.test.ts:
(pass) resolvePromptPaths > (a) builtin scope: resolves prompt_file relative to rootDir/prompts/ [0.09ms]
(pass) resolvePromptPaths > (b) global scope: resolves prompt_file to ~/.weave/prompts/<file>
(pass) resolvePromptPaths > (c) project scope: resolves prompt_file to <projectRoot>/.weave/prompts/<file> [0.02ms]
(pass) resolvePromptPaths > (d) agent without prompt_file is left unchanged [0.23ms]
(pass) resolvePromptPaths > (e) mixed agents: only agent with prompt_file is resolved [0.03ms]
(pass) resolvePromptPaths > (f) immutability: original config not mutated [0.03ms]

packages/cli/src/__tests__/routing.test.ts:
(pass) CLI routing > --help exits 0 and lists init and validate [1.22ms]
(pass) CLI routing > -h is an alias for --help [0.11ms]
(pass) CLI routing > no arguments shows help [0.06ms]
(pass) CLI routing > --version exits 0 and prints version string [0.24ms]
(pass) CLI routing > -V is an alias for --version [0.02ms]
(pass) CLI routing > unknown command exits 1 with error message [0.06ms]
(pass) CLI routing > run command exits 1 with product-vision message [0.11ms]
(pass) CLI routing > --help overrides a command [0.05ms]
(pass) CLI routing > help output includes EXAMPLES section [0.02ms]

packages/cli/src/__tests__/theme.test.ts:
(pass) theme colors > returns identity functions when color is disabled [0.01ms]
(pass) theme colors > returns ANSI-wrapped strings when color is enabled [0.72ms]
(pass) theme colors > bold composites apply both bold and color [0.05ms]
(pass) ASCII logo > has multiple lines
(pass) ASCII logo > LOGO_WIDTH matches the widest line [0.06ms]
(pass) ASCII logo > renderLogo returns same number of lines as PLAIN_LOGO_LINES [0.04ms]
(pass) ASCII logo > renderLogo with color produces ANSI sequences [0.05ms]
(pass) ASCII logo > renderLogo without color produces plain text [0.25ms]
(pass) banner and help rendering > renderBanner includes logo lines and version [0.02ms]
(pass) banner and help rendering > renderHelp includes banner, commands, and examples [0.04ms]
(pass) banner and help rendering > renderHelp with NO_COLOR produces no ANSI escapes [0.05ms]
(pass) banner and help rendering > renderHelp with color produces ANSI escapes [0.02ms]
(pass) banner and help rendering > getVersion returns a semver-like string
(pass) banner and help rendering > renderVersion returns the version string

packages/engine/src/__tests__/env.test.ts:
(pass) parseEnv > defaults LOG_LEVEL to 'info' when not set
(pass) parseEnv > accepts all valid log levels [0.04ms]
(pass) parseEnv > throws with a descriptive message for an invalid LOG_LEVEL [0.88ms]
(pass) parseEnv > throws listing all invalid fields [0.06ms]
(pass) parseEnv > ignores unrelated environment variables [0.02ms]

packages/engine/src/__tests__/model-resolution.test.ts:
(pass) resolveAdapterModelIntent > priority 1: override > (a) overrideModel wins over all other inputs [0.07ms]
(pass) resolveAdapterModelIntent > priority 1: override > (b) overrideModel wins even when uiSelectedModel is also provided [0.01ms]
(pass) resolveAdapterModelIntent > priority 2: ui-selected model > (a) uiSelectedModel used when mode is primary
(pass) resolveAdapterModelIntent > priority 2: ui-selected model > (b) uiSelectedModel used when mode is all
(pass) resolveAdapterModelIntent > priority 2: ui-selected model > (c) uiSelectedModel used when mode is undefined [0.02ms]
(pass) resolveAdapterModelIntent > priority 2: ui-selected model > (d) uiSelectedModel is SKIPPED when mode is subagent — falls to next priority [0.04ms]
(pass) resolveAdapterModelIntent > priority 3: category preference > (a) first categoryModels entry is returned when available [0.02ms]
(pass) resolveAdapterModelIntent > priority 3: category preference > (b) second categoryModels entry used when first is unavailable [0.02ms]
(pass) resolveAdapterModelIntent > priority 3: category preference > (c) category preference skipped when mode is subagent and no uiSelectedModel — falls to category then agent [0.01ms]
(pass) resolveAdapterModelIntent > priority 4: agent preference > (a) first agentModels entry returned when no higher priority matches [0.01ms]
(pass) resolveAdapterModelIntent > priority 4: agent preference > (b) second agentModels entry used when first is unavailable [0.01ms]
(pass) resolveAdapterModelIntent > priority 5: system default > (a) systemDefault returned when all preferences are absent
(pass) resolveAdapterModelIntent > priority 6: constant fallback > (a) DEFAULT_FALLBACK_MODEL returned when nothing else is provided [0.01ms]
(pass) resolveAdapterModelIntent > priority 6: constant fallback > (b) returned model equals DEFAULT_FALLBACK_MODEL constant value [0.01ms]
(pass) resolveAdapterModelIntent > availability filtering > (a) empty availableModels set means no model passes — falls to systemDefault [0.01ms]
(pass) resolveAdapterModelIntent > availability filtering > (b) unavailable category model skipped; available agent model returned

packages/engine/src/__tests__/descriptors.test.ts:
(pass) generateCategoryShuttles > generation > (a) returns empty object when config has no categories [0.34ms]
(pass) generateCategoryShuttles > generation > (b) returns empty object when base shuttle agent is absent [0.07ms]
(pass) generateCategoryShuttles > generation > (c) produces a shuttle-{name} key for each category [0.13ms]
(pass) generateCategoryShuttles > generation > (d) generated descriptor name field matches the key
(pass) generateCategoryShuttles > inheritance > (a) generated descriptor inherits base shuttle prompt [0.06ms]
(pass) generateCategoryShuttles > inheritance > (b) generated descriptor inherits base shuttle tool_policy when category has none [0.06ms]
(pass) generateCategoryShuttles > inheritance > (c) generated descriptor has mode subagent regardless of base shuttle mode [0.05ms]
(pass) generateCategoryShuttles > category overrides > (a) category models replace the inherited models field [0.02ms]
(pass) generateCategoryShuttles > category overrides > (b) category temperature overrides base temperature [0.07ms]
(pass) generateCategoryShuttles > category overrides > (c) category prompt_append is set on the descriptor [0.03ms]
(pass) generateCategoryShuttles > category overrides > (d) category tool_policy merges over base: category fields win, unset fields keep base values [0.05ms]
(pass) generateCategoryShuttles > category overrides > (e) category prompt_append composes with base prompt_append [0.03ms]
(pass) generateCategoryShuttles > category overrides > (f) base prompt_append is preserved when category has no prompt_append [0.03ms]
(pass) generateCategoryShuttles > category overrides > (g) fields not set in category (e.g. temperature) keep their base shuttle value [0.19ms]
(pass) generateCategoryShuttles > disabling > (a) returns ok({}) when base shuttle is in disabled.agents [0.09ms]
(pass) generateCategoryShuttles > disabling > (b) skips only the disabled category shuttle; others are still generated [0.11ms]
(pass) generateCategoryShuttles > disabling > (c) base shuttle disabled suppresses ALL category shuttles [0.05ms]
(pass) generateCategoryShuttles > conflict detection > (a) returns err(CategoryShuttleConflictError) when shuttle-{name} is explicitly declared [0.03ms]
(pass) generateCategoryShuttles > conflict detection > (b) error contains the correct shuttleName and categoryName fields [0.04ms]
(pass) generateCategoryShuttles > conflict detection > (c) error message is human-readable and names both the agent and the category [0.04ms]
(pass) generateCategoryShuttles > conflict detection > (d) returns ok when shuttle-{name} is in disabled.agents but not explicitly declared [0.02ms]

packages/engine/src/__tests__/runner.test.ts:
(pass) WeaveRunner > lifecycle > calls init exactly once before spawning any agent [0.38ms]
(pass) WeaveRunner > lifecycle > completes without error on an empty config [0.07ms]
(pass) WeaveRunner > agent spawning > spawns a single agent with correct name and config [0.22ms]
(pass) WeaveRunner > agent spawning > spawns all agents in a multi-agent config [0.22ms]
(pass) WeaveRunner > agent spawning > passes tool_policy through to the adapter unchanged [0.22ms]
(pass) WeaveRunner > disabled agents > does not spawn an agent listed in disable agents [0.24ms]
(pass) WeaveRunner > disabled agents > spawns no agents when all are disabled [0.07ms]
(pass) WeaveRunner > disabled agents > still calls init even when all agents are disabled [0.04ms]
(pass) WeaveRunner > call ordering > init always precedes spawnSubagent calls [0.05ms]
(pass) WeaveRunner > category shuttle spawning > spawns a generated shuttle-{name} agent when a category is configured [0.09ms]
(pass) WeaveRunner > category shuttle spawning > spawns multiple generated shuttles for multiple categories [0.08ms]
(pass) WeaveRunner > category shuttle spawning > does not spawn a category shuttle when the base shuttle is disabled [0.07ms]
(pass) WeaveRunner > category shuttle spawning > does not spawn a specific category shuttle when its name is in disabled.agents [0.07ms]
(pass) WeaveRunner > category shuttle spawning > category shuttle descriptor carries category models [0.16ms]
(pass) WeaveRunner > category shuttle spawning > throws when a category would generate a name that is already explicitly declared [0.38ms]

packages/cli/src/detect/__tests__/detect.test.ts:
(pass) harness detection > detects all harnesses [0.60ms]
(pass) harness detection > returns none detected [0.10ms]
(pass) harness detection > detects partial harness sets [0.06ms]
(pass) harness detection > marks unreadable config paths [0.04ms]
(pass) harness detection > detects PATH-binary-only harnesses [0.04ms]
(pass) harness detection > includes optional version data [0.12ms]
(pass) harness detection > does not call write probes [0.10ms]

packages/cli/src/prompt/__tests__/prompt.test.ts:
(pass) prompt adapter > returns selected scope answers [0.23ms]
(pass) prompt adapter > returns install-directory defaults and overrides [0.18ms]
(pass) prompt adapter > returns multi-select harness answers [0.10ms]
(pass) prompt adapter > returns adapter module prompts [0.08ms]
(pass) prompt adapter > reports non-TTY prompt unavailability [0.09ms]
(pass) prompt adapter > supports --yes style bypass by not prompting
(pass) prompt adapter > returns cancellation as an explicit result [0.03ms]

packages/cli/src/commands/__tests__/init.test.ts:
(pass) init command > creates global config and prompts non-interactively [0.90ms]
(pass) init command > creates local config and prompts non-interactively [0.18ms]
(pass) init command > is idempotent without force [0.19ms]
(pass) init command > creates a backup when force overwrites [0.14ms]
(pass) init command > generated config validates [0.58ms]
(pass) init command > reports non-TTY fallback [0.04ms]
(pass) init command > handles prompt cancellation with exit code zero [0.10ms]
(pass) init command > reports detected harnesses and installs supported explicit OpenCode [0.29ms]

packages/cli/src/commands/__tests__/validate.test.ts:
(pass) validate command > validates explicit paths [0.60ms]
(pass) validate command > validates project config [0.29ms]
(pass) validate command > validates global config [0.21ms]
(pass) validate command > prints file line and column for invalid DSL [0.38ms]
(pass) validate command > prints missing file errors [0.09ms]
(pass) validate command > emits parseable JSON [0.45ms]

packages/cli/src/installers/__tests__/installers.test.ts:
(pass) harness installers > installs supported OpenCode integration [0.26ms]
(pass) harness installers > installs optional adapter modules [0.19ms]
(pass) harness installers > is idempotent without force [0.21ms]
(pass) harness installers > allows forced reinstall marker [0.07ms]
(pass) harness installers > returns unsupported explicit harness errors [0.06ms]
(pass) harness installers > bulk install skips unsupported harnesses [0.30ms]

 298 pass
 0 fail
 754 expect() calls
Ran 298 tests across 23 files. [155.00ms]
```

## Reviewer Conclusion

The CLI can safely install supported harness integration, reject unsupported explicit requests, skip unsupported bulk targets, document user workflows, and pass all repository quality gates.
