/**
 * Snippet formatting.
 *
 * Findings quote source, and source is not obliged to be shaped like a report
 * line: a gradient, a `box-shadow` list and a multi-line `transition` all span
 * several lines, tabs and all. The agent format is one line per finding, and the
 * hook hands that same text back as blocking feedback.
 *
 * The guarantee is enforced at one choke point — the pass at the end of
 * `analyze` that every finding passes through — and not at each capture site,
 * which is where a *bound* would be wrong. Capture sites flatten (`oneLine`) or
 * bound one contributor to a composed message (`snippet`); only the finalize
 * pass bounds the line itself.
 *
 * Design notes: docs/design/report.md#bounding
 */

import { createHash } from 'node:crypto';

/** A hex SHA-256 of `text`: the one digest every key, fingerprint and stamp here is made from. */
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The message of an unknown throw. Anything can be thrown; only Errors carry a message. */
export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The first line of the same, for a message that has to fit on one — a parser
 * may reject with anything, a code frame included.
 */
export const messageLineOf = (err: unknown): string => messageOf(err).split('\n')[0] ?? 'parse failed';

/**
 * `messageLineOf` for a parse handed `{ from: abs }`. postcss opens a syntax error
 * with that path — `/home/alice/proj/a.css:1:1: Unclosed block` — and an
 * absolute path is a fact about the machine, not the project, so it does not
 * belong in a report another clone reads. The finding already names the file,
 * so only `line:column` is kept.
 */
export const parseMessageOf = (err: unknown, abs: string): string => {
	const message = messageLineOf(err);
	return message.startsWith(`${abs}:`) ? message.slice(abs.length + 1) : message;
};

/**
 * What a parse error says is wrong, without where: postcss's `reason`,
 * `Unclosed block`. A finding's `code` is part of its baseline key, and the
 * position moves whenever a line is added above it — so a code carrying it
 * matches no baseline after an unrelated edit, and the hook calls an error the
 * file already had a new one. Undefined for a throw that gives no reason, which
 * keeps its message.
 */
export const parseReasonOf = (err: unknown): string | undefined => {
	const reason = (err as { reason?: unknown } | null)?.reason;
	return typeof reason === 'string' && reason ? reason : undefined;
};

/** `s` as a literal inside a regex. */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every run of whitespace — newlines and tabs included — as a single space. */
const flatten = (text: string): string => text.replace(/\s+/g, ' ');

/** The same, trimmed: what a captured snippet gets. */
export const oneLine = (text: string): string => flatten(text).trim();

/**
 * Flattened and bounded. Sliced by code point rather than by UTF-16 unit:
 * `slice` splits a surrogate pair down the middle, and a lone surrogate is not
 * a character a strict JSON reader will accept.
 */
const clip = (text: string, max: number): string => {
	const line = oneLine(text);
	if (max <= 0) return '';
	// A string's UTF-16 length is never below its code-point count, so a short
	// one provably fits and never needs the array. That is the overwhelming
	// majority of calls, and the spread below is the expensive half.
	if (line.length <= max) return line;
	const chars = [...line];
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}\u2026` : line;
};

/**
 * The first `max` characters of a captured snippet, counted in code points and
 * taken *before* any flattening.
 *
 * Not `clip`: this bounds an identity rather than a display. No ellipsis, no
 * whitespace collapsing, because `findingKey` normalizes whitespace itself — so
 * flattening first would only move which characters survive the cut, and with
 * them every baseline entry written before the change.
 */
export const head = (text: string, max: number): string =>
	text.length <= max ? text : [...text].slice(0, max).join('');

/** Past this, a snippet is quoting the value rather than identifying it. */
const SNIPPET_MAX = 80;

/**
 * One captured snippet — a declaration, a selector. Bounds one *contributor* to
 * a message, so a single long value cannot spend the whole line on its own.
 */
export const snippet = (text: string): string => clip(text, SNIPPET_MAX);

/** A message may carry several snippets and a channel marker. Still one line. */
const MESSAGE_MAX = 200;

/** How much of the line a tail may claim before it is shortened in its turn. */
const TAIL_MAX = 100;

/**
 * `tail`, bounded from the FRONT so its end survives.
 *
 * The opposite end from `clip`, because a tail is read right-to-left: the
 * channel marker is last, and where a tail carries a selector the characters
 * telling two sibling selectors apart sit nearest it.
 */
const clipFront = (text: string, max: number): string => {
	const line = flatten(text);
	if (line.length <= max) return line;
	const chars = [...line];
	return chars.length > max ? `…${chars.slice(chars.length - (max - 1)).join('')}` : line;
};

/**
 * The whole of what a finding prints, bounded once everything has composed.
 *
 * `tail` is the part that must survive the cap rather than be eaten by it: the
 * channel marker, or the prose remedy on a rule whose message leads with an
 * unbounded signature. Neither is recoverable from the rest of the line.
 *
 * Surviving is not being unbounded, though — a tail carrying a selector is
 * source-derived too, so it is held to `TAIL_MAX`, shortened from the front, and
 * measured in code points, the same unit `clip` bounds the body in.
 */
export const messageLine = (body: string, tail = ''): string => {
	const end = clipFront(tail, TAIL_MAX);
	return clip(body, MESSAGE_MAX - [...end].length) + end;
};

/**
 * A composed message, bounded with its `tail` kept last: what the finalize pass
 * at the end of `analyze` does to every finding, and what `--judge` does again
 * to a message it recomposes after that pass.
 */
export const boundMessage = (message: string, tail = ''): string =>
	messageLine(tail && message.endsWith(tail) ? message.slice(0, -tail.length) : message, tail);

/** What separates one composed part of a message from the next. */
const JOIN = '; ';

/**
 * A message composed of several parts, bounded to the same line — by dropping
 * whole parts and counting them, not by cutting the last one in half.
 *
 * `messageLine` is right for a message that is one thing; a collapsed finding is
 * a list, and cutting a list at `MESSAGE_MAX` ends it mid-token and says nothing
 * about the parts that fell off the end.
 *
 * The tail is returned unbounded so the finalize pass can still recognise it as
 * the suffix it appended; the budget here is reckoned against what that pass
 * will shorten it to.
 */
export const messageParts = (parts: readonly string[], tail = ''): string => {
	const budget = MESSAGE_MAX - [...clipFront(tail, TAIL_MAX)].length;
	const pieces = parts.map(oneLine);
	const whole = pieces.join(JOIN);
	if ([...whole].length <= budget) return whole + tail;

	// Reserved before choosing what fits, so that choosing cannot change how much
	// room the count itself needs.
	const room = budget - ` (+${pieces.length} more)`.length;
	const kept: string[] = [];
	let used = 0;
	for (const p of pieces) {
		const cost = (kept.length ? JOIN.length : 0) + [...p].length;
		// The first part is kept whatever it costs — `clip` bounds it below — so
		// that a single over-long part still leaves a line that says something.
		if (kept.length && used + cost > room) break;
		kept.push(p);
		used += cost;
	}
	const dropped = pieces.length - kept.length;
	return `${clip(kept.join(JOIN), room)}${dropped ? ` (+${dropped} more)` : ''}${tail}`;
};
