#!/usr/bin/env node
/**
 * Delivery: can the project actually use what a finding recommends?
 *
 * Two near-misses started this (#26). `loupe fix` staged two dozen
 * `var(--wpds-*)` substitutions into a plugin whose stylesheet never loaded the
 * sheet defining them, so every one resolved to nothing; and every
 * `system/raw-element` remedy named `@wordpress/ui`, which WordPress does not
 * provide — adopting it bundled the package into a deliberately
 * dependency-free plugin. Both are facts about how a design system ships, so
 * the profile declares them and the engine reads them. What is checked here is
 * that the declaration is read strictly, and that each consumer fails safe.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findingKey } from '../src/analyze.ts';
import { argumentsAt, dependencyList, stripComments } from '../src/checks/tokens/undelivered.ts';
import { loadDelivery, reachNote, remedyPackages } from '../src/delivery.ts';
import { readProfiles } from '../src/profiles.ts';
import { assert, CLI, check, cleanup, finish, one, scratch, writeAll } from './harness.ts';
import type { Finding } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES = join(HERE, '..', '..', 'profiles');

// ── A: the profile's delivery block ─────────────────────────────────────────

await check('a delivery block is read from the profile, relative to its directory', () => {
	const dir = scratch('loupe-deliv-');
	try {
		writeAll(dir, {
			'acme/profile.json': JSON.stringify({ id: 'acme', packages: ['@acme/ui'], delivery: './delivery.json' }),
			'acme/delivery.json': JSON.stringify({
				host: 'Acme Host',
				packages: { '@acme/ui': { provided: 'bundled' }, '@acme/core': { provided: 'external', handle: 'acme-core' } },
				tokens: {
					stylesheet: '@acme/tokens.css',
					handle: 'acme-tokens',
					evidence: [{ kind: 'import', files: ['**/*.css'], specifiers: ['@acme/tokens.css'] }],
				},
			}),
		});
		const { delivery } = one(readProfiles(dir), 'expected the profile');
		assert(delivery, 'the delivery block should load');
		assert(delivery.host === 'Acme Host', `host: ${delivery.host}`);
		assert(delivery.packages.get('@acme/ui')?.provided === 'bundled', 'a bundled package should survive');
		assert(delivery.packages.get('@acme/core')?.handle === 'acme-core', 'an external keeps its handle');
		assert(delivery.tokens?.handle === 'acme-tokens', 'the token block should load');
		assert(delivery.tokens?.evidence.length === 1, 'its evidence should load');
	} finally {
		cleanup(dir);
	}
});

await check('a delivery block that does not say what it means is dropped, not guessed at', () => {
	// Entries with no usable `provided`, checks of unknown kind or without the
	// fields their kind runs on, and a regex that does not compile.
	const d = loadDelivery({
		packages: {
			'@a/ok': { provided: 'external' },
			'@a/vague': { provided: 'maybe' },
			'@a/junk': 3,
		},
		tokens: {
			stylesheet: 'tokens.css',
			evidence: [
				{ kind: 'enqueue-dependency', files: ['**/*.php'], calls: ['wp_enqueue_style'], handles: [] },
				{ kind: 'enqueue-dependency', files: ['**/*.php'], calls: ['not a name('], handles: ['x'] },
				{ kind: 'pattern', files: ['**/*.js'], pattern: '(' },
				{ kind: 'telepathy', files: ['**/*'] },
				{ kind: 'import', files: [], specifiers: ['x'] },
				{
					kind: 'enqueue-dependency',
					files: ['**/*.php'],
					calls: ['wp_enqueue_style', 'wp_register_style'],
					enqueues: ['wp_enqueue_style', 'something_else'],
					handles: ['x'],
				},
			],
		},
	});
	assert(d, 'the usable half should still load');
	assert([...d.packages.keys()].join() === '@a/ok', `only the well-formed entry survives: ${[...d.packages.keys()]}`);
	const only = one(d.tokens?.evidence ?? [], 'only the well-formed check should survive');
	assert(only.kind === 'enqueue-dependency', `kind: ${only.kind}`);
	assert(
		only.kind === 'enqueue-dependency' && only.argument === 2,
		'the dependency list defaults to the third argument',
	);
	assert(
		only.kind === 'enqueue-dependency' && only.enqueues.join() === 'wp_enqueue_style',
		'an `enqueues` call has to be one of `calls`',
	);
	assert(d.host === 'the host', `an unnamed host is not invented: ${d.host}`);
});

