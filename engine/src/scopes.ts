/**
 * Token scopes: what a design system's token names say each token is *for*.
 *
 * A token's type says what kind of value it is; it does not say where it
 * belongs. A stroke colour and a text colour are both colours, and applying one
 * where the other belongs gives the right pixels with the wrong meaning. A
 * well-built system writes the answer into the name — WPDS publishes
 * `--wpds-color-<property>-<target>-<tone>…` — so a profile declares that
 * grammar and what its segments mean, and stays right as the system adds
 * tokens. A scale whose role is not in the name (`--wpds-border-radius-md` says
 * nothing about menus) is enumerated instead.
 *
 * Read from a profile's `tokenScopes`. A profile declaring none leaves the
 * engine on its generic property→token table in `tokens.ts`, exactly as
 * before; so does any CSS property no declared segment sets.
 *
 * Fail safe in both directions: a token no grammar places has no declared scope
 * and is never reported as misapplied, and a constraint on the kind of element
 * a token sits on is only ever applied where the markup says what the element
 * is.
 *
 * Design notes: docs/design/analysis.md#token-scopes
 */

import { escapeRe } from './text.ts';

/** The CSS properties one property segment answers for. */
interface Segment {
	/** What the token is for: the properties it is suggested for, and may set. */
	sets: readonly string[];
	/** Where it may also appear without being what it is for — a stroke inside a focus-ring `box-shadow`. */
	also: readonly string[];
}

/** What a target segment says about the element a token sits on. */
interface Placing {
	/** One of these kinds, or the token is off-role there. */
	requires: readonly string[];
	/** None of these kinds. */
	not: readonly string[];
}

interface Grammar {
	pattern: string;
	re: RegExp;
	/** Segment value → its properties. A family with no `{property}` keys its one entry by the pattern. */
	property: ReadonlyMap<string, Segment>;
	target: ReadonlyMap<string, Placing>;
}

/** A profile's `tokenScopes`, validated and compiled. */
export interface TokenScopes {
	grammars: readonly Grammar[];
	/** Element kind → the element and component names that are one. Empty: a kind markup cannot show. */
	kinds: ReadonlyMap<string, ReadonlySet<string>>;
	/** Token → the element kinds it belongs on, for a scale whose role is not in its name. */
	scales: ReadonlyMap<string, readonly string[]>;
}

/** Where a token sits in its system's grammar. */
export interface Placement {
	/**
	 * The property segment, or the family's pattern where the family has one
	 * property. Null for a scale step no grammar places: where it sits is
	 * declared, what it sets is not.
	 */
	property: string | null;
	sets: readonly string[];
	also: readonly string[];
	/** The target segment, where the grammar has one and declares something about it. */
	target?: string | undefined;
	placing?: Placing | undefined;
	/** The kinds an enumerated scale step belongs on. */
	on?: readonly string[] | undefined;
}

// ── reading a profile's declaration ─────────────────────────────────────────

const PROP = /^-?[a-z][a-z-]*(\*[a-z-]*)?$/;
const ELEMENT = /^([a-z][a-z0-9-]*|[A-Z][A-Za-z0-9_]*(\.[A-Z][A-Za-z0-9_]*)*)$/;
const KIND = /^[a-z][a-z0-9-]*$/;
const PLACEHOLDER = /\{([^}]*)\}/g;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keys an author may annotate with: `$comment`, `$source`. Never read. */
const authored = (o: Record<string, unknown>): [string, unknown][] =>
	Object.entries(o).filter(([k]) => !k.startsWith('$'));

/**
 * Validate and compile a `tokenScopes` block.
 *
 * All or nothing: one malformed entry and the whole block is refused, with
 * every problem named. A half-read declaration would put some of a system's
 * tokens in scope and leave their siblings to the generic table, which is a
 * worse state than either.
 */
