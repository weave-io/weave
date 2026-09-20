/**
 * Bun test preload — runs before any test file is imported.
 *
 * Sets LOG_LEVEL=silent so that pino does not emit structured JSON logs
 * to stdout during test runs, keeping test output clean.
 *
 * Points WEAVE_GLOBAL_CONFIG_DIR at a directory with no `config.weave`, so that
 * tests which load the effective Weave config see builtins plus project config
 * only. Without this, any such test reads the developer's real
 * `~/.weave/config.weave` and the suite's result depends on the machine it runs
 * on. A test that needs global-scope config sets this variable to its own
 * fixture directory.
 */
import { join } from "node:path";

process.env.LOG_LEVEL = "silent";
process.env.WEAVE_GLOBAL_CONFIG_DIR = join(
  import.meta.dir,
  "fixtures",
  "empty-global-config",
);
