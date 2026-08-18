import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function unwrap(node: ESTree.Node): ESTree.Node {
	let current = node;
	while (current.type === "ChainExpression") current = current.expression;
	while (current.type === "ParenthesizedExpression") current = current.expression;
	return current;
}

function isNullishLiteral(node: ESTree.Node): boolean {
	const current = unwrap(node);
	return (
		(current.type === "Literal" && current.value === null) ||
		(current.type === "Identifier" && current.name === "undefined")
	);
}

function isNullishGuard(node: ESTree.Node, objectText: string): boolean {
	const current = unwrap(node);
	if (current.type !== "BinaryExpression") return false;
	if (
		current.operator !== "!=" &&
		current.operator !== "!==" &&
		current.operator !== "==" &&
		current.operator !== "==="
	) {
		return false;
	}
	const left = unwrap(current.left);
	const right = unwrap(current.right);
	if (isNullishLiteral(left)) {
		return sourceShape(right) === objectText;
	}
	if (isNullishLiteral(right)) {
		return sourceShape(left) === objectText;
	}
	return false;
}

function sourceShape(node: ESTree.Node): string {
	const current = unwrap(node);
	if (current.type === "Identifier") return current.name;
	if (current.type === "ThisExpression") return "this";
	if (current.type === "MemberExpression") {
		const object = sourceShape(current.object);
		if (current.computed) {
			const property =
				current.property.type === "Literal"
					? JSON.stringify(current.property.value)
					: sourceShape(current.property);
			return `${object}[${property}]`;
		}
		if (current.property.type === "Identifier") {
			return `${object}.${current.property.name}`;
		}
	}
	if (current.type === "CallExpression") {
		return `${sourceShape(current.callee)}()`;
	}
	return "";
}

function emptyObjectLiteral(node: ESTree.Node): boolean {
	const current = unwrap(node);
	return current.type === "ObjectExpression" && current.properties.length === 0;
}

/** Require optional chaining instead of equivalent logical guards. */
export const useOptionalChainRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Require optional chaining instead of equivalent && / || {} guards.",
		},
		messages: {
			preferOptionalChain: "Use optional chaining instead of this nullish guard.",
		},
	},
	createOnce(context) {
		return {
			LogicalExpression(node) {
				if (node.operator === "&&") {
					const right = unwrap(node.right);
					if (right.type !== "MemberExpression" && right.type !== "CallExpression") {
						return;
					}
					const object =
						right.type === "MemberExpression" ? right.object : right.callee;
					const objectText = sourceShape(object);
					if (objectText === "") return;
					const left = unwrap(node.left);
					if (
						sourceShape(left) === objectText ||
						isNullishGuard(left, objectText)
					) {
						context.report({ node, messageId: "preferOptionalChain" });
					}
					return;
				}
				if (node.operator !== "||") return;
				if (!emptyObjectLiteral(node.right)) return;
				const parent = node.parent;
				if (parent === null || parent.type !== "MemberExpression") return;
				if (parent.object !== node) return;
				context.report({ node: parent, messageId: "preferOptionalChain" });
			},
		};
	},
});
