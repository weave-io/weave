import { defineRule } from "@oxlint/plugins";

import type { Context, ESTree } from "@oxlint/plugins";

import { isExplicitlyParenthesized } from "../shared/ancestors.ts";

function assignmentIsAllowed(
	node: ESTree.AssignmentExpression,
	context: Context,
): boolean {
	let previous: ESTree.Node = node;
	let parent: ESTree.Node | null = node.parent;

	// Assignment chains and parenthesized assignments are still one
	// assignment expression for the purpose of this rule.
	while (
		parent !== null &&
		(parent.type === "AssignmentExpression" || parent.type === "ParenthesizedExpression")
	) {
		previous = parent;
		parent = parent.parent;
	}

	while (parent?.type === "SequenceExpression") {
		if (isExplicitlyParenthesized(context.sourceCode, parent)) return false;
		previous = parent;
		parent = parent.parent;
	}

	if (parent?.type === "ExpressionStatement") return true;
	if (parent?.type === "ForStatement") {
		return parent.test === null || parent.test !== previous;
	}
	if (parent?.type === "ArrowFunctionExpression") {
		return parent.expression && parent.body === previous;
	}
	return false;
}

/** Disallow assignments used as expressions. */
export const noAssignInExpressionsRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow assignments inside expressions.",
		},
		messages: {
			assignInExpression:
				"Do not assign inside an expression. Use a comparison or a standalone assignment.",
		},
	},
	createOnce(context) {
		return {
			AssignmentExpression(node) {
				if (!assignmentIsAllowed(node, context)) {
					context.report({ node, messageId: "assignInExpression" });
				}
			},
		};
	},
});
