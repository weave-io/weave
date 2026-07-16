# @weaveio/weave — AI Context Map

> **Stack:** raw-http | none | unknown | typescript
> **Monorepo:** @weaveio/weave-core, @weaveio/weave-engine, @weaveio/weave-config, @weaveio/weave-cli, @weaveio/weave-docs, @weaveio/weave-adapter-claude-code, @weaveio/weave-adapter-opencode

> 0 routes | 0 models | 0 components | 133 lib files | 8 env vars | 5 middleware | 0% test coverage
> **Token savings:** this file is ~12.300 tokens. Without it, AI exploration would cost ~46.000 tokens. **Saves ~33.800 tokens per conversation.**
> **Last scanned:** 2026-07-16 10:30 — re-run after significant changes

---

# Libraries

- `packages\adapters\claude-code\src\adapter.ts` — class ClaudeCodeAdapter, interface ClaudeCodeAdapterOptions
- `packages\adapters\claude-code\src\agent-translation.ts` — function translateAgentToMarkdown: (input) => string, interface AgentTranslationInput
- `packages\adapters\claude-code\src\bootstrap.ts` — function getBootstrapDir: () => string, const BOOTSTRAP_FILES
- `packages\adapters\claude-code\src\model-resolution.ts` — function buildClaudeCodeModelInput: (descriptor) => ModelResolutionInput, const CLAUDE_CODE_AVAILABLE_MODELS: Set<string>
- `packages\adapters\claude-code\src\skill-discovery.ts` — function discoverClaudeCodeSkills: (projectRoot, homeDir, readDir) => void
- `packages\adapters\claude-code\src\tool-classification.ts`
  - function getClaudeCodeToolClassifications: () => readonly ConcreteToolClassification[]
  - const CLAUDE_CODE_TOOL_CLASSIFICATIONS: readonly ConcreteToolClassification[]
  - const CLAUDE_CODE_TOOL_IDS: readonly string[]
- `packages\adapters\opencode\src\adapter.ts`
  - class OpenCodeAdapterError
  - class OpenCodeAdapter
  - interface OpenCodeAdapterOptions
- `packages\adapters\opencode\src\direct-review.ts`
  - function executeDirectReview: (agentName, config, client, reviewPrompt) => ResultAsync<DirectReviewResult, DirectReviewError>
  - interface DirectReviewResult
  - type DirectReviewError
- `packages\adapters\opencode\src\execute-review-variants.ts` — function executeReviewVariants: (variants, client, reviewPrompt) => ResultAsync<ReviewExecutionResult[], ReviewFanOutAdapterError>
- `packages\adapters\opencode\src\model-resolution.ts`
  - function resolveModelForAgent: (descriptor, context) => Result<string, ModelResolutionError>
  - interface OpenCodeModelContext
  - type ModelResolutionError
- `packages\adapters\opencode\src\opencode-client.ts`
  - class SdkOpenCodeClient
  - interface OpenCodeClientFacade
  - type PromptSessionInfo
  - type OpenCodeClientError
- `packages\adapters\opencode\src\plugin.ts`
  - function createWeavePlugin: (options) => Plugin
  - interface WeavePluginOptions
  - const WeavePlugin: Plugin
  - const server
