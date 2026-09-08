# OpenCode 2 Adapter

`@weaveio/weave-adapter-opencode` provides native server, RPC, and CLI plugins
for OpenCode 2. The supported host for this release is exactly
`0.0.0-beta-19086`.

**Related:** [Adapter Boundary](../adapter-boundary.md) · [Adapter Readiness
Status](../adapter-readiness-status.md) · [Model Resolution](../model-resolution.md)
· [Verification](../testing/opencode2-verification.md) · [Package
README](../../packages/adapters/opencode/README.md)

## Install

Use the Weave CLI to add one native `plugins` entry. OpenCode 1 and OpenCode 2
use different plugin ABIs, so selection is explicit.

```bash
weave init --harness opencode2 --scope local --yes
```

Local installation edits one of these files under the current project:

- `opencode.jsonc`
- `opencode.json`
- `.opencode/opencode.jsonc`
- `.opencode/opencode.json`

Global installation uses
`$XDG_CONFIG_HOME/opencode/opencode.json(c)`, or
`~/.config/opencode/opencode.json(c)` when `XDG_CONFIG_HOME` is unset.
Installation stops if more than one candidate exists. It preserves comments,
options, and unrelated keys. A second run does not change the file bytes.

Manual configuration uses the plural `plugins` field:

```jsonc
{
  "plugins": [
    "@weaveio/weave-adapter-opencode@<exact-version>",
  ],
}
```

Plugin options use OpenCode's package descriptor form:

```jsonc
{
  "plugins": [
    {
      "package": "@weaveio/weave-adapter-opencode@<exact-version>",
      "options": {
        "projectConfig": true,
        "defaultAgent": "loom",
        "refreshIntervalMs": 1000,
      },
    },
  ],
}
```

`projectConfig: false` prevents this plugin instance from loading
`<Location>/.weave/config.weave`. Global Weave config remains available. The
refresh interval accepts 250 through 60,000 milliseconds. Unknown or invalid
options disable setup with a bounded warning.

## Package entries and compatibility

The package ships these entries:

| Entry | Purpose |
| --- | --- |
| package root | Legacy library helpers plus the V2 server definition |
| `./server` and `./plugin` | V2 server plugin definition |
| `./rpc` | Portable read-only RPC definition |
| `./tui` | Solid/OpenTUI CLI plugin |

The package also ships physical root `server.js`, `rpc.js`, and `tui.js`
wrappers. The pinned host requires those files when `plugins` names a local
package directory; published package-name loading continues to use subpath
exports.

The live plugin ABI is an intentional compatibility break. OpenCode 1 plugin
loading is not supported by these entries. Existing V1 SDK-based library
helpers remain exported for source compatibility, but they are not the V2
runtime.

## Location-scoped materialization

Each server plugin instance owns one OpenCode Location. It:

1. loads builtin, global, and allowed project `.weave` layers;
2. gets model and skill inventories from OpenCode;
3. materializes normalized descriptors once;
4. resolves models, variants, and skills against those inventories;
5. registers absent agents through the native agent transform.

The adapter does not overwrite a same-ID foreign agent. Later hooks and
commands act only on agent IDs inserted by the current replay. Health reports
collisions as bounded counts. Generated category and review agents use the same
path as ordinary agents. Trigger metadata stays in its current object form, and
category `patterns` remain part of the DSL.

## Models and request intent

An explicit model entry uses `provider/model` and can add a native variant as
`provider/model#variant`. A bare model ID is accepted only when exactly one live
catalog entry matches. The first viable declared entry wins. An agent is
omitted when it declares models but none are valid or available.

If an agent declares no model, OpenCode keeps native model selection. The
adapter does not reset a user's model on each turn. A descriptor-level
`variant` applies only when the selected model entry has no `#variant`.
Declared temperature is applied through the native context hook after agent
ownership and session Location checks.

## Tool policy

Weave maps only its abstract capabilities. It leaves unrelated native
safeguards in place.

| Weave capability | OpenCode 2 actions |
| --- | --- |
| `read` | `read`, `glob`, `grep` |
| `write` | `edit` |
| `execute` | `shell` |
| `delegate` | `subagent` for eligible materialized targets |
| `network` | `webfetch`, `websearch` |

`allow`, `deny`, and `ask` remain distinct. Delegation starts with a wildcard
deny rule, then adds rules only for eligible target agent IDs. The adapter does
not emit obsolete `task`, `bash`, `doom_loop`, or boolean tool fields. Arbitrary
MCP and custom tool mappings are not claimed.

## Skills

The adapter matches configured skill names against OpenCode's live skill
inventory. Missing skills produce nonfatal health issues. Existing prompt
skill mentions are retained and duplicate skill IDs are removed.

**Accepted host limit:** OpenCode `0.0.0-beta-19086` does not expose the native
skill permission assertion through prompt admission. This release attaches
configured, available skill IDs without that permission check. Do not treat a
Weave skill declaration as proof that OpenCode asked for approval. Disable the
skill in `.weave` when this behavior is not acceptable.

