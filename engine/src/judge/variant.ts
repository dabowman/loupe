/**
 * `system/raw-element`: which variant?
 *
 * `<p> → <Text>` is right about the component and silent about the variant,
 * which is the half an agent has to guess — and on a real plugin it is wrong
 * about the component often enough to matter: a `<span>` that is a colour
 * swatch, a `<p>` that only wraps a button. Neither is decidable from the tag
 * and its classes; both are obvious from reading the element.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Query } from '../judge.ts';
import type { ComponentEntry, Finding } from '../types.ts';

export interface VariantItem {
	f: Finding;
	/** The registry entry, with variants, the finding points at. */
	target: ComponentEntry;
}

/** The option that says the analog was the wrong call. */
export const notKey = (e: ComponentEntry): string => `not_${e.name.toLowerCase()}`;

export const variantQuery = (root: string): Query<VariantItem> => ({
	// One per request, as forces are: `represents` lost a third of its
	// destinations sharing a state 40 ways, and this has no eval of its own to
	// say it fares better. Each question needs only its own element, so the
	// tokens are about the same either way.
	size: 1,
	element: ({ f }) => {
		const lines = readFileSync(join(root, f.file), 'utf8').split('\n');
		const i = f.line - 1;
		return {
			file: f.file,
			// The flagged element opens on the first line of `source`; the lines
			// before it are its parent, which is often what decides the role.
			context_before: lines.slice(Math.max(0, i - 5), i).join('\n'),
			source: lines.slice(i, i + 10).join('\n'),
		};
	},
	question: ({ f, target }, i) => ({
		type: 'choice',
		instructions: `The ${f.code ?? 'element'} on the first line of \`elements[${i}].source\` is flagged to be replaced by the design system's ${target.name} component. Which ${target.name} variant matches the role this element plays in its interface?`,
		// The option name is sent to the model too, so it says what it means:
		// `none` scored the same elements 0.3 lower than `not_text`. Wording
		// that forced a decision ("holds no text of its own") cleared the
		// floor more often and called real text `not_text` doing it.
		criteria: {
			...target.variants,
			[notKey(target)]: `The element is not a run of content ${target.name} renders — a wrapper around controls, an icon holder or colour swatch, a layout box — so no ${target.name} variant applies.`,
		},
	}),
});
