/**
 * Deterministic fixes.
 *
 * The engine already knows the answer wherever a value matched the design
 * system's own token definitions on-role. Every rule that flags a declaration
 * arrives carrying one `suggest` entry per declaration — `tokens/hardcoded-value`
 * and `typography/untokenized` both — and that entry is the licence to
 * substitute, so nothing here needs a list of which rules they are. Printing that
 * into prose and paying a model to read the file back and type the same
 * substitution is the expensive way to apply a change nobody had to reason
 * about — and they are the highest-volume rules in most reports, so they crowd
 * out the findings that do need judgement.
 *
 * Only the unambiguous case is applied. Two on-role tokens carrying the same
 * value is a semantic choice, and picking one by array order is exactly how you
 * get the right pixels with the wrong meaning — the failure the token
 * suggestion machinery exists to prevent.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { byBytes } from './discover.ts';
import { KEEP } from './tokens.ts';
import { escapeRe } from './text.ts';
import type { Directive, FixCandidate, KeptValue, SkippedFix, SkippedKeep, TokenFix } from './types.ts';

/**
 * Stylesheet channels only.
 *
 * The same rule fires on `style={{ padding: '13px' }}` and on CSS-in-JS
 * templates, where the surrounding syntax is JS and a CSS-shaped substitution
 * would write a syntax error with a clean report.
 */
export const CSS_FILE = /\.(css|scss|sass|less|pcss|postcss)$/i;

/**
 * Every declaration with one rewrite for it: a single exact token, or — only
 * once `--judge` has written one — the judged replacement.
 *
 * A finding may be several declarations. `typography/untokenized` collapses a
 * CSS rule's type block into one finding, and `font-size: 12px` there is as
 * unambiguous as it is on its own; each is matched against its own line. Where
 * a declaration is one of several on-role tokens, or none, it is left alone and
 * its finding stays standing — which is why the caller counts findings cleared
 * rather than fixes applied.
 */
function tokenFixes(findings: readonly FixCandidate[]): TokenFix[] {
	const out: TokenFix[] = [];
	for (const f of findings) {
		// `suggest` is the licence: an entry is a declaration whose value a token
		// could stand in for, which is the same thing a list of which rules those
		// are would have said, only said once and by the finding itself.
		if (!CSS_FILE.test(f.file)) continue;
		for (const s of f.suggest ?? []) {
			// The exact token first: `--judge` is never asked about a declaration
			// code already settled, so at most one of these is ever there.
			const to = s.tokens.length === 1 ? `var(${s.tokens[0]})` : s.judged?.answer;
			if (to === undefined || to === KEEP) continue;
			out.push({ file: f.file, line: s.line ?? f.line, prop: s.prop, value: s.value, to });
		}
	}
	return out;
}

/**
 * How many findings every one of their declarations was settled for — what
 * `fix` actually cleared, as against how many declarations it acted on. A
 * finding holding one settled declaration and one nobody could settle is still
 * there, so it is still counted as left for review.
 *
 * Settled is rewritten or suppressed: a value `--judge` kept is as done with as
 * one it replaced, and the finding it came from will not be reported again.
 */
export function settledBy(
	findings: readonly FixCandidate[],
	applied: readonly TokenFix[],
	kept: readonly KeptValue[] = [],
): number {
	const at = (d: { file: string; line: number; prop: string }): string => `${d.file}\u0000${d.line}\u0000${d.prop}`;
	const done = new Set([...applied, ...kept].map(at));
	return findings.filter((f) => {
		const parts = f.suggest ?? (f.decl ? [f.decl] : []);
		return parts.length > 0 && parts.every((s) => done.has(at({ file: f.file, line: s.line ?? f.line, prop: s.prop })));
	}).length;
}

/**
 * Rewrite each fix in place. Returns what was applied and what was left alone.
 *
 * A fix that cannot find its declaration exactly once on the line it was
 * reported at is skipped rather than guessed at: the file has moved under the
 * report, and a substitution against a stale line number edits the wrong
 * declaration.
 */
export function applyTokenFixes(
	root: string,
	findings: readonly FixCandidate[],
	{ dry = false }: { dry?: boolean } = {},
): { applied: TokenFix[]; skipped: SkippedFix[] } {
	const byFile = new Map<string, TokenFix[]>();
	for (const fix of tokenFixes(findings)) {
		const group = byFile.get(fix.file) ?? [];
		group.push(fix);
		byFile.set(fix.file, group);
	}

	const applied: TokenFix[] = [];
	const skipped: SkippedFix[] = [];
	for (const [file, group] of byFile) {
		const abs = join(root, file);
		let text: string;
		try {
			text = readFileSync(abs, 'utf8');
		} catch (err) {
			const why = err instanceof Error ? err.message : String(err);
			for (const fix of group) skipped.push({ ...fix, why });
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
				'gi',
			);
			const hits = line.match(re);
			if (hits?.length !== 1) {
				skipped.push({ ...fix, why: hits ? `${hits.length} matches on line` : 'declaration not on its reported line' });
				continue;
			}
			lines[i] = line.replace(re, `$1$2${fix.to}`);
			dirty = true;
			applied.push(fix);
		}
		if (dirty && !dry) writeFileSync(abs, lines.join('\n'));
	}
	return { applied, skipped };
}

