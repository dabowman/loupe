/**
 * CSS-side primitives: property groups, value classification, and the two AST
 * helpers that make nested CSS behave.
 *
 * Property groups are CSS-generic, so they live in code. What varies between
 * design systems is which *components* own these properties, and that is config.
 *
 * Design notes: docs/design/analysis.md
 */

import type { ChildNode, Container, Declaration, Rule } from 'postcss';
import type { DeadRule, Decl, MarginKind } from './types.ts';

/**
 * Shorthands whose colour part has a token, whatever their other parts are.
 * Exported for the token pass, which offers a border colour for the colour and
 * leaves the width and style as written.
 */
export const COLOR_SHORTHANDS = new Set([
	'border',
	'border-top',
	'border-right',
	'border-bottom',
	'border-left',
	'border-block',
	'border-block-start',
	'border-block-end',
	'border-inline',
	'border-inline-start',
	'border-inline-end',
	'border-block-color',
	'border-inline-color',
	'border-block-start-color',
	'border-block-end-color',
	'border-inline-start-color',
	'border-inline-end-color',
	'outline',
	'column-rule',
	'column-rule-color',
	'text-decoration',
	'text-shadow',
	'background-image',
]);

/** Token-backed props whose literal values duplicate a design token. */
const COLOR_PROPS = new Set([
	'color',
	'background',
	'background-color',
	'border-color',
	'border-top-color',
	'border-right-color',
	'border-bottom-color',
	'border-left-color',
	'outline-color',
	'fill',
	'stroke',
	'box-shadow',
	'text-decoration-color',
	'caret-color',
	'accent-color',
]);
const SPACING_PROPS = new Set([
	'padding',
	'padding-top',
	'padding-right',
	'padding-bottom',
	'padding-left',
	'padding-block',
	'padding-inline',
	'padding-block-start',
	'padding-block-end',
	'padding-inline-start',
	'padding-inline-end',
	'inset',
	'top',
	'right',
	'bottom',
	'left',
]);
const RADIUS_PROPS = new Set([
	'border-radius',
	'border-top-left-radius',
	'border-top-right-radius',
	'border-bottom-left-radius',
	'border-bottom-right-radius',
]);
export const TYPE_PROPS = new Set(['font', 'font-size', 'font-weight', 'font-family', 'line-height', 'letter-spacing']);
export const GAP_PROPS = new Set(['gap', 'row-gap', 'column-gap']);
/** Token-backed too: the design system ships a border-width scale. */
const BORDER_WIDTH_PROPS = new Set([
	'border-width',
	'border-top-width',
	'border-right-width',
	'border-bottom-width',
	'border-left-width',
	'outline-width',
]);
const FLEX_PROPS = new Set([
	'flex-direction',
	'align-items',
	'justify-content',
	'align-content',
	'justify-items',
	'flex-wrap',
	'place-items',
	'place-content',
]);
/** Token-backed: the design system ships duration and easing scales. */
const MOTION_PROPS = new Set([
	'transition-duration',
	'animation-duration',
	'transition-timing-function',
	'animation-timing-function',
]);
/** Token-backed: the design system ships a cursor scale for interactive controls. */
const CURSOR_PROPS = new Set(['cursor']);

/**
 * Appearance-only. Layout and box-model props are excluded: on a layout
 * primitive exposing no padding or per-child sizing prop, a styling-hook class
 * carrying them is the intended usage, not an override.
 */
export const APPEARANCE_PROPS = new Set([
	...COLOR_PROPS,
	...RADIUS_PROPS,
	...TYPE_PROPS,
	'border',
	'border-top',
	'border-right',
	'border-bottom',
	'border-left',
	'border-width',
	'border-top-width',
	'border-right-width',
	'border-bottom-width',
	'border-left-width',
	'border-style',
	'background-image',
	'text-transform',
	'text-decoration',
	'opacity',
	'text-shadow',
	'filter',
	'backdrop-filter',
]);

const SIDES = ['top', 'right', 'bottom', 'left'];
const LOGICAL = ['block', 'inline', 'block-start', 'block-end', 'inline-start', 'inline-end'];
const BORDER_PARTS = ['width', 'style', 'color'];

