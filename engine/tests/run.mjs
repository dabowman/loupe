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
 *     ds-hygiene.config.json   config for the fixture
 *     expected.json            { note, findings: [{ rule, file, line }] }
 *     <sources>
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyze.mjs';
import { loadConfig } from '../src/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

const key = (f) => `${f.rule} @ ${f.file}:${f.line}`;
const only = process.argv[2];

let failed = 0;
let passed = 0;

for (const name of readdirSync(FIXTURES).sort()) {
	if (only && name !== only) continue;
	const root = join(FIXTURES, name);
	const expected = JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8'));

	let actual;
	try {
		const config = await loadConfig({ root, configPath: join(root, 'ds-hygiene.config.json') });
		actual = await analyze(config, { scope: null });
	} catch (err) {
		console.log(`FAIL ${name}\n  threw: ${err.stack}`);
		failed++;
		continue;
	}

	const want = new Set(expected.findings.map(key));
	const got = new Set(actual.findings.map(key));
	const missing = [...want].filter((k) => !got.has(k));
	const extra = [...got].filter((k) => !want.has(k));

	if (!missing.length && !extra.length) {
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
		console.log(`  +  unexpected: ${e}  "${f.message}"`);
	}
	if (actual.diagnostics.parseErrors.length)
		for (const p of actual.diagnostics.parseErrors) console.log(`  !  parse error ${p.file}: ${p.message}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
