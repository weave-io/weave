export { PI_ADAPTER_CAPABILITY_CONTRACT } from "./capability-declarations.js";
export type {
  PiCandidatePlanContext,
  PiCapabilityProbeSource,
  PiPreflightContext,
} from "./capability-prober.js";
export {
  buildBlockedProbeSet,
  DefaultPiCapabilityProber,
  PROJECT_PATH_DEPENDENT_CAPABILITIES,
  sanitizeCapabilityProbeResults,
} from "./capability-prober.js";
export type {
  WeaveCommandClassification,
  WeaveCommandName,
} from "./commands.js";
export {
  ADAPTER_PACKAGE_IDENTITY,
  classifyWeaveCommand,
  isOwnSourceInfo,
  parseNpmSourceName,
  WEAVE_COMMAND_NAMES,
} from "./commands.js";
export type {
  PiConfigActivationInput,
  PiConfigActivationResult,
  PiConfigActivatorDeps,
  PiConfigLoaderPort,
  PiDescriptorCatalog,
  PiMaterializerPort,
} from "./config-activator.js";
export {
  buildDescriptorCatalog,
  createTrustWithheldFileReader,
  defaultPiConfigLoaderPort,
  defaultPiFileReader,
  defaultPiMaterializerPort,
  logMaterializationErrors,
  PiConfigActivator,
} from "./config-activator.js";
export type {
  PiCommandGateDecision,
  PiExtensionControllerDeps,
  PiGeneration,
  PiOperationHandle,
} from "./controller.js";
export { PiExtensionController } from "./controller.js";
export type {
  PiAdapterFailure,
  PiAdapterFailureCode,
  PiAdapterFailureImpact,
  PiAdapterFailurePhase,
  PiAdapterFailureRecovery,
  PiAdapterFailureScope,
} from "./errors.js";
export {
  makeActivationFailedFailure,
  makeCommandCollisionFailure,
  makeControllerGenerationStaleFailure,
  makeHostIdentityUnknownFailure,
  makeHostVersionUnsupportedFailure,
  makeInteractiveTuiRequiredFailure,
  makeInvariantViolationFailure,
  PiAdapterFailureCodeSchema,
  PiAdapterFailureImpactSchema,
  PiAdapterFailurePhaseSchema,
  PiAdapterFailureRecoverySchema,
} from "./errors.js";
export type { PiExtensionDeps } from "./extension.js";
export {
  createDefaultPiExtensionDeps,
  createPiExtension,
} from "./extension.js";
export type {
  HostPackageInfo,
  HostPackageReader,
} from "./host-compatibility.js";
export {
  BunHostPackageReader,
  checkHostCompatibility,
  HOST_PACKAGE_NAME,
  HOST_VERSION_CEILING,
  HOST_VERSION_FLOOR,
  HostPackageInfoSchema,
  isSupportedHostVersion,
  parseSemver,
} from "./host-compatibility.js";
export { readValidatedCommands, readValidatedTools } from "./host-inventory.js";
export type {
  PiModelActivationOutcome,
  PiModelApplyPort,
  PiModelInfo,
  PiModelResolution,
  PiModelResolutionSource,
} from "./model-resolution.js";
export { PiModelActivator, PiModelResolver } from "./model-resolution.js";
export type {
  PiActivePrimary,
  PiPrimaryActivationContext,
  PiPrimaryActivationError,
  PiPrimaryCapabilityWarning,
  PiPrimarySessionDeps,
} from "./primary-session.js";
export {
  appendWeaveBlockOnce,
  DEFAULT_PRIMARY_AGENT_NAME,
  PiPrimarySession,
  renderWeavePromptBlock,
} from "./primary-session.js";
export type {
  PiPreflightResult,
  PiSafeInitializerDeps,
} from "./safe-initializer.js";
export { PiSafeInitializer } from "./safe-initializer.js";
export { PiSkillCatalog, toEngineSkillInfo } from "./skill-catalog.js";
export type {
  Clock,
  IdGenerator,
  PiAdapterLogger,
  PiBeforeAgentStartEvent,
  PiBuildSystemPromptOptions,
  PiCommandHandler,
  PiCommandInfo,
  PiCommandRegistration,
  PiEventHandler,
  PiExtensionApi,
  PiMode,
  PiModelRegistry,
  PiResourceOrigin,
  PiResourceScope,
  PiSessionContext,
  PiSkillInfo,
  PiSourceInfo,
  PiToolInfo,
  PiTrustState,
  PiUiNotifyLevel,
  PiUiPort,
} from "./types.js";
