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

import { canonicalRuleId } from './rules.mjs';

const ID = '(?:[A-Za-z][\\w-]*(?:/[\\w-]+)*)';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Leading whitespace, jsdoc asterisks, then an optional comment opener.
const OPENER = /^[\s*]*(?:\/\/+|\/\*+|\{\/\*+|<!--|#+)?\s*/;

export function makeSuppressionParser({ keyword, blanket = [] }) {
	const strict = new RegExp(`^${esc(keyword)}\\s+(${ID}(?:\\s*,\\s*${ID})*)\\s*--\\s*(\\S.*?)(?:\\*/|-->|\\}|$)`);
	const prefixes = [keyword, ...blanket];

	/**
	 * @returns {{ byLine: Map<number,Set<string>>, directives: Array, malformed: Array }}
	 */
	return function scan(text, relPath) {
		const byLine = new Map();
		const directives = [];
		const malformed = [];
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i];
			if (!prefixes.some((p) => raw.includes(p))) continue;
			const stripped = raw.replace(OPENER, '');
			if (!prefixes.some((p) => stripped.startsWith(p))) continue; // prose, not a directive
			const line = i + 1;
			const m = stripped.match(strict);
			if (m) {
				const ids = m[1].split(',').map((s) => canonicalRuleId(s.trim()));
				byLine.set(line, new Set(ids));
				directives.push({ file: relPath, line, rules: ids, reason: m[2].trim() });
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
export function isSuppressed(byLine, line, ruleId, scopeLines = []) {
	for (const L of [line, line - 1, ...scopeLines]) {
		const s = byLine.get(L);
		if (s && s.has(ruleId)) return true;
	}
	return false;
}
