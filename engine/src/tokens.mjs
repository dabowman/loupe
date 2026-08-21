/**
 * The token set.
 *
 * `tokenPrefixes` used to be cosmetic: it shaped a message and nothing
 * validated anything against it. So a finding said "13px is hardcoded — use a
 * `--wpds-*` token", and the agent, having no list to choose from, invented
 * `--wpds-font-size-13`. A finding that names a namespace instead of a value is
 * a finding that manufactures its own next bug.
 *
 * So read the real set. Token definitions are plain CSS custom properties, and
 * a design system ships them in a file — `@wordpress/theme` emits 190 of them
 * into one stylesheet. Read that, plus anything the project defines itself, and
 * a finding can name the token instead of the namespace.
 *
 * Everything degrades to today's behaviour when no definitions are found: no
 * annotation on hardcoded values, and `tokens/unknown-token` stays silent
 * rather than declaring every token unknown.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';

/**
 * Which token names could plausibly answer for this property.
 *
 * `1px` is both `--wpds-border-radius-xs` and `--wpds-border-width-xs`, and
 * naming the wrong one is worse advice than naming none: the agent applies it,
 * the value is right, and the semantics are quietly wrong forever.
 */
const ROLE_HINTS = [
	[/^border-radius|radius$/, /radius/],
	[/^border(-(top|right|bottom|left))?-width$|^border-width$/, /border-width/],
	// Colour roles are split finer than the rest: suggesting a background token
	// for a `color` gives the right pixels and the wrong meaning, which survives
	// review precisely because it looks correct.
	[/^color$/, /colou?r-(fg|text|content|foreground)/],
	[/^background(-color)?$|^background-image$/, /colou?r-(bg|background|surface)/],
	[/border.*-color$|^border-color$|^outline-color$/, /colou?r-(border|line|stroke)/],
	[/shadow/, /shadow/],
	[/^fill$|^stroke$|caret-color|accent-color|text-decoration-color/, /colou?r/],
	[/^font-size$/, /font-size/],
	[/^font-weight$/, /font-weight/],
	[/^line-height$/, /line-height/],
	[/^letter-spacing$/, /letter-spacing/],
	[/^font-family$|^font$/, /font-family/],
	[/padding|^gap$|gap$|^inset$|^top$|^right$|^bottom$|^left$/, /dimension|spac|padding|gap/],
];

/** Comparable form of a CSS value: case, spacing, shorthand hex, `!important`. */
export function normalizeValue(value) {
	let v = String(value).trim().toLowerCase().replace(/\s*!important\s*$/, '').replace(/\s+/g, ' ');
	v = v.replace(/#([0-9a-f])([0-9a-f])([0-9a-f])\b/g, '#$1$1$2$2$3$3');
	return v;
}

/** An empty set, in the shape `read` returns. */
export const emptyTokenSet = () => ({ known: new Set(), byValue: new Map(), sources: 0 });

/** Record every `--prefix-*: value` declaration in a parsed stylesheet. */
export function harvestTokenDefs(root, prefixes, into) {
	if (!prefixes.length) return into;
	root.walkDecls((decl) => {
		const name = decl.prop;
		if (!name.startsWith('--') || !prefixes.some((p) => name.startsWith(p))) return;
		into.known.add(name);
		const v = normalizeValue(decl.value);
		// A token defined as another token tells us nothing about literal values.
		if (!v || v.includes('var(')) return;
		if (!into.byValue.has(v)) into.byValue.set(v, []);
		if (!into.byValue.get(v).includes(name)) into.byValue.get(v).push(name);
	});
	return into;
}

/** `.css` files under a path, which may be a file or a directory. Bounded. */
function cssFilesUnder(path, budget = { left: 200 }) {
	let st;
	try {
		st = statSync(path);
	} catch {
		return []; // a token source that isn't installed is not an error
	}
	if (st.isFile()) return path.endsWith('.css') ? [path] : [];
	const out = [];
	const walk = (dir) => {
		if (budget.left <= 0) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (budget.left <= 0) return;
			const full = join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.name.endsWith('.css')) {
				out.push(full);
				budget.left--;
			}
		}
	};
	walk(path);
	return out;
}

/**
 * Read the declared token set from `designSystem.tokenSources`.
 *
 * These paths deliberately reach into `node_modules`, which the project walk
 * prunes: the design system's tokens are the whole point, and they live there.
 */
export function readTokenSources(root, sources, prefixes) {
	const set = emptyTokenSet();
	if (!prefixes.length) return set;
	for (const rel of sources || []) {
		for (const file of cssFilesUnder(join(root, rel))) {
			try {
				harvestTokenDefs(postcss.parse(readFileSync(file, 'utf8'), { from: file }), prefixes, set);
				set.sources++;
			} catch {
				/* an unparseable vendored stylesheet just contributes nothing */
			}
		}
	}
	return set;
}

/**
 * The token(s) that carry `value` for `prop`, most specific first.
 * Empty when nothing matches, or when only off-role tokens do.
 */
export function tokensFor(set, prop, value) {
	const names = set.byValue.get(normalizeValue(value));
	if (!names?.length) return [];
	const hint = ROLE_HINTS.find(([p]) => p.test(prop))?.[1];
	if (!hint) return [];
	const onRole = names.filter((n) => hint.test(n));
	return onRole.length ? onRole : [];
}

/** `→ var(--wpds-border-radius-md)`, or `` when nothing on-role matches. */
export function suggestionFor(set, prop, value) {
	const names = tokensFor(set, prop, value);
	if (!names.length) return '';
	const shown = names.slice(0, 2).map((n) => `var(${n})`).join(' or ');
	return ` → ${shown}${names.length > 2 ? ` (+${names.length - 2} more)` : ''}`;
}

/** Every `var(--prefix-…)` referenced in a value. */
export function tokenRefsIn(value, prefixes) {
	if (!prefixes.length) return [];
	const out = [];
	for (const m of String(value).matchAll(/var\(\s*(--[\w-]+)/g))
		if (prefixes.some((p) => m[1].startsWith(p))) out.push(m[1]);
	return out;
}
