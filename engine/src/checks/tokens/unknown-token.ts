/**
 * `tokens/unknown-token`: a `var()` naming a token in the design system's
 * namespace that no token source defines — usually a misspelling, or one an
 * agent invented.
 *
 * Run once every stylesheet has been read, since a set that is still being
 * built reports the design system's own tokens as unknown. An empty set means
 * nothing was found to check against, not that every token is unknown, and
 * says nothing. Once per name per file.
 *
 * Logic, per `var(--name)` in the design system's namespace:
 *   nothing was read into the known set        → report nothing at all
 *   the name is in the known set               → clean
 *   already reported for this file             → skipped
 *   otherwise                                  → tokens/unknown-token
 */

import type { Candidate } from '../../analyze.ts';

/** A `var(--name)` in the design system's namespace, where it was written. */
export interface TokenRef {
	file: string;
	line: number;
	name: string;
	scopeLines: number[];
}

export function unknownTokens(refs: readonly TokenRef[], known: ReadonlySet<string>): Candidate[] {
	if (!known.size) return [];
	const seen = new Set<string>();
	return refs.flatMap(({ file, line, name, scopeLines }): Candidate[] => {
		const key = `${file}\u0000${name}`;
		if (known.has(name) || seen.has(key)) return [];
		seen.add(key);
		return [{ rule: 'tokens/unknown-token', file, line, message: `var(${name})`, code: name, scopeLines }];
	});
}
