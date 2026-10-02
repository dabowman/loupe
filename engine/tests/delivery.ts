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

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDelivery } from '../src/delivery.ts';
import { readProfiles } from '../src/profiles.ts';
import { assert, CLI, check, cleanup, finish, one, scratch, writeAll } from './harness.ts';

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

finish();
