# Task 04 Proofs — static policy preview and `beforeTool` compatibility

> **Superseded:** This proof originally described the legacy pure `beforeTool` evaluator. The evaluator now lives at `previewToolPolicy`; `beforeTool` is authoritative only for registered Spec 34 permission-session calls.

## Historical task summary

The original task proved static abstract policy evaluation from `tool-policy.ts`. That behavior remains at `previewToolPolicy`, which reuses `ABSTRACT_CAPABILITIES` and `EffectiveToolPolicy` and cannot authorize execution, issue a permit, or establish adapter readiness. Adapters still own concrete tool-name mapping.

The current `beforeTool` contract is separate:

- It accepts an exact registered call snapshot, not static policy fields.
- It snapshots plain own enumerable top-level and nested permission fields once.
- It rejects accessors, proxies, omitted fields, legacy-shaped inputs, and extras with `LifecycleValidationError`.
- It delegates registered calls to `PermissionSession`; unmanaged calls return `unmanaged` and never authorize.

## Historical evidence

The test and typecheck captures below document the original implementation and remain audit history. They are not evidence for the current API. Current tests call `previewToolPolicy` for static decisions and use the registered permission compatibility tests for `beforeTool` authorization and adversarial input validation.

## Current references

- [Spec 13](../13-spec-minimal-execution-lifecycle-surface.md)
- [Spec 34](../../34-spec-harness-neutral-permissions/34-spec-harness-neutral-permissions.md)
- [Tool policy evaluation guide](../../../tool-policy-evaluation.md)
- [Adapter boundary](../../../adapter-boundary.md)

## Historical test coverage

The original cases covered allow, deny, and ask decisions for all five abstract capabilities, unknown capabilities, missing identifiers, metadata sanitization, and credential-field exclusions. Those cases now belong to `previewToolPolicy` and `StaticToolPolicyPreviewInput` / `StaticToolPolicyPreviewOutput`.

The registered compatibility tests additionally cover allow, deny, ask, unmanaged calls, resolver and repository errors, identity propagation, exact-shape validation, and proxy-hidden permission.

## Reviewer conclusion

The original pure-policy claims are superseded. `previewToolPolicy` remains side-effect free and non-authoritative; registered `beforeTool` is the Spec 34 permission-session compatibility path. No Runtime Store or PermissionSession internals are changed by this migration.
