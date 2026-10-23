/**
 * Baseline: the first run's backlog, turned into a ratchet. Existing findings
 * are recorded and stay quiet; new ones surface immediately.
 *
 * Entries are keyed on rule + file + normalized code, deliberately NOT on line
 * number, so reformatting or an unrelated edit above doesn't resurrect every
 * finding in the file.
 *
 * Design notes: docs/design/report.md#baseline
 */

import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { findingKey, isBlocking } from './analyze.ts';
import { byBytes } from './discover.ts';
import { isRecord, readJson } from './json.ts';
import { ensureDir } from './paths.ts';
import type { AnalyzeResult, Baseline, BaselineFile, BaselinedResult } from './types.ts';

/**
 * Read a baseline, or null if there isn't one *or* it can't be parsed.
 *
 * Callers that already know the file is there — `findExistingBaseline` reports
 * it — can read a null as "unreadable" and say so. The likeliest corruption for
 * a file the project is asked to commit is a merge conflict, and conflict
 * markers turn every accepted finding back on with the gate blocking on it.
 */
export function readBaseline(path: string): Baseline | null {
	if (!existsSync(path)) return null;
	const parsed = readJson(path) as Partial<BaselineFile> | null;
	// A file whose `entries` is missing or not an array is as unreadable as one
	// that doesn't parse: both mean "we cannot tell you what was accepted".
	// Defaulting it to `[]` says "nothing was accepted", which reads as a healthy
	// empty baseline and puts the whole backlog live.
	if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return null;
	// An entry that is not a string is no key a finding could match, and every
	// reader past here takes one apart as text.
	const entries = (parsed.entries as unknown[]).filter((e): e is string => typeof e === 'string');
	return { createdAt: parsed.createdAt ?? '', entries, set: new Set(entries) };
}

/** One entry per distinct key, sorted, so a re-record rewrites the same bytes. */
const entriesOf = (result: AnalyzeResult): string[] => [...new Set(result.findings.map(findingKey))].sort();

/** The rule an entry belongs to: its key leads with the rule id. */
const ruleOf = (entry: string): string => entry.slice(0, entry.indexOf('|'));

/** One rule's line in `baseline --dry-run`. */
export interface BaselineRuleDiff {
	rule: string;
	/** Findings this rule would record now. */
	findings: number;
	/** Entries the prior baseline lacks — backlog that would be newly accepted. */
	added: number;
	/** Prior entries nothing matches any more — work done since it was recorded. */
	removed: number;
}

/**
 * What recording now would change, rule by rule, against the baseline in force.
 *
 * The split is in entries, the unit a baseline stores, so a rule whose findings
 * are all gone still gets a row for what was fixed. Busiest rule first.
 */
export function diffBaseline(
	result: AnalyzeResult,
	prior: Baseline | null,
): { entries: number; rules: BaselineRuleDiff[] } {
	const entries = entriesOf(result);
	const rows = new Map<string, BaselineRuleDiff>();
	const row = (rule: string): BaselineRuleDiff => {
		let r = rows.get(rule);
		if (!r) {
			r = { rule, findings: 0, added: 0, removed: 0 };
			rows.set(rule, r);
		}
		return r;
	};
	for (const f of result.findings) row(f.rule).findings++;
	if (prior) {
		const now = new Set(entries);
		for (const e of entries) if (!prior.set.has(e)) row(ruleOf(e)).added++;
		for (const e of prior.entries) if (!now.has(e)) row(ruleOf(e)).removed++;
	}
	const rules = [...rows.values()].sort((a, b) => b.findings - a.findings || byBytes(a.rule, b.rule));
	return { entries: entries.length, rules };
}

/**
 * Record the backlog.
 *
 * Both counts come back because they are different numbers: several findings
 * collapse into one entry whenever they share a key, and `check` reports the
 * findings it hid, not the entries that hid them.
 */
export function writeBaseline(
	full: string,
	result: AnalyzeResult,
): { path: string; findings: number; entries: number } {
	// The default sits in `.loupe/`, which the first write makes, and a
	// configured one may name a directory that doesn't exist yet. `ensureDir`
	// rather than a bare `mkdirSync` so a bad path fails on the write that wanted
	// it, naming ENOTDIR rather than `EEXIST ... a.css`.
	ensureDir(dirname(full));
	const entries = entriesOf(result);
	// Re-recording the same backlog rewrites the same bytes. A fresh timestamp made
	// this file — which the project is asked to commit — differ from itself, and a
	// conflict-markered baseline is unreadable. It records when the backlog was
	// taken, not when the command was.
	const prior = readBaseline(full);
	const unchanged =
		prior !== null && prior.entries.length === entries.length && prior.entries.every((e, i) => e === entries[i]);
	// Both numbers: `count` is entries, `findings` is what collapsed into them.
	// `count` keeps its meaning so 0.1.x files still parse — until 0.9.0, when it
	// goes (see `BaselineFile.count`).
	const file: BaselineFile = {
		version: 1,
		createdAt: unchanged && prior.createdAt ? prior.createdAt : new Date().toISOString(),
		count: entries.length,
		findings: result.findings.length,
		entries,
	};
	writeFileSync(full, `${JSON.stringify(file, null, 2)}\n`);
	return { path: full, findings: result.findings.length, entries: entries.length };
}

/**
 * Split findings against a baseline.
 *
 * The accepted findings come back whole, not just counted: SARIF lists them as
 * suppressed results, which is what its suppression model is for, and a count
 * alone cannot be listed.
 *
 * `fixed` is only meaningful on a whole-repo run — on a scoped run the absent
 * entries are mostly just out of scope — so it is null there, and with no
 * baseline to compare against. A run narrowed to some rules (`--rule`) still
 * read every file, so it counts only those rules' entries: another rule's are
 * absent because they were filtered out, not because they were fixed. The same
 * goes for a rule the config has off (`enabled`): it reports nothing, so its
 * entries match nothing.
 */
export function applyBaseline(
	result: AnalyzeResult,
	baseline: Baseline | null,
	{
		scoped = false,
		rules = null,
		enabled = null,
	}: {
		scoped?: boolean;
		rules?: ReadonlySet<string> | null;
		enabled?: Readonly<Record<string, boolean>> | null;
	} = {},
): BaselinedResult {
	if (!baseline) return { ...result, baselined: 0, baselinedFindings: [], fixed: null };
	const seen = new Set<string>();
	const kept = [];
	const accepted = [];
	for (const f of result.findings) {
		const key = findingKey(f);
		seen.add(key);
		if (baseline.set.has(key)) accepted.push(f);
		else kept.push(f);
	}
	return {
		...result,
		findings: kept,
		blocking: isBlocking(kept),
		baselined: accepted.length,
		baselinedFindings: accepted,
		fixed: scoped
			? null
			: [...baseline.set].filter((k) => {
					const rule = ruleOf(k);
					return !seen.has(k) && (!rules || rules.has(rule)) && enabled?.[rule] !== false;
				}).length,
	};
}
