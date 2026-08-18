import { defineRule } from "@oxlint/plugins";

/** Disallow the `arguments` object. */
export const noArgumentsRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow the arguments object; use rest parameters.",
		},
		messages: {
			noArguments: "Do not use `arguments`. Use a rest parameter instead.",
		},
	},
	createOnce(context) {
		return {
			Identifier(node) {
				if (node.name !== "arguments") return;
				const parent = node.parent;
				if (parent === null) return;
				if (
					(parent.type === "VariableDeclarator" && parent.id === node) ||
					(parent.type === "Property" &&
						parent.key === node &&
						parent.shorthand !== true) ||
					parent.type === "FunctionDeclaration" ||
					parent.type === "FunctionExpression"
				) {
					return;
				}
				context.report({ node, messageId: "noArguments" });
			},
		};
	},
});
