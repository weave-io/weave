// Hidden verifier for the red-ci fixture (Spec 37, 20.1). Runs in a second
// container after the agent session, with the finished workspace at
// /workspace and this directory at /verifier. Exits 0 only when every
// expectation holds, so a fix that only edits the tests does not pass.
import { daysBetween } from "/workspace/src/dates.ts";

const expectations: Array<[from: string, to: string, expected: number]> = [
  ["2026-01-01", "2026-01-31", 30],
  ["2026-03-14", "2026-03-14", 0],
  ["2026-02-27", "2026-03-01", 2],
  ["2025-12-31", "2026-01-01", 1],
];

let failures = 0;
for (const [from, to, expected] of expectations) {
  const actual = daysBetween(from, to);
  if (actual !== expected) {
    failures += 1;
    console.error(`daysBetween(${from}, ${to}) = ${actual}, expected ${expected}`);
  }
}

console.log(
  failures === 0
    ? `verifier: ${expectations.length} expectations passed`
    : `verifier: ${failures} of ${expectations.length} expectations failed`,
);
process.exit(failures === 0 ? 0 : 1);
