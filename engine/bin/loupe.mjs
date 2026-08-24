#!/usr/bin/env node
/**
 * loupe — the entry point every caller reaches: the `bin/loupe` shim, both
 * hooks, the commands, and `node engine/bin/loupe.mjs` by hand.
 *
 * The engine exists twice. `src/` is the real code: TypeScript, needing both its
 * three dependencies and a runtime that can strip types. `dist/loupe.mjs` is
 * that same code bundled with them and transpiled to plain JavaScript,
 * committed, and rebuilt by `npm run build` — which is what makes this plugin
 * installable from a marketplace at all, since nothing in a marketplace install
 * runs `npm install` on a plugin's behalf, and no version of Node runs `.ts`
 * from a bare `node` invocation on its own.
 *
 * Source wins wherever it can actually run. A checkout with dev dependencies
 * installed is a checkout someone is editing, and pinning that to a bundle
 * would mean edits to `src/` silently doing nothing until a rebuild — a gate
 * reporting yesterday's verdict on today's code, which is the exact failure
 * mode this engine is built to refuse. Everywhere else the bundle runs, so an
 * install with no toolchain is a working install rather than a stack trace on
 * every write.
 *
 * `tsx` stands in for the whole dev toolchain the way `picomatch` used to stand
 * in for the dependency set: it is present exactly in a checkout that ran
 * `npm install`, and it is what lets this file import a `.ts` entry point at
 * all. Absent it, the bundle.
 *
 * `dist/` sits at the same depth as `src/`, so the `import.meta.url` lookups
 * inside the engine — the preset directory, the plugin manifest — resolve to
 * the same paths either way.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..');

const source = join(ENGINE, 'src', 'cli.ts');
const bundle = join(ENGINE, 'dist', 'loupe.mjs');
const sourceRunnable =
	existsSync(join(ENGINE, 'node_modules', 'tsx')) &&
	existsSync(join(ENGINE, 'node_modules', 'picomatch')) &&
	existsSync(source);

const entry = sourceRunnable || !existsSync(bundle) ? source : bundle;

try {
	if (entry === source) {
		// Registering the loader is what teaches this process to import `.ts`.
		// It has to happen before the import, and only in a checkout — a
		// marketplace install has no `tsx` to register.
		//
		// Deliberately never unregistered. The CLI's `main()` is still pending
		// when this import resolves, and the engine imports lazily well after
		// that: a project's `loupe.config.mjs`, and the postcss syntax for the
		// first `.scss` file it meets. Tearing the loader down here would break
		// both, in a checkout only, which is the worst place to differ.
		const { register } = await import('tsx/esm/api');
		register();
		await import(pathToFileURL(entry).href);
	} else {
		await import(pathToFileURL(entry).href);
	}
} catch (thrown) {
	const err = /** @type {{ code?: string, stack?: string } | null} */ (thrown);
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
