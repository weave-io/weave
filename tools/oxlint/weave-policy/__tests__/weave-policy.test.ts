import { beforeAll, describe, expect, test } from "bun:test";

import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../../..");
const pluginPath = join(repoRoot, "tools/oxlint/weave-policy/index.ts");
const biomeCliPath = join(repoRoot, "node_modules/@biomejs/biome/bin/biome");

type EdgeCase = {
	readonly filename?: string;
	readonly source: string;
	readonly expected: "invalid" | "valid";
};

type Case = {
	readonly rule: string;
	readonly filename: string;
	readonly invalid: string;
	readonly valid: string;
	readonly edgeCases?: readonly EdgeCase[];
};

type BiomeParityCase = {
	readonly customRule: string;
	readonly biomeRule: string;
	readonly filename: string;
	readonly source: string;
	readonly expected: boolean;
};

const biomeParityRegressions: readonly BiomeParityCase[] = [
	{
		customRule: "use-optional-chain",
		biomeRule: "useOptionalChain",
		filename: "use-optional-chain-biome-regression.js",
		source: "foo && foo[`bar`];\n",
		expected: true,
	},
	{
		customRule: "no-flat-map-identity",
		biomeRule: "noFlatMapIdentity",
		filename: "no-flat-map-identity-biome-regression.js",
		source: "items.flatMap(item => { return (item); });\n",
		expected: false,
	},
];

