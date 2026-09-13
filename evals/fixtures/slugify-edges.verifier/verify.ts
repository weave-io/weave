// Hidden verifier for the slugify fixtures (buggy-slugify and
// plan-bash-verification; Spec 35). Runs in a second container after the
// agent session, with the finished workspace at /workspace and this
// directory at /verifier. Exits 0 only when every expectation holds.
import { slugify } from "/workspace/src/slugify.ts";

const expectations: Array<[input: string, expected: string]> = [
  ["  Hello, World!  ", "hello-world"],
  ["--Already--Dashed--", "already-dashed"],
  ["Hello World", "hello-world"],
  ["one, two & three", "one-two-three"],
  ["!!!", ""],
];

let failures = 0;
for (const [input, expected] of expectations) {
  const actual = slugify(input);
  if (actual !== expected) {
    failures += 1;
    console.error(
      `slugify(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

console.log(
  failures === 0
    ? `verifier: ${expectations.length} expectations passed`
    : `verifier: ${failures} of ${expectations.length} expectations failed`,
);
process.exit(failures === 0 ? 0 : 1);
