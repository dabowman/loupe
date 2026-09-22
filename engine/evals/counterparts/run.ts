#!/usr/bin/env node
/**
 * What context a counterpart judgement actually needs.
 *
 * `map` sends the model a name, a type, a tier, a value, an alias, a description
 * and the token's siblings, and offers it eight ranked candidates gated on
 * `$type`. Every one of those is a guess that this part of a token carries its
 * meaning. This turns each off in turn against a set whose answers are known and
 * says what it cost.
 *
 * Two numbers per arm, and the gap between them is the point:
 *
 *   ceiling   how often the true counterpart was on the shortlist at all.
 *             Free, no request, and a hard cap — a shortlist without the answer
 *             cannot be rescued by the model. A low ceiling is a ranking
 *             problem and nothing the question can fix.
 *   accuracy  how often the model then picked it. Scored on the raw answer
 *             rather than on what survives the floor, so this measures the
 *             context and not the floor.
 *
 * `none` is scored separately and both ways round, because an arm that never
 * declines and an arm that always declines both look fine on accuracy alone.
 *
 * The labelled pair is built by renaming a real set — see rename.ts, and read
 * its caveats before quoting any number here as though it were about two real
 * systems.
 *
 *   node evals/counterparts/run.ts                       # primer-semantic
 *   node evals/counterparts/run.ts archer-common         # the other substrate
 *   node evals/counterparts/run.ts --ceilings            # free: ranking only
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FULL_CONTEXT } from '../../src/judge/counterpart.ts';
import type { Context } from '../../src/judge/counterpart.ts';
import { askCounterparts, planMap, rank } from '../../src/mapping.ts';
import { NONE, describePair, labelledPair } from './rename.ts';
import type { Labelled } from './rename.ts';
import { apiKey, pct } from '../lib.ts';
import { MODEL } from '../../src/judge.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A context with everything off, to switch single fields on from. */
const BARE: Context = {
	element: { name: false, type: false, tier: false, value: false, alias: false, description: false, siblings: false },
	option: { tier: false, value: false, description: false },
};
const ctx = (el: Partial<Context['element']>, op: Partial<Context['option']>): Context => ({
	element: { ...BARE.element, ...el },
	option: { ...BARE.option, ...op },
});

interface Arm {
	name: string;
	/** What it is testing, printed beside the result. */
	asks: string;
	context: Context;
	candidates: number;
	typeGate: boolean;
}

/**
 * The arms, in the order the questions were asked.
 *
 * Each one differs from `full` in a single respect, so a difference is
 * attributable. `all` is the exception and deliberately so: it offers every
 * token in the set, which is both the no-ranking control and the answer to
 * whether more choices help.
 */
const ARMS: Arm[] = [
	{ name: 'full', asks: 'everything map sends today', context: FULL_CONTEXT, candidates: 8, typeGate: true },
	// What the model reads about the token being matched.
	{ name: 'name only', asks: 'is the name enough?', context: ctx({ name: true }, {}), candidates: 8, typeGate: true },
	{
		name: 'description only',
		asks: 'is the description enough?',
		context: ctx({ description: true }, { description: true }),
		candidates: 8,
		typeGate: true,
	},
	{
		name: 'name + description',
		asks: 'the two that obviously carry meaning',
		context: ctx({ name: true, description: true }, { description: true }),
		candidates: 8,
		typeGate: true,
	},
	{
		name: 'full − description',
		asks: 'how much does prose carry?',
		context: {
			element: { ...FULL_CONTEXT.element, description: false },
			option: { ...FULL_CONTEXT.option, description: false },
		},
		candidates: 8,
		typeGate: true,
	},
	{
		name: 'full − siblings',
		asks: 'does it need the token in context of others?',
		context: { element: { ...FULL_CONTEXT.element, siblings: false }, option: { ...FULL_CONTEXT.option } },
		candidates: 8,
		typeGate: true,
	},
	{
		name: 'full − value',
		asks: 'does the value help or mislead?',
		context: { element: { ...FULL_CONTEXT.element, value: false }, option: { ...FULL_CONTEXT.option, value: false } },
		candidates: 8,
		typeGate: true,
	},
	{
		name: 'full − tier',
		asks: 'is tier meaning, or noise?',
		context: { element: { ...FULL_CONTEXT.element, tier: false }, option: { ...FULL_CONTEXT.option, tier: false } },
		candidates: 8,
		typeGate: true,
	},
	// How many options, and which.
	{ name: 'full, 4 choices', asks: 'fewer choices', context: FULL_CONTEXT, candidates: 4, typeGate: true },
	{ name: 'full, 16 choices', asks: 'more choices', context: FULL_CONTEXT, candidates: 16, typeGate: true },
	{ name: 'full, 32 choices', asks: 'many more', context: FULL_CONTEXT, candidates: 32, typeGate: true },
	{ name: 'full, every token', asks: 'no ranking at all', context: FULL_CONTEXT, candidates: 10_000, typeGate: true },
	{
		name: 'full, no type gate',
		asks: 'does the type gate earn it?',
		context: FULL_CONTEXT,
		candidates: 8,
		typeGate: false,
	},
];

