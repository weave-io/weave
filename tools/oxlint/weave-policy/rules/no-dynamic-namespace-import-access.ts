import { defineRule } from "@oxlint/plugins";

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
		const namespaces = new Set<string>();
		return {
			Program() {
				namespaces.clear();
			},
			ImportNamespaceSpecifier(node) {
				namespaces.add(node.local.name);
			},
			MemberExpression(node) {
				if (node.computed !== true) return;
				if (node.object.type !== "Identifier") return;
				if (!namespaces.has(node.object.name)) return;
				context.report({ node, messageId: "dynamicAccess" });
			},
		};
	},
});
