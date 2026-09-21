/**
 * `typography/untokenized`: a type property given a raw value, where a text
 * component or a type token is the remedy. Every type property is this
 * check's, and a token or an inert value (`inherit`, `0`) passes it.
 *
 * Logic, per declaration:
 *   not a type property                        → not ours, next check
 *   the value names a token, `var(--…)`        → clean, claimed
 *   every part is `0` or a CSS-wide keyword    → clean, claimed
 *   otherwise                                  → typography/untokenized, carrying the
 *                                                declaration so the token pass can name
 *                                                the type token that fits
 */

import type { DeclarationCheck } from '../../analyze.ts';
import { TYPE_PROPS, isInertValue, usesToken } from '../../styles.ts';
import { oneLine } from '../../text.ts';

export const untokenizedType: DeclarationCheck = ({ prop, value }) => {
	if (!TYPE_PROPS.has(prop)) return undefined;
	if (usesToken(value) || isInertValue(value)) return null;
	const decl = `${prop}: ${value}`;
	return { rule: 'typography/untokenized', message: decl, code: oneLine(decl), hints: [{ prop, value }] };
};
