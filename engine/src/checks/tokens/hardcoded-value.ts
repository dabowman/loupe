/**
 * `tokens/hardcoded-value`: a literal where the design system has tokens for
 * the property. Last in the chain — any property an earlier check claimed has
 * had its verdict.
 *
 * The finding carries the declaration as its hint; the analyzer's token pass
 * names the token that carries the value, and `--judge` (`judge/value.ts`)
 * settles the ones no single token does.
 *
 * Logic, per declaration (`isHardcodedTokenValue`):
 *   the value names a token, is a CSS-wide keyword, or is all zeros → clean
 *   a colour property carrying a literal colour                     → tokens/hardcoded-value
 *   a spacing, radius or border-width property carrying a length    → tokens/hardcoded-value
 *   a motion property carrying a duration or an easing              → tokens/hardcoded-value
 *   `cursor`, whose every remaining value is a literal keyword      → tokens/hardcoded-value
 *   any other property — one the system has no tokens for           → clean
 */

import type { DeclarationCheck } from '../../analyze.ts';
import { isHardcodedTokenValue } from '../../styles.ts';
import { oneLine } from '../../text.ts';

export const hardcodedValue: DeclarationCheck = ({ prop, value }) => {
	if (!isHardcodedTokenValue(prop, value)) return undefined;
	const decl = `${prop}: ${value}`;
	return { rule: 'tokens/hardcoded-value', message: decl, code: oneLine(decl), hints: [{ prop, value }] };
};
