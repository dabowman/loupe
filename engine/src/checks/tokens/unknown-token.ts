/**
 * `tokens/unknown-token`: a `var()` naming a token in the design system's
 * namespace that no token source defines — usually a misspelling, or one an
 * agent invented.
 *
 * Run once every stylesheet has been read, since a set that is still being
 * built reports the design system's own tokens as unknown. An empty set means
 * nothing was found to check against, not that every token is unknown, and
 * says nothing. Once per name per file, carrying every line that names it, at
 * the first reference read and with that channel's marker.
 *
 * Logic, per `var(--name)` in the design system's namespace — in any stylesheet
 * rule, a class named or not, a `style={{ … }}` object or a CSS-in-JS template:
 *   nothing was read into the known set        → report nothing at all
 *   the name is in the known set               → clean
 *   already reported for this file             → folded into that finding
 *   otherwise                                  → tokens/unknown-token
 *
 * Logic, per unknown name, for the rewrite `loupe fix` may apply:
 *   more than one keystroke from every
 *   known token                                → no rewrite, the finding stands
 *   its only near misses differ from it in
 *   nothing but digits                         → no rewrite, the finding stands
 *   two or more known tokens are near misses   → no rewrite, the finding stands
 *   exactly one known token is a near miss     → rename, every line of them
 *
 * Any case but the last carries `unknown`, and `--judge` asks which token was
 * meant among {@link renameCandidates} — see src/judge/token.ts.
 *
 * Design notes: docs/design/report.md#fixing
 */

import type { Candidate } from '../../analyze.ts';
import type { TokenScopes } from '../../scopes.ts';
import { onRole } from '../../tokens.ts';
import type { TokenRename } from '../../types.ts';

/** A `var(--name)` in the design system's namespace, where it was written. */
export interface TokenRef {
	file: string;
	line: number;
	name: string;
	/** The property whose value names it. */
	prop: string;
	scopeLines: number[];
	/** The channel marker a finding reported here carries: ` (inline)`. */
	suffix?: string | undefined;
}

/**
 * Whether two names are one insertion, deletion or substitution apart. Walks in
 * from both ends; whatever is left between the two walks is the edit.
 */
function oneEdit(a: string, b: string): boolean {
	if (Math.abs(a.length - b.length) > 1) return false;
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	return a.length - head - tail <= 1 && b.length - head - tail <= 1;
}

/** The same name once every digit is dropped — a scale step is not a spelling. */
const spelling = (name: string): string => name.replace(/\d/g, '');

/** The one known token this name is a single keystroke from, or nothing. */
function nearMiss(name: string, known: ReadonlySet<string>): string | undefined {
	let found: string | undefined;
	for (const k of known) {
		if (!oneEdit(name, k) || spelling(k) === spelling(name)) continue;
		if (found !== undefined) return undefined;
		found = k;
	}
	return found;
}

/**
 * The known tokens a judgement chooses among for an unknown name: the family of
 * the property it is written in, and every token a keystroke from it — scale
 * steps included, since which step was meant is what the judgement reads.
 *
 * A custom property answers as the longest property its name ends in:
 * `--wp-ui-button-background-color` as `background-color`. Where nothing
 * answers — a `transform`, `--sf-accent` — the family is the known tokens
 * sharing the most leading segments with the name, down to the one after the
 * system's prefix.
 *
 * The family is the one the profile's token scopes put on the property where
 * they say, as it is for a value's suggestion: a rename asked among the generic
 * table's family would offer, and could settle on, a token the profile says is
 * not for this property at all.
 */
export function renameCandidates(
	name: string,
	prop: string,
	known: ReadonlySet<string>,
	scopes?: TokenScopes | undefined,
): string[] {
	const names = [...known];
	const tails = prop.startsWith('--') ? prop.slice(2).split('-') : [];
	let family = onRole(names, prop, scopes);
	for (let k = 0; !family.length && k < tails.length; k++) family = onRole(names, tails.slice(k).join('-'), scopes);
	const segs = name.split('-');
	// `--wpds-color-x` splits to ['', '', 'wpds', 'color', 'x']: four is the
	// shortest head that still names a category.
	for (let k = segs.length - 1; !family.length && k >= 4; k--) {
		const head = `${segs.slice(0, k).join('-')}-`;
		family = names.filter((n) => n.startsWith(head));
	}
	return [...new Set([...family, ...names.filter((n) => oneEdit(name, n))])];
}

export function unknownTokens(refs: readonly TokenRef[], known: ReadonlySet<string>): Candidate[] {
	if (!known.size) return [];
	// Grouped rather than deduped, because the fix acts on every line the name is
	// written on and the report still shows one finding at the first of them.
	const groups = new Map<string, TokenRef & { lines: number[] }>();
	for (const ref of refs) {
		if (known.has(ref.name)) continue;
		const group = groups.get(`${ref.file}\u0000${ref.name}`);
		if (group) {
			if (!group.lines.includes(ref.line)) group.lines.push(ref.line);
			continue;
		}
		groups.set(`${ref.file}\u0000${ref.name}`, { ...ref, lines: [ref.line] });
	}
	return [...groups.values()].map(({ file, line, name, prop, scopeLines, suffix, lines }): Candidate => {
		const to = nearMiss(name, known);
		const rename: TokenRename | undefined = to === undefined ? undefined : { from: name, to, lines };
		return {
			rule: 'tokens/unknown-token',
			file,
			line,
			// The name alone: the rule's title already says a token is being named.
			// With the replacement beside it where one is settled, so a reader sees
			// what `fix` would write without having to run it.
			message: `${to === undefined ? name : `${name} → ${to}`}${suffix ?? ''}`,
			// Never the marker: a name's identity is not the channel it was first read in.
			code: name,
			suffix,
			scopeLines,
			rename,
			unknown: rename ? undefined : { prop, lines },
		};
	});
}
