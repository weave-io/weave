export { PI_ADAPTER_CAPABILITY_CONTRACT } from "./capability-declarations.js";
export type {
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
  PiPreflightResult,
  PiSafeInitializerDeps,
} from "./safe-initializer.js";
export { PiSafeInitializer } from "./safe-initializer.js";
export type {
  Clock,
  IdGenerator,
  PiAdapterLogger,
  PiCommandHandler,
  PiCommandInfo,
  PiCommandRegistration,
  PiEventHandler,
  PiExtensionApi,
  PiMode,
  PiResourceOrigin,
  PiResourceScope,
  PiSessionContext,
  PiSourceInfo,
  PiToolInfo,
  PiTrustState,
  PiUiNotifyLevel,
  PiUiPort,
} from "./types.js";
