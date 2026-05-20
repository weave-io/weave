# @weave — AI Context Map

> **Stack:** raw-http | none | unknown | typescript
> **Monorepo:** @weave/core, @weave/engine, @weave/config, @weave/cli, @weave/adapter-opencode

> 0 routes | 0 models | 0 components | 49 lib files | 2 env vars | 0 middleware | 0% test coverage
> **Token savings:** this file is ~4,100 tokens. Without it, AI exploration would cost ~22,100 tokens. **Saves ~18,000 tokens per conversation.**
> **Last scanned:** 2026-05-20 20:13 — re-run after significant changes

---

# Libraries

- `packages/cli/src/args.ts`
  - function parseArgs: (argv) => Result<ParsedArgs, ArgParseError>
  - interface ParsedArgs
  - type Command
  - type ArgParseError
- `packages/cli/src/cli.ts` — function run: (deps?) => Promise<Result<number, CliError>>, interface CliDeps
- `packages/cli/src/commands/init.ts` — function runInit: (ctx) => Promise<Result<number, CliError>>, interface InitContext
- `packages/cli/src/commands/runtime.ts`
  - function runRuntime: (ctx) => Promise<Result<number, CliError>>
  - interface RuntimeCommandContext
  - const DEFAULT_RUNTIME_DB_PATH
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
- `packages/engine/src/compose.ts`
  - function composeAgentDescriptor: (agentName, agentConfig, config, allAgents, AgentConfig>, category?) => ResultAsync<AgentDescriptor, ComposeError>
  - interface AgentDescriptor
  - interface DelegationTarget
  - type PromptTemplateReason
  - type ComposeError
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
- `packages/engine/src/runtime/errors.ts`
  - function initializationError: (message, cause?) => RuntimeStoreInitializationError
  - function migrationVersionError: (foundVersion, supportedVersion, message) => RuntimeStoreMigrationVersionError
  - function serializationError: (message, cause?) => RuntimeStoreSerializationError
  - function queryError: (message, cause?) => RuntimeStoreQueryError
  - function notFoundError: (entity, id, message?) => RuntimeStoreNotFoundError
  - function conflictError: (entity, message, conflictingId?) => RuntimeStoreConflictError
  - _...11 more_
- `packages/engine/src/runtime/fingerprint.ts` — function createProjectSalt: () => string, function fingerprintContent: (salt, content) => ResultAsync<string, RuntimeStoreError>
- `packages/engine/src/runtime/journal-writer.ts` — class RuntimeJournalWriter, interface WriteJournalEntryInput
- `packages/engine/src/runtime/memory-store.ts`
  - function createInMemoryRuntimeStore: (options) => InMemoryRuntimeStore
  - class InMemoryRuntimeStore
  - interface InMemoryRuntimeStoreFailureConfig
  - interface InMemoryRuntimeStoreOptions
- `packages/engine/src/runtime/sanitizer.ts` — function sanitizeJournalData: (data, unknown>) => Result<Record<string, unknown>, RuntimeStoreError>, function sanitizeSnapshotMetadata: (metadata, string | number | boolean>) => Result<Record<string, string | number | boolean>, RuntimeStoreError>
- `packages/engine/src/runtime/sqlite/kysely-bun-sqlite.ts` — class BunSqliteDialect
- `packages/engine/src/runtime/sqlite/migrations.ts`
  - function runMigrations: (db) => Result<void, RuntimeStoreError>
  - function readSchemaVersion: (db) => number
  - const CURRENT_SCHEMA_VERSION
- `packages/engine/src/runtime/sqlite/store.ts`
  - function createSqliteRuntimeStore: (options) => SqliteRuntimeStore
  - class SqliteRuntimeStore
  - interface SqliteRuntimeStoreOptions
- `packages/engine/src/runtime/types.ts`
  - function createWorkflowInstanceId: (raw) => WorkflowInstanceId
  - function createExecutionLeaseId: (raw) => ExecutionLeaseId
  - function createSessionSnapshotId: (raw) => SessionSnapshotId
  - function createRuntimeJournalEntryId: (raw) => RuntimeJournalEntryId
  - function createOwnerId: (raw) => OwnerId
  - interface ArtifactRef
  - _...15 more_
- `packages/engine/src/skill-resolution.ts`
  - function resolveSkillsForAgent: (input) => Result<ResolvedSkill[], SkillResolutionError[]>
  - function resolveSkillsForConfig: (input) => Result<ConfigSkillResolutionResult, SkillResolutionError[]>
  - interface SkillInfo
  - interface ResolvedSkill
  - interface SkillResolutionInput
  - interface SkillResolutionConfigInput
  - _...2 more_
