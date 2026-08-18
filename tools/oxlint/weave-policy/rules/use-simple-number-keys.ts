import { defineRule } from "@oxlint/plugins";

function isNonSimpleNumericKey(raw: string): boolean {
	return (
		raw.endsWith("n") ||
		raw.includes("_") ||
		raw.includes(".") ||
		/^0[box]/iu.test(raw)
	);
}

/** Disallow non-base-10 or separator-bearing numeric object keys. */
export const useSimpleNumberKeysRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow numeric object keys that are not plain base-10 literals.",
		},
		messages: {
			simpleNumberKey:
				"Use a plain base-10 number key instead of `{{raw}}`.",
		},
	},
	createOnce(context) {
		return {
			Property(node) {
				if (node.computed || node.key.type !== "Literal") return;
				const key = node.key;
				if (
					!("raw" in key) ||
					key.raw === undefined ||
					(typeof key.value !== "number" && typeof key.value !== "bigint")
				) {
					return;
				}
				if (isNonSimpleNumericKey(key.raw)) {
					context.report({
						node: key,
						messageId: "simpleNumberKey",
						data: { raw: key.raw },
					});
				}
			},
		};
	},
});
