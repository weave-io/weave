import { logger } from "@weaveio/weave-engine";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  BunChangesetFileSystem,
  type ChangesetBump,
  ChangesetPolicyValidator,
  type ParsedChangeset,
} from "./changeset-policy.js";
import type { Clock } from "./clock.js";
import { BunCommandRunner } from "./command-runner.js";
import { PUBLIC_PACKAGE_NAMES, type PublicPackageName } from "./constants.js";
import {
  type ReleaseInvocation,
  validateReleaseInvocation,
} from "./input-validation.js";
import {
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
  parseJsonValue,
} from "./json.js";
import {
  NightlyVersionSchema,
  ReleaseOperationSchema,
  type StableTrainRecord,
  StableTrainRecordSchema,
} from "./model.js";
import {
  NpmCliRegistryClient,
  type NpmRegistryClient,
} from "./npm-registry-client.js";

export type NightlyPlan =
  | { skip: "no-public-change" | "same-sha"; subjectSha: string }
  | {
      skip: undefined;
      subjectSha: string;
      packages: readonly {
        name: PublicPackageName;
        version: string;
        tag: "nightly";
      }[];
    };

export type NightlyPlanError =
  | { type: "InvalidNightlyInvocation" }
  | { type: "InvalidSubjectSha"; subjectSha: string }
  | { type: "InvalidPackageVersion"; packageName: string; version: string }
  | { type: "InvalidGeneratedVersion"; version: string }
  | { type: "RegistryLookupFailed"; packageName: string; message: string };

export interface NightlyPlanInput {
  invocation: ReleaseInvocation;
  changesets: readonly ParsedChangeset[];
  subjectSha: string;
  /** Stable workspace versions, used only when npm has no stable publication. */
  packageVersions: Readonly<Record<PublicPackageName, string>>;
}

const BUMP_WEIGHT = { patch: 1, minor: 2, major: 3 } as const;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NIGHTLY_FOR_SHA = /-nightly\.\d{8}\.[0-9a-f]{12}$/;

/**
 * Deterministically derives nightly versions without modifying workspace files.
 * The base is the highest published stable SemVer; an unpublished package falls
 * back to its package.json version. Multiple pending bumps use the highest bump.
 */
export class NightlyPlanner {
  constructor(
    private readonly npm: NpmRegistryClient,
    private readonly clock: Clock,
  ) {}

  plan(input: NightlyPlanInput): ResultAsync<NightlyPlan, NightlyPlanError> {
    if (!isNightly(input.invocation))
      return errAsync({ type: "InvalidNightlyInvocation" });
    if (!/^[0-9a-f]{40}$/.test(input.subjectSha))
      return errAsync({
        type: "InvalidSubjectSha",
        subjectSha: input.subjectSha,
      });
    const bumps = collectBumps(input.changesets);
    if (bumps.size === 0)
      return okAsync({
        skip: "no-public-change",
        subjectSha: input.subjectSha,
      });
    const date = utcDate(this.clock.now());
    const shortSha = input.subjectSha.slice(0, 12);
    let planned = okAsync<
      readonly { name: PublicPackageName; version: string; tag: "nightly" }[],
      NightlyPlanError
    >([]);
    for (const [name, bump] of bumps)
      planned = planned.andThen((packages) =>
        this.npm
          .listVersions(name)
          .mapErr((error) => ({
            type: "RegistryLookupFailed" as const,
            packageName: name,
            message: error.message,
          }))
          .andThen((published) => {
            const base =
              highestStable(published) ?? input.packageVersions[name];
            if (base === undefined || !STABLE_VERSION.test(base))
              return errAsync({
                type: "InvalidPackageVersion" as const,
                packageName: name,
                version: base ?? "",
              });
            const version = `${bumpVersion(base, bump)}-nightly.${date}.${shortSha}`;
            if (!NightlyVersionSchema.safeParse(version).success)
              return errAsync({
                type: "InvalidGeneratedVersion" as const,
                version,
              });
            return okAsync([
              ...packages,
              { name, version, tag: "nightly" as const },
            ]);
          }),
      );
    return planned.andThen((packages) => {
      let checks = okAsync<boolean, NightlyPlanError>(true);
      for (const item of packages)
        checks = checks.andThen((allPublished) =>
          this.npm
            .listVersions(item.name)
            .mapErr((error) => ({
              type: "RegistryLookupFailed" as const,
              packageName: item.name,
              message: error.message,
            }))
            .map(
              (versions) =>
                allPublished &&
                versions.some(
                  (version) =>
                    NIGHTLY_FOR_SHA.test(version) && version.endsWith(shortSha),
                ),
            ),
        );
      return checks.map((allPublished) =>
        allPublished
          ? { skip: "same-sha" as const, subjectSha: input.subjectSha }
          : { skip: undefined, subjectSha: input.subjectSha, packages },
      );
    });
  }
}