- `packages\adapters\opencode\src\projection-helpers.ts`
  - function translateReviewOutcome: (collateResult, ReviewOrchestrationError>) => Result<void, WorkflowRunnerError>
  - function formatReviewSummary: (collated) => string
  - function buildProjectEffect: (adapter, config?) => (
  - function deriveRunWorkflowResult: (data) => RunWorkflowResult
- `packages\adapters\opencode\src\reconcile-agent.ts`
  - function classifyExistingAgent: (agentName, existingAgents) => ReconcileDecision
  - function tagWithOwnership: (config) => OpenCodeAgentConfig
  - function reconcileAgent: (agentName, config, client) => ResultAsync<void, ReconcileAgentError>
  - type ReconcileAgentError
  - type ReconcileDecision
  - const WEAVE_OWNERSHIP_TAG
- `packages\adapters\opencode\src\run-workflow.ts`
  - function runWorkflow: (input) => ResultAsync<RunWorkflowResult, RunWorkflowError>
  - interface RunWorkflowInput
  - interface RunWorkflowResult
  - type RunWorkflowError
- `packages\adapters\opencode\src\runtime-command-projection.ts`
  - function buildOpenCodeHealthReport: (overrides?) => AdapterHealthReport
  - class RuntimeCommandProjection
  - interface ProjectionSuccess
  - interface ProjectionFailure
  - interface ProjectionDegraded
  - interface StartPlanProjectionInput
  - _...7 more_
- `packages\adapters\opencode\src\skill-discovery.ts`
  - function buildSkillInfoList: (names) => SkillInfo[]
  - function validateDeclaredSkills: (declaredSkills, availableSkills, disabledSkills) => Result<void, MissingSkillsError>
  - interface MissingSkillsError
- `packages\adapters\opencode\src\start-plan-execution.ts`
  - function startPlanExecution: (input) => ResultAsync<RunWorkflowResult, StartPlanExecutionError>
  - interface StartPlanExecutionInput
  - type StartPlanExecutionError
  - const WEAVE_START_COMMAND
  - const WEAVE_START_LEGACY_COMMAND
  - const DEFAULT_EXECUTION_WORKFLOW
- `packages\adapters\opencode\src\tool-policy-mapping.ts`
  - function toOpenCodePermission: (permission) => OpenCodePermissionValue
  - function buildReadToolsEntry: (readPermission) => Record<string, boolean> | undefined
  - function mapToolPolicy: (policy) => void
  - type OpenCodePermissionValue
  - type OpenCodeToolPermissions
  - const READ_TOOL_NAMES: readonly string[]
- `packages\adapters\opencode\src\translate-agent.ts` — function translateAgent: (descriptor, resolvedModel?) => Result<OpenCodeAgentConfig, TranslateAgentError>, type TranslateAgentError
- `packages\cli\src\args.ts`
  - function parseArgs: (argv) => Result<ParsedArgs, ArgParseError>
  - interface ParsedArgs
  - type Command
  - type ArgParseError
- `packages\cli\src\cli.ts` — function run: (deps?) => Promise<Result<number, CliError>>, interface CliDeps
- `packages\cli\src\commands\compose.ts` — function runCompose: (ctx) => Promise<Result<number, CliError>>, interface ComposeContext
- `packages\cli\src\commands\eval.ts`
  - function readPublishMode: (env, string | undefined>) => BundleWriteMode
  - function buildLangChainScorer: (evalEnv, langchainModuleLoader?) => void
  - function runEval: (ctx) => Promise<Result<number, CliError>>
  - interface EvalContext
  - interface LangChainOpenAIModule
  - const WEAVE_EVAL_PUBLISH_MODE_ENV_VAR
- `packages\cli\src\commands\init.ts`
  - function runInit: (ctx) => Promise<Result<number, CliError>>
  - function installHarnesses: (input) => Promise<number>
  - interface InitContext
- `packages\cli\src\commands\migrate.ts`
  - function renderMigrateSuccess: (theme, plan, result) => string
  - function resolveSelectedHarnesses: (flags, harnesses) => SupportedHarnessId[]
  - function runMigrateMode: (ctx, installHarnesses, harnesses) => void
  - interface MigrateContext
  - type InitScope
  - type InitPlan
- `packages\cli\src\commands\prompt.ts` — function runPrompt: (ctx) => Promise<Result<number, CliError>>, interface PromptContext
- `packages\cli\src\commands\runtime.ts` — function runRuntime: (ctx) => Promise<Result<number, CliError>>, interface RuntimeCommandContext
- `packages\cli\src\commands\validate.ts` — function runValidate: (ctx) => Promise<Result<number, CliError>>, interface ValidateContext
- `packages\cli\src\config\starter-config.ts` — function starterConfig: (scope) => string
- `packages\cli\src\detect\index.ts`
  - function isHarnessId: (value) => value is SupportedHarnessId
  - function detectHarnesses: (probes) => void
  - function formatDetectionSummary: (harnesses) => string[]
  - type SupportedHarnessId
  - type DetectedHarness
  - type DetectionError
  - _...1 more_
- `packages\cli\src\detect\probes.ts`
  - class BunDetectionProbes
  - class MemoryDetectionProbes
  - interface DetectionProbes
  - type ProbeError
- `packages\cli\src\errors.ts`
  - function formatCliError: (error) => string
  - type CliError
  - type InvalidArgsError
  - type MissingFileError
  - type FileReadError
  - type ParseFailureError
  - _...5 more_
- `packages\cli\src\evals\artifact-bundle.ts`
  - function computeRunIdPrefix: (gitSha, assembledAt) => string
  - function computeRunId: (prefix, sequence) => string
  - function computeBundleDirName: (gitSha, assembledAt) => string
  - function resolveNextSequence: (runsDir, prefix, remoteRunIds) => Promise<number>
  - function assembleScoreFile: (runnerResult, gitSha, assembledAt, dryRun) => BundleScoreFile
  - function aggregateScoreFile: (suiteName, results, gitSha, assembledAt, dryRun) => BundleScoreFile
  - _...11 more_
- `packages\cli\src\evals\case-loader.ts`
  - function loadCaseFile: (filePath) => ResultAsync<EvalCase, FixtureSchemaError>
  - function loadRubricFile: (filePath) => ResultAsync<EvalRubric, FixtureSchemaError>
  - function loadSuiteCases: (suite, evalsRoot) => ResultAsync<EvalCase[], FixtureSchemaError>
  - function loadSuiteRubrics: (suite, evalsRoot) => ResultAsync<EvalRubric[], FixtureSchemaError>
  - function validateCaseFilter: (caseId, cases) => FixtureSchemaError | EvalCase
  - const EVALS_ROOT
  - _...1 more_
- `packages\cli\src\evals\dashboard-indexes.ts`
  - function buildLatestSnapshot: (run, updatedAt) => LatestRunSnapshot
  - function buildLastNRuns: (runs, maxRuns, updatedAt) => LastNRunsIndex
  - function buildScenarioHistories: (runsOldestFirst, updatedAt) => Map<string, ScenarioHistoryIndex>
  - function generateDashboardIndexes: (runs, updatedAt, lastN) => Result<GeneratedIndexes, DashboardIndexError>
  - function validateDashboardManifestCompatibility: (raw) => Result<DashboardManifest, DashboardIndexError>
  - function validateSuiteHistoryCompatibility: (raw, suiteName) => Result<SuiteHistoryManifest, DashboardIndexError>
  - _...19 more_
- `packages\cli\src\evals\env.ts`
  - function readEvalEnv: (env, string | undefined>, {...}) => Result<EvalEnv, EvalEnvError>
  - interface EvalEnv
  - type EvalEnvError
  - const DEFAULT_OPENROUTER_BASE_URL
  - const OPENROUTER_API_KEY_ENV_VAR
  - const OPENROUTER_BASE_URL_ENV_VAR
- `packages\cli\src\evals\github-contents-publisher.ts`
  - function isIndexArtifactAllowed: (fileName) => boolean
  - class GitHubContentsPublisher
  - type FetchImpl
  - type FileReader
  - const TARGET_REPO
  - const TARGET_BRANCH
  - _...9 more_
- `packages\cli\src\evals\input-validation.ts`
  - function parseEvalRunRequest: (inputs) => Result<EvalRunRequest, EvalInputValidationError>
  - type EvalRunRequest
  - type EvalRunInputs
  - type EvalInputValidationError
  - const KNOWN_EVAL_AGENTS
  - const KNOWN_EVAL_AGENTS_SORTED: readonly string[]
- `packages\cli\src\evals\langchain-agent-evals.ts`
  - function buildRationaleProjection: (run) => string
  - function buildCaseExplanation: (scoreBucket, _passed, required, outcomeKind, applicableDimensions, dryRun) => string
  - function buildPublicExplanation: (scoreRecord, "weightedTotal" | "passed" | "required" | "dimensions"
  >, evalCase, "expected_outcome">, dryRun) => CaseResultSummary["publicExplanation"]
  - function buildSuiteExplanation: (passedCases, totalCases, suiteGreen, dryRun) => string
  - function buildModelExplanation: (overallBucket, passedCases, totalCases, dryRun) => string
  - class RealLangChainJudge
  - _...10 more_
- `packages\cli\src\evals\loom-routing-runner.ts`
  - function analyzeLoomRouting: (content) => LoomRoutingAnalysis
  - function buildRoutingRunnerDiagnostics: (evalCase, analysis) => NonNullable<RawCaseResultArtifact["runnerDiagnostics"]> | undefined
  - function extractRoutedAgents: (content) => string[]
  - function redactSecrets: (raw) => string
  - class LoomRoutingRunner
  - interface LoomRoutingAnalysis
  - _...3 more_
- `packages\cli\src\evals\model-matrix.ts`
  - function loadModelMatrix: (matrixPath) => ResultAsync<ModelMatrix, FixtureSchemaError>
  - function resolveDefaultModels: (matrix) => ModelMatrixEntry[]
  - function filterMatrix: (matrix, filterId) => ModelMatrixEntry[]
  - function validateModelInMatrix: (matrix, modelId) => Result<ModelMatrixEntry, FixtureSchemaError>
  - const MATRIX_PATH
  - const MIN_DEFAULT_MODELS
- `packages\cli\src\evals\openrouter-client.ts`
  - class OpenRouterClient
  - class StubModelClient
  - interface ChatMessage
  - interface ModelRequest
  - interface ModelResponse
  - interface ModelClient
  - _...1 more_
- `packages\cli\src\evals\pattern-planning-runner.ts`
  - function extractPlanningSignals: (content) => void
  - function buildPlanningRunnerDiagnostics: (evalCase, signals) => NonNullable<RawCaseResultArtifact["runnerDiagnostics"]>
  - function buildModelRunOutput: (evalCase, modelId, userMessage, content) => ModelRunOutput
  - function redactSecrets: (raw) => string
  - function buildUserMessage: (evalCase) => string
  - class PatternPlanningRunner
  - _...3 more_
- `packages\cli\src\evals\prompt-snapshots.ts`
  - function composeSnapshot: (input) => ResultAsync<ComposeSnapshotResult, ProvenanceError>
  - function composeAgentSnapshots: (options) => ResultAsync<ComposeAgentSnapshotsResult, ProvenanceError>
  - interface ComposeSnapshotInput
  - interface ComposeSnapshotResult
  - interface ComposeAgentSnapshotsOptions
  - interface ComposeAgentSnapshotsResult
  - _...1 more_
- `packages\cli\src\evals\provenance.ts`
  - function deriveSummary: (snapshot) => string
  - function deriveProvenanceRecord: (snapshot, gitSha, capturedAt) => void
  - function buildManifest: (records, gitSha, producedAt) => void
  - function writeManifest: (manifest, outputPath) => ResultAsync<void, ProvenanceError>
  - function deriveProvenanceManifest: (snapshots, options) => Result<PromptProvenanceManifest, ProvenanceError>
  - function deriveAndWriteManifest: (snapshots, options) => ResultAsync<PromptProvenanceManifest, ProvenanceError>
  - _...4 more_
- `packages\cli\src\evals\raw-artifacts.ts`
  - function sanitizeFilenamePart: (raw) => string
  - function rawCaseResultFilename: (caseId, modelId, date) => string
  - function rawPromptFilename: (agentName, date) => string
  - function isoToFilesafeDatetime: (iso) => string
  - class RawArtifactsWriter
  - class MemoryFileWriter
  - _...3 more_
- `packages\cli\src\evals\report-bundle.ts`
  - function assembleCaseEntry: (row, suite) => PublicCaseEntry
  - function assembleSuiteSummary: (scoreFile, gitSha, assembledAt) => Result<SuiteSummaryEntry, ReportAssemblyError>
  - function assemblePublicReportBundle: (bundle, runId) => Result<PublicReportBundle, ReportAssemblyError>
  - function assembleDashboardManifest: (existingEntries, newEntry, updatedAt) => Result<DashboardManifest, ReportAssemblyError>
  - function buildDashboardEntry: (bundle, runId, bundleReportPath) => DashboardEntry
  - function assembleModelComparisonManifest: (bundle, runId) => Result<ModelComparisonManifest, ReportAssemblyError>
  - _...2 more_
- `packages\cli\src\evals\report-markdown.ts`
  - function isMarkdownSafe: (text) => boolean
  - function sanitizeMdValue: (text) => string
  - function renderCaseRow: (entry) => string
  - function renderSuiteSummary: (summary) => string
  - function renderPublicReportBundle: (bundle) => string
- `packages\cli\src\evals\report-schema.ts`
  - function computeScoreBucket: (weightedTotal, dryRun) => ScoreBucket
  - type ExplanationSource
  - type ScoreBucket
  - type BoundedExplanation
  - type PublicCaseEntry
  - type SuiteSummaryEntry
  - _...36 more_
- `packages\cli\src\evals\results-repo.ts`
  - function validatePublishToken: (env, string | undefined>) => ResultAsync<string, ResultsRepoError>
  - function validateRepoConfig: (config) => ResultAsync<undefined, ResultsRepoError>
  - function enforcePublishPolicy: (bundle) => ResultAsync<undefined, ResultsRepoError>
  - class NoOpResultsRepoPublisher
  - class StubResultsRepoPublisher
  - interface PublishBundleRequest
  - _...2 more_
- `packages\cli\src\evals\runner.ts`
  - function buildEvalRunner: (orchestrator) => (request: EvalRunRequest) => Promise<Result<number, CliError>>
  - function getEvalCoveredPromptAgents: () => readonly string[]
  - class EvalOrchestrator
  - interface EvalRunMetadata
  - interface ModelRollup
  - interface RepeatabilityComparisonKey
  - _...16 more_
- `packages\cli\src\evals\sanitizer.ts`
  - function sanitizeCaseResultSummary: (summary) => SanitizedCaseResultSummary
  - function sanitizeScoreRecord: (record) => SanitizedScoreRecord
  - function sanitizeProvenanceRecord: (record) => SanitizedProvenanceRecord
  - function sanitizeProvenanceManifest: (manifest) => void
  - function dropUnknownFields: (input, allowedKeys) => Partial<T>
  - function assertPublishSafe: (obj, unknown>, context) => Result<undefined, SanitizerError>
  - _...11 more_
- `packages\cli\src\evals\shuttle-execution-runner.ts`
  - function extractShuttleExecutionSignals: (content) => ShuttleExecutionSignals
  - function redactSecrets: (raw) => string
  - function buildUserMessage: (evalCase) => string
  - class ShuttleExecutionRunner
  - interface ShuttleExecutionSignals
  - interface ShuttleExecutionRunnerOptions
  - _...2 more_
- `packages\cli\src\evals\spindle-tools-runner.ts`
  - function extractSpindleResearchSignals: (content) => SpindleResearchSignals
  - function redactSecrets: (raw) => string
  - function buildUserMessage: (evalCase) => string
  - class SpindleToolsRunner
  - interface SpindleResearchSignals
  - interface SpindleToolsRunnerOptions
  - _...2 more_
- `packages\cli\src\evals\tapestry-category-routing-runner.ts`
  - function extractCategoryShuttles: (content) => string[]
  - function detectGenericShuttleFallback: (content) => boolean
  - function analyzeCategoryRouting: (content, expectedTarget, acceptedAlternates) => CategoryRoutingAnalysis
  - function scoreRoutingCorrectness: (analysis) => DimensionScore
  - function scoreDelegationCorrectness: (content, analysis) => DimensionScore
  - function scoreExecutionCompleteness: (content, analysis) => DimensionScore
  - _...10 more_
- `packages\cli\src\evals\tapestry-execution-runner.ts`
  - function extractDelegationChain: (content) => string[]
  - function detectCompletionSignal: (content) => boolean
  - function extractProducedArtifacts: (content, expectedArtifacts) => string[]
  - function buildUserMessage: (evalCase) => string
  - class TapestryExecutionRunner
  - interface TapestryExecutionRunnerOptions
  - _...2 more_
- `packages\cli\src\evals\types.ts`
  - function getEvalSuiteMetadata: (suiteId) => EvalSuiteMetadata | undefined
  - function isKnownEvalSuiteId: (suiteId) => boolean
  - interface EvalSuiteMetadata
  - interface PromptSourceDescriptor
  - interface PromptSnapshot
  - interface RawPromptArtifact
  - _...51 more_
- `packages\cli\src\evals\warp-security-runner.ts`
  - function extractSecuritySignals: (content) => SecuritySignals
  - function redactSecrets: (raw) => string
  - function buildUserMessage: (evalCase) => string
  - class WarpSecurityRunner
  - interface SecuritySignals
  - interface WarpSecurityRunnerOptions
  - _...2 more_
- `packages\cli\src\evals\weft-review-runner.ts`
  - function extractReviewSignals: (content) => ReviewSignals
  - function redactSecrets: (raw) => string
  - function buildUserMessage: (evalCase) => string
  - class WeftReviewRunner
  - interface ReviewSignals
  - interface WeftReviewRunnerOptions
  - _...2 more_
- `packages\cli\src\fs\file-system.ts`
  - function describeFileSystemError: (error) => string
  - class BunFileSystem
  - class MemoryFileSystem
  - interface FileSystem
  - type FileSystemError
- `packages\cli\src\installers\index.ts`
  - function installerRegistry: (fs) => Record<SupportedHarnessId, HarnessInstaller>
  - function installAllSupported: (input, string[]>;
}) => ResultAsync<InstallResult[], InstallError>
  - interface HarnessInstaller
  - type AdapterModule
  - type InstallRequest
  - type InstallResult
  - _...1 more_
