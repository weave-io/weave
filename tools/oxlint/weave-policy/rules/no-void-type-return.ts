import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { findAncestor, isFunctionNode } from "../shared/ancestors.ts";

function isVoidReturnType(
	annotation: ESTree.TSTypeAnnotation | null | undefined,
): boolean {
	if (annotation == null) return false;
	let current = annotation.typeAnnotation;
	while (current.type === "TSParenthesizedType") {
		current = current.typeAnnotation;
	}
	return current.type === "TSVoidKeyword";
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
				if (fn === null || !isVoidReturnType(fn.returnType)) return;
				context.report({ node, messageId: "voidReturn" });
			},
		};
	},
});
