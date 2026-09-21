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
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..');

const source = join(ENGINE, 'src', 'cli.ts');
const bundle = join(ENGINE, 'dist', 'loupe.mjs');
const sourceRunnable =
	Boolean(process.features.typescript) && existsSync(join(ENGINE, 'node_modules', 'picomatch')) && existsSync(source);

const entry = sourceRunnable || !existsSync(bundle) ? source : bundle;

try {
	await import(pathToFileURL(entry).href);
} catch (thrown) {
	const err = /** @type {{ code?: string, stack?: string } | null} */ (thrown);
	process.stderr.write(
		err?.code === 'ERR_MODULE_NOT_FOUND' && entry === source
			? 'loupe: the engine is not runnable from source and no bundle was found.\n' +
					`  Build one:  cd ${ENGINE} && npm install && npm run build\n`
			: `loupe: ${err?.stack || err}\n`,
	);
	process.exitCode = 2;
}
