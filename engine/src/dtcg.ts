/**
 * A DTCG token set, read flat.
 *
 * `tokens.ts` reads the *other* kind of token set — the CSS custom properties a
 * design system ships compiled, which is what a stylesheet can reference. This
 * reads the authored source: the DTCG JSON the custom properties are generated
 * from, where a token still carries its `$type`, its `$description` and the
 * alias chain that says which tier it belongs to. `map` needs that, because what
 * it compares is roles, and a compiled `--wpds-color-fg-primary: #1e1e1e` has
 * lost every trace of the role but the name.
 *
 * Nothing here is specific to one system's naming. Two token sets that agree on
 * nothing but the spec still read into the same shape, which is the whole
 * premise of mapping one to the other.
 *
 * Design notes: docs/design/map.md#reading-a-token-set
 */

import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { filesUnder } from './discover.ts';
import { isRecord } from './json.ts';
import { isColorLiteral } from './styles.ts';
import { messageOf } from './text.ts';

/**
 * Where a token sits in the three-tier architecture.
 *
 * `base` is a raw value the system owns (a palette entry, a step of the spacing
 * scale); `semantic` gives one of those a role (`text.primary`, `surface.raised`);
 * `component` binds a role to one component (`button.primary.background`).
 * Counterparts live in the same tier far more often than not, which is why this
 * is inferred at all — see {@link tierOf}.
 */
export type Tier = 'base' | 'semantic' | 'component' | 'unknown';

/** A tier a set can actually declare. `unknown` is the absence of one, not a fourth. */
export type DeclaredTier = Exclude<Tier, 'unknown'>;

export const TIERS: readonly DeclaredTier[] = ['base', 'semantic', 'component'];

/** Every value a token's `tier` can take, in report order. */
export const ALL_TIERS: readonly Tier[] = [...TIERS, 'unknown'];

export const isTier = (s: string): s is Tier => (ALL_TIERS as readonly string[]).includes(s);

/** One token, flattened out of the tree it was authored in. */
export interface Token {
	/** Dot-joined path from the root of the set — a token's identity here. */
	path: string;
	segments: string[];
	/** The last segment: the token's own name, apart from the groups above it. */
	leaf: string;
	/** `$type`, own or inherited from the nearest group that declares one, or inferred from the value. */
	type: string;
	/** Whether `type` was declared or guessed from the value's shape. */
	typed: boolean;
	/** `$value` exactly as authored — an alias string, a literal, or a composite object. */
	value: unknown;
	/** `$value` with aliases followed, so two sets can be compared on what they resolve to. */
	resolved: unknown;
	/** {@link resolved} rendered for comparison and for display: `#1e1e1e`, `16px`, `200ms`. */
	literal: string;
	description?: string | undefined;
	/** The path this token aliases directly, if its whole value is one reference. */
	alias?: string | undefined;
	/** How many aliases were followed to reach a literal. 0 is a token that holds one. */
	depth: number;
	tier: Tier;
	/** Where the tier came from, or `unstated` when the set never said. */
	tierFrom: 'named' | 'foldered' | 'unstated';
	/** The other tokens in the same group, by leaf name. Bounded; it is context, not data. */
	siblings: string[];
	/** Which file in the set this token came from. */
	file: string;
}

/** A whole set: its tokens, and what was read to get them. */
export interface TokenDoc {
	tokens: Token[];
	/** The path the set was read from, as it was given. */
	path: string;
	files: string[];
	/** A short name for the set, for report prose and for the question put to the model. */
	label: string;
}

// ── reading ─────────────────────────────────────────────────────────────────

/** A DTCG group or token: a plain JSON object (`isRecord`). Everything else is a leaf value. */
type Node = Record<string, unknown>;

/**
 * Every `.json` under a path, which may be a file or a directory.
 *
 * A set is as often a directory of files — one per family — as a single
 * document, and which of the two it is says nothing about the tokens. Bounded
 * for the same reason `cssFilesUnder` is: a path typed by hand can be anything.
 */
export function tokenFilesUnder(path: string, budget = 200): string[] {
	let isDir: boolean;
	try {
		isDir = statSync(path).isDirectory();
	} catch {
		throw new Error(`no token set at ${path}`);
	}
	if (!isDir) return [path];
	const out: string[] = [];
	for (const file of filesUnder(path, (name) => name.endsWith('.json') && !name.startsWith('.'))) {
		// Refused rather than cut short: the files left unread would report
		// their tokens as missing from the system.
		if (out.length >= budget)
			throw new Error(`more than ${budget} .json files under ${path}; point at the token sources`);
		out.push(file);
	}
	if (!out.length) throw new Error(`no .json token files under ${path}`);
	return out;
}

