#!/usr/bin/env node
/**
 * The deterministic fix path.
 *
 * Every case here is one where a wrong substitution would be invisible: the
 * value is right, the file parses, the report goes clean, and the meaning has
 * quietly changed. That is the whole risk surface of applying a fix without a
 * reader, so it is the whole of this suite.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { analyze } from '../src/analyze.ts';
import { applyKeeps, applyTokenFixes } from '../src/autofix.ts';
import { loadConfig } from '../src/config.ts';
import { judgeValues } from '../src/judge.ts';
import { emptyTokenSet, harvestTokenDefs, planValue } from '../src/tokens.ts';
import { CLI, assert, check, cleanup, finish, scratch, write, writeAll } from './harness.ts';
import type { Finding, FixCandidate, SkippedFix, TokenFix } from '../src/types.ts';

const CONFIG = JSON.stringify({ extends: 'wpds', namespaces: { project: ['wf-'] } });

const TOKENS = `:root {
	--wpds-border-radius-md: 4px;
	--wpds-color-foreground-content-neutral: #1e1e1e;
	--wpds-color-foreground-content-strong: #1e1e1e;
	--wpds-dimension-space-md: 8px;
}`;

interface Fixture {
	applied: TokenFix[];
	skipped: SkippedFix[];
	read: (rel: string) => string;
	findings: Finding[];
}

/** Analyze a throwaway repo, apply fixes, hand back what the files now say. */
async function fixture(files: Record<string, string>): Promise<Fixture> {
	const root = scratch('dsh-fix-');
	try {
		const all = { 'loupe.config.json': CONFIG, 'styles/tokens.css': TOKENS, ...files };
		writeAll(root, all);
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const result = await analyze(config, { scope: null });
		const outcome = applyTokenFixes(root, result.findings);
		// Read before the cleanup below: a closure over `root` would resolve
		// against a directory this function has already removed.
		const after = new Map(Object.keys(all).map((rel) => [rel, readFileSync(join(root, rel), 'utf8')]));
		return {
			...outcome,
			read: (rel: string): string => {
				const text = after.get(rel);
				assert(text !== undefined, `fixture did not write ${rel}`);
				return text;
			},
			findings: result.findings,
		};
	} finally {
		cleanup(root);
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
	assert(!applied.length, `expected no fix, got ${applied.map((f) => f.to).join(', ')}`);
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
	const findings: FixCandidate[] = [
		{ rule: 'tokens/hardcoded-value', file: 'styles/f.css', line: 99, suggest: [{ prop: 'border-radius', value: '4px', tokens: ['--wpds-border-radius-md'] }] },
	];
	const root = scratch('dsh-fix-');
	try {
		write(root, 'styles/f.css', '.wf-f { border-radius: 4px; }');
		const { applied, skipped } = applyTokenFixes(root, findings);
		assert(!applied.length && skipped.length === 1, 'a line that does not exist must skip');
		assert(readFileSync(join(root, 'styles/f.css'), 'utf8').includes('4px'), 'file must be untouched');
	} finally {
		cleanup(root);
	}
});

await check('--dry-run reports without writing', async () => {
	const root = scratch('dsh-fix-');
	try {
		write(root, 'styles/g.css', '.wf-g { border-radius: 4px; }');
		const findings: FixCandidate[] = [
			{ rule: 'tokens/hardcoded-value', file: 'styles/g.css', line: 1, suggest: [{ prop: 'border-radius', value: '4px', tokens: ['--wpds-border-radius-md'] }] },
		];
		const { applied } = applyTokenFixes(root, findings, { dry: true });
		assert(applied.length === 1, 'dry run still reports the fix');
		assert(readFileSync(join(root, 'styles/g.css'), 'utf8').includes('4px'), 'dry run must not write');
	} finally {
		cleanup(root);
	}
});

// What `fix` skips is what it prints, and a declaration spanning source lines
// is exactly the case it skips — the substitution is matched against one line.
// The value is held raw on purpose, since that is what the match needs, so this
// is the one place the flattening belongs at the print site rather than at
// capture.
await check('a skipped multi-line declaration is reported on one line', async () => {
	const root = scratch('dsh-fix-');
	try {
		writeAll(root, {
			'loupe.config.json': CONFIG,
			'styles/tokens.css': ':root { --wpds-shadow-md: 0 1px 2px rgba(0, 0, 0, 0.12), 0 4px 12px rgba(0, 0, 0, 0.08); }',
			'styles/s.css': '.wf-s {\n\tbox-shadow: 0 1px 2px rgba(0, 0, 0, 0.12),\n\t\t0 4px 12px rgba(0, 0, 0, 0.08);\n}',
			'src/S.jsx': 'export const S = () => <div className="wf-s" />;',
		});
		const out = execFileSync('node', [CLI, 'fix', '--dry-run', '--root', root], { encoding: 'utf8' });
		const skips = out.split('\n').filter((l) => l.startsWith('skip'));
		assert(skips.length === 1, `expected one skip line, got ${skips.length}:\n${out}`);
		// Counting the lines that START with `skip` cannot see the failure: a
		// declaration spilling across output lines leaves continuations that begin
		// with the source's own indentation, and those are filtered out rather
		// than counted. So the spill is checked for directly.
		assert(!out.split('\n').some((l) => /^\s+\S/.test(l)), `output spilled onto an indented line:\n${out}`);
		assert(skips[0]?.includes('box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12), 0 4px 12px'), `not flattened: ${skips[0]}`);
	} finally {
		cleanup(root);
	}
});

