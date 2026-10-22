/**
 * `css/dead-class`: a class a stylesheet declares that no markup or reference
 * file mentions.
 *
 * Only namespaces the project owns, and only the classes a rule declares in
 * its key selector — ancestors belong to their own rule. Once per class per
 * file. The reference index over-collects on purpose (see `markup.ts`): a
 * false "referenced" costs one missed finding, and a false "dead" tells an
 * agent to delete live CSS.
 *
 * Logic, per class a stylesheet rule declares in its key selector:
 *   already reported for this file                        → skipped
 *   not in a namespace the project owns                   → clean
 *   some markup or reference file mentions the name       → clean
 *   the profile lists the name as never-dead, or it is
 *   the wrapper class of a block the project's block.json
 *   names (`wp-block-acme-card`)                          → clean
 *   the name starts with a stem built at runtime (`is-`)  → clean
 *   otherwise                                             → css/dead-class
 *
 * The editor may offer to delete the rule; `loupe fix` never does. Logic, per
 * finding:
 *   several rules in this file declare the class          → no deletion
 *   the rule could not be lifted out on its own           → no deletion
 *   otherwise                                             → the rule's lines
 *
 * Why only the editor: docs/design/report.md#deleting-is-the-editors-alone.
 */

import type { Candidate } from '../../analyze.ts';
import type { DeadRule } from '../../types.ts';

/** A class a stylesheet rule declares, where the rule starts. */
export interface DeclaredClass {
	file: string;
	line: number;
	cls: string;
	scopeLines: number[];
	/**
	 * How far a deletion of this rule would reach, where deleting it for *this*
	 * class is safe — a selector list whose other selectors do not name the class
	 * carries none, because removing the rule would take their styling too.
	 */
	cut?: DeadRule | undefined;
}

export function deadClasses(
	declared: readonly DeclaredClass[],
	{
		referenced,
		stems,
		isProject,
		isNeverDead,
	}: {
		/** Every token the markup and reference files contain. */
		referenced: ReadonlySet<string>;
		/** Prefixes a class is built from at runtime (`'is-' + state`). */
		stems: readonly string[];
		isProject: (cls: string) => boolean;
		isNeverDead: (cls: string) => boolean;
	},
): Candidate[] {
	const isReferenced = (cls: string): boolean =>
		referenced.has(cls) || isNeverDead(cls) || stems.some((s) => cls.startsWith(s));
	// A finding is one class in one file however many rules declare it, so a
	// deletion is offered only where the rule it points at is the only one.
	const rules = new Map<string, number>();
	for (const d of declared) {
		const key = `${d.file}\u0000${d.cls}`;
		rules.set(key, (rules.get(key) ?? 0) + 1);
	}
	const seen = new Set<string>(); // `${file}\u0000${class}`
	return declared.flatMap(({ file, line, cls, scopeLines, cut }): Candidate[] => {
		const key = `${file}\u0000${cls}`;
		if (seen.has(key) || !isProject(cls) || isReferenced(cls)) return [];
		seen.add(key);
		// The selector is carried so `loupe serve` can resolve the finding to the
		// live elements it claims are unstyled.
		return [
			{
				rule: 'css/dead-class',
				file,
				line,
				message: `.${cls}`,
				code: `.${cls}`,
				selector: `.${cls}`,
				scopeLines,
				dead: rules.get(key) === 1 ? cut : undefined,
			},
		];
	});
}