await check('a delivery block with nothing usable left is no block', () => {
	assert(loadDelivery(null) === null, 'null');
	assert(loadDelivery([]) === null, 'an array');
	assert(loadDelivery({ packages: { x: { provided: 'nope' } } }) === null, 'no valid package and no tokens');
	// A token block with nothing to run never reports, so it is not a block.
	assert(loadDelivery({ tokens: { stylesheet: 'x.css', evidence: [] } }) === null, 'tokens with no evidence');
});

await check('a profile whose delivery file is missing or broken still loads, without one', () => {
	const dir = scratch('loupe-deliv-bad-');
	try {
		writeAll(dir, {
			'a/profile.json': JSON.stringify({ id: 'a', packages: ['@a/ui'], delivery: './nope.json' }),
			'b/profile.json': JSON.stringify({ id: 'b', packages: ['@b/ui'], delivery: './delivery.json' }),
			'b/delivery.json': '{ not json',
			'c/profile.json': JSON.stringify({ id: 'c', packages: ['@c/ui'], delivery: 7 }),
		});
		const found = readProfiles(dir);
		assert(found.length === 3, `every profile should still load: ${found.map((p) => p.id)}`);
		assert(
			found.every((p) => p.delivery === null),
			'none of them has a usable delivery block',
		);
	} finally {
		cleanup(dir);
	}
});

await check('the shipped WPDS profile declares what WordPress provides and what it bundles', () => {
	const wpds = readProfiles(PROFILES).find((p) => p.id === 'wpds');
	const d = wpds?.delivery;
	assert(d, 'the wpds profile should carry a delivery block');
	assert(d.host === 'WordPress', `host: ${d.host}`);
	// dependency-extraction-webpack-plugin 6.56.0, BUNDLED_PACKAGES.
	assert(d.packages.get('@wordpress/ui')?.provided === 'bundled', '@wordpress/ui is bundled');
	const components = d.packages.get('@wordpress/components');
	assert(components?.provided === 'external' && components.handle === 'wp-components', 'components is wp-components');
	assert(d.tokens?.handle === 'wp-theme', `the token sheet ships as wp-theme: ${d.tokens?.handle}`);
	assert(d.tokens?.prefixes.join() === '--wpds-', `it covers the --wpds- namespace: ${d.tokens?.prefixes}`);
	assert(
		d.tokens?.evidence.some((e) => e.kind === 'enqueue-dependency' && e.handles.includes('wp-theme')),
		'an enqueue listing wp-theme should count as delivery',
	);
});

await check('`loupe status` names what the active profile delivers how', () => {
	const root = scratch('loupe-deliv-status-');
	try {
		writeAll(root, { 'package.json': JSON.stringify({ dependencies: { '@wordpress/components': '^30.0.0' } }) });
		const out = execFileSync('node', [CLI, 'status', '--root', root, '--profiles', PROFILES], {
			encoding: 'utf8',
			env: { ...process.env, NO_COLOR: '1' },
		});
		const line = out.split('\n').find((l) => l.startsWith('delivery:'));
		assert(line, `status should print a delivery line:\n${out}`);
		assert(line.includes('wp-theme'), `it should name the token handle: ${line}`);
		assert(/bundled into your build: [^;]*@wordpress\/ui/.test(line), `it should name the bundled packages: ${line}`);
		assert(/provided by WordPress: @wordpress\/components \(wp-components\)/.test(line), `and the externals: ${line}`);
	} finally {
		cleanup(root);
	}
});

// ── C: what a remedy naming a package costs ─────────────────────────────────