/**
 * Whether a node is a token rather than a group.
 *
 * `$value` is the spec's own test and the only one that holds across drafts: a
 * group may carry `$type` and `$description` too, and a token's value may be an
 * object (a shadow, a typography composite), so neither the presence of other
 * `$` keys nor the shape of the value tells them apart.
 */
const isToken = (n: Node): boolean => '$value' in n;

/**
 * Group names, so a path reads the way the set's own docs write it.
 *
 * A directory of files is one namespace, not one per file: `color.json` and
 * `spacing.json` in the same set define `color.*` and `spacing.*`, and prefixing
 * each with its filename would invent a level neither set has. A file whose
 * top-level keys would collide with another's is the exception, and the loser
 * keeps the first definition — the same rule `harvestTokenDefs` uses.
 */
function walkFile(
	raw: unknown,
	file: string,
	into: Map<string, Omit<Token, 'tier' | 'tierFrom' | 'siblings'>>,
	groupOf: Map<string, string>,
): void {
	if (!isRecord(raw)) return;
	const walk = (node: Node, trail: string[], inheritedType: string | undefined): void => {
		const declared = typeof node.$type === 'string' ? node.$type : inheritedType;
		for (const [key, child] of Object.entries(node)) {
			// `$`-prefixed keys are the spec's own metadata, except `$root`: the
			// group's own token, referenced as `{group.$root}`.
			if ((key.startsWith('$') && key !== '$root') || !isRecord(child)) continue;
			const trailNext = [...trail, key];
			if (!isToken(child)) {
				walk(child, trailNext, declared);
				continue;
			}
			const path = trailNext.join('.');
			if (into.has(path)) continue;
			const own = typeof child.$type === 'string' ? child.$type : undefined;
			const value = child.$value;
			// The spec types a reference by its target ahead of its group, so a
			// reference's group type waits in `groupOf` as `resolve`'s fallback.
			const isRef = aliasTarget(value) !== undefined;
			if (own === undefined && isRef && declared !== undefined) groupOf.set(path, declared);
			into.set(path, {
				path,
				segments: trailNext,
				leaf: key,
				// Completed by `resolve`, which is the only place that can see the
				// whole set and therefore the only place an alias's type is knowable.
				type: own ?? (isRef ? '' : (declared ?? '')),
				typed: (own ?? declared) !== undefined,
				value,
				resolved: value,
				literal: '',
				...(typeof child.$description === 'string' ? { description: child.$description } : {}),
				depth: 0,
				file,
			});
		}
	};
	walk(raw, [], undefined);
}

// ── aliases ─────────────────────────────────────────────────────────────────

/** `{color.base.blue.500}` — a whole value that is one reference, per the spec. */
const ALIAS = /^\{([^{}]+)\}$/;

const aliasTarget = (value: unknown): string | undefined =>
	typeof value === 'string' ? (ALIAS.exec(value.trim())?.[1] ?? undefined) : undefined;

/**
 * Follow every alias to the literal behind it, and record how far it was.
 *
 * The depth is the point: a set that names no tiers still declares them in its
 * own structure, since a literal, a reference to a literal and a reference to a
 * reference are exactly the three tiers. A chain that does not terminate — a
 * cycle, or a reference to a token this set does not define — stops where it is,
 * and the token keeps the alias as its value; it is still comparable by name.
 */
function resolve(
	tokens: Map<string, Omit<Token, 'tier' | 'tierFrom' | 'siblings'>>,
	groupOf: ReadonlyMap<string, string>,
): void {
	// Types as authored, read before this pass fills any in, so no token's answer
	// depends on which tokens were resolved before it.
	const declaredOf = new Map([...tokens].map(([path, t]) => [path, t.type]));
	for (const t of tokens.values()) {
		const direct = aliasTarget(t.value);
		if (direct !== undefined) t.alias = direct;
		let at = t;
		let type = t.type;
		const seen = new Set<string>([t.path]);
		let depth = 0;
		for (;;) {
			const next = aliasTarget(at.value);
			if (next === undefined) break;
			const to = tokens.get(next);
			if (!to || seen.has(next)) break;
			seen.add(next);
			at = to;
			depth++;
			type ||= declaredOf.get(next) ?? '';
		}
		t.resolved = at.value;
		// A reference that leads out of the set still makes this an alias, not a primitive.
		t.depth = depth || (direct !== undefined ? 1 : 0);
		// Its own type, else the first declared along its alias chain (a reference
		// to a colour is a colour), else its group's, else its value's shape.
		t.type = type || groupOf.get(t.path) || inferType(t.resolved);
		t.literal = literalOf(t.resolved);
	}
}

