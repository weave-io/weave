import { defineRule } from "@oxlint/plugins";

import type { Context, ESTree } from "@oxlint/plugins";

import { isExplicitlyParenthesized } from "../shared/ancestors.ts";

function unwrapParentheses(node: ESTree.Node): ESTree.Node {
	let current = node;
	while (current.type === "ParenthesizedExpression") current = current.expression;
	return current;
}

function staticMemberName(node: ESTree.MemberExpression): string | null {
	if (!node.computed && node.property.type === "Identifier") {
		return node.property.name;
	}
	if (node.computed) {
		if (node.property.type === "Literal" && typeof node.property.value === "string") {
			return node.property.value;
		}
		if (node.property.type === "TemplateLiteral" && node.property.expressions.length === 0) {
			return node.property.quasis.map((quasi) => quasi.value.raw).join("");
		}
	}
	return null;
}

function firstParamName(
	fn: ESTree.ArrowFunctionExpression | ESTree.Function,
): string | null {
	if (fn.params.length !== 1) return null;
	const first = fn.params[0];
	if (
		first === undefined ||
		first.type !== "Identifier" ||
		first.typeAnnotation != null
	) {
		return null;
	}
	return first.name;
}

function returnedIdentifier(
	fn: ESTree.ArrowFunctionExpression | ESTree.Function,
	context: Context,
): string | null {
	if (fn.type === "ArrowFunctionExpression" && fn.expression) {
		const body = unwrapParentheses(fn.body);
		return body.type === "Identifier" ? body.name : null;
	}
	if (fn.body === null || fn.body.type !== "BlockStatement") return null;
	const statement = fn.body.body.find(
		(candidate) =>
			!(candidate.type === "ExpressionStatement" && candidate.directive != null),
	);
	if (statement?.type !== "ReturnStatement" || statement.argument === null) {
		return null;
	}
	if (isExplicitlyParenthesized(context.sourceCode, statement.argument)) return null;
	return statement.argument.type === "Identifier" ? statement.argument.name : null;
}

/** Disallow identity callbacks passed to Array#flatMap. */
export const noFlatMapIdentityRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Disallow identity callbacks on flatMap; use flat() instead.",
		},
		messages: {
			flatMapIdentity: "Replace identity `flatMap` with `flat()`.",
		},
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				if (node.callee.type !== "MemberExpression") return;
				if (staticMemberName(node.callee) !== "flatMap") return;
				const callback = node.arguments[0];
				if (
					callback === undefined ||
					(callback.type !== "ArrowFunctionExpression" &&
						callback.type !== "FunctionExpression")
				) {
					return;
				}
				const param = firstParamName(callback);
				const returned = returnedIdentifier(callback, context);
				if (param !== null && returned === param) {
					context.report({ node, messageId: "flatMapIdentity" });
				}
			},
		};
	},
});
