/**
 * `tokens/undelivered`: the project uses the design system's tokens, and
 * nothing shows the stylesheet defining them ever reaches its pages.
 *
 * An undefined custom property makes its whole declaration invalid at
 * computed-value time: `background: var(--wpds-color-…)` does not fall back to
 * white, it drops, and the card renders transparent. Every token substitution
 * on such a page is dead, and a report full of correct `var()`s says nothing
 * about it. How a sheet is delivered is the design system's own fact — a
 * `wp_enqueue_style` dependency, a CSS import, a build plugin — so the profile
 * states what counts as evidence (`delivery.tokens.evidence`, see
 * `DeliveryCheck`) and this runs it. No language is parsed: each check is a
 * bounded, literal read of the files its globs name.
 *
 * Logic, once per project:
 *   no active profile declares a token delivery           → nothing
 *   no `var()` names a token in the delivery's namespace
 *   that the project's own stylesheets do not define      → nothing
 *   the first such reference is outside this run's scope  → nothing, unread
 *   any check finds its evidence                          → nothing: delivered
 *   any check cannot tell — a walk or a file over its
 *   bound, a dependency list that is not a literal        → nothing: unknown
 *   an `enqueue-dependency` check read every call it
 *   found and none names a handle                         → tokens/undelivered, at the
 *                                                           first reference
 *   otherwise — no enqueue to read at all                 → nothing: nothing shows this
 *                                                           project is the one that
 *                                                           delivers the sheet
 *
 * Build-time fallbacks (`delivery.tokens.fallbacks`) are not delivery. A
 * `var(--wpds-x, #fff)` written by the build renders, but at the default
 * theme's value whatever theme the site runs, so the tokens are doing nothing
 * a literal would not. Found, they change what the finding says, never whether
 * it reports.
 *
 * Fails safe throughout: the cost of a false "your tokens never load" is an
 * agent re-plumbing a stylesheet that worked.
 *
 * Design notes: docs/design/checks.md#tokensundelivered
 */

import { readFileSync, statSync } from 'node:fs';
import picomatch from 'picomatch';
import type { Candidate } from '../../analyze.ts';
import { byBytes, discover } from '../../discover.ts';
import type { DeliveryCheck, TokenDelivery } from '../../types.ts';
import type { TokenRef } from './unknown-token.ts';

/** What build-time fallbacks leave the page with. */
export const FALLBACKS = "fallbacks render but won't follow the theme";

/** Directory entries the evidence walk may look at before it gives up. */
const WALK_LIMIT = 50_000;
/** Files one run reads for evidence. A project past this is not guessed about. */
const FILE_LIMIT = 4_000;
/** Bytes per file; a bigger one is generated, and unread means unknown. */
const MAX_BYTES = 1_500_000;
/** Characters one call's argument list may run to before it is unreadable. */
const ARGS_MAX = 5_000;

type Verdict =
	| { state: 'delivered' }
	| { state: 'unknown' }
	/** An enqueue check that read every call: none names a handle. */
	| { state: 'missing'; calls: number; first: { file: string; line: number } }
	/** Nothing to say: no evidence, and nothing that makes its absence mean anything. */
	| { state: 'silent' };

/**
 * PHP with its comments blanked to spaces, newlines kept so offsets still give
 * lines. A commented-out enqueue is not one. Strings are kept whole, so a `//`
 * inside a URL survives; `#[` opens an attribute, not a comment.
 */
export function stripComments(text: string): string {
	// UTF-16 units, not code points: the offsets have to be `text`'s own.
	const out = text.split('');
	let quote: string | null = null;
	for (let i = 0; i < out.length; i++) {
		const c = out[i];
		if (quote) {
			if (c === '\\') i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			continue;
		}
		const next = out[i + 1];
		let stop: number;
		if ((c === '/' && next === '/') || (c === '#' && next !== '[')) stop = text.indexOf('\n', i);
		else if (c === '/' && next === '*') {
			const close = text.indexOf('*/', i + 2);
			stop = close === -1 ? -1 : close + 2;
		} else continue;
		// Unterminated: the comment runs to the end of the file.
		if (stop === -1) stop = out.length;
		for (let k = i; k < stop; k++) if (out[k] !== '\n') out[k] = ' ';
		i = stop - 1;
	}
	return out.join('');
}

/**
 * The top-level arguments of the call whose `(` is at `open`, or null when the
 * list does not close within {@link ARGS_MAX} characters.
 */
