/**
 * Markup scans across worker threads, for the runs with a lot to scan.
 *
 * Parsing is most of a cold run, CPU-bound, and independent per file, so a
 * first run, a CI run or an audit after a branch switch spreads it over the
 * machine's cores. A warm run has a handful of misses and never starts a
 * worker: a worker's own start-up is a module load, and below a few hundred
 * files that costs more than it saves.
 *
 * The worker is this same module, loaded again. From source that is
 * `src/scan-pool.ts`; from the bundle it is `dist/loupe.mjs`, whose CLI entry
 * stands aside off the main thread (`cli.ts`). Either way the scan a worker runs
 * is the one the main thread would have, and results are placed by index, so
 * the analysis consumes them in the same order as an in-process run.
 *
 * Anything going wrong with a worker — it will not start, it dies, the host is
 * a compiled binary whose module graph a worker cannot reload — falls back to
 * scanning in-process. Workers are a speed-up, never a requirement.
 *
 * Design notes: docs/design/cli.md#caches
 */

import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { scanMarkup } from './markup.ts';
import { isOn } from './paths.ts';
import { messageOf } from './text.ts';
import type { DesignSystem, PatternRule, ScanResult } from './types.ts';

const TAG = 'loupe-scan-worker';

/** One file to scan: its path and its bytes. */
export interface ScanJob {
	rel: string;
	text: string;
}

// Below this many files, or this many bytes, the in-process scan is faster than
// starting workers. Measured on Gutenberg: ~100ms to bring a worker up from the
// bundle, against ~0.8ms per file to scan.
const MIN_FILES = 150;
const MIN_BYTES = 600_000;
// Files per message: large enough that messaging is noise, small enough that
// one worker stuck on a big file does not hold the rest of the queue.
const BATCH = 24;

/** How many workers this run gets; 0 means scan in-process. */
export function workerCount(jobs: readonly ScanJob[]): number {
	if (isOn(process.env.LOUPE_NO_WORKERS)) return 0;
	// A compiled binary's modules cannot be loaded a second time from inside it.
	if (process.versions.bun) return 0;
	if (jobs.length < MIN_FILES) return 0;
	let bytes = 0;
	for (const j of jobs) bytes += j.text.length;
	if (bytes < MIN_BYTES) return 0;
	// `availableParallelism` is Node 18.14: named, it would have failed the whole
	// bundle at link time on an older 18. The floor is now Node 20, so every Node
	// `engines` admits has it and the `cpus()` fallback stays only for now.
	const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
	if (cores < 2) return 0;
	// One core stays with the main thread, which is reading files and will
	// consume the results.
	return Math.min(cores - 1, 8, Math.ceil(jobs.length / BATCH));
}

const scanAll = (jobs: readonly ScanJob[], ds: DesignSystem, rules: readonly PatternRule[]): ScanResult[] =>
	jobs.map((j) => scanMarkup(j.text, j.rel, ds, rules));

/**
 * Every job's scan, in job order. Uses workers when the run is big enough to
 * be worth them, and the main thread otherwise or if they fail.
 */
export async function scanMany(
	jobs: readonly ScanJob[],
	ds: DesignSystem,
	rules: readonly PatternRule[],
): Promise<ScanResult[]> {
	// `LOUPE_DEBUG_SCAN=1` says where the scans were made. A fallback is
	// otherwise silent by design, which is also what would hide a broken worker.
	const debug = (line: string): void => {
		if (isOn(process.env.LOUPE_DEBUG_SCAN)) process.stderr.write(`loupe: ${line}\n`);
	};
	const n = workerCount(jobs);
	if (n) {
		try {
			const out = await inWorkers(jobs, ds, rules, n);
			debug(`scanned ${jobs.length} file(s) across ${n} worker(s)`);
			return out;
		} catch (err) {
			debug(`workers failed (${messageOf(err)}), scanning in-process`);
		}
	}
	const out = scanAll(jobs, ds, rules);
	if (jobs.length) debug(`scanned ${jobs.length} file(s) in-process`);
	return out;
}

/** Exported for the tests: the worker path alone, with no fallback to hide a failure. */
export function inWorkers(
	jobs: readonly ScanJob[],
	ds: DesignSystem,
	rules: readonly PatternRule[],
	n: number,
): Promise<ScanResult[]> {
	const out: ScanResult[] = new Array(jobs.length);
	let next = 0;
	let left = jobs.length;
	const workers: Worker[] = [];
	return new Promise<ScanResult[]>((resolve, reject) => {
		let settled = false;
		const finish = (err?: unknown): void => {
			if (settled) return;
			settled = true;
			for (const w of workers) void w.terminate();
			if (err) reject(err);
			else resolve(out);
		};
		const feed = (w: Worker): void => {
			if (next >= jobs.length) return;
			const batch = jobs.slice(next, next + BATCH).map((j, k) => ({ ...j, i: next + k }));
			next += batch.length;
			w.postMessage(batch);
		};
		for (let k = 0; k < n; k++) {
			const w = new Worker(new URL(import.meta.url), { workerData: { [TAG]: true, ds, rules } });
			workers.push(w);
			w.on('message', (done: { i: number; scan: ScanResult }[]) => {
				for (const { i, scan } of done) out[i] = scan;
				left -= done.length;
				if (left === 0) finish();
				else feed(w);
			});
			w.on('error', finish);
			w.on('exit', (code) => {
				if (code !== 0) finish(new Error(`scan worker exited with ${code}`));
			});
			feed(w);
		}
	});
}

// The worker side: the same module, loaded by `new Worker` above.
if (!isMainThread && (workerData as Record<string, unknown> | null)?.[TAG] && parentPort) {
	const { ds, rules } = workerData as { ds: DesignSystem; rules: PatternRule[] };
	const port = parentPort;
	port.on('message', (batch: (ScanJob & { i: number })[]) => {
		port.postMessage(batch.map((j) => ({ i: j.i, scan: scanMarkup(j.text, j.rel, ds, rules) })));
	});
}
