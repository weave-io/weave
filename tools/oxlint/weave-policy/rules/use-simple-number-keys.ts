import { defineRule } from "@oxlint/plugins";

function isNonSimpleNumericKey(raw: string): boolean {
	let firstZero = false;
	let secondCharacter: string | undefined;
	let containsDot = false;
	let containsUnderscore = false;
	let largestDigit = "0";
	let isBigInt = false;

	for (let index = 0; index < raw.length; index += 1) {
		const character = raw[index];
		if (character === undefined) continue;
		if (index === 0 && character === "0" && raw.length > 1) {
			firstZero = true;
			continue;
		}
		if (character === "n") {
			isBigInt = true;
			break;
		}
		if (character === "e" || character === "E") continue;
		if (character === "_") {
			containsUnderscore = true;
			continue;
		}
		if (character === ".") {
			containsDot = true;
			continue;
		}
		if (index === 1 && /[A-Za-z]/u.test(character)) {
			secondCharacter = character;
			continue;
		}
		if (character > largestDigit) largestDigit = character;
	}

	// Decimal fractions and exponents are already simple. Numeric separators
	// are the only non-simple feature that remains in a dotted literal.
	if (containsDot) return containsUnderscore;

	if (!firstZero) return isBigInt || containsUnderscore;
	if (
		secondCharacter !== undefined &&
		"bBoOxX".includes(secondCharacter)
	) {
		return true;
	}

	// Biome treats legacy octal-shaped literals, including 0e1, as non-simple.
	// 08/09 and their exponent forms are decimal and are therefore accepted.
	if (largestDigit < "8") return true;
	return isBigInt || containsUnderscore;
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
					(key.raw === undefined || key.raw === null) ||
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
