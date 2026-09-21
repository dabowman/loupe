/**
 * React style objects, translated into the CSS declarations the rules speak.
 *
 * `style={{ marginBottom: 16 }}` is the same violation as `margin-bottom: 16px`
 * in a stylesheet, and goes through the same classifier.
 *
 * Two React-specific conversions stand between the JSX and the rules: camelCase
 * property names, and bare numbers React silently suffixes with `px` — except on
 * the properties where a number is already the unit.
 *
 * Design notes: docs/design/analysis.md
 */

import type { Node, ObjectProperty } from '@babel/types';

/**
 * Properties where a bare number is a ratio or a count, not a length. React
 * leaves these unsuffixed, so `fontWeight: 600` must not read as `600px`.
 */
const UNITLESS = new Set([
	'animation-iteration-count',
	'aspect-ratio',
	'border-image-outset',
	'border-image-slice',
	'border-image-width',
	'box-flex',
	'box-flex-group',
	'box-ordinal-group',
	'column-count',
	'columns',
	'flex',
	'flex-grow',
	'flex-positive',
	'flex-shrink',
	'flex-negative',
	'flex-order',
	'font-weight',
	'grid-area',
	'grid-row',
	'grid-row-end',
	'grid-row-start',
	'grid-column',
	'grid-column-end',
	'grid-column-start',
	'line-clamp',
	'line-height',
	'opacity',
	'order',
	'orphans',
	'scale',
	'tab-size',
	'widows',
	'z-index',
	'zoom',
	'fill-opacity',
	'flood-opacity',
	'stop-opacity',
	'stroke-dasharray',
	'stroke-dashoffset',
	'stroke-miterlimit',
	'stroke-opacity',
	'stroke-width',
]);

/**
 * `marginBottom` -> `margin-bottom`, `WebkitBoxShadow` -> `-webkit-box-shadow`.
 * A key already containing a hyphen is passed through: React accepts
 * `'margin-bottom'` as a quoted key, and custom properties must survive intact.
 */
export function toCssProp(key: string): string {
	if (key.startsWith('--')) return key;
	if (key.includes('-')) return key.toLowerCase();
	const kebab = key.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`);
	// A leading capital is a vendor prefix (`WebkitFoo`), which needs the dash.
	return /^[A-Z]/.test(key) ? `-${kebab.replace(/^-/, '')}` : kebab;
}

/**
 * The CSS value a React style value produces.
 * Returns null when the value is dynamic — an identifier, a call, a spread —
 * because "width: [expression]" is noise, not a finding.
 */
export function toCssValue(prop: string, node: Node | null | undefined): string | null {
	if (!node) return null;
	switch (node.type) {
		case 'StringLiteral':
			return node.value;
		case 'NumericLiteral':
			return numeric(prop, node.value);
		case 'UnaryExpression':
			if (node.operator === '-' && node.argument?.type === 'NumericLiteral') return numeric(prop, -node.argument.value);
			return null;
		case 'TemplateLiteral':
			// Only a template with no interpolation is knowable.
			return node.expressions.length === 0 ? (node.quasis[0]?.value?.cooked ?? null) : null;
		default:
			return null;
	}
}

function numeric(prop: string, n: number): string {
	if (n === 0) return '0';
	return UNITLESS.has(prop) ? String(n) : `${n}px`;
}

/** The property name a style-object key carries, or null if it isn't static. */
export function keyName(node: ObjectProperty | null | undefined): string | null {
	if (!node) return null;
	if (node.key.type === 'Identifier' && !node.computed) return node.key.name;
	if (node.key.type === 'StringLiteral') return node.key.value;
	return null;
}
