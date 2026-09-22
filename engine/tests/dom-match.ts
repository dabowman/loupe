#!/usr/bin/env node
/**
 * The matcher, and the two things about it that fail silently.
 *
 * It is a source string, not a module, so nothing type-checks it and nothing
 * imports it into a place a compiler would look. It reaches a page through two
 * different routes — spliced into `serve`'s client, and vendored into the
 * DevTools extension — and a mistake in either is invisible in exactly the same
 * way: the panel still loads, still lists findings, and highlights the wrong
 * elements or none.
 *
 * Two failures are specifically worth a test each.
 *
 * **Escaping.** The matcher lives inside a template literal, so every regex in
 * it is written one level up. `[\\w-]` in the source emits `[\w-]`; `[\\\\w-]`
 * emits `[\\w-]`, which is a character class of backslash, w and dash. Both
 * compile. Both run. The second silently strips `:hover` out of `.a:hovered`
 * and leaves `.aed` — a valid selector for an element that does not exist. That
 * mistake was made writing this file and caught here.
 *
 * **Drift.** The extension cannot fetch the matcher at runtime — Manifest V3
 * prohibits remote code — so it carries a generated copy. A copy a version
 * behind highlights against yesterday's rules and says nothing.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MATCH_JS, MATCH_VERSION } from '../src/dom-match.ts';
import { assert, check, finish } from './harness.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Pull a regex literal back out of the emitted source and compile it. */
function regexIn(pattern: RegExp, what: string): RegExp {
	const m = pattern.exec(MATCH_JS);
	assert(m?.[1], `the matcher no longer contains ${what}`);
	// biome-ignore lint/security/noGlobalEval: reading back the literal is the point — a copy would not be the shipped one.
	return eval(m[1]) as RegExp;
}

await check('the emitted source is parseable JavaScript', () => {
	// Not `eval`: this must not run, only parse. A matcher that throws on load
	// leaves `window.__loupeMatch` undefined and every caller reporting "not
	// connected", which reads as the server being down.
	new Function(MATCH_JS);
});

await check('a state pseudo-class is stripped whole, never half', () => {
	const STATE = regexIn(/var STATE = (\/.*?\/g);/, 'its state pseudo-class list');
	const cases: [string, string][] = [
		['.a:hover', '.a'],
		['.a:focus', '.a'],
		['.a:focus-visible', '.a'],
		['.a:focus-within', '.a'],
		// The one the escaping breaks. `:hover` is a prefix of `:hovered`, and a
		// lookahead over a mis-escaped class lets it match — leaving `.aed`.
		['.a:hovered', '.a:hovered'],
		['.a:focused', '.a:focused'],
		['.a:activех', '.a:activех'],
		// Not a state: it says what to match, not when.
		['.a:not(.x)', '.a:not(.x)'],
		['.a:nth-child(2)', '.a:nth-child(2)'],
	];
	for (const [input, want] of cases) {
		STATE.lastIndex = 0;
		const got = input.replace(STATE, '');
		assert(got === want, `${input} -> ${got}, wanted ${want}`);
	}
});

await check('a pseudo-element is stripped, with its argument', () => {
	const PE = regexIn(/replace\((\/::[^/]*\/g),/, 'its pseudo-element pattern');
	const cases: [string, string][] = [
		['.a::before', '.a'],
		['.a::after', '.a'],
		['.a::part(label)', '.a'],
		['.a::-webkit-scrollbar', '.a'],
		['.a', '.a'],
	];
	for (const [input, want] of cases) {
		PE.lastIndex = 0;
		const got = input.replace(PE, '');
		assert(got === want, `${input} -> ${got}, wanted ${want}`);
	}
});

await check('the split on whitespace is a whitespace class, not a literal backslash', () => {
	// `split(/\\s+/)` emits a class matching `\` or `s`, which turns a two-class
	// element into a tag label nobody can read. It only shows on the mark's tag,
	// which is the least likely thing anyone reports.
	const m = /\.split\((\/.*?\/)\)\.join/.exec(MATCH_JS);
	assert(m?.[1], 'the matcher no longer splits a class list');
	// biome-ignore lint/security/noGlobalEval: same reason as regexIn.
	const re = eval(m[1]) as RegExp;
	assert(
		JSON.stringify('a  b'.split(re)) === JSON.stringify(['a', 'b']),
		`split gave ${JSON.stringify('a  b'.split(re))}`,
	);
});

await check('the install is guarded, so a re-evaluation keeps the first one', () => {
	// A DevTools panel re-evaluates on every navigation and cannot know whether it
	// is the first. Without the guard, `load`ed findings are dropped on each one.
	assert(
		MATCH_JS.includes(`window.__loupeMatch && window.__loupeMatch.version === ${MATCH_VERSION}`),
		'the version guard is gone, or no longer names the exported version',
	);
});

await check('the API a reader depends on is all present', () => {
	// Named rather than inferred: these are the calls `serve.ts` splices in and
	// the extension evaluates by name, neither of which a compiler checks.
	for (const fn of [
		'load',
		'snapshot',
		'forElement',
		'highlight',
		'highlightElement',
		'clear',
		'teardown',
		'scrollTo',
		'domSelector',
	])
		assert(new RegExp(`\\b${fn}:`).test(MATCH_JS), `window.__loupeMatch.${fn} is gone`);
});

await check("loupe's own furniture is never a finding's target", () => {
	// The overlay's panel is a div with classes, in the page. Without this, every
	// broad selector reports one extra hit and outlines loupe outlining itself.
	assert(MATCH_JS.includes('data-loupe-marks'), 'the marks layer is not excluded');
	assert(MATCH_JS.includes('data-loupe-overlay'), "the overlay's host is not excluded");
});

await check('the extension carries this exact matcher, not one behind', () => {
	try {
		execFileSync('node', [join(REPO, 'browser', 'devtools', 'build.mjs'), '--check'], { stdio: 'pipe' });
	} catch (err) {
		const e = err as { stderr?: Buffer };
		throw new Error(String(e.stderr ?? err).trim());
	}
});

finish();
