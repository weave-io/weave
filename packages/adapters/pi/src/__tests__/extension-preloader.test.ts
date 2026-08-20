import { describe, expect, it } from "bun:test";
import {
  computeExtensionBuildBinding,
  createExtensionBuildManifest,
  EXTENSION_BUILD_BINDING_PLACEHOLDER,
  EXTENSION_RUNTIME_OUTPUT_NAMES,
  renderExtensionBuildManifest,
  sha256Hex,
} from "../extension-build-identity.js";
import {
  makeRealTempRoot,
  removeRealTempRoot,
} from "./fakes/real-temp-root.js";

const SUBJECT = "1".repeat(40);
const BUILD_COMPLETED_AT = "1970-01-01T00:00:00.100Z";
const EVALUATED_KEY = "__weaveExtensionPreloaderTestEvaluated";

type Fixture = {
  readonly directory: string;
  readonly entryPath: string;
  readonly implementationPath: string;
};

function digest(contents: string): string {
  return sha256Hex(new TextEncoder().encode(contents))._unsafeUnwrap();
}

function compileLoader(source: string): string {
  return new Bun.Transpiler({ loader: "ts" }).transformSync(source);
}

function replaceEmbeddedBinding(source: string, binding: string): string {
  const pattern = new RegExp(
    `(const\\s+WEAVE_PI_EMBEDDED_BUILD_BINDING\\s*=\\s*")${EXTENSION_BUILD_BINDING_PLACEHOLDER}("\\s*;)`,
    "u",
  );
  const replaced = source.replace(pattern, `$1${binding}$2`);
  if (replaced === source) throw new Error("loader binding marker missing");
  return replaced;
}

function digestForRuntimeOutput(
  name: string,
  loader: string,
  identity: string,
  implementation: string,
  host: string,
): string {
  switch (name) {
    case "extension":
      return digest(loader);
    case "extension-build-identity":
      return digest(identity);
    case "extension-impl":
      return digest(implementation);
    case "host-module-loader":
      return digest(host);
    default:
      return digest(host);
  }
}

function implementationSource(): string {
  return `
    import "./extension-build-identity.js";
    import "./host-module-loader.js";
    globalThis[${JSON.stringify(EVALUATED_KEY)}] =
      Number(globalThis[${JSON.stringify(EVALUATED_KEY)}] ?? 0) + 1;
    export function setLoadedPiExtensionIdentity(_identity) {}
    export default (pi) => { pi.invoked = true; };
  `;
}

function identitySource(swapPath: string | undefined, swapped: string): string {
  const swap =
    swapPath === undefined
      ? ""
      : `await Bun.write(${JSON.stringify(swapPath)}, ${JSON.stringify(swapped)});`;
  return `
    ${swap}
    export function extensionProcessStartMs() { return 1; }
    export function maybeWriteExtensionBuildIdentityProofLine() { return false; }
  `;
}

function hostSource(): string {
  return `
    export class BunPiHostModuleEnvironment {}
    export function recordHostModuleOutcome(_outcome) {}
    export function recordPiExtensionEntryPath(_path) {}
    export function resolveHostModules() {
      return Promise.resolve({ isOk: () => true, value: {} });
    }
  `;
}

