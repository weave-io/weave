#!/usr/bin/env bun
/**
 * Weave CLI executable entry point.
 *
 * This file is the `bin` target in package.json. It invokes the
 * testable CLI router and translates the returned exit code into
 * a process exit. No business logic lives here.
 */

import { run } from "./cli.js";

const result = await run();

result.match(
  (code) => {
    process.exitCode = code;
  },
  (_err) => {
    process.exitCode = 1;
  },
);
