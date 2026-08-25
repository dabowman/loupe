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
 * These live in their own module because the flattening belongs where a
 * snippet is *captured*: the classifier in `analyze.ts`, the suppression
 * parser, and `fix`'s report of what it skipped. Anything that only the agent
 * formatter honours is not a guarantee `--format json` or SARIF can rely on.
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
	const chars = [...line];
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}\u2026` : line;
};

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

/**
 * The whole of what a finding prints, bounded once everything has composed.
 *
 * `tail` is the part that must survive the cap rather than be eaten by it —
 * the marker naming which of the three channels the finding came from, which
 * is not something a reader can recover from the rest of the line. The body
 * keeps at least a snippet's worth of room whatever the tail costs.
 */
export const messageLine = (body: string, tail = ''): string =>
	clip(body, Math.max(MESSAGE_MAX - tail.length, SNIPPET_MAX)) + flatten(tail);
