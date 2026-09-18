#!/usr/bin/env node
/**
 * Score the `represents` question against 100 hand-labelled controls.
 *
 * This is the half a stub test cannot cover. `tests/features.ts` pins what gets
 * asked and what gets written; this pins whether the answers are any good, which
 * only a live model and labelled code can say. It is deliberately outside
 * `npm test`: it costs tokens, needs a key, and a model is allowed to drift in
 * ways a build should not fail on.
 *
 * The controls come from `gutenberg/packages/{editor,edit-site}` and
 * `site-foundry/src`, extracted once and committed, so the eval reproduces
 * without either checkout. `labels.json` is `[answer, ambiguous]` — the 13
 * flagged ambiguous are ones a careful reader could defend either way, and the
 * headline number is reported with and without them.
 *
 * The question is the one `check --judge` sends: `represents` as the vocabulary
 * in `patterns/index.json` words it, framed by `src/judge/force.ts`, one control
 * per request. Edit the wording in either and this scores the edit.
 *
 *   npx tsx evals/represents/run.ts        # three runs
 *   npx tsx evals/represents/run.ts 1      # one
 *   npx tsx evals/represents/run.ts 1 --batch 10   # sweep the batch size
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL, ask, loadLanguage } from '../../src/judge.ts';
import { forceQuery } from '../../src/judge/force.ts';
import type { Choice } from '../../src/judge.ts';
import type { Control } from '../../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLASSES = ['value', 'command', 'destination', 'none'] as const;
type Represents = (typeof CLASSES)[number];

interface Row extends Pick<Control, 'file' | 'line' | 'component' | 'enclosing' | 'source'> {
	id: string;
}

const represents = loadLanguage().vocabulary.forces['represents']?.judge;
if (!represents) throw new Error('patterns/index.json gives `represents` no judge block');

const controls = JSON.parse(readFileSync(join(HERE, 'controls.json'), 'utf8')) as Row[];
const labels = JSON.parse(readFileSync(join(HERE, 'labels.json'), 'utf8')) as Record<string, [Represents, 0 | 1]>;

const truth = (id: string): Represents => labels[id]?.[0] ?? 'none';
const ambiguous = (id: string): boolean => labels[id]?.[1] === 1;
const pct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(0)}%` : '—');

try {
	if (!process.env.TYPESAFE_API_KEY) process.loadEnvFile?.(join(HERE, '..', '..', '..', '.env'));
} catch {
	/* no .env beside the checkout is the ordinary case */
}
const key = process.env.TYPESAFE_API_KEY;
if (!key) {
	process.stderr.write(`eval: needs TYPESAFE_API_KEY, in the environment or ${join(HERE, '..', '..', '..', '.env')}\n`);
	process.exit(2);
}

const flag = process.argv.indexOf('--batch');
const size = flag === -1 ? undefined : Number(process.argv[flag + 1]);
const times = Number(process.argv.find((a, i) => i >= 2 && /^\d+$/.test(a) && i !== flag + 1) ?? 3);
process.stdout.write(`model: ${MODEL}\n`);
const runs: (Choice | undefined)[][] = [];
for (let r = 1; r <= times; r++) {
	const started = Date.now();
	const answers = await ask(forceQuery(represents), controls, key, fetch, size);
	runs.push(answers);
	const got = answers.filter((a) => a).length;
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
	process.stdout.write(
		`run ${r}: ${got}/${controls.length} answered in ${((Date.now() - started) / 1000).toFixed(1)}s — ` +
			`all ${pct(ok, controls.length)}, unambiguous ${pct(okCertain, nCertain)}\n`,
	);
}

const baseline = controls.filter((c) => truth(c.id) === 'command').length;
process.stdout.write(`\nmajority-class baseline: ${pct(baseline, controls.length)} (always "command")\n`);

// Stability: a judgement that flips between runs cannot gate anything.
let stable = 0;
const flips: string[] = [];
controls.forEach((c, i) => {
	const picks = new Set(runs.map((r) => r[i]?.choice));
	if (picks.size === 1) stable++;
	else flips.push(`${c.id} ${[...picks].join('/')} (labelled ${truth(c.id)})`);
});
process.stdout.write(
	`stable across ${times} runs: ${pct(stable, controls.length)}${flips.length ? ` — flipped: ${flips.join(', ')}` : ''}\n`,
);

// Per class. `destination` is the one that matters: every redirect in the
// abstract language fires on it, so a false positive sends an agent to the
// wrong pattern entirely.
process.stdout.write('\nclass         precision  recall\n');
for (const cls of CLASSES) {
	let tp = 0;
	let fp = 0;
	let fn = 0;
	runs.forEach((answers) =>
		controls.forEach((c, i) => {
			const picked = answers[i]?.choice === cls;
			const is = truth(c.id) === cls;
			if (picked && is) tp++;
			else if (picked) fp++;
			else if (is) fn++;
		}),
	);
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
	runs.forEach((answers) =>
		controls.forEach((c, i) => {
			const a = answers[i];
			if (!a || a.confidence < lo || a.confidence >= hi) return;
			n++;
			if (a.choice === truth(c.id)) ok++;
		}),
	);
	process.stdout.write(`${name.padEnd(17)} ${String(n).padStart(5)}  ${pct(ok, n).padStart(7)}\n`);
}

// The same bands per picked class. A redirect acts on one class, so its floor
// is that class's precision under the floor, not the whole question's.
process.stdout.write('\npicked as       >=0.90 right   <0.90 right\n');
for (const cls of CLASSES) {
	const cell = (hi: boolean): string => {
		let n = 0;
		let ok = 0;
		runs.forEach((answers) =>
			controls.forEach((c, i) => {
				const a = answers[i];
				if (a?.choice !== cls || a.confidence >= 0.9 !== hi) return;
				n++;
				if (truth(c.id) === cls) ok++;
			}),
		);
		return `${ok}/${n}`.padStart(8);
	};
	process.stdout.write(`${cls.padEnd(13)} ${cell(true)}      ${cell(false)}\n`);
}

// The redirect classes gated two ways on the same answers: the pick's
// confidence, as `judgeRedirects` does, or the class's own probability.
// Confidence is the shape of the whole distribution, so it also falls when the
// rest is split between two classes neither of which is this one.
process.stdout.write('\ngate                      acted  wrong  recall\n');
for (const cls of ['command', 'destination'] as const) {
	const truly = controls.filter((c) => truth(c.id) === cls).length * runs.length;
	for (const [name, acts] of [
		['confidence', (a: Choice, bar: number) => a.choice === cls && a.confidence >= bar],
		[`P(${cls})`, (a: Choice, bar: number) => (a.probabilities?.[cls] ?? 0) >= bar],
	] as const)
		for (const bar of [0.8, 0.9]) {
			let acted = 0;
			let wrong = 0;
			runs.forEach((answers) =>
				controls.forEach((c, i) => {
					const a = answers[i];
					if (!a || !acts(a, bar)) return;
					acted++;
					if (truth(c.id) !== cls) wrong++;
				}),
			);
			const label = `${cls} ${name} >= ${bar.toFixed(2)}`;
			process.stdout.write(
				`${label.padEnd(25)} ${String(acted).padStart(5)}  ${String(wrong).padStart(5)}  ${pct(acted - wrong, truly).padStart(6)}\n`,
			);
		}
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
