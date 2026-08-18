import { defineRule } from "@oxlint/plugins";

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
				const parent = node.parent;
				if (parent === null) return;
				if (parent.type === "ExpressionStatement" && parent.expression === node) {
					return;
				}
				if (
					parent.type === "ForStatement" &&
					(parent.init === node || parent.update === node)
				) {
					return;
				}
				context.report({ node, messageId: "assignInExpression" });
			},
		};
	},
});
