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

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProfiles } from '../src/profiles.ts';
import { parseTokenScopes, place } from '../src/scopes.ts';
import { GENERIC_ROLES, onRole } from '../src/tokens.ts';
import { CLI, assert, check, cleanup, finish, first, scratch, writeAll } from './harness.ts';

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

finish();
