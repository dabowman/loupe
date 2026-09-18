/**
 * CSS-side primitives: property groups, value classification, and the two AST
 * helpers that make nested CSS behave.
 *
 * Property groups are CSS-generic, not design-system-specific, so they live in
 * code rather than config. What varies between design systems is which
 * *components* own these properties — and that is what config carries.
 */

import type { Container, Declaration, Rule } from 'postcss';
import type { HardcodedOptions, MarginKind } from './types.ts';

/** Token-backed props whose literal values duplicate a design token. */
export const COLOR_PROPS = new Set([
	'color', 'background', 'background-color', 'border-color', 'border-top-color',
	'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color',
	'fill', 'stroke', 'box-shadow', 'text-decoration-color', 'caret-color', 'accent-color',
]);
export const SPACING_PROPS = new Set([
	'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
	'padding-block', 'padding-inline', 'padding-block-start', 'padding-block-end',
	'padding-inline-start', 'padding-inline-end', 'inset', 'top', 'right', 'bottom', 'left',
]);
export const RADIUS_PROPS = new Set([
	'border-radius', 'border-top-left-radius', 'border-top-right-radius',
	'border-bottom-left-radius', 'border-bottom-right-radius',
]);
export const TYPE_PROPS = new Set([
	'font', 'font-size', 'font-weight', 'font-family', 'line-height', 'letter-spacing',
]);
export const GAP_PROPS = new Set(['gap', 'row-gap', 'column-gap']);
/** Token-backed too: the design system ships a border-width scale. */
export const BORDER_WIDTH_PROPS = new Set([
	'border-width', 'border-top-width', 'border-right-width',
	'border-bottom-width', 'border-left-width', 'outline-width',
]);
export const FLEX_PROPS = new Set([
	'flex-direction', 'align-items', 'justify-content', 'align-content',
	'justify-items', 'flex-wrap', 'place-items', 'place-content',
]);
/** Token-backed: the design system ships duration and easing scales. */
export const MOTION_PROPS = new Set([
	'transition-duration', 'animation-duration',
	'transition-timing-function', 'animation-timing-function',
]);
/** Token-backed: the design system ships a cursor scale for interactive controls. */
export const CURSOR_PROPS = new Set(['cursor']);

/**
 * Appearance-only. Layout and box-model props are deliberately excluded: on a
 * layout primitive that exposes no padding or per-child sizing prop, a
 * styling-hook class carrying them is the *intended* usage, not an override, so
 * flagging them just manufactures suppressions.
 */
export const APPEARANCE_PROPS = new Set([
	...COLOR_PROPS, ...RADIUS_PROPS, ...TYPE_PROPS,
	'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
	'border-width', 'border-top-width', 'border-right-width', 'border-bottom-width',
	'border-left-width', 'border-style', 'background-image', 'text-transform',
	'text-decoration', 'opacity', 'text-shadow', 'filter', 'backdrop-filter',
]);

const KEYWORD = /^(inherit|initial|unset|revert|revert-layer|none|auto|transparent|currentcolor|normal)$/i;
const ZERO = /^0([a-z%]*)$/i;

