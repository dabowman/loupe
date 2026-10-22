#!/usr/bin/env node
/**
 * Token scopes: a profile saying what each token is *for*.
 *
 * Every case here guards a failure that looks like success. A suggestion made
 * from the wrong family is the right pixels with the wrong meaning; a scope
 * declaration that silently failed to load reads exactly like one that was
 * never written; and a scope checked against an element nobody looked at
 * reports a guess as a finding.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { analyze } from '../src/analyze.ts';
import { judgeValues, renameOptions } from '../src/judge.ts';
import { tokenFixes } from '../src/autofix.ts';
import { loadConfig } from '../src/config.ts';
import { readProfiles } from '../src/profiles.ts';
import { fitOf, parseTokenScopes, place } from '../src/scopes.ts';
import type { TokenScopes } from '../src/scopes.ts';
import { GENERIC_ROLES, emptyTokenSet, harvestTokenDefs, onRole } from '../src/tokens.ts';
import { CLI, assert, check, cleanup, finish, first, one, scratch, writeAll } from './harness.ts';
import type { Finding, Profile, TokenSet } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES = join(HERE, '..', '..', 'profiles');
const DESCRIBED = Object.keys(
	JSON.parse(readFileSync(join(PROFILES, 'wpds', 'token-descriptions.json'), 'utf8')) as Record<string, string>,
).filter((k) => k.startsWith('--'));
// `--wpds-border-radius` describes the group, and is no token.
const WPDS_NAMES = DESCRIBED.filter((k) => !DESCRIBED.some((o) => o.startsWith(`${k}-`)));

const shipped = readProfiles(PROFILES);
const wpds = first(
	shipped.filter((p) => p.id === 'wpds'),
	'the wpds profile ships',
);
const WPDS = wpds.tokenScopes;

// ── the schema ──────────────────────────────────────────────────────────────

await check('every shipped profile declares scopes that load without a problem', () => {
	for (const p of shipped) {
		assert(!p.problems.length, `${p.id}: ${p.problems.join('; ')}`);
		assert(p.tokenScopes, `${p.id} declares no tokenScopes`);
	}
});

await check('a malformed declaration is refused whole, with every problem named', () => {
	const { scopes, errors } = parseTokenScopes({
		grammars: [
			{ pattern: '--acme-color-{property}-{target}...', property: { bg: ['background'] }, target: { x: {} } },
			{ pattern: '--acme-space-{size}', property: { padding: ['padding'] } },
			{ pattern: 'acme-radius-{size}', properties: ['border-radius'] },
			{ pattern: '--acme-fg-{property}', property: { text: ['Color!'] }, extra: true },
		],
		kinds: { interactive: ['button', 'not a name'] },
		scales: { '--acme-radius-md': { on: ['overlay'] } },
		colours: {},
	});
	assert(scopes === null, 'a declaration with errors must not half-load');
	const said = errors.join('\n');
	for (const expected of [
		'tokenScopes.colours: unknown key',
		'tokenScopes.kinds.interactive: not an element or component name: "not a name"',
		'tokenScopes.grammars[0].target.x: declares neither requires nor not',
		'tokenScopes.grammars[1].property: the pattern has no {property} to map',
		'tokenScopes.grammars[1].properties: a pattern without {property} names the CSS properties',
		'tokenScopes.grammars[2].pattern: expected a custom-property name pattern',
		'tokenScopes.grammars[3].extra: unknown key',
		'tokenScopes.grammars[3].property.text: expected a list of lowercase CSS properties',
		'tokenScopes.scales.--acme-radius-md.on: undeclared kind overlay',
	])
		assert(said.includes(expected), `expected "${expected}" in:\n${said}`);
});

await check('a profile with broken scopes still loads, and says what was wrong', () => {
	const dir = scratch('loupe-scopes-');
	try {
		writeAll(dir, {
			'acme/profile.json': JSON.stringify({
				id: 'acme',
				packages: ['@acme/ui'],
				patterns: './patterns.json',
				tokenScopes: { grammars: 'nope' },
			}),
			'beta/profile.json': JSON.stringify({ id: 'beta', packages: ['@beta/ui'], tokenScopes: './missing.json' }),
			'gamma/profile.json': JSON.stringify({ id: 'gamma', packages: ['@gamma/ui'], tokenScopes: './scopes.json' }),
			'gamma/scopes.json': JSON.stringify({
				grammars: [{ pattern: '--g-color-{property}...', property: { text: ['color'] } }],
			}),
		});
		const [acme, beta, gamma] = readProfiles(dir);
		assert(acme && beta && gamma, 'all three profiles should be read');
		assert(acme.tokenScopes === null && acme.patterns?.endsWith('patterns.json'), 'its registries still apply');
		assert(
			acme.problems.some((p) => p.includes('tokenScopes.grammars: expected a list')),
			`acme: ${acme.problems}`,
		);
		assert(
			beta.problems.some((p) => p.includes('could not read ./missing.json')),
			`beta: ${beta.problems}`,
		);
		assert(gamma.tokenScopes && !gamma.problems.length, `a scopes file by path loads: ${gamma.problems}`);
	} finally {
		cleanup(dir);
	}
});

await check('the CLI says a selected profile’s scopes were refused', () => {
	const dir = scratch('loupe-scopes-cli-');
	try {
		writeAll(dir, {
			'profiles/acme/profile.json': JSON.stringify({ id: 'acme', packages: ['@acme/ui'], tokenScopes: [] }),
			'repo/loupe.config.json': JSON.stringify({ extends: 'generic', designSystem: { packages: ['@acme/ui'] } }),
			'repo/a.css': '.a { color: red; }\n',
		});
		const { stderr } = spawnSync(
			'node',
			[CLI, 'check', '--all', '--root', join(dir, 'repo'), '--profiles', join(dir, 'profiles')],
			{ encoding: 'utf8' },
		);
		assert(
			stderr.includes('loupe: profile acme tokenScopes: expected an object') && stderr.includes('ignored'),
			`stderr: ${stderr}`,
		);
	} finally {
		cleanup(dir);
	}
});

await check('the WPDS grammar places tokens by their segments, and leaves what it does not name alone', () => {
	assert(WPDS, 'wpds scopes loaded');
	const surface = place(WPDS, '--wpds-color-background-surface-neutral-strong');
	assert(surface?.property === 'background' && surface.target === 'surface', JSON.stringify(surface));
	assert(place(WPDS, '--wpds-dimension-surface-width-md')?.property === 'surface-width', 'a two-word segment');
	assert(place(WPDS, '--wpds-typography-font-size-md')?.property === 'font-size', 'a two-word segment');
	assert(place(WPDS, '--wpds-color-stroke-focus')?.property === 'stroke', 'the focus exception still places');
	assert(place(WPDS, '--wpds-border-radius-md')?.on?.includes('overlay'), 'radius steps carry their role');
	assert(place(WPDS, '--wpds-dimension-primitive-space-10') === null, 'a primitive has no declared scope');
});

// ── ROLE_HINTS, moved out ───────────────────────────────────────────────────

/** The table as it stood in the engine before profiles could say, verbatim. */
const BEFORE: readonly (readonly [RegExp, RegExp, RegExp?])[] = [
	[/^border-radius|radius$/, /radius/],
	[/^border(-(top|right|bottom|left))?-width$|^border-width$|^outline-width$/, /border-width/],
	[/^color$/, /colou?r-(fg|text|content|foreground)/],
	[/^background(-color)?$|^background-image$/, /colou?r-(bg|background|surface)/],
	[/border.*-color$|^border-color$|^outline-color$/, /colou?r-(border|line|stroke)/],
	[
		/^(border|outline|column-rule)(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?$/,
		/colou?r-(border|line|stroke)/,
	],
	[/shadow/, /shadow/],
	[/^fill$|^stroke$|caret-color|accent-color|^text-decoration(-color)?$/, /colou?r/],
	[/^font-size$/, /font-size/],
	[/^font-weight$/, /font-weight/],
	[/^line-height$/, /line-height/],
	[/^letter-spacing$/, /letter-spacing/],
	[/^font-family$|^font$/, /font-family/],
	[/padding/, /dimension|spac|padding|gap/, /padding/],
	[/gap$/, /dimension|spac|padding|gap/, /gap/],
	[/^inset$|^top$|^right$|^bottom$|^left$/, /spac|padding|gap/],
	[/^cursor$/, /cursor/],
	[/^(min-|max-)?(width|height|inline-size|block-size)$/, /(?<!font-)size|surface-width/],
	[/^transition-duration$|^animation-duration$/, /duration/],
	[/^transition-timing-function$|^animation-timing-function$/, /easing/],
];
const before = (names: readonly string[], prop: string): string[] => {
	const [, hint, own] = BEFORE.find(([p]) => p.test(prop)) ?? [];
	if (!hint) return [];
	const on = names.filter((n) => hint.test(n));
	const preferred = own ? on.filter((n) => own.test(n)) : [];
	return preferred.length ? preferred : on;
};

const PROPS = [
	'color',
	'background',
	'background-color',
	'background-image',
	'border-color',
	'border-top-color',
	'border-block-start-color',
	'outline-color',
	'border',
	'border-left',
	'outline',
	'column-rule',
	'box-shadow',
	'text-shadow',
	'fill',
	'stroke',
	'caret-color',
	'accent-color',
	'text-decoration',
	'border-radius',
	'border-top-left-radius',
	'border-width',
	'outline-width',
	'font-size',
	'font-weight',
	'line-height',
	'letter-spacing',
	'font-family',
	'font',
	'padding',
	'padding-inline-start',
	'gap',
	'row-gap',
	'inset',
	'top',
	'cursor',
	'width',
	'max-height',
	'transition-duration',
	'animation-timing-function',
	'margin',
	'z-index',
];
const ARCHER_NAMES = [
	'--color-text-primary',
	'--color-background-secondary',
	'--color-border-control',
	'--color-neutral-600',
	'--color-primary',
	'--space-m',
	'--space-s-m',
	'--radius-3',
	'--border-width-1',
	'--shadow-2',
	'--size-md',
	'--font-size-lg',
	'--font-weight-bold',
	'--font-line-height-tight',
	'--font-family-sans',
	'--duration-fast',
	'--easing-ease-in',
	'--cursor-pointer',
];

await check('with no scopes declared, every property gets exactly the family it got before', () => {
	assert(GENERIC_ROLES.length === BEFORE.length, 'the generic table changed size');
	for (const names of [WPDS_NAMES, ARCHER_NAMES])
		for (const prop of PROPS) {
			const was = before(names, prop).join(' ');
			const now = onRole(names, prop).join(' ');
			assert(now === was, `${prop}: was [${was}], now [${now}]`);
		}
});

await check('WPDS scopes narrow only where the system says, and leave every other property alone', () => {
	assert(WPDS, 'wpds scopes loaded');
	// The deliberate differences: properties the generic table answered with any
	// colour at all, a height the surface widths were never for, and offsets it
	// answered with the primitive space palette the semantic grammar leaves out.
	const narrowed = new Set(['fill', 'stroke', 'caret-color', 'text-decoration', 'max-height', 'inset', 'top']);
	for (const prop of PROPS) {
		const was = before(WPDS_NAMES, prop).sort();
		const now = onRole(WPDS_NAMES, prop, WPDS).sort();
		if (narrowed.has(prop)) {
			assert(now.length < was.length && now.every((n) => was.includes(n)), `${prop} should narrow: ${now}`);
			continue;
		}
		assert(now.join(' ') === was.join(' '), `${prop}: was [${was.join(' ')}], now [${now.join(' ')}]`);
	}
	assert(
		onRole(WPDS_NAMES, 'fill', WPDS).every((n) => n.includes('-foreground-')),
		'fill is a foreground colour under WPDS',
	);
});

// A judged rename chooses among these. Asked from the generic family, `fill`
// offered every colour the system has — background and stroke included — and a
// confident pick among them rewrites every line naming the unknown token to one
// the profile says is not for this property.
await check('a judged rename is asked among the family the scopes put on the property', () => {
	assert(WPDS, 'wpds scopes loaded');
	const set = (scopes?: TokenScopes): TokenSet => ({
		known: new Set(WPDS_NAMES),
		byValue: new Map(),
		sources: 1,
		scopes,
	});
	// Nothing a keystroke away, so the family is all there is.
	const name = '--wpds-colour-fill-mystery';
	const generic = renameOptions(name, 'fill', set()).map(([n]) => n);
	const scoped = renameOptions(name, 'fill', set(WPDS)).map(([n]) => n);
	assert(scoped.length, 'the scoped family offered nothing');
	assert(scoped.length < generic.length, `the scopes did not narrow it: ${scoped.length} of ${generic.length}`);
	assert(
		scoped.every((n) => n.includes('-foreground-')),
		`an off-scope token was offered: ${scoped.filter((n) => !n.includes('-foreground-'))}`,
	);
	// And a property the scopes say nothing about is asked as it was.
	const cursor = (s?: TokenScopes) => renameOptions('--wpds-cursor-mystery', 'cursor', set(s)).map(([n]) => n);
	assert(cursor().length, 'the generic table offered no cursor token');
	assert(cursor(WPDS).join(' ') === cursor().join(' '), 'an undeclared property changed family');
});

// ── fix, and the suggestion path ────────────────────────────────────────────

const TOKENS = `:root {
	--wpds-border-radius-xs: 1px;
	--wpds-border-radius-sm: 2px;
	--wpds-border-radius-md: 4px;
	--wpds-border-radius-lg: 8px;
	--wpds-border-radius-xl: 12px;
	--wpds-border-width-xs: 1px;
	--wpds-color-background-surface-neutral-strong: #ffffff;
	--wpds-color-background-interactive-neutral: #fefefe;
	--wpds-color-foreground-content-neutral: #1e1e1e;
	--wpds-color-stroke-surface-neutral: #dddddd;
	--wpds-color-stroke-focus: #3858e9;
	--wpds-dimension-padding-md: 12px;
	--wpds-dimension-primitive-space-10: 4px;
	--wpds-cursor-control: pointer;
}`;

/** Analyze a throwaway WPDS repo, with the given profiles active — the shipped WPDS one by default. */
async function run(
	files: Record<string, string>,
	active: Profile[] = [wpds],
): Promise<{ findings: Finding[]; misapplied: Finding[] }> {
	const root = scratch('loupe-scope-run-');
	try {
		writeAll(root, {
			'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['rp-'] } }),
			'styles/tokens.css': TOKENS,
			...files,
		});
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		config.profiles = { available: shipped, active, applied: [], skipped: [], notes: [], errors: [] };
		const { findings } = await analyze(config, { scope: null });
		return { findings, misapplied: findings.filter((f) => f.rule === 'tokens/misapplied-token') };
	} finally {
		cleanup(root);
	}
}

const hardcoded = (fs: readonly Finding[], file: string, line: number): Finding =>
	one(
		fs.filter((f) => f.rule === 'tokens/hardcoded-value' && f.file === file && f.line === line),
		`one hardcoded-value at ${file}:${line}`,
	);

// The issue's example, verbatim: both declarations resolved to one token by
// value, both applied unattended, both role-wrong.
const ISSUE = `/* a dialog surface — WPDS role scale says lg */
.rp-dialog { border-radius: 4px; }
/* a standalone button — WPDS role scale says sm */
.rp-button { border-radius: 4px; }
`;

await check('without scopes, the issue’s two radii are both applied as md — the behaviour being fixed', async () => {
	const { findings } = await run({ 'src/a.scss': ISSUE }, []);
	const fixes = tokenFixes(findings);
	assert(fixes.length === 2 && fixes.every((f) => f.to === 'var(--wpds-border-radius-md)'), JSON.stringify(fixes));
});

await check(
	'with scopes and no markup, neither radius is applied: md is for overlays, and nothing shows either is one',
	async () => {
		const { findings } = await run({ 'src/a.scss': ISSUE });
		assert(!tokenFixes(findings).length, `nothing should be applied: ${JSON.stringify(tokenFixes(findings))}`);
		const dialog = hardcoded(findings, 'src/a.scss', 2);
		const s = first(dialog.suggest ?? [], 'the declaration keeps its suggestion');
		assert(s.tokens.join() === '--wpds-border-radius-md', `the candidate is still named: ${s.tokens}`);
		assert(s.review?.includes('for overlay'), `the reason is carried: ${s.review}`);
		assert(dialog.message.includes('(review: for overlay'), `and shown: ${dialog.message}`);
	},
);

await check(
	'with the markup bound, md is off-role on the dialog and on the button, and sm on a button is applied',
	async () => {
		const { findings } = await run({
			'src/a.scss': `${ISSUE}.rp-chip { border-radius: 2px; }\n`,
			'src/A.jsx': `export const A = () => (
	<dialog className="rp-dialog">
		<button className="rp-button">Go</button>
		<button className="rp-chip">x</button>
	</dialog>
);
`,
		});
		const fixes = tokenFixes(findings);
		const fix = one(fixes, 'only the on-role radius is applied');
		assert(fix.line === 5 && fix.to === 'var(--wpds-border-radius-sm)', JSON.stringify(fix));
		assert(hardcoded(findings, 'src/a.scss', 2).suggest?.[0]?.review?.includes('<dialog>'), 'the dialog is named');
		assert(hardcoded(findings, 'src/a.scss', 4).suggest?.[0]?.review?.includes('<button>'), 'the button is named');
	},
);

await check('a step no markup can confirm — xs, nested inside a control — is never applied unattended', async () => {
	const { findings } = await run({
		'src/a.css': '.rp-x { border-radius: 1px; }\n',
		'src/A.jsx': 'export const A = () => <button className="rp-x" />;\n',
	});
	assert(!tokenFixes(findings).length, 'xs should not apply');
	assert(hardcoded(findings, 'src/a.css', 1).suggest?.[0]?.review, 'xs is held for review');
});

// `fix --judge` settles a value part by part, and a part matching one token
// exactly — or one token equal to it in another unit — was written at
// confidence 1 with no question asked, past the hold a whole value gets.
await check('a token a part or another unit settles on is held where a whole value would be', async () => {
	const { findings } = await run({
		'src/a.css': `.rp-d { border-radius: 4px 4px 0 0; }
.rp-e { border-radius: 0.25rem; }
.rp-b { border: 1px solid #dddddd; }
`,
		'src/A.jsx': `export const A = () => (
	<dialog className="rp-d rp-e">
		<button className="rp-b" />
	</dialog>
);
`,
	});
	const reviews = [1, 2, 3].map((line) => hardcoded(findings, 'src/a.css', line).suggest?.[0]?.review ?? '');
	assert(
		reviews[0]?.startsWith('--wpds-border-radius-md for overlay; this styles <dialog>') &&
			reviews[1]?.startsWith('--wpds-border-radius-md for overlay; this styles <dialog>') &&
			reviews[2]?.startsWith('--wpds-color-stroke-surface-neutral not for interactive; this styles <button>'),
		`each is held, naming its token: ${reviews.join(' | ')}`,
	);
	let asked = 0;
	const stub = (async () => {
		asked++;
		throw new Error('nothing here is a question');
	}) as unknown as typeof fetch;
	// The set `fix --judge` judges against: the fixture's tokens, under the same scopes.
	const tokens = harvestTokenDefs(postcss.parse(TOKENS), ['--wpds-'], emptyTokenSet());
	tokens.scopes = WPDS ?? undefined;
	await judgeValues('/nonexistent', findings, tokens, 'key', new Map(), stub);
	assert(!asked, `asked ${asked} question(s)`);
	assert(!tokenFixes(findings).length, `fix --judge writes none of them: ${JSON.stringify(tokenFixes(findings))}`);
});

await check('a token with nothing declared about where it sits is applied as before', async () => {
	const { findings } = await run({ 'src/a.css': '.rp-a { padding-top: 12px; outline-color: #3858e9; }\n' });
	const to = tokenFixes(findings)
		.map((f) => f.to)
		.sort();
	assert(
		to.join() === 'var(--wpds-color-stroke-focus),var(--wpds-dimension-padding-md)',
		`expected both applied: ${to}`,
	);
});

await check('fix --dry-run names what it held back, and why', () => {
	const root = scratch('loupe-scope-cli-');
	try {
		writeAll(root, {
			'package.json': JSON.stringify({ dependencies: { '@wordpress/components': '*' } }),
			'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['rp-'] } }),
			'styles/tokens.css': TOKENS,
			'src/a.scss': ISSUE,
		});
		const out = execFileSync('node', [CLI, 'fix', '--dry-run', '--root', root, '--profiles', PROFILES], {
			encoding: 'utf8',
		});
		const review = out.split('\n').filter((l) => l.startsWith('review'));
		assert(review.length === 2, `expected two review lines:\n${out}`);
		assert(
			review.every((l) => l.includes('border-radius: 4px → --wpds-border-radius-md — for overlay')),
			`review lines: ${review.join('\n')}`,
		);
		assert(out.includes('would fix 0 substitution(s)'), out);
	} finally {
		cleanup(root);
	}
});

// A grammar decides for the names under its own prefixes. A project's own
// tokens are under none, and were dropped from every property the grammar
// covers: no suggestion for the colour only they carry, and a same-valued one
// gone from the background, which left a single candidate to apply.
await check('a token no grammar’s prefix claims keeps the matching it had', async () => {
	const { findings } = await run({
		'loupe.config.json': JSON.stringify({
			extends: 'wpds',
			namespaces: { project: ['rp-'] },
			designSystem: { tokenPrefixes: ['--wpds-', '--acme-'] },
		}),
		'styles/acme.css': ':root { --acme-color-text-brand: #123456; --acme-color-background-panel: #ffffff; }\n',
		'src/a.css': '.rp-a { color: #123456; background: #ffffff; }\n',
	});
	const fixes = tokenFixes(findings).map((f) => `${f.prop} ${f.to}`);
	assert(fixes.join() === 'color var(--acme-color-text-brand)', `fixes: ${fixes.join(', ')}`);
	const background = findings.flatMap((f) => f.suggest ?? []).find((s) => s.prop === 'background');
	assert(
		background?.tokens.sort().join() === '--acme-color-background-panel,--wpds-color-background-surface-neutral-strong',
		`two candidates, a question: ${background?.tokens}`,
	);
});

await check('a profile with no scopes leaves suggestions and fixes exactly as they were', async () => {
	const plain: Profile = { ...wpds, tokenScopes: null };
	const files = {
		'src/a.scss': `${ISSUE}.rp-c { color: #1e1e1e; background: #ffffff; cursor: pointer; }\n`,
		'src/A.jsx': 'export const A = () => <button className="rp-button" />;\n',
	};
	const none = await run(files, []);
	const blank = await run(files, [plain]);
	const show = (fs: readonly Finding[]): string =>
		fs
			.map((f) => `${f.rule} ${f.file}:${f.line} ${f.message}`)
			.sort()
			.join('\n');
	assert(
		show(blank.findings) === show(none.findings),
		`findings differ:\n${show(blank.findings)}\n---\n${show(none.findings)}`,
	);
	assert(!blank.misapplied.length, 'no scopes, no misapplied tokens');
	assert(
		JSON.stringify(tokenFixes(blank.findings)) === JSON.stringify(tokenFixes(none.findings)),
		'the fixes should be the same',
	);
});

// ── tokens/misapplied-token ─────────────────────────────────────────────────

await check('a token on a property its segment does not set is misapplied', async () => {
	const { misapplied } = await run({
		'src/a.css': '.rp-a { color: var(--wpds-color-background-surface-neutral-strong); }\n',
	});
	const f = one(misapplied, 'one misapplied token');
	assert(f.severity === 'warn', `advisory: ${f.severity}`);
	assert(
		f.message.startsWith('color: --wpds-color-background-surface-neutral-strong — a background token sets background'),
		f.message,
	);
});

await check(
	'a surface background on a clickable control is misapplied, in every channel that shows the element',
	async () => {
		const { misapplied } = await run({
			'src/A.jsx': `export const A = () => (
	<>
		<input className="rp-radio" type="radio" />
		<button style={{ background: 'var(--wpds-color-background-surface-neutral-strong)' }} />
	</>
);
`,
			'src/a.css': `.rp-radio { background: var(--wpds-color-background-surface-neutral-strong); }
.rp-card button { background-color: var(--wpds-color-background-surface-neutral-strong); }
`,
		});
		const where = misapplied.map((f) => `${f.file}:${f.line}`).sort();
		assert(where.join() === 'src/A.jsx:4,src/a.css:1,src/a.css:2', `got ${where}`);
		assert(
			misapplied.every((f) => f.message.includes('not for interactive')),
			misapplied.map((f) => f.message).join('\n'),
		);
	},
);

await check('a scale step on the wrong kind of element is misapplied; on the right one it is not', async () => {
	const { misapplied } = await run({
		'src/A.jsx': 'export const A = () => <dialog className="rp-d"><button className="rp-b" /></dialog>;\n',
		'src/a.css': `.rp-d { border-radius: var(--wpds-border-radius-lg); }
.rp-b { border-radius: var(--wpds-border-radius-md); }
.rp-d a { cursor: var(--wpds-cursor-control); }
.rp-b { cursor: var(--wpds-cursor-control); border-radius: var(--wpds-border-radius-sm); }
`,
	});
	const lines = misapplied.map((f) => f.line).sort();
	assert(lines.join() === '2,3', `expected md on the button and the control cursor on the link: ${lines}`);
	assert(
		misapplied.some((f) => f.message.includes('for overlay; this styles <button>')),
		'md names its role',
	);
	assert(
		misapplied.some((f) => f.message.includes('for control; this styles <a>')),
		'cursor names its role',
	);
});

// A profile's kinds list `Button`. Looked up by the name the file gave it — an
// alias, a namespace, the root of a compound — a design-system control matched
// no kind and read as definitely not one.
await check('an element’s kind is the component it is, not the name the file gave it', async () => {
	const { misapplied } = await run({
		'src/A.jsx': `import styled from '@emotion/styled';
import { Button as B, Card } from '@wordpress/components';
import * as WP from '@wordpress/components';
const S = styled(B)\`cursor: var(--wpds-cursor-control);\`;
export const A = () => (
	<Card>
		<Card.Header className="rp-h" />
		<B className="rp-c" />
		<WP.Button className="rp-w" />
		<S />
	</Card>
);
`,
		'src/a.css': `.rp-c { cursor: var(--wpds-cursor-control); }
.rp-w { cursor: var(--wpds-cursor-control); background: var(--wpds-color-background-surface-neutral-strong); }
.rp-h { border-radius: var(--wpds-border-radius-lg); }
`,
	});
	// The control cursor is on-role on every spelling of Button; the surface
	// background is not.
	const said = misapplied.map((f) => `${f.file}:${f.line} ${f.message}`).sort();
	assert(
		said.length === 1 &&
			said[0]?.startsWith('src/a.css:2 background: --wpds-color-background-surface-neutral-strong') &&
			said[0].endsWith('this styles <Button>'),
		said.join('\n'),
	);
	// A card's header is not the card. No kind lists the part, so the container
	// radius on it is unknown rather than reported or confirmed.
	assert(WPDS, 'wpds scopes loaded');
	assert(fitOf(WPDS, '--wpds-border-radius-lg', ['Card.Header']).fit === 'unknown', 'the header is not the card');
	assert(fitOf(WPDS, '--wpds-border-radius-lg', ['Card']).fit === 'on', 'the card is a container');
});

// What a rule lands on is read from selector text and the markup the index
// records, and every misreading of either named an element the rule does not
// style: `.a.b` took the elements of each class, a class inside `:not()` counted,
// an attribute value split into a tag, a nested group kept its last selector,
// an interpolation read as `<dsh-e>`, and a class shared with an unrecorded
// element was taken to style only the recorded one.
await check('what a rule styles is read conservatively, and unknown where it is not shown', async () => {
	const { findings, misapplied } = await run({
		'src/A.jsx': `import styled from '@emotion/styled';
const Icon = () => null;
const Nav = styled.nav\`
	& button, & a { cursor: var(--wpds-cursor-control); }
	&:hover \${Icon} { background: var(--wpds-color-background-interactive-neutral); }
\`;
export const A = () => (
	<Nav>
		<section className="rp-panel is-active" />
		<button className="is-active rp-x" aria-label="Close dialog" />
		<ul>
			<li className="rp-item" />
			<li className="rp-item" />
			<li className="rp-item" />
		</ul>
		<button className="rp-item" />
		<dialog className="rp-n" />
		<button className="rp-m" />
	</Nav>
);
`,
		'src/a.css': `.rp-panel.is-active { background: var(--wpds-color-background-surface-neutral-strong); }
.rp-x[aria-label="Close dialog"] { border-radius: var(--wpds-border-radius-sm); }
.rp-item { border-radius: 2px; }
.rp-n:not(.rp-m) { border-radius: 8px; }
`,
	});
	assert(!misapplied.length, misapplied.map((f) => `${f.file}:${f.line} ${f.message}`).join('\n'));
	// Three list items and a button share the class: the button's radius is not
	// the rule's to apply. A class inside `:not()` is one the element lacks.
	const fixes = tokenFixes(findings).map((f) => `${f.line} ${f.to}`);
	assert(fixes.join() === '4 var(--wpds-border-radius-lg)', `fixes: ${fixes.join(', ')}`);
	assert(hardcoded(findings, 'src/a.css', 3).suggest?.[0]?.review, 'the shared class is held for review');
});

await check('nothing is misapplied where nothing declares a scope, or nothing shows the element', async () => {
	const { misapplied } = await run({
		'src/a.css': `.rp-a {
	--rp-ring: var(--wpds-color-background-surface-neutral-strong);
	padding: var(--wpds-dimension-primitive-space-10);
	margin: calc(-1 * var(--wpds-dimension-padding-md));
	width: calc(100% - var(--wpds-color-stroke-focus));
	box-shadow: 0 0 0 var(--wpds-border-width-xs) var(--wpds-color-stroke-focus);
	border: var(--wpds-border-width-xs) solid var(--wpds-color-stroke-surface-neutral);
	border-radius: var(--wpds-border-radius-md);
	background: var(--wpds-color-background-interactive-neutral);
	color: var(--wpds-color-foreground-content-neutral);
	outline-color: var(--wpds-color-made-up-token);
}
`,
	});
	assert(!misapplied.length, misapplied.map((f) => f.message).join('\n'));
});

await check('elements that disagree, or a kind no markup can show, are never reported', () => {
	assert(WPDS, 'wpds scopes loaded');
	const mixed = fitOf(WPDS, '--wpds-color-background-surface-neutral', ['button', 'div']);
	assert(mixed.fit === 'unknown', `a class on a button and a div is not every element: ${mixed.fit}`);
	const nested = fitOf(WPDS, '--wpds-border-radius-xs', ['button', 'Button']);
	assert(nested.fit === 'unknown', `nesting inside a control cannot be shown: ${nested.fit}`);
	const surface = fitOf(WPDS, '--wpds-color-background-surface-neutral', []);
	assert(surface.fit === 'on', `"not interactive" holds by default where nothing is shown: ${surface.fit}`);
	const on = fitOf(WPDS, '--wpds-border-radius-lg', ['Modal']);
	assert(on.fit === 'on', `a Modal is a container: ${on.fit}`);
});

// A kind's list says what an element is, never what it is not: a `<div>`, a
// `<span>` inside a button, or a component the profile has not read could be
// any kind, and reading it as none reported a card's radius, an icon's
// interactive colour and a menu's radius as misapplied.
await check('an element no kind lists is unknown, never the wrong kind', async () => {
	assert(WPDS, 'wpds scopes loaded');
	for (const [token, els] of [
		['--wpds-border-radius-lg', ['div']],
		['--wpds-color-background-interactive-neutral', ['span']],
		['--wpds-border-radius-md', ['div']],
		['--wpds-border-radius-lg', ['Dialog.Popup']],
		['--wpds-cursor-control', ['ToolbarButton']],
		['--wpds-border-radius-lg', ['dialog', 'div']],
	] as const) {
		const fit = fitOf(WPDS, token, els);
		assert(fit.fit === 'unknown', `${token} on ${els.join(', ')}: ${fit.fit}`);
	}
	const { misapplied } = await run({
		'src/A.jsx': `export const A = () => (
	<>
		<div className="rp-card" />
		<button className="rp-b"><svg className="rp-i" /><span className="rp-s" /></button>
		<div className="rp-menu" />
	</>
);
`,
		'src/a.css': `.rp-card { border-radius: var(--wpds-border-radius-lg); }
.rp-i { fill: var(--wpds-color-foreground-interactive-neutral); }
.rp-s { background: var(--wpds-color-background-interactive-neutral); }
.rp-menu { border-radius: var(--wpds-border-radius-md); }
`,
	});
	assert(!misapplied.length, misapplied.map((f) => `${f.line} ${f.message}`).join('\n'));
	// Every element listed and none the kind is still reported.
	assert(fitOf(WPDS, '--wpds-border-radius-lg', ['button']).fit === 'off', 'a button is not a container');
});

await check('profile kinds of one name pool when two profiles are active', async () => {
	const extra = parseTokenScopes({
		kinds: { container: ['Sheet'] },
		scales: { '--acme-radius-lg': { on: ['container'] } },
	}).scopes as TokenScopes;
	assert(extra, 'the extra scopes parse');
	const other: Profile = { ...wpds, id: 'acme', tokenScopes: extra };
	const { misapplied } = await run(
		{
			'src/A.jsx': 'export const A = () => <dialog className="rp-d" />;\n',
			'src/a.css': '.rp-d { border-radius: var(--wpds-border-radius-sm); }\n',
		},
		[wpds, other],
	);
	assert(one(misapplied, 'still one finding').message.includes('<dialog>'), 'the merged scopes still check');
});

finish();
