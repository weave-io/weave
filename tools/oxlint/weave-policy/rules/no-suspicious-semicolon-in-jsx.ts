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
				if (!/^\s*;\s*$/u.test(node.value)) return;
				const parent = node.parent;
				if (parent === null || parent.type !== "JSXElement") return;
				const index = parent.children.indexOf(node);
				if (index <= 0) return;
				const previous = parent.children[index - 1];
				if (
					previous?.type === "JSXElement" ||
					previous?.type === "JSXFragment"
				) {
					context.report({ node, messageId: "suspiciousSemicolon" });
				}
			},
		};
	},
});
