# @weave — AI Context Map

> **Stack:** raw-http | none | unknown | typescript
> **Monorepo:** @weave/core, @weave/engine, @weave/config, @weave/cli, @weave/docs, @weave/adapter-opencode

> 0 routes | 0 models | 0 components | 92 lib files | 7 env vars | 5 middleware | 0% test coverage
> **Token savings:** this file is ~7,600 tokens. Without it, AI exploration would cost ~35,200 tokens. **Saves ~27,700 tokens per conversation.**
> **Last scanned:** 2026-06-11 20:40 — re-run after significant changes

---

# Libraries

- `packages/adapters/opencode/src/adapter.ts`
  - class OpenCodeAdapterError
  - class OpenCodeAdapter
  - interface OpenCodeAdapterOptions
- `packages/adapters/opencode/src/model-resolution.ts`
  - function resolveModelForAgent: (descriptor, context) => Result<string, ModelResolutionError>
  - interface OpenCodeModelContext
  - type ModelResolutionError
- `packages/adapters/opencode/src/opencode-client.ts`
  - class SdkOpenCodeClient
  - interface OpenCodeClientFacade
  - type OpenCodeClientError
- `packages/adapters/opencode/src/plugin.ts`
  - function createWeavePlugin: (options) => Plugin
  - interface WeavePluginOptions
  - const WeavePlugin: Plugin
  - const server
- `packages/adapters/opencode/src/projection-helpers.ts` — function buildProjectEffect: (adapter) => (effect: DispatchAgentEffect) => ResultAsync<void, WorkflowRunnerError>, function deriveRunWorkflowResult: (data) => RunWorkflowResult
- `packages/adapters/opencode/src/reconcile-agent.ts`
  - function classifyExistingAgent: (agentName, existingAgents) => ReconcileDecision
  - function tagWithOwnership: (config) => OpenCodeAgentConfig
  - function reconcileAgent: (agentName, config, client) => ResultAsync<void, ReconcileAgentError>
  - type ReconcileAgentError
  - type ReconcileDecision
  - const WEAVE_OWNERSHIP_TAG
- `packages/adapters/opencode/src/run-workflow.ts`
  - function runWorkflow: (input) => ResultAsync<RunWorkflowResult, RunWorkflowError>
  - interface RunWorkflowInput
  - interface RunWorkflowResult
  - type RunWorkflowError
- `packages/adapters/opencode/src/runtime-command-projection.ts`
  - function buildOpenCodeHealthReport: (overrides?) => AdapterHealthReport
  - class RuntimeCommandProjection
  - interface ProjectionSuccess
  - interface ProjectionFailure
  - interface ProjectionDegraded
  - interface StartPlanProjectionInput
  - _...7 more_
- `packages/adapters/opencode/src/skill-discovery.ts`
  - function buildSkillInfoList: (names) => SkillInfo[]
  - function validateDeclaredSkills: (declaredSkills, availableSkills, disabledSkills) => Result<void, MissingSkillsError>
  - interface MissingSkillsError
- `packages/adapters/opencode/src/start-plan-execution.ts`
  - function startPlanExecution: (input) => ResultAsync<RunWorkflowResult, StartPlanExecutionError>
  - interface StartPlanExecutionInput
  - type StartPlanExecutionError
  - const WEAVE_START_COMMAND
  - const WEAVE_START_LEGACY_COMMAND
  - const DEFAULT_EXECUTION_WORKFLOW
- `packages/adapters/opencode/src/tool-policy-mapping.ts`
  - function toOpenCodePermission: (permission) => OpenCodePermissionValue
  - function buildReadToolsEntry: (readPermission) => Record<string, boolean> | undefined
  - function mapToolPolicy: (policy) => void
  - type OpenCodePermissionValue
  - type OpenCodeToolPermissions
  - const READ_TOOL_NAMES: readonly string[]
- `packages/adapters/opencode/src/translate-agent.ts` — function translateAgent: (descriptor, resolvedModel?) => Result<OpenCodeAgentConfig, TranslateAgentError>, type TranslateAgentError
- `packages/cli/src/args.ts`
  - function parseArgs: (argv) => Result<ParsedArgs, ArgParseError>
  - interface ParsedArgs
  - type Command
  - type ArgParseError
