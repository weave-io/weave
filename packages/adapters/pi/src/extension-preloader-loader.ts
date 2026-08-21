import {
  type GlobalLoaderState,
  PIN_QUERY_PREFIX,
  PINNED_PRELOADER_PLUGIN_NAME,
} from "./extension-preloader-contract.js";

function isLocalModuleSpecifier(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.startsWith("file:") ||
    value.includes("\\") ||
    value.includes("\u0000")
  );
}

function stripQuery(value: string): string {
  const queryIndex = value.indexOf("?");
  return queryIndex < 0 ? value : value.slice(0, queryIndex);
}

function queryToken(value: string): string | undefined {
  const queryIndex = value.indexOf(PIN_QUERY_PREFIX);
  if (queryIndex < 0) return undefined;
  const token = value.slice(queryIndex + PIN_QUERY_PREFIX.length);
  return token.length > 0 && !token.includes("&") ? token : undefined;
}

function pinnedPathForLocalImport(
  importer: string,
  specifier: string,
  token: string,
  pinnedPaths: ReadonlySet<string>,
): string | undefined {
  let target: string | undefined;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const importerPath = stripQuery(importer);
    const slash = importerPath.lastIndexOf("/");
    if (slash < 0 || specifier.includes("?") || specifier.includes("#")) {
      return undefined;
    }
    // Keep the path exact. A traversal component cannot accidentally resolve
    // to a mutable file because only the canonical pinned key is accepted.
    target = `${importerPath.slice(0, slash + 1)}${specifier}`;
    if (specifier.startsWith("./")) {
      target = `${importerPath.slice(0, slash + 1)}${specifier.slice(2)}`;
    }
  } else if (specifier.startsWith("/")) {
    target = specifier;
  }
  if (target === undefined) return undefined;
  const pinnedPath = `${target}${PIN_QUERY_PREFIX}${token}`;
  return pinnedPaths.has(pinnedPath) ? pinnedPath : undefined;
}

/**
 * Install one process-wide, content-free plugin. Bun has no unregister API;
 * the plugin therefore owns only the global registry and looks up a live
 * registration for each callback. Per-load registrations and byte maps are
 * removed by disposePinnedRuntime.
 */
export function installPinnedModulePlugin(state: GlobalLoaderState): boolean {
  if (state.pluginInstalled) return true;
  try {
    Bun.plugin({
      name: PINNED_PRELOADER_PLUGIN_NAME,
      setup(build) {
        build.onResolve({ filter: /.*/u }, (args) => {
          const token = queryToken(args.importer);
          if (token === undefined || !isLocalModuleSpecifier(args.path)) {
            return undefined;
          }
          const registration = state.registrations.get(token);
          if (registration === undefined) {
            return {
              path: args.path,
              errors: [{ message: "disposed pinned module graph" }],
            };
          }
          const pinnedPath = pinnedPathForLocalImport(
            args.importer,
            args.path,
            token,
            registration.pinnedPaths,
          );
          return pinnedPath === undefined
            ? {
                path: args.path,
                errors: [{ message: "unverified pinned module graph" }],
              }
            : { path: pinnedPath };
        });
        build.onLoad({ filter: /\?weave=/u }, (args) => {
          const token = queryToken(args.path);
          if (token === undefined) return undefined;
          const registration = state.registrations.get(token);
          if (
            registration === undefined ||
            !registration.pinnedPaths.has(args.path)
          ) {
            return {
              contents: "",
              loader: "js",
              errors: [{ message: "disposed pinned module bytes" }],
            };
          }
          const contents = state.pins.get(args.path);
          return contents === undefined
            ? {
                contents: "",
                loader: "js",
                errors: [{ message: "missing pinned module bytes" }],
              }
            : { contents, loader: "js" };
        });
      },
    });
    state.pluginInstalled = true;
    return true;
  } catch {
    return false;
  }
}
