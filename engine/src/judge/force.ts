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
 *
 * What one control sends, whole — the request body `ask` posts, here for
 * `represents`:
 *
 *   {
 *     "model": "jev-1.13.0",
 *     "state": {
 *       "elements": [
 *         {
 *           "file": "gutenberg/packages/editor/src/components/post-actions/index.js",
 *           "component": "Menu.Item",
 *           "enclosing_component": "DropdownMenuItemTrigger",
 *           "source": "<Menu.Item onClick={ onClick }>\n\t\t\t<Menu.ItemLabel>{ label }</Menu.ItemLabel>\n\t\t</Menu.Item>"
 *         }
 *       ]
 *     },
 *     "questions": {
 *       "e0": {
 *         "type": "choice",
 *         "instructions": "`elements[0].source` is one interactive control taken from a React user interface. What does that control stand for to the person using it?",
 *         "criteria": {
 *           "value": "It picks or sets a value the system already knows about — an option, a setting, a piece of data. Using it changes what some value is, not where the user is. A select, a checkbox-style menu item, a colour swatch, or a disclosure button whose visible label is the value it will change all count.",
 *           "command": "It invokes a command that changes something — save, delete, duplicate, upload, undo, retry, close, or opening a dialog or panel to do one of those. Using it does something rather than going somewhere or setting a value.",
 *           "destination": "It moves the user to another view, screen, route, record or URL. Using it changes where the user is, however the control happens to be styled — a button that routes is still a destination.",
 *           "none": "Not an interactive control at all: static text or a display-only element that happens to use a control component."
 *         }
 *       }
 *     }
 *   }
 *
 * Every word of `instructions` after the first sentence, and every line of
 * `criteria`, is the vocabulary's own — this file only frames it. The answer,
 * `{ choice: "command", confidence: 0.97, probabilities: {…} }`, is a force
 * value the pattern's `resolve` table then reads.
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