- `packages/cli/src/cli.ts` — function run: (deps?) => Promise<Result<number, CliError>>, interface CliDeps
- `packages/cli/src/commands/init.ts`
  - function runInit: (ctx) => Promise<Result<number, CliError>>
  - function installHarnesses: (input) => Promise<number>
  - interface InitContext
- `packages/cli/src/commands/migrate.ts`
  - function renderMigrateSuccess: (theme, plan, result) => string
  - function resolveSelectedHarnesses: (flags, harnesses) => SupportedHarnessId[]
  - function runMigrateMode: (ctx, installHarnesses, harnesses) => void
  - interface MigrateContext
  - type InitScope
  - type InitPlan
- `packages/cli/src/commands/prompt.ts` — function runPrompt: (ctx) => Promise<Result<number, CliError>>, interface PromptContext
- `packages/cli/src/commands/runtime.ts` — function runRuntime: (ctx) => Promise<Result<number, CliError>>, interface RuntimeCommandContext
- `packages/cli/src/commands/validate.ts` — function runValidate: (ctx) => Promise<Result<number, CliError>>, interface ValidateContext
- `packages/cli/src/config/starter-config.ts` — function starterConfig: (scope) => string
- `packages/cli/src/detect/index.ts`
  - function isHarnessId: (value) => value is SupportedHarnessId
  - function detectHarnesses: (probes) => void
  - function formatDetectionSummary: (harnesses) => string[]
  - type SupportedHarnessId
  - type DetectedHarness
  - type DetectionError
  - _...1 more_
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
  - _...4 more_
- `packages/cli/src/fs/file-system.ts`
  - function describeFileSystemError: (error) => string
  - class BunFileSystem
  - class MemoryFileSystem
  - interface FileSystem
  - type FileSystemError
- `packages/cli/src/installers/index.ts`
  - function installerRegistry: (fs) => Record<SupportedHarnessId, HarnessInstaller>
  - function installAllSupported: (input, string[]>;
}) => ResultAsync<InstallResult[], InstallError>
  - interface HarnessInstaller
  - type AdapterModule
  - type InstallRequest
  - type InstallResult
  - _...1 more_
- `packages/cli/src/installers/opencode.ts` — class OpenCodeInstaller
- `packages/cli/src/io/terminal.ts`
  - class RealTerminal
  - class BufferTerminal
  - interface TerminalIO
- `packages/cli/src/migration/conversion-warnings.ts` — function renderConversionWarnings: (warnings) => string
- `packages/cli/src/migration/legacy-jsonc-converter.ts` — function stripJsoncComments: (source) => string, function convertLegacyJsonc: (source) => ConversionResult
- `packages/cli/src/migration/migration-plan.ts`
  - function buildMigrationPlan: (scope, fs, skippedWarningCount) => MigrationPlan
  - function detectLegacySource: (scope, fs) => ResultAsync<string | undefined,
  - const LEGACY_SOURCE_RELATIVE: Record<MigrationScope, string>
  - const CANONICAL_WEAVE_DIR: Record<MigrationScope, string>
- `packages/cli/src/migration/migration-write.ts`
  - function buildMigratedContent: (plan, conversion) => string
  - function writeMigratedDsl: (fs, plan, dslContent, destExists) => ResultAsync<
  - function performMigrationWrite: (fs, plan, sourceContent, destExists, preConversion?) => ResultAsync<
- `packages/cli/src/prompt/index.ts`
  - class ClackPromptAdapter
  - class StaticPromptAdapter
  - interface PromptAdapter
  - type PromptError
  - type PromptOption
- `packages/cli/src/prompts/self-modify.ts`
  - function resolveSelfModifyPaths: (ctx) => SelfModifyPaths
  - function renderSelfModifyPrompt: (ctx) => string
  - interface SelfModifyContext
  - interface SelfModifyPaths
  - type SelfModifyScope
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
  - const BUILTIN_PROMPT_CONTENTS: Readonly<Record<string, string>>
  - const BUILTIN_WEAVE_SOURCE
