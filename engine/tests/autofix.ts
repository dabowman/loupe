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
import { applyKeeps, applyTokenFixes, settledBy } from '../src/autofix.ts';
import { loadConfig } from '../src/config.ts';
import { judgeValues } from '../src/judge.ts';
import { KEEP, emptyTokenSet, harvestTokenDefs, planValue } from '../src/tokens.ts';
import { messageParts } from '../src/text.ts';
import { CLI, assert, check, cleanup, finish, scratch, write, writeAll } from './harness.ts';
import type { Finding, FixCandidate, SkippedFix, TokenFix } from '../src/types.ts';

const CONFIG = JSON.stringify({ extends: 'wpds', namespaces: { project: ['wf-'] } });

const TOKENS = `:root {
	--wpds-border-radius-md: 4px;
	--wpds-color-foreground-content-neutral: #1e1e1e;
	--wpds-color-foreground-content-strong: #1e1e1e;
	--wpds-dimension-space-md: 8px;
	--wpds-typography-font-size-sm: 12px;
	--wpds-typography-line-height-xs: 16px;
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
		out.includes('border-radius: var(--wpds-border-radius-md)') &&
			out.includes('padding: var(--wpds-dimension-space-md)'),
		`one of the two was lost:\n${out}`,
	);
});

await check('the JS channels are never rewritten as CSS', async () => {
	const { applied } = await fixture({
		'src/E.jsx': 'export const E = () => <div className="wf-e" style={{ borderRadius: \'4px\' }} />;',
	});
	assert(!applied.length, `inline style was rewritten: ${JSON.stringify(applied)}`);
});

await check('a stale line number skips rather than guesses', async () => {
	const findings: FixCandidate[] = [
		{
			rule: 'tokens/hardcoded-value',
			file: 'styles/f.css',
			line: 99,
			suggest: [{ prop: 'border-radius', value: '4px', tokens: ['--wpds-border-radius-md'] }],
		},
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
			{
				rule: 'tokens/hardcoded-value',
				file: 'styles/g.css',
				line: 1,
				suggest: [{ prop: 'border-radius', value: '4px', tokens: ['--wpds-border-radius-md'] }],
			},
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

// A collapsed finding is the case a line-exact substitution gets wrong by
// default: `typography/untokenized` reports a CSS rule's whole type block at
// the first declaration's line, and matching the others against that line
// either misses them or edits the wrong one.
await check('every declaration of a collapsed finding is matched against its own line', async () => {
	const { applied, skipped, read, findings } = await fixture({
		'styles/t.css': '.wf-t {\n\tfont-size: 12px;\n\tfont-weight: 500;\n\tline-height: 16px;\n}',
		'src/T.jsx': 'export const T = () => <div className="wf-t" />;',
	});
	const type = findings.filter((f) => f.rule === 'typography/untokenized');
	assert(type.length === 1, `expected one collapsed finding, got ${type.length}`);
	assert(!skipped.length, `nothing should skip: ${skipped.map((s) => s.why).join(', ')}`);
	assert(applied.length === 2, `expected 2 fixes, got ${applied.length}`);
	const out = read('styles/t.css');
	assert(out.includes('font-size: var(--wpds-typography-font-size-sm);'), `font-size not substituted:\n${out}`);
	assert(out.includes('line-height: var(--wpds-typography-line-height-xs);'), `line-height not substituted:\n${out}`);
	// No token carries 500, so that declaration stays and its finding stands.
	assert(out.includes('font-weight: 500;'), `an unmatched value was rewritten:\n${out}`);
	assert(settledBy(findings, applied) === 0, 'a finding with an unsettled declaration is not cleared');
});

await check('a collapsed finding is cleared only once every declaration is settled', async () => {
	const { applied, read, findings } = await fixture({
		'styles/u.css': '.wf-u {\n\tfont-size: 12px;\n\tline-height: 16px;\n}',
		'src/U.jsx': 'export const U = () => <div className="wf-u" />;',
	});
	assert(applied.length === 2, `expected 2 fixes, got ${applied.length}`);
	assert(settledBy(findings, applied) === 1, 'both declarations settled, so the finding is cleared');
	assert(!/\b(12px|16px)\b/.test(read('styles/u.css')), `a literal survived:\n${read('styles/u.css')}`);
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
	assert(
		ten && 'candidates' in ten && ten.candidates.tier === 'near' && !ten.candidates.keep,
		`10px: ${JSON.stringify(ten)}`,
	);
	assert(
		ten.candidates.options.map(([n]) => n).join() === '--wpds-dimension-padding-sm,--wpds-dimension-padding-md',
		'not the steps either side',
	);
	assert(
		twelve && 'token' in twelve && twelve.token === '--wpds-dimension-padding-md',
		`12px: ${JSON.stringify(twelve)}`,
	);
	// A zero is not a literal to replace, and a shorthand's other words are kept.
	const zero = planValue(set, 'padding', '6px 0');
	assert(zero && zero !== 'none' && zero.slots.length === 1 && zero.slots[0]?.at === 0, JSON.stringify(zero));
	const bg = planValue(set, 'background', '#f0c url(x.png) no-repeat');
	assert(bg && bg !== 'none' && bg.slots.length === 1 && bg.slots[0]?.part === '#f0c', JSON.stringify(bg));
	const pink = bg.slots[0];
	assert(
		pink && 'candidates' in pink && pink.candidates.tier === 'family' && pink.candidates.options.length === 2,
		JSON.stringify(pink),
	);
	// Spacing the scale covers only snaps; past its end, or off spacing, it may stay.
	const past = planValue(set, 'padding', '48px');
	const pastSlot = past && past !== 'none' ? past.slots[0] : undefined;
	assert(
		pastSlot && 'candidates' in pastSlot && pastSlot.candidates.tier === 'end' && pastSlot.candidates.keep,
		JSON.stringify(past),
	);
	const radius = planValue(set, 'border-radius', '3px');
	const radiusSlot = radius && radius !== 'none' ? radius.slots[0] : undefined;
	assert(
		radiusSlot && 'candidates' in radiusSlot && radiusSlot.candidates.tier === 'near' && radiusSlot.candidates.keep,
		JSON.stringify(radius),
	);
	// A token for a negative inset flips its sign, and 5% is not on a px scale.
	assert(planValue(set, 'top', '-4px') === null, 'a negative inset was planned');
	assert(planValue(set, 'padding', '5% 8px') === null, 'a half-replaceable value was planned');
	// Nothing to choose from is its own answer.
	assert(planValue(set, 'box-shadow', '0 1px 2px #000') === 'none', 'box-shadow has no family here');
	const cursor = planValue(set, 'cursor', 'default');
	assert(cursor && cursor !== 'none' && 'candidates' in (cursor.slots[0] ?? {}), 'a cursor is a choice among names');
	// An offset is spacing, not the size of an icon.
	const sized = harvestTokenDefs(
		postcss.parse(`${JUDGE_TOKENS}\n:root { --wpds-dimension-size-4xs: 8px; }`),
		['--wpds-'],
		emptyTokenSet(),
	);
	const top = planValue(sized, 'top', '10px');
	assert(top && top !== 'none' && 'candidates' in (top.slots[0] ?? {}), JSON.stringify(top));
	const offered = top.slots[0] && 'candidates' in top.slots[0] ? top.slots[0].candidates.options.map(([n]) => n) : [];
	assert(
		offered.length && !offered.some((n) => n.includes('size')),
		`top was offered a size token: ${offered.join(', ')}`,
	);
});

// The failure that prompted this: a `tokenSources` path that stopped resolving
// left every family empty, and every value read as having no token at all.
await check('--judge refuses an empty token set rather than calling every value tokenless', async () => {
	let called = false;
	const stub = (async () => {
		called = true;
		return new Response('{}');
	}) as unknown as typeof fetch;
	const f = {
		rule: 'tokens/hardcoded-value',
		severity: 'warn',
		rank: 0,
		file: 'a.css',
		line: 1,
		message: 'padding: 10px',
		decl: { prop: 'padding', value: '10px' },
	} as const;
	const findings: Finding[] = [{ ...f, decl: { ...f.decl } }];
	let threw = '';
	try {
		await judgeValues('/nonexistent', findings, emptyTokenSet(), 'key', new Map(), stub);
	} catch (err) {
		threw = err instanceof Error ? err.message : String(err);
	}
	assert(/no design tokens were read/.test(threw), `did not refuse: ${threw || 'no throw'}`);
	assert(!called && findings[0]?.judged === undefined && findings[0]?.message === 'padding: 10px', 'judged anyway');
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
			const questions = JSON.parse(init.body).questions as Record<
				string,
				{ instructions: string; criteria: Record<string, string> }
			>;
			const answers = Object.fromEntries(
				Object.entries(questions).map(([k, q]) => {
					asked.push(q);
					const offers = Object.keys(q.criteria);
					// Under the floor, and applied anyway: in-scale spacing only snaps.
					const pick = offers.includes('--wpds-dimension-padding-sm')
						? { choice: '--wpds-dimension-padding-sm', confidence: 0.3 }
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
		// 10px of padding sits inside the scale, so it can only snap.
		const offersKeep = (q: { criteria: Record<string, string> }): boolean => 'keep' in q.criteria;
		const tenAsk = asked.find((q) => '--wpds-dimension-padding-sm' in q.criteria);
		assert(tenAsk && !offersKeep(tenAsk), 'in-scale padding was offered keep');
		assert(
			asked.filter((q) => q !== tenAsk).every(offersKeep),
			'a question off the spacing scale offered no way to keep the value',
		);
		const pinkAsk = asked.find((q) => '--wpds-color-background-surface-neutral' in q.criteria);
		assert(
			pinkAsk?.criteria['--wpds-color-background-surface-neutral']?.includes('Surfaces with normal emphasis.'),
			'the description was not sent',
		);
		assert(written === 5, `wrote ${written}, expected 5 (padding, three pinks, box-shadow)`);

		const at = (file: string, line: number, prop: string) => {
			const f = result.findings.find((x) => x.file === file && x.line === line && x.decl?.prop === prop);
			assert(f, `no finding for ${prop} at ${file}:${line}`);
			return f;
		};
		const padding = at('styles/card.css', 2, 'padding');
		assert(
			padding.message === 'padding: 10px 12px → --wpds-dimension-padding-sm --wpds-dimension-padding-md (judged 0.30)',
			padding.message,
		);
		// The message names the tokens; the answer stays the CSS `fix` writes.
		assert(
			padding.judged?.answer === 'var(--wpds-dimension-padding-sm) var(--wpds-dimension-padding-md)',
			`judged answer is not the replacement value: ${padding.judged?.answer}`,
		);
		assert(
			padding.judged?.spans.every((s) => padding.message.includes(s)),
			'a span is not in the message',
		);
		assert(
			at('styles/card.css', 3, 'background').message === 'background: #f0c → deliberate, no token fits (judged 0.70)',
			'pink not kept',
		);
		assert(
			at('styles/card.css', 4, 'box-shadow').message.endsWith('→ no box-shadow token in the design system'),
			'box-shadow',
		);
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
			css.includes(
				`\t/* ${config.suppression.keyword} tokens/hardcoded-value -- deliberate, no token fits (judged 0.70) */\n\tbackground: #f0c;`,
			),
			css,
		);
		// The directives parse and mute exactly what they were written for.
		const after = await analyze(config, { scope: ['styles/card.css'] });
		const left = after.findings.map((f) => `${f.rule}:${f.line}`);
		assert(!left.includes('suppression/malformed'), `a directive was malformed: ${left.join(', ')}`);
		const hard = after.findings
			.filter((f) => f.rule === 'tokens/hardcoded-value')
			.map((f) => f.decl?.prop)
			.sort();
		assert(hard.join() === 'background,border-radius,border-radius', `left: ${hard.join()}`);
	} finally {
		cleanup(root);
	}
});