- `packages\cli\src\installers\opencode.ts` — class OpenCodeInstaller
- `packages\cli\src\io\terminal.ts`
  - class RealTerminal
  - class BufferTerminal
  - interface TerminalIO
- `packages\cli\src\migration\conversion-warnings.ts` — function renderConversionWarnings: (warnings) => string
- `packages\cli\src\migration\legacy-jsonc-converter.ts` — function stripJsoncComments: (source) => string, function convertLegacyJsonc: (source) => ConversionResult
- `packages\cli\src\migration\migration-plan.ts`
  - function buildMigrationPlan: (scope, fs, skippedWarningCount) => MigrationPlan
  - function detectLegacySource: (scope, fs) => ResultAsync<string | undefined,
  - const LEGACY_SOURCE_RELATIVE: Record<MigrationScope, string>
  - const CANONICAL_WEAVE_DIR: Record<MigrationScope, string>
- `packages\cli\src\migration\migration-write.ts`
  - function buildMigratedContent: (plan, conversion) => string
  - function writeMigratedDsl: (fs, plan, dslContent, destExists) => ResultAsync<
  - function performMigrationWrite: (fs, plan, sourceContent, destExists, preConversion?) => ResultAsync<
- `packages\cli\src\prompt\index.ts`
  - class ClackPromptAdapter
  - class StaticPromptAdapter
  - interface PromptAdapter
  - type PromptError
  - type PromptOption
