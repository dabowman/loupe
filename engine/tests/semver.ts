#!/usr/bin/env node
/**
 * The version-range reader profile selection asks.
 *
 * A wrong answer here fails quietly in both directions: a profile written for
 * v2 selected on a v3 project hands an agent the old system's guidance, and one
 * left out on the project it describes takes its registries with it. Neither
 * shows up as an error, only as findings that are wrong or missing.
 */

import { overlaps, parseRange } from '../src/semver.ts';
import type { Range } from '../src/semver.ts';
import { assert, check, finish } from './harness.ts';

const range = (text: string): Range => {
	const r = parseRange(text);
	assert(r, `expected ${JSON.stringify(text)} to read as a range`);
	return r;
};

/** Does `version` satisfy `text`? An exact version is a range of one. */
const admits = (text: string, version: string): boolean => overlaps(range(text), range(version));

/** Every [range, version, admitted] row, with the row named on failure. */
function table(rows: readonly (readonly [string, string, boolean])[]): void {
	const wrong = rows.filter(([text, v, want]) => admits(text, v) !== want);
	assert(
		!wrong.length,
		wrong.map(([text, v, want]) => `${JSON.stringify(text)} should ${want ? '' : 'not '}admit ${v}`).join('; '),
	);
}

await check('comparators bound the versions they name', () => {
	table([
		['<3', '2.99.99', true],
		['<3', '3.0.0', false],
		['<=3', '3.9.0', true],
		['<=3', '4.0.0', false],
		['<=3.0.0', '3.0.0', true],
		['<=3.0.0', '3.0.1', false],
		['>2', '2.9.9', false],
		['>2', '3.0.0', true],
		['>2.3.4', '2.3.4', false],
		['>2.3.4', '2.3.5', true],
		['>=2.3', '2.3.0', true],
		['>=2.3', '2.2.9', false],
		['=1.2.3', '1.2.3', true],
		['=1.2.3', '1.2.4', false],
		['1.2.3', '1.2.3', true],
		['v1.2.3', '1.2.3', true],
		['1.2.3+build.5', '1.2.3', true],
	]);
});

await check('caret keeps the leftmost non-zero part', () => {
	table([
		['^2.3.0', '2.3.0', true],
		['^2.3.0', '2.99.0', true],
		['^2.3.0', '2.2.9', false],
		['^2.3.0', '3.0.0', false],
		['^0.2.3', '0.2.9', true],
		['^0.2.3', '0.3.0', false],
		['^0.0.3', '0.0.3', true],
		['^0.0.3', '0.0.4', false],
		['^0.0', '0.0.9', true],
		['^0.0', '0.1.0', false],
		['^1', '1.9.9', true],
		['^1', '2.0.0', false],
		['^0', '0.9.9', true],
		['^0', '1.0.0', false],
	]);
});

await check('tilde lets the patch move, or the minor when only a major is given', () => {
	table([
		['~1.2.3', '1.2.9', true],
		['~1.2.3', '1.3.0', false],
		['~1.2.3', '1.2.2', false],
		['~1.2', '1.2.0', true],
		['~1.2', '1.3.0', false],
		['~1', '1.9.0', true],
		['~1', '2.0.0', false],
		['~>1.2.3', '1.2.5', true],
	]);
});

await check('x, X and * stand for any value of their part', () => {
	table([
		['*', '0.0.1', true],
		['*', '99.0.0', true],
		['x', '3.1.4', true],
		['2.x', '2.5.0', true],
		['2.x', '3.0.0', false],
		['2.3.X', '2.3.7', true],
		['2.3.*', '2.4.0', false],
		['2', '2.0.0', true],
		['2', '3.0.0', false],
		['2.x.5', '2.9.0', true],
		['>=*', '1.0.0', true],
	]);
	assert(!overlaps(range('<*'), range('*')), '<* admits nothing');
	assert(!overlaps(range('>*'), range('*')), '>* admits nothing');
	assert(overlaps(range(''), range('1.0.0')), 'an empty range is any version');
});

await check('a space joins comparators that must all hold', () => {
	table([
		['>=2.3.0 <3', '2.5.0', true],
		['>=2.3.0 <3', '3.0.0', false],
		['>=2.3.0 <3', '2.2.0', false],
		['>= 2.3.0  < 3', '2.5.0', true],
		['^2 >=2.5', '2.4.0', false],
	]);
	assert(!overlaps(range('>=3 <2'), range('*')), 'a contradiction admits nothing');
});

await check('|| joins ranges of which any may hold', () => {
	table([
		['^1.0.0 || ^3.0.0', '1.5.0', true],
		['^1.0.0 || ^3.0.0', '2.5.0', false],
		['^1.0.0 || ^3.0.0', '3.1.0', true],
		['<1||>=4', '4.0.0', true],
	]);
});

await check('ranges overlap when some version is in both, not when one contains the other', () => {
	const pairs: [string, string, boolean][] = [
		['^2.3.0', '<3', true],
		['^3.0.0', '<3', false],
		['>=2.9.0', '<3', true],
		['>=3.0.0', '<3', false],
		['~2.9.0', '<3', true],
		['*', '<3', true],
		['^1.0.0 || ^3.0.0', '<3', true],
		['^3.0.0 || ^4.0.0', '<3', false],
		['>=2.0.0 <=3.0.0', '>=3.0.0', true],
		['>=2.0.0 <3.0.0', '>=3.0.0', false],
		['>2.0.0', '<=2.0.0', false],
	];
	const wrong = pairs.filter(
		([a, b, want]) => overlaps(range(a), range(b)) !== want || overlaps(range(b), range(a)) !== want,
	);
	assert(!wrong.length, wrong.map(([a, b, want]) => `${a} and ${b} should ${want ? '' : 'not '}overlap`).join('; '));
});

await check('prereleases sort below their release, and a partial bound excludes the next one’s', () => {
	table([
		['<3', '3.0.0-beta.1', false],
		['<3.0.0', '2.9.9-rc.1', true],
		['>=1.2.3-alpha', '1.2.3-beta', true],
		['>=1.2.3-beta', '1.2.3-alpha', false],
		['>=1.2.3-alpha.2', '1.2.3-alpha.10', true],
		['>=1.2.3-alpha.1', '1.2.3-alpha', false],
		['<1.2.3-alpha', '1.2.3-1', true],
		['^3.0.0-beta.1', '3.0.0', true],
	]);
	assert(!overlaps(range('^3.0.0-beta.1'), range('<3')), 'a v3 prerelease is not inside <3');
});

await check('what is not a range reads as null, for the caller to decide', () => {
	for (const text of [
		'workspace:*',
		'workspace:^1.2.0',
		'latest',
		'next',
		'github:acme/ui#main',
		'git+https://github.com/acme/ui.git',
		'file:../ui',
		'npm:@acme/ui@^2',
		'1.2.3 - 2.3.4',
		'1.2-beta',
		'^1.2.3.4',
		'1 | 2',
	])
		assert(parseRange(text) === null, `${JSON.stringify(text)} should not read as a range`);
});

finish();
