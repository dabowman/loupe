/**
 * Suppression directives.
 *
 *   ds-allow system/override -- Stack exposes no padding prop
 *
 * Rule id(s) and a reason are both mandatory. Anything looser — a whole-file
 * disable, a missing reason, a bare keyword — is not a mute but its own
 * violation (`suppression/malformed`), which is the severity inversion that
 * keeps the escape hatch honest.
 *
 * The directive must be the first thing in its comment. That is what stops the
 * checker flagging its own documentation: a line reading
 * `* Suppression: ds-allow <ids> -- <reason>` is prose about the grammar, not
 * an instance of it.
 *
 * The keyword is preset-scoped, so adopting a different preset renames it. Read
 * aliases are what keep that rename from orphaning the directives already
 * written: every keyword the engine knows mutes, whichever one the active
 * config asks people to write.
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
	// must never have. Blanket forms are left out on purpose: an alias widens
	// what may be *written*, never what a directive is allowed to do.
	const heads = [keyword, ...aliases.filter((a) => a !== keyword && !blanket.includes(a))];
	// Longest first: alternation takes the first branch that matches, so a
	// keyword that is a prefix of another would otherwise shadow it.
	const head = [...heads].sort((a, b) => b.length - a.length).map(esc).join('|');
	const strict = new RegExp(`^(${head})\\s+(${ID}(?:\\s*,\\s*${ID})*)\\s*--\\s*(\\S.*?)(?:\\*/|-->|\\}|$)`);
	const prefixes = [...heads, ...blanket];

	return function scan(text: string, relPath: string): Suppressions {
		const byLine = new Map<number, Set<string>>();
		const directives: Directive[] = [];
		const malformed: MalformedDirective[] = [];
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i];
			if (raw === undefined || !prefixes.some((p) => raw.includes(p))) continue;
			const stripped = raw.replace(OPENER, '');
			if (!prefixes.some((p) => stripped.startsWith(p))) continue; // prose, not a directive
			const line = i + 1;
			const m = stripped.match(strict);
			if (m?.[2] !== undefined && m[3] !== undefined) {
				const ids = m[2].split(',').map((s) => canonicalRuleId(s.trim()));
				byLine.set(line, new Set(ids));
				directives.push({
					file: relPath,
					line,
					rules: ids,
					reason: m[3].trim(),
					// Carried only when it is not the keyword the config asks for, so
					// `loupe suppressions` can name the rename and nothing else has to.
					...(m[1] !== undefined && m[1] !== keyword ? { alias: m[1] } : {}),
				});
			} else {
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
