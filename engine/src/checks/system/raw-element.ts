/**
 * `system/raw-element`: a raw element the design system has an analog for.
 *
 * The scanner records every element the element map names, with its classes
 * and whether an inline style styles or lays it out; the stylesheet walk
 * records which classes style something and which lay something out. This is
 * what is decided from those.
 *
 * Logic, per element the element map names:
 *   the mapping is not `styledOnly`                         → system/raw-element
 *   `styledOnly`, and the analog is a layout primitive:
 *     nothing lays the element out — no inline layout,
 *     no class some stylesheet lays out with                → clean
 *   `styledOnly`, and the analog is anything else:
 *     nothing styles the element — no inline style,
 *     no class some stylesheet styles                       → clean
 *   otherwise                                               → system/raw-element, naming
 *                                                             the analog the registry
 *                                                             still recommends
 */

import type { Candidate } from '../../analyze.ts';
import type { ComponentEntry, RawElement } from '../../types.ts';

/**
 * The element map's analog, forwarded if the registry has since superseded it.
 *
 * The map is keyed by tag and names a bare component; the registry is keyed by
 * package and knows currency. Nothing reconciled them, so on a two-package
 * system the two rules contradicted each other: `system/raw-element` said
 * `<h3> → <Heading>`, and doing that earned a `system/superseded-component`
 * saying `Heading` is legacy. An agent that follows the first finding
 * manufactures the second, which is a loop a weaker model can run forever.
 *
 * Only forwards when *every* package carrying the name is stale, so a component
 * that is legacy in one package and recommended in another (WPDS has several)
 * keeps the bare name and lets the import rule speak to the package.
 */
function currentAnalog(registry: ReadonlyMap<string, ComponentEntry>, suggest: string): string {
	const entries = [...registry.values()].filter((e) => e.name === suggest);
	const current = entries.some((e) => e.status === 'recommended');
	return (!current && entries.find((e) => e.supersededBy)?.supersededBy) || `<${suggest}>`;
}

export function rawElements(
	els: readonly RawElement[],
	{
		layoutComponents,
		styledClasses,
		layoutClasses,
		registry,
	}: {
		layoutComponents: readonly string[];
		/** Classes some stylesheet styles. */
		styledClasses: ReadonlySet<string>;
		/** Classes some stylesheet lays something out with. */
		layoutClasses: ReadonlySet<string>;
		registry: ReadonlyMap<string, ComponentEntry>;
	},
): Candidate[] {
	return els.flatMap((el): Candidate[] => {
		// A `styledOnly` mapping only earns its suggestion when the element is doing
		// what the suggested component is for. `<span>` → `<Text>` needs styling of
		// any kind; `<div>` → a layout primitive needs the div to actually lay
		// something out. Accepting any styling for both told agents to turn every
		// bordered `<div>` into an `<HStack>` — the largest single source of
		// findings in a real repo, and wrong nearly every time.
		if (el.styledOnly) {
			// `String`: an elementMap entry authored as `{ styledOnly: true }` has no
			// `component`, and one bad entry must not take the whole run down.
			const suggestsLayout = String(el.suggest)
				.split('/')
				.some((n) => layoutComponents.includes(n.trim()));
			const laidOut = el.inlineLayout || el.classes.some((c) => layoutClasses.has(c));
			const styled = el.inlineStyled || el.classes.some((c) => styledClasses.has(c));
			if (suggestsLayout ? !laidOut : !styled) return [];
		}
		return [
			{
				rule: 'system/raw-element',
				file: el.file,
				line: el.line,
				message: `<${el.tag}> → ${currentAnalog(registry, el.suggest)}`,
				code: `<${el.tag}>`,
			},
		];
	});
}
