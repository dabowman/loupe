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
 */

import { canonicalRuleId } from './rules.ts';
import { oneLine } from './text.ts';
import type { Directive, MalformedDirective, SuppressionConfig, Suppressions } from './types.ts';

const ID = '(?:[A-Za-z][\\w-]*(?:/[\\w-]+)*)';
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Leading whitespace, jsdoc asterisks, then an optional comment opener.
const OPENER = /^[\s*]*(?:\/\/+|\/\*+|\{\/\*+|<!--|#+)?\s*/;

export function makeSuppressionParser({
	keyword,
	blanket = [],
}: SuppressionConfig): (text: string, relPath: string) => Suppressions {
	const strict = new RegExp(`^${esc(keyword)}\\s+(${ID}(?:\\s*,\\s*${ID})*)\\s*--\\s*(\\S.*?)(?:\\*/|-->|\\}|$)`);
	const prefixes = [keyword, ...blanket];

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
			if (m?.[1] !== undefined && m[2] !== undefined) {
				const ids = m[1].split(',').map((s) => canonicalRuleId(s.trim()));
				byLine.set(line, new Set(ids));
				directives.push({ file: relPath, line, rules: ids, reason: m[2].trim() });
			} else {
				malformed.push({
					rule: 'suppression/malformed',
					file: relPath,
					line,
					// Flattened, not capped: a block comment's tab would otherwise
					// reset the indentation the report groups findings by, and this
					// also feeds `code`, where collapsing whitespace is what
					// `findingKey` already does.
					message: oneLine(stripped).slice(0, 60),
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