// ── fix --judge ─────────────────────────────────────────────────────────────

const JUDGE_TOKENS = `:root {
	--wpds-dimension-padding-xs: 4px;
	--wpds-dimension-padding-sm: 8px;
	--wpds-dimension-padding-md: 12px;
	--wpds-color-background-surface-neutral: #fcfcfc;
	--wpds-color-background-surface-brand: #ecf0fa;
	--wpds-border-radius-sm: 2px;
	--wpds-border-radius-md: 4px;
	--wpds-cursor-control: pointer;
}`;

const judgeSet = () => harvestTokenDefs(postcss.parse(JUDGE_TOKENS), ['--wpds-'], emptyTokenSet());

// What the planner decides is what the model is never asked about, so a wrong
// call here is a wrong question or, worse, a substitution nobody judged.
await check('a flagged value is planned part by part, and what code can settle is not asked', () => {
	const set = judgeSet();
	const plan = planValue(set, 'padding', '10px 12px');
	assert(plan && plan !== 'none', `no plan: ${String(plan)}`);
	const [ten, twelve] = plan.slots;
	assert(ten && 'candidates' in ten && ten.candidates.tier === 'near', `10px: ${JSON.stringify(ten)}`);
	assert(ten.candidates.options.map(([n]) => n).join() === '--wpds-dimension-padding-sm,--wpds-dimension-padding-md', 'not the steps either side');
	assert(twelve && 'token' in twelve && twelve.token === '--wpds-dimension-padding-md', `12px: ${JSON.stringify(twelve)}`);
	// A zero is not a literal to replace, and a shorthand's other words are kept.
	const zero = planValue(set, 'padding', '6px 0');
	assert(zero && zero !== 'none' && zero.slots.length === 1 && zero.slots[0]?.at === 0, JSON.stringify(zero));
	const bg = planValue(set, 'background', '#f0c url(x.png) no-repeat');
	assert(bg && bg !== 'none' && bg.slots.length === 1 && bg.slots[0]?.part === '#f0c', JSON.stringify(bg));
	const pink = bg.slots[0];
	assert(pink && 'candidates' in pink && pink.candidates.tier === 'family' && pink.candidates.options.length === 2, JSON.stringify(pink));
	// A token for a negative inset flips its sign, and 5% is not on a px scale.
	assert(planValue(set, 'top', '-4px') === null, 'a negative inset was planned');
	assert(planValue(set, 'padding', '5% 8px') === null, 'a half-replaceable value was planned');
	// Nothing to choose from is its own answer.
	assert(planValue(set, 'box-shadow', '0 1px 2px #000') === 'none', 'box-shadow has no family here');
	const cursor = planValue(set, 'cursor', 'default');
	assert(cursor && cursor !== 'none' && 'candidates' in (cursor.slots[0] ?? {}), 'a cursor is a choice among names');
});

