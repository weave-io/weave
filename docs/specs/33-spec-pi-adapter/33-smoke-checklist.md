# Pi child-inspection smoke checklist

Version: 2

This checklist is generated from the release checklist at
`scripts/release/pi-acceptance/smoke-checklist.md`. Rows S024–S036 are pending
until the autonomous, digest-bound PTY run completes. The driver uses disposable
`XDG_DATA_HOME`, `PI_CODING_AGENT_DIR`, and project roots and sends no human
input.

| ID | Requirement | Result |
|---|---|---|
| S024 | Render native and fallback child views with bounded sanitized previews | Pending |
| S025 | Render safely at narrow widths and preserve interaction | Pending |
| S026 | Steer a running child through native control | Pending |
| S027 | Complete queued follow-up and extension UI response | Pending |
| S028 | Interrupt and restart without losing authenticated state | Pending |
| S029 | Keep private persistence inside isolated data roots | Pending |
| S030 | Keep private content out of parent projections | Pending |
| S031 | Return bounded terminal output and numeric metadata only | Pending |
| S032 | Validate >1 MiB output ten times sequentially and at max parallelism | Pending |
| S033 | Enforce quotas and clear terminal history | Pending |
| S034 | Reject invalid settings with structured issues | Pending |
| S035 | Resume ordinary work after restart | Pending |
| S036 | Reject exact structured `ChildSettlementMissing`, independent of logs | Pending |

A passing report must record artifact SHA-256, subject SHA, exact host version,
checklist version, run attempt, and `childSettlementMissingCount: 0`.
