import { describe, expect, it } from "bun:test";
import { loadActionFiles, verifyActionPins } from "../verify-action-pins.js";

const PIN = "34e114876b0b11c390a56381ad16ebd13914f8d5";
const UPLOAD_ARTIFACT_PIN = "ea165f8d65b6e75b540449e92b4886f43607fa02";
const DOWNLOAD_ARTIFACT_PIN = "d3f86a106a0bac45b974a628896c90dbdf5c8093";
const DEPRECATED_UPLOAD_ARTIFACT_PIN =
  "0b7f8abb1508181956e8e162db84b466c27e18ce";

describe("verifyActionPins", () => {
  it.each([
    ["tag", "uses: actions/checkout@v4"],
    ["branch", "uses: actions/checkout@main"],
    ["unknown owner", `uses: evil/checkout@${PIN}`],
    ["short SHA", "uses: actions/checkout@34e1148"],
    [
      "deprecated upload-artifact SHA",
      `uses: actions/upload-artifact@${DEPRECATED_UPLOAD_ARTIFACT_PIN}`,
    ],
    ["deprecated upload-artifact major", "uses: actions/upload-artifact@v3"],
    [
      "deprecated download-artifact major",
      "uses: actions/download-artifact@v3",
    ],
  ])("rejects a %s reference", (_name, uses) => {
    expect(verifyActionPins({ "fixture.yml": uses }).isErr()).toBe(true);
  });

  it.each([
    ["list item", "- uses: evil/action@main"],
    ["quoted value", 'uses: "actions/checkout@main"'],
    ["continuation line", `uses:\n  actions/checkout@${PIN}`],
    ["unresolved inline form", `step: { uses: "actions/checkout@${PIN}" }`],
  ])("fails closed for a %s reference", (_name, uses) => {
    expect(verifyActionPins({ "fixture.yml": uses }).isErr()).toBe(true);
  });

  it("accepts local actions and approved full-SHA actions", () => {
    expect(
      verifyActionPins({
        "fixture.yml": `uses: actions/checkout@${PIN}\nuses: ./local-action`,
      }).isOk(),
    ).toBe(true);
  });

  it("accepts the current supported artifact-action pins", () => {
    expect(
      verifyActionPins({
        "fixture.yml": [
          `uses: actions/upload-artifact@${UPLOAD_ARTIFACT_PIN}`,
          `uses: actions/download-artifact@${DOWNLOAD_ARTIFACT_PIN}`,
        ].join("\n"),
      }).isOk(),
    ).toBe(true);
  });

  it("accepts quoted pinned actions and ignores commented-out references", () => {
    expect(
      verifyActionPins({
        "fixture.yml": `uses: 'actions/checkout@${PIN}'\n# - uses: evil/action@main`,
      }).isOk(),
    ).toBe(true);
  });

  it("rejects a workflow with no action references", () => {
    expect(
      verifyActionPins({ "fixture.yml": "name: check\non: push" }).isErr(),
    ).toBe(true);
  });

  it("accepts every repository workflow and composite action", async () => {
    expect(verifyActionPins(await loadActionFiles()).isOk()).toBe(true);
  });

  it("does not introduce custom attestation or SBOM actions", async () => {
    const workflows = await loadActionFiles();
    expect(Object.values(workflows).join("\n")).not.toMatch(
      /uses:[ \t]+(?![ \t]*actions\/attest-build-provenance@)[^\n]*(attest|sbom)/i,
    );
  });
});
