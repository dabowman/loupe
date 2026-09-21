/**
 * Stylesheet parser selection.
 *
 * The `styles` glob ships with `**\/*.scss` in it, and vanilla postcss throws
 * "Unknown word" on the `//` comment that opens most Sass files. Every file that
 * cannot be read is reported as `stylesheet/unparsed` rather than dropped, so a
 * clean report always means "checked and clean".
 *
 * `postcss-scss` and `postcss-less` are optional deps imported by literal
 * specifier, so the bundler folds them into `dist/`. The other two stay behind a
 * computed specifier: resolved from the host's `node_modules` when it has them,
 * reported missing when it does not.
 *
 * Design notes: docs/design/analysis.md
 */

import postcss from 'postcss';
import type { ProcessOptions, Root } from 'postcss';

/**
 * Either a usable parser, or the name of the package that would provide one.
 * The two halves are mutually exclusive, so `if (syntax.missing)` narrows to a
 * parser on the other side without a cast.
 */
export type SyntaxResolution =
	| { parse: (text: string, opts?: ProcessOptions) => Root; missing?: undefined }
	| { parse?: undefined; missing: string };

/** extension -> npm package providing a postcss `syntax`/`parse` export. */
const SYNTAX_PACKAGES: Record<string, string> = {
	'.scss': 'postcss-scss',
	'.sass': 'postcss-sass',
	'.less': 'postcss-less',
	'.styl': 'postcss-styl',
};

/**
 * Literal-specifier loaders for the syntaxes this package ships as optional
 * deps. Anything not listed here falls back to a computed import, which a
 * bundler cannot follow and therefore leaves for the host to resolve.
 */
const BUNDLED_LOADERS: Record<string, () => Promise<unknown>> = {
	'postcss-scss': () => import('postcss-scss'),
	'postcss-less': () => import('postcss-less'),
};

const cache = new Map<string, SyntaxResolution>();

const extOf = (path: string): string => {
	const i = path.lastIndexOf('.');
	return i === -1 ? '' : path.slice(i).toLowerCase();
};

/**
 * Resolve the parser for a path. Returns `{ parse }` on success, or
 * `{ missing }` naming the package to install.
 *
 * Cached per extension including the failure, so a repo with 400 .scss files
 * attempts the import once rather than 400 times.
 */
export async function syntaxFor(path: string): Promise<SyntaxResolution> {
	const ext = extOf(path);
	const pkg = SYNTAX_PACKAGES[ext];
	if (!pkg) return { parse: (text, opts) => postcss.parse(text, opts) };
	const cached = cache.get(pkg);
	if (cached) return cached;

	let resolved: SyntaxResolution;
	try {
		const load = BUNDLED_LOADERS[pkg] ?? (() => import(pkg));
		const mod = (await load()) as { default?: unknown } & Record<string, unknown>;
		const syntax = (mod.default ?? mod) as { parse?: unknown };
		const parse = syntax.parse ?? syntax;
		if (typeof parse !== 'function') throw new Error(`${pkg} exposes no parse()`);
		const parseFn = parse as (text: string, opts?: ProcessOptions) => Root;
		resolved = { parse: (text, opts) => parseFn(text, opts) };
	} catch {
		resolved = { missing: pkg };
	}
	cache.set(pkg, resolved);
	return resolved;
}
