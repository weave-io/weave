import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { isLoopStatement } from "../shared/ancestors.ts";

function lastStatement(body: ESTree.Node): ESTree.Node {
	if (body.type === "BlockStatement") {
		const last = body.body.at(-1);
		return last ?? body;
	}
	if (body.type === "LabeledStatement") return lastStatement(body.body);
	return body;
}

function loopBody(node: ESTree.Node): ESTree.Node | null {
	if (
		node.type === "ForStatement" ||
		node.type === "ForInStatement" ||
		node.type === "ForOfStatement" ||
		node.type === "WhileStatement" ||
		node.type === "DoWhileStatement"
	) {
		return node.body;
	}
	return null;
}

function enclosingLoopLabel(node: ESTree.ContinueStatement): string | null {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (current.type === "LabeledStatement" && isLoopStatement(current.body)) {
			return current.label.name;
		}
		if (isLoopStatement(current) || isFunctionLike(current)) return null;
		current = current.parent;
	}
	return null;
}

function isFunctionLike(node: ESTree.Node): boolean {
	return (
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression" ||
		node.type === "ArrowFunctionExpression"
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
				let current: ESTree.Node | null = node.parent;
				while (current !== null && current.type !== "Program") {
					if (isFunctionLike(current)) return;
					const body = loopBody(current);
					if (body !== null) {
						const last = lastStatement(body);
						const continueIsLast =
							last === node ||
							(last.type === "LabeledStatement" && last.body === node);
						if (!continueIsLast) return;
						if (node.label === null) {
							context.report({ node, messageId: "uselessContinue" });
							return;
						}
						const loopLabel = enclosingLoopLabel(node);
						if (loopLabel === node.label.name) {
							context.report({ node, messageId: "uselessContinue" });
						}
						return;
					}
					current = current.parent;
				}
			},
		};
	},
});