/**
 * Write a suppression above each value `--judge` kept. Returns what was
 * written and what was left alone.
 *
 * A directive mutes its whole next line, so one is written only where every
 * flagged value on that line was kept: muting a line that also carries a
 * value nobody settled would hide it along with the one that was. Nor above a
 * rule's opening line, where a directive covers the whole rule, nor between an
 * existing directive and the line it is for. The reason is
 * what the judgement said, so the comment records that a model made the call,
 * not a person.
 *
 * The directive names the rules the kept declarations on that line were
 * reported under, which is not always one: a minified stylesheet can put a kept
 * colour and a kept font-weight on the same line, and a directive naming only
 * the first leaves the second reported under a comment that claims to cover it.
 */
export function applyKeeps(
	root: string,
	findings: readonly FixCandidate[],
	keyword: string,
	{ dry = false, directives = [] }: { dry?: boolean; directives?: readonly Pick<Directive, 'file' | 'line'>[] } = {},
): { applied: KeptValue[]; skipped: SkippedKeep[] } {
	const taken = new Set(directives.map((d) => `${d.file}\u0000${d.line}`));
	// One entry per flagged declaration, at the line it is actually written on:
	// a collapsed finding is a whole CSS rule, and its parts are not all on the
	// line it was reported at.
	const all = findings.flatMap((f) => (f.suggest ?? []).map((s) => ({ f, s, line: s.line ?? f.line })));
	const onLine = new Map<string, typeof all>();
	for (const d of all) {
		const k = `${d.f.file}\u0000${d.line}`;
		onLine.set(k, [...(onLine.get(k) ?? []), d]);
	}
	// Which rules a line's directive has to name, so it covers everything it mutes.
	const rulesOn = new Map(
		[...onLine].map(([k, group]) => [k, [...new Set(group.map((d) => d.f.rule))].sort().join(',')]),
	);
	const byFile = new Map<string, KeptValue[]>();
	const skipped: SkippedKeep[] = [];
	for (const { f, s: decl, line } of all) {
		if (decl.judged?.answer !== KEEP) continue;
		const kept: KeptValue = {
			file: f.file,
			line,
			prop: decl.prop,
			value: decl.value,
			reason: decl.judged.spans.join(' '),
		};
		if (!CSS_FILE.test(f.file)) skipped.push({ ...kept, why: 'not a stylesheet' });
		else if (onLine.get(`${f.file}\u0000${line}`)?.some((o) => o.s.judged?.answer !== KEEP))
			skipped.push({ ...kept, why: 'shares its line with a value that was not kept' });
		else byFile.set(f.file, [...(byFile.get(f.file) ?? []), kept]);
	}

	const applied: KeptValue[] = [];
	for (const [file, group] of byFile) {
		const abs = join(root, file);
		let text: string;
		try {
			text = readFileSync(abs, 'utf8');
		} catch (err) {
			const why = err instanceof Error ? err.message : String(err);
			for (const k of group) skipped.push({ ...k, why });
			continue;
		}
		const lines = text.split('\n');
		let last = 0;
		// Bottom up, so an inserted line never moves one still to come.
		for (const k of [...group].sort((a, b) => b.line - a.line)) {
			// One directive per line, however many values on it were kept.
			if (k.line === last) {
				applied.push(k);
				continue;
			}
			const line = lines[k.line - 1];
			if (line === undefined) {
				skipped.push({ ...k, why: 'line out of range' });
				continue;
			}
			// Only the nearest line above is read: a directive already there for
			// this line would be pushed off it, and what it names would come back.
			if (taken.has(`${file}\u0000${k.line - 1}`)) {
				skipped.push({ ...k, why: 'the line above already carries a directive — add the rule to it by hand' });
				continue;
			}
			// A brace that opens a rule, not Sass's `#{…}` interpolation.
			if (/(?:^|[^#])\{/.test(line)) {
				skipped.push({ ...k, why: "on the rule's opening line, where a directive would mute the whole rule" });
				continue;
			}
			// Spaces and tabs only: `\s` would copy a byte-order mark onto the
			// directive. And the line's own ending, so a CRLF file stays one.
			const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
			const eol = line.endsWith('\r') ? '\r' : '';
			// Whichever rules that line was reported under, not just this one's.
			const rules = rulesOn.get(`${file}\u0000${k.line}`) ?? 'tokens/hardcoded-value';
			lines.splice(k.line - 1, 0, `${indent}/* ${keyword} ${rules} -- ${k.reason} */${eol}`);
			applied.push(k);
			last = k.line;
		}
		if (last && !dry) writeFileSync(abs, lines.join('\n'));
	}
	applied.sort((a, b) => byBytes(a.file, b.file) || a.line - b.line);
	return { applied, skipped };
}
