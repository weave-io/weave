# Weave CLI

The Weave CLI is the user-facing command surface for GitHub issue #26. It creates and validates `.weave` configuration and safely hands Weave intent to supported harness installers. It does **not** start, supervise, or drive third-party harness runtimes.

Related specs:

- [CLI spec](./specs/06-spec-cli/06-spec-cli.md)
- [Adapter boundary](./adapter-boundary.md)
- [Product vision](./product-vision.md)

## Local PATH installation

The CLI package is built with Bun and exposes a `weave` binary from `@weave/cli`.

```bash
bun install
bun run build
bun link ./packages/cli
command -v weave
weave --help
```

The local link expects the package to be built first because the package `bin` entry points at `packages/cli/dist/main.js`.

## Package runners

Once `@weave/cli` is publishable, these package-runner forms should execute the same command surface:

```bash
bunx @weave/cli --help
npx @weave/cli --help
npm exec @weave/cli -- --help
pnpm dlx @weave/cli --help
```

## Theme and accessibility

`weave --help` renders a checked-in ASCII-style line-art logo derived from the app mark at `tryweave.io/assets/weave_logo.png`, preserving the interlaced ribbon silhouette and title-case wordmark in plain terminals. It uses a cyan/blue/purple/magenta terminal theme when color is supported. Automation and accessibility fallbacks are supported through standard terminal conventions:

```bash
NO_COLOR=1 weave --help
```

When color is disabled or stdout is not a TTY, output remains readable plain text.

## `weave validate`

Use `weave validate` to validate effective, scoped, or explicit Weave config.

```bash
weave validate                 # effective config for the current project
weave validate --project       # ./.weave/config.weave
weave validate --global        # ~/.weave/config.weave
weave validate --path file.weave
weave validate --path file.weave --json
```

Human-readable success output summarizes counts only:

- agents
- categories
- workflows
- disabled entries
- log level

The CLI intentionally avoids printing full private prompt/config content in normal success output. Parse and validation failures use `file:line:column: message` formatting where the DSL pipeline provides location data.

The root `validate-config` script delegates to the CLI:

```bash
bun run validate-config
```

## `weave init`

`weave init` creates a starter Weave config directory containing `config.weave` and `prompts/`.

```bash
weave init --scope local --yes
weave init --scope global --yes
weave init --scope local --install-dir ./custom-weave --yes
```

Scope defaults:

| Scope    | Default directory      | Purpose                                                |
| -------- | ---------------------- | ------------------------------------------------------ |
| `global` | `~/.weave`             | Shared user-level defaults across projects             |
| `local`  | `<projectRoot>/.weave` | Project-level configuration for the current repository |

Safety behavior:

- Existing `config.weave` is skipped by default.
- `--force` writes `config.weave.bak` before overwriting.
- `--yes` / `-y` accepts safe defaults without prompts.
- Non-TTY invocations do not hang; use decisive flags such as `--scope` and `--yes` in scripts.
- Prompt cancellation exits cleanly with code `0`.

## Harness detection and installation

Detection is side-effect free. It may probe config paths, check readability, inspect PATH binaries, and read optional version strings through injected probes, but it must not create directories, write files, edit config, or launch harness runtimes.

Supported detection IDs:

- `opencode`
- `claude-code`
- `pi`

Installer support is intentionally separate from detection support. OpenCode has a first installer boundary; Claude Code and Pi currently report unsupported installer messages until adapter-specific installers exist.

```bash
weave init --harness opencode --yes
weave init --harness pi --yes        # explicit unsupported/undetected failure until supported
weave init --all-harnesses --yes     # install supported detected harnesses, skip unsupported ones
```

Harness writes only happen after explicit non-interactive flags or interactive confirmation.

## No runtime execution

Weave configures harnesses; harnesses run themselves. `weave run`, if encountered for transition compatibility, exits with a message directing users to `weave init` and harness-specific launch commands.

## Proof artifact security

Proof artifacts and terminal captures are committed to the repository. Before committing them:

- Replace API keys, tokens, passwords, and secrets with `[REDACTED]`.
- Use fixture home/project directories instead of real user paths.
- Avoid committing private prompts or real harness config content.
- Keep command output concise and reviewer-oriented.
