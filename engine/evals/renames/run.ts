#!/usr/bin/env node
/**
 * Score the unknown-token question, `src/judge/token.ts`, against 158 names no
 * WPDS token defines, each set in a real declaration from `site-foundry/src` or
 * `gutenberg/packages` where a real token stood.
 *
 * Real code has almost none — Gutenberg's three are test fixtures — so the
 * names are made, in three kinds:
 *
 *   invented  the real token renamed the way an agent guesses at a system's
 *             vocabulary: `--wpds-color-text-muted`, `--wpds-spacing-lg`
 *   between   a size suffix typo'd one keystroke from two steps, `-xk` for
 *             `-xs`; the deterministic rename refuses these as a coin toss
 *   none      a name for what WPDS has no token for — a z-index, a shadow, a
 *             product colour — set over a real hardcoded declaration
 *
 * `labels.json` lists every token a careful reader would accept: the one that
 * stood there, plus any of its category with the same value, which the invented
 * name cannot tell apart. Candidates are worked out live by `renameOptions`, so a
 * change to them is scored by this. A name with no candidates is never asked,
 * which is right for a `none` and a coverage miss otherwise.
 *
 *   node evals/renames/run.ts          # three runs
 *   node evals/renames/run.ts 1        # one
 *
 * Design notes: docs/design/judge.md#the-evals
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, renameOptions, tokenDescriptions } from '../../src/judge.ts';
import { NONE, renameQuery } from '../../src/judge/token.ts';
import type { TokenSet } from '../../src/types.ts';
import { apiKey, pct, repeat, runCount, stability } from '../lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Item {
	id: string;
	kind: 'invented' | 'between' | 'none';
	file: string;
	line: number;
	prop: string;
	name: string;
	context_before: string;
	source: string;
}

const items = JSON.parse(readFileSync(join(HERE, 'items.json'), 'utf8')) as Item[];
const labels = JSON.parse(readFileSync(join(HERE, 'labels.json'), 'utf8')) as Record<string, string[]>;
// The same WPDS token set `evals/values` reads.
const tokens = JSON.parse(readFileSync(join(HERE, '..', 'values', 'tokens.json'), 'utf8')) as [string, string][];
const byValue = new Map<string, string[]>();
for (const [n, v] of tokens) byValue.set(v, [...(byValue.get(v) ?? []), n]);
const set: TokenSet = { known: new Set(tokens.map(([n]) => n)), byValue, sources: 1 };
const about = tokenDescriptions([
	{ tokenDescriptions: join(HERE, '..', '..', '..', 'profiles', 'wpds', 'token-descriptions.json') },
]);

const all = items.map((it) => ({ ...it, options: renameOptions(it.name, it.prop, set, about) }));
const asked = all.filter((it) => it.options.length);
const unasked = all.filter((it) => !it.options.length);

const label = (id: string): string[] => labels[id] ?? [];
const ok = (id: string, pick: string | undefined): boolean => pick !== undefined && label(id).includes(pick);
const covered = (it: (typeof all)[number]): boolean =>
	label(it.id).some((l) => l === NONE || it.options.some(([n]) => n === l));
const short = (t: string | undefined): string => (t ?? '—').replace(/^--wpds-(color-)?/, '');

const key = apiKey();

const nCovered = asked.filter(covered).length;
const unaskedNone = unasked.filter((it) => label(it.id).includes(NONE)).length;
process.stdout.write(
	`asked ${asked.length}/${all.length}; not asked ${unasked.length}, of them ${unaskedNone} labelled none (right to leave) and ${unasked.length - unaskedNone} a miss the candidates made\n`,
);
process.stdout.write(
	`coverage: a right answer was on offer for ${nCovered}/${asked.length} (${pct(nCovered, asked.length)}); options per question: median ${[...asked.map((it) => it.options.length)].sort((a, b) => a - b)[asked.length >> 1]}\n\n`,
);

const runs = await repeat(
	runCount(),
	() => ask(renameQuery, asked, key, fetch),
	(answers) => {
		const right = asked.filter((it, i) => ok(it.id, answers[i]?.choice)).length;
		const rightCovered = asked.filter((it, i) => covered(it) && ok(it.id, answers[i]?.choice)).length;
		return `all ${pct(right, asked.length)}, where coverable ${pct(rightCovered, nCovered)}`;
	},
);
stability(runs, asked.length, (i) => asked[i]?.id ?? '');

process.stdout.write('\nkind      asked  right  coverable\n');
for (const kind of ['invented', 'between', 'none'] as const) {
	const idx = asked.flatMap((it, i) => (it.kind === kind ? [i] : []));
	let right = 0;
	for (const r of runs) for (const i of idx) if (ok(asked[i]?.id ?? '', r[i]?.choice)) right++;
	const cov = idx.filter((i) => {
		const it = asked[i];
		return it && covered(it);
	}).length;
	process.stdout.write(
		`${kind.padEnd(9)} ${String(idx.length).padStart(5)}  ${pct(right, idx.length * runs.length).padStart(5)}  ${pct(cov, idx.length).padStart(9)}\n`,
	);
}

// A wrong rename repaints an element from a token that means something else,
// under a clean report; a wrong `none` only leaves a finding a reader would have
// had anyway. Scored as the check acts: under the floor, nothing is written.
process.stdout.write('\nfloor  acted  right  wrong-token  wrong-none  | between: acted wrong\n');
for (const floor of [0.5, 0.7, 0.8, 0.85, 0.9, 0.95]) {
	let acted = 0;
	let right = 0;
	let wrongToken = 0;
	let wrongNone = 0;
	let betweenActed = 0;
	let betweenWrong = 0;
	for (const r of runs)
		asked.forEach((it, i) => {
			const a = r[i];
			if (!a || a.confidence < floor) return;
			acted++;
			if (it.kind === 'between' && a.choice !== NONE) {
				betweenActed++;
				if (!ok(it.id, a.choice)) betweenWrong++;
			}
			if (ok(it.id, a.choice)) right++;
			else if (a.choice === NONE) wrongNone++;
			else wrongToken++;
		});
	const n = asked.length * runs.length;
	process.stdout.write(
		`${floor.toFixed(2)}  ${pct(acted, n).padStart(5)}  ${pct(right, acted).padStart(5)}  ${String(wrongToken).padStart(11)}  ${String(wrongNone).padStart(10)}  | ${String(betweenActed).padStart(14)} ${String(betweenWrong).padStart(5)}\n`,
	);
}

// Where it disagreed, so the labels stay auditable.
process.stdout.write('\ndisagreements (first run)\n');
const first = runs[0] ?? [];
asked.forEach((it, i) => {
	const a = first[i];
	if (ok(it.id, a?.choice)) return;
	const miss = covered(it) ? '' : ' [not on offer]';
	process.stdout.write(
		`  ${it.id} ${it.kind} ${it.prop}: ${short(it.name)} — judged ${short(a?.choice)} ${a ? a.confidence.toFixed(2) : ''}, labelled ${label(it.id).map(short).join(' | ')}${miss}\n`,
	);
});
