/**
 * Pure host-module redirect planner (Pi adapter contract).
 *
 * Decides, from already-gathered facts, whether each closed Pi host specifier
 * should re-export the proven host copy, and renders the re-export stub. This
 * module has no I/O, no `Bun.*`, and no dynamic import: the loader edge
 * gathers facts and registers overrides.
 *
 * Health and log strings stay path-free. Absolute paths live only on the
 * opt-in proof record.
 */
import { isAbsolute } from "node:path";
import { err, ok, type Result } from "neverthrow";

/**
 * Same identity as `HOST_PACKAGE_NAME` in `host-compatibility.ts`, kept local
 * so this module never imports the Pi host package.
 */
const EXPECTED_HOST_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** Closed set of Pi packages the adapter must share with the host process. */
export const PI_HOST_MODULE_SPECIFIERS = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
] as const;

export type PiHostModuleSpecifier = (typeof PI_HOST_MODULE_SPECIFIERS)[number];

/**
 * Why one specifier was redirected, skipped, or rejected. The planner emits
 * the skip and rejection reasons; `plugin-unavailable` and
 * `redirect-registered` belong to the loader edge after it tries to install
 * an override.
 */
export const PI_HOST_REDIRECT_REASONS = [
  "host-root-unproven",
  "host-package-mismatch",
  "no-local-copy",
  "already-host",
  "local-path-unsafe",
  "plugin-unavailable",
  "redirect-registered",
] as const;

export type PiHostRedirectReason = (typeof PI_HOST_REDIRECT_REASONS)[number];

/**
 * Pi's extension loader aliases the bare `pi-ai` specifier to the compat
 * entry (`dist/core/extensions/loader.js`). Redirects must target that same
 * entry so the extension sees the host's global API surface.
 */
export const PI_AI_COMPAT_SPECIFIER = "@earendil-works/pi-ai/compat";

/** Same bound as validated spawn paths in the child-session launch grant. */
export const MAX_HOST_MODULE_PATH_LENGTH = 4_096;

/** Health-line budget. Specifier names and reasons fit well under this. */
const MAX_HOST_REDIRECT_SUMMARY_LENGTH = 160;

export interface PiHostSpecifierFacts {
  readonly localEntryPath?: string;
  readonly hostEntryPath?: string;
}

export interface PiHostModuleRedirectInput {
  readonly hostPackageRoot: string;
  readonly hostPackage: {
    readonly name: string;
    readonly version: string;
  };
  readonly specifiers: {
    readonly [K in PiHostModuleSpecifier]: PiHostSpecifierFacts;
  };
}

export interface PiHostRedirectTarget {
  readonly specifier: PiHostModuleSpecifier;
  readonly hostSpecifier: string;
  readonly localEntryPath: string;
  readonly hostEntryPath: string;
}

export interface PiHostSkippedSpecifier {
  readonly specifier: PiHostModuleSpecifier;
  readonly reason: PiHostRedirectReason;
}

export interface PiHostRedirectProofSpecifier {
  readonly specifier: PiHostModuleSpecifier;
  readonly hostSpecifier: string;
  readonly localEntryPath?: string;
  readonly hostEntryPath?: string;
  readonly redirected: boolean;
  readonly skipReason?: PiHostRedirectReason;
}

/** Opt-in proof record. May carry absolute paths; never log this by default. */
export interface PiHostRedirectProofRecord {
  readonly hostRoot: string;
  readonly hostVersion: string;
  readonly specifiers: readonly PiHostRedirectProofSpecifier[];
}

export interface PiHostRedirectPlan {
  readonly hostVersion: string;
  readonly redirects: readonly PiHostRedirectTarget[];
  readonly skipped: readonly PiHostSkippedSpecifier[];
  readonly proof: PiHostRedirectProofRecord;
}

export type PiHostRedirectDiagnostic =
  | {
      readonly reason: "host-root-unproven";
    }
  | {
      readonly reason: "host-package-mismatch";
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly reason: "local-path-unsafe";
      readonly field: "hostPackageRoot" | "localEntryPath" | "hostEntryPath";
      readonly specifier?: PiHostModuleSpecifier;
    };

