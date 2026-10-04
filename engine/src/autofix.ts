/**
 * Deterministic fixes.
 *
 * The engine already knows the answer wherever a value matched the design
 * system's own token definitions on-role. Every rule that flags a substitutable
 * declaration arrives carrying one `suggest` entry per declaration, and that
 * entry is the licence to substitute — nothing here needs a list of which rules
 * they are. A `rename` is the same licence for a name nothing defines, written
 * by the check that already holds the known token set.
 *
 * Only the unambiguous case is applied: two on-role tokens carrying the same
 * value is a semantic choice, not an array lookup, and a misspelling one
 * keystroke from two real tokens is a question, not a typo.
 *
 * Design notes: docs/design/report.md#fixing
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { byBytes } from './discover.ts';
import { DELIBERATE, KEEP } from './tokens.ts';
import { escapeRe, messageLineOf } from './text.ts';
import type { Directive, FixCandidate, KeptValue, SkippedFix, SkippedKeep, Suggestion, TokenFix } from './types.ts';

/**
 * Where a suppression comment can be written. A kept value outside a stylesheet
 * is reported rather than suppressed: the comment syntax differs by channel, and
 * a comment line above a JSX element is not a comment at all — it is rendered
 * text.
 */
export const CSS_FILE = /\.(css|scss|sass|less|pcss|postcss)$/i;

/**
 * Every declaration with one rewrite for it: a single exact token, or — only
 * once `--judge` has written one — the judged replacement. Plus every line of a
 * token name the check settled on a single near miss for.
 *
 * A finding may be several declarations, each matched against its own line.
 * Where a declaration is one of several on-role tokens, or none, it is left
 * alone and its finding stays standing.
 */
export function tokenFixes(findings: readonly FixCandidate[]): TokenFix[] {
	const out: TokenFix[] = [];
	for (const f of findings) {
		// `suggest` is the licence: an entry is a declaration whose value a token could
		// stand in for.
		for (const s of f.suggest ?? []) {
			// The exact token first: `--judge` is never asked about a declaration
			// code already settled, so at most one of these is ever there.
			const to = s.tokens.length === 1 ? `var(${s.tokens[0]})` : s.judged?.answer;
			if (to === undefined || to === KEEP) continue;
			out.push({ file: f.file, line: s.line ?? f.line, prop: s.prop, value: s.value, to, span: s.span });
		}
		// A misspelled token is one finding across every line the file names it on.
		// Fixing only the line it was reported at would leave the rest broken and
		// the next run would report the same name again.
		const rename = f.rename;
		if (rename) for (const line of rename.lines) out.push({ file: f.file, line, value: rename.from, to: rename.to });
	}
	return out;
}

/**
 * How many findings every one of their declarations was settled for — what `fix`
 * actually cleared, as against how many declarations it acted on.
 *
 * Settled is rewritten or suppressed: a value `--judge` kept is as done with as
 * one it replaced. A renamed token is settled only once every line naming it
 * was rewritten, for the same reason: the name is still wrong on the rest.
 *
 * The key is file, line and property. A rename has no property and takes the
 * empty slot, which nothing else can occupy — every declaration a fix or a keep
 * names came out of a parse, and a parse has no nameless property.
 */
export function settledBy(
	findings: readonly FixCandidate[],
	applied: readonly TokenFix[],
	kept: readonly KeptValue[] = [],
): number {
	const at = (d: { file: string; line: number; prop?: string | undefined }): string =>
		`${d.file}\u0000${d.line}\u0000${d.prop ?? ''}`;
	const done = new Set([...applied, ...kept].map(at));
	return findings.filter((f) => {
		const parts = f.rename
			? f.rename.lines.map((line) => ({ file: f.file, line }))
			: (f.suggest ?? (f.decl ? [f.decl] : [])).map((s) => ({ file: f.file, line: s.line ?? f.line, prop: s.prop }));
		return parts.length > 0 && parts.every((p) => done.has(at(p)));
	}).length;
}

/** The quotes a JSX style value can already be written in, and keeps. */
const QUOTES = '\'"`';

/**
 * One declaration rewritten on the line it sits on — or one token name renamed
 * there — or why it was not.
 *
 * Shared by `loupe fix` and the language server's quick fix, so the two cannot
 * write different bytes for one finding.
 *
 * Three ways in. A stylesheet declaration and a CSS-in-JS one are both matched
 * as text: what is inside the template is literal CSS, and a declaration whose
 * value comes from an interpolation never reaches here — the parse drops it. A
 * JSX style object is spliced at the span the scan recorded, because the
 * declaration it was reported as appears nowhere in the file. A rename carries
 * no property and is matched inside `var()` instead.
 *
 * Any of the three, a fix that cannot locate its target exactly is refused
 * rather than guessed at: the file has moved under the report, and a
 * substitution against a stale line or column edits the wrong bytes.
 */
