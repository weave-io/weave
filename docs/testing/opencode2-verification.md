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

## Requirements

The retained Podman verifier uses an explicit `proof/proof-model` catalog
entry and a local deterministic HTTP provider. Its Weave fixtures declare that
model for every builtin. They must not rely on primary-agent model fallback,
the host's changing free-model catalog, or remote credentials. These fixtures
exercise the native `./server` implementation, not the compatibility facade.

- Run from a clean Weave worktree.
- Use Bun.
- Keep the exact supported host at `0.0.0-beta-19151`.
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

## Run the packaged runtime proof

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
2. Run `/weave:start <active-plan>`. Confirm the plan name, completed/total
   count, current task, and next task.
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

Record only bounded outcomes, host/package versions, artifact digests, and
terminal dimensions in `docs/artifacts/`. Do not record credentials, temporary
paths, provider request bodies, or conversation text.

## Clean up

Stop the isolated CLI, service, and provider. Delete every retained proof root.
Then check that no proof process remains and that no `.weave/runtime/weave.db`
was created by these checks.
