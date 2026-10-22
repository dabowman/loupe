#!/usr/bin/env node
/**
 * The index cache changes what a run costs and nothing else.
 *
 * Every fixture is copied out, then analyzed three ways — uncached, cold, warm —
 * and again after each kind of change a cache could miss: an edit, a deletion,
 * a new file, a same-size edit inside one mtime tick, a config change, a judged
 * run. Each cached result must equal, byte for byte, an uncached run of the same
 * tree. Equal findings are not enough: diagnostics, directives, the token set
 * and the controls all ride along.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyze.ts';
import { loadConfig } from '../src/config.ts';
import { IndexCache } from '../src/index-cache.ts';
import { readProfiles } from '../src/profiles.ts';
import type { AnalyzeResult } from '../src/types.ts';
import { CLI, assert, check, cleanup, finish, scratch, write } from './harness.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Everything a result carries, with its sets and maps written out in a stable order. */
const snapshot = (r: AnalyzeResult): string =>
	JSON.stringify(r, (_k, v: unknown) => {
		if (v instanceof Set) return [...v].map(String).sort();
		if (v instanceof Map) return [...v].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
		return v;
	});

async function run(root: string, opts: { cache: boolean; judge?: boolean }, configPatch?: object): Promise<string> {
	const configPath = join(root, 'loupe.config.json');
	if (configPatch) {
		const base = JSON.parse(readFileSync(configPath, 'utf8')) as object;
		writeFileSync(configPath, JSON.stringify({ ...base, ...configPatch }));
	}
	const config = await loadConfig({ root, configPath });
	return snapshot(await analyze(config, { scope: null, cache: opts.cache, judge: opts.judge ?? false }));
}

/** Uncached, then cached: the cached run must say exactly what the uncached one did. */
async function same(root: string, label: string, judge = false): Promise<void> {
	const want = await run(root, { cache: false, judge });
	const got = await run(root, { cache: true, judge });
	assert(got === want, `${label}: the cached run differs from an uncached one`);
}

function files(root: string, ext: RegExp): string[] {
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (ext.test(e.name)) out.push(p);
		}
	};
	walk(root);
	return out.sort();
}

/** Every file an hour old: the state in which the cache trusts `stat` alone. */
function age(root: string): void {
	const then = (Date.now() - 3_600_000) / 1000;
	for (const f of files(root, /./)) utimesSync(f, then, then);
}

const state = scratch('loupe-index-state-');
process.env.CLAUDE_PLUGIN_DATA = state;

for (const name of readdirSync(FIXTURES).sort()) {
	await check(`${name}: cold, warm and after every kind of change, the cache answers as a fresh run does`, async () => {
		const root = scratch(`loupe-index-${name}-`);
		try {
			cpSync(join(FIXTURES, name), root, { recursive: true });
			rmSync(join(root, 'expected.json'));

			// Fresh mtimes: every entry is inside the racy window, so it is verified by hash.
			await same(root, 'cold');
			await same(root, 'warm, hash-verified');

			// Old mtimes: entries are trusted on `stat` alone.
			age(root);
			await same(root, 'aged, first run');
			await same(root, 'aged, stat-trusted');

			const markup = files(root, /\.(jsx|tsx|html)$/);
			const sheets = files(root, /\.(css|scss)$/);

			// An edit that changes the size.
			const target = markup[0] ?? sheets[0];
			if (target) {
				writeFileSync(target, `${readFileSync(target, 'utf8')}\n`);
				await same(root, 'after an edit');
			}

			// A same-size edit inside one mtime tick, with the mtime put back: only
			// the racy guard can see it.
			const racy = sheets[0] ?? markup[0];
			if (racy) {
				const before = readFileSync(racy, 'utf8');
				writeFileSync(racy, before);
				await run(root, { cache: true });
				const { atime, mtime } = statSync(racy);
				const swapped = before.replace(/[0-9]/, (d) => String((Number(d) + 1) % 10));
				if (swapped !== before) {
					writeFileSync(racy, swapped);
					utimesSync(racy, atime, mtime);
					await same(root, 'after a same-size edit with the mtime restored');
				}
			}

			// A suppression directive arriving in a file that had none.
			if (sheets[0]) {
				writeFileSync(sheets[0], `/* wpds-allow tokens/hardcoded-value -- test */\n${readFileSync(sheets[0], 'utf8')}`);
				await same(root, 'after a directive is added');
			}

			// A new file, then a deleted one.
			write(root, 'src/Added.jsx', 'export const Added = () => <p style={{ marginBottom: 4 }}>Hi</p>;\n');
			await same(root, 'after a file is added');
			if (sheets[1] ?? markup[1]) {
				rmSync((sheets[1] ?? markup[1]) as string);
				await same(root, 'after a file is deleted');
			}

			// A judged run collects controls; an unjudged one must not, from the same cache.
			await same(root, 'judged', true);
			await same(root, 'unjudged after judged');

			// Severities are applied live, never cached.
			await same(root, 'after a severity change', false);
			await run(root, { cache: false }, { rules: { 'layout/margin-on-child': 'off' } });
			await same(root, 'with a rule turned off');
		} finally {
			cleanup(root);
		}
	});
}

