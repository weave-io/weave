/**
 * Thin CLI registration surface for `weave adapter pi …`.
 *
 * The Weave CLI dynamic-imports this entry only so production adapter-command
 * ports do not pull the Pi TUI/extension graph into `@weaveio/weave-cli`.
 * Engine/core stay Pi-free; payload semantics remain adapter-owned.
 */

export type {
  CreatePiAdapterCommandHandlersOptions,
  PiAdapterChildEntrySummary,
  PiAdapterChildListItem,
  PiAdapterChildrenPort,
  PiAdapterCommandPortError,
  PiAdapterDoctorPort,
  PiChildrenCommandPortOptions,
  PiChildrenDeleteResult,
  PiChildrenListResult,
  PiChildrenResolveResult,
  PiChildrenShowResult,
  PiDoctorResult,
} from "./adapter-cli-commands.js";
export {
  createPiAdapterCommandHandlers,
  createPiAdapterCommandRegistry,
  createPiChildrenCommandPort,
  createPlaceholderDoctorPort,
  looksLikeFilesystemPath,
  PI_ADAPTER_COMMAND_BOUNDS,
  PI_ADAPTER_COMMAND_NAMES,
  PI_ADAPTER_NAME,
  PiChildrenDeleteResultSchema,
  PiChildrenListResultSchema,
  PiChildrenResolveResultSchema,
  PiChildrenShowResultSchema,
  PiDoctorResultSchema,
  stripPathsUnlessDiagnostic,
} from "./adapter-cli-commands.js";
export type {
  CreateProductionPiAdapterCommandPortsOptions,
  PiProductionAdapterAccessMode,
  PiProductionAdapterCliOpenError,
  PiProductionAdapterCommandError,
  PiProductionAdapterCommandPorts,
  ResolveProductionAdapterCliRegistryInput,
} from "./adapter-cli-production.js";
export {
  accessModeForAdapterAction,
  createProductionPiAdapterCommandRegistry,
  createProductionPorts,
  openProductionPiAdapterCommandPorts,
  resolveProductionAdapterCliRegistry,
} from "./adapter-cli-production.js";
export type { PiSessionMutationGate } from "./required-capability-gate.js";
export {
  createBlockedSessionMutationGate,
  createOpenSessionMutationGate,
  createSessionMutationGate,
  SESSION_MUTATION_REQUIRED_CAPABILITY,
} from "./required-capability-gate.js";