- `packages\cli\src\prompts\self-modify.ts`
  - function resolveSelfModifyPaths: (ctx) => SelfModifyPaths
  - function renderSelfModifyPrompt: (ctx) => string
  - interface SelfModifyContext
  - interface SelfModifyPaths
  - type SelfModifyScope
- `packages\cli\src\theme\ascii-logo.ts`
  - function renderLogo: (theme) => string[]
  - const PLAIN_LOGO_LINES: string[]
  - const LOGO_WIDTH
- `packages\cli\src\theme\colors.ts`
  - class ThemeManager
  - interface ThemeColors
  - interface ThemeManagerDeps
  - const defaultThemeManager
- `packages\cli\src\theme\render.ts`
  - class ThemeRenderer
  - interface VersionSource
  - const defaultThemeRenderer
- `packages\config\src\builtins.ts`
  - function getBuiltinConfig: () => Result<WeaveConfig, ConfigError[]>
  - const BUILTIN_PROMPT_CONTENTS: Readonly<Record<string, string>>
  - const BUILTIN_WEAVE_SOURCE
- `packages\config\src\discovery.ts`
  - function discoverAndParse: (projectRoot?, fileReader) => ResultAsync<DiscoveredConfig[], ConfigLoadError[]>
  - interface FileReader
  - type DiscoveredConfig
  - const bunFileReader: FileReader
