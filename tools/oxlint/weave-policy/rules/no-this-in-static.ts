import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import { findAncestor, isFunctionNode } from "../shared/ancestors.ts";

function isStaticContext(node: ESTree.Node): boolean {
	const owner = findAncestor(
		node,
		(current) =>
			current.type === "MethodDefinition" ||
			current.type === "PropertyDefinition" ||
			current.type === "StaticBlock",
	);
	if (owner === null) return false;
	if (owner.type === "StaticBlock") return true;
	if (
		(owner.type === "MethodDefinition" || owner.type === "PropertyDefinition") &&
		owner.static === true
	) {
		if (owner.type === "MethodDefinition") {
			const fn = findAncestor(node, isFunctionNode);
			return fn === owner.value;
		}
		return true;
	}
	return false;
}

/** Disallow `this` and `super` in static class contexts. */
export const noThisInStaticRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow this and super in static class contexts.",
		},
		messages: {
			noThisInStatic:
				"Do not use `{{kind}}` in a static context. Use the class name instead.",
		},
	},
	createOnce(context) {
		return {
			ThisExpression(node) {
				if (isStaticContext(node)) {
					context.report({
						node,
						messageId: "noThisInStatic",
						data: { kind: "this" },
					});
				}
			},
			Super(node) {
				if (isStaticContext(node)) {
					context.report({
						node,
						messageId: "noThisInStatic",
						data: { kind: "super" },
					});
				}
			},
		};
	},
});
