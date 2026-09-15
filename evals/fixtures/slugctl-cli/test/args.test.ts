import { expect, test } from "bun:test";
import { parseArgs } from "../src/args.ts";

test("joins the remaining words into the text", () => {
  expect(parseArgs(["Hello", "World"]).text).toBe("Hello World");
});

test("reads the separator flag", () => {
  expect(parseArgs(["--sep", "_", "Hello"]).separator).toBe("_");
});