export function argumentsAt(text: string, open: number): string[] | null {
	const args: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let start = open + 1;
	const stop = Math.min(text.length, open + ARGS_MAX);
	for (let i = open + 1; i < stop; i++) {
		const c = text[i];
		if (quote) {
			if (c === '\\') i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === "'" || c === '"') quote = c;
		else if (c === '(' || c === '[' || c === '{') depth++;
		else if (c === ')' && depth === 0) {
			const last = text.slice(start, i).trim();
			if (last || args.length) args.push(last);
			return args;
		} else if (c === ')' || c === ']' || c === '}') depth--;
		else if (c === ',' && depth === 0) {
			args.push(text.slice(start, i).trim());
			start = i + 1;
		}
	}
	return null;
}

/**
 * The offset of the bracket closing the one at `open`, or -1 when it does not
 * close within {@link ARGS_MAX} characters. Quotes are honoured.
 */
function closingAt(text: string, open: number): number {
	let depth = 0;
	let quote: string | null = null;
	const stop = Math.min(text.length, open + ARGS_MAX);
	for (let i = open; i < stop; i++) {
		const c = text[i];
		if (quote) {
			if (c === '\\') i++;
			else if (c === quote) quote = null;
		} else if (c === "'" || c === '"') quote = c;
		else if (c === '(' || c === '[' || c === '{') depth++;
		else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return i;
	}
	return -1;
}

/** A quoted string with nothing interpolated into it, unquoted; else null. */
const literal = (arg: string): string | null => {
	const m = /^'((?:[^'\\]|\\.)*)'$|^"((?:[^"\\$]|\\.)*)"$/.exec(arg.trim());
	return m ? (m[1] ?? m[2] ?? '') : null;
};

/**
 * What a dependency argument says: the handles it names, and whether that is
 * all it could name. A literal `array( 'a', 'b' )` or `[ … ]` of strings is
 * complete; `$deps`, `array_merge( … )` or a list holding a variable is not.
 */
export function dependencyList(arg: string | undefined): { handles: string[]; complete: boolean } {
	if (arg === undefined || arg === '') return { handles: [], complete: true };
	const text = arg.trim();
	const named = [...text.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\$]|\\.)*)"/g)].map((m) => m[1] ?? m[2] ?? '');
	const open = /^array\s*\(/i.exec(text)?.[0].length ?? (text.startsWith('[') ? 1 : 0);
	// The list has to be the whole argument: `array( 'a' ) + deps()` ends in a
	// paren too, and names more than its literal half.
	const close = open ? closingAt(text, open - 1) : -1;
	if (close !== text.length - 1) return { handles: named, complete: false };
	const list = text.slice(open, close);
	const items = argumentsAt(`(${list})`, 0) ?? [];
	const complete = items.every((item) => item === '' || literal(item) !== null);
	return { handles: named, complete };
}

/** The argument at `index`, honouring a PHP 8 named `deps:` argument. */
function dependencyArgument(args: readonly string[], index: number): string | undefined {
	const named = args.find((a) => /^deps\s*:(?!:)/.test(a));
	if (named !== undefined) return named.replace(/^deps\s*:/, '').trim();
	const arg = args[index];
	return arg !== undefined && /^[A-Za-z_]\w*\s*:(?!:)/.test(arg) ? undefined : arg;
}

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split('\n').length;

function enqueueVerdict(
	check: Extract<DeliveryCheck, { kind: 'enqueue-dependency' }>,
	files: readonly { rel: string; text: string }[],
): Verdict {
	// Not a method (`->`, `::`) or a variable; a namespaced `\wp_enqueue_style(` is a call.
	const calls = new RegExp(`(?<![\\w$>:])(${check.calls.join('|')})\\s*\\(`, 'g');
	let seen = 0;
	let first: { file: string; line: number } | null = null;
	let unknown = false;
	for (const { rel, text } of files) {
		const code = stripComments(text);
		for (const m of code.matchAll(calls)) {
			// `function wp_enqueue_style(` is a definition, not a call.
			if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
			const args = argumentsAt(code, m.index + m[0].length - 1);
			seen++;
			first ??= { file: rel, line: lineAt(code, m.index) };
			if (!args) {
				unknown = true;
				continue;
			}
			const own = literal(args[0] ?? '');
			if (own !== null && check.enqueues.includes(String(m[1])) && check.handles.includes(own))
				return { state: 'delivered' };
			const deps = dependencyList(dependencyArgument(args, check.argument));
			if (deps.handles.some((h) => check.handles.includes(h))) return { state: 'delivered' };
			if (!deps.complete) unknown = true;
		}
	}
	if (unknown) return { state: 'unknown' };
	return first ? { state: 'missing', calls: seen, first } : { state: 'silent' };
}

/** `@import`, `@use`, `@forward`, `import … from`, side-effect `import`, `require`. */
const SPECIFIERS =
	/@(?:import|use|forward)\s+(?:url\(\s*)?['"]([^'"]+)['"]|\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]/g;

const withoutExt = (s: string): string => s.replace(/\.(?:s?css|sass|less)$/, '');

