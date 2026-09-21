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

interface VariantItem {
	f: Finding;
	/** The registry entry, with variants, the finding points at. */
	target: ComponentEntry;
}

/** The lines a judged element is read with: `before` above it, and `source` opening on it. */
export function around(
	root: string,
	file: string,
	line: number,
	before: number,
	after: number,
): { context_before: string; source: string } {
	const lines = readFileSync(join(root, file), 'utf8').split('\n');
	const i = line - 1;
	return {
		context_before: lines.slice(Math.max(0, i - before), i).join('\n'),
		source: lines.slice(i, i + after).join('\n'),
	};
}

/** The option that says the analog was the wrong call. */
export const notKey = (e: ComponentEntry): string => `not_${e.name.toLowerCase()}`;

export const variantQuery = (root: string): Query<VariantItem> => ({
	// The lines before the flagged element are its parent, which is often what
	// decides the role.
	element: ({ f }) => ({ file: f.file, ...around(root, f.file, f.line, 5, 10) }),
	question: ({ f, target }, i) => ({
		type: 'choice',
		instructions: `The ${f.code ?? 'element'} on the first line of \`elements[${i}].source\` is flagged to be replaced by the design system's ${target.name} component. Which ${target.name} variant matches the role this element plays in its interface?`,
		// The option name is sent to the model too, so it says what it means:
		// `none` scored the same elements 0.3 lower than `not_text`. Wording
		// that forced a decision ("holds no text of its own") cleared the
		// floor more often and called real text `not_text` doing it.
		criteria: {
			...target.variants,
			[notKey(target)]:
				`The element is not a run of content ${target.name} renders — a wrapper around controls, an icon holder or colour swatch, a layout box — so no ${target.name} variant applies.`,
		},
	}),
});
