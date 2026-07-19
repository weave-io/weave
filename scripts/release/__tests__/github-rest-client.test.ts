import { expect, test } from "bun:test";
import { GitHubRestClient } from "../github-client.js";

test("returns a typed malformed response for invalid GitHub JSON", async () => {
  const client = new GitHubRestClient(
    "weave-io/weave",
    "token",
    async () => new Response("not json"),
  );
  const result = await client.getWorkflowRun(1);
  expect(result.isErr()).toBe(true);
  if (result.isErr())
    expect(result.error).toMatchObject({ type: "GitHubError" });
});
