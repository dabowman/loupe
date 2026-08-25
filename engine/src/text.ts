/**
 * Snippet formatting.
 *
 * Findings quote source, and source is not obliged to be shaped like a report
 * line: a gradient, a `box-shadow` list, a `grid-template-areas` map and a
 * multi-line `transition` all span several lines, tabs and all. The agent
 * format is one line per finding and uses indentation to group findings under
 * a rule, so a quoted value carried through verbatim breaks it — and the hook
 * hands that same text back as blocking feedback.
 *
 * The guarantee is enforced at one choke point — the pass at the end of
 * `analyze` that every finding passes through, whatever channel produced it —
 * and not at each capture site. Capture sites are where a *bound* would be
 * wrong: `code` is a finding's identity, the baseline keys on it, and a cap
 * applied before the dedupe folds two distinct declarations into one finding.
 * So captures flatten (`oneLine`) or bound one contributor to a composed
 * message (`snippet`); only the finalize pass bounds the line itself.
 *
 * It lives in `analyze` rather than in a formatter because anything only the
 * agent formatter honours is not a guarantee `--format json` or SARIF can rely
 * on.
 */

/** Every run of whitespace — newlines and tabs included — as a single space. */
const flatten = (text: string): string => text.replace(/\s+/g, ' ');

/** The same, trimmed: what a captured snippet gets. */
export const oneLine = (text: string): string => flatten(text).trim();

/**
 * Flattened and bounded.
 *
 * Sliced by code point rather than by UTF-16 unit: `slice` splits a surrogate
 * pair straight down the middle, and a lone surrogate is not a character a
 * strict JSON reader will accept — which would trade a broken report line for
 * a payload SARIF consumers reject outright.
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
 * Not `clip`: this bounds an identity rather than a display. It adds no ellipsis
 * and collapses no whitespace, because `findingKey` normalizes whitespace
 * itself — so flattening first would only change which characters survive the
 * cut, and with them every baseline entry written before the change. Code
 * points because a cut landing mid-surrogate-pair is the one thing both
 * truncations here must never do.
 */
export const head = (text: string, max: number): string =>
	text.length <= max ? text : [...text].slice(0, max).join('');

/** Past this, a snippet is quoting the value rather than identifying it. */
const SNIPPET_MAX = 80;

/**
 * One captured snippet — a declaration, a selector.
 *
 * Bounds one *contributor* to a message, so a single long value cannot spend
 * the whole line on its own.
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
 * channel marker is last, and where a tail also carries a selector the
 * characters that tell two sibling selectors apart — a BEM suffix, a hash, an
 * index — are the ones nearest it. Cutting the other end would throw away
 * exactly the part worth keeping.
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
 * marker naming which of the three channels the finding came from, or the prose
 * remedy on a rule whose message leads with an unbounded source-derived
 * signature. Neither is recoverable from the rest of the line.
 *
 * Surviving is not the same as being unbounded, though — a tail carrying a
 * selector is source-derived too, and left to itself would spend the line the
 * body is supposed to get. It is held to `TAIL_MAX` and shortened from the
 * front, and it is measured in code points, the same unit `clip` bounds the
 * body in: budgeting in UTF-16 units would let one astral character in the tail
 * cost the body two. The sum is `MESSAGE_MAX` whatever the split.
 */
export const messageLine = (body: string, tail = ''): string => {
	const end = clipFront(tail, TAIL_MAX);
	return clip(body, MESSAGE_MAX - [...end].length) + end;
};

/** What separates one composed part of a message from the next. */
const JOIN = '; ';

/**
 * A message composed of several parts, bounded to the same line — by dropping
 * whole parts and counting them, not by cutting the last one in half.
 *
 * `messageLine` is right for a message that is one thing; a collapsed finding is
 * a list. Cutting a list at `MESSAGE_MAX` ends it mid-token — `letter-spacing:
 * 0.02em → v…` — which is a remedy the reader cannot act on, and says nothing
 * about the parts that fell off the end entirely. Whole parts and a count is the
 * shape `suggestionFor` already uses for the tokens it could not name, and it is
 * the difference between a reader who knows to go and look and one who does not
 * know there is anything to look for.
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
