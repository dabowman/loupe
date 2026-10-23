#!/usr/bin/env node
/**
 * Fixture-driven tests.
 *
 * Every fixture corresponds to a bug the regex/recursive-walk version had, or
 * to a config seam that must keep working. Once behaviour is config-driven,
 * this is the only thing standing between a preset edit and a rule silently
 * turning itself off.
 *
 *   tests/fixtures/<name>/
 *     loupe.config.json   config for the fixture
 *     expected.json            { note, parseErrors?, findings: [{ rule, file, line }] }
 *     <sources>
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyze.ts';
import { loadConfig } from '../src/config.ts';
import type { AnalyzeResult, Finding } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

/** A fixture's recorded expectation: identity only, never message prose. */
interface Expected {
	note?: string;
	/** The files that may not parse, when a fixture pins it; `[]` means every file parses. */
	parseErrors?: string[];
	findings: Pick<Finding, 'rule' | 'file' | 'line'>[];
}

const key = (f: Pick<Finding, 'rule' | 'file' | 'line'>): string => `${f.rule} @ ${f.file}:${f.line}`;
const files = (paths: readonly string[]): string => [...new Set(paths)].sort().join(', ');
const only = process.argv[2];

let failed = 0;
let passed = 0;

for (const name of readdirSync(FIXTURES).sort()) {
	if (only && name !== only) continue;
	const root = join(FIXTURES, name);
	const expected = JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8')) as Expected;

	let actual: AnalyzeResult;
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		actual = await analyze(config, { scope: null });
	} catch (err) {
		console.log(`FAIL ${name}\n  threw: ${err instanceof Error ? err.stack : String(err)}`);
		failed++;
		continue;
	}

	const want = new Set(expected.findings.map(key));
	const got = new Set(actual.findings.map(key));
	const missing = [...want].filter((k) => !got.has(k));
	const extra = [...got].filter((k) => !want.has(k));
	const unparsed = files(actual.diagnostics.parseErrors.map((p) => p.file));
	const parseDrift = expected.parseErrors !== undefined && unparsed !== files(expected.parseErrors);

	if (!missing.length && !extra.length && !parseDrift) {
		passed++;
		console.log(`ok   ${name}  (${actual.findings.length} finding(s))`);
		continue;
	}

	failed++;
	console.log(`FAIL ${name}`);
	if (expected.note) console.log(`     ${expected.note}`);
	for (const m of missing) console.log(`  -  missing: ${m}`);
	for (const e of extra) {
		const f = actual.findings.find((x) => key(x) === e);
		console.log(`  +  unexpected: ${e}  "${f?.message ?? ''}"`);
	}
	if (parseDrift) console.log(`  !  unparsed: want [${files(expected.parseErrors ?? [])}], got [${unparsed}]`);
	if (actual.diagnostics.parseErrors.length)
		for (const p of actual.diagnostics.parseErrors) console.log(`  !  parse error ${p.file}: ${p.message}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
