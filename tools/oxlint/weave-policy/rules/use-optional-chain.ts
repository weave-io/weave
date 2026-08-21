import { defineRule } from "@oxlint/plugins";

import type { Context, ESTree, Reference } from "@oxlint/plugins";

import { isExplicitlyParenthesized } from "../shared/ancestors.ts";

type ChainPart = {
	readonly key: string;
};

function unwrapForGuard(node: ESTree.Node): ESTree.Node {
	let current = node;
	while (
		current.type === "ChainExpression" ||
		current.type === "ParenthesizedExpression"
	) {
		current = current.expression;
	}
	return current;
}

function staticText(node: ESTree.Node, context: Context): string | null {
	const current = unwrapForGuard(node);
	if (current.type === "Literal") {
		if (typeof current.value === "string") return current.value;
		return null;
	}
	if (current.type !== "TemplateLiteral" || current.expressions.length > 0) {
		return null;
	}
	return current.quasis.map((quasi) => quasi.value.raw).join("");
}

function memberKey(node: ESTree.MemberExpression, context: Context): string | null {
	if (!node.computed && node.property.type === "Identifier") {
		return `member:${node.property.name}`;
	}
	if (!node.computed && node.property.type === "PrivateIdentifier") {
		return `private:${node.property.name}`;
	}
	if (node.computed) {
		const propertyText = context.sourceCode.getText(node.property).trim();
		if (node.property.type === "Identifier") return `computed-id:${propertyText}`;
		if (node.property.type === "Literal") return `computed:${propertyText}`;
		if (
			node.property.type === "TemplateLiteral" &&
			node.property.expressions.length === 0
		) {
			return `computed:${propertyText}`;
		}
	}
	return null;
}

function chainFromExpression(
	expression: ESTree.Node,
	context: Context,
	ignoreOuterParentheses = false,
): ChainPart[] {
	let current = expression;
	const parts: ChainPart[] = [];
	while (current.type === "ChainExpression") current = current.expression;
	if (
		!ignoreOuterParentheses &&
		isExplicitlyParenthesized(context.sourceCode, current)
	) return [];

	while (true) {
		if (current.type === "MemberExpression") {
			const key = memberKey(current, context);
			if (key === null) return [];
			parts.unshift({ key });
			current = current.object;
			while (current.type === "ChainExpression") current = current.expression;
			if (current.type === "ParenthesizedExpression") return [];
			continue;
		}
		if (current.type === "CallExpression") {
			const callText = context.sourceCode.getText(current);
			const open = callText.indexOf("(");
			const close = callText.lastIndexOf(")");
			const argumentsText =
				open >= 0 && close > open
					? callText.slice(open + 1, close).trim()
					: "";
			parts.unshift({ key: `call:${argumentsText}` });
			current = current.callee;
			while (current.type === "ChainExpression") current = current.expression;
			if (current.type === "ParenthesizedExpression") return [];
			continue;
		}
		if (current.type === "Identifier") {
			parts.unshift({ key: `identifier:${current.name}` });
			return parts;
		}
		return [];
	}
}

function isPrefix(longer: readonly ChainPart[], shorter: readonly ChainPart[]): boolean {
	if (shorter.length === 0 || longer.length <= shorter.length) return false;
	return shorter.every((part, index) => part.key === longer[index]?.key);
}

function isEqual(left: readonly ChainPart[], right: readonly ChainPart[]): boolean {
	return (
		left.length === right.length &&
		left.every((part, index) => part.key === right[index]?.key)
	);
}

function isNullish(node: ESTree.Node, context: Context): boolean {
	if (isExplicitlyParenthesized(context.sourceCode, node)) return false;
	let current = node;
	while (current.type === "ChainExpression") current = current.expression;
	return (
		(current.type === "Literal" && current.value === null) ||
		(current.type === "Identifier" && current.name === "undefined")
	);
}

function isUndefinedString(node: ESTree.Node, context: Context): boolean {
	if (
		node.type === "ParenthesizedExpression" ||
		isExplicitlyParenthesized(context.sourceCode, node)
	) return false;
	return staticText(node, context) === "undefined";
}

function rootIdentifier(node: ESTree.Node): ESTree.Node | null {
	let current = unwrapForGuard(node);
	while (true) {
		if (current.type === "MemberExpression") {
			current = unwrapForGuard(current.object);
			continue;
		}
		if (current.type === "CallExpression") {
			current = unwrapForGuard(current.callee);
			continue;
		}
		return current.type === "Identifier" ? current : null;
	}
}

