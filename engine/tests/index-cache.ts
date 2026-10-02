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

await check('an unparseable stylesheet stays reported as unparsed when its failure is cached', async () => {
	const root = scratch('loupe-index-broken-');
	try {
		write(root, 'loupe.config.json', JSON.stringify({ extends: 'wpds', sources: { styles: ['**/*.css'] } }));
		write(root, 'styles/broken.css', '.a { color: red;\n.b {');
		await same(root, 'cold');
		age(root);
		await same(root, 'warm');
		const result = JSON.parse(await run(root, { cache: true })) as AnalyzeResult;
		assert(
			result.findings.some((f) => f.rule === 'stylesheet/unparsed'),
			'the cached failure was not reported as stylesheet/unparsed',
		);
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
finish();
