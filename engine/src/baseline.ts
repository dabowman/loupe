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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { findingKey } from './analyze.ts';
import type { AnalyzeResult, Baseline, BaselineFile, BaselinedResult } from './types.ts';

const resolvePath = (root: string, p: string): string => (isAbsolute(p) ? p : join(root, p));

export function readBaseline(root: string, path: string): Baseline | null {
	const full = resolvePath(root, path);
	if (!existsSync(full)) return null;
	try {
		const parsed = JSON.parse(readFileSync(full, 'utf8')) as Partial<BaselineFile>;
		const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
		return {
			version: parsed.version ?? 1,
			createdAt: parsed.createdAt ?? '',
			count: parsed.count ?? entries.length,
			entries,
			set: new Set(entries),
		};
	} catch {
		return null;
	}
}

export function writeBaseline(
	root: string,
	path: string,
	result: AnalyzeResult,
): { path: string; count: number } {
	const full = resolvePath(root, path);
	// A configured baseline may name a directory that doesn't exist yet.
	mkdirSync(dirname(full), { recursive: true });
	const entries = [...new Set(result.findings.map(findingKey))].sort();
	writeFileSync(
		full,
		`${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), count: entries.length, entries }, null, 2)}\n`
	);
	return { path: full, count: entries.length };
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
