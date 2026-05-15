# @weave — AI Context Map

> **Stack:** raw-http | none | unknown | typescript
> **Monorepo:** @weave/core, @weave/engine, @weave/config, @weave/cli, @weave/adapter-opencode

> 0 routes | 0 models | 0 components | 36 lib files | 2 env vars | 0 middleware | 0% test coverage
> **Token savings:** this file is ~3,100 tokens. Without it, AI exploration would cost ~18,700 tokens. **Saves ~15,700 tokens per conversation.**
> **Last scanned:** 2026-05-15 21:58 — re-run after significant changes

---

# Libraries

- `packages/cli/src/args.ts`
  - function parseArgs: (argv) => Result<ParsedArgs, ArgParseError>
  - interface ParsedArgs
  - type Command
  - type ArgParseError
- `packages/cli/src/cli.ts` — function run: (deps?) => Promise<Result<number, CliError>>, interface CliDeps
- `packages/cli/src/commands/init.ts` — function runInit: (ctx) => Promise<Result<number, CliError>>, interface InitContext
- `packages/cli/src/commands/validate.ts`
  - function validateExplicitPath: (path, fs) => ResultAsync<ValidatedConfig, ValidateError>
  - function formatSummary: (config) => string
  - function runValidate: (ctx) => Promise<Result<number, CliError>>
  - interface ValidateContext
- `packages/cli/src/config/starter-config.ts` — function starterConfig: (scope) => string
- `packages/cli/src/detect/index.ts`
  - function detectHarnesses: (probes) => void
  - function formatDetectionSummary: (harnesses) => string[]
  - type SupportedHarnessId
  - type DetectedHarness
  - type DetectionError
- `packages/cli/src/detect/probes.ts`
  - class BunDetectionProbes
  - class MemoryDetectionProbes
  - interface DetectionProbes
  - type ProbeError
- `packages/cli/src/errors.ts`
  - function formatCliError: (error) => string
  - type CliError
  - type InvalidArgsError
  - type MissingFileError
  - type FileReadError
  - type ParseFailureError
  - _...2 more_
- `packages/cli/src/fs/file-system.ts`
  - function describeFileSystemError: (error) => string
  - class BunFileSystem
  - class MemoryFileSystem
  - interface FileSystem
  - type FileSystemErrorCause
  - type FileSystemError
- `packages/cli/src/installers/index.ts`
  - function installerRegistry: (fs) => Record<SupportedHarnessId, HarnessInstaller>
  - function unsupportedInstaller: (id) => HarnessInstaller
  - function skipUnsupported: (id) => InstallResult
  - function installAllSupported: (input, string[]>;
}) => ResultAsync<InstallResult[], InstallError>
  - interface HarnessInstaller
  - type AdapterModule
  - _...3 more_
- `packages/cli/src/installers/opencode.ts` — class OpenCodeInstaller
- `packages/cli/src/installers/unsupported.ts` — function unsupportedHarnessInstall: (harness) => ResultAsync<InstallResult, InstallError>, function undetectedHarnessInstall: (harness) => ResultAsync<InstallResult, InstallError>
- `packages/cli/src/io/terminal.ts`
  - class RealTerminal
  - class BufferTerminal
  - interface TerminalIO
- `packages/cli/src/prompt/index.ts`
  - class ClackPromptAdapter
  - class StaticPromptAdapter
  - interface PromptAdapter
  - type PromptError
  - type PromptOption
- `packages/cli/src/theme/ascii-logo.ts`
  - function renderLogo: (theme) => string[]
  - const PLAIN_LOGO_LINES: string[]
  - const LOGO_WIDTH
- `packages/cli/src/theme/colors.ts`
  - class ThemeManager
  - interface ThemeColors
  - interface ThemeManagerDeps
  - const defaultThemeManager
- `packages/cli/src/theme/render.ts`
  - class ThemeRenderer
  - interface VersionSource
  - const defaultThemeRenderer