/**
 * Host specifier the override must load. Bare `pi-ai` maps to the compat
 * entry; the other two keep their own names.
 */
export function hostEntrySpecifierFor(
  specifier: PiHostModuleSpecifier,
): string {
  if (specifier === "@earendil-works/pi-ai") return PI_AI_COMPAT_SPECIFIER;
  return specifier;
}

/**
 * Accepts only a bounded absolute path: no NUL, no backslash, no `.` or `..`
 * component. Matches {@link validateAbsoluteSpawnPath} in `rpc-child.ts`,
 * plus an explicit length bound.
 */
export function isSafeAbsoluteHostPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_HOST_MODULE_PATH_LENGTH) {
    return false;
  }
  if (value.includes("\0") || value.includes("\\")) return false;
  if (!isAbsolute(value)) return false;
  const components = value.split("/");
  return !components.some(
    (component, index) =>
      index > 0 && (component === "." || component === ".."),
  );
}

function validateRequiredPath(
  value: string,
  field: "hostPackageRoot",
): Result<string, PiHostRedirectDiagnostic> {
  if (value.length === 0) return err({ reason: "host-root-unproven" });
  if (!isSafeAbsoluteHostPath(value)) {
    return err({ reason: "local-path-unsafe", field });
  }
  return ok(value);
}

function validateOptionalPath(
  value: string | undefined,
  field: "localEntryPath" | "hostEntryPath",
  specifier: PiHostModuleSpecifier,
): Result<string | undefined, PiHostRedirectDiagnostic> {
  if (value === undefined) return ok(undefined);
  if (!isSafeAbsoluteHostPath(value)) {
    return err({ reason: "local-path-unsafe", field, specifier });
  }
  return ok(value);
}

function skip(
  specifier: PiHostModuleSpecifier,
  reason: PiHostRedirectReason,
): PiHostSkippedSpecifier {
  return { specifier, reason };
}

function decideSpecifier(
  specifier: PiHostModuleSpecifier,
  facts: PiHostSpecifierFacts,
): Result<
  | { readonly kind: "redirect"; readonly target: PiHostRedirectTarget }
  | { readonly kind: "skip"; readonly skip: PiHostSkippedSpecifier },
  PiHostRedirectDiagnostic
> {
  const localResult = validateOptionalPath(
    facts.localEntryPath,
    "localEntryPath",
    specifier,
  );
  if (localResult.isErr()) return err(localResult.error);
  const hostResult = validateOptionalPath(
    facts.hostEntryPath,
    "hostEntryPath",
    specifier,
  );
  if (hostResult.isErr()) return err(hostResult.error);

  const localEntryPath = localResult.value;
  const hostEntryPath = hostResult.value;
  const hostSpecifier = hostEntrySpecifierFor(specifier);

  if (localEntryPath === undefined) {
    return ok({ kind: "skip", skip: skip(specifier, "no-local-copy") });
  }
  if (hostEntryPath === undefined) {
    return ok({ kind: "skip", skip: skip(specifier, "host-root-unproven") });
  }
  if (localEntryPath === hostEntryPath) {
    return ok({ kind: "skip", skip: skip(specifier, "already-host") });
  }
  return ok({
    kind: "redirect",
    target: {
      specifier,
      hostSpecifier,
      localEntryPath,
      hostEntryPath,
    },
  });
}

