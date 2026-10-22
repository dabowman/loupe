#!/usr/bin/env node
/**
 * loupe — the entry point every caller reaches: the `bin/loupe` shim, both
 * hooks, the commands, and `node engine/bin/loupe.mjs` by hand.
 *
 * The engine exists twice. `src/` is the real code — TypeScript, needing its
 * three dependencies and a Node that strips types (22.18+). `dist/loupe.mjs` is
 * that same code bundled and transpiled, committed, and rebuilt by `npm run
 * build`.
 *
 * Source wins wherever it can actually run, so edits to `src/` never sit behind
 * a stale bundle; everywhere else the bundle runs, so an install with no
 * toolchain is a working install.
 *
 * `dist/` sits at the same depth as `src/`, so the `import.meta.url` lookups
 * inside the engine resolve to the same paths either way.
 *
 * Design notes: docs/design/cli.md#building-and-distribution
 */

import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..');

const source = join(ENGINE, 'src', 'cli.ts');
const bundle = join(ENGINE, 'dist', 'loupe.mjs');

// "Can actually run" is more than "the dependencies resolve". Node refuses to
// strip types from anything under `node_modules`, so an npm install never runs
// source, whatever it has installed beside it. And `src/` reaches out of the
// package for the pattern language, `../../patterns/index.json`, which only the
// repo checkout has — a vendored copy of the engine has its deps and its source
// and still cannot load it. The bundle has that file compiled in and strips no
// types, so in both places it is the one to run.
const sourceRunnable =
	Boolean(process.features.typescript) &&
	!ENGINE.split(sep).includes('node_modules') &&
	existsSync(join(ENGINE, 'node_modules', 'picomatch')) &&
	existsSync(join(ENGINE, '..', 'patterns', 'index.json')) &&
	existsSync(source);

const entry = sourceRunnable || !existsSync(bundle) ? source : bundle;

// The ways a `.ts` entry fails to load, as opposed to failing once it runs: a
// dependency or data file that is not there, a Node that strips no types, and
// one that will not strip them under `node_modules`.
const UNLOADABLE = new Set([
	'ERR_MODULE_NOT_FOUND',
	'ERR_UNKNOWN_FILE_EXTENSION',
	'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING',
]);

try {
	await import(pathToFileURL(entry).href);
} catch (thrown) {
	const err = /** @type {{ code?: string, message?: string, stack?: string } | null} */ (thrown);
	// Source is only the fallback when there is no bundle. When it was chosen over
	// one, the failure is a fault in the checkout, and the stack is what says so.
	process.stderr.write(
		entry === source && !existsSync(bundle) && UNLOADABLE.has(err?.code ?? '')
			? 'loupe: the engine cannot run from source here, and has no bundle to run instead.\n' +
					`  ${String(err?.message).split('\n')[0]}\n` +
					`  Build one:  cd ${ENGINE} && npm install && npm run build\n`
			: `loupe: ${err?.stack || err}\n`,
	);
	process.exitCode = 2;
}
