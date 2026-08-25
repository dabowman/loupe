/**
 * Baseline.
 *
 * The adoption blocker for a tool like this is the first run on an existing
 * codebase: hundreds of advisory findings, none of them the work in front of
 * you. A baseline turns that backlog into a ratchet — existing findings are
 * recorded and stay quiet, new ones surface immediately.
 *
 * Entries are keyed on rule + file + normalized code, deliberately NOT on line
 * number, so reformatting or an unrelated edit above doesn't resurrect every
 * finding in the file.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { findingKey } from './analyze.ts';
import { ensureDir } from './paths.ts';
import type { AnalyzeResult, Baseline, BaselineFile, BaselinedResult } from './types.ts';

const resolvePath = (root: string, p: string): string => (isAbsolute(p) ? p : join(root, p));

/**
 * Read a baseline, or null if there isn't one *or* it can't be parsed.
 *
 * Callers that already know the file is there — `findExistingBaseline` reports
 * it — can read a null as "unreadable" and say so. That distinction matters:
 * the likeliest corruption for a file this project now asks people to commit is
 * a merge conflict, and conflict markers in it turn every accepted finding back
 * on with the gate blocking on all of them, which is the precise symptom the
 * baseline was pinned to the project to stop producing.
 */
export function readBaseline(root: string, path: string): Baseline | null {
	const full = resolvePath(root, path);
	if (!existsSync(full)) return null;
	try {
		const parsed = JSON.parse(readFileSync(full, 'utf8')) as Partial<BaselineFile>;
		// A file whose `entries` is missing or not an array is as unreadable as one
		// that doesn't parse: both mean "we cannot tell you what was accepted".
		// Defaulting it to `[]` instead said "nothing was accepted", which reads to
		// every caller as a healthy empty baseline — so the backlog went live, the
		// gate blocked on all of it, and the warning that exists for exactly this
		// never fired. `jq` rewriting the file without `.entries` is enough to get
		// here, and valid JSON is the case least likely to be suspected.
		if (!Array.isArray(parsed.entries)) return null;
		const entries = parsed.entries;
		return {
			version: parsed.version ?? 1,
			createdAt: parsed.createdAt ?? '',
			count: parsed.count ?? entries.length,
			findings: parsed.findings ?? entries.length,
			entries,
			set: new Set(entries),
		};
	} catch {
		return null;
	}
}

/**
 * Record the backlog.
 *
 * Both counts come back because they are different numbers: several findings
 * collapse into one entry whenever they share a key — the same declaration on
 * two selectors, the same code on two lines — and `check` reports the findings
 * it hid, not the entries that hid them. Returning only the entries left the
 * caller labelling them as findings and the two commands disagreeing with
 * nothing to reconcile them against.
 */
export function writeBaseline(
	root: string,
	path: string,
	result: AnalyzeResult,
): { path: string; findings: number; entries: number } {
	const full = resolvePath(root, path);
	// A *configured* baseline may name a directory that doesn't exist yet — the
	// default one sits in the project root, which the caller already proved
	// exists, so don't mkdir it. `ensureDir` rather than a bare `mkdirSync`
	// because a bad path should fail on the write that wanted it: mkdir on a
	// path whose parent is a file reports `EEXIST ... a.css`, which names the
	// wrong problem, where the write reports ENOTDIR and names the right one.
	const dir = dirname(full);
	if (dir !== resolve(root)) ensureDir(dir);
	const entries = [...new Set(result.findings.map(findingKey))].sort();
	// Both numbers, for the same reason the CLI prints both: `count` is entries,
	// and a file that reports only entries under a name a reader hears as
	// "findings" is how 194 came to be quoted against `check`'s 253. `count`
	// keeps its meaning so 0.1.x files still parse; `findings` says the rest.
	const file: BaselineFile = {
		version: 1,
		createdAt: new Date().toISOString(),
		count: entries.length,
		findings: result.findings.length,
		entries,
	};
	writeFileSync(full, `${JSON.stringify(file, null, 2)}\n`);
	return { path: full, findings: result.findings.length, entries: entries.length };
}

/**
 * Split findings against a baseline.
 * `fixed` is only meaningful on a whole-repo run — on a scoped run the absent
 * entries are mostly just out of scope, so callers suppress that number.
 */
export function applyBaseline(result: AnalyzeResult, baseline: Baseline | null): BaselinedResult {
	if (!baseline) return { ...result, baselined: 0, fixed: 0 };
	const seen = new Set<string>();
	const kept = [];
	let baselined = 0;
	for (const f of result.findings) {
		const key = findingKey(f);
		seen.add(key);
		if (baseline.set.has(key)) baselined++;
		else kept.push(f);
	}
	const fixed = [...baseline.set].filter((k) => !seen.has(k)).length;
	return {
		...result,
		findings: kept,
		blocking: kept.some((f) => f.severity === 'error'),
		baselined,
		fixed,
	};
}
