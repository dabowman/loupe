/** What both evals share: the key, the run loop, stability, and how a ratio prints. */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL } from '../src/judge.ts';
import type { Choice } from '../src/judge.ts';

export type Answers = (Choice | undefined)[];

export const pct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(0)}%` : '—');

const ENV = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');

/** `TYPESAFE_API_KEY`, from the environment or the checkout's `.env`; exits 2 without one. */
export function apiKey(): string {
	try {
		if (!process.env.TYPESAFE_API_KEY) process.loadEnvFile?.(ENV);
	} catch {
		/* no .env beside the checkout is the ordinary case */
	}
	const key = process.env.TYPESAFE_API_KEY;
	if (!key) {
		process.stderr.write(`eval: needs TYPESAFE_API_KEY, in the environment or ${ENV}\n`);
		process.exit(2);
	}
	return key;
}

/** The bare number on the command line, 3 without one. `skip` is an index that is some flag's value. */
export const runCount = (skip = -1): number =>
	Number(process.argv.find((a, i) => i >= 2 && /^\d+$/.test(a) && i !== skip) ?? 3);

/** Ask `times` times, printing each run's timing and `score`. Returns every run's answers. */
export async function repeat(
	times: number,
	once: () => Promise<Answers>,
	score: (answers: Answers) => string,
): Promise<Answers[]> {
	process.stdout.write(`model: ${MODEL}\n`);
	const runs: Answers[] = [];
	for (let r = 1; r <= times; r++) {
		const started = Date.now();
		const answers = await once();
		runs.push(answers);
		process.stdout.write(
			`run ${r}: ${answers.filter(Boolean).length}/${answers.length} answered in ${((Date.now() - started) / 1000).toFixed(1)}s — ${score(answers)}\n`,
		);
	}
	return runs;
}

/**
 * Stability: a judgement that flips between runs cannot be applied unattended.
 * `describe` names one flipped item, given the picks it flipped between.
 */
export function stability(runs: readonly Answers[], n: number, describe: (i: number, picks: string[]) => string): void {
	const flips: string[] = [];
	for (let i = 0; i < n; i++) {
		const picks = [...new Set(runs.map((r) => r[i]?.choice ?? '—'))];
		if (picks.length > 1) flips.push(describe(i, picks));
	}
	process.stdout.write(
		`stable across ${runs.length} runs: ${pct(n - flips.length, n)}${flips.length ? ` — flipped: ${flips.join(', ')}` : ''}\n`,
	);
}
