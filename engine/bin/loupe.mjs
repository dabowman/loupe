#!/usr/bin/env node
/**
 * loupe — the entry point every caller reaches: the `bin/loupe` shim, both
 * hooks, the commands, and `node engine/bin/loupe.mjs` by hand.
 *
 * The engine exists twice. `src/` is the real code: TypeScript, needing both its
 * three dependencies and a Node that strips types (22.18+). `dist/loupe.mjs` is
 * that same code bundled with them and transpiled to plain JavaScript,
 * committed, and rebuilt by `npm run build` — which is what makes this plugin
 * installable from a marketplace at all, since nothing in a marketplace install
 * runs `npm install` on a plugin's behalf.
 *
 * Source wins wherever it can actually run. A checkout with its dependencies
 * installed is a checkout someone is editing, and pinning that to a bundle
 * would mean edits to `src/` silently doing nothing until a rebuild — a gate
 * reporting yesterday's verdict on today's code. Everywhere else the bundle
 * runs, so an install with no toolchain is a working install rather than a
 * stack trace on every write.
 *
 * `dist/` sits at the same depth as `src/`, so the `import.meta.url` lookups
 * inside the engine — the preset directory, the plugin manifest — resolve to
 * the same paths either way.
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