// A failure can be the parser's rather than the file's, and an upgraded
// postcss-scss or babel is not in the fingerprint: a failure is never kept, so
// the next run asks the parser again.
await check('an unparseable file stays reported, and its failure is never cached', async () => {
	const root = scratch('loupe-index-broken-');
	try {
		write(root, 'loupe.config.json', JSON.stringify({ extends: 'wpds', sources: { styles: ['**/*.css'] } }));
		write(root, 'styles/broken.css', '.a { color: red;\n.b {');
		write(root, 'styles/fine.css', '.a { color: red; }');
		write(root, 'src/Broken.jsx', 'export const A = () => <div>;');
		await same(root, 'cold');
		age(root);
		await same(root, 'warm');
		const result = JSON.parse(await run(root, { cache: true })) as AnalyzeResult;
		assert(
			result.findings.some((f) => f.rule === 'stylesheet/unparsed'),
			'the failure was not reported as stylesheet/unparsed',
		);
		const index = files(state, /^index-.*\.json$/).filter((f) => statSync(f).mtimeMs > Date.now() - 5000);
		const stored = index.flatMap((f) =>
			Object.keys((JSON.parse(readFileSync(f, 'utf8')) as { entries: object }).entries),
		);
		assert(stored.includes('styles/fine.css'), `the parsed sheet was not cached: ${stored.join(', ')}`);
		assert(!stored.includes('styles/broken.css'), 'a stylesheet that failed to parse was cached');
		assert(!stored.includes('src/Broken.jsx'), 'markup that failed to parse was cached');
	} finally {
		cleanup(root);
	}
});

await check('a corrupt index file is a cold cache, not a failure', async () => {
	const root = scratch('loupe-index-corrupt-');
	try {
		cpSync(join(FIXTURES, 'inline-styles'), root, { recursive: true });
		await run(root, { cache: true });
		const dir = files(state, /^index-.*\.json$/).filter((f) => statSync(f).mtimeMs > Date.now() - 5000);
		for (const f of dir) writeFileSync(f, '{"version":1,"entries":{"src/Inline.jsx":');
		await same(root, 'after corruption');
	} finally {
		cleanup(root);
	}
});

await check(
	'through the CLI, with the shipped profiles and their registries, cached output is uncached output',
	async () => {
		const root = scratch('loupe-index-cli-');
		try {
			write(
				root,
				'package.json',
				JSON.stringify({ dependencies: { '@wordpress/components': '*', '@wordpress/ui': '*' } }),
			);
			write(
				root,
				'src/Settings.jsx',
				[
					"import { Button, Modal, Flex, FlexItem, Card, CardHeader, CardBody } from '@wordpress/components';",
					"import './settings.css';",
					'export function Settings({ onClose }) {',
					'  return (',
					'    <Modal title="Settings" onRequestClose={onClose}>',
					'      <Card className="s-card"><CardHeader><h2>General</h2></CardHeader><CardBody><p>Body</p></CardBody></Card>',
					'      <Flex justify="flex-end"><FlexItem><Button variant="tertiary" onClick={onClose}>Cancel</Button></FlexItem>',
					'      <FlexItem><Button variant="primary">Save</Button></FlexItem></Flex>',
					'    </Modal>',
					'  );',
					'}',
				].join('\n'),
			);
			write(root, 'src/settings.css', '.s-card { margin-top: 12px; padding: 16px; color: #1e1e1e; }\n');
			const PROFILES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'profiles');
			const cli = (extra: string[]): string => {
				try {
					return execFileSync(
						'node',
						[CLI, 'check', '--root', root, '--all', '--format', 'json', '--profiles', PROFILES, ...extra],
						{
							encoding: 'utf8',
							env: { ...process.env, LOUPE_NO_CACHE: '' },
						},
					);
				} catch (err) {
					return (err as { stdout: string }).stdout;
				}
			};
			const want = cli(['--no-cache']);
			assert(JSON.parse(want).findings.length > 0, 'the project produced no findings to compare');
			assert(cli([]) === want, 'the cold cached run differs');
			age(root);
			assert(cli([]) === want, 'the first aged run differs');
			assert(cli([]) === want, 'the stat-trusted run differs');
		} finally {
			cleanup(root);
		}
	},
);

