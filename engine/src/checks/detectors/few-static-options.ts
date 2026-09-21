/**
 * `few-static-options`: a component in `components` whose `prop` is a static
 * array of `min`..`max` entries whose labels total at most `maxLabelChars` —
 * the select that should have been a segmented control. A hit reports the
 * registry entry that carries the detector, as `patterns/superseded-composite`.
 *
 * Logic, per JSX element:
 *   the component is not in the entry's `components`         → no hit
 *   its `prop` is missing, or is not a literal array the
 *   source states in full                                    → no hit
 *   the array holds fewer than `min` or more than `max`      → no hit
 *   some option's label is not a plain string in the source  → no hit, the width is unknown
 *   the labels together run past `maxLabelChars`             → no hit, it will not fit a row
 *   otherwise                                                → hit, naming the count
 */

import type { Detector } from '../../markup.ts';
import { listParam, numParam, stringParam } from '../../patterns.ts';

export const fewStaticOptions: Detector = (el, spec, ctx) => {
	if (!listParam(spec, 'components').includes(ctx.canonical)) return null;
	const prop = stringParam(spec, 'prop', 'options');
	const attr = el.openingElement.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === prop);
	const value =
		attr?.type === 'JSXAttribute' && attr.value?.type === 'JSXExpressionContainer' ? attr.value.expression : null;
	const options = value && value.type !== 'JSXEmptyExpression' ? ctx.optionsIn(value) : null;
	if (!options || options.length < numParam(spec, 'min', 2) || options.length > numParam(spec, 'max', 5)) return null;
	// Few is not enough: the segmented control needs the set to sit on one
	// row, and five "Uppercase Roman numerals" do not. Total label length
	// stands in for that force; a label the source does not state leaves
	// the width unknown, and an unknown width is not a finding.
	if (!options.every((l): l is string => l !== null)) return null;
	if (options.reduce((n, l) => n + l.length, 0) > numParam(spec, 'maxLabelChars', 32)) return null;
	return `${ctx.canonical} with ${options.length} short static ${prop}`;
};
