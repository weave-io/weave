import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

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
		const unresolvedArguments = new Set<ESTree.Node>();
		return {
			Program() {
				unresolvedArguments.clear();
				for (const scope of context.sourceCode.scopeManager.scopes) {
					for (const reference of scope.references) {
						if (
							reference.identifier.name === "arguments" &&
							(reference.resolved === null ||
								reference.resolved.defs.length === 0)
						) {
							unresolvedArguments.add(reference.identifier);
						}
					}
				}
			},
			Identifier(node) {
				if (unresolvedArguments.has(node)) {
					context.report({ node, messageId: "noArguments" });
				}
			},
		};
	},
});
