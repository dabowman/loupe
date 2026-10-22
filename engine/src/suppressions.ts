/**
 * Suppression directives.
 *
 *   <keyword> system/override -- Stack exposes no padding prop
 *
 * where `<keyword>` is what the active preset asks for — `ds-allow` under
 * `generic`, `wpds-allow` under `wpds`. Rule id(s) and a reason are both
 * mandatory. Anything looser — a whole-file disable, a missing reason, a bare
 * keyword — is not a mute but its own violation (`suppression/malformed`).
 *
 * The directive must be the first thing in its comment, which is what stops the
 * checker flagging its own documentation. Note the limit of that defence: an
 * *indented* example inside a doc comment is still first in its comment once the
 * asterisks are stripped, so a file that quotes the grammar verbatim under a
 * scanned `src/` is writing a live directive. Write it the way this comment does.
 *
 * The keyword is preset-scoped, so adopting a different preset renames it. Read
 * aliases are what keep that rename from orphaning the directives already
 * written: every keyword the engine knows *mutes*, whichever one the active
 * config asks people to write.
 *
 * Design notes: docs/design/report.md#suppression
 */

import { canonicalRuleId } from './rules.ts';
import { escapeRe, head, oneLine } from './text.ts';
import type { Directive, MalformedDirective, SuppressionConfig, Suppressions } from './types.ts';

const ID = '(?:[A-Za-z][\\w-]*(?:/[\\w-]+)*)';

// Leading whitespace, jsdoc asterisks, then an optional comment opener. The JSX
// opener admits a space before the comment (`{ /* … */ }`), the form WordPress's
// prettier config mandates.
const OPENER = /^[\s*]*(?:\/\/+|\/\*+|\{\s*\/\*+|<!--|#+)?\s*/;

/**
 * The lines after `i` that a directive's own block comment still covers.
 *
 * Empty unless the directive opened a block comment on this line that closes on
 * a later one — a `//` or `#` comment ends with its line, and a block that
 * already closed needs nothing. The closer is searched for within a bound: a
 * comment that never closes is a broken file, and extending a suppression to
 * the end of it would turn a typo into the blanket disable this grammar exists
 * to refuse.
 *
 * ponytail: the opener is read off the line rather than tokenized, so a `/*`
 * inside a string literal on the directive's own line reads as a comment. The
 * whole scanner is line-and-regex already; upgrade both together if it matters.
 */
function spannedLines(lines: readonly string[], i: number, raw: string, stripped: string): number[] {
	const opener = raw.slice(0, raw.length - stripped.length);
	const close = /\/\*/.test(opener) ? '*/' : /<!--/.test(opener) ? '-->' : null;
	// A continuation line inside a jsdoc block (`* <keyword> …`) strips to the same
	// shape with no opener of its own. Nothing is extended from there, which
	// under-covers rather than over-covers.
	if (close === null || stripped.includes(close)) return [];
	const LIMIT = 40;
	for (let j = i + 1; j < lines.length && j - i <= LIMIT; j++) {
		const cont = lines[j];
		if (cont === undefined) break;
		if (cont.includes(close)) return Array.from({ length: j - i }, (_, k) => i + k + 2);
	}
	return [];
}

export function makeSuppressionParser({
	keyword,
	blanket = [],
	aliases = [],
}: SuppressionConfig): (text: string, relPath: string) => Suppressions {
	// A read alias mutes exactly as the active keyword does: an unrecognized
	// directive is not read as a directive at all, and that silence is the one
	// outcome a reason someone wrote down must never have.
	//
	// Which terms are offered is `normalize`'s call. The invariant enforced here is
	// that an alias never outranks this config's own blanket list — it widens what
	// may be *written*, never what a directive is allowed to do.
	const heads = [keyword, ...aliases.filter((a) => a !== keyword && !blanket.includes(a))];
	// Longest first, since alternation takes the first branch that matches and a
	// keyword that is a prefix of another would shadow it. The boundary is what
	// stops `ds-allowlist` reading as `ds-allow`.
	const alternation = (terms: readonly string[]): string =>
		[...new Set(terms)]
			.sort((a, b) => b.length - a.length)
			.map(escapeRe)
			.join('|');
	const keywordHead = `(${alternation(heads)})(?![\\w-])`;
	const IDS = `${ID}(?:\\s*,\\s*${ID})*`;
	// The reason may not be the comment terminator itself: `<kw> <ids> -- */` is
	// the missing-reason case wearing a directive's clothes, so it drops through
	// to `shaped`.
	const strict = new RegExp(`^${keywordHead}\\s+(${IDS})\\s*--\\s*(?!\\*/|-->|\\})(\\S.*?)(?:\\*/|-->|\\}|$)`);
	// A line with a directive's *shape* that `strict` rejected: the keyword alone,
	// or with rule ids, or with a separator and nothing usable after it. This is
	// the only route by which a read alias can produce a finding, and the shape is
	// what separates a broken directive from a sentence about one.
	const shaped = new RegExp(`^${keywordHead}\\s*(?:${IDS}\\s*)?(?:--|\\*/|-->|\\}|$)`);
	// The malformed gate: the vocabulary this config asks people to write, in any
	// shape at all, plus the blanket forms it names. A regex rather than
	// `startsWith` so it carries the same word boundary the heads do.
	const written = new RegExp(`^(?:${alternation([keyword, ...blanket])})(?![\\w-])`);
	// The cheap whole-line filter — everything that could reach either gate.
	const anyHead = [...heads, ...blanket];

	/**
	 * Logic, per line of the file:
	 *   the line contains no keyword at all                → prose, skipped cheaply
	 *   a keyword is not the first thing on it, once the
	 *   comment opener is stripped                         → prose, skipped
	 *   `<kw> <ruleIds> -- <reason>`, the reason being
	 *   something other than the comment terminator        → a directive: it mutes those
	 *                                                        rules on this line and on
	 *                                                        every line its comment spans
	 *   the line opens with the configured keyword or one
	 *   of the blanket forms, in any shape                 → suppression/malformed
	 *   it has a directive's shape — a keyword, optionally
	 *   rule ids, then a separator or the end of the
	 *   comment — but `strict` rejected it                 → suppression/malformed
	 *   otherwise, a sentence that merely opens with a
	 *   read alias                                         → prose, and mutes nothing
	 */
	return function scan(text: string, relPath: string): Suppressions {
		const byLine = new Map<number, Set<string>>();
		const owners = new Map<number, Directive[]>();
		const directives: Directive[] = [];
		const malformed: MalformedDirective[] = [];
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i];
			if (raw === undefined || !anyHead.some((p) => raw.includes(p))) continue;
			const stripped = raw.replace(OPENER, '');
			// Every gate below is `^`-anchored on a member of `anyHead`, so this is
			// output-identical and keeps prose that mentions a keyword off the regex.
			if (!anyHead.some((p) => stripped.startsWith(p))) continue; // prose, not a directive
			const line = i + 1;
			const m = stripped.match(strict);
			if (m?.[2] !== undefined && m[3] !== undefined) {
				const ids = m[2].split(',').map((s) => canonicalRuleId(s.trim()));
				const used = m[1] ?? keyword;
				// Flattened for the same reason the malformed branch below is: a tab in
				// the reason resets the columns `loupe suppressions` prints in.
				const directive: Directive = {
					file: relPath,
					line,
					rules: ids,
					reason: oneLine(m[3]),
					// Carried only when it is not the keyword the config asks for, so
					// `loupe suppressions` can name the rename.
					...(used === keyword ? {} : { alias: used }),
				};
				directives.push(directive);
				// A block comment covers every line it spans, not just the one the keyword
				// sits on. `isSuppressed` looks only at the finding's line and the one
				// above, so a directive whose comment closes two lines higher anchors to
				// nothing — and a formatter wraps a reason worth writing.
				for (const l of [line, ...spannedLines(lines, i, raw, stripped)]) {
					const set = byLine.get(l) ?? new Set<string>();
					for (const id of ids) set.add(id);
					byLine.set(l, set);
					owners.set(l, [...(owners.get(l) ?? []), directive]);
				}
			} else if (written.test(stripped) || shaped.test(stripped)) {
				malformed.push({
					rule: 'suppression/malformed',
					file: relPath,
					line,
					// Cut on the raw text, and by code point: this string is also the
					// finding's `code`, and `findingKey` collapses whitespace on `code`
					// itself, so flattening first would only move the 60-character window
					// and take every baseline key already written with it.
					message: head(stripped.trim(), 60),
				});
			}
		}
		return { byLine, owners, directives, malformed };
	};
}