/** `check --all --format json` through the CLI, the way the hook and skills run it. */
function checkJson(root: string, profiles: boolean = true): Finding[] {
	const args = [CLI, 'check', '--all', '--format', 'json', '--no-baseline', '--root', root, '--preset', 'wpds'];
	const r = spawnSync('node', profiles ? [...args, '--profiles', PROFILES] : args, { encoding: 'utf8' });
	assert(r.status === 0 || r.status === 1, `loupe could not run (${r.status}): ${r.stderr}`);
	return (JSON.parse(r.stdout) as { findings: Finding[] }).findings;
}

const PLUGIN = {
	'package.json': JSON.stringify({ dependencies: { '@wordpress/components': '^30.0.0' } }),
	'src/Panel.jsx': `import { HStack, Button } from '@wordpress/components';
export const Panel = () => (
  <HStack>
    <p>Settings</p>
    <button>Save</button>
  </HStack>
);
`,
};

const BUNDLING = 'bundling required: @wordpress/ui is bundled into your build, not provided by WordPress';

await check('a remedy naming a bundled package the project does not import says bundling is required', () => {
	const root = scratch('loupe-reach-');
	try {
		writeAll(root, PLUGIN);
		const findings = checkJson(root);
		const p = one(
			findings.filter((f) => f.rule === 'system/raw-element' && f.code === '<p>'),
			'the <p> should report',
		);
		assert(p.message.includes('(@wordpress/ui)'), `the remedy should name @wordpress/ui: ${p.message}`);
		assert(p.note?.includes(BUNDLING), `the note should name the bundling cost: ${p.note}`);
		const hstack = one(
			findings.filter((f) => f.rule === 'system/superseded-component'),
			'HStack should report as superseded',
		);
		assert(hstack.note?.endsWith(BUNDLING), `after its own note: ${hstack.note}`);
	} finally {
		cleanup(root);
	}
});

await check('a remedy naming a package the host provides carries no note', () => {
	const root = scratch('loupe-reach-ext-');
	try {
		writeAll(root, PLUGIN);
		const button = one(
			checkJson(root).filter((f) => f.rule === 'system/raw-element' && f.code === '<button>'),
			'the <button> should report',
		);
		assert(button.message.includes('(@wordpress/components)'), `remedy: ${button.message}`);
		assert(!button.note, `an external costs nothing to adopt: ${button.note}`);
	} finally {
		cleanup(root);
	}
});

await check('once the project imports the bundled package, its remedies carry no note', () => {
	const root = scratch('loupe-reach-paid-');
	try {
		writeAll(root, {
			...PLUGIN,
			'package.json': JSON.stringify({
				dependencies: { '@wordpress/components': '^30.0.0', '@wordpress/ui': '^0.5.0' },
			}),
			'src/Other.jsx': `import { Stack } from '@wordpress/ui';\nexport const Other = () => <Stack />;\n`,
		});
		const findings = checkJson(root);
		const p = one(
			findings.filter((f) => f.rule === 'system/raw-element' && f.code === '<p>'),
			'the <p> should still report',
		);
		assert(!p.note, `the bundling cost is already paid: ${p.note}`);
	} finally {
		cleanup(root);
	}
});

await check('the note changes no finding key, so a baseline survives it', () => {
	const root = scratch('loupe-reach-key-');
	try {
		writeAll(root, PLUGIN);
		const keys = (fs: Finding[]): string =>
			fs
				.filter((f) => f.rule === 'system/raw-element')
				.map(findingKey)
				.sort()
				.join('\n');
		const withNote = checkJson(root);
		assert(
			withNote.some((f) => f.note?.includes('bundling required')),
			'the annotated run should carry the note',
		);
		// Without profiles there is no registry naming a package and no note.
		const bare = checkJson(root, false);
		assert(keys(withNote) === keys(bare), `keys moved:\n${keys(withNote)}\n---\n${keys(bare)}`);
	} finally {
		cleanup(root);
	}
});

