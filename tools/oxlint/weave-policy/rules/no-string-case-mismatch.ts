import { defineRule } from "@oxlint/plugins";

const CASE_METHODS = new Set([
	"toUpperCase",
	"toLowerCase",
	"toLocaleUpperCase",
	"toLocaleLowerCase",
]);

function caseMethodName(node: {
	type: string;
	callee?: {
		type: string;
		computed?: boolean;
		property?: { type: string; name?: string };
	};
}): string | null {
	if (node.type !== "CallExpression") return null;
	const callee = node.callee;
	if (
		callee === undefined ||
		callee.type !== "MemberExpression" ||
		callee.computed === true ||
		callee.property?.type !== "Identifier"
	) {
		return null;
	}
	return CASE_METHODS.has(callee.property.name ?? "")
		? callee.property.name
		: null;
}

function expectedCase(method: string, value: string): string {
	if (method === "toUpperCase" || method === "toLocaleUpperCase") {
		return value.toUpperCase();
	}
	return value.toLowerCase();
}

/** Disallow case-converted comparisons that cannot match the literal. */
export const noStringCaseMismatchRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow comparing a case-converted string with a literal that cannot match.",
		},
		messages: {
			caseMismatch:
				"This case conversion can never equal `{{literal}}`.",
		},
	},
	createOnce(context) {
		return {
			BinaryExpression(node) {
				if (
					node.operator !== "===" &&
					node.operator !== "!==" &&
					node.operator !== "==" &&
					node.operator !== "!="
				) {
					return;
				}
				const sides = [node.left, node.right];
				const call = sides.find((side) => caseMethodName(side) !== null);
				const literal = sides.find(
					(side) => side.type === "Literal" && typeof side.value === "string",
				);
				if (call === undefined || literal === undefined) return;
				const method = caseMethodName(call);
				if (method === null || typeof literal.value !== "string") return;
				if (literal.value !== expectedCase(method, literal.value)) {
					context.report({
						node,
						messageId: "caseMismatch",
						data: { literal: literal.value },
					});
				}
			},
		};
	},
});