// Each of these once wrote CSS that was wrong in a way no report would show.
// The rule `--judge` was widened to, and the shape the widening is about: one
// finding, three declarations, three different outcomes on three lines.
await check('a collapsed typography finding is judged and fixed declaration by declaration', async () => {
	const root = scratch('dsh-judge-type-');
	try {
		writeAll(root, {
			'loupe.config.json': CONFIG,
			'styles/tokens.css': `${JUDGE_TOKENS}\n:root {\n\t--wpds-typography-font-size-sm: 12px;\n\t--wpds-typography-font-size-md: 13px;\n\t--wpds-typography-font-weight-default: 400;\n\t--wpds-typography-font-weight-emphasis: 600;\n}`,
			'styles/type.css': [
				'.wf-t {',
				'\tfont-size: 12px;',
				'\tfont-weight: 500;',
				'\tletter-spacing: 0.02em;',
				'}',
			].join('\n'),
			'src/T.jsx': 'export const T = () => <div className="wf-t" />;',
		});
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const result = await analyze(config, { scope: null });
		assert(result.tokens, 'analyze did not hand back its token set');
		const type = result.findings.filter((f) => f.rule === 'typography/untokenized');
		assert(type.length === 1, `expected one collapsed finding, got ${type.length}`);
		const f = type[0];
		assert(f?.suggest?.length === 3, `expected three declarations, got ${JSON.stringify(f?.suggest)}`);

		// font-size was exact, so it is never a question; letter-spacing has no
		// family at all, so it is answered without one. Only font-weight is asked.
		const asked: string[] = [];
		const stub = (async (_url: string, init: { body: string }) => {
			const questions = JSON.parse(init.body).questions as Record<string, { criteria: Record<string, string> }>;
			const answers = Object.fromEntries(
				Object.entries(questions).map(([k, q]) => {
					asked.push(Object.keys(q.criteria).join(','));
					return [k, { choice: '--wpds-typography-font-weight-emphasis', confidence: 0.8 }];
				}),
			);
			return new Response(JSON.stringify({ answers }));
		}) as unknown as typeof fetch;
		const written = await judgeValues(root, result.findings, result.tokens, 'key', new Map(), stub);
		assert(asked.length === 1, `asked ${asked.length} questions, expected 1: ${asked.join(' | ')}`);
		assert(written === 2, `wrote ${written}, expected 2 (font-weight, letter-spacing)`);

		const by = Object.fromEntries((f?.suggest ?? []).map((s) => [s.prop, s]));
		assert(by['font-size']?.judged === undefined, 'an exact token was sent to the model');
		assert(by['font-weight']?.judged?.answer === 'var(--wpds-typography-font-weight-emphasis)', 'font-weight');
		assert(by['letter-spacing']?.judged?.answer === KEEP, 'letter-spacing should be kept, tokenless');
		// Each declaration keeps the line it is written on, not the finding's.
		assert([2, 3, 4].join() === (f?.suggest ?? []).map((s) => s.line).join(), JSON.stringify(f?.suggest));
		// Composed as a list, not edited in place. All three remedies fit now that
		// the message names tokens without the `var()` around them: the same list
		// spent 12 characters on two wrappers before, and dropped its third part
		// to `(+1 more)` to pay for them. The message is the display — the answer
		// `fix --judge` acts on is on `suggest`, which is why a part the bound
		// does drop is not a part that is lost.
		assert(
			f?.message ===
				'font-size: 12px → --wpds-typography-font-size-sm; ' +
					'font-weight: 500 → --wpds-typography-font-weight-emphasis (judged 0.80); ' +
					'letter-spacing: 0.02em → no letter-spacing token in the design system',
			f?.message,
		);
		assert(by['letter-spacing']?.judged?.spans.join() === 'no letter-spacing token in the design system', 'lost');

		const fixes = applyTokenFixes(root, result.findings);
		assert(
			fixes.applied.map((x) => `${x.line}:${x.prop}`).join() === '2:font-size,3:font-weight',
			JSON.stringify(fixes),
		);
		const kept = applyKeeps(root, result.findings, config.suppression.keyword);
		assert(kept.applied.map((k) => k.line).join() === '4', JSON.stringify(kept));
		const css = readFileSync(join(root, 'styles/type.css'), 'utf8');
		assert(css.includes('font-size: var(--wpds-typography-font-size-sm);'), css);
		assert(css.includes('font-weight: var(--wpds-typography-font-weight-emphasis);'), css);
		// The suppression names the rule the declaration was reported under.
		assert(css.includes(`/* ${config.suppression.keyword} typography/untokenized -- no letter-spacing token`), css);
		// And it mutes exactly what it was written for: nothing left in this rule.
		const after = await analyze(config, { scope: ['styles/type.css'] });
		assert(!after.findings.some((x) => x.rule === 'typography/untokenized'), JSON.stringify(after.findings));
	} finally {
		cleanup(root);
	}
});

