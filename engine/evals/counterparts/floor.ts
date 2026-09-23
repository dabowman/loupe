#!/usr/bin/env node
/**
 * Where to put the floor.
 *
 * A judgement below the floor is withheld — the row comes back `unsure` and a
 * person looks at it. Above it, the answer is written into the map as fact. So
 * the floor trades two failures against each other, and they do not cost the
 * same: a withheld answer is work for a reader, and an admitted wrong one is a
 * false statement about the second design system that everything downstream
 * inherits. This is the same asymmetry every other floor in the engine resolves
 * the same way — see docs/design/judge.md.
 *
 * 0.5 was inherited from `check --judge`, where a question offers a handful of
 * options. A question here offers up to 254, which spreads the probability mass
 * over far more of them, so the number had no business surviving that change
 * unexamined.
 *
 * What this measures, over the labelled pairs `rename.ts` builds:
 *
 *   admitted    answers at or above the floor, as a share of all rows
 *   precision   of those, how many were right
 *   lost        right answers the floor withheld, as a share of all right ones
 *
 * Each run is repeated, because a single reading moves by a few rows on its own
 * — see docs/design/map.md#how-much-of-this-is-noise.
 *
 * The sweep answers where to put the floor. It does not answer whether the floor
 * is the right instrument, and the bands at the end are what settles that: if
 * confidence is well calibrated, the rows under the floor are not junk but
 * *less certain*, and throwing them away is a different act from excluding them.
 * Pass a `map --format json` payload and the bands report how much of a real
 * run sits in each one, which is the thing the substrate cannot tell you.
 *
 *   node evals/counterparts/floor.ts            # both substrates, 2 repeats
 *   node evals/counterparts/floor.ts 3          # 3 repeats
 *   node evals/counterparts/floor.ts 2 map.json # …and where a real run falls
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askCounterparts, planMap } from '../../src/mapping.ts';
import { NONE, labelledPair } from './rename.ts';
import { apiKey, pct, runCount } from '../lib.ts';
import { MODEL } from '../../src/judge.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETS = ['primer-semantic', 'archer-common'];
const FLOORS = [0, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7];
/** Lower bounds, high to low. Each band runs from its bound up to the one above. */
const BANDS = [0.7, 0.5, 0.35, 0.25, 0];

/** One answered row: how sure the model was, and whether it was right. */
interface Row {
	confidence: number;
	right: boolean;
	/** `none` answers are scored too — withholding one is also a row for a person. */
	declined: boolean;
}

const key = apiKey();
const repeats = runCount();
const rows: Row[] = [];

process.stdout.write(`model: ${MODEL}   ${repeats} repeat(s)\n\n`);

for (const set of SETS) {
	const pair = labelledPair(join(HERE, 'sets', `${set}.json`));
	const plan = planMap(pair.source, pair.target, { settleExact: false });
	for (let r = 0; r < repeats; r++) {
		const { answers } = await askCounterparts(plan, key, fetch);
		plan.jobs.forEach((job, i) => {
			const a = answers[i];
			if (!a) return;
			const truth = pair.truth.get(job.token.path);
			rows.push({ confidence: a.confidence, right: a.choice === truth, declined: a.choice === NONE });
		});
	}
	process.stdout.write(`${set.padEnd(18)}${plan.jobs.length} tokens × ${repeats}\n`);
}

const right = rows.filter((r) => r.right).length;
process.stdout.write(`\n${rows.length} answered rows, ${right} of them correct (${pct(right, rows.length)})\n\n`);

process.stdout.write(
	`${'floor'.padEnd(8)}${'admitted'.padStart(10)}${'right'.padStart(7)}${'wrong'.padStart(7)}` +
		`${'precision'.padStart(11)}${'lost'.padStart(8)}${'cost'.padStart(8)}\n`,
);
// `cost` is the only column that answers "is this step worth taking": the right
// answers a step gives up per wrong answer it removes. No weighting is invented
// for it, because there is no honest number to invent — what a wrong row costs
// against a withheld one is a judgement, and the ratio is what it is applied to.
let last: { ok: number; bad: number } | undefined;
for (const f of FLOORS) {
	const admitted = rows.filter((r) => r.confidence >= f);
	const ok = admitted.filter((r) => r.right).length;
	const bad = admitted.length - ok;
	const dropped = last ? last.bad - bad : 0;
	const cost = last && dropped > 0 ? ((last.ok - ok) / dropped).toFixed(1) : last ? '\u2014' : '';
	process.stdout.write(
		`${f.toFixed(2).padEnd(8)}${pct(admitted.length, rows.length).padStart(10)}${String(ok).padStart(7)}` +
			`${String(bad).padStart(7)}${pct(ok, admitted.length).padStart(11)}${pct(right - ok, right).padStart(8)}` +
			`${cost.padStart(8)}\n`,
	);
	last = { ok, bad };
}

// ── is the confidence worth anything on its own? ─────────────────────────────
//
// A floor is a good instrument only if the number it cuts on is meaningless
// below the cut. If precision instead falls off smoothly band by band, the
// number is carrying information the whole way down, and a floor that discards
// the answer along with the claim is throwing that information away.
const payload = process.argv[3];
const real = payload ? confidencesIn(payload) : [];
// Dumped so a question about where to cut can be re-asked without paying for
// the answers again. Every table above and below is a view of this file.
writeFileSync(join(HERE, 'floor-rows.json'), JSON.stringify(rows));

process.stdout.write(
	`\n${'confidence'.padEnd(14)}${'rows'.padStart(7)}${'precision'.padStart(11)}` +
		`${real.length ? `${'a real run'.padStart(12)}` : ''}\n`,
);
for (const [i, low] of BANDS.entries()) {
	const high = i === 0 ? 1.01 : (BANDS[i - 1] as number);
	const band = rows.filter((r) => r.confidence >= low && r.confidence < high);
	const ok = band.filter((r) => r.right).length;
	const there = real.filter((c) => c >= low && c < high).length;
	process.stdout.write(
		`${`${low.toFixed(2)}\u2013${Math.min(1, high).toFixed(2)}`.padEnd(14)}` +
			`${String(band.length).padStart(7)}${pct(ok, band.length).padStart(11)}` +
			`${real.length ? pct(there, real.length).padStart(12) : ''}\n`,
	);
}

/**
 * The confidence of every row of a real run that a question was actually put
 * for. `exact` and `absent` are settled without one, so they have no confidence
 * to report and counting them would flatter the distribution.
 */
function confidencesIn(path: string): number[] {
	const doc = JSON.parse(readFileSync(path, 'utf8')) as {
		mappings?: { how: string; confidence: number }[];
	};
	const asked = (doc.mappings ?? []).filter((m) => m.how === 'judged' || m.how === 'none' || m.how === 'unsure');
	if (!asked.length) throw new Error(`${path} has no answered rows — is it a \`map --format json\` payload?`);
	process.stdout.write(`\nagainst ${path}: ${asked.length} answered rows\n`);
	return asked.map((m) => m.confidence);
}