await check('what a remedy names is read after the arrow, and unknown is not a cost', () => {
	assert(
		remedyPackages('HStack (@wordpress/components) ×3 → Stack (@wordpress/ui, direction="row")', []).join() ===
			'@wordpress/ui',
		'the current import, before the arrow, is not the remedy',
	);
	// The elementMap remedy shape, with a substitution prop inside it.
	assert(
		remedyPackages('<h4> → <Text render={ <h4 /> }> (@wordpress/ui) (judged 0.80)', []).join() === '@wordpress/ui',
		'a judged tail is not a package',
	);
	assert(remedyPackages('<p> → <Text>', []).length === 0, 'a remedy naming no package names none');
	const imported = new Set<string>();
	// No profile says, and package.json lists it: nothing new to say.
	assert(reachNote('@acme/ui', { delivery: null, imported, dependencies: new Set(['@acme/ui']) }) === null, 'listed');
	// No profile says, and package.json does not list it: a new dependency.
	assert(
		reachNote('@acme/ui', { delivery: null, imported, dependencies: new Set() }) ===
			'new dependency: @acme/ui is not in package.json',
		'unlisted',
	);
	// No profile says, and there is no package.json to ask: say nothing.
	assert(reachNote('@acme/ui', { delivery: null, imported, dependencies: null }) === null, 'unknown');
});

// ── B: tokens/undelivered ───────────────────────────────────────────────────

const TOKENS_CSS = '.card {\n  background: var(--wpds-color-background-surface-neutral-strong);\n}\n';

/** The plugin from #26: tokens in its CSS, and an enqueue that never names wp-theme. */
const enqueue = (deps: string): string => `<?php
wp_enqueue_style(
	'site-foundry-admin',
	SITE_FOUNDRY_PLUGIN_URL . 'build/index.css',
	${deps},
	$asset['version']
);
`;

const undeliveredIn = (files: Record<string, string>, profiles = true): Finding[] => {
	const root = scratch('loupe-undeliv-');
	try {
		writeAll(root, {
			'package.json': JSON.stringify({ dependencies: { '@wordpress/components': '^30.0.0' } }),
			...files,
		});
		return checkJson(root, profiles).filter((f) => f.rule === 'tokens/undelivered');
	} finally {
		cleanup(root);
	}
};

await check('tokens used, and the only enqueue does not depend on wp-theme: one finding, at the first use', () => {
	const f = one(
		undeliveredIn({
			'src/b.css': TOKENS_CSS,
			'src/a.css': '.x {\n  color: var(--wpds-color-foreground-content-neutral);\n}\n',
			'includes/admin.php': enqueue("array( 'site-spec-styles' )"),
		}),
		'expected one finding for the project',
	);
	assert(f.file === 'src/a.css' && f.line === 2, `anchored at the first use: ${f.file}:${f.line}`);
	assert(f.severity === 'warn', `advisory: ${f.severity}`);
	assert(f.code === 'tokens/undelivered:wp-theme', `a key that survives edits: ${f.code}`);
	assert(
		f.message.includes('used in 2 file(s)') && f.message.includes('includes/admin.php:2'),
		`it says how many files and where the enqueue is: ${f.message}`,
	);
	assert(f.note?.includes("'wp-theme'"), `the note names the handle to add: ${f.note}`);
});

await check('a commented-out dependency is not one', () => {
	const php = `${enqueue("array( /* 'wp-theme', */ 'site-spec-styles' )")}// wp_enqueue_style( 'x', 'y', array( 'wp-theme' ) );\n`;
	one(undeliveredIn({ 'src/a.css': TOKENS_CSS, 'includes/admin.php': php }), 'a comment delivers nothing');
});

await check('an enqueue listing wp-theme, or a style that depends on it, is delivery', () => {
	const cases: [string, string][] = [
		['wp-theme in the deps', enqueue("array( 'site-spec-styles', 'wp-theme' )")],
		['short array syntax', enqueue('[ "wp-theme" ]')],
		['wp-components, which depends on it', enqueue("array( 'wp-components' )")],
		['the handle enqueued itself', `<?php\nwp_enqueue_style( 'wp-theme' );\n${enqueue('array()')}`],
		[
			'a registered style that lists it',
			`<?php\nwp_register_style( 'mine', 'a.css', array( 'wp-theme' ) );\n${enqueue("array( 'mine' )")}`,
		],
		['a named deps argument', "<?php\nwp_enqueue_style( handle: 'a', src: 'a.css', deps: array( 'wp-theme' ) );\n"],
	];
	for (const [label, php] of cases) {
		const found = undeliveredIn({ 'src/a.css': TOKENS_CSS, 'includes/admin.php': php });
		assert(!found.length, `${label} should count as delivery: ${found.map((f) => f.message)}`);
	}
});

