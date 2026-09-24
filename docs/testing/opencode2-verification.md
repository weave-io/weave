# Verify the OpenCode 2 Adapter

Use this guide to verify the built OpenCode 2 adapter without changing a
developer's OpenCode installation or shared service.

**Audience:** Weave maintainers preparing an OpenCode 2 core release.

**Related:** [OpenCode 2 adapter](../adapters/opencode2-core.md) · [runtime proof
record](../artifacts/opencode2-core-runtime-proof.md) · [UI proof
record](../artifacts/opencode2-core-ui-proof.md)

The [separate-package merge proof](../artifacts/opencode2-package-merge-proof.md)
records the beta-19151 packaged runtime and V1 fallback checks. The older
records above describe the pre-merge layout and are not current package hashes.

The [start-command diagnostic record](../artifacts/opencode2-start-command-proof.md)
records the recovered picker implementation's runtime checks and the remaining
interactive verification limit.

The [shared-contract recovery record](../artifacts/opencode2-shared-contract-recovery.md)
records the string-trigger backport and live OpenCode 2.0.2 agent registration.

## Requirements

The retained Podman verifier uses an explicit `proof/proof-model` catalog
entry and a local deterministic HTTP provider. Its Weave fixtures declare that
model for every builtin. They must not rely on primary-agent model fallback,
the host's changing free-model catalog, or remote credentials. These fixtures
exercise the native `./server` implementation, not the compatibility facade.

Provider configuration can activate after Weave's setup returns. An initial
agent-list response can therefore contain only host builtins. The embedded
check waits up to ten seconds for an owned Loom. The CLI wrapper starts a
bounded observation, returns from setup to let host activation finish, and
awaits that observation before cleanup. It requires owned Loom and Tapestry;
missing agents still fail the checks. Waiting inside setup would prevent the
host from completing the activation that the check needs to observe.

- Run from a clean Weave worktree.
- Use Bun.
- Keep the exact supported host at `2.0.16` (`@opencode/cli`).
- Do not stop or upgrade the user's shared OpenCode service.
- Put all live proof data under the approved temporary root used by
  `scripts/opencode2/proof-environment.ts`.

## Run repository checks

```bash
bun install
bun test packages/core/src/__tests__ packages/config/src/__tests__ packages/engine/src/__tests__
bun test packages/adapters/opencode2/src/__tests__
bun test packages/cli/src/detect/__tests__ packages/cli/src/installers/__tests__ packages/cli/src/commands/__tests__ packages/cli/src/migration/__tests__
bun test
bun run typecheck
bun run lint
bun run build
bun run validate-config
bun run docs:check-links
```

If global Weave config can affect `validate-config`, give that command an
isolated `HOME` and XDG environment. Do not edit the global config to make the
check pass.

## Run the live host check

This check answers one question: does Weave work on a real OpenCode 2 host? CI
runs it through [`opencode2-live.yml`](../../.github/workflows/opencode2-live.yml).
Run it locally the same way:

```bash
bun scripts/proof/opencode2-live/main.ts --host pinned --plugin local \
  --root ~/weave-opencode2-live
```

The host and its plugin cache need about 2 GB under `--root`. Pass a root
outside a small `/tmp`. The root must not exist yet or must be empty. The
script marks the root with a `.weave-opencode2-live` file and deletes only a
marked root when it finishes, unless you pass `--keep`.

`--host` accepts `pinned` (the `@opencode/plugin` version the adapter
depends on), `latest`, or an exact version. `--plugin` says how Weave is
installed:

| `--plugin` | What is installed |
| --- | --- |
| `local` | This checkout's adapter, built with `bun run build`, packed with `bun pm pack`, unpacked, and given its production dependencies. This is the package this revision would publish. |
| `npm:<spec>` | A registry package named in the project `plugins` field, for example `npm:@weaveio/weave-adapter-opencode2@next`. The host installs it. |
| `init:<cli-spec>` | The documented install, `<cli-spec> init --harness opencode2 --scope local --yes`, for example `init:@weaveio/weave-cli@next`. |

The script installs the host under an isolated HOME, XDG and runtime directory.
It names a scripted local model provider in the host's global config and
starts an isolated background service. It then uses only the `opencode2` CLI,
never `@opencode/client`, so a host release that changes the client API cannot
break the check itself. `scripts/opencode2/verify-runtime.ts` below broke that
way.

The script reports these checks:

| Check | Passes when |
| --- | --- |
| `host_version` | The host reports 2.x and, for an exact `--host`, that version. |
| `plugin_active` | `opencode2 api plugin.list` shows the Weave plugin as `active`. |
| `agents_registered` | `opencode2 api agent.list` shows every builtin agent with the `[weave-managed]` ownership marker. |
| `start_command` | `opencode2 api command.list` includes `weave:start`. |
| `run_completed` | `opencode2 run --agent loom` exited 0. |
| `loom_prompt` | During that run, the model received Loom's host-reported system prompt. |
| `delegation_offered` | Loom was offered the native `subagent` tool with Shuttle as a target. |
| `delegation_ran` | The scripted model called `subagent` for Shuttle, and the model then received Shuttle's system prompt from a child session. |
| `delegation_returned` | Loom's next request carried the tool result whose `tool_call_id` matches its `subagent` call. |
| `subagent_policy` | Shuttle was not offered `subagent` or `question`. |

