/**
 * `map`: which token in the other set is this one's counterpart?
 *
 * Two design systems that share no naming, no grouping and no values still make
 * most of the same decisions — both have a default text colour, both have a step
 * of spacing that sits inside a button. Finding the pairs is what makes the two
 * comparable, and it is not something a parse can do: `color.text.primary` and
 * `content.default.fg` are the same decision under names with no word in common,
 * while `color.text.primary` and `color.border.primary` share two words and are
 * not related at all.
 *
 * So the arithmetic goes first and the judgement goes second, the same division
 * `judge/value.ts` makes. `mapping.ts` narrows to the tokens of a compatible
 * type and ranks them by value distance, name overlap and tier; what arrives
 * here is a shortlist of plausible counterparts, and the question is the half
 * that is left — which of these plays the same *role*.
 *
 * What one token sends, whole — the request body `ask` posts, with four of the
 * eight candidates elided:
 *
 *   {
 *     "model": "jev-1.13.0",
 *     "state": {
 *       "elements": [
 *         {
 *           "set": "wpds",
 *           "token": "color.foreground.secondary",
 *           "type": "color",
 *           "tier": "semantic",
 *           "value": "#757575",
 *           "aliases": "color.gray.600",
 *           "description": "Secondary text: help text, captions, metadata.",
 *           "group_siblings": ["primary", "tertiary", "disabled", "inverted"]
 *         }
 *       ]
 *     },
 *     "questions": {
 *       "e0": {
 *         "type": "choice",
 *         "instructions": "`elements[0]` is one design token from the design system \"wpds\". Each option below is a token from a different design system, \"archer\", given as its tier, its value, and what that system says it is for. Which option is the counterpart of `elements[0]` — the token an interface being ported from wpds to archer should use in its place? Judge by the role each token plays in its own system, not by how close the two values happen to be: two systems can agree on a role and still round the value differently, and two unrelated tokens can share a value by coincidence.",
 *         "criteria": {
 *           "text.muted": "semantic · #6b7280 — Lower-emphasis text beside a primary label.",
 *           "text.default": "semantic · #111827 — Body copy and labels.",
 *           "border.subtle": "semantic · #e5e7eb — Hairlines between rows.",
 *           "palette.slate.500": "base · #64748b",
 *           "none": "None of these. The second system has no counterpart for this token — it models this part of the interface differently, or does not model it at all — and a port would have to add a token rather than reuse one."
 *         }
 *       }
 *     }
 *   }
 *
 * The answer, `{ choice: "text.muted", confidence: 0.88, probabilities: {…} }`,
 * is one row of the map: `color.foreground.secondary → text.muted (judged 0.88)`.
 */

import type { Query } from '../judge.ts';
import type { Token } from '../dtcg.ts';

/** What `map` answers for a token the other set has no counterpart for. */
export const NONE = 'none';

/** One token to be mapped, with the shortlist it is choosing among. */
export interface CounterpartItem {
	token: Token;
	candidates: readonly Token[];
	/** The set each side came from, named as the reader named it on the command line. */
	fromLabel: string;
	toLabel: string;
}

// Worded as a decision about the two systems rather than as "none of these
// looked close", for the reason `judge/value.ts` words `keep` the way it does:
// an escape hatch that reads as "no exact match" collects every hard call.
const NONE_CRITERION =
	'None of these. The second system has no counterpart for this token — it models this part of the interface ' +
	'differently, or does not model it at all — and a port would have to add a token rather than reuse one.';

/** `semantic · #6b7280 — Lower-emphasis text beside a primary label.` */
const describe = (t: Token): string => {
	const head = `${t.tier} · ${t.literal || '(composite)'}`;
	return t.description ? `${head} — ${t.description}` : head;
};

/**
 * What the model reads about the token being mapped.
 *
 * Everything here is something a reader would need to answer the question and
 * cannot get from the name. `aliases` is what the token points at, which is
 * often the clearest statement of its role a set makes — a semantic token whose
 * name is opaque still says `{color.red.600}`. `group_siblings` say whether the
 * token is one step of a scale or a decision on its own, which is what separates
 * `spacing.md` from `card.padding`.
 */
export const counterpartQuery: Query<CounterpartItem> = {
	element: ({ token, fromLabel }) => ({
		set: fromLabel,
		token: token.path,
		type: token.type || 'unknown',
		tier: token.tier,
		value: token.literal,
		...(token.alias ? { aliases: token.alias } : {}),
		...(token.description ? { description: token.description } : {}),
		...(token.siblings.length ? { group_siblings: token.siblings } : {}),
	}),
	question: ({ candidates, fromLabel, toLabel }, i) => ({
		type: 'choice',
		instructions:
			`\`elements[${i}]\` is one design token from the design system "${fromLabel}". Each option below is a token ` +
			`from a different design system, "${toLabel}", given as its tier, its value, and what that system says it is ` +
			`for. Which option is the counterpart of \`elements[${i}]\` — the token an interface being ported from ` +
			`${fromLabel} to ${toLabel} should use in its place? Judge by the role each token plays in its own system, ` +
			'not by how close the two values happen to be: two systems can agree on a role and still round the value ' +
			'differently, and two unrelated tokens can share a value by coincidence.',
		criteria: {
			...Object.fromEntries(candidates.map((c) => [c.path, describe(c)])),
			[NONE]: NONE_CRITERION,
		},
	}),
};