export function substituteOnLine(
	line: string,
	fix: Pick<TokenFix, 'prop' | 'value' | 'to' | 'span'>,
): string | { why: string } {
	const span = fix.span;
	if (span) {
		if (line.slice(span.col, span.col + span.text.length) !== span.text)
			return { why: 'the value is no longer where it was reported' };
		// A substitution is `var(--token)`, or several beside words kept from the
		// value they replace. One carrying a quote, a backslash or a template hole
		// would have to be escaped to survive as a JS string, and a fix that has to
		// escape its way in is refused instead of written.
		if (/['"`\\]|\$\{/.test(fix.to)) return { why: 'replacement is not writable as a JS string' };
		// The quote the value was already written in, so the file keeps its own
		// style. A bare number has none and takes the codebase default.
		const opener = span.text[0];
		const quote = opener && QUOTES.includes(opener) ? opener : "'";
		return `${line.slice(0, span.col)}${quote}${fix.to}${quote}${line.slice(span.col + span.text.length)}`;
	}
	// A rename has no property around it. It replaces the name inside `var()`,
	// every time this line names it — the same name is the same misspelling
	// wherever it stands, so several on a line is not the ambiguity several
	// declarations would be. Only inside `var()`, so `--name: …` keeps defining
	// whatever it defines, and bounded on the right so `--space` does not match
	// inside `--space-lg`.
	if (fix.prop === undefined) {
		const renamed = line.replace(new RegExp(`(var\\(\\s*)${escapeRe(fix.value)}(?![-\\w])`, 'g'), `$1${fix.to}`);
		if (renamed === line) return { why: 'the token is not on its reported line' };
		return renamed;
	}
	// The property boundary matters: `background` must not match inside
	// `background-color`, and `border-radius` must not match inside
	// `-webkit-border-radius`. A backtick bounds a declaration the way a brace
	// does, for the CSS-in-JS template written on one line. `!important` and the
	// terminator are left alone — only the value is replaced.
	const re = new RegExp(
		`(^|[;{\\s\`])(${escapeRe(fix.prop)}\\s*:\\s*)${escapeRe(fix.value.trim())}(?=\\s*(?:!important)?\\s*(?:[;}\`]|$))`,
		'gi',
	);
	const hits = line.match(re);
	if (hits?.length !== 1)
		return { why: hits ? `${hits.length} matches on line` : 'declaration not on its reported line' };
	return line.replace(re, `$1$2${fix.to}`);
}

/**
 * Rewrite each fix in place. Returns what was applied and what was left alone.
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
			const why = messageLineOf(err);
			for (const fix of group) skipped.push({ ...fix, why });
			continue;
		}
		const lines = text.split('\n');
		let dirty = false;
		// Right to left within a line, so a splice never moves a span still to
		// come. A matched declaration finds itself wherever it has ended up, so
		// the order costs it nothing.
		for (const fix of [...group].sort((a, b) => b.line - a.line || (b.span?.col ?? 0) - (a.span?.col ?? 0))) {
			const i = fix.line - 1;
			// Re-read: two fixes can land on one line, and the second must see
			// what the first wrote.
			const line = lines[i];
			if (line === undefined) {
				skipped.push({ ...fix, why: 'line out of range' });
				continue;
			}
			const rewritten = substituteOnLine(line, fix);
			if (typeof rewritten !== 'string') {
				skipped.push({ ...fix, why: rewritten.why });
				continue;
			}
			lines[i] = rewritten;
			dirty = true;
			applied.push(fix);
		}
		if (dirty && !dry) writeFileSync(abs, lines.join('\n'));
	}
	// Reported in reading order, whatever order they had to be written in.
	applied.sort((a, b) => byBytes(a.file, b.file) || a.line - b.line);
	return { applied, skipped };
}

/**
 * Write a suppression above each value `--judge` kept. Returns what was written
 * and what was left alone.
 *
 * A directive mutes its whole next line, so one is written only where every
 * flagged value on that line was kept. Nor above a rule's opening line, where a
 * directive covers the whole rule, nor between an existing directive and the
 * line it is for.
 *
 * It names every rule the kept declarations on that line were reported under,
 * which is not always one: a minified stylesheet can put a kept colour and a
 * kept font-weight on the same line. The reason is what the keep was settled
 * with.
 *
 * Only a keep whose reason is a fact is written: no token for the property in
 * the design system at all. One the model judged {@link DELIBERATE} is left
 * for review, since what the value is — the reason a suppression should give —
 * is not something the judgement says.
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
	const deliberate = (s: Suggestion): boolean => s.judged?.spans[0] === DELIBERATE;
	for (const { f, s: decl, line } of all) {
		if (decl.judged?.answer !== KEEP) continue;
		const kept: KeptValue = {
			file: f.file,
			line,
			prop: decl.prop,
			value: decl.value,
			reason: decl.judged.spans.join(' '),
		};
		if (deliberate(decl))
			skipped.push({ ...kept, why: 'judged deliberate — suppress it by hand, saying what the value is' });
		else if (!CSS_FILE.test(f.file)) skipped.push({ ...kept, why: 'not a stylesheet' });
		// A value left for review mutes nothing, so it cannot share a directive's line.
		else if (onLine.get(`${f.file}\u0000${line}`)?.some((o) => o.s.judged?.answer !== KEEP || deliberate(o.s)))
			skipped.push({ ...kept, why: 'shares its line with a value that is not suppressed' });
		else byFile.set(f.file, [...(byFile.get(f.file) ?? []), kept]);
	}

	const applied: KeptValue[] = [];
	for (const [file, group] of byFile) {
		const abs = join(root, file);
		let text: string;
		try {
			text = readFileSync(abs, 'utf8');
		} catch (err) {
			const why = messageLineOf(err);
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