function isUnboundRoot(
	node: ESTree.Node,
	references: ReadonlyMap<ESTree.Node, Reference>,
): boolean {
	const root = rootIdentifier(node);
	if (root === null) return false;
	const reference = references.get(root);
	return reference === undefined || reference.resolved === null;
}

function nullishGuard(
	node: ESTree.Node,
	context: Context,
	references: ReadonlyMap<ESTree.Node, Reference>,
): ESTree.Node | null {
	let current = node;
	while (current.type === "ChainExpression") current = current.expression;
	if (current.type !== "BinaryExpression") return null;
	if (isExplicitlyParenthesized(context.sourceCode, current)) return null;
	if (current.operator !== "!=" && current.operator !== "!==") return null;
	let left = current.left;
	let right = current.right;
	while (left.type === "ChainExpression") left = left.expression;
	while (right.type === "ChainExpression") right = right.expression;
	const leftIsNullish = isNullish(left, context);
	const rightIsNullish = isNullish(right, context);
	if (leftIsNullish !== rightIsNullish) {
		// Unlike a typeof guard, a direct nullish comparison also works
		// for an undeclared/global reference and is still an optional-chain
		// candidate.
		return leftIsNullish ? right : left;
	}
	if (left.type === "UnaryExpression" && left.operator === "typeof" && isUndefinedString(right, context)) {
		const candidate = unwrapForGuard(left.argument);
		return isUnboundRoot(candidate, references) ? null : candidate;
	}
	if (right.type === "UnaryExpression" && right.operator === "typeof" && isUndefinedString(left, context)) {
		const candidate = unwrapForGuard(right.argument);
		return isUnboundRoot(candidate, references) ? null : candidate;
	}
	return null;
}

function chainForBranch(
	node: ESTree.Node,
	context: Context,
	references: ReadonlyMap<ESTree.Node, Reference>,
): ChainPart[] {
	const guard = nullishGuard(node, context, references);
	let ignoreParentheses = false;
	if (guard !== null) {
		let current = node;
		while (current.type === "ChainExpression") current = current.expression;
		if (current.type === "BinaryExpression") {
			let left = current.left;
			let right = current.right;
			while (left.type === "ChainExpression") left = left.expression;
			while (right.type === "ChainExpression") right = right.expression;
			ignoreParentheses =
				(left.type === "UnaryExpression" &&
					left.operator === "typeof" &&
					isUndefinedString(right, context)) ||
				(right.type === "UnaryExpression" &&
					right.operator === "typeof" &&
					isUndefinedString(left, context));
		}
	}
	return chainFromExpression(guard ?? node, context, ignoreParentheses);
}

function andBranches(node: ESTree.Node): ESTree.Node[] {
	if (node.type === "LogicalExpression" && node.operator === "&&") {
		return [...andBranches(node.left), node.right];
	}
	return [node];
}

function negatedExpression(node: ESTree.Node): ESTree.Node | null {
	const current = unwrapForGuard(node);
	if (current.type !== "UnaryExpression" || current.operator !== "!") return null;
	return unwrapForGuard(current.argument);
}

function isNegatedOrChain(node: ESTree.LogicalExpression): boolean {
	if (node.operator !== "||" || negatedExpression(node.right) === null) return false;
	let current: ESTree.Node = node.left;
	while (current.type === "LogicalExpression" && current.operator === "||") {
		if (negatedExpression(current.right) === null) return false;
		current = current.left;
	}
	return negatedExpression(current) !== null;
}

function negatedBranches(node: ESTree.Node): ESTree.Node[] {
	if (node.type === "LogicalExpression" && node.operator === "||") {
		return [...negatedBranches(node.left), node.right];
	}
	return [node];
}

function isInsideAnotherAndChain(
	node: ESTree.LogicalExpression,
	context: Context,
	references: ReadonlyMap<ESTree.Node, Reference>,
): boolean {
	const parent = node.parent;
	if (parent?.type !== "LogicalExpression" || parent.operator !== "&&" || parent.left !== node) {
		return false;
	}
	const current = chainForBranch(node.right, context, references);
	const outer = chainForBranch(parent.right, context, references);
	return isEqual(outer, current) || isPrefix(outer, current);
}

