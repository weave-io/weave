# Task 01 Proofs - CLI package, executable, and branded help

## Task Summary

This task establishes `@weave/cli`, builds the `weave` executable, and proves the top-level command surface renders branded help, version output, color fallback, package-runner documentation, and workspace integration.

## What This Task Proves

- `weave` is available on `PATH` after the documented local build/link-style flow.
- `weave --help` exits successfully, lists `init` and `validate`, and renders the ASCII Weave banner.
- `NO_COLOR=1 weave --help` is readable without ANSI styling.
- `weave --version` is wired to CLI package metadata.
- Routing/theme tests, build, and typecheck all pass.

## Evidence Summary

The CLI binary was symlinked from the built package into a temporary proof PATH. The command surface works from that PATH, the package-runner commands are documented, and the task-specific tests plus build/typecheck pass.

## Artifact: PATH-installed command and help output

**What it proves:** The built CLI can be invoked as `weave` and exposes the expected help surface.

**Why it matters:** Later `init`, `validate`, and installer workflows rely on the same executable entry point.

**Command:** `command -v weave && weave --help && NO_COLOR=1 weave --help && weave --version`

**Result summary:** `command -v weave` resolves to the temporary proof binary, help includes the ASCII logo plus `init` and `validate`, `NO_COLOR=1` produces plain text, and version prints `0.0.1`.

```text
## command -v weave
[repo]/tmp/weave-proof-bin/weave

## weave --help

   ╭─╮         ╭─╮   
  ╭╯ ╰╮  ╭─╮ ╭╯ ╰╮  
  ╰╮ ╭╰──╯ ╰─╯╮ ╭╯  
   ╰╮╰╮  ╭─╮ ╭╯╭╯   
    ╰╮╰──╯ ╰─╯╭╯    
     ╰╮ ╭─╮  ╭╯     
      ╰─╯ ╰──╯      

  {weave} v0.0.1

  Weave — structure your AI coding workflow

  USAGE

    $ weave <command> [options]

  COMMANDS

    init        Create Weave config and install into harnesses
    validate    Validate .weave configuration files

  OPTIONS

    --help             Show this help message
    --version          Show CLI version
    --scope global|local Choose init scope
    --install-dir <dir> Choose init config directory
    --path <file>       Validate an explicit .weave file
    --json             Emit machine-readable validation output
    --yes, -y          Accept safe non-interactive defaults

  EXAMPLES

    $ weave init                        # Interactive setup wizard
    $ weave init --scope global --yes   # Non-interactive global setup
    $ weave validate --project          # Validate project config
    $ weave validate --path my.weave    # Validate a specific file


## NO_COLOR=1 weave --help

   ╭─╮         ╭─╮   
  ╭╯ ╰╮  ╭─╮ ╭╯ ╰╮  
  ╰╮ ╭╰──╯ ╰─╯╮ ╭╯  
   ╰╮╰╮  ╭─╮ ╭╯╭╯   
    ╰╮╰──╯ ╰─╯╭╯    
     ╰╮ ╭─╮  ╭╯     
      ╰─╯ ╰──╯      

  {weave} v0.0.1

  Weave — structure your AI coding workflow

  USAGE

    $ weave <command> [options]

  COMMANDS

    init        Create Weave config and install into harnesses
    validate    Validate .weave configuration files

  OPTIONS

    --help             Show this help message
    --version          Show CLI version
    --scope global|local Choose init scope
    --install-dir <dir> Choose init config directory
    --path <file>       Validate an explicit .weave file
    --json             Emit machine-readable validation output
    --yes, -y          Accept safe non-interactive defaults

  EXAMPLES

    $ weave init                        # Interactive setup wizard
    $ weave init --scope global --yes   # Non-interactive global setup
    $ weave validate --project          # Validate project config
    $ weave validate --path my.weave    # Validate a specific file


## weave --version
0.0.1

## package runner docs
README.md:80:bunx @weave/cli --help
README.md:81:npx @weave/cli --help
README.md:82:npm exec @weave/cli -- --help
README.md:83:pnpm dlx @weave/cli --help
docs/cli.md:30:bunx @weave/cli --help
docs/cli.md:31:npx @weave/cli --help
docs/cli.md:32:npm exec @weave/cli -- --help
docs/cli.md:33:pnpm dlx @weave/cli --help

## targeted tests
bun test v1.3.13 (bf2e2cec)

packages/cli/src/__tests__/routing.test.ts:
(pass) CLI routing > --help exits 0 and lists init and validate [1.20ms]
(pass) CLI routing > -h is an alias for --help [0.09ms]
(pass) CLI routing > no arguments shows help [0.46ms]
(pass) CLI routing > --version exits 0 and prints version string [1.89ms]
(pass) CLI routing > -V is an alias for --version [0.15ms]
(pass) CLI routing > unknown command exits 1 with error message [0.08ms]
(pass) CLI routing > run command exits 1 with product-vision message [0.07ms]
(pass) CLI routing > --help overrides a command [0.09ms]
(pass) CLI routing > help output includes EXAMPLES section [0.04ms]

packages/cli/src/__tests__/theme.test.ts:
(pass) theme colors > returns identity functions when color is disabled [0.29ms]
(pass) theme colors > returns ANSI-wrapped strings when color is enabled [0.09ms]
(pass) theme colors > bold composites apply both bold and color [0.24ms]
(pass) ASCII logo > has multiple lines [0.13ms]
(pass) ASCII logo > LOGO_WIDTH matches the widest line [0.03ms]
(pass) ASCII logo > renderLogo returns same number of lines as PLAIN_LOGO_LINES [0.03ms]
(pass) ASCII logo > renderLogo with color produces ANSI sequences
```