- `packages/config/src/builtins.ts`
  - function getBuiltinConfig: () => Result<WeaveConfig, ConfigError[]>
  - const BUILTIN_AGENT_NAMES: readonly string[]
  - const BUILTIN_WEAVE_SOURCE
- `packages/config/src/discovery.ts`
  - function discoverAndParse: (projectRoot?, fileReader) => ResultAsync<DiscoveredConfig[], ConfigLoadError[]>
  - interface FileReader
  - type DiscoveredConfig
  - const bunFileReader: FileReader
- `packages/config/src/loader.ts` — function loadConfig: (projectRoot?, fileReader) => ResultAsync<import("@weave/core").WeaveConfig, ConfigLoadError[]>
- `packages/config/src/merge.ts` — function mergeConfigs: (...configs) => WeaveConfig
- `packages/config/src/normalize-path.ts` — function normalizePath: (p) => string
- `packages/config/src/resolve.ts` — function resolvePromptPaths: (config, scope) => WeaveConfig
- `packages/core/src/errors.ts`
  - function formatError: (error) => string
  - type LexError
  - type ParseError
  - type ValidationError
  - type ConfigError
- `packages/core/src/lexer.ts` — function tokenize: (source) => Result<Token[], LexError[]>, class Lexer
- `packages/core/src/parse-config.ts` — function parseConfig: (source) => Result<WeaveConfig, ConfigError[]>
- `packages/core/src/parser.ts` — function parse: (tokens) => Result<AstNode[], ParseError[]>, class Parser
- `packages/core/src/validate.ts` — function validate: (ast) => Result<WeaveConfig, ValidationError[]>
- `packages/engine/src/capability-contract.ts`
  - function evaluateCoreReadinessProfile: (contract) => ProfileEvaluationResult
  - function buildAdapterHealthReport: (input) => AdapterHealthReport
  - function buildHumanRows: (report) => HumanReadinessRow[]
  - function buildToonRows: (report) => ToonReadinessRow[]
  - function toJson: (report) => string
  - interface CapabilityEntry
  - _...18 more_
- `packages/engine/src/descriptors.ts` — function generateCategoryShuttles: (config) => Result<Record<string, AgentConfig>, CategoryShuttleConflictError>, type CategoryShuttleConflictError
- `packages/engine/src/env.ts`
  - function parseEnv: (raw) => Env
  - type Env
  - const envSchema
  - const env: Env
- `packages/engine/src/model-resolution.ts`
  - function resolveAdapterModelIntent: (input) => ModelResolutionResult
  - interface ModelResolutionInput
  - interface ModelResolutionResult
  - type ResolutionSource
  - const DEFAULT_FALLBACK_MODEL
- `packages/engine/src/runner.ts` — class WeaveRunner, interface WeaveRunnerOptions
- `packages/engine/src/skill-resolution.ts`
  - function resolveSkillsForAgent: (input) => Result<ResolvedSkill[], SkillResolutionError[]>
  - function resolveSkillsForConfig: (input) => Result<ConfigSkillResolutionResult, SkillResolutionError[]>
  - interface SkillInfo
  - interface ResolvedSkill
  - interface SkillResolutionInput
  - interface SkillResolutionConfigInput
  - _...2 more_
- `packages/engine/src/tool-policy.ts`
  - function evaluateEffectiveToolPolicy: (policy) => EffectiveToolPolicy
  - function resolveToolDecisions: (toolIds, classifications, effectivePolicy) => ToolDecision[]
  - type EffectiveToolPolicy
  - type ConcreteToolClassification
  - type MappedToolDecision
  - type UnmappedToolDecision
  - _...3 more_
- `scripts/validate-config.ts` — function printSummary: (config, configPath) => void

---

# Config

## Environment Variables

- `HOME` **required** — packages/cli/src/detect/probes.ts
- `LOG_LEVEL` **required** — packages/config/src/logger.ts

## Config Files

- `tsconfig.json`

---

# Dependency Graph

## Most Imported Files (change these carefully)

