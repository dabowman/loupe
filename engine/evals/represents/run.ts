#!/usr/bin/env node
/**
 * Score the `represents` question against 100 hand-labelled controls from
 * `gutenberg/packages/{editor,edit-site}` and `site-foundry/src`, extracted once
 * and committed so this reproduces without either checkout.
 *
 * Deliberately outside `npm test`: it costs tokens, needs a key, and a model is
 * allowed to drift in ways a build should not fail on.
 *
 * `labels.json` is `[answer, ambiguous]` — the 13 flagged ambiguous are ones a
 * careful reader could defend either way, and the headline number is reported
 * with and without them. The question is the one `check --judge` sends, so
 * editing the vocabulary or `src/judge/force.ts` is what this scores.
 *
 *   node evals/represents/run.ts        # three runs
 *   node evals/represents/run.ts 1      # one
 *   node evals/represents/run.ts 1 --batch 10   # sweep the batch size
 *
 * Design notes: docs/design/judge.md#the-evals
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGE, ask } from '../../src/judge.ts';
import { forceQuery } from '../../src/judge/force.ts';
import type { Control } from '../../src/types.ts';
import { apiKey, pct, repeat, runCount, stability } from '../lib.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLASSES = ['value', 'command', 'destination', 'none'] as const;
type Represents = (typeof CLASSES)[number];

interface Row extends Pick<Control, 'file' | 'line' | 'component' | 'enclosing' | 'source'> {
	id: string;
}

const represents = LANGUAGE.vocabulary.forces.represents?.judge;
if (!represents) throw new Error('patterns/index.json gives `represents` no judge block');

const controls = JSON.parse(readFileSync(join(HERE, 'controls.json'), 'utf8')) as Row[];
const labels = JSON.parse(readFileSync(join(HERE, 'labels.json'), 'utf8')) as Record<string, [Represents, 0 | 1]>;

const truth = (id: string): Represents => labels[id]?.[0] ?? 'none';
const ambiguous = (id: string): boolean => labels[id]?.[1] === 1;
const key = apiKey();
const flag = process.argv.indexOf('--batch');
const size = flag === -1 ? undefined : Number(process.argv[flag + 1]);
const runs = await repeat(
	runCount(flag + 1),
	() => ask(forceQuery(represents), controls, key, fetch, size),
	(answers) => {
		let ok = 0;
		let okCertain = 0;
		let nCertain = 0;
		controls.forEach((c, i) => {
			const hit = answers[i]?.choice === truth(c.id);
			if (hit) ok++;
			if (!ambiguous(c.id)) {
				nCertain++;
				if (hit) okCertain++;
			}
		});
		return `all ${pct(ok, controls.length)}, unambiguous ${pct(okCertain, nCertain)}`;
	},
);

const baseline = controls.filter((c) => truth(c.id) === 'command').length;
process.stdout.write(`\nmajority-class baseline: ${pct(baseline, controls.length)} (always "command")\n`);

stability(runs, controls.length, (i, picks) => {
	const id = controls[i]?.id ?? '';
	return `${id} ${picks.join('/')} (labelled ${truth(id)})`;
});

// Per class. `destination` is the one that matters: every redirect in the
// abstract language fires on it, so a false positive sends an agent to the
// wrong pattern entirely.
process.stdout.write('\nclass         precision  recall\n');
for (const cls of CLASSES) {
	let tp = 0;
	let fp = 0;
	let fn = 0;
	runs.forEach((answers) => {
		controls.forEach((c, i) => {
			const picked = answers[i]?.choice === cls;
			const is = truth(c.id) === cls;
			if (picked && is) tp++;
			else if (picked) fp++;
			else if (is) fn++;
		});
	});
	if (tp + fn === 0) continue;
	process.stdout.write(
		`${cls.padEnd(13)} ${pct(tp, tp + fp).padStart(9)}  ${pct(tp, tp + fn).padStart(6)}  (tp${tp} fp${fp} fn${fn})\n`,
	);
}

// Calibration: does confidence mean anything? Only useful if a high band is
// clean enough to act on without asking a person.
process.stdout.write('\nconfidence band   items  correct\n');
for (const [name, lo, hi] of [
	['>0.90', 0.9, 1.01],
	['0.50–0.90', 0.5, 0.9],
	['<0.50', 0, 0.5],
] as const) {
	let n = 0;
	let ok = 0;
	runs.forEach((answers) => {
		controls.forEach((c, i) => {
			const a = answers[i];
			if (!a || a.confidence < lo || a.confidence >= hi) return;
			n++;
			if (a.choice === truth(c.id)) ok++;
		});
	});
	process.stdout.write(`${name.padEnd(17)} ${String(n).padStart(5)}  ${pct(ok, n).padStart(7)}\n`);
}

// The same bands per picked class. A redirect acts on one class, so its floor
// is that class's precision under the floor, not the whole question's.
process.stdout.write('\npicked as       >=0.90 right   <0.90 right\n');
for (const cls of CLASSES) {
	const cell = (hi: boolean): string => {
		let n = 0;
		let ok = 0;
		runs.forEach((answers) => {
			controls.forEach((c, i) => {
				const a = answers[i];
				if (a?.choice !== cls || a.confidence >= 0.9 !== hi) return;
				n++;
				if (truth(c.id) === cls) ok++;
			});
		});
		return `${ok}/${n}`.padStart(8);
	};
	process.stdout.write(`${cls.padEnd(13)} ${cell(true)}      ${cell(false)}\n`);
}

// Where it disagreed, so the labels stay auditable: on a real disagreement the
// label is as likely to be wrong as the model.
process.stdout.write('\ndisagreements on unambiguous controls (first run)\n');
const first = runs[0] ?? [];
let shown = 0;
controls.forEach((c, i) => {
	const a = first[i];
	if (ambiguous(c.id) || !a || a.choice === truth(c.id)) return;
	shown++;
	process.stdout.write(
		`  ${c.id} ${c.component} — labelled "${truth(c.id)}", judged "${a.choice}" (${a.confidence.toFixed(2)})  ${c.file}:${c.line}\n`,
	);
});
if (!shown) process.stdout.write('  none\n');