function importVerdict(check: Extract<DeliveryCheck, { kind: 'import' }>, files: readonly { text: string }[]): Verdict {
	const wanted = check.specifiers.map(withoutExt);
	for (const { text } of files)
		for (const m of text.matchAll(SPECIFIERS)) {
			const spec = withoutExt(String(m[1] ?? m[2] ?? m[3]).replace(/^~/, ''));
			if (wanted.some((w) => spec === w || spec.endsWith(`/${w}`))) return { state: 'delivered' };
		}
	return { state: 'silent' };
}

/** Every file the checks name, read once: one walk for all of them. */
function readEvidenceFiles(
	root: string,
	checks: readonly DeliveryCheck[],
	ignore: readonly string[],
): { rel: string; text: string }[] | null {
	const globs = [...new Set(checks.flatMap((c) => c.files))];
	const found = discover({
		root,
		sources: { styles: globs, markup: [], references: [], ignore: [...ignore] },
		limit: WALK_LIMIT,
	});
	if (found.truncated || found.styles.length > FILE_LIMIT) return null;
	const out: { rel: string; text: string }[] = [];
	for (const { abs, rel } of found.styles) {
		try {
			if (statSync(abs).size > MAX_BYTES) return null;
			out.push({ rel, text: readFileSync(abs, 'utf8') });
		} catch {
			return null;
		}
	}
	return out;
}

export function undelivered({
	root,
	ignore,
	tokens,
	refs,
	prefixes,
	projectDefined,
	reports,
}: {
	root: string;
	/** The config's ignore globs: what the project does not consider its own. */
	ignore: readonly string[];
	tokens: TokenDelivery | null;
	refs: readonly TokenRef[];
	/** The design system's own token prefixes, where the delivery names none. */
	prefixes: readonly string[];
	/** Tokens the project's own stylesheets define: those are delivered with them. */
	projectDefined: ReadonlySet<string>;
	reports: (file: string) => boolean;
}): Candidate[] {
	if (!tokens) return [];
	const namespace = tokens.prefixes.length ? tokens.prefixes : prefixes;
	if (!namespace.length) return [];
	const used = refs
		.filter((r) => namespace.some((p) => r.name.startsWith(p)) && !projectDefined.has(r.name))
		.sort((a, b) => byBytes(a.file, b.file) || a.line - b.line);
	const [anchor] = used;
	// The evidence walk is the expensive half, and its answer could only be
	// reported here.
	if (!anchor || !reports(anchor.file)) return [];

	const files = readEvidenceFiles(root, [...tokens.evidence, ...tokens.fallbacks], ignore);
	if (!files) return [];
	// `delivered` is "the check holds": for a fallback check, that fallbacks are written.
	const verdictOf = (check: DeliveryCheck): Verdict => {
		const mine = files.filter((f) => picomatch(check.files)(f.rel));
		if (check.kind === 'enqueue-dependency') return enqueueVerdict(check, mine);
		if (check.kind === 'import') return importVerdict(check, mine);
		return mine.some((f) => check.pattern.test(f.text)) ? { state: 'delivered' } : { state: 'silent' };
	};
	const verdicts = tokens.evidence.map(verdictOf);
	if (verdicts.some((v) => v.state === 'delivered' || v.state === 'unknown')) return [];
	const missing = verdicts.find((v): v is Extract<Verdict, { state: 'missing' }> => v.state === 'missing');
	if (!missing) return [];

	const target = tokens.handle ?? tokens.stylesheet;
	const fallbacks = tokens.fallbacks.some((check) => verdictOf(check).state === 'delivered');
	const users = new Set(used.map((r) => r.file)).size;
	const shown = namespace.map((p) => `${p}*`).join(', ');
	return [
		{
			rule: 'tokens/undelivered',
			file: anchor.file,
			line: anchor.line,
			message: `${shown} used in ${users} file(s); none of ${missing.calls} style enqueue(s) depends on ${target} (first: ${missing.first.file}:${missing.first.line})`,
			// One per project and delivery: the count and the first enqueue move with
			// every edit, and a baseline must not.
			code: `tokens/undelivered:${target}`,
			// The remedy, short enough to survive as the line's tail. The profile's
			// own prose on it is `loupe explain`'s to print, whole. With fallbacks
			// the page does render, so the note says why that is not enough, and
			// stays short enough for both clauses to survive the tail's bound.
			note: fallbacks
				? `${FALLBACKS}${tokens.handle ? `; add '${tokens.handle}' to this CSS's enqueue dependencies` : ''}`
				: tokens.handle
					? `list '${tokens.handle}' in the dependencies of the enqueue loading this CSS`
					: undefined,
			scopeLines: anchor.scopeLines,
		},
	];
}
