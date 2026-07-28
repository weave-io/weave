import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PackagePolicyValidator } from "../package-policy.js";
import { BunPackageCommandRunner, PublicPackagePackager } from "../packager.js";
import { TarInspector } from "../tar-inspector.js";

/**
 * Packed-artifact proof for the pi adapter's public package/build/pack
 * policy (Pi adapter contract package and public surface, host compatibility,
 * packed tarball, acceptance manifest PI-PKG).
 *
 * Runs `npm pack --ignore-scripts` on the staged, publicly-approved files
 * only (no lifecycle scripts, no network). Never starts Pi.
 */
describe("pi adapter packed artifact (Pi adapter contract, PI-PKG)", () => {
  it("packs @weaveio/weave-adapter-pi with an inventory-clean, policy-valid tarball", async () => {
    const root = join(".release", `pi-pkg-packed-${randomUUID()}`);
    const packager = new PublicPackagePackager(
      new BunPackageCommandRunner(),
      new PackagePolicyValidator(),
    );

    try {
      const packed = await packager.pack(
        "@weaveio/weave-adapter-pi",
        root,
        join(root, "out"),
      );
      expect(packed.isOk()).toBe(true);
      if (!packed.isOk()) return;

      // PublicPackagePackager.pack() already ran PackagePolicyValidator
      // internally (lifecycle-script rejection, private-dependency
      // rejection, exact inventory/mode checks, undeclared-import
      // checks) - re-inspect the same bytes here as the durable,
      // independently re-checkable packed proof.
      const bytes = await Bun.file(packed.value).bytes();
      const inspected = new TarInspector().inspect(bytes);
      expect(inspected.isOk()).toBe(true);
      if (!inspected.isOk()) return;

      const paths = inspected.value.map((entry) => entry.path).sort();
      expect(paths).toEqual(
        [
          "package/README.md",
          "package/dist/extension.d.ts",
          "package/dist/extension.js",
          "package/dist/index.d.ts",
          "package/dist/index.js",
          "package/package.json",
        ].sort(),
      );

      const manifestEntry = inspected.value.find(
        (entry) => entry.path === "package/package.json",
      );
      expect(manifestEntry).toBeDefined();
      const manifest = JSON.parse(
        new TextDecoder().decode(manifestEntry?.contents),
      ) as Record<string, unknown>;

      expect(manifest.name).toBe("@weaveio/weave-adapter-pi");
      expect(manifest.scripts).toBeUndefined();
      expect(manifest.devDependencies).toBeUndefined();

      // preserved custom pi manifest field (Pi adapter contract)
      expect(manifest.pi).toEqual({ extensions: ["./dist/extension.js"] });

      // preserved, unmodified exact host peer range (Pi adapter contract)
      expect(manifest.peerDependencies).toEqual({
        "@earendil-works/pi-coding-agent": ">=0.81.1",
        "@earendil-works/pi-ai": "*",
        "@earendil-works/pi-tui": "*",
      });

      // preserved runtime dependencies actually referenced by the
      // built, bundled output (not devDependencies, not private
      // @weaveio/* workspace packages - those are bundled inline)
      expect(manifest.dependencies).toEqual({
        kysely: "^0.27.5",
        mustache: "^4.2.0",
        neverthrow: "^8.2.0",
        pino: "^9.6.0",
        typebox: "1.1.38",
        zod: "^4.4.3",
      });
    } finally {
      await Bun.spawn(["rm", "-rf", root]).exited;
    }
  }, 60_000);
});
