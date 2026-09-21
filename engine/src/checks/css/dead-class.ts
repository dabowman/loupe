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
 *   the profile lists the name as never-dead              → clean
 *   the name starts with a stem built at runtime (`is-`)  → clean
 *   otherwise                                             → css/dead-class
 */

import type { Candidate } from '../../analyze.ts';

/** A class a stylesheet rule declares, where the rule starts. */
export interface DeclaredClass {
	file: string;
	line: number;
	cls: string;
	scopeLines: number[];
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
	const seen = new Set<string>(); // `${file}\u0000${class}`
	return declared.flatMap(({ file, line, cls, scopeLines }): Candidate[] => {
		const key = `${file}\u0000${cls}`;
		if (seen.has(key) || !isProject(cls) || isReferenced(cls)) return [];
		seen.add(key);
		// The selector is carried so `loupe serve` can resolve the finding to the
		// live elements it claims are unstyled.
		return [
			{ rule: 'css/dead-class', file, line, message: `.${cls}`, code: `.${cls}`, selector: `.${cls}`, scopeLines },
		];
	});
}