export const usesToken = (value: string): boolean => /var\(\s*--/.test(value);
export const isLiteralColor = (v: string): boolean => /#[0-9a-f]{3,8}\b/i.test(v) || /\b(rgb|rgba|hsl|hsla|oklch|lab|color)\(/i.test(v);
export const isLiteralLength = (v: string): boolean =>
	/(^|\s|,)-?\d*\.?\d+(px|rem|em|%|vh|vw|vmin|vmax|pt|ch)\b/.test(v) || /(^|\s)-?\d+(\s|$)/.test(v);
export const isLiteralDuration = (v: string): boolean => /^-?\d*\.?\d+m?s$/i.test(v.trim());
export const isLiteralEasing = (v: string): boolean =>
	/^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/i.test(v.trim()) ||
	/^(cubic-bezier|steps)\(/i.test(v.trim());

export const isMarginProp = (prop: string): boolean => prop === 'margin' || prop.startsWith('margin-');

/** A declaration that makes or tunes a flex (or grid) container. */
export const isFlexDecl = (prop: string, value: string): boolean =>
	FLEX_PROPS.has(prop) || (prop === 'display' && /\b(inline-)?(flex|grid)\b/.test(value));

/**
 * Classify a margin declaration: `'spacing' | 'negative' | null`.
 *
 * The original rule fired on every margin, which sounds right — the design
 * system ships no margin token, so margin is never the sanctioned way to space
 * things — but the majority of real margins in a codebase have no `gap` remedy
 * at all:
 *
 *   margin: 0            a reset. There is nothing to move to a parent.
 *   margin: 0 auto       horizontal centering. `gap` cannot express it.
 *   margin-inline: auto  same, logical form.
 *
 * Reporting those trains everyone to reflex-suppress the one rule that matters
 * most, and a habitually suppressed rule is an off rule. Negative margins split
 * out on their own: a bleed is a real technique, so it warrants a "confirm this"
 * rather than the "move it to gap" remedy, which would be wrong advice.
 */
export function classifyMargin(value: string): MarginKind {
	const parts = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!parts.length) return null;
	// `var(--x)` on a margin is still margin, but we cannot see its sign. A
	// leading `--` is a custom property name, not a minus: `var( --gap )` splits
	// on the spaces prettier writes, and reading that as a bleed flags every
	// tokenized margin in the repo.
	if (parts.some((p) => /^-(?!-)/.test(p) && !ZERO.test(p))) return 'negative';
	if (parts.some((p) => p === 'auto')) return null;
	if (parts.every((p) => ZERO.test(p) || KEYWORD.test(p))) return null;
	return 'spacing';
}

/**
 * A value with nothing to tokenize: a keyword, or a zero.
 *
 * `font-family: inherit` and `line-height: 0` are not untokenized type styling —
 * there is no token that means "whatever the parent said", and a rule that
 * demands one for every reset is a rule people turn off.
 */
export const isInertValue = (value: string): boolean => {
	const parts = String(value).trim().split(/\s+/).filter(Boolean);
	return parts.length > 0 && parts.every((p) => ZERO.test(p) || KEYWORD.test(p));
};

/** A token-backed prop carrying a raw literal instead of a token reference. */
export function isHardcodedTokenValue(prop: string, value: string, { allowZero = true }: HardcodedOptions = {}): boolean {
	const v = value.trim();
	if (usesToken(value) || KEYWORD.test(v)) return false;
	if (allowZero && v.split(/\s+/).every((part) => ZERO.test(part))) return false;
	if (COLOR_PROPS.has(prop)) return isLiteralColor(value);
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
 * postcss's `walkDecls` is recursive, so a parent rule sees every descendant's
 * declarations: findings get duplicated across parent and child, a child's
 * `font-size` gets attributed to whatever component the *parent* class is bound
 * to, and a nested `display: grid` marks the whole parent as a grid.
 *
 * At-rules are transparent — a `@media` block's declarations still belong to
 * the enclosing selector — but nested rules are not.
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
		own.map((s) => (s.includes('&') ? s.replace(/&/g, base) : `${base} ${s}`))
	);
}

/**
 * Rightmost compound of a selector — the element the rule actually styles.
 * Component bindings must correlate against this, or a descendant rule
 * attributes its declarations to the ancestor's component.
 */
export const keySelector = (sel: string): string => sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? sel;

export const classesIn = (sel: string): string[] =>
	[...sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));

/** Does this rule establish a CSS Grid? Grid is a genuine keep: flex primitives can't replace it. */
export function ruleIsGrid(rule: Container): boolean {
	for (const d of ownDecls(rule)) {
		const p = d.prop.toLowerCase();
		if ((p === 'display' && /\bgrid\b/.test(d.value)) || p === 'grid' || p.startsWith('grid-template') || p.startsWith('grid-auto'))
			return true;
	}
	return false;
}