cleanup(state);
// What the profile-driven passes read off the walk: the elements a class lands
// on (token scopes), the tokens the project defines (`tokens/undelivered`), a
// parse error's reason (its key). And `contents`, the hook's "before the edit":
// a file it stands in for is never answered from the cache, nor stored in it.
await check('with a profile active, and under `contents`, cached output is uncached output', async () => {
	const root = scratch('loupe-index-profile-');
	const PROFILES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'profiles');
	const wpds = readProfiles(PROFILES).filter((p) => p.id === 'wpds');
	assert(wpds.length === 1, 'the wpds profile ships');
	const analyzed = async (opts: { cache: boolean; contents?: ReadonlyMap<string, string> }): Promise<string> => {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		config.profiles = { available: wpds, active: wpds, applied: [], skipped: [], notes: [], errors: [] };
		return snapshot(await analyze(config, { scope: null, ...opts }));
	};
	try {
		write(root, 'package.json', JSON.stringify({ dependencies: { '@wordpress/components': '*' } }));
		write(root, 'loupe.config.json', JSON.stringify({ extends: 'wpds', namespaces: { project: ['rp-'] } }));
		write(
			root,
			'node_modules/@wordpress/theme/prebuilt/css/design-tokens.css',
			':root { --wpds-border-radius-md: 4px; --wpds-border-radius-sm: 2px; --wpds-color-bg-surface-neutral: #fff; }',
		);
		write(
			root,
			'src/App.jsx',
			[
				"import { Button } from '@wordpress/components';",
				"import './app.css';",
				'export const App = () => (<><Button className="rp-b">Go</Button><dialog className="rp-d" /></>);',
			].join('\n'),
		);
		write(
			root,
			'src/app.css',
			[
				':root { --wpds-project-brand: #c00; }',
				'.rp-b { border-radius: var(--wpds-border-radius-md); background: var(--wpds-color-bg-surface-neutral); }',
				'.rp-d { border-radius: 4px; }',
			].join('\n'),
		);
		write(root, 'src/broken.css', '.rp-x { color: red;\n.rp-y {');
		write(root, 'plugin.php', "<?php wp_enqueue_style( 'rp', 'app.css', array( 'wp-components' ) );");

		const want = await analyzed({ cache: false });
		assert(want.includes('tokens/misapplied-token'), 'the fixture should exercise token scopes');
		assert(want.includes('Unclosed block'), 'the fixture should carry a parse error keyed on its reason');
		assert((await analyzed({ cache: true })) === want, 'cold');
		age(root);
		assert((await analyzed({ cache: true })) === want, 'warm');

		// The hook's question: the same tree with one file as it was before an edit.
		const before = new Map([['src/app.css', '.rp-b { border-radius: 2px; }\n']]);
		const asWas = await analyzed({ cache: false, contents: before });
		assert(asWas !== want, 'the stand-in should change the answer, or this proves nothing');
		assert((await analyzed({ cache: true, contents: before })) === asWas, 'warm, under contents');
		// And it was not stored as the file's: the disk's answer is unchanged.
		assert((await analyzed({ cache: true })) === want, 'after a run under contents');
	} finally {
		cleanup(root);
	}
});

// The racy-mtime guard trusts an entry on `stat` only when its mtime is two
// seconds older than the read. Stamped when stored, after a scan that can take
// seconds, a same-size rewrite in the read's mtime tick was trusted for good.
await check('an entry records when its file was read, not when it was stored', async () => {
	const root = scratch('loupe-index-stamp-');
	try {
		write(root, 'a.css', '.a { color: red; }');
		const cache = new IndexCache(root, { stamp: 1 });
		const look = cache.lookup(join(root, 'a.css'), 'a.css');
		await new Promise((r) => setTimeout(r, 50));
		const stored = Date.now();
		cache.store(look, 'a.css', '.a { color: red; }', { d: false });
		cache.save();
		const entry = (JSON.parse(readFileSync(cache.path, 'utf8')) as { entries: Record<string, { t: number }> }).entries[
			'a.css'
		];
		assert(entry !== undefined && entry.t === look.at && entry.t < stored, `stamped ${entry?.t}, read at ${look.at}`);
	} finally {
		cleanup(root);
	}
});

finish();
