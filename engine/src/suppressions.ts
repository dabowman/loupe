/**
 * Suppression directives.
 *
 *   <keyword> system/override -- Stack exposes no padding prop
 *
 * where `<keyword>` is what the active preset asks for — `ds-allow` under
 * `generic`, `wpds-allow` under `wpds`. Rule id(s) and a reason are both
 * mandatory. Anything looser — a whole-file disable, a missing reason, a bare
 * keyword — is not a mute but its own violation (`suppression/malformed`),
 * which is the severity inversion that keeps the escape hatch honest.
 *
 * The directive must be the first thing in its comment. That is what stops the
 * checker flagging its own documentation: a line reading
 * `* Suppression: <keyword> <ids> -- <reason>` is prose about the grammar, not
 * an instance of it. Note the limit of that defence: an *indented* example
 * inside a doc comment is still first in its comment once the asterisks are
 * stripped, so a file that quotes the grammar verbatim under a scanned `src/`
 * is writing a live directive. Write it the way this comment does.
 *
 * The keyword is preset-scoped, so adopting a different preset renames it. Read
 * aliases are what keep that rename from orphaning the directives already
 * written: every keyword the engine knows *mutes*, whichever one the active
 * config asks people to write. What an alias does *not* widen is prose: a
 * comment that merely opens with another preset's keyword is left alone, while
 * one that carries a directive's shape — the keyword alone, or a reason
 * separator, or rule ids — reports as `suppression/malformed` exactly as it
 * would in the active keyword. Both halves are load-bearing. Prose must not
 * become an error, and a directive someone signed off must never go silent:
 * silence is the one outcome a written-down reason can never have.
 */

import { canonicalRuleId } from './rules.ts';
import type { Directive, MalformedDirective, SuppressionConfig, Suppressions } from './types.ts';

const ID = '(?:[A-Za-z][\\w-]*(?:/[\\w-]+)*)';
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Leading whitespace, jsdoc asterisks, then an optional comment opener.
const OPENER = /^[\s*]*(?:\/\/+|\/\*+|\{\/\*+|<!--|#+)?\s*/;

export function makeSuppressionParser({
	keyword,
	blanket = [],
	aliases = [],
}: SuppressionConfig): (text: string, relPath: string) => Suppressions {
	// A read alias mutes exactly as the active keyword does. An unrecognized
	// directive is not read as a directive at all — it neither suppresses nor
	// reports — and that silence is the one outcome a reason someone wrote down
	// must never have.
	//
	// Which terms are offered as aliases is `normalize`'s call: it is the only
	// place that can see every preset's vocabulary. What survives here is the
	// invariant this function can enforce on whatever it is handed — an alias
	// never outranks this config's own blanket list, so an alias widens what may
	// be *written*, never what a directive is allowed to do.
	const heads = [keyword, ...aliases.filter((a) => a !== keyword && !blanket.includes(a))];
	// Longest first: alternation takes the first branch that matches, so a
	// keyword that is a prefix of another would otherwise shadow it. The
	// boundary is what stops `ds-allowlist` reading as `ds-allow` wherever the
	// term is not already followed by mandatory whitespace — which is the
	// malformed gate below, not `strict`.
	const alternation = (terms: readonly string[]): string =>
		[...new Set(terms)].sort((a, b) => b.length - a.length).map(esc).join('|');
	const head = `(${alternation(heads)})(?![\\w-])`;
	const IDS = `${ID}(?:\\s*,\\s*${ID})*`;
	// The reason may not be the comment terminator itself: `<kw> <ids> -- */`
	// records `*/` as a signed-off reason and mutes, which is the missing-reason
	// case wearing a directive's clothes. Rejecting it here drops it through to
	// `shaped`, where it belongs.
	const strict = new RegExp(`^${head}\\s+(${IDS})\\s*--\\s*(?!\\*/|-->|\\})(\\S.*?)(?:\\*/|-->|\\}|$)`);
	// A line with a directive's *shape* that `strict` rejected: the keyword
	// alone, or with rule ids, or with a reason separator and nothing usable
	// after it. This is the only route by which a read alias can produce a
	// finding, and the shape is what separates `ds-allow tokens/hardcoded-value`
	// and `ds-allow -- Stack exposes no padding` (directives someone wrote and
	// broke) from `ds-allow is the old keyword, write wpds-allow` (a sentence
	// about one). Prose that merely opens with a keyword this config does not
	// ask for stays prose — the rename must not cost a clean repo its exit code
	// — but a broken directive must not go silent either, which is what happens
	// when the shape gate is narrower than the grammar it guards.
	const shaped = new RegExp(`^${head}\\s*(?:${IDS}\\s*)?(?:--|\\*/|-->|\\}|$)`);
	// The malformed gate: the vocabulary this config asks people to write, in
	// any shape at all, plus the blanket forms it names. A regex rather than
	// `startsWith` so it carries the same word boundary the heads do —
	// `ds-allowlist` and `ds-disabled` are other words, not this one written
	// badly, and `suppression/malformed` is an error in every preset.
	const written = new RegExp(`^(?:${alternation([keyword, ...blanket])})(?![\\w-])`);
	// The cheap whole-line filter — everything that could reach either gate.
	const anyHead = [...heads, ...blanket];

	return function scan(text: string, relPath: string): Suppressions {
		const byLine = new Map<number, Set<string>>();
		const directives: Directive[] = [];
		const malformed: MalformedDirective[] = [];
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i];
			if (raw === undefined || !anyHead.some((p) => raw.includes(p))) continue;
			const stripped = raw.replace(OPENER, '');
			// Every gate below is `^`-anchored on a member of `anyHead`, so this
			// is output-identical and keeps prose that merely mentions a keyword
			// from paying for a regex pass.
			if (!anyHead.some((p) => stripped.startsWith(p))) continue; // prose, not a directive
			const line = i + 1;
			const m = stripped.match(strict);
			if (m?.[2] !== undefined && m[3] !== undefined) {
				const ids = m[2].split(',').map((s) => canonicalRuleId(s.trim()));
				const used = m[1] ?? keyword;
				byLine.set(line, new Set(ids));
				directives.push({
					file: relPath,
					line,
					rules: ids,
					reason: m[3].trim(),
					// Carried only when it is not the keyword the config asks for, so
					// `loupe suppressions` can name the rename and nothing else has to.
					...(used === keyword ? {} : { alias: used }),
				});
			} else if (written.test(stripped) || shaped.test(stripped)) {
				malformed.push({
					rule: 'suppression/malformed',
					file: relPath,
					line,
					message: stripped.trim().slice(0, 60),
				});
			}
		}
		return { byLine, directives, malformed };
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
	for (const L of [line, line - 1, ...scopeLines]) {
		const s = byLine.get(L);
		if (s && s.has(ruleId)) return true;
	}
	return false;
}