- `packages/engine/src/template-context.ts`
  - function buildTemplateContext: (input) => Result<AgentPromptTemplateContext, TemplateContextError>
  - interface AgentContextEntry
  - interface CategoryContextEntry
  - interface ToolPolicyContextEntry
  - interface DelegationTargetContextEntry
  - interface DelegationContextEntry
  - _...5 more_
- `packages/engine/src/template-renderer.ts`
  - function renderTemplate: (source, context, options) => Result<string, RendererError>
  - function extractTemplatePaths: (source) => Result<string[], RendererError>
  - interface TemplateContext
  - interface RenderOptions
  - type RendererError
  - type TemplateContextValue
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

- `packages/cli/src/theme/colors.ts` — imported by **12** files
- `packages/cli/src/io/terminal.ts` — imported by **10** files
- `packages/engine/src/runtime/errors.ts` — imported by **10** files
- `packages/core/src/tokens.ts` — imported by **8** files
- `packages/engine/src/compose.ts` — imported by **8** files
- `packages/cli/src/fs/file-system.ts` — imported by **7** files
- `packages/cli/src/args.ts` — imported by **6** files
- `packages/core/src/errors.ts` — imported by **6** files
- `packages/engine/src/logger.ts` — imported by **6** files
- `packages/cli/src/cli.ts` — imported by **5** files
- `packages/cli/src/theme/render.ts` — imported by **5** files
- `packages/cli/src/errors.ts` — imported by **5** files
- `packages/config/src/discovery.ts` — imported by **5** files
- `packages/config/src/types.ts` — imported by **5** files
- `packages/core/src/lexer.ts` — imported by **5** files
- `packages/engine/src/descriptors.ts` — imported by **5** files
- `packages/config/src/builtins.ts` — imported by **4** files
- `packages/config/src/normalize-path.ts` — imported by **4** files
- `packages/core/src/parser.ts` — imported by **4** files
- `packages/engine/src/env.ts` — imported by **4** files

## Import Map (who imports what)

- `packages/cli/src/theme/colors.ts` ← `packages/cli/src/__tests__/theme.test.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/runtime.test.ts`, `packages/cli/src/commands/__tests__/validate.test.ts` +7 more
- `packages/cli/src/io/terminal.ts` ← `packages/cli/src/__tests__/routing.test.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/runtime.test.ts`, `packages/cli/src/commands/__tests__/validate.test.ts` +5 more
- `packages/engine/src/runtime/errors.ts` ← `packages/engine/src/__tests__/runtime-contract.test.ts`, `packages/engine/src/__tests__/runtime-journal.test.ts`, `packages/engine/src/__tests__/runtime-journal.test.ts`, `packages/engine/src/runtime/fingerprint.ts`, `packages/engine/src/runtime/fingerprint.ts` +5 more
- `packages/core/src/tokens.ts` ← `packages/core/src/__tests__/lexer.test.ts`, `packages/core/src/ast.ts`, `packages/core/src/ast.ts`, `packages/core/src/index.ts`, `packages/core/src/index.ts` +3 more
- `packages/engine/src/compose.ts` ← `packages/engine/src/__tests__/compose.test.ts`, `packages/engine/src/__tests__/mock-adapter.ts`, `packages/engine/src/__tests__/template-context.test.ts`, `packages/engine/src/adapter.ts`, `packages/engine/src/index.ts` +3 more
- `packages/cli/src/fs/file-system.ts` ← `packages/cli/src/__tests__/file-system.test.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/validate.test.ts`, `packages/cli/src/commands/validate.ts`, `packages/cli/src/installers/__tests__/installers.test.ts` +2 more
- `packages/cli/src/args.ts` ← `packages/cli/src/cli.ts`, `packages/cli/src/commands/__tests__/runtime.test.ts`, `packages/cli/src/commands/init.ts`, `packages/cli/src/commands/validate.ts`, `packages/cli/src/index.ts` +1 more
- `packages/core/src/errors.ts` ← `packages/core/src/__tests__/errors.test.ts`, `packages/core/src/index.ts`, `packages/core/src/lexer.ts`, `packages/core/src/parse-config.ts`, `packages/core/src/parser.ts` +1 more
- `packages/engine/src/logger.ts` ← `packages/engine/src/index.ts`, `packages/engine/src/runner.ts`, `packages/engine/src/runtime/journal-writer.ts`, `packages/engine/src/runtime/sqlite/store.ts`, `packages/engine/src/template-context.ts` +1 more
- `packages/cli/src/cli.ts` ← `packages/cli/src/__tests__/routing.test.ts`, `packages/cli/src/commands/__tests__/runtime.test.ts`, `packages/cli/src/index.ts`, `packages/cli/src/index.ts`, `packages/cli/src/main.ts`

---

# Test Coverage

> **0%** of routes and models are covered by tests
> 41 test files found

---

_Generated by [codesight](https://github.com/Houseofmvps/codesight) — see your codebase clearly_