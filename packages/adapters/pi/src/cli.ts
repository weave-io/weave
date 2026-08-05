/**
 * Thin CLI registration surface for `weave adapter pi …`.
 *
 * The Weave CLI dynamic-imports this entry only so production adapter-command
 * ports do not pull the Pi TUI/extension graph into `@weaveio/weave-cli`.
 * Engine/core stay Pi-free; payload semantics remain adapter-owned.
 */

export type {
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
  CreatePiAdapterCommandHandlersOptions,
} from "./adapter-cli-commands.js";
export {
  PI_ADAPTER_COMMAND_BOUNDS,
  PI_ADAPTER_COMMAND_NAMES,
  PI_ADAPTER_NAME,
  PiChildrenDeleteResultSchema,
  PiChildrenListResultSchema,
  PiChildrenResolveResultSchema,
  PiChildrenShowResultSchema,
  PiDoctorResultSchema,
  createPiAdapterCommandHandlers,
  createPiAdapterCommandRegistry,
  createPiChildrenCommandPort,
  createPlaceholderDoctorPort,
  looksLikeFilesystemPath,
  stripPathsUnlessDiagnostic,
} from "./adapter-cli-commands.js";
export type {
  CreateProductionPiAdapterCommandPortsOptions,
  PiProductionAdapterCommandError,
  PiProductionAdapterCommandPorts,
} from "./adapter-cli-production.js";
export {
  createProductionPiAdapterCommandRegistry,
  openProductionPiAdapterCommandPorts,
} from "./adapter-cli-production.js";
