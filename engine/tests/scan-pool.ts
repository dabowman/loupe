#!/usr/bin/env node
/**
 * Where a scan is made never shows in what it found.
 *
 * Workers scan the same files the main thread would, so every result here is
 * compared against an in-process run: per scan through the pool directly, and
 * per report through the CLI — from source and from the bundle, since the
 * bundle's worker is the bundle itself reloaded and is the copy a marketplace
 * install runs. `LOUPE_DEBUG_SCAN` proves the workers actually ran: a pool that
 * quietly fell back would pass every comparison while being broken.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { scanMarkup } from '../src/markup.ts';
import { inWorkers } from '../src/scan-pool.ts';
import type { ScanJob } from '../src/scan-pool.ts';
import { assert, check, cleanup, finish, scratch, write } from './harness.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const ENGINE = join(HERE, '..');

const stable = (v: unknown): string =>
	JSON.stringify(v, (_k, x: unknown) => (x instanceof Set ? [...x].map(String).sort() : x));

await check('a scan made in a worker is the scan the main thread makes', async () => {
	const config = await loadConfig({ root: join(FIXTURES, 'inline-styles'), preset: 'wpds' });
	const jobs: ScanJob[] = [];
	for (const name of readdirSync(FIXTURES))
		for (const sub of ['src', 'templates']) {
			let entries: string[] = [];
			try {
				entries = readdirSync(join(FIXTURES, name, sub));
			} catch {
				continue;
			}
			for (const f of entries)
				jobs.push({ rel: `${name}/${sub}/${f}`, text: readFileSync(join(FIXTURES, name, sub, f), 'utf8') });
		}
	assert(jobs.length >= 5, `only ${jobs.length} fixture files to scan`);
	const want = jobs.map((j) => scanMarkup(j.text, j.rel, config.designSystem, []));
	const got = await inWorkers(jobs, config.designSystem, [], 3);
	assert(got.length === want.length, `${got.length} scans back for ${want.length} files`);
	got.forEach((g, i) => {
		assert(stable(g) === stable(want[i]), `the worker's scan of ${jobs[i]?.rel} differs`);
	});
});

// Enough markup to clear the pool's floor (150 files, 600 kB).
const root = scratch('loupe-workers-');
write(root, 'package.json', JSON.stringify({ dependencies: { '@wordpress/components': '*', '@wordpress/ui': '*' } }));
write(root, 'loupe.config.json', JSON.stringify({ extends: 'wpds', namespaces: { project: ['w-'] } }));
const filler = `// ${'x'.repeat(4000)}\n`;
for (let i = 0; i < 180; i++)
	write(
		root,
		`src/C${i}.jsx`,
		`${filler}import { Button } from '@wordpress/components';\nexport const C${i} = () => <div className="w-c${i}" style={{ marginBottom: ${i % 9}px }}><p>Item ${i}</p><Button>Go</Button></div>;\n`,
	);
write(root, 'src/c.css', '.w-c1 { display: flex; gap: 8px; }\n.w-c2 { margin-top: 4px; }\n');

const cli = (entry: string, env: Record<string, string>): { stdout: string; stderr: string } => {
	try {
		const stdout = execFileSync('node', [entry, 'check', '--root', root, '--all', '--format', 'json'], {
			encoding: 'utf8',
			env: { ...process.env, LOUPE_NO_CACHE: '1', LOUPE_DEBUG_SCAN: '1', ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { stdout, stderr: '' };
	} catch (err) {
		const e = err as { stdout: string; stderr: string; status: number };
		if (e.status !== 1) throw new Error(`exit ${e.status}: ${e.stderr}`);
		return { stdout: e.stdout, stderr: e.stderr };
	}
};

for (const [label, entry] of [
	['source', join(ENGINE, 'bin', 'loupe.mjs')],
	['bundle', join(ENGINE, 'dist', 'loupe.mjs')],
] as const) {
	await check(`from the ${label}, a run scanned across workers reports what an in-process run does`, () => {
		const inProcess = cli(entry, { LOUPE_NO_WORKERS: '1' });
		const pooled = cli(entry, { LOUPE_NO_WORKERS: '' });
		assert(/in-process/.test(inProcess.stderr), `the baseline run did not scan in-process: ${inProcess.stderr}`);
		assert(/across \d+ worker/.test(pooled.stderr), `no workers ran: ${pooled.stderr}`);
		assert(JSON.parse(pooled.stdout).findings.length > 0, 'nothing was found to compare');
		assert(pooled.stdout === inProcess.stdout, 'the pooled run reported something different');
	});
}

cleanup(root);
finish();
