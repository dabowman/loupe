/**
 * `tokens/hardcoded-value`: a literal where the design system has tokens for
 * the property. Last in the chain — any property an earlier check claimed has
 * had its verdict.
 *
 * The finding carries the declaration as its hint; the analyzer's token pass
 * names the token that carries the value, and `--judge` (`judge/value.ts`)
 * settles the ones no single token does.
 */

import type { DeclarationCheck } from '../../analyze.ts';
import { isHardcodedTokenValue } from '../../styles.ts';
import { oneLine } from '../../text.ts';

export const hardcodedValue: DeclarationCheck = ({ prop, value }, { options }) => {
	if (!isHardcodedTokenValue(prop, value, options)) return undefined;
	const decl = `${prop}: ${value}`;
	return { rule: 'tokens/hardcoded-value', message: decl, code: oneLine(decl), hint: { prop, value } };
};
