# Adapter Capabilities

Adapter capabilities describe what a harness integration can support and what it proved during the current activation. They prevent a static package claim from being mistaken for live readiness.

**Related:** [Adapter Boundary](../architecture/adapter-boundary.md) · [Adapter Development](../guides/adapter-development.md) · [Tool Policy](tool-policy.md) · [Execution Lifecycle](execution-lifecycle.md)

---

## Two layers of readiness

1. **Static declaration** — the adapter's maximum supported readiness for each capability.
2. **Runtime probe** — one safe observation of what the current harness generation can actually provide.

A probe may lower a declaration; it can never raise it. The resulting effective capability set drives activation and health reporting.

## Readiness levels

| Level | Meaning |
| --- | --- |
| `native` | The harness provides the capability directly |
| `emulated` | The adapter supplies equivalent behavior |
| `degraded` | The capability exists with a documented limitation |
| `unsupported` | The integration cannot provide it |

`native` and `emulated` satisfy a required capability. `degraded`, `unsupported`, missing, duplicate, or failed required probes do not.

## Capability contract

An adapter returns one ordered `AdapterCapabilityContract`. Each entry has:

- a stable capability ID;
- a readiness level;
- a short description;
- implementation notes;
- the impact of degradation or absence;
- the component that supplied the declaration.

The closed ID vocabulary and current required/optional profile live in [`packages/engine/src/capability-contract.ts`](../../packages/engine/src/capability-contract.ts). Do not copy the list into adapter code or documentation; import it so additions cannot drift.

`provider-fast-activation` is the optional provider-acceleration capability. When `runtimeStatus` is present, the exported contract accepts only the bounded evidence tokens from that module. Other capabilities keep sanitized freeform status strings. A descriptor without `fast true` does not require this capability and emits no requested or applied state.

### Current provider-fast support

No shipped adapter can prove that a provider applied acceleration. One adapter mapping can nevertheless prove what it sent, so it declares a ceiling below `applied`:

| Adapter | Readiness | Runtime status | Seam |
| --- | --- | --- | --- |
| Pi, OpenAI Codex subscription mapping | `degraded` | Read from one correlated attempt: `requested`, `not-confirmed`, or `unsupported` | Weave's own wrapped `openai-codex` provider holds the effective transport, the final body, the outgoing headers, and the same attempt's response. It sends the two-part Codex control only under the exact eligibility rules, and the pinned host's standard-speed response evidence caps a successful request at `not-confirmed`. |
| Pi, public OpenAI API and every other provider | — | `unsupported` (`harness-seam-unavailable`) | Pi's hook contract cannot bind the effective transport or the response body of one prepared provider request, so the adapter registers no provider request or header hook. |
| OpenCode | `unsupported` | `unsupported` (`response-proof-unavailable`) | OpenCode's plugin surface can mutate a request, but no correlated official response-body proof exists for the same attempt. |
| Claude Code | `unsupported` | `unsupported` (`harness-seam-unavailable`) | Static file materialization owns no per-invocation request seam and no response evidence. Claude Code's own `/fast` and Agent SDK controls are outside the adapter's surface. |

Pi declares one static entry for the whole capability. `degraded` is its ceiling because the mapping covers one provider and cannot reach `applied` on the pinned host; a live attempt may lower that ceiling and can never raise it. Every mapping in the table that reports `unsupported` sends no acceleration control and leaves its provider payloads and headers unchanged, so `fast true` stays inert there. A Pi request that fails any eligibility rule is also byte-identical passthrough.

