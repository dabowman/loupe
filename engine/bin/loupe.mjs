#!/usr/bin/env node
/**
 * loupe — the entry point every caller reaches: the `bin/loupe` shim, both
 * hooks, the commands, and `node engine/bin/loupe.mjs` by hand.
 *
 * The engine exists twice. `src/` is the real code and needs its three
 * dependencies installed. `dist/loupe.mjs` is that same code bundled with them,
 * committed, and rebuilt by `npm run build` — which is what makes this plugin
 * installable from a marketplace at all, since nothing in a marketplace install
 * runs `npm install` on a plugin's behalf.
 *
 * Source wins wherever it can actually run. A checkout with deps installed is a
 * checkout someone is editing, and pinning that to a bundle would mean edits to
 * `src/` silently doing nothing until a rebuild — a gate reporting yesterday's
 * verdict on today's code, which is the exact failure mode this engine is built
 * to refuse. Everywhere else the bundle runs, so an install with no toolchain
 * is a working install rather than a stack trace on every write.
 *
 * `dist/` sits at the same depth as `src/`, so the three `import.meta.url`
 * lookups inside the engine — the preset directory, the plugin manifest —
 * resolve to the same paths either way.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..');

// picomatch stands in for the whole dependency set: it is a hard import on the
// first module the CLI loads, so if it is absent the source tree cannot start.
const sourceRunnable = existsSync(join(ENGINE, 'node_modules', 'picomatch'));
const source = join(ENGINE, 'src', 'cli.mjs');
const bundle = join(ENGINE, 'dist', 'loupe.mjs');

const entry = sourceRunnable || !existsSync(bundle) ? source : bundle;

try {
	await import(pathToFileURL(entry).href);
} catch (err) {
	if (err?.code === 'ERR_MODULE_NOT_FOUND' && entry === source) {
		process.stderr.write(
			'loupe: the engine is not runnable from source and no bundle was found.\n' +
				`  Build one:  cd ${ENGINE} && npm install && npm run build\n` +
				`  Or install deps only:  cd ${ENGINE} && npm install\n`,
		);
		process.exitCode = 2;
	} else {
		process.stderr.write(`loupe: ${err?.stack || err}\n`);
		process.exitCode = 2;
	}
}