async function createFixture(
  options: {
    readonly identitySource?: string | ((implementationPath: string) => string);
    readonly implementationSource?:
      | string
      | ((input: {
          readonly directory: string;
          readonly implementationPath: string;
        }) => string);
  } = {},
): Promise<Fixture> {
  const directory = await makeRealTempRoot("weave-preloader-test");
  const entryPath = `${directory}/extension.js`;
  const identityPath = `${directory}/extension-build-identity.js`;
  const implementationPath = `${directory}/extension-impl.js`;
  const hostPath = `${directory}/host-module-loader.js`;
  const loaderSource = await Bun.file(
    new URL("../extension.ts", import.meta.url),
  ).text();
  const loaderPlaceholder = compileLoader(loaderSource);
  const identity =
    typeof options.identitySource === "function"
      ? options.identitySource(implementationPath)
      : (options.identitySource ??
        identitySource(undefined, "export default 0;"));
  const implementation =
    typeof options.implementationSource === "function"
      ? options.implementationSource({ directory, implementationPath })
      : (options.implementationSource ?? implementationSource());
  const host = hostSource();
  const placeholderDigests = EXTENSION_RUNTIME_OUTPUT_NAMES.map((name) => ({
    name,
    sha256: digestForRuntimeOutput(
      name,
      loaderPlaceholder,
      identity,
      implementation,
      host,
    ),
  }));
  const binding = computeExtensionBuildBinding({
    subject: SUBJECT,
    dirty: false,
    buildInputs: ["a".repeat(64)],
    runtimeOutputs: placeholderDigests,
    buildCompletedAt: BUILD_COMPLETED_AT,
  })._unsafeUnwrap();
  const loader = replaceEmbeddedBinding(loaderPlaceholder, binding);
  const finalOutputs = EXTENSION_RUNTIME_OUTPUT_NAMES.map((name) => ({
    name,
    sha256: digestForRuntimeOutput(
      name,
      loader,
      identity,
      implementation,
      host,
    ),
  }));
  const manifest = createExtensionBuildManifest({
    subject: SUBJECT,
    dirty: false,
    buildBinding: binding,
    buildInputs: ["a".repeat(64)],
    outputs: finalOutputs,
    buildCompletedAt: BUILD_COMPLETED_AT,
  })._unsafeUnwrap();
  await Bun.write(entryPath, loader);
  await Bun.write(identityPath, identity);
  await Bun.write(implementationPath, implementation);
  await Bun.write(hostPath, host);
  await Bun.write(
    `${directory}/extension-build-identity.json`,
    renderExtensionBuildManifest(manifest)._unsafeUnwrap(),
  );
  return { directory, entryPath, implementationPath };
}

async function loadFixture(
  fixture: Fixture,
): Promise<(pi: unknown) => Promise<void>> {
  const extension = (await import(
    `${fixture.entryPath}?test=${crypto.randomUUID()}`
  )) as { default: (pi: unknown) => Promise<void> };
  return extension.default;
}

async function invokeFixture(fixture: Fixture): Promise<{ invoked: boolean }> {
  (globalThis as Record<string, unknown>)[EVALUATED_KEY] = 0;
  const pi: { invoked?: boolean } = {};
  await (await loadFixture(fixture))(pi);
  return { invoked: pi.invoked === true };
}

async function copyFixtureFiles(from: Fixture, to: Fixture): Promise<void> {
  for (const fileName of [
    "extension.js",
    "extension-build-identity.js",
    "extension-impl.js",
    "host-module-loader.js",
    "extension-build-identity.json",
  ]) {
    await Bun.write(
      `${to.directory}/${fileName}`,
      await Bun.file(`${from.directory}/${fileName}`).arrayBuffer(),
    );
  }
}

