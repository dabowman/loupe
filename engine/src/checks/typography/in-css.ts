/**
 * `typography/in-css`: a type property set in CSS on a class bound to a text
 * component, whose size and style props are the remedy.
 *
 * It supersedes the ordinary verdict on the declaration — `font-size: 13px`
 * is otherwise `typography/untokenized` — so it steps aside when it is off.
 */

import type { DeclarationCheck } from '../../analyze.ts';
import { TYPE_PROPS } from '../../styles.ts';

export const typographyInCss: DeclarationCheck = ({ prop }, { boundText, enabled }) =>
	TYPE_PROPS.has(prop) && boundText[0] && enabled('typography/in-css')
		? { rule: 'typography/in-css', message: `${prop} on <${boundText[0].tag}>` }
		: undefined;
