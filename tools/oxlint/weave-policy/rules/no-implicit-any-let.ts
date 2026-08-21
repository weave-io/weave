import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function bindingTypeAnnotation(
	id: ESTree.BindingPattern,
): ESTree.TSTypeAnnotation | null | undefined {
	if (id.type === "AssignmentPattern") return id.left.typeAnnotation;
	return id.typeAnnotation;
}

function isTypeScriptSource(filename: string): boolean {
	return /\.(?:c|m)?tsx?$/u.test(filename) && !/\.d\.(?:c|m)?tsx?$/u.test(filename);
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
			VariableDeclaration(node) {
				if (!isTypeScriptSource(context.filename)) return;
				if (node.kind !== "let" && node.kind !== "var") return;
				for (const declarator of node.declarations) {
					if (declarator.init !== null) continue;
					// Biome reports the first identifier declarator in a
					// declaration. Destructuring patterns are not diagnosed.
					if (declarator.id.type !== "Identifier") continue;
					if (bindingTypeAnnotation(declarator.id) != null) continue;
					context.report({ node: declarator.id, messageId: "implicitAnyLet" });
					return;
				}
			},
		};
	},
});