Exit code 0 means every check passed. Exit code 1 means a check failed or was
skipped. Exit code 2 means the harness could not run, for example because the
host install failed.

The Podman layers in `verify:opencode2` assert agent materialization with
fixtures that give every agent `proof/proof-model`. This check uses the
builtin defaults instead, so it covers the configuration a new user has. The
`api` operations are also the outside-the-host view that
[#165](https://github.com/weave-io/weave/issues/165) asked for.

### CI legs

- **Pinned** runs on pull requests and pushes that touch the adapter or its
  engine dependencies. It checks this revision on the pinned host.
- **Canary** runs daily and on manual dispatch against
  `@opencode/cli@latest`. It checks this revision, the `next` package, and the
  documented `weave init` install. The host changes without any change in
  this repository, so a path-filtered workflow cannot detect a host release
  that breaks Weave. OpenCode 2.0.4 removed `ctx.catalog` on 2026-09-16, and
  the pinned checks stayed green until
  [#236](https://github.com/weave-io/weave/pull/236).

A red `published next package` or `documented weave init` leg while
`this revision` is green means a fix exists but has not been released.

## Run the packaged runtime proof

> **Stale.** `verify-runtime.ts` still targets `0.0.0-beta-19151` and calls
> client APIs that 2.0.16 removed, such as `plugin.awaitActivation`. CI does
> not run it. Use the [live host check](#run-the-live-host-check) for current
> hosts.

```bash
bun scripts/opencode2/verify-runtime.ts
```

The script does the following work:

1. builds and packs `@weaveio/weave-adapter-opencode2`;
2. installs the tarball and exact OpenCode CLI/client packages in an isolated
   root;
3. starts an isolated service on an ephemeral port;
4. uses a local deterministic provider to inspect native requests and child
   results;
5. runs all verdicts in `scripts/opencode2/proof-cases.ts`; and
6. stops the service and deletes the proof root.

The command must exit nonzero when a host API, package identity, or required
case is missing. Set `WEAVE_OPENCODE2_KEEP_PROOF=1` only while debugging. Remove
the retained root when the investigation is complete. Do not retain provider
requests or session transcripts as proof artifacts.

## Run the interactive UI proof

Use the tarball produced from the same source revision as the passing runtime
proof. Install it with the exact host in an isolated runtime. Configure the
adapter through a package-directory entry in the plural `plugins` field. Start
a deterministic local provider and an OpenCode service on an ephemeral port.

When you open a terminal pane for this check, use Herdr and follow its current
skill instructions. Start the CLI from a local working directory that differs
from the fixture project, but pass the fixture project as the OpenCode
Location.

Check these states in the real CLI:

1. Create a session. Confirm `Weave plan: No plan selected`.
2. Run `/weave:start` with no argument. Confirm the native plan picker lists
   fixture plans, cancel it, and confirm that no work started. Run
   `/weave:start <active-plan>`, confirm the start prompt, and then confirm
   the plan name, completed/total count, current task, and next task.
3. Open **Weave: Plan tasks** from the command palette. Move the selection with
   the keyboard, then close it with Escape. Confirm that the plan did not
   change and no work started.
4. Select a complete plan. Confirm the completed count, `Plan complete`, and no
   next task.
5. Select missing and malformed plans. Confirm the panel returns to no-plan and
   the command starts no model work.
6. Save malformed `.weave` config and admit one request. Confirm the last valid
   plan remains visible with `Weave config refresh failed; using last valid
   config`.
7. Stop only the isolated service. Within the transport-check interval, confirm
   `Weave plan: Disconnected`. Restart the isolated service and confirm that the
   selected plan is read again.
8. Create a second session with no selected plan. Switch between the two
   sessions and confirm that each panel shows its own state.
9. Repeat the panel and task-list checks at normal and narrow terminal widths.
   Confirm that each line stays bounded and legible.
10. Load a harmless second CLI plugin beside Weave. Confirm both plugins remain
    active and the Weave panel still works.
11. Inspect the server session Location through the public client. Confirm it is
     the fixture project, not the CLI process's original working directory.
12. Open the start picker, then move the session to another Location or close
    the session view. Confirm the picker closes, late responses do not reopen
    it, and no plan starts. Repeat while the plan catalog request is pending.
13. Call `plans` against a fixture whose `.weave` or `plans` entry is a symbolic
    link, including a dangling link. Confirm an unreadable-catalog error, not
    an empty list or names from the link target. Confirm a genuinely missing
    plans directory returns an empty list.
14. Submit `start` with a directory that differs from the session Location.
    Confirm a `wrong_location` error and no agent switch or prompt admission.

Record only bounded outcomes, host/package versions, artifact digests, and
terminal dimensions in `docs/artifacts/`. Do not record credentials, temporary
paths, provider request bodies, or conversation text.

## Clean up

Stop the isolated CLI, service, and provider. Delete every retained proof root.
Then check that no proof process remains and that no `.weave/runtime/weave.db`
was created by these checks.