export function parseTokenScopes(raw: unknown): { scopes: TokenScopes | null; errors: string[] } {
	const errors: string[] = [];
	const err = (at: string, what: string): void => {
		errors.push(`tokenScopes${at}: ${what}`);
	};
	if (!isObject(raw)) {
		err('', 'expected an object of grammars, kinds and scales');
		return { scopes: null, errors };
	}
	for (const [k] of authored(raw))
		if (k !== 'grammars' && k !== 'kinds' && k !== 'scales')
			err(`.${k}`, 'unknown key — expected grammars, kinds, scales');

	// Kinds first: targets and scales name them.
	const kinds = new Map<string, Set<string>>();
	if (raw.kinds !== undefined) {
		if (!isObject(raw.kinds)) err('.kinds', 'expected an object of kind → element and component names');
		else
			for (const [kind, names] of authored(raw.kinds)) {
				if (!KIND.test(kind)) err(`.kinds.${kind}`, 'a kind is a lowercase name');
				if (!Array.isArray(names)) {
					err(`.kinds.${kind}`, 'expected a list of element and component names (empty for a kind markup cannot show)');
					continue;
				}
				const bad = names.filter((n) => typeof n !== 'string' || !ELEMENT.test(n));
				if (bad.length)
					err(
						`.kinds.${kind}`,
						`not an element or component name: ${bad.map((b) => JSON.stringify(b)).join(', ')} — a tag is lowercase (\`button\`), a component capitalised (\`Button\`)`,
					);
				kinds.set(kind, new Set(names.filter((n): n is string => typeof n === 'string')));
			}
	}
	const kindList = (at: string, v: unknown): string[] => {
		if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'string')) {
			err(at, 'expected a list of kind names');
			return [];
		}
		const unknown = v.filter((x) => !kinds.has(x));
		if (unknown.length) err(at, `undeclared kind ${unknown.join(', ')} — declare it under tokenScopes.kinds`);
		return v;
	};
	const propList = (at: string, v: unknown): string[] => {
		if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !PROP.test(x))) {
			err(at, 'expected a list of lowercase CSS properties, with at most one `*` each');
			return [];
		}
		return v;
	};
	const segment = (at: string, v: unknown): Segment => {
		if (Array.isArray(v)) return { sets: propList(at, v), also: [] };
		if (!isObject(v)) {
			err(at, 'expected a list of CSS properties, or { sets, also }');
			return { sets: [], also: [] };
		}
		for (const [k] of authored(v))
			if (k !== 'sets' && k !== 'also') err(`${at}.${k}`, 'unknown key — expected sets, also');
		return {
			sets: propList(`${at}.sets`, v.sets),
			also: v.also === undefined ? [] : propList(`${at}.also`, v.also),
		};
	};

	const grammars: Grammar[] = [];
	if (raw.grammars !== undefined && !Array.isArray(raw.grammars)) err('.grammars', 'expected a list');
	for (const [i, g] of (Array.isArray(raw.grammars) ? raw.grammars : []).entries()) {
		const at = `.grammars[${i}]`;
		if (!isObject(g)) {
			err(at, 'expected an object with a pattern');
			continue;
		}
		for (const [k] of authored(g))
			if (!['pattern', 'property', 'properties', 'target'].includes(k))
				err(`${at}.${k}`, 'unknown key — expected pattern, property, properties, target');
		const pattern = g.pattern;
		if (typeof pattern !== 'string' || !pattern.startsWith('--')) {
			err(`${at}.pattern`, 'expected a custom-property name pattern, like `--acme-color-{property}-{target}...`');
			continue;
		}
		const holes = [...pattern.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '');
		const bad = holes.filter((h) => !/^[a-z][a-z-]*$/.test(h));
		if (bad.length) err(`${at}.pattern`, `a placeholder is a lowercase name: ${bad.map((b) => `{${b}}`).join(', ')}`);
		for (const name of ['property', 'target'])
			if (holes.filter((h) => h === name).length > 1) err(`${at}.pattern`, `{${name}} appears more than once`);
		if (/[^a-z0-9-]/.test(pattern.replace(/\.\.\.$/, '').replace(PLACEHOLDER, '')))
			err(`${at}.pattern`, 'only lowercase letters, digits, `-`, placeholders and a trailing `...`');

		const hasProperty = holes.includes('property');
		const property = new Map<string, Segment>();
		if (hasProperty) {
			if (g.properties !== undefined) err(`${at}.properties`, 'a pattern with {property} maps it under `property`');
			if (!isObject(g.property) || !authored(g.property).length)
				err(`${at}.property`, 'expected an object of property segment → CSS properties');
			else
				for (const [seg, v] of authored(g.property)) {
					if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(seg))
						err(`${at}.property.${seg}`, 'a segment is lowercase words joined by `-`');
					property.set(seg, segment(`${at}.property.${seg}`, v));
				}
		} else {
			if (g.property !== undefined) err(`${at}.property`, 'the pattern has no {property} to map');
			if (g.properties === undefined)
				err(`${at}.properties`, 'a pattern without {property} names the CSS properties its family sets');
			else property.set(pattern, segment(`${at}.properties`, g.properties));
		}

		const target = new Map<string, Placing>();
		if (g.target !== undefined) {
			if (!holes.includes('target')) err(`${at}.target`, 'the pattern has no {target} to map');
			if (!isObject(g.target)) err(`${at}.target`, 'expected an object of target segment → { requires, not }');
			else
				for (const [seg, v] of authored(g.target)) {
					const t = `${at}.target.${seg}`;
					if (!isObject(v)) {
						err(t, 'expected { requires, not }');
						continue;
					}
					for (const [k] of authored(v))
						if (k !== 'requires' && k !== 'not') err(`${t}.${k}`, 'unknown key — expected requires, not');
					const requires = v.requires === undefined ? [] : kindList(`${t}.requires`, v.requires);
					const not = v.not === undefined ? [] : kindList(`${t}.not`, v.not);
					if (!requires.length && !not.length) err(t, 'declares neither requires nor not');
					target.set(seg, { requires, not });
				}
		}

		// `{property}` matches only the declared segments, longest first: WPDS's
		// `surface-width` and `font-size` are one segment of two words. Every other
		// placeholder is one word.
		const alternatives = [...property.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
		const open = pattern.endsWith('...');
		// Split keeps the placeholders: literal, hole, literal, hole, …
		const source = (open ? pattern.slice(0, -3) : pattern)
			.split(/(\{[^}]*\})/)
			.map((piece, k) => {
				if (k % 2 === 0) return escapeRe(piece);
				const name = piece.slice(1, -1);
				if (name === 'property') return `(?<property>${alternatives.join('|')})`;
				return name === 'target' ? '(?<target>[a-z0-9]+)' : '[a-z0-9]+';
			})
			.join('');
		grammars.push({ pattern, re: new RegExp(`^${source}${open ? '(?:-[a-z0-9]+)*' : ''}$`), property, target });
	}

	const scales = new Map<string, readonly string[]>();
	if (raw.scales !== undefined) {
		if (!isObject(raw.scales)) err('.scales', 'expected an object of token → { on: [kinds] }');
		else
			for (const [token, v] of authored(raw.scales)) {
				const at = `.scales.${token}`;
				if (!token.startsWith('--')) err(at, 'a scale step is a token name');
				if (!isObject(v)) {
					err(at, 'expected { on: [kinds] }');
					continue;
				}
				for (const [k] of authored(v)) if (k !== 'on') err(`${at}.${k}`, 'unknown key — expected on');
				scales.set(token, kindList(`${at}.on`, v.on));
			}
	}

	if (!grammars.length && !scales.size && !errors.length) err('', 'declares no grammars and no scales');
	return errors.length ? { scopes: null, errors } : { scopes: { grammars, kinds, scales }, errors };
}

