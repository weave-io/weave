import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isLoopStatement } from "../shared/ancestors.ts";

function isStatementList(node: ESTree.Node): node is ESTree.BlockStatement {
	return node.type === "BlockStatement";
}

function isLastInStatementList(
	parent: ESTree.BlockStatement,
	child: ESTree.Node,
): boolean {
	return parent.body.at(-1) === child;
}

function isUnnecessary(node: ESTree.ContinueStatement): boolean {
	const ancestors: ESTree.Node[] = [];
	let current: ESTree.Node | null = node.parent;
	while (current !== null && !isLoopStatement(current)) {
		ancestors.push(current);
		current = current.parent;
	}
	if (current === null) return false;

	// A continue in a switch changes which statement executes next. It is
	// not equivalent to falling through the enclosing loop body.
	if (ancestors.some((ancestor) => ancestor.type === "SwitchStatement")) {
		return false;
	}

	// The loop's direct body is the only ancestor-free case. This mirrors
	// Biome's control-flow check for `while (condition) continue;`.
	if (ancestors.length === 0) return true;

	const immediateParent = ancestors[0];
	if (
		!isStatementList(immediateParent) ||
		!isLastInStatementList(immediateParent, node)
	) {
		return false;
	}

	for (let index = 0; index + 1 < ancestors.length; index += 1) {
		const child = ancestors[index];
		const parent = ancestors[index + 1];
		if (isStatementList(parent) && !isLastInStatementList(parent, child)) {
			return false;
		}
	}

	if (node.label === null) return true;
	const loopParent = current.parent;
	return (
		loopParent?.type === "LabeledStatement" &&
		loopParent.label.name === node.label.name
	);
}

/** Disallow continue statements that do not skip remaining loop work. */
export const noUselessContinueRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow continue statements that do not skip remaining work.",
		},
		messages: {
			uselessContinue: "This `continue` is unnecessary.",
		},
	},
	createOnce(context) {
		return {
			ContinueStatement(node) {
				if (isUnnecessary(node)) {
					context.report({ node, messageId: "uselessContinue" });
				}
			},
		};
	},
});
