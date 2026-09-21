/**
 * `layout/margin-on-child` and `layout/negative-margin`.
 *
 * Spacing set on the child, where a layout primitive's `gap` on the parent is
 * the remedy — or, for a negative margin, a deliberate bleed to confirm. One
 * check for both: every margin is claimed here, and zero and `auto` pass, a
 * reset and a centering trick, neither of which has a gap remedy to point at.
 * `classifyMargin` has the cases.
 *
 * Logic, per declaration:
 *   not `margin` or `margin-*`                       → not ours, next check
 *   some part is negative (a `--var` name is not)    → layout/negative-margin
 *   some part is `auto`                              → clean, claimed
 *   every part is `0` or a CSS-wide keyword          → clean, claimed
 *   otherwise                                        → layout/margin-on-child
 */

import type { DeclarationCheck } from '../../analyze.ts';
import { classifyMargin, isMarginProp } from '../../styles.ts';

export const margin: DeclarationCheck = ({ prop, value }) => {
	if (!isMarginProp(prop)) return undefined;
	const kind = classifyMargin(value);
	const decl = `${prop}: ${value}`;
	if (kind === 'negative') return { rule: 'layout/negative-margin', message: decl, code: prop };
	return kind ? { rule: 'layout/margin-on-child', message: decl, code: prop } : null;
};