/**
 * Every active profile's scopes as one. A grammar is tried in profile order and
 * the first that places a token wins; kinds of one name pool their members.
 */
export function mergeScopes(list: readonly (TokenScopes | null | undefined)[]): TokenScopes | undefined {
	const present = list.filter((s): s is TokenScopes => Boolean(s));
	if (!present.length) return undefined;
	if (present.length === 1) return present[0];
	const kinds = new Map<string, Set<string>>();
	for (const s of present) for (const [k, names] of s.kinds) kinds.set(k, new Set([...(kinds.get(k) ?? []), ...names]));
	return {
		grammars: present.flatMap((s) => s.grammars),
		kinds,
		scales: new Map(present.flatMap((s) => [...s.scales])),
	};
}

// ── reading a token against them ────────────────────────────────────────────

const globCache = new Map<string, RegExp>();
/** `padding-*` → every padding longhand; a plain name only itself. */
export function propMatches(list: readonly string[], prop: string): boolean {
	return list.some((p) => {
		if (!p.includes('*')) return p === prop;
		let re = globCache.get(p);
		if (!re) {
			re = new RegExp(`^${p.split('*').map(escapeRe).join('[a-z-]+')}$`);
			globCache.set(p, re);
		}
		return re.test(prop);
	});
}

/**
 * Placements, per declaration: the token pass asks about every known token for
 * every flagged declaration, and the answer for a name never changes.
 */
const placed = new WeakMap<TokenScopes, Map<string, Placement | null>>();