interface Score {
	/** Rows whose true answer is a token. */
	pairs: number;
	ceiling: number;
	correct: number;
	/** Rows whose true answer is `none`. */
	nones: number;
	noneFound: number;
	/** Rows that said `none` when a real counterpart existed. */
	falseNone: number;
	options: number;
}

/** Was the true counterpart on the shortlist? Free, and the cap on everything else. */
function ceilingOf(pair: Labelled, candidates: number, typeGate: boolean): { pairs: number; ceiling: number } {
	let pairs = 0;
	let hit = 0;
	for (const t of pair.source.tokens) {
		const truth = pair.truth.get(t.path);
		if (!truth || truth === NONE) continue;
		pairs++;
		if (
			rank(t, pair.target.tokens, typeGate)
				.slice(0, candidates)
				.some((c) => c.token.path === truth)
		)
			hit++;
	}
	return { pairs, ceiling: hit };
}

async function runArm(pair: Labelled, arm: Arm, key: string): Promise<Score> {
	const plan = planMap(pair.source, pair.target, {
		candidates: arm.candidates,
		typeGate: arm.typeGate,
		settleExact: false,
	});
	const { answers } = await askCounterparts(plan, key, fetch, arm.context);
	const s: Score = { pairs: 0, ceiling: 0, correct: 0, nones: 0, noneFound: 0, falseNone: 0, options: 0 };
	plan.jobs.forEach((job, i) => {
		const truth = pair.truth.get(job.token.path);
		// The raw pick, not what survives the floor: this arm is about context.
		const got = answers[i]?.choice;
		s.options += job.candidates.length;
		if (truth === NONE) {
			s.nones++;
			if (got === NONE) s.noneFound++;
			return;
		}
		s.pairs++;
		if (job.candidates.some((c) => c.path === truth)) s.ceiling++;
		if (got === truth) s.correct++;
		else if (got === NONE) s.falseNone++;
	});
	// Rows the plan settled without asking are still rows; count them as missed
	// rather than silently shrinking the denominator.
	for (const m of plan.settled) {
		const truth = pair.truth.get(m.from);
		if (truth === NONE) {
			s.nones++;
			if (m.to === null) s.noneFound++;
		} else s.pairs++;
	}
	return s;
}

const set = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'primer-semantic';
const ceilingsOnly = process.argv.includes('--ceilings');
const pair = labelledPair(join(HERE, 'sets', `${set}.json`));

process.stdout.write(`set: ${set}   model: ${MODEL}\n${describePair(pair)}\n`);

if (ceilingsOnly) {
	// The ranking alone, for free. Worth running first on a new pair: an arm
	// cannot score above its ceiling however good the question is.
	process.stdout.write(`${'arm'.padEnd(24)}${'options'.padStart(8)}${'ceiling'.padStart(10)}\n`);
	for (const arm of ARMS) {
		const { pairs, ceiling } = ceilingOf(pair, arm.candidates, arm.typeGate);
		const offered = Math.min(arm.candidates, pair.target.tokens.length);
		process.stdout.write(`${arm.name.padEnd(24)}${String(offered).padStart(8)}${pct(ceiling, pairs).padStart(10)}\n`);
	}
	process.exit(0);
}

const key = apiKey();
process.stdout.write(
	`${'arm'.padEnd(24)}${'opts'.padStart(6)}${'ceiling'.padStart(9)}${'accuracy'.padStart(10)}` +
		`${'none found'.padStart(12)}${'false none'.padStart(12)}   asks\n`,
);
for (const arm of ARMS) {
	const started = Date.now();
	const s = await runArm(pair, arm, key);
	const secs = ((Date.now() - started) / 1000).toFixed(0);
	process.stdout.write(
		`${arm.name.padEnd(24)}${String(Math.round(s.options / Math.max(1, s.pairs + s.nones))).padStart(6)}` +
			`${pct(s.ceiling, s.pairs).padStart(9)}${pct(s.correct, s.pairs).padStart(10)}` +
			`${pct(s.noneFound, s.nones).padStart(12)}${pct(s.falseNone, s.pairs).padStart(12)}` +
			`   ${arm.asks} (${secs}s)\n`,
	);
}
