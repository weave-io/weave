import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function jsxName(name: ESTree.JSXOpeningElement["name"]): string | null {
	if (name.type === "JSXIdentifier") return name.name;
	return null;
}

function attributeName(attribute: ESTree.JSXAttribute): string | null {
	return attribute.name.type === "JSXIdentifier" ? attribute.name.name : null;
}

function attributeLiteral(
	attribute: ESTree.JSXAttribute,
): string | null {
	if (attribute.value === null) return "";
	if (attribute.value.type === "Literal" && typeof attribute.value.value === "string") {
		return attribute.value.value;
	}
	if (
		attribute.value.type === "JSXExpressionContainer" &&
		attribute.value.expression.type === "Literal" &&
		typeof attribute.value.expression.value === "string"
	) {
		return attribute.value.expression.value;
	}
	return null;
}

function hasNonEmptyTitle(element: ESTree.JSXElement): boolean {
	return element.children.some((child) => {
		if (child.type !== "JSXElement") return false;
		if (jsxName(child.openingElement.name) !== "title") return false;
		return child.children.some(
			(titleChild) =>
				titleChild.type === "JSXText" && titleChild.value.trim() !== "",
		);
	});
}

/** Require an accessible name on svg elements. */
export const noSvgWithoutTitleRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Require a title child or role=img plus an accessible name on svg elements.",
		},
		messages: {
			missingTitle:
				"Give this `svg` a non-empty `<title>` or `role=\"img\"` with `aria-label` / `aria-labelledby`.",
		},
	},
	createOnce(context) {
		return {
			JSXElement(node) {
				if (jsxName(node.openingElement.name) !== "svg") return;
				if (hasNonEmptyTitle(node)) return;
				const attributes = node.openingElement.attributes.filter(
					(attribute): attribute is ESTree.JSXAttribute =>
						attribute.type === "JSXAttribute",
				);
				const role = attributes.find(
					(attribute) => attributeName(attribute) === "role",
				);
				const labelled =
					attributes.some((attribute) => attributeName(attribute) === "aria-label") ||
					attributes.some(
						(attribute) => attributeName(attribute) === "aria-labelledby",
					);
				if (role !== undefined && attributeLiteral(role) === "img" && labelled) {
					return;
				}
				context.report({ node: node.openingElement, messageId: "missingTitle" });
			},
		};
	},
});
