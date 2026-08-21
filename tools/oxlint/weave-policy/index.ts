import { eslintCompatPlugin } from "@oxlint/plugins";

import { noArgumentsRule } from "./rules/no-arguments.ts";
import { noAssignInExpressionsRule } from "./rules/no-assign-in-expressions.ts";
import { noDynamicNamespaceImportAccessRule } from "./rules/no-dynamic-namespace-import-access.ts";
import { noFlatMapIdentityRule } from "./rules/no-flat-map-identity.ts";
import { noImplicitAnyLetRule } from "./rules/no-implicit-any-let.ts";
import { noOctalEscapeRule } from "./rules/no-octal-escape.ts";
import { noRedundantUseStrictRule } from "./rules/no-redundant-use-strict.ts";
import { noStringCaseMismatchRule } from "./rules/no-string-case-mismatch.ts";
import { noSuspiciousSemicolonInJsxRule } from "./rules/no-suspicious-semicolon-in-jsx.ts";
import { noSvgWithoutTitleRule } from "./rules/no-svg-without-title.ts";
import { noThisInStaticRule } from "./rules/no-this-in-static.ts";
import { noUselessContinueRule } from "./rules/no-useless-continue.ts";
import { noUselessStringRawRule } from "./rules/no-useless-string-raw.ts";
import { noVoidTypeReturnRule } from "./rules/no-void-type-return.ts";
import { useExportTypeRule } from "./rules/use-export-type.ts";
import { useOptionalChainRule } from "./rules/use-optional-chain.ts";
import { useSimpleNumberKeysRule } from "./rules/use-simple-number-keys.ts";

/** Project-owned Oxlint rules that close Biome 2.4.14 recommended parity gaps. */
const weavePolicyPlugin = eslintCompatPlugin({
	meta: { name: "weave-policy" },
	rules: {
		"no-arguments": noArgumentsRule,
		"no-assign-in-expressions": noAssignInExpressionsRule,
		"no-dynamic-namespace-import-access": noDynamicNamespaceImportAccessRule,
		"no-flat-map-identity": noFlatMapIdentityRule,
		"no-implicit-any-let": noImplicitAnyLetRule,
		"no-octal-escape": noOctalEscapeRule,
		"no-redundant-use-strict": noRedundantUseStrictRule,
		"no-string-case-mismatch": noStringCaseMismatchRule,
		"no-suspicious-semicolon-in-jsx": noSuspiciousSemicolonInJsxRule,
		"no-svg-without-title": noSvgWithoutTitleRule,
		"no-this-in-static": noThisInStaticRule,
		"no-useless-continue": noUselessContinueRule,
		"no-useless-string-raw": noUselessStringRawRule,
		"no-void-type-return": noVoidTypeReturnRule,
		"use-export-type": useExportTypeRule,
		"use-optional-chain": useOptionalChainRule,
		"use-simple-number-keys": useSimpleNumberKeysRule,
	},
});

export default weavePolicyPlugin;