describe("trusted extension preloader", () => {
  it("accepts a valid current build and evaluates the pinned implementation", async () => {
    const fixture = await createFixture();
    try {
      expect(await invokeFixture(fixture)).toEqual({ invoked: true });
      expect((globalThis as Record<string, unknown>)[EVALUATED_KEY]).toBe(1);
    } finally {
      await removeRealTempRoot(fixture.directory);
    }
  });

  it("blocks an implementation replaced before factory evaluation", async () => {
    const fixture = await createFixture();
    try {
      await Bun.write(
        fixture.implementationPath,
        "export default (pi) => { pi.invoked = true; };",
      );
      expect(await invokeFixture(fixture)).toEqual({ invoked: false });
      expect((globalThis as Record<string, unknown>)[EVALUATED_KEY]).toBe(0);
    } finally {
      await removeRealTempRoot(fixture.directory);
    }
  });

  it("serves pinned bytes when disk swaps after verification and before import", async () => {
    const swapped = "export default (pi) => { pi.invoked = false; };";
    const fixture = await createFixture({
      identitySource: (implementationPath) =>
        identitySource(implementationPath, swapped),
    });
    try {
      expect(await invokeFixture(fixture)).toEqual({ invoked: true });
      expect(await Bun.file(fixture.implementationPath).text()).toBe(swapped);
    } finally {
      await removeRealTempRoot(fixture.directory);
    }
  });

  it("rejects a stale entry when a newer manifest is installed", async () => {
    const fixture = await createFixture();
    try {
      const manifestPath = `${fixture.directory}/extension-build-identity.json`;
      const manifest = (await Bun.file(manifestPath).json()) as Record<
        string,
        unknown
      >;
      await Bun.write(
        manifestPath,
        JSON.stringify({ ...manifest, buildBinding: "f".repeat(64) }),
      );
      expect(await invokeFixture(fixture)).toEqual({ invoked: false });
    } finally {
      await removeRealTempRoot(fixture.directory);
    }
  });

  it("keeps an old parent stale and reloads a complete new build", async () => {
    const oldBuild = await createFixture();
    const newBuild = await createFixture({
      implementationSource: `${implementationSource()}\n// newer build`,
    });
    try {
      const oldExtension = await loadFixture(oldBuild);
      await copyFixtureFiles(newBuild, oldBuild);

      (globalThis as Record<string, unknown>)[EVALUATED_KEY] = 0;
      const oldParentPi: { invoked?: boolean } = {};
      await oldExtension(oldParentPi);
      expect(oldParentPi.invoked).toBeUndefined();
      expect((globalThis as Record<string, unknown>)[EVALUATED_KEY]).toBe(0);

      (globalThis as Record<string, unknown>)[EVALUATED_KEY] = 0;
      const reloadedPi: { invoked?: boolean } = {};
      await (await loadFixture(oldBuild))(reloadedPi);
      expect(reloadedPi.invoked).toBe(true);
      expect((globalThis as Record<string, unknown>)[EVALUATED_KEY]).toBe(1);
    } finally {
      await removeRealTempRoot(oldBuild.directory);
      await removeRealTempRoot(newBuild.directory);
    }
  });

  it("fails closed for malformed pinned source and replaced identity or host bytes", async () => {
    const malformed = await createFixture({
      implementationSource: "export default (",
    });
    try {
      expect(await invokeFixture(malformed)).toEqual({ invoked: false });
    } finally {
      await removeRealTempRoot(malformed.directory);
    }

    for (const fileName of [
      "extension-build-identity.js",
      "host-module-loader.js",
    ]) {
      const fixture = await createFixture();
      try {
        await Bun.write(
          `${fixture.directory}/${fileName}`,
          "export const corrupt = true;",
        );
        expect(await invokeFixture(fixture)).toEqual({ invoked: false });
      } finally {
        await removeRealTempRoot(fixture.directory);
      }
    }

    const missing = await createFixture();
    try {
      await Bun.file(`${missing.directory}/host-module-loader.js`).delete();
      expect(await invokeFixture(missing)).toEqual({ invoked: false });
    } finally {
      await removeRealTempRoot(missing.directory);
    }

    const malformedManifest = await createFixture();
    try {
      await Bun.write(
        `${malformedManifest.directory}/extension-build-identity.json`,
        "{ malformed",
      );
      expect(await invokeFixture(malformedManifest)).toEqual({
        invoked: false,
      });
    } finally {
      await removeRealTempRoot(malformedManifest.directory);
    }
  });

  it("fails closed when the verified graph requests an unpinned local module", async () => {
    const fixture = await createFixture({
      implementationSource: `
        import "./mutable-runtime.js";
        ${implementationSource()}
      `,
    });
    try {
      expect(await invokeFixture(fixture)).toEqual({ invoked: false });
      expect((globalThis as Record<string, unknown>)[EVALUATED_KEY]).toBe(0);
    } finally {
      await removeRealTempRoot(fixture.directory);
    }
  });

  it("fails closed for a mutable parent-relative module", async () => {
    const fixture = await createFixture({
      implementationSource: ({ directory }) => {
        const directoryName = directory.slice(directory.lastIndexOf("/") + 1);
        return `
          import "../${directoryName}-mutable-runtime.js";
          ${implementationSource()}
        `;
      },
    });
    const directoryName = fixture.directory.slice(
      fixture.directory.lastIndexOf("/") + 1,
    );
    const mutablePath = `${fixture.directory}/../${directoryName}-mutable-runtime.js`;
    await Bun.write(
      mutablePath,
      `globalThis[${JSON.stringify(EVALUATED_KEY)}] = 99; export default {};`,
    );
    try {
      expect(await invokeFixture(fixture)).toEqual({ invoked: false });
      expect((globalThis as Record<string, unknown>)[EVALUATED_KEY]).toBe(0);
    } finally {
      await Bun.file(mutablePath).delete();
      await removeRealTempRoot(fixture.directory);
    }
  });
});
