import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";
import type { CommandRunner } from "../command-runner.js";
import { NpmCliRegistryClient } from "../npm-registry-client.js";

describe("NpmCliRegistryClient", () => {
  it("returns typed malformed responses", async () => {
    const client = new NpmCliRegistryClient(runner("not json"));
    for (const result of [
      await client.listVersions("@weaveio/weave-cli"),
      await client.viewDistTags("@weaveio/weave-cli"),
      await client.distTagLs("@weaveio/weave-cli"),
    ]) {
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.type).toBe("RegistryError");
    }
  });
});

function runner(stdout: string): CommandRunner {
  return { run: () => okAsync({ exitCode: 0, stdout, stderr: "" }) };
}
