#!/usr/bin/env node
/**
 * The deterministic fix path.
 *
 * Every case here is one where a wrong substitution would be invisible: the
 * value is right, the file parses, the report goes clean, and the meaning has
 * quietly changed. That is the whole risk surface of applying a fix without a
 * reader, so it is the whole of this suite.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { analyze } from '../src/analyze.mjs';
import { applyTokenFixes } from '../src/autofix.mjs';
import { loadConfig } from '../src/config.mjs';

let failed = 0;
const check = async (name, fn) => {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failed++;
		console.log(`FAIL ${name}\n     ${err.message}`);
	}
};
const assert = (cond, msg) => {
	if (!cond) throw new Error(msg);
};

const CONFIG = JSON.stringify({ extends: 'wpds', namespaces: { project: ['wf-'] } });

const TOKENS = `:root {
	--wpds-border-radius-md: 4px;
	--wpds-color-foreground-content-neutral: #1e1e1e;
	--wpds-color-foreground-content-strong: #1e1e1e;
	--wpds-dimension-space-md: 8px;
}`;

/** Analyze a throwaway repo, apply fixes, hand back what the files now say. */
async function fixture(files) {
	const root = mkdtempSync(join(tmpdir(), 'dsh-fix-'));
	try {
		const all = { 'ds-hygiene.config.json': CONFIG, 'styles/tokens.css': TOKENS, ...files };
		for (const [rel, body] of Object.entries(all)) {
			const p = join(root, rel);
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, body);
		}
		const config = await loadConfig({ root, configPath: join(root, 'ds-hygiene.config.json') });
		const result = await analyze(config, { scope: null });
		const outcome = applyTokenFixes(root, result.findings);
		// Read before the cleanup below: a closure over `root` would resolve
		// against a directory this function has already removed.
		const after = Object.fromEntries(Object.keys(all).map((rel) => [rel, readFileSync(join(root, rel), 'utf8')]));
		return { ...outcome, read: (rel) => after[rel], findings: result.findings };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

await check('an unambiguous value is substituted, and !important survives', async () => {
	const { applied, read } = await fixture({
		'styles/a.css': '.wf-a {\n\tborder-radius: 4px;\n\tpadding: 8px !important;\n}',
	});
	assert(applied.length === 2, `expected 2 fixes, got ${applied.length}`);
	const out = read('styles/a.css');
	assert(out.includes('border-radius: var(--wpds-border-radius-md);'), `radius not substituted:\n${out}`);
	assert(out.includes('padding: var(--wpds-dimension-space-md) !important;'), `important lost:\n${out}`);
});

await check('an ambiguous value is left alone', async () => {
	// Two foreground tokens carry #1e1e1e. Picking by array order is how you get
	// the right pixels and the wrong meaning — the failure this path exists to
	// avoid. (An off-role match is already filtered out upstream: a background
	// token is never offered for `color`.)
	const { applied, read } = await fixture({ 'styles/b.css': '.wf-b {\n\tcolor: #1e1e1e;\n}' });
	assert(!applied.length, `expected no fix, got ${applied.map((f) => f.token).join(', ')}`);
	assert(read('styles/b.css').includes('#1e1e1e'), 'value should be untouched');
});

await check('a property is not matched inside a longer property name', async () => {
	const { applied, read } = await fixture({
		'styles/c.css': '.wf-c {\n\t-webkit-border-radius: 4px;\n\tborder-radius: 4px;\n}',
	});
	const out = read('styles/c.css');
	assert(out.includes('-webkit-border-radius: 4px;'), `prefixed property was rewritten:\n${out}`);
	assert(applied.length === 1, `expected 1 fix, got ${applied.length}`);
});

await check('two fixes on one line both land', async () => {
	const { applied, read } = await fixture({ 'styles/d.css': '.wf-d { border-radius: 4px; padding: 8px; }' });
	const out = read('styles/d.css');
	assert(applied.length === 2, `expected 2 fixes, got ${applied.length}`);
	assert(
		out.includes('border-radius: var(--wpds-border-radius-md)') && out.includes('padding: var(--wpds-dimension-space-md)'),
		`one of the two was lost:\n${out}`
	);
});

await check('the JS channels are never rewritten as CSS', async () => {
	const { applied } = await fixture({
		'src/E.jsx': "export const E = () => <div className=\"wf-e\" style={{ borderRadius: '4px' }} />;",
	});
	assert(!applied.length, `inline style was rewritten: ${JSON.stringify(applied)}`);
});

await check('a stale line number skips rather than guesses', async () => {
	const findings = [
		{ rule: 'tokens/hardcoded-value', file: 'styles/f.css', line: 99, suggest: [{ prop: 'border-radius', value: '4px', tokens: ['--wpds-border-radius-md'] }] },
	];
	const root = mkdtempSync(join(tmpdir(), 'dsh-fix-'));
	try {
		mkdirSync(join(root, 'styles'), { recursive: true });
		writeFileSync(join(root, 'styles/f.css'), '.wf-f { border-radius: 4px; }');
		const { applied, skipped } = applyTokenFixes(root, findings);
		assert(!applied.length && skipped.length === 1, 'a line that does not exist must skip');
		assert(readFileSync(join(root, 'styles/f.css'), 'utf8').includes('4px'), 'file must be untouched');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await check('--dry-run reports without writing', async () => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-fix-'));
	try {
		mkdirSync(join(root, 'styles'), { recursive: true });
		writeFileSync(join(root, 'styles/g.css'), '.wf-g { border-radius: 4px; }');
		const findings = [
			{ rule: 'tokens/hardcoded-value', file: 'styles/g.css', line: 1, suggest: [{ prop: 'border-radius', value: '4px', tokens: ['--wpds-border-radius-md'] }] },
		];
		const { applied } = applyTokenFixes(root, findings, { dry: true });
		assert(applied.length === 1, 'dry run still reports the fix');
		assert(readFileSync(join(root, 'styles/g.css'), 'utf8').includes('4px'), 'dry run must not write');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

console.log(`\n${failed ? `${failed} failed` : 'all passed'}`);
process.exit(failed ? 1 : 0);
