import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import {
  HOST_PACKAGE_NAME,
  HOST_VERSION_FLOOR,
  isSupportedHostVersion,
} from "../../../packages/adapters/pi/src/host-compatibility.js";
import { PI_HOST_COMPATIBILITY_MATRIX } from "../../../packages/adapters/pi/src/host-compatibility-matrix.js";
import {
  AcceptanceManifestSchema,
  HostSchema,
} from "../acceptance-manifest.js";
import { isJsonObject, isJsonString, parseJsonValue } from "../json.js";
import { PackagePolicyValidator } from "../package-policy.js";
import { BunPackageCommandRunner, PublicPackagePackager } from "../packager.js";
import { TarInspector } from "../tar-inspector.js";

/**
 * Clean-room fake-host consumer proof (Pi adapter contract, PI-PKG).
 *
 * Materializes the packed `@weaveio/weave-adapter-pi` tarball into a fully
 * isolated directory (never the developer's project) alongside a local
 * *fake* `@earendil-works/pi-coding-agent` peer pinned to the current exact
 * release-tested version, plus fake `pi-ai`/`pi-tui` peers and
 * this workspace's own already-resolved real runtime dependencies. No
 * `npm install`, no registry, no
 * network call of any kind, and the extension's default factory is only
 * inspected - never invoked - so Pi is never started.
 */
const EXACT_TESTED_HOST_VERSION =
  PI_HOST_COMPATIBILITY_MATRIX.exactTestedVersion;

const ACCEPTANCE_FIXTURE_MANIFEST = join(
  ".",
  "scripts/release/pi-acceptance/acceptance-manifest.json",
);
const ACCEPTANCE_FIXTURE_SMOKE = join(
  ".",
  "scripts/release/pi-acceptance/smoke-checklist.md",
);

const HistoricalAcceptanceManifestSchema = AcceptanceManifestSchema.extend({
  host: HostSchema.extend({
    exactTestedVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  }),
});

/**
 * Minimal stub bodies for the handful of runtime *value* imports the
 * compiled pi adapter bundle actually references from each Pi-provided
 * peer package (editor, tool-component, tool-definition, enum, text, Markdown,
 * key-match, and display-width exports). The list is verified directly against
 * packages/adapters/pi/dist/{index,extension}.js). These exist only so a
 * clean-room `import()` can link without starting Pi or touching the
 * network; they carry no adapter behavior of their own.
 */
interface FakeHostPackage {
  readonly version: string;
  readonly source: string;
}

const FAKE_HOST_PACKAGES = {
  "@earendil-works/pi-coding-agent": {
    version: EXACT_TESTED_HOST_VERSION,
    source: `export const VERSION = "${EXACT_TESTED_HOST_VERSION}";
export class CustomEditor {}
export class ToolExecutionComponent {}
export class UserMessageComponent {}
export function getMarkdownTheme() { return {}; }
export function getSelectListTheme() { return { selectedPrefix: (text) => text, selectedText: (text) => text, description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text }; }
export function createBashToolDefinition() {}
export function createEditToolDefinition() {}
export function createFindToolDefinition() {}
export function createGrepToolDefinition() {}
export function createLsToolDefinition() {}
export function createReadToolDefinition() {}
export function createWriteToolDefinition() {}
`,
  },
  "@earendil-works/pi-ai": {
    version: EXACT_TESTED_HOST_VERSION,
    source: "export function StringEnum(values) { return values; }\n",
  },
  "@earendil-works/pi-tui": {
    version: EXACT_TESTED_HOST_VERSION,
    source:
      "export function matchesKey() { return false; }\nexport function isKeyRelease() { return false; }\nexport function truncateToWidth(text) { return text; }\nexport function visibleWidth(text) { return text.length; }\nexport function getKeybindings() { return { getResolvedBindings: () => ({}) }; }\nexport class Markdown {}\nexport class Text {}\n",
  },
} satisfies Readonly<Record<string, FakeHostPackage>>;

