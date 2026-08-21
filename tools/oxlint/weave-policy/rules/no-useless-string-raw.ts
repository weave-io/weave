import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function isStringRawTag(node: ESTree.Node): boolean {
	if (node.type !== "MemberExpression") return false;
	return (
		node.computed !== true &&
		node.object.type === "Identifier" &&
		node.object.name === "String" &&
		node.property.type === "Identifier" &&
		node.property.name === "raw"
	);
}

/** Disallow String.raw when the template has no escape-like sequence. */
export const noUselessStringRawRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow String.raw on templates that contain no escape-like sequence.",
		},
		messages: {
			uselessStringRaw:
				"`String.raw` is unnecessary when the template has no escape-like sequence.",
		},
	},
	createOnce(context) {
		return {
			TaggedTemplateExpression(node) {
				if (!isStringRawTag(node.tag)) return;
				const hasEscape = node.quasi.quasis.some((quasi) =>
					quasi.value.raw.includes("\\"),
				);
				if (!hasEscape) {
					context.report({ node, messageId: "uselessStringRaw" });
				}
			},
		};
	},
});
