import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function isUseStrictDirective(node: ESTree.Node): boolean {
	return node.type === "ExpressionStatement" && node.directive === "use strict";
}

function fileIsAlwaysStrict(filename: string, program: ESTree.Program): boolean {
	if (/\.[cm]ts$|\.mjs$/u.test(filename)) return true;
	return program.body.some(
		(statement) =>
			statement.type === "ImportDeclaration" ||
			statement.type === "ExportNamedDeclaration" ||
			statement.type === "ExportDefaultDeclaration" ||
			statement.type === "ExportAllDeclaration",
	);
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
				if (parent.type === "Program") {
					if (fileIsAlwaysStrict(context.filename, parent)) {
						context.report({ node, messageId: "redundantUseStrict" });
						return;
					}
					const first = parent.body.find(isUseStrictDirective);
					if (first !== undefined && first !== node) {
						context.report({ node, messageId: "redundantUseStrict" });
					}
					return;
				}
				if (parent.type === "BlockStatement") {
					const first = parent.body.find(isUseStrictDirective);
					if (first !== undefined && first !== node) {
						context.report({ node, messageId: "redundantUseStrict" });
						return;
					}
					let current: ESTree.Node | null = parent.parent;
					while (current !== null) {
						if (current.type === "Program") {
							if (
								current.body.some(isUseStrictDirective) ||
								fileIsAlwaysStrict(context.filename, current)
							) {
								context.report({ node, messageId: "redundantUseStrict" });
							}
							return;
						}
						if (
							current.type === "BlockStatement" &&
							current.body.some(isUseStrictDirective)
						) {
							context.report({ node, messageId: "redundantUseStrict" });
							return;
						}
						current = current.parent;
					}
				}
			},
		};
	},
});
