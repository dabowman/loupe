/**
 * Deterministic fixes.
 *
 * The engine already knows the answer for `tokens/hardcoded-value`: it read the
 * design system's own token definitions and matched the value on-role. Printing
 * that into prose and paying a model to read the file back and type the same
 * substitution is the expensive way to apply a change nobody had to reason
 * about — and it is the highest-volume rule in most reports, so it crowds out
 * the findings that do need judgement.
 *
 * Only the unambiguous case is applied. Two on-role tokens carrying the same
 * value is a semantic choice, and picking one by array order is exactly how you
 * get the right pixels with the wrong meaning — the failure the token
 * suggestion machinery exists to prevent.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Stylesheet channels only.
 *
 * The same rule fires on `style={{ padding: '13px' }}` and on CSS-in-JS
 * templates, where the surrounding syntax is JS and a CSS-shaped substitution
 * would write a syntax error with a clean report.
 */
const CSS_FILE = /\.(css|scss|sass|less|pcss|postcss)$/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The findings that carry one property, one value, and one token for it. */
export function tokenFixes(findings) {
	const out = [];
	for (const f of findings) {
		if (f.rule !== 'tokens/hardcoded-value' || !CSS_FILE.test(f.file)) continue;
		if (f.suggest?.length !== 1 || f.suggest[0].tokens.length !== 1) continue;
		const { prop, value, tokens } = f.suggest[0];
		out.push({ file: f.file, line: f.line, prop, value, token: tokens[0] });
	}
	return out;
}

/**
 * Rewrite each fix in place. Returns what was applied and what was left alone.
 *
 * A fix that cannot find its declaration exactly once on the line it was
 * reported at is skipped rather than guessed at: the file has moved under the
 * report, and a substitution against a stale line number edits the wrong
 * declaration.
 */
export function applyTokenFixes(root, findings, { dry = false } = {}) {
	const byFile = new Map();
	for (const fix of tokenFixes(findings)) {
		if (!byFile.has(fix.file)) byFile.set(fix.file, []);
		byFile.get(fix.file).push(fix);
	}

	const applied = [];
	const skipped = [];
	for (const [file, group] of byFile) {
		const abs = join(root, file);
		let text;
		try {
			text = readFileSync(abs, 'utf8');
		} catch (err) {
			for (const fix of group) skipped.push({ ...fix, why: err.message });
			continue;
		}
		const lines = text.split('\n');
		let dirty = false;
		for (const fix of group) {
			const i = fix.line - 1;
			// Re-read: two fixes can land on one line, and the second must see
			// what the first wrote.
			const line = lines[i];
			if (line === undefined) {
				skipped.push({ ...fix, why: 'line out of range' });
				continue;
			}
			// The property boundary matters: `background` must not match inside
			// `background-color`, and `border-radius` must not match inside
			// `-webkit-border-radius`. `!important` and the terminator are left
			// alone — only the value is replaced.
			const re = new RegExp(
				`(^|[;{\\s])(${escapeRe(fix.prop)}\\s*:\\s*)${escapeRe(fix.value.trim())}(?=\\s*(?:!important)?\\s*(?:[;}]|$))`,
				'gi'
			);
			const hits = line.match(re);
			if (hits?.length !== 1) {
				skipped.push({ ...fix, why: hits ? `${hits.length} matches on line` : 'declaration not on its reported line' });
				continue;
			}
			lines[i] = line.replace(re, `$1$2var(${fix.token})`);
			dirty = true;
			applied.push(fix);
		}
		if (dirty && !dry) writeFileSync(abs, lines.join('\n'));
	}
	return { applied, skipped };
}
