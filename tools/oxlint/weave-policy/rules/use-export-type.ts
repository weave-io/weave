import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function isTypeScriptSource(filename: string): boolean {
	return /\.(?:c|m)?tsx?$/u.test(filename) && !/\.d\.(?:c|m)?tsx?$/u.test(filename);
}

function exportedName(name: ESTree.ModuleExportName): string | null {
	return name.type === "Identifier" ? name.name : null;
}

function addPatternBindings(pattern: ESTree.Node, names: Set<string>): void {
	switch (pattern.type) {
		case "Identifier":
			names.add(pattern.name);
			return;
		case "AssignmentPattern":
			addPatternBindings(pattern.left, names);
			return;
		case "RestElement":
			addPatternBindings(pattern.argument, names);
			return;
		case "ArrayPattern":
			for (const element of pattern.elements) {
				if (element !== null) addPatternBindings(element, names);
			}
			return;
		case "ObjectPattern":
			for (const property of pattern.properties) {
				if (property.type === "RestElement") {
					addPatternBindings(property.argument, names);
				} else {
					addPatternBindings(property.value, names);
				}
			}
			return;
		default:
			return;
	}
}

function addDeclarationBindings(
	declaration: ESTree.Node | null | undefined,
	typeBindings: Set<string>,
	valueBindings: Set<string>,
): void {
	if (declaration == null) return;
	switch (declaration.type) {
		case "TSTypeAliasDeclaration":
		case "TSInterfaceDeclaration":
			typeBindings.add(declaration.id.name);
			return;
		case "VariableDeclaration":
			for (const declarator of declaration.declarations) {
				addPatternBindings(declarator.id, valueBindings);
			}
			return;
		case "FunctionDeclaration":
		case "ClassDeclaration":
			if (declaration.id !== null) valueBindings.add(declaration.id.name);
			return;
		case "TSEnumDeclaration":
		case "TSModuleDeclaration":
		case "TSImportEqualsDeclaration":
			if (declaration.id.type === "Identifier") {
				valueBindings.add(declaration.id.name);
			}
			return;
		default:
			return;
	}
}

function addDeclaredBindings(
	body: readonly ESTree.Statement[],
	typeBindings: Set<string>,
	valueBindings: Set<string>,
): void {
	for (const statement of body) {
		if (statement.type === "ImportDeclaration") {
			for (const specifier of statement.specifiers) {
				const isType =
					statement.importKind === "type" ||
					(specifier.type === "ImportSpecifier" && specifier.importKind === "type");
				if (isType) typeBindings.add(specifier.local.name);
				else valueBindings.add(specifier.local.name);
			}
			continue;
		}
		if (statement.type === "ExportNamedDeclaration") {
			addDeclarationBindings(statement.declaration, typeBindings, valueBindings);
			continue;
		}
		if (statement.type === "ExportDefaultDeclaration") {
			addDeclarationBindings(statement.declaration, typeBindings, valueBindings);
			continue;
		}
		addDeclarationBindings(statement, typeBindings, valueBindings);
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
		const valueBindings = new Set<string>();
		return {
			Program(node) {
				typeBindings.clear();
				valueBindings.clear();
				if (!isTypeScriptSource(context.filename)) return;
				addDeclaredBindings(node.body, typeBindings, valueBindings);
				for (const name of valueBindings) typeBindings.delete(name);
			},
			ExportNamedDeclaration(node) {
				if (!isTypeScriptSource(context.filename) || node.specifiers.length === 0) return;
				const hasInlineType = node.specifiers.some(
					(specifier) => specifier.exportKind === "type",
				);
				if (node.exportKind === "type") {
					if (hasInlineType) {
						context.report({ node, messageId: "useExportType" });
					}
					return;
				}

				// Re-exports have no local semantic binding. Their inline type
				// markers are still enough to establish an all-type export.
				if (node.source !== null) {
					if (node.specifiers.every((specifier) => specifier.exportKind === "type")) {
						context.report({ node, messageId: "useExportType" });
					}
					return;
				}

				let allTypeOnly = true;
				let hasUnmarkedType = false;
				for (const specifier of node.specifiers) {
					if (specifier.exportKind === "type") continue;
					const name = exportedName(specifier.local);
					// Biome's semantic `all` check treats an unresolved local
					// export as type-only. A known value binding is the only
					// reason for this specifier to be a value export.
					const isTypeOnly = name !== null && !valueBindings.has(name);
					if (!isTypeOnly) allTypeOnly = false;
					else hasUnmarkedType = true;
				}
				if (allTypeOnly || hasUnmarkedType) {
					context.report({ node, messageId: "useExportType" });
				}
			},
		};
	},
});