// ── values ──────────────────────────────────────────────────────────────────

/**
 * A DTCG value rendered as the string two sets are compared on.
 *
 * The spec has moved on the shape of the simple types — a dimension was `"16px"`
 * and is now `{ value: 16, unit: "px" }`, a colour was a hex string and is now
 * `{ colorSpace, components, alpha }` — and a real pair of sets is as likely to
 * straddle that change as to sit on one side of it. Both forms render to the
 * same string here, so the draft a set was authored against never reaches the
 * comparison. A composite (a shadow, a typography block) has no one-line form,
 * so it renders as its own JSON, which is still stable enough to compare and
 * short enough to show.
 */
export function literalOf(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) return JSON.stringify(value);
	if (!isRecord(value)) return String(value);
	// `{ value, unit }` — dimension and duration.
	if (typeof value.value === 'number' && typeof value.unit === 'string') return `${value.value}${value.unit}`;
	// `{ colorSpace, components, alpha }` — the 2025 colour object.
	if (Array.isArray(value.components) && typeof value.colorSpace === 'string') {
		const alpha = typeof value.alpha === 'number' ? value.alpha : 1;
		// A set that carries its own hex is taken at its word for the RGB: it is the
		// value the system publishes. The spec keeps alpha out of the hex, so it is
		// appended here.
		const hex = typeof value.hex === 'string' ? value.hex.trim() : '';
		if (/^#[0-9a-f]{6}$/i.test(hex)) return `${hex}${alpha < 1 ? byte(alpha) : ''}`;
		// `none` is a component the spec allows and CSS converts as 0.
		const numbers = value.components.every((c) => typeof c === 'number' || c === 'none')
			? value.components.map((c) => (typeof c === 'number' ? c : 0))
			: null;
		const srgb = numbers && toSrgb(value.colorSpace, numbers);
		if (srgb) return hexOf(srgb, alpha);
		const parts = value.components.map((c) => (typeof c === 'number' ? round(c) : String(c)));
		return `color(${value.colorSpace} ${parts.join(' ')}${alpha !== 1 ? ` / ${round(alpha)}` : ''})`;
	}
	return JSON.stringify(value);
}

const round = (n: number): string => String(Math.round(n * 1000) / 1000);

/**
 * A colour's components in whatever space it was authored in, as sRGB 0..1.
 *
 * Every space that can reach sRGB without a colour-science library does, and the
 * rest render as `color(space …)` and compare on equality alone. This is not
 * about display: it is what makes two sets comparable at all. Primer authors its
 * palette in `hsl` and WPDS authors its own in `srgb`, and left in their own
 * spaces the two never register as the same colour — every pair scores zero and
 * the shortlist falls back to whatever sorts first.
 *
 * Null for a space this cannot convert, which is the honest answer: an `oklch`
 * value converted by guesswork would rank *worse* than one left alone, because
 * it would look like a measurement.
 */
export function toSrgb(space: string, components: readonly number[]): [number, number, number] | null {
	const [a = 0, b = 0, c = 0] = components;
	switch (space) {
		case 'srgb':
			return [a, b, c];
		// Gamma-encode: the linear space holds the same colours on another curve.
		case 'srgb-linear': {
			const enc = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
			return [enc(a), enc(b), enc(c)];
		}
		// `[hue in degrees, saturation %, lightness %]`, per the spec.
		case 'hsl':
			return hslToSrgb(a, b / 100, c / 100);
		// `[hue, whiteness %, blackness %]`: the fully saturated hue, then mixed
		// toward white and black.
		case 'hwb': {
			const [w, bl] = [b / 100, c / 100];
			if (w + bl >= 1) {
				const grey = w / (w + bl);
				return [grey, grey, grey];
			}
			const pure = hslToSrgb(a, 1, 0.5);
			return [pure[0], pure[1], pure[2]].map((v) => v * (1 - w - bl) + w) as [number, number, number];
		}
		default:
			return null;
	}
}

