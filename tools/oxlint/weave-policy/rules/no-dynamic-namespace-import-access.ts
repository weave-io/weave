import { defineRule } from "@oxlint/plugins";

import type { ESTree, Reference } from "@oxlint/plugins";

/** Disallow computed access on namespace imports. */
export const noDynamicNamespaceImportAccessRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow computed member access on namespace imports.",
		},
		messages: {
			dynamicAccess:
				"Do not dynamically access a namespace import. Use a static property or a named import.",
		},
	},
	createOnce(context) {
		const namespaceIdentifiers = new Set<ESTree.Node>();
		const references = new Map<ESTree.Node, Reference>();
		return {
			Program() {
				namespaceIdentifiers.clear();
				references.clear();
				for (const scope of context.sourceCode.scopeManager.scopes) {
					for (const reference of scope.references) {
						references.set(reference.identifier, reference);
					}
				}
			},
			ImportNamespaceSpecifier(node) {
				if (node.parent?.type === "ImportDeclaration" && node.parent.importKind === "type") {
					return;
				}
				namespaceIdentifiers.add(node.local);
			},
			MemberExpression(node) {
				if (!node.computed || node.object.type !== "Identifier") return;
				const reference = references.get(node.object);
				if (
					reference?.resolved?.identifiers.some((identifier) =>
						namespaceIdentifiers.has(identifier),
					)
				) {
					context.report({ node, messageId: "dynamicAccess" });
				}
			},
		};
	},
});
