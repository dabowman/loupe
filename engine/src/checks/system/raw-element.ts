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
import { supersededEverywhere } from './currency.ts';

/**
 * The element map's analog, forwarded if the registry has since superseded it.
 * Only when *every* package carrying the name is stale, so a component that is
 * legacy in one package and recommended in another keeps the bare name.
 */
function currentAnalog(registry: ReadonlyMap<string, ComponentEntry>, suggest: string): string {
	if (!supersededEverywhere(registry, suggest)) return `<${suggest}>`;
	const remedy = [...registry.values()].find((e) => e.name === suggest && e.supersededBy)?.supersededBy;
	return remedy || `<${suggest}>`;
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
		// A `styledOnly` mapping earns its suggestion only when the element does
		// what the suggested component is for: `<span>` → `<Text>` needs styling of
		// any kind, `<div>` → a layout primitive needs the div to lay something out.
		if (el.styledOnly) {
			// `String`: a `{ styledOnly: true }` entry may carry no `component`.
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