- `packages\config\src\loader.ts` — function loadConfig: (projectRoot?, fileReader) => ResultAsync<import("@weaveio/weave-core").WeaveConfig, ConfigLoadError[]>
- `packages\config\src\merge.ts`
  - function mergeWorkflow: (workflowName, base, override, workflowMap, WorkflowConfig>) => Result<WorkflowConfig, WorkflowExtensionError>
  - function mergeConfigsResult: (...configs) => Result<WeaveConfig, MergeError[]>
  - function mergeConfigs: (...configs) => WeaveConfig
  - type WorkflowExtensionError
  - type MergeError
- `packages\config\src\normalize-path.ts` — function normalizePath: (p) => string
- `packages\config\src\plan-state-provider.ts` — class BunFilesystemPlanStateProvider
- `packages\config\src\resolve.ts` — function resolvePromptPaths: (config, scope) => WeaveConfig
- `packages\core\src\errors.ts`
  - function formatError: (error) => string
  - type LexError
  - type ParseError
  - type ValidationError
  - type ConfigError
- `packages\core\src\lexer.ts` — function tokenize: (source) => Result<Token[], LexError[]>
- `packages\core\src\parse-config.ts` — function parseConfig: (source) => Result<WeaveConfig, ConfigError[]>
- `packages\core\src\parser.ts` — function parse: (tokens) => Result<AstNode[], ParseError[]>
- `packages\core\src\prompt-schema-helpers.ts`
  - function refinePromptAppendExclusive: () => [
  - function refinePromptExclusive: () => [
  - function refinePromptFileSafe: (field) => [(data: HasPromptFile) => boolean,
- `packages\core\src\validate.ts` — function validate: (ast) => Result<WeaveConfig, ValidationError[]>
- `packages\docs\src\utils\base-url.ts` — function normalizeBaseUrl: (base) => string, function withBaseUrl: (base, path) => string
- `packages\engine\src\capability-contract.ts`
  - function evaluateCoreReadinessProfile: (contract) => ProfileEvaluationResult
  - function buildAdapterHealthReport: (input) => AdapterHealthReport
  - function buildHumanRows: (report) => HumanReadinessRow[]
  - function buildToonRows: (report) => ToonReadinessRow[]
  - function toJson: (report) => string
  - interface CapabilityEntry
  - _...18 more_
- `packages\engine\src\compose.ts`
  - function detectAppendCollisions: (configs) => AppendCollision[]
  - function composeWorkflowStepPrompt: (stepName, step, workflow, templateContext) => ResultAsync<WorkflowStepComposedPrompt, ComposeError>
  - function composeAgentDescriptor: (agentName, agentConfig, config, allAgents, AgentConfig>, category?) => ResultAsync<AgentDescriptor, ComposeError>
  - interface CategoryMetadata
  - interface AgentDescriptor
  - interface AgentDescriptorCategory
  - _...6 more_
- `packages\engine\src\descriptors.ts`
  - function generateCategoryShuttles: (config) => Result<
  - interface GeneratedCategoryShuttle
  - type CategoryShuttleConflictError
- `packages\engine\src\env.ts`
  - function parseEnv: (raw, string | undefined>) => Result<Env, EnvValidationError>
  - type Env
  - type EnvValidationError
  - const envSchema
  - const env: Env
- `packages\engine\src\execution-lifecycle\artifacts.ts`
  - function latestArtifactByName: (instance, name) => ArtifactRef | undefined
  - function latestAttemptForStep: (instance, stepName) => StepAttemptRecord | undefined
  - function isApprovalInvalidated: (instance, artifactName) => boolean
  - function verifyArtifactIntegrity: (artifact, suppliedDigest) => Result<undefined, LifecycleError>
  - function inputRole: (input) => "normative" | "informational"
  - function validateStepInputs: (step, instance, artifactDigests?, string>>, pinnedNames?) => Result<ArtifactInputSummary, LifecycleError>
  - _...3 more_
- `packages\engine\src\execution-lifecycle\authorization.ts` — function validateAuthorizationSource: (source, operation) => Result<undefined, LifecyclePolicyDecisionError>, function validateReconciliationSource: (reason, source) => Result<undefined, LifecyclePolicyDecisionError>
- `packages\engine\src\execution-lifecycle\before-tool.ts` — function beforeTool: (input) => BeforeToolResult
- `packages\engine\src\execution-lifecycle\completion.ts` — function completeStep: (input, store) => ResultAsync<CompleteStepOutput, LifecycleError>
- `packages\engine\src\execution-lifecycle\dispatch.ts`
  - function buildConfiguredRunAgentEffect: (step, promptMetadata, agentConfig?) => RunAgentEffect
  - function resolveWorkflowStep: (workflowConfig, stepName) => Result<WorkflowStep, LifecycleError>
  - function dispatchStep: (input, store) => ResultAsync<DispatchStepOutput, LifecycleError>
- `packages\engine\src\execution-lifecycle\errors.ts`
  - function lifecycleValidationError: (message, field?) => LifecycleValidationError
  - function lifecycleNotFoundError: (entity, id, message?) => LifecycleNotFoundError
  - function lifecycleLeaseConflictError: (workflowInstanceId, conflictingLeaseId, message) => LifecycleLeaseConflictError
  - function lifecyclePersistenceError: (message, cause?) => LifecyclePersistenceError
  - function lifecyclePolicyDecisionError: (message, rule?) => LifecyclePolicyDecisionError
- `packages\engine\src\execution-lifecycle\inspection.ts` — function inspectExecution: (input, store) => InspectExecutionResult
- `packages\engine\src\execution-lifecycle\interrupts.ts` — function handleUserInterrupt: (input, store) => ResultAsync<HandleUserInterruptOutput, LifecycleError>
- `packages\engine\src\execution-lifecycle\lease.ts`
  - function mapStoreError: (storeError) => LifecyclePersistenceError
  - function mapConflictToLeaseConflict: (workflowInstanceId, storeError) => LifecycleLeaseConflictError
  - function validateActiveLease: (activeLease, workflowInstanceId, leaseId) => Result<ExecutionLease, LifecycleError>
- `packages\engine\src\execution-lifecycle\metadata.ts` — function sanitizeMetadata: (metadata) => Result<SafeMetadata, LifecycleValidationError>
- `packages\engine\src\execution-lifecycle\prompt-context.ts`
  - function buildStepPromptContext: (instance, step) => TemplateContext
  - function renderStepPrompt: (promptTemplate, context, artifactNames) => Result<
  - function renderPlanName: (planNameTemplate, instance) => Result<string, LifecycleError>
- `packages\engine\src\execution-lifecycle\reconciliation.ts` — function reconcileExecution: (input, store) => ReconcileExecutionResult
- `packages\engine\src\execution-lifecycle\resume.ts` — function resumeExecution: (input, store) => ResultAsync<ResumeExecutionOutput, LifecycleError>
- `packages\engine\src\execution-lifecycle\session.ts` — function observeSession: (input, store) => ResultAsync<ObserveSessionOutput, LifecycleError>
- `packages\engine\src\execution-lifecycle\start.ts` — function startExecution: (input, store) => ResultAsync<StartExecutionOutput, LifecycleError>
- `packages\engine\src\execution-lifecycle\terminal-outcomes.ts` — function approveArtifact: (input, store) => ApproveArtifactResult
- `packages\engine\src\logger.ts`
  - function redirectLogsToFile: (filePath) => Promise<void>
  - const logDestination
  - const logger
- `packages\engine\src\materialization.ts`
  - function materializeAgents: (input) => ResultAsync<MaterializationPlan, never>
  - interface MaterializationInput
  - interface MaterializedAgent
  - interface MaterializationPlan
  - type MaterializationError
- `packages\engine\src\model-resolution.ts`
  - function resolveAdapterModelIntent: (input) => ModelResolutionResult
  - interface ModelResolutionInput
  - interface ModelResolutionResult
  - type ResolutionSource
  - const DEFAULT_FALLBACK_MODEL
- `packages\engine\src\review-gate-policy.ts`
  - function evaluateGateDecision: (verdicts) => GateDecision
  - interface VariantVerdictInput
  - interface GateDecision
- `packages\engine\src\review-orchestration.ts`
  - function fanOut: (agentName, config) => Result<ReviewFanOutPlan, ReviewOrchestrationError>
  - function collate: (results) => Result<CollatedReview, ReviewOrchestrationError>
  - class ReviewOrchestrator
  - interface DirectReviewContext
  - type ReviewOrchestrationAgentNotFoundError
  - type ReviewOrchestrationError
  - _...5 more_
- `packages\engine\src\review-variants.ts`
  - function reviewVariantName: (agentName, model) => string
  - function generateReviewVariants: (config) => Result<Record<string, GeneratedReviewVariant>, ReviewVariantConflictError>
  - interface GeneratedReviewVariant
  - type ReviewVariantConflictError
- `packages\engine\src\review-verdict-parser.ts` — function parseVerdict: (output) => ReviewVerdict, type ReviewVerdict
- `packages\engine\src\runtime\errors.ts`
  - function initializationError: (message, cause?) => RuntimeStoreInitializationError
  - function migrationVersionError: (foundVersion, supportedVersion, message) => RuntimeStoreMigrationVersionError
  - function serializationError: (message, cause?) => RuntimeStoreSerializationError
  - function queryError: (message, cause?) => RuntimeStoreQueryError
  - function notFoundError: (entity, id, message?) => RuntimeStoreNotFoundError
  - function conflictError: (entity, message, conflictingId?) => RuntimeStoreConflictError
  - _...11 more_
- `packages\engine\src\runtime\fingerprint.ts` — function createProjectSalt: () => string, function fingerprintContent: (salt, content) => ResultAsync<string, RuntimeStoreError>
- `packages\engine\src\runtime\journal-writer.ts` — class RuntimeJournalWriter, interface WriteJournalEntryInput
- `packages\engine\src\runtime\memory-store.ts`
  - function createInMemoryRuntimeStore: (options) => InMemoryRuntimeStore
  - class InMemoryRuntimeStore
  - interface InMemoryRuntimeStoreFailureConfig
  - interface InMemoryRuntimeStoreOptions
- `packages\engine\src\runtime\sanitizer.ts`
  - function isDeniedKey: (key) => boolean
  - function sanitizeJournalData: (data) => Result<JsonObject, RuntimeStoreError>
  - function sanitizeSnapshotMetadata: (metadata, string | number | boolean>) => Result<Record<string, string | number | boolean>, RuntimeStoreError>
- `packages\engine\src\runtime\sqlite\kysely-bun-sqlite.ts` — class BunSqliteDialect
- `packages\engine\src\runtime\sqlite\migrations.ts`
  - function runMigrations: (db) => Result<void, RuntimeStoreError>
  - function readSchemaVersion: (db) => number
  - const CURRENT_SCHEMA_VERSION
- `packages\engine\src\runtime\sqlite\store.ts`
  - function createSqliteRuntimeStore: (options) => SqliteRuntimeStore
  - class SqliteRuntimeStore
  - interface SqliteRuntimeStoreOptions
- `packages\engine\src\runtime\types.ts`
  - function createWorkflowInstanceId: (raw) => WorkflowInstanceId
  - function createExecutionLeaseId: (raw) => ExecutionLeaseId
  - function createSessionSnapshotId: (raw) => SessionSnapshotId
  - function createRuntimeJournalEntryId: (raw) => RuntimeJournalEntryId
  - function createOwnerId: (raw) => OwnerId
  - function createArtifactId: (raw) => ArtifactId
  - _...30 more_
- `packages\engine\src\runtime-command-operations\control.ts` — function abortExecution: (input) => import("neverthrow").ResultAsync<, function advanceStep: (input) => import("neverthrow").ResultAsync<StepAdvancedData, CommandOperationError>
- `packages\engine\src\runtime-command-operations\health.ts` — function runtimeHealth: (input) => RuntimeHealthResult
- `packages\engine\src\runtime-command-operations\run-named-workflow.ts` — function runNamedWorkflow: (input, projectEffect, renderedPrompt?) => void
- `packages\engine\src\runtime-command-operations\start-plan.ts` — function startPlan: (input, projectEffect, renderedPrompt?) => void
- `packages\engine\src\runtime-command-operations\status.ts` — function inspectStatus: (input) => import("neverthrow").ResultAsync<
- `packages\engine\src\runtime-command-operations\workflow-runner.ts`
  - function runWorkflowLifecycle: (input) => ResultAsync<WorkflowRunnerOutput, WorkflowRunnerError>
  - function mapWorkflowRunnerErrorToLifecycle: (error) => CommandLifecycleError
  - function mapRunnerErrorToCommandError: (error, operation) => CommandOperationError
  - interface WorkflowRunnerInput
  - interface WorkflowRunnerOutput
  - type WorkflowRunnerError
- `packages\engine\src\skill-resolution.ts`
  - function resolveSkillsForAgent: (input) => Result<ResolvedSkill[], SkillResolutionError[]>
  - function resolveSkillsForConfig: (input) => Result<ConfigSkillResolutionResult, SkillResolutionError[]>
  - interface SkillInfo
  - interface ResolvedSkill
  - interface SkillResolutionInput
  - interface SkillResolutionConfigInput
  - _...2 more_
- `packages\engine\src\template-context.ts`
  - function buildTemplateContext: (input) => Result<AgentPromptTemplateContext, TemplateContextError>
  - interface AgentContextEntry
  - interface CategoryContextEntry
  - interface ToolPolicyContextEntry
  - interface DelegationTargetContextEntry
  - interface DelegationContextEntry
  - _...5 more_
- `packages\engine\src\template-renderer.ts`
  - function renderTemplate: (source, context, options) => Result<string, RendererError>
  - function extractTemplatePaths: (source) => Result<string[], RendererError>
  - interface TemplateContext
  - interface RenderOptions
  - type RendererError
- `packages\engine\src\tool-policy.ts`
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

- `BASE_PATH` **required** — packages\docs\astro.config.mjs
- `BASE_URL` **required** — packages\docs\src\data\docs-search.ts
- `HOME` **required** — packages\cli\src\detect\probes.ts
- `LOG_LEVEL` **required** — packages\config\src\logger.ts
- `PWD` **required** — packages\adapters\opencode\src\adapter.ts
- `RUN_HARNESS_SMOKE` **required** — packages\adapters\opencode\src\__tests__\category-routing-smoke.test.ts
- `SITE_URL` **required** — packages\docs\astro.config.mjs
- `WEAVE_LOG_FILE` **required** — packages\engine\src\env.ts

## Config Files

- `tsconfig.json`

---

# Middleware

## validation
- migrate — `packages\cli\src\commands\migrate.ts`

## custom
- migrate-conversion.test — `packages\cli\src\commands\__tests__\migrate-conversion.test.ts`
- migrate.test — `packages\cli\src\commands\__tests__\migrate.test.ts`

## auth
- authorization — `packages\engine\src\execution-lifecycle\authorization.ts`
- authorization.test — `packages\engine\src\__tests__\execution-lifecycle\authorization.test.ts`

---

# Dependency Graph

## Most Imported Files (change these carefully)

- `packages\cli\src\evals\types.ts` — imported by **39** files
- `packages\cli\src\theme\colors.ts` — imported by **20** files
- `packages\cli\src\io\terminal.ts` — imported by **18** files
- `packages\cli\src\evals\openrouter-client.ts` — imported by **18** files
- `packages\cli\src\evals\report-schema.ts` — imported by **17** files
- `packages\adapters\opencode\src\sdk-types.ts` — imported by **16** files
- `packages\engine\src\runtime\types.ts` — imported by **16** files
- `packages\cli\src\args.ts` — imported by **14** files
- `packages\engine\src\runtime\store.ts` — imported by **13** files
- `packages\cli\src\fs\file-system.ts` — imported by **12** files
- `packages\engine\src\logger.ts` — imported by **12** files
- `packages\adapters\opencode\src\adapter.ts` — imported by **11** files
- `packages\engine\src\execution-lifecycle\metadata.ts` — imported by **11** files
- `packages\engine\src\runtime\errors.ts` — imported by **11** files
- `packages\cli\src\errors.ts` — imported by **10** files
- `packages\engine\src\execution-lifecycle\lease.ts` — imported by **10** files
- `packages\engine\src\execution-lifecycle\errors.ts` — imported by **10** files
- `packages\cli\src\evals\prompt-snapshots.ts` — imported by **9** files
- `packages\engine\src\compose.ts` — imported by **9** files
- `packages\core\src\tokens.ts` — imported by **8** files

## Import Map (who imports what)

- `packages\cli\src\evals\types.ts` ← `packages\cli\src\evals\github-contents-publisher.ts`, `packages\cli\src\evals\input-validation.ts`, `packages\cli\src\evals\loom-routing-runner.ts`, `packages\cli\src\evals\loom-routing-runner.ts`, `packages\cli\src\evals\loom-routing-runner.ts` +34 more
- `packages\cli\src\theme\colors.ts` ← `packages\cli\src\cli.ts`, `packages\cli\src\commands\compose.ts`, `packages\cli\src\commands\eval.ts`, `packages\cli\src\commands\init.ts`, `packages\cli\src\commands\migrate.ts` +15 more
- `packages\cli\src\io\terminal.ts` ← `packages\cli\src\cli.ts`, `packages\cli\src\commands\compose.ts`, `packages\cli\src\commands\eval.ts`, `packages\cli\src\commands\init.ts`, `packages\cli\src\commands\migrate.ts` +13 more
- `packages\cli\src\evals\openrouter-client.ts` ← `packages\cli\src\evals\loom-routing-runner.ts`, `packages\cli\src\evals\pattern-planning-runner.ts`, `packages\cli\src\evals\runner.ts`, `packages\cli\src\evals\shuttle-execution-runner.ts`, `packages\cli\src\evals\spindle-tools-runner.ts` +13 more
- `packages\cli\src\evals\report-schema.ts` ← `packages\cli\src\evals\__tests__\artifact-bundle.test.ts`, `packages\cli\src\evals\__tests__\artifact-bundle.test.ts`, `packages\cli\src\evals\__tests__\artifact-bundle.test.ts`, `packages\cli\src\evals\__tests__\artifact-bundle.test.ts`, `packages\cli\src\evals\__tests__\artifact-bundle.test.ts` +12 more
- `packages\adapters\opencode\src\sdk-types.ts` ← `packages\adapters\opencode\src\adapter.ts`, `packages\adapters\opencode\src\plugin.ts`, `packages\adapters\opencode\src\reconcile-agent.ts`, `packages\adapters\opencode\src\tool-policy-mapping.ts`, `packages\adapters\opencode\src\translate-agent.ts` +11 more
- `packages\engine\src\runtime\types.ts` ← `packages\engine\src\execution-lifecycle\resume.ts`, `packages\engine\src\execution-lifecycle\start.ts`, `packages\engine\src\execution-lifecycle\types.ts`, `packages\engine\src\runtime\journal-writer.ts`, `packages\engine\src\runtime\sanitizer.ts` +11 more
- `packages\cli\src\args.ts` ← `packages\cli\src\cli.ts`, `packages\cli\src\commands\compose.ts`, `packages\cli\src\commands\eval.ts`, `packages\cli\src\commands\init.ts`, `packages\cli\src\commands\migrate.ts` +9 more
- `packages\engine\src\runtime\store.ts` ← `packages\engine\src\execution-lifecycle\artifacts.ts`, `packages\engine\src\execution-lifecycle\dispatch.ts`, `packages\engine\src\execution-lifecycle\inspection.ts`, `packages\engine\src\execution-lifecycle\interrupts.ts`, `packages\engine\src\execution-lifecycle\reconciliation.ts` +8 more
- `packages\cli\src\fs\file-system.ts` ← `packages\cli\src\commands\migrate.ts`, `packages\cli\src\commands\validate.ts`, `packages\cli\src\commands\__tests__\init.test.ts`, `packages\cli\src\commands\__tests__\migrate-conversion.test.ts`, `packages\cli\src\commands\__tests__\migrate.test.ts` +7 more

---

# Test Coverage

> **0%** of routes and models are covered by tests
> 123 test files found

---

# CI/CD Pipelines

## GitHub Actions (5 workflows)

| Workflow | Triggers | Jobs | Deploy | Environments |
|---|---|---|---|---|
| Agent Evals | — | 0 | — | — |
| CI | push, pull_request | 1 | — | — |
| Deploy Docs | push, workflow_dispatch | 2 | — | github-pages |
| Release | release | 2 | — | — |
| Snapshot | push | 2 | — | — |

### Deploy Docs

> `.github/workflows/deploy-docs.yml`

> Concurrency: `github-pages`

- **build** on `ubuntu-latest` — 6 steps
  - `actions/checkout@v4`
  - `actions/configure-pages@v5`
  - `oven-sh/setup-bun@v2`
  - `actions/upload-pages-artifact@v3`
- **deploy** on `ubuntu-latest` — 1 steps (needs: build)
  - `actions/deploy-pages@v4`

### Release

> `.github/workflows/release.yml`

> Concurrency: `release`

- **build-and-test** on `ubuntu-latest` — 6 steps
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
- **publish** on `ubuntu-latest` — 6 steps (needs: build-and-test)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`

### Snapshot

> `.github/workflows/snapshot.yml`

> Concurrency: `snapshot`

- **build-and-test** on `ubuntu-latest` — 6 steps
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`
- **publish** on `ubuntu-latest` — 8 steps (needs: build-and-test)
  - `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5`
  - `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`

### Secrets

- `EVAL_RESULTS_REPO_TOKEN`
- `OPENROUTER_API_KEY`
- `WEAVEIO_NPM_TOKEN`

---
_Source: .github/workflows/agent-evals.yml, .github/workflows/ci.yml, .github/workflows/deploy-docs.yml, .github/workflows/release.yml, .github/workflows/snapshot.yml_
_Generated by codesight-cicd-plugin_

---

# Git Hooks

> **Note for agents:** These hooks fire automatically on git operations and will block the operation if they fail.

## `pre-commit` — husky

- **set**: `set -euo pipefail`
- **echo**: `echo "▶ codesight..."`
- **npx**: `npx codesight`
- **git**: `git add .codesight/`
- **echo**: `echo "▶ lint-staged..."`
- **bunx**: `bunx lint-staged`
- **echo**: `echo "▶ typecheck..."`
- **bun**: `bun run typecheck`
- **echo**: `echo "▶ validate-config..."`
- **bun**: `bun run validate-config`
- **echo**: `echo "▶ test..."`
- **bun**: `bun test --recursive`
- **echo**: `echo "✔ all checks passed"`

_Source: .husky/pre-commit_

---

_Generated by [codesight](https://github.com/Houseofmvps/codesight) — see your codebase clearly_