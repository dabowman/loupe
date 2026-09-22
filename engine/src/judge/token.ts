/**
 * `tokens/unknown-token`: which token was meant?
 *
 * A name in the design system's namespace that nothing defines, where no single
 * known token is one keystroke from it. Usually an agent's guess at the system's
 * naming — `--wpds-color-text-primary` for `--wpds-color-foreground-content-neutral`
 * — or a typo that lands between two real names. Which one it meant is read off
 * the name and what the rule styles; `evals/renames` scores it.
 *
 * What one name sends, whole — the request body `ask` posts:
 *
 *   {
 *     "model": "jev-1.13.0",
 *     "state": {
 *       "elements": [
 *         {
 *           "file": "src/components/Card.scss",
 *           "context_before": ".card__meta {\n\tdisplay: flex;",
 *           "source": "\tcolor: var(--wpds-color-text-muted);\n}"
 *         }
 *       ]
 *     },
 *     "questions": {
 *       "e0": {
 *         "type": "choice",
 *         "instructions": "The first line of `elements[0].source` uses `var(--wpds-color-text-muted)` in `color`. …which of the design system's real tokens was meant?",
 *         "criteria": {
 *           "--wpds-color-foreground-content-neutral": "#1e1e1e — Text with normal emphasis.",
 *           "--wpds-color-foreground-content-neutral-weak": "#707070 — Text with low emphasis.",
 *           …,
 *           "none": "None of these. …"
 *         }
 *       }
 *     }
 *   }
 *
 * `{ choice: "--wpds-color-foreground-content-neutral-weak", confidence: 0.94 }`
 * becomes the rename `fix --judge` writes on every line of the file naming it.
 */

import type { Query } from '../judge.ts';

interface RenameItem {
	file: string;
	context_before: string;
	/** Opens on the first line naming it. */
	source: string;
	name: string;
	prop: string;
	/** `[token, what it is]`: its value, and the design system's description where there is one. */
	options: [string, string][];
}

/** What `check --judge` answers for a name no real token was meant by. */
export const NONE = 'none';

// Worded as a thing the system lacks, with examples of one, so that it is
// chosen for a reason and not as the answer to "none of these is spelled alike".
const NONE_CRITERION =
	'None of these. The name stands for something the design system has no token for — a z-index, an opacity, a shadow, a colour of the product’s own — so no real token is what it meant.';

export const renameQuery: Query<RenameItem> = {
	element: ({ file, context_before, source }) => ({ file, context_before, source }),
	question: ({ name, prop, options }, i) => ({
		type: 'choice',
		instructions: `The first line of \`elements[${i}].source\` uses \`var(${name})\` in \`${prop}\`. The name is in the design system's token namespace, but the design system defines no token by that name: it is misspelled, or was invented to look like one of the system's own. Which of the design system's real tokens was its author naming? Keep whatever the name already says — its step on a scale, its emphasis, its state — and use what the rule styles only to decide what the name leaves open.`,
		criteria: { ...Object.fromEntries(options), [NONE]: NONE_CRITERION },
	}),
};
