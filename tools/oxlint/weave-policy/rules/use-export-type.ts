import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function exportedName(name: ESTree.ModuleExportName): string | null {
	return name.type === "Identifier" ? name.name : null;
}

function addDeclaredTypes(body: readonly ESTree.Statement[], types: Set<string>): void {
	for (const statement of body) {
		const declaration =
			statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
		if (
			declaration?.type === "TSTypeAliasDeclaration" ||
			declaration?.type === "TSInterfaceDeclaration"
		) {
			types.add(declaration.id.name);
		}
		if (statement.type === "ImportDeclaration") {
			if (statement.importKind === "type") {
				for (const specifier of statement.specifiers) {
					types.add(specifier.local.name);
				}
				continue;
			}
			for (const specifier of statement.specifiers) {
				if ("importKind" in specifier && specifier.importKind === "type") {
					types.add(specifier.local.name);
				}
			}
		}
	}
}

/** Require export type when every exported binding is type-only. */
export const useExportTypeRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Require export type for type-only named exports.",
		},
		messages: {
			useExportType: "Export type-only bindings with `export type`.",
		},
	},
	createOnce(context) {
		const typeBindings = new Set<string>();
		return {
			Program(node) {
				typeBindings.clear();
				addDeclaredTypes(node.body, typeBindings);
			},
			ExportNamedDeclaration(node) {
				if (node.exportKind === "type" || node.source !== null) return;
				if (node.specifiers.length === 0) return;
				const unmarked = node.specifiers.filter((specifier) => {
					if (specifier.exportKind === "type") return false;
					const name = exportedName(specifier.local);
					return name !== null && typeBindings.has(name);
				});
				if (unmarked.length > 0) {
					context.report({ node, messageId: "useExportType" });
				}
			},
		};
	},
});