/** The longhands one level below a shorthand. Only the appearance families. */
const LONGHANDS: ReadonlyMap<string, readonly string[]> = new Map<string, string[]>([
	['font', ['font-size', 'font-weight', 'font-family', 'line-height', 'font-style', 'font-variant', 'font-stretch']],
	['background', ['background-color', 'background-image']],
	['outline', ['outline-color', 'outline-width', 'outline-style']],
	['text-decoration', ['text-decoration-color', 'text-decoration-line', 'text-decoration-style']],
	['border', [...[...SIDES, ...LOGICAL].map((s) => `border-${s}`), ...BORDER_PARTS.map((p) => `border-${p}`)]],
	...[...SIDES, ...LOGICAL].map((s): [string, string[]] => [
		`border-${s}`,
		BORDER_PARTS.map((p) => `border-${s}-${p}`),
	]),
	...BORDER_PARTS.map((p): [string, string[]] => [`border-${p}`, SIDES.map((s) => `border-${s}-${p}`)]),
	[
		'border-radius',
		['border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius'],
	],
]);

/** A property and every longhand beneath it, however deep. */
function withLonghands(prop: string): Set<string> {
	const out = new Set([prop]);
	for (const p of out) for (const l of LONGHANDS.get(p) ?? []) out.add(l);
	return out;
}

/**
 * Do two properties set any of the same thing? A shorthand overlaps each of
 * its longhands in both directions — `border` resets `border-top-color`, and a
 * component owning `border-color` owns what `border` would overwrite — while
 * `border` and `border-radius` share a prefix and nothing else.
 */
export function propsOverlap(a: string, b: string): boolean {
	if (a === b) return true;
	const below = withLonghands(a);
	for (const p of withLonghands(b)) if (below.has(p)) return true;
	return false;
}

const KEYWORD = /^(inherit|initial|unset|revert|revert-layer|none|auto|transparent|currentcolor|normal)$/i;
const ZERO = /^0([a-z%]*)$/i;

