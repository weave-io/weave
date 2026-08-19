import { defineRule } from "@oxlint/plugins";

import type { Context, ESTree } from "@oxlint/plugins";

import { isExplicitlyParenthesized } from "../shared/ancestors.ts";

function withoutChain(node: ESTree.Node): ESTree.Node {
	return node.type === "ChainExpression" ? node.expression : node;
}

function staticText(node: ESTree.Node, context: Context): string | null {
	const current = withoutChain(node);
	if (current.type === "Literal" && typeof current.value === "string") {
		const raw = context.sourceCode.getText(current);
		return raw.length >= 2 ? raw.slice(1, -1) : raw;
	}
	if (current.type !== "TemplateLiteral" || current.expressions.length > 0) {
		return null;
	}
	return current.quasis.map((quasi) => quasi.value.raw).join("");
}

function memberName(member: ESTree.MemberExpression, context: Context): string | null {
	if (!member.computed && member.property.type === "Identifier") {
		return member.property.name;
	}
	if (member.computed) return staticText(member.property, context);
	return null;
}

function caseMethodName(node: ESTree.Node, context: Context): string | null {
	const current = withoutChain(node);
	if (current.type !== "CallExpression" || current.arguments.length !== 0) {
		return null;
	}
	const callee = withoutChain(current.callee);
	if (callee.type !== "MemberExpression") return null;
	const name = memberName(callee, context);
	return name === "toUpperCase" || name === "toLowerCase" ? name : null;
}

function stringLiteralText(node: ESTree.Node, context: Context): string | null {
	if (node.type === "ParenthesizedExpression") return null;
	return staticText(node, context);
}

function isCased(character: string): boolean {
	return (
		character.toUpperCase() === character &&
		character.toLowerCase() !== character
	) || (
		character.toLowerCase() === character &&
		character.toUpperCase() !== character
	);
}

function mismatchesCase(text: string, expected: "upper" | "lower"): boolean {
	for (let index = 0; index < text.length; ) {
		const character = text[index];
		if (character === undefined) break;
		if (character === "\\") {
			const escape = text[index + 1];
			if (escape === "x" || escape === "X") {
				index += 4;
			} else if (escape === "u" || escape === "U") {
				if (text[index + 2] === "{") {
					const end = text.indexOf("}", index + 3);
					index = end < 0 ? text.length : end + 1;
				} else {
					index += 6;
				}
			} else {
				index += 2;
			}
			continue;
		}

		const codePoint = text.codePointAt(index);
		if (codePoint === undefined) break;
		const codePointText = String.fromCodePoint(codePoint);
		if (isCased(codePointText)) {
			const isUpper = codePointText.toUpperCase() === codePointText;
			if ((expected === "upper" && !isUpper) || (expected === "lower" && isUpper)) {
				return true;
			}
		}
		index += codePointText.length;
	}
	return false;
}

function hasExtraSwitchParentheses(
	node: ESTree.Node,
	context: Context,
): boolean {
	const before = context.sourceCode.getTokenBefore(node);
	const after = context.sourceCode.getTokenAfter(node);
	if (before?.value !== "(" || after?.value !== ")") return false;
	return context.sourceCode.getTokenBefore(before)?.value === "(";
}

function expectedCase(method: string): "upper" | "lower" {
	return method === "toUpperCase" ? "upper" : "lower";
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
				if (node.operator !== "==" && node.operator !== "===") return;
				const leftMethod = caseMethodName(node.left, context);
				const rightMethod = caseMethodName(node.right, context);
				let call: ESTree.Node | null = null;
				let literal: ESTree.Node | null = null;
				let method: string | null = null;
				if (leftMethod !== null) {
					call = node.left;
					literal = node.right;
					method = leftMethod;
				} else if (rightMethod !== null) {
					call = node.right;
					literal = node.left;
					method = rightMethod;
				}
				if (call === null || literal === null || method === null) return;
				if (isExplicitlyParenthesized(context.sourceCode, call)) return;
				if (isExplicitlyParenthesized(context.sourceCode, literal)) return;
				const text = stringLiteralText(literal, context);
				if (text === null || !mismatchesCase(text, expectedCase(method))) return;
				context.report({
					node,
					messageId: "caseMismatch",
					data: { literal: text },
				});
			},
			SwitchStatement(node) {
				const method = caseMethodName(node.discriminant, context);
				if (method === null || hasExtraSwitchParentheses(node.discriminant, context)) {
					return;
				}
				for (const switchCase of node.cases) {
					if (switchCase.test === null) continue;
					if (isExplicitlyParenthesized(context.sourceCode, switchCase.test)) {
						continue;
					}
					const text = stringLiteralText(switchCase.test, context);
					if (text !== null && mismatchesCase(text, expectedCase(method))) {
						context.report({
							node: switchCase,
							messageId: "caseMismatch",
							data: { literal: text },
						});
					}
				}
			},
		};
	},
});
