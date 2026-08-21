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
import { err, ok, Result, type Result as ResultType } from "neverthrow";
import { z } from "zod";

/**
 * Same identity as `HOST_PACKAGE_NAME` in `host-compatibility.ts`, kept local
 * so this module never imports the Pi host package.
 */
const EXPECTED_HOST_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/**
 * The one pi-ai subpath this adapter imports directly.
 *
 * It is a distinct member of the closed proof set rather than a consequence
 * of the bare `@earendil-works/pi-ai` entry: a subpath import resolves to its
 * own file, so redirecting the package entry proves nothing about it. The
 * codex-fast wrapper depends on `options.fetch` support that only exists in
 * the host's copy, so this exact module must be proven, by itself.
 */
export const CODEX_PROVIDER_SUBPATH_SPECIFIER =
  "@earendil-works/pi-ai/providers/openai-codex";

/**
 * Closed set of Pi host modules the adapter must share with the host
 * process: three package entries plus the one proven subpath import.
 */
export const PI_HOST_MODULE_SPECIFIERS = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  CODEX_PROVIDER_SUBPATH_SPECIFIER,
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

const REDIRECT_INPUT_SCHEMA = z.unknown();
type RedirectInput = z.input<typeof REDIRECT_INPUT_SCHEMA>;

interface RedirectObjectReference {
  readonly redirectObjectMarker?: never;
}

const REDIRECT_OBJECT_SCHEMA = z.custom<RedirectObjectReference>((value) => {
  const checked = Result.fromThrowable(
    (): boolean => {
      if (value === null || Object(value) !== value) return false;
      if (Array.isArray(value)) return false;
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    },
    (): boolean => false,
  )();
  return checked.isOk() && checked.value;
});

type RedirectDataRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: RedirectInput };

function readRedirectData(value: RedirectInput, key: string): RedirectDataRead {
  const record = REDIRECT_OBJECT_SCHEMA.safeParse(value);
  if (!record.success) return { kind: "invalid" };
  const descriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(record.data, key),
    (): PropertyDescriptor | undefined => undefined,
  )();
  if (descriptor.isErr()) return { kind: "invalid" };
  if (descriptor.value === undefined) return { kind: "missing" };
  if (!("value" in descriptor.value) || descriptor.value.enumerable !== true) {
    return { kind: "invalid" };
  }
  return { kind: "value", value: descriptor.value.value };
}

type MutableRedirectFacts = {
  localEntryPath?: string;
  hostEntryPath?: string;
};

type MutableRedirectSpecifiers = {
  -readonly [K in PiHostModuleSpecifier]: MutableRedirectFacts;
};

function parseRedirectInput(
  value: RedirectInput,
): ResultType<PiHostModuleRedirectInput, PiHostRedirectDiagnostic> {
  const root = readRedirectData(value, "hostPackageRoot");
  if (root.kind !== "value") return err({ reason: "host-root-unproven" });
  const hostPackageValue = readRedirectData(value, "hostPackage");
  if (hostPackageValue.kind !== "value") {
    return err({
      reason: "host-package-mismatch",
      expected: EXPECTED_HOST_PACKAGE_NAME,
      actual: "malformed",
    });
  }
  const hostPackage = REDIRECT_OBJECT_SCHEMA.safeParse(hostPackageValue.value);
  if (!hostPackage.success) {
    return err({
      reason: "host-package-mismatch",
      expected: EXPECTED_HOST_PACKAGE_NAME,
      actual: "malformed",
    });
  }
  const name = readRedirectData(hostPackage.data, "name");
  const version = readRedirectData(hostPackage.data, "version");
  if (name.kind !== "value" || version.kind !== "value") {
    return err({
      reason: "host-package-mismatch",
      expected: EXPECTED_HOST_PACKAGE_NAME,
      actual: "malformed",
    });
  }
  const parsedName = z.string().min(1).safeParse(name.value);
  const parsedVersion = z.string().min(1).safeParse(version.value);
  if (!parsedName.success || !parsedVersion.success) {
    return err({
      reason: "host-package-mismatch",
      expected: EXPECTED_HOST_PACKAGE_NAME,
      actual: "malformed",
    });
  }
  const specifiersValue = readRedirectData(value, "specifiers");
  const specifiersRecord =
    specifiersValue.kind === "value"
      ? REDIRECT_OBJECT_SCHEMA.safeParse(specifiersValue.value)
      : undefined;
  const specifiers: MutableRedirectSpecifiers = {
    "@earendil-works/pi-coding-agent": {},
    "@earendil-works/pi-ai": {},
    "@earendil-works/pi-tui": {},
    [CODEX_PROVIDER_SUBPATH_SPECIFIER]: {},
  };
  for (const specifier of PI_HOST_MODULE_SPECIFIERS) {
    if (specifiersRecord === undefined || !specifiersRecord.success) continue;
    const factsValue = readRedirectData(specifiersRecord.data, specifier);
    if (factsValue.kind !== "value") continue;
    const factsRecord = REDIRECT_OBJECT_SCHEMA.safeParse(factsValue.value);
    if (!factsRecord.success) continue;
    const facts: MutableRedirectFacts = {};
    const local = readRedirectData(factsRecord.data, "localEntryPath");
    const host = readRedirectData(factsRecord.data, "hostEntryPath");
    if (local.kind === "value") {
      const parsedLocal = z.string().safeParse(local.value);
      if (!parsedLocal.success) {
        return err({
          reason: "local-path-unsafe",
          field: "localEntryPath",
          specifier,
        });
      }
      facts.localEntryPath = parsedLocal.data;
    } else if (local.kind === "invalid") {
      return err({
        reason: "local-path-unsafe",
        field: "localEntryPath",
        specifier,
      });
    }
    if (host.kind === "value") {
      const parsedHost = z.string().safeParse(host.value);
      if (!parsedHost.success) {
        return err({
          reason: "local-path-unsafe",
          field: "hostEntryPath",
          specifier,
        });
      }
      facts.hostEntryPath = parsedHost.data;
    } else if (host.kind === "invalid") {
      return err({
        reason: "local-path-unsafe",
        field: "hostEntryPath",
        specifier,
      });
    }
    specifiers[specifier] = facts;
  }
  const parsedRoot = z.string().safeParse(root.value);
  if (!parsedRoot.success) return err({ reason: "host-root-unproven" });
  return ok({
    hostPackageRoot: parsedRoot.data,
    hostPackage: { name: parsedName.data, version: parsedVersion.data },
    specifiers,
  });
}

