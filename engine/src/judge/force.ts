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

type ForceItem = Pick<Control, 'file' | 'component' | 'enclosing' | 'source'>;

export const forceQuery = (force: ForceJudge): Query<ForceItem> => ({
	element: (c) => ({ file: c.file, component: c.component, enclosing_component: c.enclosing, source: c.source }),
	question: (_c, i) => ({
		type: 'choice',
		instructions: `\`elements[${i}].source\` is one interactive control taken from a React user interface. ${force.question}`,
		criteria: force.criteria,
	}),
});
