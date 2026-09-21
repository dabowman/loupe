/**
 * `system/raw-element`: which variant?
 *
 * `<p> → <Text>` is right about the component and silent about the variant, the
 * half an agent has to guess — and often enough wrong about the component too,
 * which is what `not_text` is for. Design notes: docs/design/judge.md
 *
 * What one `<p>` sends, whole — the request body `ask` posts, with six of the
 * nine Text variants elided:
 *
 *   {
 *     "model": "jev-1.13.0",
 *     "state": {
 *       "elements": [
 *         {
 *           "file": "src/AssetCard.jsx",
 *           "context_before": "\treturn (\n\t\t<Card className=\"vip-dam-card\">\n\t\t\t<CardBody>\n\t\t\t\t<img src={ asset.thumbnail } alt=\"\" className=\"vip-dam-card__thumb\" />\n\t\t\t\t<h3 className=\"vip-dam-card__title\">{ asset.title }</h3>",
 *           "source": "\t\t\t\t<p className=\"vip-dam-card__meta\">\n\t\t\t\t\t{ asset.mimeType } · { formatBytes( asset.size ) }\n\t\t\t\t</p>\n\t\t\t\t<Button variant=\"secondary\" onClick={ onOpen }>\n\t\t\t\t\tOpen\n\t\t\t\t</Button>\n\t\t\t</CardBody>\n\t\t</Card>\n\t);\n}"
 *         }
 *       ]
 *     },
 *     "questions": {
 *       "e0": {
 *         "type": "choice",
 *         "instructions": "The <p> on the first line of `elements[0].source` is flagged to be replaced by the design system's Text component. Which Text variant matches the role this element plays in its interface?",
 *         "criteria": {
 *           "heading-2xl": "Page title. 32px, semibold. One per screen, at the top.",
 *           "heading-lg": "Section or card title. 15px, semibold.",
 *           "body-md": "Default body text: paragraphs, labels, values. 13px, regular.",
 *           "body-sm": "Secondary text: help text, descriptions, captions, metadata, muted notes. 12px, regular.",
 *           "not_text": "The element is not a run of content Text renders — a wrapper around controls, an icon holder or colour swatch, a layout box — so no Text variant applies."
 *         }
 *       }
 *     }
 *   }
 *
 * The answer comes back as `{ choice: "body-sm", confidence: 0.81, probabilities: {…} }`,
 * and above the floor `judgeVariants` writes it into the finding:
 * `<p> → <Text variant="body-sm"> (judged 0.81)`.
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
