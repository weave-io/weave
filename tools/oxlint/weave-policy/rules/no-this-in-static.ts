import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function isStaticContext(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (current.type === "PropertyDefinition" || current.type === "AccessorProperty") {
			// Biome does not treat a class-field initializer as a static
			// control-flow root, even when the field itself is static.
			return false;
		}
		if (current.type === "StaticBlock") return true;
		if (current.type === "MethodDefinition") return current.static === true;
		if (current.type === "FunctionDeclaration" || current.type === "FunctionExpression") {
			// A method's function node belongs to the method definition. Any
			// other ordinary function starts a new `this` context.
			if (
				current.parent?.type !== "MethodDefinition" ||
				current.parent.value !== current
			) {
				return false;
			}
		}
		// Arrow functions preserve the surrounding `this` context.
		current = current.parent;
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
