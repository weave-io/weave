#!/usr/bin/env bun
/**
 * Weave CLI executable entry point.
 *
 * This file is the `bin` target in package.json. It invokes the
 * testable CLI router and translates the returned exit code into
 * a process exit. No business logic lives here.
 */

import { defaultLogLevel } from "./log-level.js";

// Command output goes to stdout, so `weave prompt inspect --json > file` and
// other piped commands stay parseable. Engine logs go to stderr, and only
// warnings unless LOG_LEVEL asks for more (errors only for `weave models`,
// which reports its own problems; see log-level.ts). LOG_LEVEL is set before
// the engine and config loggers load, because their child loggers keep the
// level they were created with.
if (Bun.env.LOG_LEVEL === undefined)
  Bun.env.LOG_LEVEL = defaultLogLevel(Bun.argv);

const { logDestination } = await import("@weaveio/weave-engine");
if (Bun.env.WEAVE_LOG_FILE === undefined)
  logDestination.redirectTo(process.stderr);

const { run } = await import("./cli.js");
const result = await run();

result.match(
  (code) => {
    process.exitCode = code;
  },
  (_err) => {
    process.exitCode = 1;
  },
);
