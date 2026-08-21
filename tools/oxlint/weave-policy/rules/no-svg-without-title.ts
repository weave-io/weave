import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function jsxName(name: ESTree.JSXOpeningElement["name"]): string | null {
	if (name.type === "JSXIdentifier") return name.name;
	return null;
}

function attributeName(attribute: ESTree.JSXAttribute): string | null {
	return attribute.name.type === "JSXIdentifier" ? attribute.name.name : null;
}

function staticAttributeValue(attribute: ESTree.JSXAttribute): string | null {
	if (attribute.value === null) return null;
	if (attribute.value.type === "Literal") {
		if (typeof attribute.value.value === "string") return attribute.value.value;
		if (typeof attribute.value.value === "boolean") {
			return String(attribute.value.value);
		}
	}
	if (attribute.value.type === "JSXExpressionContainer") {
		const expression = attribute.value.expression;
		if (expression.type === "Literal") {
			if (typeof expression.value === "string") return expression.value;
			if (typeof expression.value === "boolean") return String(expression.value);
		}
	}
	return null;
}

function attributes(element: ESTree.JSXOpeningElement): ESTree.JSXAttribute[] {
	return element.attributes.filter(
		(attribute): attribute is ESTree.JSXAttribute => attribute.type === "JSXAttribute",
	);
}

function hasValidTitle(element: ESTree.JSXElement): boolean {
	// Biome intentionally checks the first element child after the initial
	// child-list slot. In formatted JSX that slot is the leading whitespace.
	const candidate = element.children[1];
	if (candidate?.type !== "JSXElement") return false;
	if (jsxName(candidate.openingElement.name) !== "title") return false;
	return candidate.children.length > 0;
}

function hasMatchingLabelledBy(
	attribute: ESTree.JSXAttribute | undefined,
	element: ESTree.JSXElement,
): boolean {
	if (attribute === undefined) return false;
	const label = staticAttributeValue(attribute);
	if (label === null) return false;
	return element.children.some((child) => {
		if (child.type !== "JSXElement" || child.openingElement.selfClosing) {
			return false;
		}
		const id = attributes(child.openingElement).find(
			(candidate) => attributeName(candidate) === "id",
		);
		return id !== undefined && staticAttributeValue(id) === label;
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
				const svgAttributes = attributes(node.openingElement);
				const hidden = svgAttributes.find(
					(attribute) => attributeName(attribute) === "aria-hidden",
				);
				if (hidden !== undefined && staticAttributeValue(hidden) === "true") return;
				if (hasValidTitle(node)) return;

				const roleAttribute = svgAttributes.find(
					(attribute) => attributeName(attribute) === "role",
				);
				const role = roleAttribute === undefined
					? null
					: staticAttributeValue(roleAttribute);
				// Presentation roles do not require an accessible name. Other
				// roles (including SVG's default image role) do.
				if (role === "presentation" || role === "none") return;

				const ariaLabel = svgAttributes.find(
					(attribute) => attributeName(attribute) === "aria-label",
				);
				const ariaLabelledBy = svgAttributes.find(
					(attribute) => attributeName(attribute) === "aria-labelledby",
				);
				if (ariaLabel !== undefined || hasMatchingLabelledBy(ariaLabelledBy, node)) {
					return;
				}
				context.report({ node: node.openingElement, messageId: "missingTitle" });
			},
		};
	},
});