export const usesToken = (value: string): boolean => /var\(\s*--/.test(value);
const isLiteralColor = (v: string): boolean =>
	/#[0-9a-f]{3,8}\b/i.test(v) || /\b(rgb|rgba|hsl|hsla|hwb|oklch|oklab|lab|lch|color)\(/i.test(v);

/**
 * The value with every `var()` and `url()` cut out, nested parentheses and all.
 *
 * A token beside a literal does not make the literal a token: `border:
 * var(--border-width-xs) solid #dcdcde` still carries a raw colour. A `var()`
 * fallback goes with it — the token is what renders — and a `url()` is cut so
 * `icon.svg#face` is not read as a hex.
 */
export function withoutRefs(value: string): string {
	let out = '';
	for (let i = 0; i < value.length; ) {
		const m = /^(var|url)\(/i.exec(value.slice(i));
		if (!m) {
			out += value[i++];
			continue;
		}
		let depth = 0;
		let j = i + m[0].length - 1;
		for (; j < value.length; j++) {
			if (value[j] === '(') depth++;
			else if (value[j] === ')' && --depth === 0) break;
		}
		out += ' ';
		i = j + 1;
	}
	return out;
}
const isLiteralLength = (v: string): boolean =>
	/(^|\s|,)-?\d*\.?\d+(px|rem|em|%|vh|vw|vmin|vmax|pt|ch)\b/.test(v) || /(^|\s)-?\d+(\s|$)/.test(v);
const isLiteralDuration = (v: string): boolean => /^-?\d*\.?\d+m?s$/i.test(v.trim());
const isLiteralEasing = (v: string): boolean =>
	/^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/i.test(v.trim()) ||
	/^(cubic-bezier|steps)\(/i.test(v.trim());

export const isMarginProp = (prop: string): boolean => prop === 'margin' || prop.startsWith('margin-');

/** A declaration that makes or tunes a flex (or grid) container. */
export const isFlexDecl = (prop: string, value: string): boolean =>
	FLEX_PROPS.has(prop) || (prop === 'display' && /\b(inline-)?(flex|grid)\b/.test(value));

/**
 * A declaration that establishes a CSS Grid. Grid is a genuine keep: flex primitives can't replace it.
 *
 * The bare `grid` shorthand counts in every channel, and that is a decision, not
 * a by-product of folding three checks into this one (#65): the inline-style and
 * markup channels once skipped it while stylesheets did not, so the same
 * declaration laid an element out in one and not the other. In effect a
 * `grid:`-only `<div>` can draw `system/raw-element`, and an inline style with
 * one is `isGrid`, which keeps `layout/in-css` off its `gap`.
 */
export const isGridDecl = (prop: string, value: string): boolean =>
	(prop === 'display' && /\bgrid\b/.test(value)) ||
	prop === 'grid' ||
	prop.startsWith('grid-template') ||
	prop.startsWith('grid-auto');

/**
 * Does this declaration lay anything out? `<div>` maps to a layout primitive,
 * so that suggestion only holds when the div is actually laying something out.
 */
export const isLayoutDecl = ({ prop, value }: Decl): boolean =>
	isFlexDecl(prop, value) || GAP_PROPS.has(prop) || isGridDecl(prop, value);

/**
 * Classify a margin declaration.
 *
 *   margin: 0             a reset, nothing to move to a parent  → null
 *   margin: 0 auto        centering, `gap` cannot express it    → null
 *   margin-inline: auto   same, logical form                    → null
 *   any negative part     a bleed, a technique to confirm       → 'negative'
 *   anything else                                               → 'spacing'
 */
export function classifyMargin(value: string): MarginKind {
	const parts = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!parts.length) return null;
	// `var(--x)` on a margin is still margin, but its sign is invisible. A leading
	// `--` is a custom property name, not a minus: `var( --gap )` splits on the
	// spaces prettier writes.
	if (parts.some((p) => /^-(?!-)/.test(p) && !ZERO.test(p))) return 'negative';
	if (parts.some((p) => p === 'auto')) return null;
	if (parts.every((p) => ZERO.test(p) || KEYWORD.test(p))) return null;
	return 'spacing';
}

/**
 * A value with nothing to tokenize: a keyword, or a zero. No token means
 * "whatever the parent said", so `font-family: inherit` and `line-height: 0`
 * are not untokenized type styling.
 */
export const isInertValue = (value: string): boolean => {
	const parts = String(value).trim().split(/\s+/).filter(Boolean);
	return parts.length > 0 && parts.every((p) => ZERO.test(p) || KEYWORD.test(p));
};

/** A token-backed prop carrying a raw literal instead of a token reference. */
export function isHardcodedTokenValue(prop: string, value: string): boolean {
	const v = value.trim();
	// Colour first, and past the token bail-out: a colour is one part of a
	// shorthand, and the token beside it says nothing about it.
	// Only the colour of a shorthand is judged here: `border: 1px solid #dcdcde`
	// is flagged for the hex, not the width.
	if (COLOR_PROPS.has(prop) || COLOR_SHORTHANDS.has(prop)) return isLiteralColor(withoutRefs(value));
	if (usesToken(value) || KEYWORD.test(v)) return false;
	if (v.split(/\s+/).every((part) => ZERO.test(part))) return false;
	if (SPACING_PROPS.has(prop) || RADIUS_PROPS.has(prop) || BORDER_WIDTH_PROPS.has(prop)) return isLiteralLength(value);
	if (MOTION_PROPS.has(prop)) return isLiteralDuration(value) || isLiteralEasing(value);
	// Cursor has no length/color shape to check — anything left after the var()
	// and CSS-wide-keyword bail-outs above is a literal keyword (`pointer`, `grab`, …).
	if (CURSOR_PROPS.has(prop)) return true;
	return false;
}

/**
 * Declarations belonging to THIS rule.
 *
 * postcss's `walkDecls` is recursive, so a parent rule would otherwise see every
 * descendant's declarations. At-rules are transparent — a `@media` block's
 * declarations still belong to the enclosing selector — but nested rules are not.
 */
export function* ownDecls(rule: Container): Generator<Declaration> {
	for (const node of rule.nodes ?? []) {
		if (node.type === 'decl') yield node;
		else if (node.type === 'atrule') yield* ownDecls(node);
	}
}

/** Resolve `&`/descendant nesting against ancestor rules. */
export function resolvedSelectors(rule: Rule): string[] {
	const own = rule.selectors;
	const p = rule.parent;
	if (!p || p.type === 'root') return own;
	const grandparent = p.parent;
	const ancestor: Rule | null =
		p.type === 'rule' ? (p as Rule) : grandparent?.type === 'rule' ? (grandparent as Rule) : null;
	if (!ancestor) return own;
	return resolvedSelectors(ancestor).flatMap((base) =>
		own.map((s) => (s.includes('&') ? s.replace(/&/g, base) : `${base} ${s}`)),
	);
}

/**
 * The `@media` conditions a rule sits under, combined the way CSS combines them:
 * a nested query applies only when every enclosing one does, which is what
 * ` and ` means. Empty when the rule is unconditional.
 *
 * The companion of `resolvedSelectors` for a reader in a browser — a selector
 * says which elements a rule reaches, this says when.
 *
 * Conditions are returned unparenthesized and joined as written, which is
 * correct for both shapes that occur. A comma binds looser than `and`, so a
 * comma inside any one condition returns nothing and the finding reads as
 * unconditional rather than subtly wrong.
 */
export function mediaQuery(rule: Rule): string {
	// Walked structurally rather than through postcss's node union: only `type`,
	// `name` and `params` are read, and naming the union here means every
	// container variant has to typecheck for a three-field lookup.
	type Ancestor = { type: string; name?: string; params?: string; parent?: Ancestor } | undefined;
	const conds: string[] = [];
	for (let n = rule.parent as Ancestor; n; n = n.parent) {
		if (n.type !== 'atrule' || n.name?.toLowerCase() !== 'media') continue;
		const params = n.params?.trim();
		if (params) conds.unshift(params);
	}
	if (!conds.length) return '';
	if (conds.length === 1) return conds[0] ?? '';
	return conds.some((c) => c.includes(',')) ? '' : conds.join(' and ');
}

/**
 * Rightmost compound of a selector — the element the rule actually styles.
 * Component bindings must correlate against this, or a descendant rule
 * attributes its declarations to the ancestor's component.
 *
 * Cut only at a combinator outside brackets, parentheses and quotes:
 * `.x[aria-label="Close dialog"]` is one compound, and so are `.x:has(> .y)`
 * and `.x:nth-child(2n+1)`.
 *
 * Design notes: docs/design/analysis.md#reading-a-stylesheet
 */
export function keySelector(sel: string): string {
	let depth = 0;
	let quote = '';
	let start = 0;
	const s = sel.trim();
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === '\\') i++;
		else if (quote) {
			if (ch === quote) quote = '';
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '(' || ch === '[') depth++;
		else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
		else if (!depth && (ch === ' ' || ch === '\n' || ch === '\t' || ch === '>' || ch === '+' || ch === '~'))
			start = i + 1;
	}
	return s.slice(start);
}