// The list bound, asserted on its own since the fixture above stopped tripping
// it — dropping `var()` from the message freed exactly the room its third part
// needed. A list this cuts mid-token is worse than one it shortens: the remedy
// the reader is meant to act on ends in half a token name, and nothing on the
// line says a fourth remedy existed at all.
await check('an over-long list drops whole parts and counts them', () => {
	const part = (n: number): string =>
		`property-${n}: some-fairly-long-literal-value-${n} \u2192 --design-system-token-name-${n}`;
	const short = messageParts([part(1), part(2)]);
	assert(short === `${part(1)}; ${part(2)}`, `a list that fits was shortened anyway: ${short}`);
	const long = messageParts([part(1), part(2), part(3), part(4)]);
	assert(long.startsWith(part(1)), `the first part did not survive: ${long}`);
	assert(/ \(\+\d+ more\)$/.test(long), `parts were dropped without saying so: ${long}`);
	// Whole parts only: every `\u2192` that made it kept the token it points at.
	for (const piece of long.replace(/ \(\+\d+ more\)$/, '').split('; '))
		assert(/\u2192 --design-system-token-name-\d+$/.test(piece), `a part was cut mid-token: ${piece}`);
});

await check('a value is planned by what it measures, and a part is only what its parentheses close', () => {
	const set = harvestTokenDefs(
		postcss.parse(
			`${JUDGE_TOKENS}\n:root { --wpds-border-width-focus: 2px; --wpds-color-foreground-content-neutral: var(--x); }`,
		),
		['--wpds-'],
		emptyTokenSet(),
	);
	// 0.75rem is 12px: the exact token, not the steps either side of it.
	const rem = planValue(set, 'padding', '0.75rem');
	assert(rem && rem !== 'none' && rem.slots[0] && 'token' in rem.slots[0], JSON.stringify(rem));
	assert(rem.slots[0].token === '--wpds-dimension-padding-md', JSON.stringify(rem));
	// One part, not `rgb(calc(255 * 0.5)` and a stray `0)`.
	const nested = planValue(set, 'background', 'rgb(calc(255 * 0.5) 0 0)');
	assert(nested && nested !== 'none' && nested.parts.length === 1, JSON.stringify(nested));
	// The literal inside calc() has no token, and a var() beside it would hide it.
	assert(planValue(set, 'padding', 'calc(10px + 2px) 8px') === null, 'a calc() part was passed over');
	// A focus ring's width is a border width, and a token that is an alias is still a token.
	assert(planValue(set, 'outline-width', '2px') !== 'none', 'outline-width read as having no token');
	assert(planValue(set, 'color', '#111') === null, 'an alias-only role read as having no token');
});

