/**
 * Terminal colour.
 *
 * Off by default, on only when a human is provably watching. Every other
 * consumer of this output is a machine that reads the bytes: the hook hands its
 * report back to the agent, `--format json|sarif` is parsed, `--format html` is
 * redirected to a file, and a CI log is a file too. An escape sequence in any
 * of those is corruption — which is why the bash wrapper this CLI replaced had
 * to strip ANSI in the first place, and why that stripping is not coming back.
 *
 * `process.stdout` is the one stream consulted, even for the stderr sites: a
 * run whose stdout is a pipe is a run being consumed, and the cost of guessing
 * wrong in that direction is only a colourless error message.
 */

import type { Severity } from './types.ts';

// An empty variable is an unset one. Every shell that has ever exported
// `FORCE_COLOR=` to clear it means "not set", and reading it as "set to
// something that is not 0" turns clearing the switch into throwing it.
const { NO_COLOR, FORCE_COLOR, TERM } = process.env;

let enabled = NO_COLOR
	? false
	: FORCE_COLOR
		? FORCE_COLOR !== '0'
		: Boolean(process.stdout.isTTY) && TERM !== 'dumb';

/** Hook mode, whose stdout may be a terminal but whose reader never is. */
export const setColor = (on: boolean): void => {
	enabled = on;
};

/**
 * One SGR pair. Never nest these: the inner reset ends the outer style too, so
 * a colour covers a whole fragment or none of it.
 */
const paint =
	(code: string) =>
	(text: string): string =>
		enabled ? `\u001B[${code}m${text}\u001B[0m` : text;

export const bold = paint('1');
export const dim = paint('2');
export const red = paint('31');
export const green = paint('32');
export const yellow = paint('33');
export const magenta = paint('35');
export const cyan = paint('36');

/**
 * What the palette means, so a reader learns it once:
 *
 *   magenta  a rule id
 *   cyan     a design-system component, or a CLI option
 *   dim      a location, a label, or anything the eye should skip
 *   red/yellow/green  severity, and whether a run is in trouble
 *
 * Three surfaces name rules and two name components, and a reader who has
 * learned the colour in the report has learned it in `status` and `explain`.
 */

/**
 * Severity's colour, in one place.
 *
 * The report and `status` both say what a rule will do, in different words, and
 * a reader who has learned that red blocks in one of them has learned it for
 * the other. Two independent maps is how that stops being true.
 */
export const SEV_PAINT: Record<Severity, (s: string) => string> = {
	error: red,
	warn: yellow,
	off: dim,
};
