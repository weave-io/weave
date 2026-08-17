# Verify an adapter in its real harness

Unit and integration tests prove adapter logic in isolation. They do not prove
that a packaged adapter loads, owns the expected resources, passes runtime
capability probes, or performs useful work in the harness that will run it.

**An LLM working on an adapter must be able to verify that the adapter is
properly loading and working in its real harness.** It must not declare adapter
work complete from mocks, build output, package inventory, or log-text search
alone.

## Required proof

For every adapter change, collect evidence for all five stages.

1. **Build the public artifact.** Build the package with Bun and inspect the
   files that will ship. Record the artifact digest.
2. **Install that exact artifact.** Do not validate a source checkout and then
   install different bytes. Record the installed path and prove its entry-point
   digest matches the staged artifact.
3. **Restart the harness.** Adapters load into process memory. Stop every process
   that could retain old extension code, then start a fresh process.
4. **Prove loading and readiness.** Use the harness's own inventory and health
   surfaces. Confirm the adapter loaded from the intended package identity,
   registered its resources once, and passed required capability probes.
5. **Exercise real behavior.** Run one minimal adapter-owned action through the
   real harness boundary and inspect its structured result. For delegation or
   workflows, verify the child result, settlement, cleanup, and failure code —
   not only visible prose or logs.

A successful package import is not a load proof. A successful load is not a
readiness proof. Readiness is not a behavior proof. Keep these claims separate.

## Use an isolated harness process

Other extensions can crash, replace sessions, collide with commands, or alter
models and tools. Start a fresh process with unrelated extensions disabled when
the harness supports it. Keep the target adapter enabled and use the same
runtime mode that users rely on.

Do not substitute a headless mode when the adapter requires an interactive
mode. For example, the Pi adapter treats print and RPC modes as unsupported for
normal operation. Validate it in a fresh interactive TUI, then use RPC only for
protocol-specific tests.

## Check package identity and provenance

Some adapters use harness-owned source metadata to prove command or tool
ownership. Preserve that provenance during local validation.

For Pi release verification, Weave commands must be loaded with the npm package
source `npm:@weaveio/weave-adapter-pi`. Installing the directory as a
`local/...` package changes `sourceInfo.source`; command ownership probes then
fail closed and Pi enters health-only mode. To validate an unpublished tarball,
retain the npm package registration and replace only that package's installed
bytes with the exact inspected artifact.

Interactive local development may set
`WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE=1` before Pi starts and load the
built extension through a local symlink. This bypasses only source ownership;
missing commands and numeric-suffix collisions still fail closed. Never use the
override for release verification or packaged adapter proof.

Pi packages declare `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
and `@earendil-works/pi-tui` as peers. They must resolve from the running Pi
host. A nested copy beside the adapter changes module identity, and with it
every host-version gate and capability probe.

The Pi extension loader now redirects those three specifiers to the proven host
copy, so a nested copy no longer silently wins. That redirect is deliberately
fail-open, so it is a safety net rather than permission: keep packaged installs
free of nested host copies, and when preparing a local extracted package with
Bun use `bun install --production --omit=peer`. Prove the outcome instead of
assuming it — see
[Prove one host runtime copy (Pi)](#prove-one-host-runtime-copy-pi).

## Prove one host runtime copy (Pi)

A successful import proves nothing about module identity. Prove it with a real
process:

```bash
bun run verify:pi-host-singleton
```

The script builds `packages/adapters/pi/dist/extension.js`, records its digest,
resolves the host CLI from `PI_HOST_CLI` or `PATH`, and runs two controls
against that host:

- **Positive control.** It starts `pi --mode rpc` with the built extension and
  `WEAVE_PI_HOST_MODULE_PROOF=1`, then requires the proof line's host version to
  match the host `package.json`, every specifier to load from under the host
  root, and the live process's OS mappings to contain no `@earendil-works` file
  under the checkout's `node_modules`.
- **Negative control.** It repeats the run with
  `WEAVE_PI_DISABLE_HOST_MODULE_REDIRECT=1` and requires those same assertions
  to fail. A negative control that stays clean fails the script, because a
  detector that cannot see the duplicate proves nothing about the positive run.

The script prints `PASS` only when the positive run is clean and the negative
control is detected. Without an available host it exits non-zero unless
`--allow-skip` is passed, and a skip is a missing proof rather than a pass. It
spawns a real Pi process, so it is not part of `bun test`. RPC mode proves
module loading only: readiness and behavior still need the five stages above in
a fresh interactive TUI.

## Minimum adapter checks

### Pi

- `pi list` shows the expected npm package identity and no load error.
- `bun run verify:pi-host-singleton` prints `PASS` for the built artifact.
- Start a fresh interactive TUI after installation.
- `/weave:health` reports `Weave adapter mode: ready`, `host runtime:
  single-copy`, and required capabilities at their declared readiness.
- `/weave:status` reports trusted interactive mode and `health-only: false`.
- Run one ordinary delegation and one direct workflow-step completion when the
  change touches child transport or settlement.
- Verify no execution leases or child processes remain after completion.

### OpenCode

- Start a fresh OpenCode process with the packaged plugin.
- Confirm the plugin registers the expected commands, agents, models, and tools
  exactly once.
- Exercise one materialized agent or command through OpenCode's real plugin
  boundary and inspect the structured result.

### Claude Code

- Install the generated adapter artifacts into a clean fixture or user config.
- Start a fresh Claude Code process and confirm the generated resources are
  discovered from the intended paths.
- Exercise one generated command or agent and verify the harness applies its
  prompt, model, and permission mapping.

## Failure evidence

When verification fails, record:

- artifact and installed entry-point digests;
- installed package source and path;
- harness version, mode, trust, and process start time;
- structured health/capability output;
- exact structured adapter failure code;
- whether a fresh isolated process reproduces the problem.

Do not use log-text search as the only verdict. Logs support diagnosis; typed
results and harness state decide success.

## Completion rule

An adapter task is complete only when isolated tests pass **and** an LLM can
reproduce the install, loading, readiness, and real behavior checks above. If a
live harness cannot be run, report the missing proof as a blocker rather than
claiming the adapter works.
