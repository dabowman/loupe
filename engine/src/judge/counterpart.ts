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
 *         "instructions": "`elements[0]` is one design token from the design system \"wpds\". Each option below is a token from a different design system, \"archer\", given as the tier it sits at, its value and what that system says it is for. Which option is the counterpart of `elements[0]` — the token an interface being ported from wpds to archer should use in its place, or does archer have no counterpart for it? Match the intent of the token: the decision it records, and how specific that decision is. Two systems can agree on an intent and still round the value differently, and two unrelated tokens can share a value by coincidence.",
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

/**
 * Which facts about a token reach the model.
 *
 * Every flag here is a claim that this part of a token carries its meaning, and
 * that is an empirical question rather than a design one. `evals/counterparts`
 * turns each one off in turn and scores what it costs, which is the only way to
 * tell context from noise. The defaults are what `map` ships.
 */
export interface Context {
	/** What the model reads about the token being mapped. */
	element: {
		/** Its path. Off asks whether the description alone identifies it; the
		 * options keep theirs either way, since a path is how an answer is named. */
		name: boolean;
		type: boolean;
		tier: boolean;
		value: boolean;
		/** What it points at — often the clearest statement of its role a set makes. */
		alias: boolean;
		description: boolean;
		/** The other leaves in its group: one step of a scale, or a decision on its own. */
		siblings: boolean;
	};
	/** What the model reads about each option. */
	option: { tier: boolean; value: boolean; description: boolean };
}

export const FULL_CONTEXT: Context = {
	element: { name: true, type: true, tier: true, value: true, alias: true, description: true, siblings: true },
	option: { tier: true, value: true, description: true },
};

/** `semantic · #6b7280 — Lower-emphasis text beside a primary label.`, minus whatever is switched off. */
const describe = (t: Token, opt: Context['option']): string => {
	const head = [opt.tier ? t.tier : '', opt.value ? t.literal || '(no value)' : ''].filter(Boolean).join(' \u00b7 ');
	const desc = opt.description ? t.description : undefined;
	if (!head) return desc ?? '(name only)';
	return desc ? `${head} \u2014 ${desc}` : head;
};

/** What the instructions promise each option carries, so the wording tracks the context. */
function optionShape(opt: Context['option']): string {
	const said = [
		opt.tier ? 'the tier it sits at' : '',
		opt.value ? 'its value' : '',
		opt.description ? 'what that system says it is for' : '',
	].filter(Boolean);
	if (!said.length) return 'its name alone';
	if (said.length === 1) return said[0] as string;
	return `${said.slice(0, -1).join(', ')} and ${said.at(-1)}`;
}

/**
 * The question, over whichever context is switched on.
 *
 * It asks for the *intent* of the token rather than for a nearest neighbour, and
 * says outright that a value agreeing is not evidence. Specificity is part of
 * that intent, not a separate axis: a button's border token and a common border
 * token record the same kind of decision at different scopes, so the tier is
 * offered as one more fact about meaning rather than as a filter.
 */
export const counterpartQuery = (ctx: Context = FULL_CONTEXT): Query<CounterpartItem> => ({
	element: ({ token, fromLabel }) => ({
		set: fromLabel,
		...(ctx.element.name ? { token: token.path } : {}),
		...(ctx.element.type ? { type: token.type || 'unknown' } : {}),
		...(ctx.element.tier ? { tier: token.tier } : {}),
		...(ctx.element.value && token.literal ? { value: token.literal } : {}),
		...(ctx.element.alias && token.alias ? { aliases: token.alias } : {}),
		...(ctx.element.description && token.description ? { description: token.description } : {}),
		...(ctx.element.siblings && token.siblings.length ? { group_siblings: token.siblings } : {}),
	}),
	question: ({ candidates, fromLabel, toLabel }, i) => ({
		type: 'choice',
		instructions:
			`\`elements[${i}]\` is one design token from the design system "${fromLabel}". Each option below is a ` +
			`token from a different design system, "${toLabel}", given as ${optionShape(ctx.option)}. Which option is ` +
			`the counterpart of \`elements[${i}]\` — the token an interface being ported from ${fromLabel} to ` +
			`${toLabel} should use in its place, or does ${toLabel} have no counterpart for it? Match the intent of ` +
			'the token: the decision it records, and how specific that decision is. Two systems can agree on an intent ' +
			'and still round the value differently, and two unrelated tokens can share a value by coincidence.',
		criteria: {
			...Object.fromEntries(candidates.map((c) => [c.path, describe(c, ctx.option)])),
			[NONE]: NONE_CRITERION,
		},
	}),
});
