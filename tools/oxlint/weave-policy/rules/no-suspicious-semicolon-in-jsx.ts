import { defineRule } from "@oxlint/plugins";

/** Disallow a stray semicolon text node after a JSX child. */
export const noSuspiciousSemicolonInJsxRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow suspicious semicolons inside JSX children.",
		},
		messages: {
			suspiciousSemicolon:
				"This semicolon looks like a leftover after a JSX child.",
		},
	},
	createOnce(context) {
		return {
			JSXText(node) {
				// Biome's JSX text rule looks for a semicolon followed by a
				// line break. A same-line semicolon is ordinary text.
				if (!node.value.startsWith(";\n") && !node.value.startsWith(";\r")) {
					return;
				}
				context.report({ node, messageId: "suspiciousSemicolon" });
			},
		};
	},
});
