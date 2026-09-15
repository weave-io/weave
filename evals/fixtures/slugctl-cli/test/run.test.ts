import { expect, test } from "bun:test";
import { run, USAGE } from "../src/run.ts";

const parsed = (separator: string, text: string) => () => ({
  help: false,
  separator,
  text,
});

test("prints the slug with the parsed separator", () => {
  expect(run([], { parse: parsed("_", "Hello World") })).toBe("hello_world");
});

test("prints usage when there is no text", () => {
  expect(run([], { parse: parsed("-", "") })).toBe(USAGE);
});
