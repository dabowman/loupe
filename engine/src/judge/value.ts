/**
 * `tokens/hardcoded-value`: which token, or is it deliberate?
 *
 * One hardcoded literal, read against the tokens it could have been. The
 * candidates arrive already narrowed where arithmetic can narrow them —
 * `candidatesFor` picks the scale steps either side of a length — so what is
 * asked is the half code cannot do: which token this rule *means*, judged by
 * what it styles, and whether the value was a decision at all. The pink card
 * background is the case the keep option is for: it is either a mistake with a
 * system default it should have used, or a choice to suppress and leave alone.
 * `evals/values` scores it.
 */

import type { Query } from '../judge.ts';
import { KEEP } from '../tokens.ts';
import type { Candidates } from '../tokens.ts';

export interface ValueItem {
	file: string;
	context_before: string;
	/** Opens on the declaration. */
	source: string;
	prop: string;
	value: string;
	/** The one hardcoded part of `value` being asked about. */
	part: string;
	candidates: Candidates;
}

// The keep option, worded as a decision with examples of one, so that it is
// chosen for a reason and not as the answer to "none of these is exact".
const KEEP_CRITERION =
	'None of these. The hardcoded value is a deliberate one-off the design system has no token for — a brand or illustration colour, an overlay or scrim, a size locked to something outside the system — and should stay as written.';

const TIER: Record<Candidates['tier'], string> = {
	exact: 'Several tokens carry exactly this value; they differ in the role they are for.',
	near: 'No token carries exactly this value; these are the steps of the scale either side of it.',
	end: 'No token carries this value, and it is past the end of the scale; this is the nearest step.',
	family: 'No token carries exactly this value; these are all the tokens for this property.',
};

/**
 * `about` is what each token is for, in the design system's words
 * (`tokenDescriptions`), sent as each option's meaning. Empty asks with names
 * and values alone.
 */
export const valueQuery = (about: ReadonlyMap<string, string>): Query<ValueItem> => ({
	// One per request, as forces are asked, until this has its own batch sweep.
	size: 1,
	element: ({ file, context_before, source }) => ({ file, context_before, source }),
	question: ({ prop, value, part, candidates }, i) => ({
		type: 'choice',
		instructions: `The first line of \`elements[${i}].source\` is the CSS declaration \`${prop}: ${value}\`, from a stylesheet in a product built on a design system, and \`${part}\` in it is hardcoded where the design system has tokens. ${TIER[candidates.tier]} Judging by what the rule styles and the role this value plays there, which token should it use${candidates.keep ? ' — or is the value a deliberate choice the system has no token for' : ''}?`,
		criteria: {
			...Object.fromEntries(candidates.options.map(([n, v]) => [n, about.has(n) ? `${v} — ${about.get(n) ?? ''}` : v])),
			...(candidates.keep ? { [KEEP]: KEEP_CRITERION } : {}),
		},
	}),
});
