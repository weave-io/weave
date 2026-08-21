import { describe, expect, it } from "bun:test";
import { loadActionFiles, verifyActionPins } from "../verify-action-pins.js";

const PIN = "34e114876b0b11c390a56381ad16ebd13914f8d5";
const UPLOAD_ARTIFACT_PIN = "ea165f8d65b6e75b540449e92b4886f43607fa02";
const DOWNLOAD_ARTIFACT_PIN = "d3f86a106a0bac45b974a628896c90dbdf5c8093";
const CREATE_GITHUB_APP_TOKEN_PIN = "bcd2ba49218906704ab6c1aa796996da409d3eb1";
const DEPRECATED_UPLOAD_ARTIFACT_PIN =
  "0b7f8abb1508181956e8e162db84b466c27e18ce";

describe("verifyActionPins", () => {
  it.each([
    ["tag", "uses: actions/checkout@v4"],
    ["branch", "uses: actions/checkout@main"],
    ["unknown owner", `uses: evil/checkout@${PIN}`],
    ["short SHA", "uses: actions/checkout@34e1148"],
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

  it("accepts the current supported artifact and App-token pins", () => {
    expect(
      verifyActionPins({
        "fixture.yml": [
          `uses: actions/upload-artifact@${UPLOAD_ARTIFACT_PIN}`,
          `uses: actions/download-artifact@${DOWNLOAD_ARTIFACT_PIN}`,
          `uses: actions/create-github-app-token@${CREATE_GITHUB_APP_TOKEN_PIN}`,
        ].join("\n"),
      }).isOk(),
    ).toBe(true);
  });

  it("rejects an unsupported create-github-app-token commit", () => {
    expect(
      verifyActionPins({
        "fixture.yml":
          "uses: actions/create-github-app-token@0000000000000000000000000000000000000000",
      }).isErr(),
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
