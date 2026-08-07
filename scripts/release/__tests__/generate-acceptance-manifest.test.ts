import { describe, expect, it } from "bun:test";
import { generateAcceptanceManifest } from "../generate-acceptance-manifest.js";

/**
 * Proof that the acceptance-manifest generator produces a real,
 * schema-valid, evidence-verified manifest from the current working tree -
 * a genuine local pack and a genuine git HEAD, never fabricated digests.
 * Never writes into the real repository tree; only reads it and writes to a
 * `.release/` scratch directory it cleans up itself.
 */
describe("generateAcceptanceManifest", () => {
  it("produces a manifest whose artifactBinding is a real computed digest and whose evidence verifies clean", async () => {
    const root = new URL("../../..", import.meta.url).pathname.replace(
      /\/$/,
      "",
    );
    const result = await generateAcceptanceManifest(root);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const { manifest, evidenceOk } = result.value;

    expect(evidenceOk).toBe(true);
    expect(manifest.artifactBinding.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.artifactBinding.subjectSha).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.requirements).toHaveLength(28);
    expect(
      manifest.requirements
        .filter((row) => row.result === "pending")
        .map((row) => row.id),
    ).toEqual([
      "PI-POL",
      "PI-INS",
      "PI-PRI",
      "PI-BND",
      "PI-OVR",
      "PI-SET",
      "PI-RCV",
    ]);
    expect(
      manifest.requirements
        .filter((row) =>
          (
            [
              "PI-ACT",
              "PI-MAT",
              "PI-PRM",
              "PI-SKL",
              "PI-MDL",
              "PI-DEL",
              "PI-CMD",
              "PI-LIF",
              "PI-CMP",
              "PI-REC",
              "PI-PLN",
              "PI-ART",
              "PI-PER",
              "PI-DIA",
              "PI-USG",
              "PI-CAP",
              "PI-ERR",
              "PI-PKG",
              "PI-MODE",
              "PI-INT",
              "PI-QUO",
            ] as readonly string[]
          ).includes(row.id),
        )
        .every((row) => row.result === "pass"),
    ).toBe(true);
  }, 60_000);
});

describe("generateAcceptanceManifest error path", () => {
  it("returns a typed PackageJsonReadFailed error instead of throwing for a root with no such package", async () => {
    const bogusRoot = `/tmp/weave-generate-acceptance-manifest-test-${crypto.randomUUID()}`;

    const result = await generateAcceptanceManifest(bogusRoot);

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("PackageJsonReadFailed");
  });
});