## Refresh behavior

The server checks for changes before admitted work, with a bounded minimum
interval. One in-flight refresh is shared. It reads each source once per
attempt, hashes those exact bytes, and publishes only a complete valid catalog.
Broken edits keep the last valid catalog. The CLI plan contribution shows this
as a bounded refresh warning while it continues to display the last valid plan
state. A changed catalog reloads native agent
and command registries for later operations; it does not rewrite an in-flight
request or silently switch a live session model. Registry reload is not
cross-registry atomic, so a failed partial reload is rolled back and replayed
from the previous candidate.
If initial config loading fails, the registered transforms remain idle. The
first later valid refresh publishes the catalog and reloads both registries, so
fixing the file does not require an OpenCode restart. An existence-check I/O
failure is not treated as a deleted source.

The adapter does not redirect the shared process logger to a Location-specific
file. Operators control the shared pino destination and level.

## Foreground plan command

The V2 plugin reserves one command:

```text
/weave:start <plan-name>
```

`/start-work` is not registered. The reserved-name decision means another
plugin's `weave:start` command can be replaced during replay because the pinned
`CommandEditor` has no atomic presence check.

The command validates and reads only
`<Location>/.weave/plans/<plan-name>.md`, switches the current session to the
owned Tapestry agent and its resolved model, and submits one visible foreground
prompt with the invocation's files, agent mentions, skill mentions, and
delivery mode. No plan name means
no switch and no work. Missing or invalid plans also start no work.

Selected-plan storage contains only session/Location identity, the plan name,
content revision, and bounded display counts/titles. It is not workflow state,
automatic-resume authority, or an exactly-once record. The command and the
read-only RPC do not create `.weave/runtime/weave.db`.

## CLI plan display

The `./tui` plugin appends a compact composer contribution with plan name,
completed/total count, current task, and next task. The palette action **Weave:
Plan tasks** opens a read-only task list. It has no default global key binding.

The UI does not gate plan loading on an exact OpenCode version. It attempts
the plan RPC on newer hosts as well; this does not extend the verified host
compatibility claim above.

The UI shows explicit no-plan, loading, completed, unavailable,
and disconnected states. It re-reads server state after
reconnect, relevant session events, and a five-second transport check. It
rejects stale session responses and
does not read project files locally. Headless OpenCode clients can call the
same read-only RPC but do not load the CLI contribution.
The periodic transport check refreshes the panel without closing an open task
dialog. Session invalidation and component disposal can close that dialog.

## Native delegation

Weave uses OpenCode's native `subagent` action. It does not create a parallel
session scheduler or use private `parentID` inputs. Foreground and background
execution, result delivery, navigation, steering, and interruption remain
native OpenCode behavior. Child requests use the child's registered model,
policy, prompt, temperature, and configured skills.

## Readiness and limits

The adapter RPC reports native-agent, request-intent, foreground-plan,
plan-display, and native-delegation readiness from live registrations. It also
reports that durable workflows are unavailable. Therefore this release does
not satisfy Weave's existing Core Readiness Profile, which requires durable
workflow capabilities.

Not delivered: durable workflow run/resume/advance, usage rollups, a child
dashboard, automatic model fallback, provider acceleration, or `/weave:goal`.
The DSL accepts `fast` and `settings.delegation.max_concurrency` as execution
intent. Parsing these fields alone does not establish native enforcement; see
[Execution Controls](../specs/33-spec-execution-controls/33-spec-execution-controls.md).

### Execution control boundary on beta-19086

Neither setting is currently applied by this adapter. `fast` survives agent
composition, including category overrides. `delegation.max_concurrency`
survives config loading and merging. These are configuration support, not
runtime support.

The pinned host has no native agent `fast` field. Its context hook can set
`providerOptions.serviceTier` for OpenAI Responses, but that is not a portable
fast-mode control. No mapping has been verified for `openai-codex` or
Anthropic. This adapter does not add a provider-specific override or claim
that fast service was requested or applied.

The concurrency contract requires a separate limit for each parent session,
covering live foreground and background children. Wrapping the native
`subagent` executor cannot meet it: foreground calls wait for completion,
while background calls return after launch. The public plugin API has no
atomic child admission/completion control or reliable reconstruction of live
children after restart. Limiting launches or rejecting background work is not
an accepted substitute. Runtime enforcement is blocked pending a host API that
can satisfy this contract; the adapter does not install a partial limiter.

Sources: the pinned `@opencode-ai/plugin` public `promise/session.d.ts` and
`promise/tool.d.ts` types, and the [V2 plugin
guide](https://opencode.ai/v2/docs/build/plugins).

## Verify

Use the isolated procedure in [OpenCode 2
verification](../testing/opencode2-verification.md). Unit tests use mocked host
boundaries. Packaged runtime and interactive UI checks use a separate exact
host under an isolated HOME and XDG root.