These remain optional-capability outcomes. They warn, and they never enter health-only mode, block descriptor materialization, agent activation, prompts, models, tools, or delegation. `fast true` still travels through the config, descriptor, and Pi child-bootstrap layers as neutral intent. See [Pi Adapter](../adapters/pi.md#provider-acceleration) for the exact Pi rules, and the [provider acceleration contract](../specs/fast-provider-acceleration-contract.md#truthful-states-and-transitions) for the state vocabulary and the evidence threshold that `applied` requires.

## Effective evaluation

A safe initializer supplies exactly one `CapabilityProbeResult` for every known capability. Evaluation:

1. validates the static contract;
2. rejects missing or duplicate probes;
3. lowers each static readiness by its probe status;
4. evaluates required capabilities as pass/fail and optional capabilities as pass/warning;
5. builds one `AdapterHealthReport`.

Required effective gaps put an adapter generation into health-only mode. Optional gaps remain warnings unless another contract makes them required for a specific operation.

## Execution entry

`command-entrypoints` is the execution-entry capability. It tells users whether the adapter exposes an explicit surface that may start or resume durable work.

`workflow-step-dispatch` is supporting machinery only. It does not authorize execution and cannot satisfy a missing command entrypoint.

## Tool policy

`tool-policy-mapping` records who owns concrete tool authorization:

- an adapter that maps Weave policy may describe its mapping;
- an adapter that relies on native harness/tool-owner controls may still be `native`, but its details must name that ownership;
- readiness never means that Weave has intercepted every harness tool.

See [Tool Policy](tool-policy.md) and [Permissions](permissions.md).

## Adapter-owned host surface probes

The closed capability ID vocabulary is engine-owned, but an adapter may also declare *host surfaces*: the concrete host APIs it needs, each with its own severity. Surfaces are internal to the adapter; they never widen the engine's ID set. They exist so a host that is otherwise healthy can degrade one feature instead of failing the whole generation.

The Pi adapter declares four severities:

| Severity | Gap behavior |
| --- | --- |
| `required-for-delegation` | The generation enters health-only mode |
| `overlay-only` | The overlay falls back to the custom-editor path; delegation keeps working |
| `rendering-fallback` | The harness's default rendering is used |
| `feature-only` | An optional host feature stays off; health stays ready and the overlay is unchanged |

Pi's `runtime-model-fallback` surface is `feature-only`. It is an adapter host surface, not an engine capability ID. The adapter probes only public surface presence: payloadless `agent_settled` registration, terminal `message_end`, replacement-returning `context`, `message_start`, `model_select`, callable `setModel`, fire-and-forget `sendMessage`, and callable idle and pending-message helpers. Static presence does not prove event ordering; each recovery attempt still requires exact marker `message_start` and provider-context repair.

The implementation targets Pi `0.84.2`'s public surfaces, and Task 15 is the exact real-host proof target for this optional behavior. Until Task 15 passes, Pi `0.84.2` is not a proven fallback host. The support floor stays `0.81.1`. If a surface is missing or unproven, the adapter reports bounded unsupported evidence, keeps health ready, and uses legacy visible and child settlement. It does not enter health-only mode or select the overlay fallback. The fallback coordinator then remains inactive.

Its native child-session storage adds four `required-for-delegation` probes — `rpc-persistent-session`, `rpc-append-entry`, `rpc-session-tree-read`, and `custom-session-directory` — plus the `overlay-only` `child-overlay-lifecycle` surface. A missing session read surface is never treated as overlay-only, because reading recorded child work must not silently disappear.

Every required surface gap reduces to one closed, path-free readiness reason on `delegated-specialist-execution`: `pi-session-api-unavailable`, `pi-session-root-unavailable`, `pi-session-root-unsafe`, or `pi-process-unavailable`. Raw host messages, causes, filesystem paths, and method names never reach an operator surface.

Pi native-session readiness is not a public capability or host-surface ID. Before activation, the adapter proves the real `SessionManager.create` and `SessionManager.open` API, its private session root, and the Pi process launch surface. No environment variable or descriptor capability can raise readiness.

A gap reports the stable surface ID and a remediation string. See [Pi Adapter](../adapters/pi.md#host-surface-probes).

## Health reports

Health reports are normalized engine output. Adapters may render them as text, JSON, TUI rows, or harness-native diagnostics, but must not change the verdicts.

A report contains:

- adapter name and version;
- harness identity and compatibility result;
- static declarations;
- effective entries and probe resolutions;
- profile evaluation;
- health-only status and safe diagnostics.

Health-only mode may expose health and other read-only diagnostics. It blocks agent materialization, workflow mutation, and delegation.

### Persistent session mutation

Persistent session mutation depends on the required `delegated-specialist-execution` capability. A harness that addresses sessions by path proves containment inside its own adapter: the adapter owns the session root, hands the harness that exact directory, and accepts only a canonical immediate child of it. No path enters an engine capability, health report, lifecycle record, or model result.

When that capability is unavailable for one of the four closed session-readiness reasons, every route that would perform a persistent session mutation fails with a typed `RequiredCapabilityUnavailable` result before it calls a controller, session service, filesystem, metadata cache, execution lease, or child process. That covers delegation, direct workflow dispatch, retry, continue, steering, follow-up, cancellation, clear, recovery, and the adapter CLI's delete command. Read-only status, health, history, inspection, doctor, list, and show routes stay available and perform no mutation.

The adapter CLI gates `children.delete` on the same proof before it opens writable diagnostics. Delete removes the verified terminal child session and appends its tombstone. List, show, and doctor never inherit write access.

Unlike an ordinary health-only gap, an unproven session store also blocks idempotent cleanup: cleanup still writes to persistent session state, and the adapter cannot prove where that write would land.

## Adapter responsibilities

Each adapter must:

- declare only behavior it really implements;
- probe without project mutation or outbound network activity;
- rebuild readiness for each controller generation;
- fail closed when required context is absent or ambiguous;
- keep runtime evidence in tests and release outputs, not in this reference page.

Per-adapter implementation notes live under [`docs/adapters/`](../adapters). Tests for the shared contract are under [`packages/engine/src/__tests__/`](../../packages/engine/src/__tests__).
