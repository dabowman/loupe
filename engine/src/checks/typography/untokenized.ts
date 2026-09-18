/**
 * `typography/untokenized`: a type property given a raw value, where a text
 * component or a type token is the remedy. Every type property is this
 * check's, and a token or an inert value (`inherit`, `0`) passes it.
 */

import type { DeclarationCheck } from '../../analyze.ts';
import { TYPE_PROPS, isInertValue, usesToken } from '../../styles.ts';
import { oneLine } from '../../text.ts';

export const untokenizedType: DeclarationCheck = ({ prop, value }) => {
	if (!TYPE_PROPS.has(prop)) return undefined;
	if (usesToken(value) || isInertValue(value)) return null;
	const decl = `${prop}: ${value}`;
	return { rule: 'typography/untokenized', message: decl, code: oneLine(decl), hint: { prop, value } };
};
