/**
 * Terminal colour.
 *
 * Off by default, on only when a human is provably watching — every other
 * consumer of this output is a machine that reads the bytes, and an escape
 * sequence in any of them is corruption.
 *
 * `process.stdout` is the one stream consulted, even for the stderr sites: a run
 * whose stdout is a pipe is a run being consumed.
 *
 * Design notes: docs/design/cli.md#colour-is-off-unless-a-human-is-provably-watching
 */

import type { Severity } from './types.ts';

// An empty variable is an unset one: every shell that exports `FORCE_COLOR=` to
// clear it means "not set".
const { NO_COLOR, FORCE_COLOR, TERM } = process.env;

let enabled = NO_COLOR ? false : FORCE_COLOR ? FORCE_COLOR !== '0' : Boolean(process.stdout.isTTY) && TERM !== 'dumb';

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
 *   green    inside a finding, what a model judged (`check --judge`) rather
 *            than what the parse found
 */

/**
 * Severity's colour, in one place: the report and `status` both say what a rule
 * will do, in different words, and two independent maps is how a reader's
 * learned association stops being true.
 */
export const SEV_PAINT: Record<Severity, (s: string) => string> = {
	error: red,
	warn: yellow,
	off: dim,
};
