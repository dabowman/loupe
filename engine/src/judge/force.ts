/**
 * A force, read off one control.
 *
 * The `resolve` tables in `patterns/index.json` decide on things a signature
 * cannot see — does this control stand for a value, a command or a
 * destination — so this asks. The wording is the force's own, from the
 * vocabulary, so the definition an author reads beside `about` is the one the
 * model is scored on. `represents` was tuned against `evals/represents`: one
 * disambiguating line per value and no more, or the eval scores a cheat sheet;
 * and its no-match stays `none`, against the `not_text` lesson in
 * `variant.ts`, because it is rare and the three real classes separate
 * cleanly — `not_a_control` moved nothing and cost two points.
 *
 * The state carries the element and where it came from and nothing else: an
 * ablation over 100 labelled controls scored the enclosing component's source
 * exactly level with leaving it out, at 1.5x the tokens, because the slice
 * usually missed the handler it was there to supply.
 */

import type { Query } from '../judge.ts';
import type { Control } from '../types.ts';

/** How a force is asked: its `judge` block in `patterns/index.json`. */
export interface ForceJudge {
	question: string;
	/** One per value of the force, plus the no-match option the question needs. */
	criteria: Record<string, string>;
}

export type ForceItem = Pick<Control, 'file' | 'component' | 'enclosing' | 'source'>;

export const forceQuery = (force: ForceJudge): Query<ForceItem> => ({
	// Measured, one run over the eval's 100 controls — destination recall is the
	// column that decides it, because every redirect in the abstract language
	// fires on that class:
	//
	//   batch   all   destination P/R
	//      40   81%      91% / 69%
	//      20   90%      96% / 83%
	//      10   90%     100% / 86%
	//       4   91%     100% / 90%
	//       1   93%     100% / 97%
	//
	// Sharing a state with 39 other controls costs nearly a third of the
	// destinations. A control is a few lines, so one request each is cheap; the
	// pool in `ask` is what keeps it quick. Every force is asked this way until
	// its own eval says otherwise: this table is `represents`, not forces in
	// general.
	size: 1,
	element: (c) => ({ file: c.file, component: c.component, enclosing_component: c.enclosing, source: c.source }),
	question: (_c, i) => ({
		type: 'choice',
		instructions: `\`elements[${i}].source\` is one interactive control taken from a React user interface. ${force.question}`,
		criteria: force.criteria,
	}),
});