- `packages/config/src/discovery.ts`
  - function discoverAndParse: (projectRoot?, fileReader) => ResultAsync<DiscoveredConfig[], ConfigLoadError[]>
  - interface FileReader
  - type DiscoveredConfig
  - const bunFileReader: FileReader
- `packages/config/src/loader.ts` — function loadConfig: (projectRoot?, fileReader) => ResultAsync<import("@weave/core").WeaveConfig, ConfigLoadError[]>
- `packages/config/src/merge.ts`
  - function mergeWorkflow: (workflowName, base, override, workflowMap, WorkflowConfig>) => Result<WorkflowConfig, WorkflowExtensionError>
  - function mergeConfigsResult: (...configs) => Result<WeaveConfig, MergeError[]>
  - function mergeConfigs: (...configs) => WeaveConfig
  - type WorkflowExtensionError
  - type MergeError
- `packages/config/src/normalize-path.ts` — function normalizePath: (p) => string
- `packages/config/src/plan-state-provider.ts` — class BunFilesystemPlanStateProvider
- `packages/config/src/resolve.ts` — function resolvePromptPaths: (config, scope) => WeaveConfig
- `packages/core/src/errors.ts`
  - function formatError: (error) => string
  - type LexError
  - type ParseError
  - type ValidationError
  - type ConfigError
