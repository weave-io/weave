import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function bindingTypeAnnotation(
	id: ESTree.BindingPattern,
): ESTree.TSTypeAnnotation | null | undefined {
	if (id.type === "AssignmentPattern") {
		return id.left.typeAnnotation;
	}
	return id.typeAnnotation;
}

/** Disallow uninitialized let/var bindings with no type annotation. */
export const noImplicitAnyLetRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow let/var declarations that are implicit any because they have no initializer or annotation.",
		},
		messages: {
			implicitAnyLet:
				"This binding is implicit `any`. Initialize it or give it a type annotation.",
		},
	},
	createOnce(context) {
		return {
			VariableDeclarator(node) {
				const declaration = node.parent;
				if (declaration === null || declaration.type !== "VariableDeclaration") {
					return;
				}
				if (declaration.kind !== "let" && declaration.kind !== "var") return;
				if (node.init !== null) return;
				if (bindingTypeAnnotation(node.id) != null) return;
				context.report({ node: node.id, messageId: "implicitAnyLet" });
			},
		};
	},
});
