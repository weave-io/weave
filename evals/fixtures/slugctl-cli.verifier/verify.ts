// Hidden verifier for the slugctl-cli fixture. Runs in a second container
// after the agent session, with the finished workspace at /workspace and this
// directory at /verifier. It runs the real CLI, not the unit tests, because
// the fixture's unit tests pass with the bug in place. Exits 0 only when
// every expectation holds.
const expectations: Array<[argv: string[], expected: string]> = [
  [["--separator", "_", "Hello World"], "hello_world"],
  [["--separator", ".", "  Release Notes: v2  "], "release.notes.v2"],
  [["Hello, World!"], "hello-world"],
];

let failures = 0;
for (const [argv, expected] of expectations) {
  const result = Bun.spawnSync(["bun", "src/slugctl.ts", ...argv], {
    cwd: "/workspace",
  });
  const actual = result.stdout.toString().trim();
  if (result.exitCode !== 0 || actual !== expected) {
    failures += 1;
    console.error(
      `slugctl ${JSON.stringify(argv)} printed ${JSON.stringify(actual)} (exit ${result.exitCode}), expected ${JSON.stringify(expected)}`,
    );
  }
}

console.log(
  failures === 0
    ? `verifier: ${expectations.length} expectations passed`
    : `verifier: ${failures} of ${expectations.length} expectations failed`,
);
process.exit(failures === 0 ? 0 : 1);
