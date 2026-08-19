import type { ESTree, SourceCode } from "@oxlint/plugins";

/** Walk ancestors until `predicate` matches or the program root is reached. */
export function findAncestor(
	node: ESTree.Node,
	predicate: (current: ESTree.Node) => boolean,
): ESTree.Node | null {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (predicate(current)) return current;
		current = current.parent;
	}
	return null;
}

export function isLoopStatement(node: ESTree.Node): boolean {
	return (
		node.type === "ForStatement" ||
		node.type === "ForInStatement" ||
		node.type === "ForOfStatement" ||
		node.type === "WhileStatement" ||
		node.type === "DoWhileStatement"
	);
}

export function isFunctionNode(
	node: ESTree.Node,
): node is ESTree.ArrowFunctionExpression | ESTree.Function {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

/** Return true when a node is wrapped in a pair of source parentheses. */
export function isExplicitlyParenthesized(
	sourceCode: SourceCode,
	node: ESTree.Node,
): boolean {
	const before = sourceCode.getTokenBefore(node);
	const after = sourceCode.getTokenAfter(node);
	return before?.value === "(" && after?.value === ")";
}