/** Hue in degrees, saturation and lightness in 0..1, as sRGB 0..1. */
export function hslToSrgb(hue: number, s: number, l: number): [number, number, number] {
	const h = ((hue % 360) + 360) % 360;
	const chroma = (1 - Math.abs(2 * l - 1)) * s;
	const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - chroma / 2;
	const [r, g, b]: [number, number, number] =
		h < 60
			? [chroma, x, 0]
			: h < 120
				? [x, chroma, 0]
				: h < 180
					? [0, chroma, x]
					: h < 240
						? [0, x, chroma]
						: h < 300
							? [x, 0, chroma]
							: [chroma, 0, x];
	return [r + m, g + m, b + m];
}

/** A 0..1 channel as two hex digits. */
const byte = (n: number): string =>
	Math.max(0, Math.min(255, Math.round(n * 255)))
		.toString(16)
		.padStart(2, '0');

/** sRGB components in 0..1 as `#rrggbb`, which is how every set that predates the object writes them. */
function hexOf(components: readonly number[], alpha: number): string {
	const [r = 0, g = 0, b = 0] = components;
	return `#${byte(r)}${byte(g)}${byte(b)}${alpha < 1 ? byte(alpha) : ''}`;
}

/**
 * The `$type` a value implies, for a set that leaves it off.
 *
 * `$type` is required by the current spec and optional in everything authored
 * before it, and a set with no types at all would put every token in one
 * undifferentiated pool — a colour compared against a duration. Guessing from
 * the value recovers the distinction the file did not write down; where the
 * shape says nothing, the type is empty and only tokens equally untyped are
 * comparable to it.
 */