await check('a keep beside a part that settled on a token leaves the value for review', async () => {
	const root = scratch('dsh-halfkeep-');
	try {
		write(root, 'a.css', '.wf-a {\n\tpadding: 6px 48px;\n}\n');
		const stub = (async (_url: string, init: { body: string }) => {
			const questions = JSON.parse(init.body).questions as Record<string, { criteria: Record<string, string> }>;
			const answers = Object.fromEntries(
				Object.entries(questions).map(([k, q]) => [
					k,
					{ choice: 'keep' in q.criteria ? 'keep' : Object.keys(q.criteria)[0], confidence: 0.9 },
				]),
			);
			return new Response(JSON.stringify({ answers }));
		}) as unknown as typeof fetch;
		const finding: Finding = {
			rule: 'tokens/hardcoded-value',
			severity: 'warn',
			rank: 0,
			file: 'a.css',
			line: 2,
			message: 'padding: 6px 48px',
			decl: { prop: 'padding', value: '6px 48px' },
		};
		// 6px has to snap and 48px, past the scale, may stay: keeping the whole
		// declaration would suppress the 6px along with it.
		const written = await judgeValues(root, [finding], judgeSet(), 'key', new Map(), stub);
		assert(written === 0 && finding.judged === undefined, `settled a half answer: ${JSON.stringify(finding.judged)}`);
	} finally {
		cleanup(root);
	}
});

