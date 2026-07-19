import { describe, expect, it } from "bun:test";
import { loadActionFiles, verifyActionPins } from "../verify-action-pins.js";

const PIN = "34e114876b0b11c390a56381ad16ebd13914f8d5";

describe("verifyActionPins", () => {
  it.each([
    ["tag", "uses: actions/checkout@v4"],
    ["branch", "uses: actions/checkout@main"],
    ["unknown owner", `uses: evil/checkout@${PIN}`],
    ["short SHA", "uses: actions/checkout@34e1148"],
  ])("rejects a %s reference", (_name, uses) => {
    expect(verifyActionPins({ "fixture.yml": uses }).isErr()).toBe(true);
  });

  it("accepts local actions and approved full-SHA actions", () => {
    expect(
      verifyActionPins({
        "fixture.yml": `uses: actions/checkout@${PIN}\nuses: ./local-action`,
      }).isOk(),
    ).toBe(true);
  });

  it("accepts every repository workflow and composite action", async () => {
    expect(verifyActionPins(await loadActionFiles()).isOk()).toBe(true);
  });

  it("does not introduce custom attestation or SBOM actions", async () => {
    const workflows = await loadActionFiles();
    expect(Object.values(workflows).join("\n")).not.toMatch(
      /uses:\s*[^\n]*(attest|sbom)/i,
    );
  });
});
