/**
 * `tokens/hardcoded-value`: which token, or is it deliberate?
 *
 * One hardcoded literal, read against the tokens it could have been. The
 * candidates arrive already narrowed where arithmetic can narrow them —
 * `candidatesFor` picks the scale steps either side of a length — so what is
 * asked is the half code cannot do: which token this rule *means*, judged by
 * what it styles, and whether the value was a decision at all. `evals/values`
 * scores it; docs/design/judge.md has the numbers.
 *
 * What one literal sends, whole — the request body `ask` posts. A value is asked
 * about part by part, so this is `1px` of a `padding: 1px 7px`, and `7px` is a
 * second request just like it:
 *
 *   {
 *     "model": "jev-1.13.0",
 *     "state": {
 *       "elements": [
 *         {
 *           "file": "assets/css/admin-panels.css",
 *           "context_before": "\talign-items: center;\n\tflex-wrap: wrap;\n\tmargin: 0;\n\tpadding: 6px 0;\n\tborder-bottom: 1px solid #f0f0f1;\n}\n.vip-dam-share-status {\n\tflex: 0 0 auto;",
 *           "source": "\tpadding: 1px 7px;\n\tborder-radius: 9px;\n\tfont-size: 11px;"
 *         }
 *       ]
 *     },
 *     "questions": {
 *       "e0": {
 *         "type": "choice",
 *         "instructions": "The first line of `elements[0].source` is the CSS declaration `padding: 1px 7px`, from a stylesheet in a product built on a design system, and `1px` in it is hardcoded where the design system has tokens. No token carries this value, and it is past the end of the scale; this is the nearest step. Judging by what the rule styles and the role this value plays there, which token should it use — or is the value a deliberate choice the system has no token for?",
 *         "criteria": {
 *           "--wpds-dimension-padding-xs": "4px",
 *           "keep": "None of these. The hardcoded value is a deliberate one-off the design system has no token for — a brand or illustration colour, an overlay or scrim, a size locked to something outside the system — and should stay as written."
 *         }
 *       }
 *     }
 *   }
 *
 * A colour sends the same shape with a far longer `criteria`: the whole family,
 * each option worth its hex and, where the profile has one, what the design
 * system says that token is for. The answer,
 * `{ choice: "--wpds-dimension-padding-xs", confidence: 0.86, probabilities: {…} }`,
 * settles one part; the declaration is rewritten only once every part of it has
 * settled, and kept only when every part answered `keep`.
 */

import type { Query } from '../judge.ts';
import { KEEP } from '../tokens.ts';
import type { Candidates } from '../tokens.ts';

interface ValueItem {
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
