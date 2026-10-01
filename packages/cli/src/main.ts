#!/usr/bin/env bun
/**
 * Weave CLI executable entry point.
 *
 * This file is the `bin` target in package.json. It invokes the
 * testable CLI router and translates the returned exit code into
 * a process exit. No business logic lives here.
 */

import { logDestination, logger } from "@weaveio/weave-engine";
import { run } from "./cli.js";

// Command output goes to stdout, so `weave prompt inspect --json > file` and
// other piped commands stay parseable. Engine logs go to stderr, and only
// warnings unless LOG_LEVEL asks for more.
if (Bun.env.WEAVE_LOG_FILE === undefined)
  logDestination.redirectTo(process.stderr);
if (Bun.env.LOG_LEVEL === undefined) {
  // Commands load `@weaveio/weave-config` lazily; its logger reads LOG_LEVEL
  // when it is first imported.
  Bun.env.LOG_LEVEL = "warn";
  logger.level = "warn";
}

const result = await run();

result.match(
  (code) => {
    process.exitCode = code;
  },
  (_err) => {
    process.exitCode = 1;
  },
);
