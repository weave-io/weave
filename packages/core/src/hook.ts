/**
 * Configuration for a lifecycle hook that the Weave engine will register
 * with the underlying harness adapter.
 *
 * Hooks allow external logic to be injected at well-known points in the
 * agent lifecycle (e.g. before a task starts, after a tool call completes).
 */
export interface HookConfig {
	/**
	 * The hook identifier. Must match a hook name recognised by the active
	 * harness adapter (e.g. `"on-task-start"`, `"on-tool-call"`,
	 * `"on-session-end"`).
	 */
	name: string;

	/**
	 * Whether this hook is active. Disabled hooks are parsed and validated
	 * but never registered with the adapter at runtime.
	 *
	 * @default true
	 */
	enabled: boolean;
}
