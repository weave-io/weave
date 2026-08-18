import { describe, expect, test } from "bun:test";

import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../../..");
const pluginPath = join(repoRoot, "tools/oxlint/weave-policy/index.ts");

type Case = {
	readonly rule: string;
	readonly filename: string;
	readonly invalid: string;
	readonly valid: string;
};

const cases: readonly Case[] = [
	{
		rule: "no-arguments",
		filename: "no-arguments.js",
		invalid: "function f() { return arguments; }\n",
		valid: "function f(...args) { return args; }\n",
	},
	{
		rule: "no-this-in-static",
		filename: "no-this-in-static.js",
		invalid:
			"class A { static CONSTANT = 1; static foo() { return this.CONSTANT; } }\n",
		valid: "class A { static CONSTANT = 1; static foo() { return A.CONSTANT; } }\n",
	},
	{
		rule: "no-useless-continue",
		filename: "no-useless-continue.js",
		invalid: "for (let i = 0; i < 3; i++) { continue; }\n",
		valid:
			"for (let i = 0; i < 3; i++) { if (i === 1) continue; use(i); }\nfunction use(_value) {}\n",
	},
	{
		rule: "no-useless-string-raw",
		filename: "no-useless-string-raw.js",
		invalid: "const value = String.raw`plain`;\n",
		valid: "const value = String.raw`\\n`;\n",
	},
	{
		rule: "use-simple-number-keys",
		filename: "use-simple-number-keys.js",
		invalid: "export const value = { 0x1: 1 };\n",
		valid: "export const value = { 1: 1 };\n",
	},
	{
		rule: "no-string-case-mismatch",
		filename: "no-string-case-mismatch.js",
		invalid: 'if (s.toUpperCase() === "Abc") {}\n',
		valid: 'if (s.toUpperCase() === "ABC") {}\n',
	},
	{
		rule: "no-void-type-return",
		filename: "no-void-type-return.ts",
		invalid: "function f(): void { return undefined; }\n",
		valid: "function f(): void { return; }\n",
	},
	{
		rule: "no-dynamic-namespace-import-access",
		filename: "no-dynamic-namespace-import-access.js",
		invalid: 'import * as foo from "foo"; foo["bar"];\n',
		valid: 'import * as foo from "foo"; foo.bar;\n',
	},
	{
		rule: "no-assign-in-expressions",
		filename: "no-assign-in-expressions.js",
		invalid: "function f(a) { return a = 1; }\n",
		valid: "function f(a) { a = 1; return a; }\n",
	},
	{
		rule: "no-implicit-any-let",
		filename: "no-implicit-any-let.ts",
		invalid: "let value;\nvalue = 1;\n",
		valid: "let value: number;\nvalue = 1;\n",
	},
	{
		rule: "no-octal-escape",
		filename: "no-octal-escape.js",
		invalid: 'const foo = "Copyright \\251";\n',
		valid: 'const foo = "Copyright \\u00A9";\n',
	},
	{
		rule: "no-redundant-use-strict",
		filename: "no-redundant-use-strict.cjs",
		invalid: '"use strict";\nfunction foo() { "use strict"; }\n',
		valid: '"use strict";\nfunction foo() { return 1; }\n',
	},
	{
		rule: "no-suspicious-semicolon-in-jsx",
		filename: "no-suspicious-semicolon-in-jsx.jsx",
		invalid: "export const Component = () => <div><span />;</div>;\n",
		valid: "export const Component = () => <div><span /></div>;\n",
	},
	{
		rule: "no-flat-map-identity",
		filename: "no-flat-map-identity.js",
		invalid: "export const value = items.flatMap((item) => item);\n",
		valid: "export const value = items.flatMap((item) => item * 2);\n",
	},
	{
		rule: "no-svg-without-title",
		filename: "no-svg-without-title.jsx",
		invalid: "export const Icon = () => <svg><circle /></svg>;\n",
		valid:
			"export const Icon = () => <svg><title>Icon</title><circle /></svg>;\n",
	},
	{
		rule: "use-optional-chain",
		filename: "use-optional-chain.js",
		invalid: "export const value = foo && foo.bar;\n",
		valid: "export const value = foo?.bar;\n",
	},
	{
		rule: "use-export-type",
		filename: "use-export-type.ts",
		invalid: "interface Item {}\nexport { Item };\n",
		valid: "interface Item {}\nexport type { Item };\n",
	},
];

async function lintSource(
	rule: string,
	filename: string,
	source: string,
): Promise<string> {
	const directory = join(tmpdir(), `weave-policy-${crypto.randomUUID()}`);
	const configPath = join(directory, ".oxlintrc.json");
	const sourcePath = join(directory, filename);
	await Bun.write(
		configPath,
		`${JSON.stringify(
			{
				categories: { correctness: "off" },
				plugins: [],
				jsPlugins: [{ name: "weave-policy", specifier: pluginPath }],
				rules: { [`weave-policy/${rule}`]: "error" },
			},
			null,
			2,
		)}\n`,
	);
	await Bun.write(sourcePath, source);
	const process = Bun.spawn({
		cmd: [
			"bunx",
			"--bun",
			"oxlint",
			sourcePath,
			"-c",
			configPath,
			"--format",
			"unix",
		],
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(process.stdout).text();
	const stderr = await new Response(process.stderr).text();
	await process.exited;
	return `${stdout}\n${stderr}`;
}

describe("weave-policy Biome parity rules", () => {
	for (const fixture of cases) {
		test(`${fixture.rule} flags the invalid case and accepts the valid case`, async () => {
			const invalid = await lintSource(
				fixture.rule,
				fixture.filename,
				fixture.invalid,
			);
			const valid = await lintSource(
				fixture.rule,
				fixture.filename,
				fixture.valid,
			);
			expect(invalid).toContain(`weave-policy(${fixture.rule})`);
			expect(valid).not.toContain(`weave-policy(${fixture.rule})`);
		});
	}
});