await check(
	"a kept value is not suppressed from its rule's opening line or under someone else's directive, and keeps the line ending",
	() => {
		const root = scratch('dsh-keeps-');
		try {
			writeAll(root, {
				'styles/open.css': '.wf-a { background: #f0c;\n\tcolor: #0cf;\n}\n',
				'styles/crlf.css': '.wf-b {\r\n\tbackground: #f0c;\r\n}\r\n',
				'styles/taken.css':
					'.wf-c {\n\t/* ds-allow layout/margin-on-child -- legacy grid */\n\tmargin-bottom: 16px; background: #f0c;\n}\n',
			});
			const keep = (file: string, line: number): FixCandidate => ({
				rule: 'tokens/hardcoded-value',
				file,
				line,
				suggest: [
					{
						prop: 'background',
						value: '#f0c',
						tokens: [],
						judged: { answer: 'keep', confidence: 0.9, spans: ['deliberate, no token fits'] },
					},
				],
			});
			const { applied, skipped } = applyKeeps(
				root,
				[keep('styles/open.css', 1), keep('styles/crlf.css', 2), keep('styles/taken.css', 3)],
				'ds-allow',
				{ directives: [{ file: 'styles/taken.css', line: 2 }] },
			);
			assert(skipped.map((k) => k.file).join() === 'styles/open.css,styles/taken.css', JSON.stringify(skipped));
			// Pushed a line up, the margin directive would no longer reach its line.
			assert(
				!readFileSync(join(root, 'styles/taken.css'), 'utf8').includes('tokens/hardcoded-value'),
				'a directive was displaced',
			);
			assert(applied.length === 1, JSON.stringify(applied));
			assert(
				readFileSync(join(root, 'styles/open.css'), 'utf8') === '.wf-a { background: #f0c;\n\tcolor: #0cf;\n}\n',
				'the opening line was suppressed',
			);
			const crlf = readFileSync(join(root, 'styles/crlf.css'), 'utf8');
			assert(
				crlf ===
					'.wf-b {\r\n\t/* ds-allow tokens/hardcoded-value -- deliberate, no token fits */\r\n\tbackground: #f0c;\r\n}\r\n',
				JSON.stringify(crlf),
			);
		} finally {
			cleanup(root);
		}
	},
);

finish();