function isPublicPackageName(value: string): value is PublicPackageName {
  return PUBLIC_PACKAGE_NAMES.some((name) => name === value);
}

const isStringValue = isJsonString;

function isNightly(invocation: ReleaseInvocation): boolean {
  if (invocation.eventName === "schedule") return true;
  return invocation.operation === "nightly" && invocation.channel === "nightly";
}

function collectBumps(
  changesets: readonly ParsedChangeset[],
): Map<PublicPackageName, ChangesetBump> {
  const bumps = new Map<PublicPackageName, ChangesetBump>();
  for (const changeset of changesets)
    for (const [name, bump] of changeset.releases)
      if (isPublicPackageName(name)) {
        const previous = bumps.get(name);
        if (previous === undefined || BUMP_WEIGHT[bump] > BUMP_WEIGHT[previous])
          bumps.set(name, bump);
      }
  return bumps;
}

function highestStable(versions: readonly string[]): string | undefined {
  return versions
    .filter((version) => STABLE_VERSION.test(version))
    .sort(compareVersion)
    .at(-1);
}

function compareVersion(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function bumpVersion(version: string, bump: ChangesetBump): string {
  const [major, minor, patch] = version.split(".").map(Number);
  if (bump === "major") return `${(major ?? 0) + 1}.0.0`;
  if (bump === "minor") return `${major ?? 0}.${(minor ?? 0) + 1}.0`;
  return `${major ?? 0}.${minor ?? 0}.${(patch ?? 0) + 1}`;
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

const REQUIRED_MAIN_CHECK = "Lint, Typecheck, Build & Test";
const log = logger.child({ module: "nightly-plan" });

/** Workflow boundary: proves protected-main state before any build or bind job. */
/** Exported for the release harness: all operation routing remains behind the same shared gates. */
export async function runPreflight(
  environment: Record<string, string | undefined>,
): Promise<number> {
  if (environment.RELEASE_PUBLISH_ENABLED !== "true") {
    log.error("release publication is disabled");
    return 1;
  }
  const eventName = environment.RELEASE_EVENT_NAME;
  const operation =
    eventName === "schedule" ? "nightly" : environment.RELEASE_OPERATION;
  if (eventName !== "schedule" && eventName !== "workflow_dispatch") {
    log.error({ eventName }, "invalid release event");
    return 1;
  }
  if (!ReleaseOperationSchema.safeParse(operation).success) {
    log.error({ operation }, "invalid release operation");
    return 1;
  }
  if (
    environment.RELEASE_REF !== "refs/heads/main" ||
    environment.RELEASE_WORKFLOW_REF !==
      "weave-io/weave/.github/workflows/publish.yml@refs/heads/main"
  ) {
    log.error("workflow source is not protected main");
    return 1;
  }
  const token = environment.GITHUB_TOKEN;
  if (token === undefined) {
    log.error("missing GitHub token");
    return 1;
  }
  const main = await fetchJson("/git/ref/heads/main", token);
  if (
    main.isErr() ||
    !isMainRef(main.value) ||
    environment.RELEASE_SHA !== main.value.object.sha
  ) {
    log.error("workflow SHA is stale relative to main");
    return 1;
  }
  const checks = await fetchJson(
    `/commits/${main.value.object.sha}/check-runs`,
    token,
  );
  if (checks.isErr() || !hasGreenRequiredCheck(checks.value)) {
    log.error(
      { requiredCheck: REQUIRED_MAIN_CHECK },
      "main required check is not green",
    );
    return 1;
  }
  if (operation !== "nightly") {
    const stableTrain = parseStableTrain(environment.RELEASE_STABLE_TRAIN);
    if (
      (operation === "stable-publish" || operation === "stable-finalize") &&
      stableTrain === undefined
    ) {
      log.error("stable publish/finalize requires a valid stable train input");
      return 1;
    }
    const output = environment.GITHUB_OUTPUT;
    if (output !== undefined)
      await Bun.write(
        output,
        `operation=${operation}\nskipped=false\nversions=${JSON.stringify(stableTrain?.versions ?? {})}\nstable_plan_input=${environment.RELEASE_STABLE_PLAN_INPUT ?? ""}\nmetadata_replay_input=${environment.RELEASE_METADATA_REPLAY_INPUT ?? ""}\nstable_train=${environment.RELEASE_STABLE_TRAIN ?? ""}\n`,
      );
    log.info({ operation }, "non-nightly release preflight passed");
    return 0;
  }
  const invocation = validateReleaseInvocation({
    repository: "weave-io/weave",
    workflowPath: ".github/workflows/publish.yml",
    eventName: "schedule",
    ref: "refs/heads/main",
  });
  if (invocation.isErr()) {
    log.error(
      { issues: invocation.error.issues },
      "invalid normalized nightly invocation",
    );
    return 1;
  }
  const changesets = await loadChangesets();
  if (changesets.isErr()) {
    log.error({ errors: changesets.error }, "changeset policy failed");
    return 1;
  }
  const packageVersions = await loadPackageVersions();
  if (packageVersions.isErr()) {
    log.error(
      { error: packageVersions.error },
      "unable to load workspace versions",
    );
    return 1;
  }
  const serverDate = new Date(main.value.date);
  if (Number.isNaN(serverDate.valueOf())) {
    log.error("GitHub server date was invalid");
    return 1;
  }
  const plan = await new NightlyPlanner(
    new NpmCliRegistryClient(new BunCommandRunner()),
    { now: () => serverDate, sleep: () => okAsync() },
  ).plan({
    invocation: invocation.value,
    changesets: changesets.value,
    subjectSha: main.value.object.sha,
    packageVersions: packageVersions.value,
  });
  if (plan.isErr()) {
    log.error({ error: plan.error }, "nightly planning failed");
    return 1;
  }
  const output = environment.GITHUB_OUTPUT;
  if (output !== undefined)
    await Bun.write(
      output,
      `operation=nightly\nskipped=${plan.value.skip === undefined ? "false" : "true"}\nversions=${JSON.stringify(plan.value.skip === undefined ? Object.fromEntries(plan.value.packages.map((entry) => [entry.name, entry.version])) : {})}\n`,
    );
  log.info(
    { plan: plan.value },
    plan.value.skip === undefined ? "nightly plan created" : "nightly skipped",
  );
  return 0;
}

function parseStableTrain(
  value: string | undefined,
): StableTrainRecord | undefined {
  if (value === undefined) return undefined;
  const decoded = parseJsonValue(value);
  if (decoded.isErr()) return undefined;
  const record = StableTrainRecordSchema.safeParse(decoded.value);
  return record.success ? record.data : undefined;
}

type PreflightResponseError = { type: "GitHubResponse" };
type MainRef = JsonObject & {
  readonly object: JsonObject & { readonly sha: string };
  readonly date: string;
};
type PreflightResponse = JsonObject & { readonly date: string };
function fetchJson(
  path: string,
  token: string,
): ResultAsync<PreflightResponse, PreflightResponseError> {
  return ResultAsync.fromPromise(
    fetch(`https://api.github.com/repos/weave-io/weave${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
      },
    }),
    () => ({ type: "GitHubResponse" as const }),
  ).andThen((response) => {
    if (!response.ok) return errAsync({ type: "GitHubResponse" as const });
    return ResultAsync.fromPromise(response.text(), () => ({
      type: "GitHubResponse" as const,
    })).andThen((text) => {
      const parsed = parseJsonValue(text);
      if (parsed.isErr()) return errAsync({ type: "GitHubResponse" as const });
      if (!isJsonObject(parsed.value))
        return errAsync({ type: "GitHubResponse" as const });
      const body = parsed.value;
      const withDate = Object.assign({}, body, {
        date: response.headers.get("date") ?? "",
      });
      return okAsync(withDate);
    });
  });
}
function isMainRef(value: JsonValue): value is MainRef {
  return (
    isJsonObject(value) &&
    isStringValue(value.date) &&
    isJsonObject(value.object) &&
    isStringValue(value.object.sha) &&
    /^[0-9a-f]{40}$/.test(value.object.sha)
  );
}
function hasGreenRequiredCheck(value: JsonValue): boolean {
  if (!isCheckRunsPayload(value)) return false;
  return value.check_runs.some(isGreenCheck);
}
function isCheckRunsPayload(
  value: JsonValue,
): value is JsonValue & { readonly check_runs: readonly JsonValue[] } {
  return isJsonObject(value) && Array.isArray(value.check_runs);
}
function isGreenCheck(value: JsonValue): boolean {
  if (!isJsonObject(value)) return false;
  return value.name === REQUIRED_MAIN_CHECK && value.conclusion === "success";
}
function loadChangesets(): ResultAsync<readonly ParsedChangeset[], unknown> {
  const files = new BunChangesetFileSystem();
  const validator = new ChangesetPolicyValidator(files);
  return validator
    .validateDirectory(".changeset")
    .mapErr((error) => error)
    .andThen(() =>
      files.listMarkdown(".changeset").andThen((paths) => {
        let loaded = okAsync<ParsedChangeset[], unknown[]>([]);
        for (const path of paths)
          loaded = loaded.andThen((parsed) =>
            files
              .readText(path)
              .andThen((contents) => validator.parse(path, contents))
              .map((changeset) => [...parsed, changeset])
              .mapErr((error) => [error]),
          );
        return loaded;
      }),
    );
}
function loadPackageVersions(): ResultAsync<
  Record<PublicPackageName, string>,
  string
> {
  const locations = {
    "@weaveio/weave-cli": "packages/cli/package.json",
    "@weaveio/weave-adapter-opencode":
      "packages/adapters/opencode/package.json",
    "@weaveio/weave-adapter-claude-code":
      "packages/adapters/claude-code/package.json",
    "@weaveio/weave-adapter-pi": "packages/adapters/pi/package.json",
  } satisfies Record<PublicPackageName, string>;
  return ResultAsync.fromPromise(
    Promise.all(
      Object.entries(locations).map(
        async ([name, path]) => [name, await Bun.file(path).json()] as const,
      ),
    ),
    () => "package manifest read failed",
  ).andThen((entries) => {
    const versions = new Map<PublicPackageName, string>();
    for (const [name, manifest] of entries) {
      if (!isJsonObject(manifest) || !isStringValue(manifest.version))
        return errAsync("package manifest has no version");
      if (!isPublicPackageName(name))
        return errAsync("package manifest has an unknown package");
      versions.set(name, manifest.version);
    }
    const cli = versions.get("@weaveio/weave-cli");
    const openCode = versions.get("@weaveio/weave-adapter-opencode");
    const claude = versions.get("@weaveio/weave-adapter-claude-code");
    const pi = versions.get("@weaveio/weave-adapter-pi");
    if (
      cli === undefined ||
      openCode === undefined ||
      claude === undefined ||
      pi === undefined
    )
      return errAsync("package manifest set is incomplete");
    return okAsync({
      "@weaveio/weave-cli": cli,
      "@weaveio/weave-adapter-opencode": openCode,
      "@weaveio/weave-adapter-claude-code": claude,
      "@weaveio/weave-adapter-pi": pi,
    });
  });
}

if (import.meta.main) process.exitCode = await runPreflight(process.env);
