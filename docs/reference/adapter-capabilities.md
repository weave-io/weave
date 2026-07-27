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

## Adapter responsibilities

Each adapter must:

- declare only behavior it really implements;
- probe without project mutation or outbound network activity;
- rebuild readiness for each controller generation;
- fail closed when required context is absent or ambiguous;
- keep runtime evidence in tests and release outputs, not in this reference page.

Per-adapter implementation notes live under [`docs/adapters/`](../adapters). Tests for the shared contract are under [`packages/engine/src/__tests__/`](../../packages/engine/src/__tests__).
