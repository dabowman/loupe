#!/usr/bin/env node
/**
 * Score the hardcoded-value question, `src/judge/value.ts`, against 145
 * hand-labelled literals from `vip-digital-asset-manager` — an un-remediated
 * WPDS plugin whose stylesheets were written against the wp-admin palette, so
 * nearly none of its values are exactly a WPDS token and most are close to one.
 *
 * Extracted once and committed, so this reproduces without the checkout.
 * `tokens.json` is that token set; candidates are worked out here, live, by
 * `candidatesFor`, so a change to how they are narrowed is scored by this.
 *
 * `labels.json` lists every answer a careful reader would accept, so "right" is
 * "one of those" — and an item whose right answer was not among the candidates
 * is a miss the narrowing made, counted separately as coverage.
 *
 *   node evals/values/run.ts          # three runs
 *   node evals/values/run.ts 1        # one
 *   node evals/values/run.ts --bare   # without the token descriptions
 *
 * Design notes: docs/design/judge.md#the-evals
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, tokenDescriptions } from '../../src/judge.ts';
import { valueQuery } from '../../src/judge/value.ts';
import { KEEP, candidatesFor } from '../../src/tokens.ts';
import type { Candidates } from '../../src/tokens.ts';
import type { TokenSet } from '../../src/types.ts';
import { apiKey, pct, repeat, runCount, stability } from '../lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Item {
	id: string;
	file: string;
	line: number;
	prop: string;
	value: string;
	part: string;
	context_before: string;
	source: string;
}

const items = JSON.parse(readFileSync(join(HERE, 'items.json'), 'utf8')) as Item[];
const labels = JSON.parse(readFileSync(join(HERE, 'labels.json'), 'utf8')) as Record<string, string[]>;
const tokens = JSON.parse(readFileSync(join(HERE, 'tokens.json'), 'utf8')) as [string, string][];

const byValue = new Map<string, string[]>();
for (const [n, v] of tokens) byValue.set(v, [...(byValue.get(v) ?? []), n]);
const set: TokenSet = { known: new Set(tokens.map(([n]) => n)), byValue, sources: 1 };

const asked = items.flatMap((it) => {
	const candidates = candidatesFor(set, it.prop, it.part);
	return candidates ? [{ ...it, candidates }] : [];
});
if (asked.length !== items.length)
	process.stderr.write(`eval: ${items.length - asked.length} item(s) no longer have candidates\n`);

const ok = (id: string, pick: string | undefined): boolean => pick !== undefined && (labels[id] ?? []).includes(pick);
const covered = (id: string, c: Candidates): boolean =>
	(labels[id] ?? []).some((l) => (l === KEEP ? c.keep : c.options.some(([n]) => n === l)));
const short = (t: string | undefined): string => (t ?? '—').replace(/^--wpds-(color-)?/, '');

const key = apiKey();

const nCovered = asked.filter((it) => covered(it.id, it.candidates)).length;
process.stdout.write(
	`coverage: a right answer was on offer for ${nCovered}/${asked.length} (${pct(nCovered, asked.length)})\n\n`,
);

// The WPDS profile's token descriptions, as `check --judge` sends them.
// `--bare` asks with names and values alone — the ablation that justified
// shipping them (docs/design/judge.md#which-token).
const about = process.argv.includes('--bare')
	? new Map<string, string>()
	: tokenDescriptions([
			{ tokenDescriptions: join(HERE, '..', '..', '..', 'profiles', 'wpds', 'token-descriptions.json') },
		]);
const runs = await repeat(
	runCount(),
	() => ask(valueQuery(about), asked, key, fetch),
	(answers) => {
		const right = asked.filter((it, i) => ok(it.id, answers[i]?.choice)).length;
		const rightCovered = asked.filter((it, i) => covered(it.id, it.candidates) && ok(it.id, answers[i]?.choice)).length;
		return `all ${pct(right, asked.length)}, where coverable ${pct(rightCovered, nCovered)}`;
	},
);
stability(runs, asked.length, (i) => asked[i]?.id ?? '');

// By tier: whether narrowing to the close tokens helps, and where the model
// earns its keep — the `family` tier is the design judgement.
process.stdout.write('\ntier     items  right  coverable\n');
for (const tier of ['exact', 'near', 'end', 'family'] as const) {
	const idx = asked.flatMap((it, i) => (it.candidates.tier === tier ? [i] : []));
	let right = 0;
	for (const r of runs) for (const i of idx) if (ok(asked[i]?.id ?? '', r[i]?.choice)) right++;
	const cov = idx.filter((i) => {
		const it = asked[i];
		return it && covered(it.id, it.candidates);
	}).length;
	process.stdout.write(
		`${tier.padEnd(8)} ${String(idx.length).padStart(5)}  ${pct(right, idx.length * runs.length).padStart(5)}  ${pct(cov, idx.length).padStart(9)}\n`,
	);
}

// The two ways to be wrong cost differently: a wrong token changes the design, a
// wrong keep leaves a mistake for review labelled deliberate (`fix --judge` no
// longer suppresses it). An answer over the floor counts as acted on either way.
process.stdout.write('\nfloor  acted  right  wrong-token  wrong-keep\n');
for (const floor of [0.5, 0.7, 0.8, 0.9]) {
	let acted = 0;
	let right = 0;
	let wrongToken = 0;
	let wrongKeep = 0;
	for (const r of runs)
		asked.forEach((it, i) => {
			const a = r[i];
			if (!a || (a.confidence < floor && it.candidates.keep)) return;
			acted++;
			if (ok(it.id, a.choice)) right++;
			else if (a.choice === KEEP) wrongKeep++;
			else wrongToken++;
		});
	const n = asked.length * runs.length;
	process.stdout.write(
		`${floor.toFixed(2)}  ${pct(acted, n).padStart(5)}  ${pct(right, acted).padStart(5)}  ${String(wrongToken).padStart(11)}  ${String(wrongKeep).padStart(10)}\n`,
	);
}

// The keep axis on its own: of the literals that can only be kept (scrims,
// pills, a CSS triangle), how many were; and of the keeps, how many were
// allowed.
let keepOnly = 0;
let keptWhenOnly = 0;
let keeps = 0;
let keepsAllowed = 0;
for (const r of runs)
	asked.forEach((it, i) => {
		const l = labels[it.id] ?? [];
		if (l.length === 1 && l[0] === KEEP) {
			keepOnly++;
			if (r[i]?.choice === KEEP) keptWhenOnly++;
		}
		if (r[i]?.choice === KEEP) {
			keeps++;
			if (l.includes(KEEP)) keepsAllowed++;
		}
	});
process.stdout.write(
	`\nkeep: recall on keep-only items ${pct(keptWhenOnly, keepOnly)}, precision ${pct(keepsAllowed, keeps)} (${keeps} keeps)\n`,
);

// Where it disagreed, so the labels stay auditable: on a real disagreement the
// label is as likely to be wrong as the model.
process.stdout.write('\ndisagreements (first run)\n');
const first = runs[0] ?? [];
asked.forEach((it, i) => {
	const a = first[i];
	if (ok(it.id, a?.choice)) return;
	const miss = covered(it.id, it.candidates) ? '' : ' [not on offer]';
	process.stdout.write(
		`  ${it.id} ${it.prop}: ${it.part} (${it.candidates.tier}) — judged ${short(a?.choice)} ${a ? a.confidence.toFixed(2) : ''}, labelled ${(labels[it.id] ?? []).map(short).join(' | ')}${miss}\n`,
	);
});