export function inferType(value: unknown): string {
	if (isRecord(value)) {
		if (Array.isArray(value.components)) return 'color';
		if (typeof value.value === 'number' && typeof value.unit === 'string')
			return value.unit === 'ms' || value.unit === 's' ? 'duration' : 'dimension';
		if ('fontFamily' in value || 'fontSize' in value) return 'typography';
		if ('color' in value && 'offsetX' in value) return 'shadow';
		return '';
	}
	if (Array.isArray(value)) return value.length === 4 && value.every((n) => typeof n === 'number') ? 'cubicBezier' : '';
	if (typeof value === 'number') return 'number';
	if (typeof value !== 'string') return '';
	const v = value.trim().toLowerCase();
	if (isColorLiteral(v)) return 'color';
	if (/^-?[\d.]+(px|rem|em|%|vh|vw|pt)$/.test(v)) return 'dimension';
	if (/^[\d.]+m?s$/.test(v)) return 'duration';
	if (/^cubic-bezier\(/.test(v)) return 'cubicBezier';
	if (/^(normal|bold|light|medium|semi-?bold|extra-?bold|black|thin)$/.test(v)) return 'fontWeight';
	return '';
}

// ── tiers ───────────────────────────────────────────────────────────────────

/**
 * The words a set uses to name each tier, in every spelling seen in the wild.
 *
 * Read off the path rather than configured, because a set's tier names are the
 * one part of its structure it always writes down somewhere — and the point of
 * this utility is that nothing else about the two sets has to agree.
 */
const TIER_WORDS: Record<DeclaredTier, RegExp> = {
	base: /^(primitives?|base|core|globals?|foundations?|refs?|reference|palettes?|raw|scales?)$/,
	semantic: /^(semantics?|alias(es)?|system|sys|themes?|roles?|intent|decisions?|common|shared|functional|applied)$/,
	component: /^(components?|comps?|cmp|parts?|recipes?|patterns?)$/,
};

/**
 * Whether a word names a tier rather than describing a token.
 *
 * `mapping.ts` drops these before comparing two names: one set writing
 * `primitive.color.blue` and another writing `color.blue` have said the same
 * thing, and counting `primitive` as a word they disagree on would penalise the
 * pair for how the two files are organised.
 */
export const isTierWord = (word: string): boolean => TIERS.some((t) => TIER_WORDS[t].test(word.toLowerCase()));

/**
 * Which tier a token belongs to, and how that was decided.
 *
 * A named tier wins: a set that groups under `primitive/` has said outright what
 * those tokens are, and no structural signal should overrule it. The name has to
 * appear *above* the leaf to count — `color.background.base` is a semantic token
 * whose own name happens to be `base`, and reading that as a tier would file
 * every "base" and "core" variant of every scale as a primitive. Above the leaf
 * the outermost wins: in `component.button.base.padding`, `base` is a variant.
 *
 * Otherwise the tier is `unknown`. Alias depth used to answer here, and read a
 * component token that reaches past the common tier for a primitive as a tier
 * too shallow; an unstated tier is not a fact about a token, so it is never
 * guessed, never sent, and never counts as two sets agreeing.
 */
export function tierOf(
	segments: readonly string[],
	dirs: readonly string[] = [],
): { tier: Tier; tierFrom: 'named' | 'foldered' | 'unstated' } {
	// The folders the file sits in come first. A set organised as base/ common/
	// component/ has made a deliberate statement about every file in it, whereas
	// a word inside a token's path may be describing the token rather than
	// placing it: Primer's `display.blue.scale.0` lives in `functional/` and is a
	// scale *of* colours, not a declaration that it is a primitive. Reading the
	// path first filed 190 of Primer's functional tokens as base on that one word.
	for (const d of dirs) {
		const tier = TIERS.find((t) => TIER_WORDS[t].test(d.toLowerCase()));
		if (tier) return { tier, tierFrom: 'foldered' };
	}
	// Then what the token calls itself, which is all a single-file set has.
	for (const s of segments.slice(0, -1)) {
		const tier = TIERS.find((t) => TIER_WORDS[t].test(s.toLowerCase()));
		if (tier) return { tier, tierFrom: 'named' };
	}
	// And otherwise it is not known, which is the honest answer.
	//
	// This used to fall back to the alias depth, on the reasoning that a literal,
	// a reference to a literal and a reference to a reference are the three tiers
	// restated. That measures plumbing rather than meaning, and it is wrong in
	// both directions. A component token that reaches a base scale directly —
	// `button.padding: {space.s}` — read a tier too shallow, which was 177 of
	// Archer's 644 component tokens. And the inference has the case backwards:
	// a component token that merely re-aliases a common one is barely a token at
	// all, while the ones that *earn* their place are exactly those reaching for a
	// different primitive than the common tier offers — the deepest chains by that
	// reasoning, and the shallowest in fact.
	//
	// The tier is a fact about what a token means: whether it applies to one
	// component or holds everywhere. Nothing in the file structure can settle that
	// when the set has not said it, so the model is told it is unknown and reads
	// the name and the description instead.
	return { tier: 'unknown', tierFrom: 'unstated' };
}

// ── the set ─────────────────────────────────────────────────────────────────

/**
 * The directories a file sits in, relative to the set's own root.
 *
 * Only what is *inside* the set counts. A checkout that happens to live under
 * `~/work/base/` would otherwise file every token in every set as a primitive.
 */
function dirsOf(root: string, file: string): string[] {
	// Resolved on both sides: the files are read through `join`, which drops the
	// `./` a typed root keeps, and a root that never prefixed its own files filed
	// every directory in the path as one the set placed its tokens in.
	const within = relative(resolvePath(root), resolvePath(file));
	const rel = within.startsWith('..') || isAbsolute(within) ? file : within;
	return rel.split(/[/\\]/).slice(0, -1).filter(Boolean);
}

/** How many sibling names a token carries as context. Enough to show a scale, not a whole palette. */
const SIBLINGS = 12;

/**
 * Read a DTCG token set from a file or a directory of them.
 *
 * Throws when the path holds no tokens at all: a set that read as empty would
 * map to nothing and report it as "no counterpart", which is a confident false
 * statement about the design system rather than a failure to read it — the same
 * reason `judgeValues` refuses an empty token set.
 */
export function readTokenDoc(path: string, label = basename(path).replace(/\.json$/, '')): TokenDoc {
	const files = tokenFilesUnder(path);
	const flat = new Map<string, Omit<Token, 'tier' | 'tierFrom' | 'siblings'>>();
	const groupOf = new Map<string, string>();
	for (const file of files) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
		} catch (err) {
			throw new Error(`${file} is not readable JSON: ${messageOf(err)}`);
		}
		walkFile(raw, file, flat, groupOf);
	}
	if (!flat.size) throw new Error(`${path} holds no DTCG tokens ($value was not found anywhere)`);
	resolve(flat, groupOf);

	// Siblings are the group's other leaves, which is what says a token is one
	// step of a scale rather than a value on its own.
	const byGroup = new Map<string, string[]>();
	for (const t of flat.values()) {
		const group = t.segments.slice(0, -1).join('.');
		byGroup.set(group, [...(byGroup.get(group) ?? []), t.leaf]);
	}

	const tokens = [...flat.values()].map((t): Token => {
		const group = t.segments.slice(0, -1).join('.');
		return {
			...t,
			...tierOf(t.segments, dirsOf(path, t.file)),
			siblings: (byGroup.get(group) ?? []).filter((n) => n !== t.leaf).slice(0, SIBLINGS),
		};
	});
	return { tokens, path, files, label };
}