/** Where `token` sits in the declared grammar, or null where nothing declares it. */
export function place(scopes: TokenScopes, token: string): Placement | null {
	let memo = placed.get(scopes);
	if (!memo) {
		memo = new Map();
		placed.set(scopes, memo);
	}
	const hit = memo.get(token);
	if (hit !== undefined) return hit;
	const found = placeUncached(scopes, token);
	memo.set(token, found);
	return found;
}

function placeUncached(scopes: TokenScopes, token: string): Placement | null {
	const on = scopes.scales.get(token);
	for (const g of scopes.grammars) {
		const m = g.re.exec(token);
		if (!m) continue;
		const property = m.groups?.property ?? g.pattern;
		const segment = g.property.get(property);
		if (!segment) continue;
		const target = m.groups?.target;
		const placing = target === undefined ? undefined : g.target.get(target);
		return { property, sets: segment.sets, also: segment.also, target: placing ? target : undefined, placing, on };
	}
	// A scale step no grammar names is still a step: it belongs where it says,
	// and sets whatever the generic table thinks it sets.
	return on ? { property: null, sets: [], also: [], on } : null;
}

/** Whether any declared segment says what `prop`'s tokens are — and so whether the profile, not the generic table, decides. */
export const covers = (scopes: TokenScopes, prop: string): boolean =>
	scopes.grammars.some((g) => [...g.property.values()].some((s) => propMatches(s.sets, prop)));

/** The names among `names` the declared grammar puts on `prop`. Null where nothing declared covers it. */
export function scopedFamily(scopes: TokenScopes, names: readonly string[], prop: string): string[] | null {
	if (!covers(scopes, prop)) return null;
	return names.filter((n) => {
		const p = place(scopes, n);
		return p !== null && propMatches(p.sets, prop);
	});
}

/** The kinds an element or component is, by the names the profile lists. */
export const kindsOf = (scopes: TokenScopes, element: string): string[] =>
	[...scopes.kinds].filter(([, names]) => names.has(element)).map(([k]) => k);

/**
 * Whether a token fits the elements a declaration styles.
 *
 * `free`: nothing is declared about where it sits. `on`: every element is a
 * kind it belongs on. `off`: every element is one it does not — the only verdict
 * anything reports. `unknown`: it needs a kind the markup does not show, or the
 * elements disagree; nothing is reported, and nothing is applied unattended.
 *
 * `elements` are what the markup and the selector say the declaration lands
 * on, empty where nothing does.
 */
export type Fit = { fit: 'free' | 'on' } | { fit: 'off' | 'unknown'; why: string; elements: readonly string[] };

export function fitOf(scopes: TokenScopes, token: string, elements: readonly string[]): Fit {
	const p = place(scopes, token);
	const requires = [...(p?.placing?.requires ?? []), ...(p?.on ?? [])];
	const not = p?.placing?.not ?? [];
	if (!requires.length && !not.length) return { fit: 'free' };
	// What the token is for, in the words a reader acts on.
	const scope = [
		...(requires.length ? [`for ${requires.join(' or ')}`] : []),
		...(not.length ? [`not for ${not.join(' or ')}`] : []),
	].join(', ');
	const els = [...new Set(elements)];
	if (!els.length)
		return requires.length
			? { fit: 'unknown', why: `${scope}; what this styles is not known`, elements: [] }
			: { fit: 'on' };
	const kinds = els.map((e) => kindsOf(scopes, e));
	const shown = els.map((e) => `<${e}>`).join(', ');
	if (not.length && kinds.every((ks) => ks.some((k) => not.includes(k))))
		return { fit: 'off', why: `${scope}; this styles ${shown}`, elements: els };
	const mixed = not.length && kinds.some((ks) => ks.some((k) => not.includes(k)));
	if (requires.length) {
		if (kinds.every((ks) => ks.some((k) => requires.includes(k))))
			return mixed ? { fit: 'unknown', why: `${scope}; ${shown} do not agree`, elements: els } : { fit: 'on' };
		// A kind no markup can show — "nested inside a control" — can never be ruled out.
		const undeterminable = requires.some((k) => !scopes.kinds.get(k)?.size);
		if (!undeterminable && kinds.every((ks) => !ks.some((k) => requires.includes(k))))
			return { fit: 'off', why: `${scope}; this styles ${shown}`, elements: els };
		return { fit: 'unknown', why: `${scope}; ${shown} cannot be shown to be`, elements: els };
	}
	return mixed ? { fit: 'unknown', why: `${scope}; ${shown} do not agree`, elements: els } : { fit: 'on' };
}
