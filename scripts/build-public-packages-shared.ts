import type { ResultAsync } from "neverthrow";
import type {
  PrivatePackageName,
  PublicPackageName,
} from "./release/constants.js";

export type PublicPrivatePackageName =
  | PrivatePackageName
  | "@weaveio/weave-adapter-claude-code"
  | "@weaveio/weave-adapter-pi";

export type PublicPackageBuildError =
  | {
      type: "BuildDiagnostics";
      packageName: PublicPackageName;
      diagnostics: string;
    }
  | {
      type: "Filesystem";
      path: string;
      operation: "copy" | "delete" | "list" | "mkdir" | "chmod" | "write";
    }
  | {
      type: "TypeDeclarations";
      packageName: PublicPackageName;
      config?: string;
      diagnostics?: string;
    }
  | { type: "CliManifest"; path: string }
  | {
      type: "BuildIdentity";
      reason:
        | "git-subject-unavailable"
        | "git-state-unavailable"
        | "manifest-invalid"
        | "input-unavailable"
        | "output-unavailable";
    }
  | {
      type: "PrivateDependencyReference";
      packageName: PublicPackageName;
      output: string;
      privatePackageName: PublicPrivatePackageName;
    };

export interface PublicPackageFileSystem {
  copyFile(
    source: string,
    destination: string,
  ): ResultAsync<void, PublicPackageBuildError>;
  ensureDirectory(path: string): ResultAsync<void, PublicPackageBuildError>;
  makeExecutable(path: string): ResultAsync<void, PublicPackageBuildError>;
  listDeclarationFiles(
    directory: string,
  ): ResultAsync<readonly string[], PublicPackageBuildError>;
  /** Optional source-tree listing seam used by the post-build identity record. */
  listPiBuildInputFiles?(): ResultAsync<
    readonly string[],
    PublicPackageBuildError
  >;
  readText(path: string): ResultAsync<string, PublicPackageBuildError>;
  removeFile(path: string): ResultAsync<void, PublicPackageBuildError>;
  writeText(
    path: string,
    contents: string,
  ): ResultAsync<void, PublicPackageBuildError>;
}

/**
 * Matches only dependency-map entries and module specifiers, not prose mentions.
 * This permits bundled builtin guidance to name a package without adding a runtime
 * dependency to the packed artifact.
 */
export function hasPrivateDependencyReference(
  contents: string,
  packageName: string,
): boolean {
  const escaped = packageName.replaceAll("/", "\\/");
  const dependencyMap = new RegExp(
    `["']${escaped}["']\\s*:\\s*["'](?:workspace:|[~^<>=*]|\\d)`,
  );
  const moduleSpecifier = new RegExp(
    `(?:import|export)\\s+(?:[^"']*?\\s+from\\s+)?["']${escaped}["']|require\\(\\s*["']${escaped}["']\\s*\\)`,
  );
  return dependencyMap.test(contents) || moduleSpecifier.test(contents);
}

/**
 * Matches any private workspace name in a shipped declaration, including prose.
 * Unlike runtime JavaScript, declaration files expose their complete text to
 * consumers and are therefore held to a stricter no-private-name policy.
 */
export function hasPrivateDeclarationReference(
  contents: string,
  packageName: string,
): boolean {
  return contents.includes(packageName);
}

/** A bundled Pi preloader must not evaluate a source seam from disk. */
export function hasRuntimeRelativeImport(contents: string): boolean {
  return /(?:from|import|export)\s*(?:\(\s*)?["'](?:\.\.\/|\.\/)/u.test(
    contents,
  );
}