- `packages/cli/src/theme/colors.ts` — imported by **10** files
- `packages/cli/src/io/terminal.ts` — imported by **8** files
- `packages/core/src/tokens.ts` — imported by **8** files
- `packages/cli/src/fs/file-system.ts` — imported by **7** files
- `packages/core/src/errors.ts` — imported by **6** files
- `packages/cli/src/theme/render.ts` — imported by **5** files
- `packages/cli/src/args.ts` — imported by **5** files
- `packages/config/src/discovery.ts` — imported by **5** files
- `packages/config/src/types.ts` — imported by **5** files
- `packages/core/src/lexer.ts` — imported by **5** files
- `packages/engine/src/descriptors.ts` — imported by **5** files
- `packages/cli/src/cli.ts` — imported by **4** files
- `packages/cli/src/errors.ts` — imported by **4** files
- `packages/config/src/normalize-path.ts` — imported by **4** files
- `packages/core/src/parser.ts` — imported by **4** files
- `packages/engine/src/env.ts` — imported by **4** files
- `packages/cli/src/commands/validate.ts` — imported by **3** files
- `packages/cli/src/detect/probes.ts` — imported by **3** files
- `packages/cli/src/prompt/index.ts` — imported by **3** files
- `packages/cli/src/installers/index.ts` — imported by **3** files

## Import Map (who imports what)

- `packages/cli/src/theme/colors.ts` ← `packages/cli/src/__tests__/theme.test.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/validate.test.ts`, `packages/cli/src/commands/init.ts` +5 more
- `packages/cli/src/io/terminal.ts` ← `packages/cli/src/__tests__/routing.test.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/validate.test.ts`, `packages/cli/src/commands/init.ts` +3 more
- `packages/core/src/tokens.ts` ← `packages/core/src/__tests__/lexer.test.ts`, `packages/core/src/ast.ts`, `packages/core/src/ast.ts`, `packages/core/src/index.ts`, `packages/core/src/index.ts` +3 more
- `packages/cli/src/fs/file-system.ts` ← `packages/cli/src/__tests__/file-system.test.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/validate.test.ts`, `packages/cli/src/commands/validate.ts`, `packages/cli/src/installers/__tests__/installers.test.ts` +2 more
- `packages/core/src/errors.ts` ← `packages/core/src/__tests__/errors.test.ts`, `packages/core/src/index.ts`, `packages/core/src/lexer.ts`, `packages/core/src/parse-config.ts`, `packages/core/src/parser.ts` +1 more
- `packages/cli/src/theme/render.ts` ← `packages/cli/src/__tests__/theme.test.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/init.ts`, `packages/cli/src/index.ts`, `packages/cli/src/index.ts`
- `packages/cli/src/args.ts` ← `packages/cli/src/cli.ts`, `packages/cli/src/commands/init.ts`, `packages/cli/src/commands/validate.ts`, `packages/cli/src/index.ts`, `packages/cli/src/index.ts`
- `packages/config/src/discovery.ts` ← `packages/config/src/__tests__/discovery.test.ts`, `packages/config/src/__tests__/discovery.test.ts`, `packages/config/src/__tests__/load_config.test.ts`, `packages/config/src/index.ts`, `packages/config/src/index.ts`
- `packages/config/src/types.ts` ← `packages/config/src/__tests__/resolve.test.ts`, `packages/config/src/discovery.ts`, `packages/config/src/index.ts`, `packages/config/src/loader.ts`, `packages/config/src/resolve.ts`
- `packages/core/src/lexer.ts` ← `packages/core/src/__tests__/lexer.test.ts`, `packages/core/src/__tests__/parser.test.ts`, `packages/core/src/__tests__/validate.test.ts`, `packages/core/src/index.ts`, `packages/core/src/parse-config.ts`

---

# Test Coverage

> **0%** of routes and models are covered by tests
> 31 test files found

---

_Generated by [codesight](https://github.com/Houseofmvps/codesight) — see your codebase clearly_