function buildProof(
  input: PiHostModuleRedirectInput,
  redirects: readonly PiHostRedirectTarget[],
  skipped: readonly PiHostSkippedSpecifier[],
): PiHostRedirectProofRecord {
  const redirectBySpecifier = new Map(
    redirects.map((target) => [target.specifier, target]),
  );
  const skipBySpecifier = new Map(
    skipped.map((entry) => [entry.specifier, entry]),
  );
  return {
    hostRoot: input.hostPackageRoot,
    hostVersion: input.hostPackage.version,
    specifiers: PI_HOST_MODULE_SPECIFIERS.map((specifier) => {
      const facts = input.specifiers[specifier];
      const redirect = redirectBySpecifier.get(specifier);
      const skippedEntry = skipBySpecifier.get(specifier);
      return {
        specifier,
        hostSpecifier: hostEntrySpecifierFor(specifier),
        ...(facts.localEntryPath === undefined
          ? {}
          : { localEntryPath: facts.localEntryPath }),
        ...((redirect?.hostEntryPath ?? facts.hostEntryPath)
          ? {
              hostEntryPath: redirect?.hostEntryPath ?? facts.hostEntryPath,
            }
          : {}),
        redirected: redirect !== undefined,
        ...(skippedEntry === undefined
          ? {}
          : { skipReason: skippedEntry.reason }),
      };
    }),
  };
}

/**
 * Plan a redirect or skip for every closed host specifier.
 *
 * Rejects the whole plan when the host package identity is wrong or any
 * supplied path is unsafe. A missing local copy, an identical local/host
 * pair, or a missing host entry is a per-specifier skip, not a failure.
 */
export function planHostModuleRedirect(
  input: PiHostModuleRedirectInput,
): Result<PiHostRedirectPlan, PiHostRedirectDiagnostic> {
  if (input.hostPackage.name !== EXPECTED_HOST_PACKAGE_NAME) {
    return err({
      reason: "host-package-mismatch",
      expected: EXPECTED_HOST_PACKAGE_NAME,
      actual: input.hostPackage.name,
    });
  }

  const rootResult = validateRequiredPath(
    input.hostPackageRoot,
    "hostPackageRoot",
  );
  if (rootResult.isErr()) return err(rootResult.error);

  const redirects: PiHostRedirectTarget[] = [];
  const skipped: PiHostSkippedSpecifier[] = [];

  for (const specifier of PI_HOST_MODULE_SPECIFIERS) {
    const decision = decideSpecifier(specifier, input.specifiers[specifier]);
    if (decision.isErr()) return err(decision.error);
    if (decision.value.kind === "redirect") {
      redirects.push(decision.value.target);
      continue;
    }
    skipped.push(decision.value.skip);
  }

  return ok({
    hostVersion: input.hostPackage.version,
    redirects,
    skipped,
    proof: buildProof(input, redirects, skipped),
  });
}

/**
 * Re-export stub that `Bun.plugin` `onLoad` can return for a local copy.
 * `export *` does not re-export `default`; the caller must say whether a
 * default export was observed.
 */
export function renderHostReexportStub(input: {
  readonly hostEntryPath: string;
  readonly hasDefaultExport: boolean;
}): string {
  const specifier = JSON.stringify(input.hostEntryPath);
  if (input.hasDefaultExport) {
    return `export * from ${specifier};\nexport { default } from ${specifier};`;
  }
  return `export * from ${specifier};`;
}

function countSkipReasons(skipped: readonly PiHostSkippedSpecifier[]): string {
  const counts = new Map<PiHostRedirectReason, number>();
  for (const entry of skipped) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  return PI_HOST_REDIRECT_REASONS.filter((reason) => counts.has(reason))
    .map((reason) => {
      const count = counts.get(reason) ?? 0;
      return count === 1 ? reason : `${reason}:${count}`;
    })
    .join(", ");
}

/**
 * Bounded, path-free health line. Counts and closed reasons only; never an
 * absolute path or host root.
 */
export function summarizeHostRedirect(plan: PiHostRedirectPlan): string {
  const skipDetail =
    plan.skipped.length === 0 ? "" : ` (${countSkipReasons(plan.skipped)})`;
  const summary = `host modules: redirected ${plan.redirects.length}, skipped ${plan.skipped.length}${skipDetail}`;
  if (summary.length <= MAX_HOST_REDIRECT_SUMMARY_LENGTH) return summary;
  return summary.slice(0, MAX_HOST_REDIRECT_SUMMARY_LENGTH);
}
