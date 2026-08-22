/**
 * Stylesheet parser selection.
 *
 * The analyzer used vanilla postcss for every file the `styles` glob matched,
 * and that glob ships with `**\/*.scss` in it. A single `//` comment — line one
 * of most Sass files — throws "Unknown word", the file is dropped, and the only
 * trace is a footnote under the findings. A Sass codebase got a clean report
 * from a tool that had read none of it. Silence is the worst failure mode a
 * gate can have.
 *
 * Custom syntaxes are optional peer deps, resolved at first use. A machine
 * without `postcss-scss` still gets a working gate on its plain CSS plus an
 * explicit finding naming every file it could not read, rather than a quiet
 * hole in coverage. That is the difference between degraded and dishonest.
 *
 * The two declared as optional deps are imported by literal specifier so the
 * bundler can see them and fold them into `dist/`, which is the only reason a
 * marketplace install parses Sass at all. The other two stay behind a computed
 * specifier: not shipped, resolved from the host's `node_modules` when it
 * happens to have them, reported missing when it doesn't.
 */

import postcss from 'postcss';

/** extension -> npm package providing a postcss `syntax`/`parse` export. */
const SYNTAX_PACKAGES = {
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
const BUNDLED_LOADERS = {
	'postcss-scss': () => import('postcss-scss'),
	'postcss-less': () => import('postcss-less'),
};

const cache = new Map();

const extOf = (path) => {
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
export async function syntaxFor(path) {
	const ext = extOf(path);
	const pkg = SYNTAX_PACKAGES[ext];
	if (!pkg) return { parse: (text, opts) => postcss.parse(text, opts) };
	if (cache.has(pkg)) return cache.get(pkg);

	let resolved;
	try {
		const load = BUNDLED_LOADERS[pkg] ?? (() => import(pkg));
		const mod = await load();
		const syntax = mod.default ?? mod;
		const parse = syntax.parse ?? syntax;
		if (typeof parse !== 'function') throw new Error(`${pkg} exposes no parse()`);
		resolved = { parse: (text, opts) => parse(text, opts) };
	} catch {
		resolved = { missing: pkg };
	}
	cache.set(pkg, resolved);
	return resolved;
}

/** Extensions that need a custom syntax, for the config-doctor path. */
export const syntaxPackages = () => ({ ...SYNTAX_PACKAGES });

/** Test seam: forget resolution results between runs. */
export const resetSyntaxCache = () => cache.clear();
