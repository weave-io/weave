import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function isUseStrictDirective(node: ESTree.Node): boolean {
	return node.type === "ExpressionStatement" && node.directive === "use strict";
}

function isFunctionBody(node: ESTree.BlockStatement): boolean {
	const parent = node.parent;
	return (
		parent?.type === "FunctionDeclaration" ||
		parent?.type === "FunctionExpression" ||
		parent?.type === "ArrowFunctionExpression"
	);
}

function hasClassAncestor(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (current.type === "ClassDeclaration" || current.type === "ClassExpression") {
			return true;
		}
		current = current.parent;
	}
	return false;
}

function hasStrictDirective(body: ESTree.Program | ESTree.BlockStatement): boolean {
	return body.body.some(isUseStrictDirective);
}

/** Disallow redundant "use strict" directives. */
export const noRedundantUseStrictRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow redundant use strict directives.",
		},
		messages: {
			redundantUseStrict: "This `\"use strict\"` directive is redundant.",
		},
	},
	createOnce(context) {
		return {
			ExpressionStatement(node) {
				if (!isUseStrictDirective(node)) return;
				const parent = node.parent;
				if (parent === null) return;
				if (hasClassAncestor(node) || context.languageOptions.sourceType === "module") {
					context.report({ node, messageId: "redundantUseStrict" });
					return;
				}

				if (parent.type === "Program") {
					const first = parent.body.find(isUseStrictDirective);
					if (first !== undefined && first !== node) {
						context.report({ node, messageId: "redundantUseStrict" });
					}
					return;
				}
				if (parent.type !== "BlockStatement" || !isFunctionBody(parent)) return;

				const first = parent.body.find(isUseStrictDirective);
				if (first !== undefined && first !== node) {
					context.report({ node, messageId: "redundantUseStrict" });
					return;
				}

				let current: ESTree.Node | null = parent.parent;
				while (current !== null) {
					if (current.type === "Program") {
						if (hasStrictDirective(current)) {
							context.report({ node, messageId: "redundantUseStrict" });
						}
						return;
					}
					if (current.type === "BlockStatement" && isFunctionBody(current)) {
						if (hasStrictDirective(current)) {
							context.report({ node, messageId: "redundantUseStrict" });
							return;
						}
					}
					current = current.parent;
				}
			},
		};
	},
});