- `packages/core/src/lexer.ts` — function tokenize: (source) => Result<Token[], LexError[]>
- `packages/core/src/parse-config.ts` — function parseConfig: (source) => Result<WeaveConfig, ConfigError[]>
- `packages/core/src/parser.ts` — function parse: (tokens) => Result<AstNode[], ParseError[]>
- `packages/core/src/prompt-schema-helpers.ts`
  - function refinePromptAppendExclusive: () => [
  - function refinePromptExclusive: () => [
  - function refinePromptFileSafe: (field) => [(data: HasPromptFile) => boolean,
- `packages/core/src/validate.ts` — function validate: (ast) => Result<WeaveConfig, ValidationError[]>
- `packages/docs/src/utils/base-url.ts` — function normalizeBaseUrl: (base) => string, function withBaseUrl: (base, path) => string
- `packages/engine/src/capability-contract.ts`
  - function evaluateCoreReadinessProfile: (contract) => ProfileEvaluationResult
  - function buildAdapterHealthReport: (input) => AdapterHealthReport
  - function buildHumanRows: (report) => HumanReadinessRow[]
  - function buildToonRows: (report) => ToonReadinessRow[]
  - function toJson: (report) => string
  - interface CapabilityEntry
  - _...18 more_
- `packages/engine/src/compose.ts`
  - function detectAppendCollisions: (configs) => AppendCollision[]
  - function composeWorkflowStepPrompt: (stepName, step, workflow, templateContext) => ResultAsync<WorkflowStepComposedPrompt, ComposeError>
  - function composeAgentDescriptor: (agentName, agentConfig, config, allAgents, AgentConfig>, category?) => ResultAsync<AgentDescriptor, ComposeError>
  - interface CategoryMetadata
  - interface AgentDescriptor
  - interface AgentDescriptorCategory
  - _...6 more_
- `packages/engine/src/descriptors.ts`
  - function generateCategoryShuttles: (config) => Result<
  - interface GeneratedCategoryShuttle
  - type CategoryShuttleConflictError
- `packages/engine/src/env.ts`
  - function parseEnv: (raw, string | undefined>) => Result<Env, EnvValidationError>
  - type Env
  - type EnvValidationError
  - const envSchema
  - const env: Env
- `packages/engine/src/execution-lifecycle/artifacts.ts`
  - function latestArtifactByName: (instance, name) => ArtifactRef | undefined
  - function latestAttemptForStep: (instance, stepName) => StepAttemptRecord | undefined
  - function isApprovalInvalidated: (instance, artifactName) => boolean
  - function verifyArtifactIntegrity: (artifact, suppliedDigest) => Result<undefined, LifecycleError>
  - function inputRole: (input) => "normative" | "informational"
  - function validateStepInputs: (step, instance, artifactDigests?, string>>, pinnedNames?) => Result<ArtifactInputSummary, LifecycleError>
  - _...3 more_
- `packages/engine/src/execution-lifecycle/authorization.ts` — function validateAuthorizationSource: (source, operation) => Result<undefined, LifecyclePolicyDecisionError>, function validateReconciliationSource: (reason, source) => Result<undefined, LifecyclePolicyDecisionError>
- `packages/engine/src/execution-lifecycle/before-tool.ts` — function beforeTool: (input) => BeforeToolResult
- `packages/engine/src/execution-lifecycle/completion.ts` — function completeStep: (input, store) => ResultAsync<CompleteStepOutput, LifecycleError>
- `packages/engine/src/execution-lifecycle/dispatch.ts`
  - function buildConfiguredRunAgentEffect: (step, promptMetadata) => RunAgentEffect
  - function resolveWorkflowStep: (workflowConfig, stepName) => Result<WorkflowStep, LifecycleError>
  - function dispatchStep: (input, store) => ResultAsync<DispatchStepOutput, LifecycleError>
- `packages/engine/src/execution-lifecycle/errors.ts`
  - function lifecycleValidationError: (message, field?) => LifecycleValidationError
  - function lifecycleNotFoundError: (entity, id, message?) => LifecycleNotFoundError
  - function lifecycleLeaseConflictError: (workflowInstanceId, conflictingLeaseId, message) => LifecycleLeaseConflictError
  - function lifecyclePersistenceError: (message, cause?) => LifecyclePersistenceError
  - function lifecyclePolicyDecisionError: (message, rule?) => LifecyclePolicyDecisionError
- `packages/engine/src/execution-lifecycle/inspection.ts` — function inspectExecution: (input, store) => InspectExecutionResult
- `packages/engine/src/execution-lifecycle/interrupts.ts` — function handleUserInterrupt: (input, store) => ResultAsync<HandleUserInterruptOutput, LifecycleError>
- `packages/engine/src/execution-lifecycle/lease.ts`
  - function mapStoreError: (storeError) => LifecyclePersistenceError
  - function mapConflictToLeaseConflict: (workflowInstanceId, storeError) => LifecycleLeaseConflictError
  - function validateActiveLease: (activeLease, workflowInstanceId, leaseId) => Result<ExecutionLease, LifecycleError>
- `packages/engine/src/execution-lifecycle/metadata.ts` — function sanitizeMetadata: (metadata) => Result<SafeMetadata, LifecycleValidationError>
- `packages/engine/src/execution-lifecycle/prompt-context.ts`
  - function buildStepPromptContext: (instance, step) => TemplateContext
  - function renderStepPrompt: (promptTemplate, context, artifactNames) => Result<
  - function renderPlanName: (planNameTemplate, instance) => Result<string, LifecycleError>
- `packages/engine/src/execution-lifecycle/reconciliation.ts` — function reconcileExecution: (input, store) => ReconcileExecutionResult
- `packages/engine/src/execution-lifecycle/resume.ts` — function resumeExecution: (input, store) => ResultAsync<ResumeExecutionOutput, LifecycleError>
- `packages/engine/src/execution-lifecycle/session.ts` — function observeSession: (input, store) => ResultAsync<ObserveSessionOutput, LifecycleError>
- `packages/engine/src/execution-lifecycle/start.ts` — function startExecution: (input, store) => ResultAsync<StartExecutionOutput, LifecycleError>
- `packages/engine/src/execution-lifecycle/terminal-outcomes.ts` — function approveArtifact: (input, store) => ApproveArtifactResult
- `packages/engine/src/logger.ts`
  - function redirectLogsToFile: (filePath) => Promise<void>
  - const logDestination
  - const logger
- `packages/engine/src/materialization.ts`
  - function materializeAgents: (input) => ResultAsync<MaterializationPlan, never>
  - interface MaterializationInput
  - interface MaterializedAgent
  - interface MaterializationPlan
  - type MaterializationError
- `packages/engine/src/model-resolution.ts`
  - function resolveAdapterModelIntent: (input) => ModelResolutionResult
  - interface ModelResolutionInput
  - interface ModelResolutionResult
  - type ResolutionSource
  - const DEFAULT_FALLBACK_MODEL
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
- `packages/engine/src/runtime/sanitizer.ts`
  - function isDeniedKey: (key) => boolean
  - function sanitizeJournalData: (data) => Result<JsonObject, RuntimeStoreError>
  - function sanitizeSnapshotMetadata: (metadata, string | number | boolean>) => Result<Record<string, string | number | boolean>, RuntimeStoreError>
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
  - function createArtifactId: (raw) => ArtifactId
  - _...30 more_
- `packages/engine/src/runtime-command-operations/control.ts` — function abortExecution: (input) => import("neverthrow").ResultAsync<, function advanceStep: (input) => import("neverthrow").ResultAsync<StepAdvancedData, CommandOperationError>
- `packages/engine/src/runtime-command-operations/health.ts` — function runtimeHealth: (input) => RuntimeHealthResult
- `packages/engine/src/runtime-command-operations/run-named-workflow.ts` — function runNamedWorkflow: (input, projectEffect) => void
- `packages/engine/src/runtime-command-operations/start-plan.ts` — function startPlan: (input, projectEffect) => void
- `packages/engine/src/runtime-command-operations/status.ts` — function inspectStatus: (input) => import("neverthrow").ResultAsync<
- `packages/engine/src/runtime-command-operations/workflow-runner.ts`
  - function runWorkflowLifecycle: (input) => ResultAsync<WorkflowRunnerOutput, WorkflowRunnerError>
  - function mapWorkflowRunnerErrorToLifecycle: (error) => CommandLifecycleError
  - function mapRunnerErrorToCommandError: (error, operation) => CommandOperationError
  - interface WorkflowRunnerInput
  - interface WorkflowRunnerOutput
  - type WorkflowRunnerError
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
- `packages/engine/src/tool-policy.ts`
  - function evaluateEffectiveToolPolicy: (policy) => EffectiveToolPolicy
  - function resolveToolDecisions: (toolIds, classifications, effectivePolicy) => ToolDecision[]
  - type EffectiveToolPolicy
  - type ConcreteToolClassification
  - type MappedToolDecision
  - type UnmappedToolDecision
  - _...3 more_

---

# Config

## Environment Variables

- `BASE_PATH` **required** — packages/docs/astro.config.mjs
- `BASE_URL` **required** — packages/docs/src/data/docs-search.ts
- `HOME` **required** — packages/cli/src/detect/probes.ts
- `LOG_LEVEL` **required** — packages/config/src/logger.ts
- `PWD` **required** — packages/adapters/opencode/src/adapter.ts
- `SITE_URL` **required** — packages/docs/astro.config.mjs
- `WEAVE_LOG_FILE` **required** — packages/engine/src/env.ts

## Config Files

- `tsconfig.json`

---

# Middleware

## custom
- migrate-conversion.test — `packages/cli/src/commands/__tests__/migrate-conversion.test.ts`
- migrate.test — `packages/cli/src/commands/__tests__/migrate.test.ts`

## validation
- migrate — `packages/cli/src/commands/migrate.ts`

## auth
- authorization.test — `packages/engine/src/__tests__/execution-lifecycle/authorization.test.ts`
- authorization — `packages/engine/src/execution-lifecycle/authorization.ts`

---

# Dependency Graph

## Most Imported Files (change these carefully)

- `packages/cli/src/theme/colors.ts` — imported by **17** files
- `packages/engine/src/runtime/types.ts` — imported by **16** files
- `packages/cli/src/io/terminal.ts` — imported by **15** files
- `packages/engine/src/runtime/store.ts` — imported by **13** files
- `packages/cli/src/fs/file-system.ts` — imported by **12** files
- `packages/engine/src/logger.ts` — imported by **12** files
- `packages/cli/src/args.ts` — imported by **11** files
- `packages/engine/src/runtime/errors.ts` — imported by **11** files
- `packages/engine/src/execution-lifecycle/metadata.ts` — imported by **11** files
- `packages/engine/src/execution-lifecycle/lease.ts` — imported by **10** files
- `packages/engine/src/execution-lifecycle/errors.ts` — imported by **10** files
- `packages/adapters/opencode/src/sdk-types.ts` — imported by **9** files
- `packages/adapters/opencode/src/adapter.ts` — imported by **8** files
- `packages/core/src/tokens.ts` — imported by **8** files
- `packages/cli/src/errors.ts` — imported by **7** files
- `packages/engine/src/execution-lifecycle.ts` — imported by **7** files
- `packages/cli/src/prompt/index.ts` — imported by **6** files
- `packages/core/src/errors.ts` — imported by **6** files
- `packages/engine/src/tool-policy.ts` — imported by **6** files
- `packages/engine/src/__tests__/execution-lifecycle/fixtures.ts` — imported by **6** files

## Import Map (who imports what)

- `packages/cli/src/theme/colors.ts` ← `packages/cli/src/__tests__/theme.test.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/migrate-conversion.test.ts`, `packages/cli/src/commands/__tests__/migrate.test.ts` +12 more
- `packages/engine/src/runtime/types.ts` ← `packages/engine/src/__tests__/runtime-command-operations.test.ts`, `packages/engine/src/__tests__/status-control.test.ts`, `packages/engine/src/__tests__/status-control.test.ts`, `packages/engine/src/__tests__/status-control.test.ts`, `packages/engine/src/__tests__/status-control.test.ts` +11 more
- `packages/cli/src/io/terminal.ts` ← `packages/cli/src/__tests__/routing.test.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/migrate-conversion.test.ts`, `packages/cli/src/commands/__tests__/migrate.test.ts` +10 more
- `packages/engine/src/runtime/store.ts` ← `packages/engine/src/__tests__/runtime-journal.test.ts`, `packages/engine/src/execution-lifecycle/artifacts.ts`, `packages/engine/src/execution-lifecycle/dispatch.ts`, `packages/engine/src/execution-lifecycle/inspection.ts`, `packages/engine/src/execution-lifecycle/interrupts.ts` +8 more
- `packages/cli/src/fs/file-system.ts` ← `packages/cli/src/__tests__/file-system.test.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/migrate-conversion.test.ts`, `packages/cli/src/commands/__tests__/migrate.test.ts`, `packages/cli/src/commands/__tests__/validate.test.ts` +7 more
- `packages/engine/src/logger.ts` ← `packages/engine/src/compose.ts`, `packages/engine/src/index.ts`, `packages/engine/src/runtime/journal-writer.ts`, `packages/engine/src/runtime/sqlite/store.ts`, `packages/engine/src/runtime-command-operations/control.ts` +7 more
- `packages/cli/src/args.ts` ← `packages/cli/src/__tests__/args.test.ts`, `packages/cli/src/cli.ts`, `packages/cli/src/commands/__tests__/init.test.ts`, `packages/cli/src/commands/__tests__/prompt.test.ts`, `packages/cli/src/commands/__tests__/runtime.test.ts` +6 more
- `packages/engine/src/runtime/errors.ts` ← `packages/engine/src/__tests__/runtime-contract.test.ts`, `packages/engine/src/__tests__/runtime-journal.test.ts`, `packages/engine/src/__tests__/runtime-journal.test.ts`, `packages/engine/src/execution-lifecycle/lease.ts`, `packages/engine/src/runtime/fingerprint.ts` +6 more
- `packages/engine/src/execution-lifecycle/metadata.ts` ← `packages/engine/src/execution-lifecycle/before-tool.ts`, `packages/engine/src/execution-lifecycle/completion.ts`, `packages/engine/src/execution-lifecycle/dispatch.ts`, `packages/engine/src/execution-lifecycle/index.ts`, `packages/engine/src/execution-lifecycle/inspection.ts` +6 more
- `packages/engine/src/execution-lifecycle/lease.ts` ← `packages/engine/src/execution-lifecycle/artifacts.ts`, `packages/engine/src/execution-lifecycle/completion.ts`, `packages/engine/src/execution-lifecycle/dispatch.ts`, `packages/engine/src/execution-lifecycle/inspection.ts`, `packages/engine/src/execution-lifecycle/interrupts.ts` +5 more

---

# Test Coverage

> **0%** of routes and models are covered by tests
> 76 test files found

---

_Generated by [codesight](https://github.com/Houseofmvps/codesight) — see your codebase clearly_