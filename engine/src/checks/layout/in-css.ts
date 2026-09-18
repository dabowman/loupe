/**
 * `layout/in-css`: flex layout written in CSS, where a layout primitive and
 * its `gap` prop are the remedy.
 *
 * Skipped on a component-bound class (component-internal flex, or a class
 * already on a layout primitive) and on a grid, neither of which converts to a
 * flex primitive. The analyzer collapses this rule's findings to one per CSS
 * rule, since `display: flex` and its three companions are one decision.
 */

import type { DeclarationCheck } from '../../analyze.ts';
import { GAP_PROPS, isFlexDecl } from '../../styles.ts';
import { oneLine } from '../../text.ts';

export const layoutInCss: DeclarationCheck = ({ prop, value }, { boundSystem, isGrid }) => {
	const decl = `${prop}: ${value}`;
	if (GAP_PROPS.has(prop))
		return !boundSystem.length && !isGrid ? { rule: 'layout/in-css', message: decl, code: prop } : null;
	if (!isFlexDecl(prop, value)) return undefined;
	const gridDisplay = prop === 'display' && /\bgrid\b/.test(value);
	return !boundSystem.length && !isGrid && !gridDisplay
		? { rule: 'layout/in-css', message: decl, code: oneLine(decl) }
		: null;
};