/**
 * Real, already-resolved runtime dependencies the packed artifact declares
 * (and keeps external rather than bundled). Copied byte-for-byte from this
 * workspace's own Bun-managed store so the clean room never touches
 * npm/network, independent of any single package's own linked subset.
 */
const REAL_RUNTIME_DEPENDENCY_STORES = [
  "kysely@0.27.6",
  "mustache@4.2.0",
  "neverthrow@8.2.0",
  "pino@9.14.0",
  "typebox@1.1.38",
  "zod@4.4.3",
] as const;

class IsolatedFakeHostConsumer {
  private constructor(readonly directory: string) {}

  static async create(): Promise<IsolatedFakeHostConsumer> {
    const proc = Bun.spawn(["mktemp", "-d"], { stdout: "pipe" });
    const directory = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return new IsolatedFakeHostConsumer(directory);
  }

  async cleanup(): Promise<void> {
    await Bun.spawn(["rm", "-rf", this.directory]).exited;
  }
}

describe("pi adapter clean-room fake-host consumer (Pi adapter contract, PI-PKG)", () => {
  it(`installs the packed tarball against a local fake ${HOST_PACKAGE_NAME}@${EXACT_TESTED_HOST_VERSION} host, without network or starting Pi`, async () => {
    // the exact host version this test binds to must fall inside the
    // adapter's own declared, enforced compatibility range
    expect(isSupportedHostVersion(EXACT_TESTED_HOST_VERSION)).toBe(true);

    const root = join(".release", `pi-fake-host-${crypto.randomUUID()}`);
    const packager = new PublicPackagePackager(
      new BunPackageCommandRunner(),
      new PackagePolicyValidator(),
    );

    const consumer = await IsolatedFakeHostConsumer.create();
    try {
      const packed = await packager.pack(
        "@weaveio/weave-adapter-pi",
        root,
        join(root, "out"),
      );
      expect(packed.isOk()).toBe(true);
      if (!packed.isOk()) return;

      const bytes = await Bun.file(packed.value).bytes();
      const inspected = new TarInspector().inspect(bytes);
      // The packed/generated artifact is the privacy boundary: private
      // prompt, task, intervention, tool, image, RPC, path, and secret data
      // must not be embedded in any shipped entry.
      const privateCanaries = [
        "PRIVATE-PROMPT-CANARY",
        "PRIVATE-TASK-CANARY",
        "PRIVATE-INTERVENTION-CANARY",
        "PRIVATE-TOOL-ARGS-CANARY",
        "PRIVATE-IMAGE-CANARY",
        "PRIVATE-RPC-BODY-CANARY",
        "PRIVATE-PATH-CANARY",
        "PRIVATE-SECRET-CANARY",
      ];
      for (const canary of privateCanaries) {
        expect(new TextDecoder().decode(bytes)).not.toContain(canary);
      }
      expect(inspected.isOk()).toBe(true);
      if (!inspected.isOk()) return;

      // Real release evidence artifacts from checked-in fixtures, loaded and scanned
      // exactly as CI expects them to prove the adapter’s non-PI evidence.
      const manifestText = await Bun.file(ACCEPTANCE_FIXTURE_MANIFEST).text();
      const parsedManifest = parseJsonValue(manifestText);
      if (parsedManifest.isErr()) throw new Error(parsedManifest.error.message);
      const manifestResult = HistoricalAcceptanceManifestSchema.safeParse(
        parsedManifest.value,
      );
      if (!manifestResult.success)
        throw new Error(JSON.stringify(manifestResult.error.issues));
      const manifestJson = manifestResult.data;
      expect(manifestJson.schemaVersion).toBe(1);
      expect(manifestJson.requirements).toHaveLength(28);
      expect(manifestJson.host.package).toBe(HOST_PACKAGE_NAME);
      expect(manifestJson.host.floorVersion.length).toBeGreaterThan(0);
      expect(manifestJson.host.supportedRange).toContain(">=0.81.1");
      expect(isSupportedHostVersion(manifestJson.host.exactTestedVersion)).toBe(
        true,
      );

      const smokeText = await Bun.file(ACCEPTANCE_FIXTURE_SMOKE).text();
      expect(smokeText).toContain("S001");
      expect(smokeText).toContain("Smoke Checklist");

      const manifestEntry = inspected.value.find(
        (entry) => entry.path === "package/package.json",
      );
      if (manifestEntry === undefined)
        throw new Error("packed manifest entry is missing");
      const parsedPackageManifest = parseJsonValue(
        new TextDecoder().decode(manifestEntry.contents),
      );
      if (parsedPackageManifest.isErr())
        throw new Error(parsedPackageManifest.error.message);
      if (!isJsonObject(parsedPackageManifest.value))
        throw new Error("packed manifest is not an object");
      const peerDependencies = parsedPackageManifest.value.peerDependencies;
      if (!isJsonObject(peerDependencies))
        throw new Error("packed manifest has no peerDependencies object");
      const hostRange = peerDependencies[HOST_PACKAGE_NAME];
      if (!isJsonString(hostRange))
        throw new Error("packed manifest has no host peer range");
      expect(hostRange).toBe(`>=${HOST_VERSION_FLOOR}`);

      // materialize the packed artifact - no npm install, no network
      const packageDir = join(
        consumer.directory,
        "node_modules/@weaveio/weave-adapter-pi",
      );
      for (const entry of inspected.value) {
        const relative = entry.path.replace(/^package\//, "");
        await Bun.write(join(packageDir, relative), entry.contents);
      }

      // materialize local fake host peers at the exact tested version
      for (const [name, config] of Object.entries(FAKE_HOST_PACKAGES)) {
        const dir = join(consumer.directory, "node_modules", name);
        await Bun.write(
          join(dir, "package.json"),
          JSON.stringify(
            { name, version: config.version, type: "module", main: "index.js" },
            null,
            2,
          ),
        );
        await Bun.write(join(dir, "index.js"), config.source);
      }

      // Materialize each dependency store's complete node_modules set. Pino
      // has transitive runtime dependencies, so copying only its leaf package
      // would make this clean-room proof weaker than a real package install.
      for (const store of REAL_RUNTIME_DEPENDENCY_STORES) {
        const sourceDir = `${join(
          process.cwd(),
          "node_modules/.bun",
          store,
          "node_modules",
        )}/.`;
        const targetDir = join(consumer.directory, "node_modules");
        const copy = Bun.spawn(["cp", "-RL", sourceDir, targetDir]);
        expect(await copy.exited).toBe(0);
      }

      const extensionEntry = inspected.value.find(
        (entry) => entry.path === "package/dist/extension.js",
      );
      if (extensionEntry === undefined)
        throw new Error("packed extension entry is missing");
      expect(new TextDecoder().decode(extensionEntry.contents)).not.toContain(
        "import.meta.require",
      );

      // clean-room proof: both packed entry points load in complete
      // isolation, without npm/network - and the extension's default
      // factory is only type/shape-inspected, never invoked, so Pi is
      // never started
      interface PackedIndexModule {
        readonly ADAPTER_PACKAGE_IDENTITY?: string;
      }
      const indexModule: PackedIndexModule = await import(
        new URL(`file://${join(packageDir, "dist/index.js")}`).href
      );
      expect(indexModule.ADAPTER_PACKAGE_IDENTITY).toBe(
        "@weaveio/weave-adapter-pi",
      );

      interface PackedExtensionModule {
        readonly default?: unknown;
      }
      const extensionModule: PackedExtensionModule = await import(
        new URL(`file://${join(packageDir, "dist/extension.js")}`).href
      );
      expect(z.function().safeParse(extensionModule.default).success).toBe(
        true,
      );
    } finally {
      await consumer.cleanup();
      await Bun.spawn(["rm", "-rf", root]).exited;
    }
  }, 120_000);
});