/**
 * A finding at `line` is muted by a directive on that line or the one above —
 * the two natural spots for a trailing or leading comment. `scopeLines` lets a
 * CSS rule's selector line mute findings on its own declarations, so muting a
 * whole block doesn't require one comment per declaration (which is precisely
 * the friction that pushes people toward a blanket disable).
 */
export function isSuppressed(
	byLine: Map<number, Set<string>>,
	line: number,
	ruleId: string,
	scopeLines: readonly number[] = [],
): boolean {
	return mutingLine(byLine, line, ruleId, scopeLines) !== null;
}

/** The line whose directive mutes a finding, by the same lookup as `isSuppressed`; null if none does. */
export function mutingLine(
	byLine: Map<number, Set<string>>,
	line: number,
	ruleId: string,
	scopeLines: readonly number[] = [],
): number | null {
	for (const L of [line, line - 1, ...scopeLines]) {
		const s = byLine.get(L);
		if (s?.has(ruleId)) return L;
	}
	return null;
}

/**
 * Which rule ids of each directive muted something, for `Directive.stale`.
 *
 * Every finding a directive's line would have muted is credited to it — a
 * finding the rule is off for is never produced, so a directive for a disabled
 * rule reads as stale, which is what it is under that config.
 */
export class MuteLedger {
	private readonly used = new Map<Directive, Set<string>>();

	/** Mute `ruleId` at `line` if a directive covers it, crediting that directive. */
	mute(supp: Suppressions, line: number, ruleId: string, scopeLines: readonly number[] = []): boolean {
		const L = mutingLine(supp.byLine, line, ruleId, scopeLines);
		if (L === null) return false;
		for (const d of supp.owners.get(L) ?? [])
			if (d.rules.includes(ruleId)) this.used.set(d, (this.used.get(d) ?? new Set()).add(ruleId));
		return true;
	}

	/** Set `stale` on each directive naming a rule that muted nothing; `skip` names rules this run could not exercise. */
	settle(directives: readonly Directive[], skip: ReadonlySet<string> = new Set()): void {
		for (const d of directives) {
			const stale = d.rules.filter((r) => !skip.has(r) && !this.used.get(d)?.has(r));
			if (stale.length) d.stale = stale;
		}
	}
}
