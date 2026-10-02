/**
 * The bits every test file was carrying its own copy of.
 *
 * `check` and `assert` were duplicated verbatim across four files, and each
 * one tracked its own failure counter and wrote its own exit line — so a
 * change to how a failure reports meant four edits, and the one file that got
 * missed still passed. There is no framework here on purpose: these are the
 * six lines the tests actually used, typed once.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every CLI a test spawns inherits this, so suites that are not about the
// caches neither read a warm one nor leave index files behind in the user's
// temp directory. The cache suites turn it back on for the runs they measure.
process.env.LOUPE_NO_CACHE ??= '1';

let failed = 0;

/** Run one named assertion. A throw is a failure, not a crash. */
export async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failed++;
		console.log(`FAIL ${name}\n     ${err instanceof Error ? err.message : String(err)}`);
	}
}

export function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

/**
 * The one element of `items`, or a failure naming how many there were.
 *
 * `assert(x.length === 1)` followed by `x[0].message` is the shape these tests
 * reach for constantly, and it is exactly the shape a strict index check cannot
 * follow — the length assertion says nothing about the element. This says both
 * at once.
 */
export function one<T>(items: readonly T[], msg: string): T {
	assert(items.length === 1, `${msg} — got ${items.length}`);
	const [first] = items;
	assert(first !== undefined, msg);
	return first;
}

/** The first element, or a failure. For "at least one of these happened". */
export function first<T>(items: readonly T[], msg: string): T {
	const [head] = items;
	assert(head !== undefined, `${msg} — got none`);
	return head;
}

/** Count a failure raised outside `check` — a fixture loop, say. */
export const fail = (): number => ++failed;

export const failures = (): number => failed;

/** Print the tally and set the exit code. Every test file ends with this. */
export function finish(summary?: string): never {
	console.log(summary ?? `\n${failed ? `${failed} failed` : 'all passed'}`);
	process.exit(failed ? 1 : 0);
}

/**
 * What `execFileSync` attaches to a non-zero exit.
 *
 * The throw is typed `unknown`, and the three fields the tests care about —
 * the exit code and both streams — are exactly the ones that vanish if you
 * reach for them without checking. This is the one place that checks.
 */
export interface ExecFailure {
	status: number | null;
	stdout: string;
	stderr: string;
	message: string;
}

export function execFailure(err: unknown): ExecFailure {
	const e = err as Partial<ExecFailure> | null;
	return {
		status: typeof e?.status === 'number' ? e.status : null,
		stdout: String(e?.stdout ?? ''),
		stderr: String(e?.stderr ?? ''),
		message: err instanceof Error ? err.message : String(err),
	};
}

/**
 * The engine's entry point, for the suites that drive it as a subprocess.
 *
 * Here rather than in each of them for the reason above: two copies of where the
 * bin lives is two edits the day it moves, and the one that gets missed still
 * passes. This is the other half of the CLI pathway `execFailure` already owns.
 */
export const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'loupe.mjs');

/** A throwaway repo directory. The caller removes it. */
export const scratch = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));

/** Write one file into a scratch repo, creating the directories it needs. */
export function write(root: string, rel: string, body: string): void {
	const full = join(root, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, body);
}

/** Write a whole tree at once: relative path -> contents. */
export function writeAll(root: string, files: Record<string, string>): void {
	for (const [rel, body] of Object.entries(files)) write(root, rel, body);
}

/** Remove a scratch repo, whatever state it is in. */
export const cleanup = (root: string): void => rmSync(root, { recursive: true, force: true });
