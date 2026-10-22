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
 * type, and ranks them only where they are more than one question can carry;
 * what arrives here is the pool of plausible counterparts, and the question is
 * the half that is left — which of these plays the same *role*.
 *
 * What one token sends, whole — the request body `ask` posts, with most of its
 * candidates elided:
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

/**
 * The key of the "no counterpart" option for a question offering `candidates`.
 * `none` unless the target set has a token by that path — a border or shadow set
 * may — which would otherwise be overwritten by it, and the model's pick of it
 * read as no counterpart. A `$` cannot begin a DTCG path, so the fallback is
 * never a token's.
 */
export const noneKey = (candidates: readonly { path: string }[]): string =>
	candidates.some((c) => c.path === NONE) ? `$${NONE}` : NONE;

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
		/** See {@link valueCarries} for what `'comparable'` means. */
		value: boolean | 'comparable';
		/** What it points at — often the clearest statement of its role a set makes. */
		alias: boolean;
		description: boolean;
		/** The other leaves in its group: one step of a scale, or a decision on its own. */
		siblings: boolean;
	};
	/** What the model reads about each option. */
	option: { tier: boolean; value: boolean | 'comparable'; description: boolean };
}

/** Every field on. The eval's reference point, not what `map` sends. */
export const FULL_CONTEXT: Context = {
	element: { name: true, type: true, tier: true, value: true, alias: true, description: true, siblings: true },
	option: { tier: true, value: true, description: true },
};

/**
 * Whether a value of this type means the same thing in both systems.
 *
 * A length does: `1px` is `1px` wherever it is written, and a step of a scale is
 * *identified* by its measurement when the two systems name their steps
 * differently — WPDS's `border.width.xs` and Archer's `borderWidth.1` are the
 * same decision, and nothing but `1px` says so.
 *
 * A colour does not. `#e05300` means "the orange this brand picked", and two
 * systems agree on one by coincidence. The same goes for a font stack or a
 * composite.
 */
export const valueCarries = (type: string): boolean =>
	type === 'dimension' || type === 'duration' || type === 'number' || type === 'fontWeight';

/**
 * What `map` sends: everything, with the value shown only where it transfers.
 *
 * `evals/counterparts` deals every target token a value belonging to another
 * token of the same type — present, plausible and wrong, which is what two real
 * systems look like to each other. Showing the value then costs the Archer
 * substrate **29 points of accuracy (92% → 63%)**: the model believes a value
 * when it sees one, and follows it to the wrong token.
 *
 * But hiding it everywhere is worse for the types where a value is the only
 * bridge. On WPDS against Archer, hiding the value took colour from 94 judged
 * rows to 127, and dimension from 31 down to 27 — losing exact matches like
 * `border.width.md` (4px) onto `borderWidth.4` (4px), which no name aligns
 * because one scale is named `xs/sm/md` and the other `1/2/4`.
 *
 * So it is per type, by {@link valueCarries}. The alias is shown either way,
 * because it is a name rather than a value: a token pointing at
 * `{color.brand.500}` has said something about its role that `#e05300` has not.
 */
export const DEFAULT_CONTEXT: Context = {
	element: { ...FULL_CONTEXT.element, value: 'comparable' },
	option: { ...FULL_CONTEXT.option, value: 'comparable' },
};

/** `semantic · #6b7280 — Lower-emphasis text beside a primary label.`, minus whatever is switched off. */
const showValue = (flag: boolean | 'comparable', type: string): boolean =>
	flag === 'comparable' ? valueCarries(type) : flag;

const describe = (t: Token, opt: Context['option']): string => {
	const head = [
		opt.tier && t.tier !== 'unknown' ? t.tier : '',
		showValue(opt.value, t.type) ? t.literal || '(no value)' : '',
	]
		.filter(Boolean)
		.join(' \u00b7 ');
	const desc = opt.description ? t.description : undefined;
	if (!head) return desc ?? '(name only)';
	return desc ? `${head} \u2014 ${desc}` : head;
};

/** What the instructions promise each option carries, so the wording tracks the context. */
function optionShape(opt: Context['option']): string {
	const said = [
		opt.tier ? 'the tier it sits at' : '',
		opt.value === true ? 'its value' : '',
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
export const counterpartQuery = (ctx: Context = DEFAULT_CONTEXT): Query<CounterpartItem> => ({
	element: ({ token, fromLabel }) => ({
		set: fromLabel,
		...(ctx.element.name ? { token: token.path } : {}),
		...(ctx.element.type ? { type: token.type || 'unknown' } : {}),
		...(ctx.element.tier && token.tier !== 'unknown' ? { tier: token.tier } : {}),
		...(showValue(ctx.element.value, token.type) && token.literal ? { value: token.literal } : {}),
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
			[noneKey(candidates)]: NONE_CRITERION,
		},
	}),
});