function isInsideAnotherNegatedChain(
	node: ESTree.LogicalExpression,
	context: Context,
): boolean {
	const parent = node.parent;
	if (parent?.type !== "LogicalExpression" || parent.operator !== "||" || parent.left !== node) {
		return false;
	}
	const currentExpression = negatedExpression(node.right);
	const outerExpression = negatedExpression(parent.right);
	if (currentExpression === null || outerExpression === null) return false;
	const current = chainFromExpression(currentExpression, context, true);
	const outer = chainFromExpression(outerExpression, context, true);
	return isEqual(outer, current) || isPrefix(outer, current);
}

function findMemberParent(node: ESTree.Node): ESTree.MemberExpression | null {
	let current: ESTree.Node | null = node.parent;
	while (current !== null) {
		if (current.type === "MemberExpression") return current;
		if (current.type === "ParenthesizedExpression" || current.type === "AwaitExpression") {
			current = current.parent;
			continue;
		}
		// Oxlint parses `await (value || {})` in a script as a call to
		// an identifier named `await`; Biome's JS AST represents the same
		// source as an await expression. Keep that parser-only wrapper.
		if (
			current.type === "CallExpression" &&
			current.callee.type === "Identifier" &&
			current.callee.name === "await"
		) {
			current = current.parent;
			continue;
		}
		break;
	}
	return null;
}

function isEmptyObject(node: ESTree.Node): boolean {
	const current = unwrapForGuard(node);
	return current.type === "ObjectExpression" && current.properties.length === 0;
}

function isWrapper(node: ESTree.Node): boolean {
	return (
		node.type === "ParenthesizedExpression" ||
		node.type === "AwaitExpression" ||
		node.type === "CallExpression" ||
		node.type === "NewExpression" ||
		node.type === "TSAsExpression" ||
		node.type === "TSSatisfiesExpression" ||
		node.type === "TSNonNullExpression" ||
		node.type === "TSTypeAssertion"
	);
}

function isInsideAnotherFallback(node: ESTree.LogicalExpression): boolean {
	const member = findMemberParent(node);
	if (member === null) return false;
	let current: ESTree.Node | null = member.parent;
	while (current !== null && isWrapper(current)) current = current.parent;
	if (current?.type !== "LogicalExpression") return false;
	if (current.operator !== "||" && current.operator !== "??") return false;
	if (!isEmptyObject(current.right)) return false;
	return findMemberParent(current) !== null;
}

function hasAndMatch(
	node: ESTree.LogicalExpression,
	context: Context,
	references: ReadonlyMap<ESTree.Node, Reference>,
): boolean {
	const right = chainForBranch(node.right, context, references);
	if (right.length < 2) return false;
	for (const branch of andBranches(node.left)) {
		const left = chainForBranch(branch, context, references);
		if (isPrefix(right, left)) return true;
	}
	return false;
}

function hasNegatedMatch(node: ESTree.LogicalExpression, context: Context): boolean {
	const rightExpression = negatedExpression(node.right);
	if (rightExpression === null) return false;
	const right = chainFromExpression(rightExpression, context, true);
	if (right.length < 2) return false;
	for (const branch of negatedBranches(node.left)) {
		const expression = negatedExpression(branch);
		if (expression === null) continue;
		if (isPrefix(right, chainFromExpression(expression, context, true))) return true;
	}
	return false;
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
		const references = new Map<ESTree.Node, Reference>();
		return {
			Program() {
				references.clear();
				for (const scope of context.sourceCode.scopeManager.scopes) {
					for (const reference of scope.references) {
						references.set(reference.identifier, reference);
					}
				}
			},
			LogicalExpression(node) {
				if (node.operator === "&&") {
					if (isInsideAnotherAndChain(node, context, references)) return;
					if (hasAndMatch(node, context, references)) {
						context.report({ node, messageId: "preferOptionalChain" });
					}
					return;
				}
				if (
					node.operator === "||" &&
					isNegatedOrChain(node) &&
					!isInsideAnotherNegatedChain(node, context) &&
					hasNegatedMatch(node, context)
				) {
					context.report({ node, messageId: "preferOptionalChain" });
					return;
				}
				if (node.operator !== "||" && node.operator !== "??") return;
				if (!isEmptyObject(node.right) || isInsideAnotherFallback(node)) return;
				const member = findMemberParent(node);
				if (member !== null) {
					context.report({ node: member, messageId: "preferOptionalChain" });
				}
			},
		};
	},
});
