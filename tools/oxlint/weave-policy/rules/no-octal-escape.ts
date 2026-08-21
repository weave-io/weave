import { defineRule } from "@oxlint/plugins";

const OCTAL_ESCAPE = /(?:^|[^\\])(?:\\\\)*\\([1-7][0-7]{0,2}|0[0-7]+)/u;

/** Disallow deprecated octal escape sequences in string literals. */
export const noOctalEscapeRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow octal escape sequences in string literals.",
		},
		messages: {
			octalEscape:
				"Do not use octal escape `{{raw}}`. Use a Unicode or hexadecimal escape.",
		},
	},
	createOnce(context) {
		return {
			Literal(node) {
				if (
					typeof node.value !== "string" ||
					node.raw === undefined ||
					node.raw === null
				) return;
				if (OCTAL_ESCAPE.test(node.raw)) {
					context.report({
						node,
						messageId: "octalEscape",
						data: { raw: node.raw },
					});
				}
			},
		};
	},
});