const cases: readonly Case[] = [
	{
		rule: "no-arguments",
		filename: "no-arguments.js",
		invalid: "function f() { return arguments; }\n",
		valid: "function f(...args) { return args; }\n",
		edgeCases: [
			{
				filename: "no-arguments.cjs",
				source: "function f(arguments) { return arguments; }\n",
				expected: "valid",
			},
			{
				filename: "no-arguments.cjs",
				source: "function f() { return { arguments: 1 }; }\n",
				expected: "valid",
			},
			{
				filename: "no-arguments.cjs",
				source: "function f() { return ({ arguments }); }\n",
				expected: "invalid",
			},
		],
	},
	{
		rule: "no-this-in-static",
		filename: "no-this-in-static.js",
		invalid:
			"class A { static CONSTANT = 1; static foo() { return this.CONSTANT; } }\n",
		valid: "class A { static CONSTANT = 1; static foo() { return A.CONSTANT; } }\n",
		edgeCases: [
			{
				source: "class A { static foo() { return () => this; } }\n",
				expected: "invalid",
			},
			{
				source: "class A { static [this.key]() {} }\n",
				expected: "invalid",
			},
			{
				source: "class A { static field = this; }\n",
				expected: "valid",
			},
			{
				source:
					"class A { static foo() { return function () { return this; }; } }\n",
				expected: "valid",
			},
		],
	},
	{
		rule: "no-useless-continue",
		filename: "no-useless-continue.js",
		invalid: "for (let i = 0; i < 3; i++) { continue; }\n",
		valid:
			"for (let i = 0; i < 3; i++) { if (i === 1) continue; use(i); }\nfunction use(_value) {}\n",
		edgeCases: [
			{
				source: "while (ready) { if (skip) { continue; } }\n",
				expected: "invalid",
			},
			{
				source: "while (ready) { if (skip) { continue; } use(); }\n",
				expected: "valid",
			},
			{
				source: "loop: while (ready) { continue loop; }\n",
				expected: "invalid",
			},
			{
				source: "while (ready) { switch (ready) { case true: continue; } }\n",
				expected: "valid",
			},
		],
	},
	{
		rule: "no-useless-string-raw",
		filename: "no-useless-string-raw.js",
		invalid: "const value = String.raw`plain`;\n",
		valid: "const value = String.raw`\\n`;\n",
		edgeCases: [
			{
				source: "const value = String.raw`${interpolation}`;\n",
				expected: "invalid",
			},
			{
				source: "const value = String.raw`\\\\`;\n",
				expected: "valid",
			},
			{
				source: "const value = String[\"raw\"]`plain`;\n",
				expected: "valid",
			},
		],
	},
	{
		rule: "use-simple-number-keys",
		filename: "use-simple-number-keys.js",
		invalid: "export const value = { 0x1: 1 };\n",
		valid: "export const value = { 1: 1 };\n",
		edgeCases: [
			{
				source: "const value = { 1.0: 1, 0.1: 2, 3.1e12: 3 };\n",
				expected: "valid",
			},
			{
				filename: "use-simple-number-keys.cjs",
				source: "const value = { 01: 1, 00: 2, 0e1: 3, 08: 4 };\n",
				expected: "invalid",
			},
			{
				source: "const value = { [0x1]: 1, [1_000]: 2 };\n",
				expected: "valid",
			},
			{
				source: "const value = { 1_000: 1, 1n: 2 };\n",
				expected: "invalid",
			},
		],
	},
	{
		rule: "no-string-case-mismatch",
		filename: "no-string-case-mismatch.js",
		invalid: 'if (s.toUpperCase() === "Abc") {}\n',
		valid: 'if (s.toUpperCase() === "ABC") {}\n',
		edgeCases: [
			{
				source: 'if (s.toUpperCase() != "abc") {}\n',
				expected: "valid",
			},
			{
				source: 'if (s["toUpperCase"]() === "abc") {}\n',
				expected: "invalid",
			},
			{
				source: 'switch (s.toUpperCase()) { case "abc": break; }\n',
				expected: "invalid",
			},
			{
				source: 'if (s.toLocaleUpperCase() === "abc") {}\n',
				expected: "valid",
			},
			{
				source: 'if (s.toUpperCase(1) === "abc") {}\n',
				expected: "valid",
			},
			{
				source: 'if (s.toUpperCase() === "\\u0061BC") {}\n',
				expected: "valid",
			},
		],
	},
	{
		rule: "no-void-type-return",
		filename: "no-void-type-return.ts",
		invalid: "function f(): void { return undefined; }\n",
		valid: "function f(): void { return; }\n",
		edgeCases: [
			{
				source: "function f(): (void) { return 1; }\n",
				expected: "valid",
			},
			{
				source: "function f(): void { return void 0; }\n",
				expected: "valid",
			},
			{
				source: "function f(): void { return (void 0); }\n",
				expected: "invalid",
			},
			{
				source: "function f(): Promise<void> { return 1; }\n",
				expected: "valid",
			},
		],
	},
	{
		rule: "no-dynamic-namespace-import-access",
		filename: "no-dynamic-namespace-import-access.js",
		invalid: 'import * as foo from "foo"; foo["bar"];\n',
		valid: 'import * as foo from "foo"; foo.bar;\n',
		edgeCases: [
			{
				source:
					'import * as foo from "foo"; function f(foo) { return foo["bar"]; }\n',
				expected: "valid",
			},
			{
				filename: "no-dynamic-namespace-import-access.ts",
				source: 'import type * as foo from "foo"; foo["bar"];\n',
				expected: "valid",
			},
			{
				source: 'import * as foo from "foo"; foo[key];\n',
				expected: "invalid",
			},
		],
	},
	{
		rule: "no-assign-in-expressions",
		filename: "no-assign-in-expressions.js",
		invalid: "function f(a) { return a = 1; }\n",
		valid: "function f(a) { a = 1; return a; }\n",
		edgeCases: [
			{
				source: "const f = (value) => (value = 1);\n",
				expected: "valid",
			},
			{
				source: "for (value = 0; value < 1; value = 1) {}\n",
				expected: "valid",
			},
			{
				source: "for (; value = 1;) {}\n",
				expected: "invalid",
			},
			{
				source: "(first = 1, second = 2);\n",
				expected: "invalid",
			},
			{
				source: "first = 1, second = 2;\n",
				expected: "valid",
			},
		],
	},
	{
		rule: "no-implicit-any-let",
		filename: "no-implicit-any-let.ts",
		invalid: "let value;\nvalue = 1;\n",
		valid: "let value: number;\nvalue = 1;\n",
		edgeCases: [
			{
				filename: "no-implicit-any-let.js",
				source: "let value;\n",
				expected: "valid",
			},
			{
				filename: "no-implicit-any-let.d.ts",
				source: "let value;\n",
				expected: "valid",
			},
			{
				source: "let first: number, second;\n",
				expected: "invalid",
			},
			{
				source: "let first, second;\n",
				expected: "invalid",
			},
		],
	},
	{
		rule: "no-octal-escape",
		filename: "no-octal-escape.js",
		invalid: 'const foo = "Copyright \\251";\n',
		valid: 'const foo = "Copyright \\u00A9";\n',
		edgeCases: [
			{
				source: 'const foo = "\\0";\n',
				expected: "valid",
			},
			{
				source: 'const foo = "\\01";\n',
				expected: "invalid",
			},
			{
				source: 'const foo = "\\\\251";\n',
				expected: "valid",
			},
			{
				source: 'const foo = "\\xA9";\n',
				expected: "valid",
			},
		],
	},
	{
		rule: "no-redundant-use-strict",
		filename: "no-redundant-use-strict.cjs",
		invalid: '"use strict";\nfunction foo() { "use strict"; }\n',
		valid: '"use strict";\nfunction foo() { return 1; }\n',
		edgeCases: [
			{
				filename: "no-redundant-use-strict.cjs",
				source: 'class C { method() { "use strict"; } }\n',
				expected: "invalid",
			},
			{
				filename: "no-redundant-use-strict.mjs",
				source: '"use strict";\n',
				expected: "invalid",
			},
			{
				filename: "no-redundant-use-strict.cjs",
				source: 'function outer() { function inner() { "use strict"; } }\n',
				expected: "valid",
			},
			{
				filename: "no-redundant-use-strict.cjs",
				source: '"use strict";\n"use strict";\n',
				expected: "invalid",
			},
		],
	},
	{
		rule: "no-suspicious-semicolon-in-jsx",
		filename: "no-suspicious-semicolon-in-jsx.jsx",
		invalid: "export const Component = () => <div>\n<span />;\n</div>;\n",
		valid: "export const Component = () => <div><span /></div>;\n",
		edgeCases: [
			{
				source: "export const Component = () => <div>{value};\n</div>;\n",
				expected: "invalid",
			},
			{
				source: "export const Component = () => <div>\n;\n</div>;\n",
				expected: "valid",
			},
			{
				source: "export const Component = () => <div><span />;</div>;\n",
				expected: "valid",
			},
		],
	},
	{
		rule: "no-flat-map-identity",
		filename: "no-flat-map-identity.js",
		invalid: "export const value = items.flatMap((item) => item);\n",
		valid: "export const value = items.flatMap((item) => item * 2);\n",
		edgeCases: [
			{
				source: "items.flatMap((item, index) => item);\n",
				expected: "valid",
			},
			{
				source: "items[\"flatMap\"](item => item);\n",
				expected: "invalid",
			},
			{
				source: 'items.flatMap(item => { "use strict"; return item; });\n',
				expected: "invalid",
			},
			{
				source: "items.flatMap(item => { if (ok) return item; return item; });\n",
				expected: "valid",
			},
		],
	},
	{
		rule: "no-svg-without-title",
		filename: "no-svg-without-title.jsx",
		invalid: "export const Icon = () => <svg><circle /></svg>;\n",
		valid:
			"export const Icon = () => <svg>\n<title>Icon</title>\n<circle />\n</svg>;\n",
		edgeCases: [
			{
				source: "<svg><title>Icon</title><circle /></svg>\n",
				expected: "invalid",
			},
			{
				source: "<svg role=\"presentation\"><circle /></svg>\n",
				expected: "valid",
			},
			{
				source: "<svg aria-hidden=\"true\"><circle /></svg>\n",
				expected: "valid",
			},
			{
				source: "<svg role=\"img\" aria-labelledby=\"title\"><span id=\"title\">Icon</span></svg>\n",
				expected: "valid",
			},
			{
				source: "<svg role=\"img\" aria-labelledby=\"title\"><span id=\"title\" /></svg>\n",
				expected: "invalid",
			},
		],
	},
	{
		rule: "use-optional-chain",
		filename: "use-optional-chain.js",
		invalid: "export const value = foo && foo.bar;\n",
		valid: "export const value = foo?.bar;\n",
		edgeCases: [
			{
				source: "foo && foo.bar && foo.bar.baz;\n",
				expected: "invalid",
			},
			{
				source: "foo == null && foo.bar;\n",
				expected: "valid",
			},
			{
				source: "foo !== undefined && foo.bar;\n",
				expected: "invalid",
			},
			{
				source: "!foo || !foo.bar;\n",
				expected: "invalid",
			},
			{
				source: "await (foo || {}).bar;\n",
				expected: "invalid",
			},
			{
				source: "foo && (foo.bar);\n",
				expected: "valid",
			},
			{
				source: "typeof window != \"undefined\" && window.foo;\n",
				expected: "valid",
			},
		],
	},
	{
		rule: "use-export-type",
		filename: "use-export-type.ts",
		invalid: "interface Item {}\nexport { Item };\n",
		valid: "interface Item {}\nexport type { Item };\n",
		edgeCases: [
			{
				source: "interface Item {}\nexport { type Item };\n",
				expected: "invalid",
			},
			{
				source: "export { Unknown };\n",
				expected: "invalid",
			},
			{
				source: "interface Item {}\nconst value = 1;\nexport { type Item, value };\n",
				expected: "valid",
			},
			{
				source: 'export { Item } from "module";\n',
				expected: "valid",
			},
			{
				filename: "use-export-type.d.ts",
				source: "interface Item {}\nexport { Item };\n",
				expected: "valid",
			},
		],
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

async function biomeReports(
	rule: string,
	filename: string,
	source: string,
): Promise<boolean> {
	const directory = join(tmpdir(), `weave-policy-biome-${crypto.randomUUID()}`);
	await Bun.write(join(directory, filename), source);
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			biomeCliPath,
			"lint",
			filename,
			`--only=lint/complexity/${rule}`,
			"--reporter=json",
			"--no-errors-on-unmatched",
		],
		cwd: directory,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = await new Response(child.stdout).text();
	await new Response(child.stderr).text();
	await child.exited;
	const report = JSON.parse(stdout) as {
		readonly diagnostics?: readonly { readonly category?: string }[];
	};
	return report.diagnostics?.some(
		(diagnostic) => diagnostic.category === `lint/complexity/${rule}`,
	) ?? false;
}

function expectDiagnostic(output: string, rule: string, expected: EdgeCase["expected"]): void {
	if (expected === "invalid") {
		expect(output).toContain(`weave-policy(${rule})`);
	} else {
		expect(output).not.toContain(`weave-policy(${rule})`);
	}
}

describe("weave-policy Biome parity rules", () => {
	beforeAll(async () => {
		const child = Bun.spawn({
			cmd: [process.execPath, biomeCliPath, "version"],
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(child.stdout).text();
		const stderr = await new Response(child.stderr).text();
		await child.exited;
		expect(`${stdout}\n${stderr}`.match(/^CLI:\s+(\S+)$/m)?.[1]).toBe(
			"2.4.14",
		);
	});

	test("matches the Biome 2.4.14 oracle for exact regressions", async () => {
		for (const regression of biomeParityRegressions) {
			const [biomeReported, customOutput] = await Promise.all([
				biomeReports(
					regression.biomeRule,
					regression.filename,
					regression.source,
				),
				lintSource(
					regression.customRule,
					regression.filename,
					regression.source,
				),
			]);
			expect(biomeReported).toBe(regression.expected);
			expectDiagnostic(
				customOutput,
				regression.customRule,
				regression.expected ? "invalid" : "valid",
			);
			expect(
				customOutput.includes(`weave-policy(${regression.customRule})`),
			).toBe(biomeReported);
		}
	});

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
			expectDiagnostic(invalid, fixture.rule, "invalid");
			expectDiagnostic(valid, fixture.rule, "valid");

			for (const edgeCase of fixture.edgeCases ?? []) {
				const output = await lintSource(
					fixture.rule,
					edgeCase.filename ?? fixture.filename,
					edgeCase.source,
				);
				expectDiagnostic(output, fixture.rule, edgeCase.expected);
			}
		});
	}
});