/**
 * Host specifier the override must load. Bare `pi-ai` maps to the compat
 * entry; every other member — including the codex provider subpath — keeps
 * its own name and is resolved from the proven host root.
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
/** Whether a string is one of the closed host-module specifiers. */
const PI_HOST_MODULE_SPECIFIER_SET: ReadonlySet<string> = new Set(
  PI_HOST_MODULE_SPECIFIERS,
);

export function isPiHostModuleSpecifier(
  value: string,
): value is PiHostModuleSpecifier {
  return PI_HOST_MODULE_SPECIFIER_SET.has(value);
}

export function isSafeAbsoluteHostPath(value: string): boolean {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) return false;
  const path = parsed.data;
  if (path.length === 0 || path.length > MAX_HOST_MODULE_PATH_LENGTH) {
    return false;
  }
  if (path.includes("\0") || path.includes("\\")) return false;
  if (!isAbsolute(path)) return false;
  const components = path.split("/");
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
  if (value === undefined) return ok(void 0);
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
  hostPackageRoot: string,
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
  const hostRootPrefix = hostPackageRoot.endsWith("/")
    ? hostPackageRoot
    : `${hostPackageRoot}/`;
  if (
    hostEntryPath !== hostPackageRoot &&
    !hostEntryPath.startsWith(hostRootPrefix)
  ) {
    return err({
      reason: "local-path-unsafe",
      field: "hostEntryPath",
      specifier,
    });
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

type MutablePiHostRedirectProofSpecifier = {
  specifier: PiHostModuleSpecifier;
  hostSpecifier: string;
  localEntryPath?: string;
  hostEntryPath?: string;
  redirected: boolean;
  skipReason?: PiHostRedirectReason;
};

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
  const specifiers: MutablePiHostRedirectProofSpecifier[] = [];
  for (const specifier of PI_HOST_MODULE_SPECIFIERS) {
    const facts = input.specifiers[specifier];
    const redirect = redirectBySpecifier.get(specifier);
    const skippedEntry = skipBySpecifier.get(specifier);
    const entry: MutablePiHostRedirectProofSpecifier = {
      specifier,
      hostSpecifier: hostEntrySpecifierFor(specifier),
      redirected: redirect !== undefined,
    };
    if (facts.localEntryPath !== undefined) {
      entry.localEntryPath = facts.localEntryPath;
    }
    const hostEntryPath = redirect?.hostEntryPath ?? facts.hostEntryPath;
    if (hostEntryPath !== undefined) entry.hostEntryPath = hostEntryPath;
    if (skippedEntry !== undefined) entry.skipReason = skippedEntry.reason;
    specifiers.push(entry);
  }
  return {
    hostRoot: input.hostPackageRoot,
    hostVersion: input.hostPackage.version,
    specifiers,
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
): ResultType<PiHostRedirectPlan, PiHostRedirectDiagnostic> {
  const parsedInput = parseRedirectInput(input);
  if (parsedInput.isErr()) return err(parsedInput.error);
  const candidate = parsedInput.value;
  if (candidate.hostPackage.name !== EXPECTED_HOST_PACKAGE_NAME) {
    return err({
      reason: "host-package-mismatch",
      expected: EXPECTED_HOST_PACKAGE_NAME,
      actual: candidate.hostPackage.name,
    });
  }

  const rootResult = validateRequiredPath(
    candidate.hostPackageRoot,
    "hostPackageRoot",
  );
  if (rootResult.isErr()) return err(rootResult.error);

  const redirects: PiHostRedirectTarget[] = [];
  const skipped: PiHostSkippedSpecifier[] = [];

  for (const specifier of PI_HOST_MODULE_SPECIFIERS) {
    const decision = decideSpecifier(
      candidate.hostPackageRoot,
      specifier,
      candidate.specifiers[specifier],
    );
    if (decision.isErr()) return err(decision.error);
    if (decision.value.kind === "redirect") {
      redirects.push(decision.value.target);
      continue;
    }
    skipped.push(decision.value.skip);
  }

  return ok({
    hostVersion: candidate.hostPackage.version,
    redirects,
    skipped,
    proof: buildProof(candidate, redirects, skipped),
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