await check('other evidence the profile names is delivery too', () => {
	const imported = undeliveredIn({
		'src/a.css': `@import '@wordpress/theme/design-tokens.css';\n${TOKENS_CSS}`,
		'includes/admin.php': enqueue("array( 'site-spec-styles' )"),
	});
	assert(!imported.length, 'bundling the sheet into the CSS delivers it');
	const block = undeliveredIn({
		'src/a.css': TOKENS_CSS,
		'includes/admin.php': enqueue("array( 'site-spec-styles' )"),
		'blocks/card/block.json': JSON.stringify({ name: 'x/card', editorStyle: ['wp-components', 'file:./index.css'] }),
	});
	assert(!block.length, 'a block.json naming the handle delivers it');
});

await check('no tokens used: nothing to deliver', () => {
	const found = undeliveredIn({
		'src/a.css': '.card { background: #fff; }\n',
		'includes/admin.php': enqueue("array( 'site-spec-styles' )"),
	});
	assert(!found.length, `no tokens, no finding: ${found.map((f) => f.message)}`);
});

await check('what cannot be read is not a finding', () => {
	const cases: [string, Record<string, string>][] = [
		['a dependency list in a variable', { 'includes/admin.php': enqueue('$deps') }],
		['a list holding a variable', { 'includes/admin.php': enqueue("array( 'a', $more )") }],
		['no enqueue at all', { 'src/index.js': 'export {};\n' }],
		['an argument list that never closes', { 'includes/admin.php': "<?php\nwp_enqueue_style( 'a', 'b', array( 'c'" }],
	];
	for (const [label, files] of cases) {
		const found = undeliveredIn({ 'src/a.css': TOKENS_CSS, ...files });
		assert(!found.length, `${label} should report nothing: ${found.map((f) => f.message)}`);
	}
	// Tokens the project defines itself arrive with its own stylesheet.
	const own = undeliveredIn({
		'src/a.css': `:root { --wpds-color-background-surface-neutral-strong: #fff; }\n${TOKENS_CSS}`,
		'includes/admin.php': enqueue("array( 'site-spec-styles' )"),
	});
	assert(!own.length, 'a self-defined token is delivered with the sheet defining it');
	// No profile, no declared check: nothing to run.
	const bare = undeliveredIn(
		{ 'src/a.css': TOKENS_CSS, 'includes/admin.php': enqueue("array( 'site-spec-styles' )") },
		false,
	);
	assert(!bare.length, 'without a delivery block the rule is silent');
});

await check('the PHP reading is literal and bounded', () => {
	const args = argumentsAt(`f( 'a, b', array( 'c', "d" ), [ 'e' ] ) // x`, 1);
	assert(args?.length === 3, `three top-level arguments: ${JSON.stringify(args)}`);
	assert(dependencyList(args?.[1]).handles.join() === 'c,d', 'a literal list is read');
	assert(dependencyList(args?.[1]).complete, 'and is complete');
	assert(!dependencyList('$deps').complete, 'a variable is not');
	assert(!dependencyList("array_merge( $a, array( 'x' ) )").complete, 'a call is not');
	assert(dependencyList(undefined).complete, 'no argument is an empty list');
	assert(argumentsAt(`f( ${'x'.repeat(6000)}`, 1) === null, 'an unclosed list is unreadable');
	const stripped = stripComments("a(); // b()\n# c()\n#[Attr]\n/* d()\n */ e('//f');");
	assert(!/b\(|c\(|d\(/.test(stripped), `comments are blanked: ${stripped}`);
	assert(stripped.includes("e('//f')") && stripped.includes('#[Attr]'), `strings and attributes kept: ${stripped}`);
	assert(stripped.split('\n').length === 5, 'lines are kept');
});

finish();
