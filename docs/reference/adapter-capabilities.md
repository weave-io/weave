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

The Pi adapter declares three severities:

| Severity | Gap behavior |
| --- | --- |
| `required-for-delegation` | The generation enters health-only mode |
| `overlay-only` | The overlay falls back to the custom-editor path; delegation keeps working |
| `rendering-fallback` | The harness's default rendering is used |

Its native child-session storage adds four `required-for-delegation` probes — `rpc-persistent-session`, `rpc-append-entry`, `rpc-session-tree-read`, and `custom-session-directory` — plus the `overlay-only` `child-overlay-lifecycle` surface. A missing session read surface is never treated as overlay-only, because reading recorded child work must not silently disappear.

A fifth `required-for-delegation` surface, `descriptor-relative-native-session-io`, backs the required capability of the same name. It is the only surface the production probe port answers `false` for unconditionally: the exact tested Pi host addresses native sessions by caller-supplied filesystem path, so the adapter cannot prove where a session write would land. Method presence for session restore, custom session directories, or any RPC call does not override it, and no environment variable or configuration can enable it. Only a test double may model a descriptor-safe host.

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

`descriptor-relative-native-session-io` is a required capability that states one contract: every native session read and write is addressed by an opaque, host-owned session descriptor rather than by a caller-supplied filesystem path. It is supplied by the host, never emulated by an adapter.

When it is unavailable, every route that would perform a persistent session mutation fails with a typed `RequiredCapabilityUnavailable` result before it calls a controller, session service, filesystem, metadata cache, execution lease, or child process. That covers delegation, direct workflow dispatch, retry, continue, steering, follow-up, cancellation, clear, recovery, and the adapter CLI's delete command. Read-only status, health, history, inspection, doctor, list, and show routes stay available and perform no mutation.

Unlike an ordinary health-only gap, this capability also blocks idempotent cleanup: cleanup still writes to persistent session state, and the host cannot prove where that write would land.

## Adapter responsibilities

Each adapter must:

- declare only behavior it really implements;
- probe without project mutation or outbound network activity;
- rebuild readiness for each controller generation;
- fail closed when required context is absent or ambiguous;
- keep runtime evidence in tests and release outputs, not in this reference page.

Per-adapter implementation notes live under [`docs/adapters/`](../adapters). Tests for the shared contract are under [`packages/engine/src/__tests__/`](../../packages/engine/src/__tests__).
