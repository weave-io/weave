# Empty global config

This directory deliberately contains no `config.weave`.

[`scripts/test-setup.ts`](../../test-setup.ts) points `WEAVE_GLOBAL_CONFIG_DIR`
here so that no test reads the developer's real `~/.weave/config.weave`. Without
it, any test that loads the effective config picks up whatever that developer
happens to have configured, and the suite passes or fails depending on the
machine it runs on — including failing outright when their global config is
merely out of date.

Do not add a `config.weave` here. A test that needs global-scope config should
point `WEAVE_GLOBAL_CONFIG_DIR` at its own fixture directory instead.
