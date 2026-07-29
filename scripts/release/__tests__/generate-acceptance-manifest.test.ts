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
    ).toEqual(["PI-POL", "PI-INS", "PI-INT", "PI-PRI", "PI-BND", "PI-OVR", "PI-QUO", "PI-SET", "PI-RCV"]);
    expect(
      manifest.requirements
        .filter((row) => row.id === "PI-ACT" || row.id === "PI-MAT" || row.id === "PI-PRM" || row.id === "PI-SKL" || row.id === "PI-MDL" || row.id === "PI-DEL" || row.id === "PI-CMD" || row.id === "PI-LIF" || row.id === "PI-CMP" || row.id === "PI-REC" || row.id === "PI-PLN" || row.id === "PI-ART" || row.id === "PI-PER" || row.id === "PI-DIA" || row.id === "PI-USG" || row.id === "PI-CAP" || row.id === "PI-ERR" || row.id === "PI-PKG" || row.id === "PI-MODE")
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