## Artifact: Task-specific tests and workspace gates

**What it proves:** Routing, theme rendering, build, and typecheck are automated and passing.

**Why it matters:** The command router and presentation layer remain testable without invoking real harnesses.

```text
(pass) ASCII logo > renderLogo without color produces plain text [0.16ms]
(pass) banner and help rendering > renderBanner includes logo lines and version [0.10ms]
(pass) banner and help rendering > renderHelp includes banner, commands, and examples [0.04ms]
(pass) banner and help rendering > renderHelp with NO_COLOR produces no ANSI escapes [0.03ms]
(pass) banner and help rendering > renderHelp with color produces ANSI escapes [0.05ms]
(pass) banner and help rendering > getVersion returns a semver-like string [0.08ms]
(pass) banner and help rendering > renderVersion returns the version string [0.01ms]

 23 pass
 0 fail
 65 expect() calls
Ran 23 tests across 2 files. [32.00ms]

## build
$ bun run --filter '@weave/core' build && bun run --filter '@weave/engine' --filter '@weave/config' build && bun run --filter '@weave/cli' build && bun run --filter '@weave/adapter-*' build
@weave/core build: Bundled 88 modules in 25ms
@weave/core build: 
@weave/core build:   index.js  0.58 MB  (entry point)
@weave/core build: 
@weave/core build: Exited with code 0
@weave/config build: Bundled 125 modules in 13ms
@weave/config build: 
@weave/config build:   index.js  0.72 MB  (entry point)
@weave/config build: 
@weave/engine build: Bundled 115 modules in 14ms
@weave/engine build: 
@weave/engine build:   index.js  0.69 MB  (entry point)
@weave/engine build: 
@weave/config build: Exited with code 0
@weave/engine build: Exited with code 0
@weave/cli build: Bundled 148 modules in 18ms
@weave/cli build: 
@weave/cli build:   index.js  0.83 MB  (entry point)
@weave/cli build:   main.js   0.83 MB  (entry point)
@weave/cli build: 
@weave/cli build: Exited with code 0
@weave/adapter-opencode build: Bundled 1 module in 54ms
@weave/adapter-opencode build: 
@weave/adapter-opencode build:   index.js  83 bytes  (entry point)
@weave/adapter-opencode build: 
@weave/adapter-opencode build: Exited with code 0

## typecheck
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
@weave/cli typecheck: Exited with code 0
```

## Reviewer Conclusion

The CLI package is integrated into the workspace, exposes a working `weave` executable, and provides branded, accessible top-level command output.
