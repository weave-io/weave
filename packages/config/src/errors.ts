import type { ConfigError } from "@weave/core";
import type { MergeError } from "./merge.js";

/**
 * Discriminated union of all errors that can occur during config loading.
 *
 * Consumers should switch on `type` to handle each variant:
 * - `FileReadError` — file exists but could not be read (I/O failure)
 * - `ParseError` — file was read but the DSL could not be parsed or validated
 * - `BuiltinParseError` — the built-in DSL constant failed to parse (indicates a bug)
 */
export type ConfigLoadError =
  /**
   * A config file was found but could not be read from disk.
   * `path` is the absolute path that was attempted.
   * `cause` is the underlying error thrown by the I/O layer.
   */
  | {
      type: "FileReadError";
      path: string;
      cause: unknown;
    }

  /**
   * A config file was read successfully but the DSL failed to parse or validate.
   * `path` is the absolute path of the offending file.
   * `errors` contains all parse/validation errors from `@weave/core`.
   */
  | {
      type: "ParseError";
      path: string;
      errors: ConfigError[];
    }

  /**
   * The built-in `.weave` DSL source string failed to parse.
   * This always indicates a bug in `packages/config/src/builtins.ts`.
   * `errors` contains all parse/validation errors from `@weave/core`.
   */
  | {
      type: "BuiltinParseError";
      errors: ConfigError[];
    }

  /**
   * One or more workflow extension errors occurred during config merging.
   * `errors` contains all `MergeError` entries from `mergeConfigsResult`.
   */
  | {
      type: "MergeError";
      errors: MergeError[];
    };