// Offline: the stub answers by what each question offers, so the check is on
// what gets asked, what gets written, and what `fix --judge` does with it.
await check('fix --judge rewrites what it settled, suppresses what it kept, and leaves the rest', async () => {
	const root = scratch('dsh-judge-fix-');
	try {
		writeAll(root, {
			'loupe.config.json': CONFIG,
			'styles/tokens.css': JUDGE_TOKENS,
			'styles/card.css': [
				'.wf-card {',
				'\tpadding: 10px 12px;',
				'\tbackground: #f0c;',
				'\tbox-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);',
				'\tborder-radius: 3px;',
				'}',
				'.wf-row { background: #f0c; border-radius: 3px; }',
			].join('\n'),
			'src/A.jsx': "export const A = () => <div style={{ background: '#f0c' }} />;",
		});
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const result = await analyze(config, { scope: null });
		assert(result.tokens, 'analyze did not hand back its token set');
		const asked: { instructions: string; criteria: Record<string, string> }[] = [];
		const stub = (async (_url: string, init: { body: string }) => {
			const questions = JSON.parse(init.body).questions as Record<string, { instructions: string; criteria: Record<string, string> }>;
			const answers = Object.fromEntries(
				Object.entries(questions).map(([k, q]) => {
					asked.push(q);
					const offers = Object.keys(q.criteria);
					const pick = offers.includes('--wpds-dimension-padding-sm')
						? { choice: '--wpds-dimension-padding-sm', confidence: 0.8 }
						: offers.includes('--wpds-border-radius-md')
							? { choice: '--wpds-border-radius-md', confidence: 0.3 }
							: { choice: 'keep', confidence: 0.7 };
					return [k, pick];
				}),
			);
			return new Response(JSON.stringify({ answers }));
		}) as unknown as typeof fetch;
		const about = new Map([['--wpds-color-background-surface-neutral', 'Surfaces with normal emphasis.']]);
		const written = await judgeValues(root, result.findings, result.tokens, 'key', about, stub);

		// 10px, the card's pink, both radii, the row's pink and the inline pink:
		// 12px was exact and box-shadow has no family, so neither is a question.
		assert(asked.length === 6, `asked ${asked.length} questions, expected 6`);
		assert(asked.every((q) => 'keep' in q.criteria), 'a question offered no way to keep the value');
		const pinkAsk = asked.find((q) => '--wpds-color-background-surface-neutral' in q.criteria);
		assert(pinkAsk?.criteria['--wpds-color-background-surface-neutral']?.includes('Surfaces with normal emphasis.'), 'the description was not sent');
		assert(written === 5, `wrote ${written}, expected 5 (padding, three pinks, box-shadow)`);

		const at = (file: string, line: number, prop: string) => {
			const f = result.findings.find((x) => x.file === file && x.line === line && x.decl?.prop === prop);
			assert(f, `no finding for ${prop} at ${file}:${line}`);
			return f;
		};
		const padding = at('styles/card.css', 2, 'padding');
		assert(
			padding.message === 'padding: 10px 12px → var(--wpds-dimension-padding-sm) var(--wpds-dimension-padding-md) (judged 0.80)',
			padding.message,
		);
		assert(padding.judged?.spans.every((s) => padding.message.includes(s)), 'a span is not in the message');
		assert(at('styles/card.css', 3, 'background').message === 'background: #f0c → deliberate, no token fits (judged 0.70)', 'pink not kept');
		assert(at('styles/card.css', 4, 'box-shadow').message.endsWith('→ no box-shadow token in the design system'), 'box-shadow');
		assert(at('styles/card.css', 5, 'border-radius').judged === undefined, 'a sub-floor pick was recorded');
		// The channel marker stays last.
		const inline = at('src/A.jsx', 1, 'background');
		assert(inline.message === 'background: #f0c → deliberate, no token fits (judged 0.70) (inline)', inline.message);

		const fixes = applyTokenFixes(root, result.findings);
		assert(fixes.applied.length === 1 && fixes.applied[0]?.line === 2, `fixes: ${JSON.stringify(fixes.applied)}`);
		const kept = applyKeeps(root, result.findings, config.suppression.keyword);
		assert(kept.applied.map((k) => k.line).join() === '3,4', `kept: ${JSON.stringify(kept.applied)}`);
		const why = Object.fromEntries(kept.skipped.map((k) => [`${k.file}:${k.line}`, k.why]));
		// A directive mutes a whole line, and the row's radius was never settled.
		assert(why['styles/card.css:7']?.includes('shares its line'), JSON.stringify(why));
		assert(why['src/A.jsx:1'] === 'not a stylesheet', JSON.stringify(why));

		const css = readFileSync(join(root, 'styles/card.css'), 'utf8');
		assert(css.includes('\tpadding: var(--wpds-dimension-padding-sm) var(--wpds-dimension-padding-md);'), css);
		assert(
			css.includes(`\t/* ${config.suppression.keyword} tokens/hardcoded-value -- deliberate, no token fits (judged 0.70) */\n\tbackground: #f0c;`),
			css,
		);
		// The directives parse and mute exactly what they were written for.
		const after = await analyze(config, { scope: ['styles/card.css'] });
		const left = after.findings.map((f) => `${f.rule}:${f.line}`);
		assert(!left.includes('suppression/malformed'), `a directive was malformed: ${left.join(', ')}`);
		const hard = after.findings.filter((f) => f.rule === 'tokens/hardcoded-value').map((f) => f.decl?.prop).sort();
		assert(hard.join() === 'background,border-radius,border-radius', `left: ${hard.join()}`);
	} finally {
		cleanup(root);
	}
});

finish();
