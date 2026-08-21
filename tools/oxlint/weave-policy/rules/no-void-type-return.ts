import { defineRule } from "@oxlint/plugins";

import type { Context, ESTree } from "@oxlint/plugins";

import { findAncestor, isExplicitlyParenthesized, isFunctionNode } from "../shared/ancestors.ts";

function isVoidReturnType(
	annotation: ESTree.TSTypeAnnotation | null | undefined,
	context: Context,
): boolean {
	return (
		annotation?.typeAnnotation.type === "TSVoidKeyword" &&
		!isExplicitlyParenthesized(context.sourceCode, annotation.typeAnnotation)
	);
}

function functionReturnType(
	node: ESTree.Node,
): ESTree.TSTypeAnnotation | null | undefined {
	if (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	) {
		return node.returnType;
	}
	return undefined;
}

/** Disallow returning a value from a function typed as void. */
export const noVoidTypeReturnRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow returning a value from a function whose return type is void.",
		},
		messages: {
			voidReturn: "Do not return a value from a `void` function.",
		},
	},
	createOnce(context) {
		return {
			ReturnStatement(node) {
				if (node.argument === null) return;
				const fn = findAncestor(node, isFunctionNode);
				if (fn === null || !isVoidReturnType(functionReturnType(fn), context)) return;
				if (
					node.argument.type === "UnaryExpression" &&
					node.argument.operator === "void" &&
					!isExplicitlyParenthesized(context.sourceCode, node.argument)
				) {
					return;
				}
				context.report({ node, messageId: "voidReturn" });
			},
		};
	},
});