/**
 * A compound with its attribute selectors and pseudo-class arguments taken out:
 * what it says about the element itself. A class inside `:not()` is one the
 * element does not carry, and one inside `:is()` or `:has()` one it may not.
 */
export function ownLevel(compound: string): string {
	let depth = 0;
	let quote = '';
	let out = '';
	for (let i = 0; i < compound.length; i++) {
		const ch = compound[i] ?? '';
		if (quote) {
			if (ch === '\\') i++;
			else if (ch === quote) quote = '';
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '(' || ch === '[') depth++;
		else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
		else if (!depth) out += ch;
	}
	return out;
}

export const classesIn = (sel: string): string[] =>
	[...sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));

/**
 * The classes a selector styles: those its key compound puts on the element
 * itself. `.list > li:not(.btn)` styles none, `.x:nth-child(2n+1)` styles `x`.
 */
export const keyClassesIn = (sel: string): string[] => classesIn(ownLevel(keySelector(sel)));

/** Does this rule establish a CSS Grid? */
export const ruleIsGrid = (rule: Container): boolean =>
	[...ownDecls(rule)].some((d) => isGridDecl(d.prop.toLowerCase(), d.value));

/**
 * The lines a rule occupies, where the rule can be lifted out on its own —
 * `null` where it cannot, and no deletion is offered for it.
 *
 * Whole lines are the only extent this carries, so a rule sharing its first or
 * last line with anything else refuses. A comment glued directly above it, with
 * no blank line between, describes the rule and goes with it; one a blank line
 * away belongs to whatever is around it and stays.
 *
 * Only `loupe lsp` acts on this. Why: docs/design/report.md#deleting-is-the-editors-alone.
 */
export function deletableRule(rule: Rule, lines: readonly string[]): DeadRule | null {
	const end = rule.source?.end;
	if (!end) return null;
	// The only child of an `@media`, an `@supports` or a parent rule: deleting it
	// leaves an empty block behind, and taking the parent with it is a bigger
	// edit than the finding claims.
	const parent = rule.parent;
	if (parent && parent.type !== 'root' && parent.nodes.length === 1) return null;
	let head: ChildNode = rule;
	for (;;) {
		const prev: ChildNode | undefined = head.prev();
		// Exactly one newline between them: a blank line breaks the attachment,
		// and no newline means the comment is trailing whatever precedes it.
		if (prev?.type !== 'comment' || !prev.source?.start) break;
		if (!/^[^\S\n]*\n[^\S\n]*$/.test(head.raws.before ?? '')) break;
		head = prev;
	}
	const start = head.source?.start;
	if (!start) return null;
	const before = (lines[start.line - 1] ?? '').slice(0, start.column - 1);
	const after = (lines[end.line - 1] ?? '').slice(end.column);
	if (before.trim() || after.trim()) return null;
	return { startLine: start.line, endLine: end.line };
}
