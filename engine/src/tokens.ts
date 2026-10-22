/**
 * The token set.
 *
 * Token definitions are plain CSS custom properties, and a design system ships
 * them in a file — `@wordpress/theme` emits 190 of them into one stylesheet.
 * Reading that, plus anything the project defines itself, is what lets a finding
 * name the token rather than the namespace.
 *
 * Everything degrades when no definitions are found: no annotation on hardcoded
 * values, and `tokens/unknown-token` stays silent rather than declaring every
 * token unknown.
 *
 * Design notes: docs/design/analysis.md#the-token-set
 */

import { readFileSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { filesUnder } from './discover.ts';
import postcss from 'postcss';
import type { Root } from 'postcss';
import { scopedFamily } from './scopes.ts';
import type { TokenScopes } from './scopes.ts';
import { COLOR_SHORTHANDS, isColorLiteral } from './styles.ts';
import { messageParts, snippet } from './text.ts';
import type { Suggestion, TokenSet } from './types.ts';

/**
 * Which token names could plausibly answer for this property, when no profile
 * says. Naming the wrong one is worse advice than naming none: `1px` is both
 * `--wpds-border-radius-xs` and `--wpds-border-width-xs`, and the agent applies
 * whichever it is given.
 *
 * This is the fallback, not the source of truth. Its alternate spellings
 * (`fg|text|content|foreground`) are a guess at several systems' conventions at
 * once; a profile's `tokenScopes` states its own system's, and wherever it
 * declares what a property's tokens are, it decides instead — see `scopes.ts`.
 * A profile declaring nothing, and every property it does not cover, gets
 * exactly this table.
 */
export const GENERIC_ROLES: readonly (readonly [RegExp, RegExp, RegExp?])[] = [
	[/^border-radius|radius$/, /radius/],
	[/^border(-(top|right|bottom|left))?-width$|^border-width$|^outline-width$/, /border-width/],
	// Colour roles are split finer than the rest: a background token suggested for
	// a `color` gives the right pixels and the wrong meaning.
	[/^color$/, /colou?r-(fg|text|content|foreground)/],
	[/^background(-color)?$|^background-image$/, /colou?r-(bg|background|surface)/],
	[/border.*-color$|^border-color$|^outline-color$/, /colou?r-(border|line|stroke)/],
	// A shorthand's token is its colour's: the width and style stay as written.
	[
		/^(border|outline|column-rule)(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?$/,
		/colou?r-(border|line|stroke)/,
	],
	[/shadow/, /shadow/],
	[/^fill$|^stroke$|caret-color|accent-color|^text-decoration(-color)?$/, /colou?r/],
	[/^font-size$/, /font-size/],
	[/^font-weight$/, /font-weight/],
	[/^line-height$/, /line-height/],
	[/^letter-spacing$/, /letter-spacing/],
	[/^font-family$|^font$/, /font-family/],
	// The third entry is the property's own family, preferred when the set has
	// one: `padding: 8px` is `padding-sm`, not `gap-sm` or `size-4xs`.
	[/padding/, /dimension|spac|padding|gap/, /padding/],
	[/gap$/, /dimension|spac|padding|gap/, /gap/],
	// Position is spacing: an offset from an edge. `dimension` alone would admit
	// the sizes (icons, buttons) and surface widths a system also ships under it.
	[/^inset$|^top$|^right$|^bottom$|^left$/, /spac|padding|gap/],
	[/^cursor$/, /cursor/],
	// Never flagged as a hardcoded value; here for the token a name in one meant.
	[/^(min-|max-)?(width|height|inline-size|block-size)$/, /(?<!font-)size|surface-width/],
	// By role word, not by one system's spelling: WPDS writes `motion-duration-*`,
	// Archer `duration-*`.
	[/^transition-duration$|^animation-duration$/, /duration/],
	[/^transition-timing-function$|^animation-timing-function$/, /easing/],
];

/** Comparable form of a CSS value: case, spacing, shorthand hex, `!important`. */
function normalizeValue(value: unknown): string {
	let v = String(value)
		.trim()
		.toLowerCase()
		.replace(/\s*!important\s*$/, '')
		.replace(/\s+/g, ' ');
	v = v.replace(/#([0-9a-f])([0-9a-f])([0-9a-f])\b/g, '#$1$1$2$2$3$3');
	return v;
}

/** An empty set, in the shape `read` returns. */
export const emptyTokenSet = (): TokenSet => ({ known: new Set(), byValue: new Map(), sources: 0 });

/**
 * Record one custom-property definition. A token's value is its first
 * definition: later ones are modes — `[data-wpds-corner-radius="moderate"]`
 * makes `radius-md` 12px — and indexing them offers `12px` as "md or xl" when
 * the default md is 4px.
 */
export function addTokenDef(into: TokenSet, name: string, value: string): void {
	if (into.known.has(name)) return;
	into.known.add(name);
	const v = normalizeValue(value);
	// A token defined as another token tells us nothing about literal values.
	if (!v || v.includes('var(')) return;
	const names = into.byValue.get(v) ?? [];
	if (!names.includes(name)) names.push(name);
	into.byValue.set(v, names);
}

/** Every `--prefix-*: value` declaration in a parsed stylesheet, in source order. */
export function tokenDefsIn(root: Root, prefixes: readonly string[]): [string, string][] {
	const out: [string, string][] = [];
	if (!prefixes.length) return out;
	root.walkDecls((decl) => {
		if (decl.prop.startsWith('--') && prefixes.some((p) => decl.prop.startsWith(p))) out.push([decl.prop, decl.value]);
	});
	return out;
}

/** Record every `--prefix-*: value` declaration in a parsed stylesheet. */
export function harvestTokenDefs(root: Root, prefixes: readonly string[], into: TokenSet): TokenSet {
	for (const [name, value] of tokenDefsIn(root, prefixes)) addTokenDef(into, name, value);
	return into;
}

/** Stylesheets under a path, which may be a file or a directory. Bounded. */
export function cssFilesUnder(
	path: string,
	budget: { left: number } = { left: 200 },
	exts: readonly string[] = ['.css'],
): string[] {
	const wanted = (name: string): boolean => exts.some((e) => name.endsWith(e));
	let st: Stats;
	try {
		st = statSync(path);
	} catch {
		return []; // a token source that isn't installed is not an error
	}
	if (st.isFile()) return wanted(path) ? [path] : [];
	const out: string[] = [];
	// Checked before the walk and right after each take: pulling one more file
	// from the generator reads every directory up to it, which a spent budget
	// must not pay for.
	if (budget.left <= 0) return out;
	for (const file of filesUnder(path, wanted)) {
		out.push(file);
		if (--budget.left <= 0) break;
	}
	return out;
}

/**
 * Read the declared token set from `designSystem.tokenSources`. These paths
 * deliberately reach into `node_modules`, which the project walk prunes.
 */
export function readTokenSources(
	root: string,
	sources: readonly string[] | undefined,
	prefixes: readonly string[],
): TokenSet {
	const set = emptyTokenSet();
	if (!prefixes.length) return set;
	for (const rel of sources ?? []) {
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
 * The names that answer for `prop`: on-role, and the property's own family when
 * the set has one. Declared scopes decide wherever they cover the property; the
 * generic table everywhere else.
 */
export function onRole(names: readonly string[], prop: string, scopes?: TokenScopes | undefined): string[] {
	return (scopes ? scopedFamily(scopes, names, prop, genericRole) : null) ?? genericRole(names, prop);
}

/** The names the generic table puts on `prop`. */
function genericRole(names: readonly string[], prop: string): string[] {
	const [, hint, own] = GENERIC_ROLES.find(([p]) => p.test(prop)) ?? [];
	if (!hint) return [];
	const onRole = names.filter((n) => hint.test(n));
	const preferred = own ? onRole.filter((n) => own.test(n)) : [];
	return preferred.length ? preferred : onRole;
}

/**
 * The token(s) that carry `value` for `prop`, most specific first.
 * Empty when nothing matches, or when only off-role tokens do.
 */
export function tokensFor(set: TokenSet, prop: string, value: string): string[] {
	// The role is decided over the whole set, not over the tokens that happen to
	// carry the value: a padding scale that stops at 32px makes `padding: 40px`
	// a question, not `gap-3xl` because only a gap step is 40px.
	const family = roleOf(set, prop);
	return (set.byValue.get(normalizeValue(value)) ?? []).filter((n) => family.has(n));
}

/** Every on-role token for `prop` that has a literal value, as `[name, value]`, whatever the value. */
function familyFor(set: TokenSet, prop: string): [string, string][] {
	const cache = familiesOf(set);
	let family = cache.literal.get(prop);
	if (!family) {
		const all = [...set.byValue].flatMap(([v, names]) => names.map((n): [string, string] => [n, v]));
		const keep = new Set(
			onRole(
				all.map(([n]) => n),
				prop,
				set.scopes,
			),
		);
		family = all.filter(([n]) => keep.has(n));
		cache.literal.set(prop, family);
	}
	return family;
}

/** `onRole` over the whole set, as a set. */
function roleOf(set: TokenSet, prop: string): ReadonlySet<string> {
	const cache = familiesOf(set);
	let family = cache.all.get(prop);
	if (!family) {
		family = new Set(onRole([...set.known], prop, set.scopes));
		cache.all.set(prop, family);
	}
	return family;
}

// Which tokens answer for a property depends only on the set's names and its
// scopes, yet `tokensFor` and `planValue` asked it again for every finding —
// with a profile loaded, the whole grammar over every token, each time. Cached
// per set and property. A set only grows (the walk adds project tokens as it
// finds them, names and values together), so its size is the version, and
// assigning new scopes starts over.
interface Families {
	size: number;
	scopes: TokenScopes | undefined;
	all: Map<string, ReadonlySet<string>>;
	literal: Map<string, [string, string][]>;
}
const families = new WeakMap<TokenSet, Families>();

function familiesOf(set: TokenSet): Families {
	let cache = families.get(set);
	if (!cache || cache.size !== set.known.size || cache.scopes !== set.scopes) {
		cache = { size: set.known.size, scopes: set.scopes, all: new Map(), literal: new Map() };
		families.set(set, cache);
	}
	return cache;
}

// ── what a literal could be replaced with ───────────────────────────────────

/**
 * What kind of literal a value is, and where it sits if it is on a scale: a
 * length in px (a rem is 16), a duration in ms. Not measured: a negative length
 * (a token substituted for one flips its sign) or a unit relative to something
 * the stylesheet cannot see (`em`, `%`, `vw`).
 */
function measure(value: string): { kind: 'px' | 'ms'; n: number } | { kind: 'color' } | null {
	const v = normalizeValue(value);
	const len = /^(\d*\.?\d+)(px|rem)$/.exec(v);
	if (len) return { kind: 'px', n: Number(len[1]) * (len[2] === 'rem' ? 16 : 1) };
	const time = /^(\d*\.?\d+)(ms|s)$/.exec(v);
	if (time) return { kind: 'ms', n: Number(time[1]) * (time[2] === 's' ? 1000 : 1) };
	return isColorLiteral(v) ? { kind: 'color' } : null;
}

/** What a value may be replaced with, and how it was narrowed. */
export interface Candidates {
	/**
	 * `exact`: several on-role tokens carry the value, and only role separates
	 * them. `near`: none does, and these are the steps of the scale either side
	 * of it. `end`: the value is past the first or last step, which is offered.
	 * `family`: every on-role token, because the choice is a design one.
	 */
	tier: 'exact' | 'near' | 'end' | 'family';
	options: [string, string][];
	/** Whether "leave it as written" is an answer, or only a token is. */
	keep: boolean;
}

/**
 * Spacing: padding, gap, and position, which is an offset from an edge.
 *
 * A spacing value the scale covers is snapped, never kept. Past the end of the
 * scale it may still be kept — 48px of page padding snapped to a 32px top step
 * is a different layout.
 */
const SPACING = /padding|gap$|^(inset|top|right|bottom|left)$/;

/**
 * The tokens a judgement chooses among for one literal part of a value.
 *
 * A length or a duration is narrowed here, in code, to the scale steps either
 * side of it: closeness on a scale is arithmetic, and no role is left to choose
 * once the property has picked its family. Whether it may also be kept is
 * decided here too — see {@link SPACING}.
 *
 * Anything else — a colour, a cursor, an easing — gets the whole family, since
 * which one the rule *means* is the question. What was measured about narrowing
 * and labelling colours is in docs/design/judge.md#which-token.
 *
 * Null when the part is not something this family can replace: a token set with
 * no family for the property, or a literal of another kind (`5%` of a padding
 * scale, a negative inset).
 */
export function candidatesFor(set: TokenSet, prop: string, part: string): Candidates | null {
	const family = familyFor(set, prop);
	if (!family.length) return null;
	const v = normalizeValue(part);
	const spacing = SPACING.test(prop);
	const exact = family.filter(([, fv]) => fv === v);
	if (exact.length) return { tier: 'exact', options: exact, keep: !spacing };
	const kinds = new Set(family.map(([, fv]) => measure(fv)?.kind));
	const m = measure(v);
	// A family of things the engine cannot measure — cursors, easings, shadows —
	// is a list of names, and the part has to be the whole value.
	if (!m) return kinds.has(undefined) && kinds.size === 1 ? { tier: 'family', options: family, keep: true } : null;
	if (!kinds.has(m.kind)) return null;
	if (m.kind === 'color') return { tier: 'family', options: family, keep: true };
	// A scale: the step either side. Past the end of it, the end.
	const steps = family.flatMap(([n, fv]): [string, string, number][] => {
		const fm = measure(fv);
		return fm && fm.kind === m.kind && 'n' in fm ? [[n, fv, fm.n - m.n]] : [];
	});
	// The same length in another unit — `1rem` against a `16px` step — is the
	// exact match the string comparison above cannot see, and it sits on neither
	// side of itself.
	const same = steps.filter(([, , d]) => Math.abs(d) < 1e-6).map(([n, fv]): [string, string] => [n, fv]);
	if (same.length) return { tier: 'exact', options: same, keep: !spacing };
	const below = Math.max(...steps.map(([, , d]) => d).filter((d) => d < 0));
	const above = Math.min(...steps.map(([, , d]) => d).filter((d) => d > 0));
	const options = steps.filter(([, , d]) => d === below || d === above).map(([n, fv]): [string, string] => [n, fv]);
	const inside = Number.isFinite(below) && Number.isFinite(above);
	return inside ? { tier: 'near', options, keep: !spacing } : { tier: 'end', options, keep: true };
}

/**
 * A value's parts, split on whitespace outside parentheses, so `padding: 6px
 * 12px` is two literals and `rgba(0, 0, 0, 0.5)` is one — nested ones too:
 * `rgb(calc(255 * 0.5) 0 0)` is one part, not three that rebuild into `…0 0)`.
 */
function partsOf(value: string): string[] {
	const out: string[] = [];
	let part = '';
	let depth = 0;
	for (const ch of value.trim()) {
		if (!depth && /\s/.test(ch)) {
			if (part) out.push(part);
			part = '';
			continue;
		}
		if (ch === '(') depth++;
		else if (ch === ')') depth = Math.max(0, depth - 1);
		part += ch;
	}
	if (part) out.push(part);
	return out;
}

/** A part a token could stand for. Zeros, keywords and `url()` pass through. */
const isLiteralPart = (p: string): boolean =>
	(/^-?\d*\.?\d+[a-z%]*$/i.test(p) && parseFloat(p) !== 0) || isColorLiteral(p);

/** What `check --judge` answers for a value that should stay as written. */
export const KEEP = 'keep';

/**
 * What a `keep` the model chose says. It is a judgement, not a reason: what the
 * value actually is (a scrim, a pill, a brand colour) is for a reader to write,
 * so `fix --judge` leaves these unsuppressed. A `keep` written without a model,
 * for a property the design system has no token for at all, states a fact and
 * is suppressed with it.
 */
export const DELIBERATE = 'deliberate, no token fits';

/** One literal in a flagged value: settled by a single exact token, or put to a judgement. */
export type Slot = { at: number; part: string } & ({ token: string } | { candidates: Candidates });

/**
 * How a flagged value could be rewritten, part by part.
 *
 * `'none'` when the set has no token for the property at all: there is nothing
 * to choose, so the value stays, whatever anyone thinks of it. Null when a part
 * is a literal no token here can stand for (`5%`, `-4px`, `hsl()`) — rewriting
 * the rest would leave the finding standing and call it fixed.
 *
 * `hold` says why a token a part settled on may not be applied unattended — off
 * its declared scope on what the declaration styles, or not shown to be in it —
 * and the first such reason comes back as `review`, naming the token. A part
 * settles exactly as a whole value does, so it is held exactly as one is.
 */
export function planValue(
	set: TokenSet,
	prop: string,
	value: string,
	hold?: (token: string) => string | null,
): 'none' | { parts: string[]; slots: Slot[]; review?: string } | null {
	const family = familyFor(set, prop);
	// A token defined as another token has no literal to offer, but it is still a
	// token for this property: "none" would be a false statement about the system.
	if (!family.length) return roleOf(set, prop).size ? null : 'none';
	// A family the engine can measure takes a value apart; one it cannot —
	// shadows, easings — is matched whole.
	const measurable = family.some(([, fv]) => measure(fv));
	const parts = measurable ? partsOf(value) : [value.trim()];
	const slots: Slot[] = [];
	let review: string | undefined;
	const settle = (at: number, part: string, token: string): void => {
		const why = review === undefined ? hold?.(token) : null;
		if (why) review = `${token} ${why}`;
		slots.push({ at, part, token });
	};
	for (const [at, part] of parts.entries()) {
		// `calc(10px + 2px)` holds literals no token replaces, and rewriting the
		// rest to `var()` would exempt the whole value from the rule.
		if (measurable && /^(calc|min|max|clamp)\(/i.test(part)) return null;
		if (measurable && !isLiteralPart(part)) continue;
		// A shorthand is flagged for its colour alone; its width is not this rule's.
		if (COLOR_SHORTHANDS.has(prop) && measure(part)?.kind !== 'color') continue;
		const [only, ...more] = tokensFor(set, prop, part);
		if (only !== undefined && !more.length) {
			settle(at, part, only);
			continue;
		}
		const candidates = candidatesFor(set, prop, part);
		if (!candidates) return null;
		// One token equal to it in another unit is as settled as one written the same.
		const [one, ...others] = candidates.tier === 'exact' ? candidates.options : [];
		if (one && !others.length) settle(at, part, one[0]);
		else slots.push({ at, part, candidates });
	}
	if (!slots.length) return null;
	return review === undefined ? { parts, slots } : { parts, slots, review };
}

/**
 * `→ --wpds-border-radius-md`, or `` when nothing on-role matches.
 *
 * The token's name, not the `var()` around it: on a run naming a hundred tokens
 * the wrapper is the only thing the eye scans past to reach the part that
 * differs, and the rule already says to use a token.
 */
export const remedyFor = (names: readonly string[]): string => {
	if (!names.length) return '';
	const shown = names.slice(0, 2).join(' or ');
	return ` → ${shown}${names.length > 2 ? ` (+${names.length - 2} more)` : ''}`;
};

/** What one flagged declaration says: the declaration, then what settles it. */
const stated = (s: Suggestion): string => {
	// The declaration is bounded and the remedy is not: a long value must not
	// spend the whole line, and a remedy the reader is meant to act on has to
	// arrive whole.
	const decl = snippet(`${s.prop}: ${s.value}`);
	if (s.judged) return `${decl} → ${s.judged.spans.join(' ')}`;
	// A token held back for review says why, so the reader checks the right thing.
	return `${decl}${remedyFor(s.tokens)}${s.review ? ` (review: ${s.review})` : ''}`;
};

/**
 * The one line a finding's flagged declarations compose, with the channel marker
 * last. Composed in one place, because both the token pass and `--judge` write
 * this message.
 *
 * It is a *list*: a collapsed finding carries one remedy per property, so
 * `messageParts` drops whole parts and counts them rather than cutting the last
 * one mid-token.
 *
 * A judgement is rendered from `judged.spans`, which is also what the report
 * paints green.
 */
export const declarationMessage = (parts: readonly Suggestion[], tail: string): string =>
	messageParts(parts.map(stated), tail);

/** Every `var(--prefix-…)` referenced in a value. */
export function tokenRefsIn(value: string, prefixes: readonly string[]): string[] {
	if (!prefixes.length) return [];
	const out: string[] = [];
	for (const m of String(value).matchAll(/var\(\s*(--[\w-]+)/g)) {
		const name = m[1];
		if (name !== undefined && prefixes.some((p) => name.startsWith(p))) out.push(name);
	}
	return out;
}
