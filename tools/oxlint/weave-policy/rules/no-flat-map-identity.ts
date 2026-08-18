import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function firstParamName(
	fn: ESTree.ArrowFunctionExpression | ESTree.Function,
): string | null {
	const first = fn.params[0];
	return first?.type === "Identifier" ? first.name : null;
}

function returnedIdentifier(
	fn: ESTree.ArrowFunctionExpression | ESTree.Function,
): string | null {
	if (fn.type === "ArrowFunctionExpression" && fn.expression) {
		return fn.body.type === "Identifier" ? fn.body.name : null;
	}
	if (fn.body === null || fn.body.type !== "BlockStatement") return null;
	if (fn.body.body.length !== 1) return null;
	const only = fn.body.body[0];
	if (only === undefined || only.type !== "ReturnStatement") return null;
	return only.argument?.type === "Identifier" ? only.argument.name : null;
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
				if (node.callee.type !== "MemberExpression" || node.callee.computed) {
					return;
				}
				if (
					node.callee.property.type !== "Identifier" ||
					node.callee.property.name !== "flatMap"
				) {
					return;
				}
				const callback = node.arguments[0];
				if (
					callback === undefined ||
					(callback.type !== "ArrowFunctionExpression" &&
						callback.type !== "FunctionExpression")
				) {
					return;
				}
				const param = firstParamName(callback);
				const returned = returnedIdentifier(callback);
				if (param !== null && returned === param) {
					context.report({ node, messageId: "flatMapIdentity" });
				}
			},
		};
	},
});
