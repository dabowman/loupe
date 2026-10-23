#!/usr/bin/env node
/**
 * The report formats.
 *
 * The HTML report renders client-side from the JSON payload, which buys one
 * guarantee and creates one hazard, and both are checked here.
 *
 * The guarantee: the page and `--format json` cannot describe different
 * findings. Nothing enforces that except the fact that the page reads the same
 * bytes — so the first test is the enforcement.
 *
 * The hazard: those bytes are inlined into a `<script>` block, where a finding's
 * own text is in a position to close it. Findings routinely carry CSS-in-JS
 * source, so this is a live case, and a page that breaks on the one repo whose
 * code contains the wrong substring is a page nobody can trust.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, findingKey } from '../src/analyze.ts';
import { applyBaseline } from '../src/baseline.ts';
import { setColor } from '../src/color.ts';
import { loadConfig } from '../src/config.ts';
import { formatAgent, formatSarif, reportPayload } from '../src/report.ts';
import { formatHtml } from '../src/report-html.ts';
import { DIR_CAP, paneFromPayload, panePayload } from '../src/report-pane.ts';
import { CLI, PLUGIN_DATA, assert, check, cleanup, execFailure, finish, one, scratch, writeAll } from './harness.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
import type { AnalyzeResult, Baseline, Config, Finding } from '../src/types.ts';

async function run(files: Record<string, string>): Promise<{ result: AnalyzeResult; config: Config; root: string }> {
	const root = scratch('loupe-report-');
	writeAll(root, files);
	const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
	return { result: await analyze(config, { scope: null }), config, root };
}

const CONFIG = '{ "extends": "wordpress-components", "namespaces": { "project": ["wf-"] } }';

const DRIFTY = {
	'loupe.config.json': CONFIG,
	'src/App.jsx': `
import { Stack, Text, Card } from '@wordpress/components';
export default () => (
  <Card className="wf-card">
    <Stack className="wf-row"><Text className="wf-label">hi</Text></Stack>
  </Card>
);
`,
	'styles/app.css': `
.wf-card { padding: 12px; background: #ffffff; }
.wf-row { display: flex; gap: 8px; margin-bottom: 16px; }
.wf-label { font-size: 13px; font-weight: 600; }
.wf-gone { color: #757575; }
`,
};

/** Pull the embedded payload back out of a rendered page, the way the page itself does. */
function embedded(html: string): unknown {
	const m = /<script type="application\/json" id="loupe-data">([\s\S]*?)<\/script>/.exec(html);
	assert(m?.[1], 'no #loupe-data block in the page');
	return JSON.parse(m[1]);
}

const { result, config, root } = await run(DRIFTY);
assert(result.findings.length > 3, `fixture produced only ${result.findings.length} findings`);

await check('html embeds exactly what --format json prints', () => {
	const page = embedded(formatHtml(result, config)) as { findings: unknown[] };
	assert(
		JSON.stringify(page) === JSON.stringify(reportPayload(result, config)),
		'the page and the JSON describe different reports',
	);
	// The equality above holds by construction while both read one payload
	// builder, and is here to fail the day someone gives the page its own field
	// selection. This second assertion is the one that can fail today: it holds
	// the shared builder to the analysis it was handed.
	assert(page.findings.length === result.findings.length, 'the payload lost findings on the way out');
});

await check('a finding that contains </script> cannot end the data block', () => {
	const hostile = '</script><script>document.title="pwned"</script><!--';
	const doctored: AnalyzeResult = {
		...result,
		findings: result.findings.map((f, i) => (i === 0 ? { ...f, message: hostile } : f)),
	};
	const html = formatHtml(doctored, config);
	const block = /<script type="application\/json" id="loupe-data">([\s\S]*?)<\/script>/.exec(html);
	assert(block?.[1], 'the hostile message ended the data block early');
	// Not merely "it parses" — the value must survive intact, or the escaping
	// would be free to pass this test by mangling the finding.
	const payload = JSON.parse(block[1]) as { findings: { message: string }[] };
	assert(payload.findings[0]?.message === hostile, 'the message did not survive embedding');
	assert(!block[1].includes('<'), 'a raw < remains inside the data block');
});

await check('a clean result renders a page rather than an empty one', () => {
	const clean: AnalyzeResult = { ...result, findings: [], blocking: false };
	const html = formatHtml(clean, config);
	assert(html.includes('clean'), 'the clean page does not say so');
	const payload = embedded(html) as { summary: { total: number } };
	assert(payload.summary.total === 0, 'the clean page carries findings');
});

await check('a clean page still names the files that could not be read', () => {
	// `stylesheet/unparsed` can be off, baselined, or out of scope, and then a
	// parse error leaves no finding behind. Without the banner the page reports
	// that files it never opened had nothing wrong with them.
	const clean: AnalyzeResult = {
		...result,
		findings: [],
		blocking: false,
		diagnostics: { ...result.diagnostics, parseErrors: [{ file: 'styles/broken.scss', message: 'Unclosed block' }] },
	};
	const html = formatHtml(clean, config);
	assert(html.includes('could not be parsed'), 'the clean page hid an unparsed file');
	const payload = embedded(html) as { summary: { parseErrors: number } };
	assert(payload.summary.parseErrors === 1, 'the clean payload lost the parse error');
});

await check('the page is one file — no external requests', () => {
	const html = formatHtml(result, config);
	assert(!/<(script|link|img)[^>]+(src|href)=/i.test(html), 'the page loads something over the network');
});

await check('the palette has a plain value under every light-dark() one', () => {
	// A custom property accepts any value, so an unguarded `light-dark()` wins in
	// a browser that cannot compute it, and every colour reading it is lost.
	const css = /<style>([\s\S]*?)<\/style>/.exec(formatHtml(result, config))?.[1] ?? '';
	const at = css.indexOf('@supports (color: light-dark(#000, #000))');
	assert(at > 0, 'no @supports guard around the light-dark() palette');
	const plain = css.slice(0, at);
	assert(!plain.includes('light-dark('), 'a light-dark() value sits outside the @supports guard');
	const themed = [...css.slice(at).matchAll(/(--[\w-]+): light-dark\(/g)].map((m) => m[1] ?? '');
	assert(themed.length > 0, 'the guard declares no themed properties');
	for (const name of themed) assert(plain.includes(`${name}: `), `${name} has no plain fallback`);
});

await check('summary.baselined is absent when no baseline step ran', () => {
	const bare = reportPayload(result, config);
	assert(!('baselined' in bare.summary), 'an un-baselined run reported a baselined count');
	const withBaseline = reportPayload({ ...result, baselined: 4, fixed: 0 }, config);
	assert(withBaseline.summary.baselined === 4, 'the baselined count did not survive');
});

await check('the payload version names the shape config.rules has', () => {
	// Version 2 is the one without `options`: a shape change that ships under an
	// unchanged version is one no consumer can detect.
	const payload = reportPayload(result, config);
	assert(payload.version === 2, `the payload is version ${payload.version}`);
	for (const [id, setting] of Object.entries(payload.config.rules))
		assert(
			JSON.stringify(Object.keys(setting)) === '["severity"]',
			`${id} carries ${JSON.stringify(setting)} — a new shape needs a new version`,
		);
});

// A repo whose whole backlog is accepted printed `total: 0` and `results: []`,
// with nothing to tell it from a clean one. The counts go in the JSON summary;
// SARIF lists the accepted findings as suppressed, which is what its
// suppression model is for.
/** The run above with its first finding accepted, plus one entry nothing matches any more. */
const baselineOf = (keys: string[]): Baseline => {
	const entries = [...keys, 'tokens/hardcoded-value|styles/gone.css|.wf-gone { color: #000; }'];
	return { createdAt: '', entries, set: new Set(entries) };
};

await check('json carries the baselined finding count and the fixed entry count', () => {
	const accepted = result.findings[0];
	assert(accepted, 'no findings to baseline');
	const baseline = baselineOf([findingKey(accepted)]);
	const whole = reportPayload(applyBaseline(result, baseline), config);
	const hidden = result.findings.filter((f) => findingKey(f) === findingKey(accepted)).length;
	assert(whole.summary.baselined === hidden, `baselined ${whole.summary.baselined}, expected ${hidden}`);
	assert(whole.summary.total === result.findings.length - hidden, 'the accepted findings are still in the total');
	assert(whole.summary.fixed === 1, `fixed ${whole.summary.fixed}, expected the one entry nothing matched`);
	// A scoped run cannot tell fixed from out of scope, so it does not guess.
	const scoped = reportPayload(applyBaseline(result, baseline, { scoped: true }), config);
	assert(!('fixed' in scoped.summary), 'a scoped run reported a fixed count');
	// `--rule` reads every file but filters the other rules out: their entries
	// are absent, not fixed, so only the named rules' entries are counted.
	const other = reportPayload(applyBaseline(result, baseline, { rules: new Set(['layout/margin-on-child']) }), config);
	assert(other.summary.fixed === 0, `fixed ${other.summary.fixed} under --rule for another rule`);
	const same = reportPayload(applyBaseline(result, baseline, { rules: new Set(['tokens/hardcoded-value']) }), config);
	assert(same.summary.fixed === 1, `fixed ${same.summary.fixed} under --rule for the gone entry's rule`);
	assert(!('fixed' in reportPayload(applyBaseline(result, null), config).summary), 'no baseline, yet a fixed count');
});

await check('sarif lists baselined findings as externally suppressed results', () => {
	const accepted = result.findings[0];
	assert(accepted, 'no findings to baseline');
	const applied = applyBaseline(result, baselineOf([findingKey(accepted)]));
	const sarif = JSON.parse(formatSarif(applied, config)) as {
		runs: {
			tool: { driver: { rules: { id: string }[] } };
			results: {
				ruleId: string;
				partialFingerprints: { loupeCode: string };
				suppressions?: { kind: string; justification: string }[];
			}[];
			properties?: { baselined: number; fixed?: number };
		}[];
	};
	const runOut = sarif.runs[0];
	assert(runOut, 'no sarif run');
	const suppressed = runOut.results.filter((r) => r.suppressions);
	assert(runOut.results.length === result.findings.length, 'baselined findings were dropped, not listed');
	assert(suppressed.length === applied.baselined, `${suppressed.length} suppressed, ${applied.baselined} baselined`);
	for (const r of suppressed) {
		const [s] = r.suppressions ?? [];
		assert(s?.kind === 'external' && /baseline/.test(s.justification), `wrong suppression: ${JSON.stringify(s)}`);
		assert(
			runOut.tool.driver.rules.some((d) => d.id === r.ruleId),
			`${r.ruleId} is suppressed but not in the driver`,
		);
	}
	assert(
		runOut.results.slice(0, applied.findings.length).every((r) => !r.suppressions),
		'a live finding was marked suppressed',
	);
	assert(
		new Set(runOut.results.map((r) => r.partialFingerprints.loupeCode)).size === runOut.results.length,
		'a suppressed result shares a fingerprint',
	);
	assert(
		runOut.properties?.baselined === applied.baselined && runOut.properties.fixed === 1,
		`run properties: ${JSON.stringify(runOut.properties)}`,
	);
	// Unbaselined output is unchanged: no suppressions, no run properties.
	const plain = JSON.parse(formatSarif(result, config)) as typeof sarif;
	assert(!plain.runs[0]?.properties, 'a run with no baseline step carries baseline counts');
});

await check('the rules roster resolves title placeholders', () => {
	const payload = reportPayload(result, config);
	assert(payload.rules.length > 0, 'no rules in the roster');
	assert(!payload.rules.some((r) => r.title.includes('{')), 'a rule title shipped an unresolved placeholder');
	// Richest first, the order every format prints in.
	const ranks = payload.rules.map((r) => r.rank);
	assert(
		ranks.every((r, i) => i === 0 || (ranks[i - 1] ?? 0) >= r),
		'the rules roster is not ordered by rank',
	);
});

await check('sarif fingerprints survive a line move', () => {
	const sarif = JSON.parse(formatSarif(result, config)) as {
		runs: { results: { partialFingerprints: { loupeCode: string } }[] }[];
	};
	const before = sarif.runs[0]?.results.map((r) => r.partialFingerprints.loupeCode) ?? [];
	assert(before.length === result.findings.length, 'not every result carries a fingerprint');
	// The whole point: an edit above a finding must not re-open its alert.
	const moved = JSON.parse(
		formatSarif({ ...result, findings: result.findings.map((f) => ({ ...f, line: f.line + 40 })) }, config),
	) as typeof sarif;
	const after = moved.runs[0]?.results.map((r) => r.partialFingerprints.loupeCode) ?? [];
	assert(JSON.stringify(before) === JSON.stringify(after), 'a fingerprint moved with its line number');
});

await check('no two sarif results share a fingerprint', () => {
	// The identity a fingerprint is built on drops the line number on purpose, so
	// one file declaring the same value twice yields two findings with one key.
	// Code scanning matches an alert on rule plus fingerprint: leave the two
	// alike and the second finding never becomes an alert at all.
	const twice = result.findings[0];
	assert(twice, 'no findings to duplicate');
	const doubled: AnalyzeResult = { ...result, findings: [...result.findings, { ...twice, line: twice.line + 12 }] };
	const sarif = JSON.parse(formatSarif(doubled, config)) as {
		runs: { results: { ruleId: string; partialFingerprints: { loupeCode: string } }[] }[];
	};
	const results = sarif.runs[0]?.results ?? [];
	const keys = new Set(results.map((r) => `${r.ruleId}|${r.partialFingerprints.loupeCode}`));
	assert(keys.size === results.length, `${results.length} results share ${keys.size} fingerprints`);
});

await check('sarif rules carry a namespace tag and a pointer to the guidance', () => {
	const sarif = JSON.parse(formatSarif(result, config)) as {
		runs: { tool: { driver: { rules: { id: string; help: { text: string }; properties: { tags: string[] } }[] } } }[];
	};
	const rules = sarif.runs[0]?.tool.driver.rules ?? [];
	assert(rules.length > 0, 'no rules in the sarif driver');
	for (const r of rules) {
		assert(r.properties.tags[0] === r.id.split('/')[0], `${r.id} is tagged ${String(r.properties.tags[0])}`);
		assert(r.help.text.includes(r.id), `${r.id} has no pointer to its guidance`);
	}
});

cleanup(root);

await check('an unparsed stylesheet is keyed without the path it was read from', async () => {
	// postcss opens its error with the absolute path it was handed, and `code`
	// is part of the baseline key: left in, the key holds one machine's checkout
	// and a committed baseline matches on no other.
	const { result, root } = await run({
		'loupe.config.json': CONFIG,
		'styles/broken.css': '.wf-row { color: #757575;',
	});
	try {
		const f = one(
			result.findings.filter((x) => x.rule === 'stylesheet/unparsed'),
			'stylesheet/unparsed finding',
		);
		assert(f.file === 'styles/broken.css', `the finding names ${f.file}`);
		for (const text of [f.message, ...result.diagnostics.parseErrors.map((e) => e.message)])
			assert(!text.includes('broken.css') && /^\d+:\d+: /.test(text), `a parse error kept its path: ${text}`);
	} finally {
		cleanup(root);
	}
});

// The code was the message, position and all, so a line added above the error
// made it a different finding — to the baseline and to the hook's pre-edit
// comparison alike. And a sheet naming its source map reported the error at
// the original file's absolute path, which no other clone has.
await check('an unparsed stylesheet is keyed on the reason, not the position or a source map', async () => {
	const { result, root } = await run({
		'loupe.config.json': CONFIG,
		'css/a.css': '/* built */\n.a { color: red; }\n.b { color: blue;\n/*# sourceMappingURL=a.css.map */\n',
		'css/a.css.map': JSON.stringify({
			version: 3,
			file: 'a.css',
			sources: ['../scss/a.scss'],
			names: [],
			mappings: 'AAAA;AACA;AACA',
		}),
	});
	try {
		const f = one(
			result.findings.filter((x) => x.rule === 'stylesheet/unparsed'),
			'stylesheet/unparsed finding',
		);
		assert(f.code === 'Unclosed block', `the code is not the bare reason: ${f.code}`);
		assert(!/scss|\//.test(f.message), `the message names the source map's original: ${f.message}`);
	} finally {
		cleanup(root);
	}
});

await check('findings, directives and tallies are in byte order, not the locale’s', async () => {
	// `localeCompare` puts `a` before `B` and may skip the `-`, and answers
	// differently under another `LANG`: the same run would print in a different
	// order on a CI box than on a laptop.
	const sheet =
		'.wf-x { color: #757575; }\n/* wpds-allow tokens/hardcoded-value -- kept */\n.wf-y { color: #757575; }\n';
	const { result, config, root } = await run({
		'loupe.config.json': CONFIG,
		'styles/a.css': sheet,
		'styles/B.css': sheet,
		'styles/-c.css': sheet,
	});
	try {
		const expected = ['styles/-c.css', 'styles/B.css', 'styles/a.css'];
		const order = (files: readonly string[]): string[] => files.filter((f, i) => files.indexOf(f) === i);
		const first = result.findings[0];
		assert(first, 'the fixture produced no findings');
		const findings = order(result.findings.filter((f) => f.rule === first.rule).map((f) => f.file));
		assert(JSON.stringify(findings) === JSON.stringify(expected), `findings ran ${findings.join(', ')}`);
		const directives = order(result.directives.map((d) => d.file));
		assert(JSON.stringify(directives) === JSON.stringify(expected), `directives ran ${directives.join(', ')}`);
		const byFile = Object.keys(reportPayload(result, config).summary.byFile);
		assert(JSON.stringify(byFile) === JSON.stringify(expected), `the tally ran ${byFile.join(', ')}`);
		assert(!formatHtml(result, config).includes('localeCompare'), 'the page sorts by the reader’s locale');
		const grouped = execFileSync(process.execPath, [CLI, 'suppressions', '--group-by', 'file'], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, NO_COLOR: '1' },
		});
		const heads = grouped.split('\n').flatMap((l) => /^(\S+\.css) \(\d+\)$/.exec(l)?.[1] ?? []);
		assert(JSON.stringify(heads) === JSON.stringify(expected), `suppressions --group-by ran ${heads.join(', ')}`);
	} finally {
		cleanup(root);
	}
});

await check('composite findings carry the key their cluster is grouped on', async () => {
	// Three files assembling the same shape: one defect, reported three times,
	// and only `group` puts the three back together.
	const composite = (name: string): string => `
import { Card, CardBody, Stack, Heading, Text, Button } from '@wordpress/components';
export default function ${name}() {
  return <Card><CardBody><Stack><Heading>a</Heading><Text>b</Text><Button>c</Button></Stack></CardBody></Card>;
}
`;
	const { result: r, root: dir } = await run({
		'loupe.config.json': CONFIG,
		'src/A.jsx': composite('A'),
		'src/B.jsx': composite('B'),
		'src/C.jsx': composite('C'),
	});
	try {
		const composites = r.findings.filter((f) => f.rule === 'patterns/unregistered-composite');
		assert(composites.length >= 3, `expected a cluster, got ${composites.length} composite findings`);
		assert(
			composites.every((f) => typeof f.group === 'string' && f.group.length > 0),
			'a composite finding has no group',
		);
		const files = new Set(composites.filter((f) => f.group === composites[0]?.group).map((f) => f.file));
		assert(files.size === 3, `the cluster spans ${files.size} files, expected 3`);
		// Every other rule leaves it unset: `group` means "one member of an N-way
		// relation", and a rule that sets it on a single-file finding says nothing.
		assert(
			r.findings.filter((f) => !f.rule.startsWith('patterns/')).every((f) => f.group === undefined),
			'a non-composite finding carries a cluster key',
		);
	} finally {
		cleanup(dir);
	}
});

await check('an unknown --format is rejected, not silently treated as agent', () => {
	const dir = scratch('loupe-fmt-');
	writeAll(dir, DRIFTY);
	try {
		execFileSync(process.execPath, [CLI, 'check', '--all', '--format', 'sarf'], { cwd: dir, encoding: 'utf8' });
		throw new Error('a misspelled format exited 0');
	} catch (err) {
		const e = execFailure(err);
		assert(e.status === 2, `expected exit 2 (cannot run), got ${String(e.status)}`);
		assert(
			e.stderr.includes('sarf') && e.stderr.includes('html'),
			`stderr did not name the valid formats: ${e.stderr}`,
		);
	} finally {
		cleanup(dir);
	}
});

// Same hazard, same answer: a `--group-by fil` that fell through to the default
// would print a perfectly good report in the order nobody asked for, and there
// is nothing in the output to say so.
await check('an unknown --group-by is rejected, not silently treated as rule', () => {
	const dir = scratch('loupe-group-');
	writeAll(dir, DRIFTY);
	try {
		execFileSync(process.execPath, [CLI, 'check', '--all', '--group-by', 'fil'], { cwd: dir, encoding: 'utf8' });
		throw new Error('a misspelled grouping exited 0');
	} catch (err) {
		const e = execFailure(err);
		assert(e.status === 2, `expected exit 2 (cannot run), got ${String(e.status)}`);
		assert(e.stderr.includes('fil') && e.stderr.includes('file'), `stderr did not name the valid axes: ${e.stderr}`);
	} finally {
		cleanup(dir);
	}
});

// ── --rule ──────────────────────────────────────────────────────────────────
// Batch remediation is one rule across the repo, and the way an agent narrowed to
// one was piping `--format json` through an inline script. A flag now, scoping
// `check` and `fix` alike.

const RULED = {
	'loupe.config.json': JSON.stringify({ extends: 'generic', rules: { 'layout/margin-on-child': 'error' } }),
	'styles/a.css': '.a { margin-bottom: 8px; padding: 13px; }\n.b { margin-bottom: 8px; }',
	'styles/b.css': '.c { margin-top: 2px; padding: 7px; }',
};

/** Exit code and both streams, whichever way the run ended. */
function cli(dir: string, ...argv: string[]): { status: number | null; stdout: string; stderr: string } {
	const r = spawnSync(process.execPath, [CLI, ...argv], { cwd: dir, encoding: 'utf8' });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

await check('--rule scopes check to the rules it names, and may repeat', () => {
	const dir = scratch('loupe-rule-');
	writeAll(dir, RULED);
	try {
		const rules = (...argv: string[]): string[] =>
			(JSON.parse(cli(dir, 'check', '--all', '--format', 'json', ...argv).stdout) as { findings: Finding[] }).findings
				.map((f) => f.rule)
				.sort();
		const all = rules();
		assert(new Set(all).size === 2, `fixture should fire two rules: ${all.join(', ')}`);
		const scoped = rules('--rule', 'layout/margin-on-child');
		assert(
			scoped.length === 3 && scoped.every((r) => r === 'layout/margin-on-child'),
			`scoped to: ${scoped.join(', ')}`,
		);
		// The same two ways `--files` takes a list, and the legacy alias.
		assert(
			rules('--rule', 'layout/margin-on-child', '--rule', 'tokens/hardcoded-value').join() === all.join(),
			'a repeat dropped a rule',
		);
		assert(
			rules('--rule', 'layout/margin-on-child,tokens/hardcoded-value').join() === all.join(),
			'a comma list dropped a rule',
		);
		assert(rules('--rule', 'R3').join() === scoped.join(), 'the alias did not resolve');
	} finally {
		cleanup(dir);
	}
});

// The gate answers for what was reported: a run scoped away from the only
// blocking rule has nothing blocking in it.
await check('--rule decides the exit code from what it kept', () => {
	const dir = scratch('loupe-rule-');
	writeAll(dir, RULED);
	try {
		assert(cli(dir, 'check', '--all').status === 1, 'the fixture should block unscoped');
		const advisory = cli(dir, 'check', '--all', '--rule', 'tokens/hardcoded-value');
		assert(advisory.status === 0, `advisory-only exited ${String(advisory.status)}:\n${advisory.stdout}`);
		assert(!/margin/.test(advisory.stdout), `the scoped report kept another rule:\n${advisory.stdout}`);
	} finally {
		cleanup(dir);
	}
});

// A misspelled id filters every finding out, and the report would say `clean`.
await check('an unknown --rule is rejected before the walk, not read as clean', () => {
	const dir = scratch('loupe-rule-');
	writeAll(dir, RULED);
	try {
		for (const command of ['check', 'fix']) {
			const r = cli(dir, command, '--all', '--rule', 'layout/margin-on-chld');
			assert(r.status === 2, `${command}: expected exit 2 (cannot run), got ${String(r.status)}`);
			assert(r.stderr.includes('layout/margin-on-chld'), `${command}: stderr did not name the id: ${r.stderr}`);
			assert(!r.stdout, `${command} reported anyway:\n${r.stdout}`);
		}
	} finally {
		cleanup(dir);
	}
});

await check('--rule scopes fix to the findings it names', () => {
	const dir = scratch('loupe-rule-');
	writeAll(dir, RULED);
	try {
		const r = cli(dir, 'fix', '--all', '--dry-run', '--rule', 'tokens/hardcoded-value');
		assert(r.status === 0, `fix exited ${String(r.status)}: ${r.stderr}`);
		assert(/ of 2 finding\(s\) left/.test(r.stdout), `fix counted findings outside the rule:\n${r.stdout}`);
	} finally {
		cleanup(dir);
	}
});

await check('--format html writes a whole document to stdout', () => {
	const dir = scratch('loupe-html-');
	writeAll(dir, DRIFTY);
	try {
		let out = '';
		try {
			out = execFileSync(process.execPath, [CLI, 'check', '--all', '--format', 'html'], { cwd: dir, encoding: 'utf8' });
		} catch (err) {
			// Exit 1 is the blocking-findings contract, not a failure to run.
			const e = execFailure(err);
			assert(e.status === 1, `expected exit 0 or 1, got ${String(e.status)}: ${e.stderr}`);
			out = e.stdout;
		}
		assert(out.startsWith('<!doctype html>'), 'stdout is not a document');
		assert(
			out.includes('<!-- loupe:begin -->') && out.includes('<!-- loupe:end -->'),
			'the fragment markers are missing',
		);
		one([...out.matchAll(/<script type="application\/json" id="loupe-data">/g)], 'expected exactly one data block');
	} finally {
		cleanup(dir);
	}
});

/**
 * Colour.
 *
 * The whole of the risk is in one direction: an escape sequence reaching a
 * reader that is not a terminal. Two of those readers are load-bearing — the
 * agent, which is handed the hook's stderr verbatim, and any parser of
 * `--format json` — and neither of them would fail loudly. So the first three
 * checks are all negative, and the fourth exists only so a colour scheme that
 * silently stopped emitting anything cannot pass the other three.
 */
const ESC = /\u001B\[/;

function runColor(argv: readonly string[], extra: NodeJS.ProcessEnv, input?: string) {
	const dir = scratch('loupe-color-');
	writeAll(dir, DRIFTY);
	try {
		const r = spawnSync(process.execPath, [CLI, ...argv], {
			cwd: dir,
			encoding: 'utf8',
			env: { ...process.env, CLAUDE_PLUGIN_DATA: PLUGIN_DATA, ...extra },
			...(input === undefined ? {} : { input }),
		});
		if (r.error) throw r.error;
		return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
	} finally {
		cleanup(dir);
	}
}

await check('a piped run emits no escape sequences', () => {
	const { stdout } = runColor(['check', '--all'], { NO_COLOR: '', FORCE_COLOR: '' });
	assert(stdout.includes('css/dead-class'), `no report at all:\n${stdout}`);
	assert(!ESC.test(stdout), 'a non-tty run coloured its output');
});

await check('the hook never colours the report it hands back', () => {
	// FORCE_COLOR is the strongest "yes" the module takes, so a hook that stays
	// plain under it stays plain under anything.
	const { stdout, stderr } = runColor(
		['hook'],
		{ FORCE_COLOR: '1', LOUPE: 'on' },
		JSON.stringify({ session_id: 'colour', tool_input: { file_path: 'styles/app.css' } }),
	);
	assert(stderr.includes('loupe') || stdout.includes('loupe'), `the hook said nothing at all:\n${stderr}${stdout}`);
	assert(!ESC.test(stderr), `the agent was handed ANSI: ${JSON.stringify(stderr)}`);
	assert(!ESC.test(stdout), `the systemMessage carries ANSI: ${JSON.stringify(stdout)}`);
});

await check('a machine format stays parseable under FORCE_COLOR', () => {
	const { stdout } = runColor(['check', '--all', '--format', 'json'], { FORCE_COLOR: '1' });
	assert(!ESC.test(stdout), 'json output was coloured');
	JSON.parse(stdout);
});

await check('FORCE_COLOR does colour the human report', () => {
	const { stdout } = runColor(['check', '--all'], { FORCE_COLOR: '1' });
	assert(ESC.test(stdout), `colour never turns on:\n${JSON.stringify(stdout)}`);
	const { stdout: off } = runColor(['check', '--all', '--no-color'], { FORCE_COLOR: '1' });
	assert(!ESC.test(off), '--no-color did not turn it off');
});

await check('--version names the version, the entry and the install', () => {
	const out = runColor(['--version'], { NO_COLOR: '1' }).stdout;
	const manifest = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as { version: string };
	assert(out.startsWith(`loupe ${manifest.version} (source, `), `expected the manifest version from source: ${out}`);
	assert(out.trim().endsWith(`, ${resolve(HERE, '..', '..')})`), `should end with the plugin root: ${out}`);
	const status = runColor(['status', '--no-color'], {}).stdout;
	assert(
		status.includes(`version:    loupe ${manifest.version}`),
		`status should carry the same line: ${status.split('\n')[0]}`,
	);
});

await check('rules, config keys and help wear their own colours', () => {
	const { stdout } = runColor(['check', '--all'], { FORCE_COLOR: '1' });
	assert(/\u001B\[35mcss\/dead-class/.test(stdout), `the rule id is not in rule colour:\n${JSON.stringify(stdout)}`);

	const status = runColor(['status'], { FORCE_COLOR: '1' }).stdout;
	assert(/\u001B\[2mnamespaces: /.test(status), `a config key went unpainted:\n${status}`);
	assert(/\u001B\[35mcss\/dead-class/.test(status), `status prints rule ids in another colour:\n${status}`);

	const help = runColor(['--help'], { FORCE_COLOR: '1' }).stdout;
	assert(/\u001B\[36m--changed/.test(help), `an option went unpainted:\n${help}`);
	assert(/\u001B\[1mcheck/.test(help), `a command went unpainted:\n${help}`);
	// The text is also what `--help | grep` reads, and a pipe is not a terminal.
	const piped = runColor(['--help'], { NO_COLOR: '1' }).stdout;
	assert(!ESC.test(piped) && /^ {2}--changed /m.test(piped), `piped help is not plain:\n${piped}`);
});

await check('component names are painted, and only at print time', () => {
	const { stdout } = runColor(['check', '--all'], { FORCE_COLOR: '1' });
	assert(/\u001B\[36m<Text>/.test(stdout), `a JSX mention went unpainted:\n${JSON.stringify(stdout)}`);

	// The load-bearing half: `findingKey` falls back to `message`, so a name
	// painted any earlier than the print site would rewrite every baseline key
	// the moment someone ran this in a terminal.
	const dir = scratch('loupe-color-key-');
	writeAll(dir, DRIFTY);
	try {
		const colour = { ...process.env, FORCE_COLOR: '1' };
		const recorded = spawnSync(process.execPath, [CLI, 'baseline'], { cwd: dir, encoding: 'utf8', env: colour });
		assert(recorded.status === 0, `baseline failed: ${recorded.stderr}`);
		assert(!ESC.test(readFileSync(join(dir, '.loupe/baseline.json'), 'utf8')), 'the baseline file carries ANSI');
		const after = spawnSync(process.execPath, [CLI, 'check', '--all'], { cwd: dir, encoding: 'utf8', env: colour });
		assert(
			/clean\./.test(after.stdout),
			`a baseline written in colour no longer matches its own findings:\n${after.stdout}`,
		);
	} finally {
		cleanup(dir);
	}
});

// ── the near-miss note ───────────────────────────────────────────────────────
// A directive that names the right rule in the right file and still mutes
// nothing is the most expensive thing to debug from the report alone: the
// stated hint has been followed, the finding is unchanged, and the blocked-turn
// message is byte-identical on every retry. So the report says where it sits
// and where it had to.

await check('a directive that missed its anchor is named, with both line numbers', async () => {
	const { result, config, root } = await run({
		'loupe.config.json': CONFIG,
		'src/A.jsx': [
			'export const A = () => (',
			'\t<>',
			'\t\t<p className="wf-note">x</p>',
			'\t\t{ /* wpds-allow system/raw-element -- written below the element it meant */ }',
			'\t</>',
			');',
		].join('\n'),
		'styles/a.css': '.wf-note { color: red }',
	});
	try {
		const out = formatAgent(result, config);
		assert(/directive is on src\/A\.jsx:4/.test(out), `did not name where the directive sits:\n${out}`);
		assert(/anchors to line 3/.test(out), `did not name where it had to sit:\n${out}`);
	} finally {
		cleanup(root);
	}
});

// Two rules on one node cannot be two stacked comments — only the nearest line
// is read — so the note has to name the comma list rather than send someone to
// displace a suppression that is already doing its job.
await check('a taken anchor line is answered with the comma form, not a move', async () => {
	const { result, config, root } = await run({
		'loupe.config.json': CONFIG,
		'src/A.jsx': [
			'export const A = () => (',
			'\t<>',
			'\t\t{ /* wpds-allow system/raw-element -- reason A */ }',
			'\t\t{ /* wpds-allow system/inline-style -- reason B */ }',
			'\t\t<p className="wf-note" style={ { margin: 0 } }>x</p>',
			'\t</>',
			');',
		].join('\n'),
		'styles/a.css': '.wf-note { color: red }',
	});
	try {
		const out = formatAgent(result, config);
		assert(/system\/inline-style, system\/raw-element -- <reason>/.test(out), `did not offer the comma list:\n${out}`);
	} finally {
		cleanup(root);
	}
});

await check('a clean report carries no near-miss noise', async () => {
	const { result, config, root } = await run({
		'loupe.config.json': CONFIG,
		'src/A.jsx': 'export const A = () => <div />;',
	});
	try {
		assert(!/directive is on/.test(formatAgent(result, config)), 'nothing to say should say nothing');
	} finally {
		cleanup(root);
	}
});

// The report could not say anything about what it was not saying: the
// suppression count sat behind an option no caller ever passed, so a repo with
// its whole blocking backlog muted by directives printed the same report as one
// with nothing to mute. An agent that read one told its user the codebase was
// clean. Every line asserted here replaced a second run of the tool.
await check('a clean report still says what was scanned and what is silenced', async () => {
	const { result, config, root } = await run({
		'loupe.config.json': CONFIG,
		'src/A.jsx': 'export const A = () => <div />;',
	});
	try {
		const silenced: AnalyzeResult = {
			...result,
			directives: [
				{ file: 'src/A.jsx', line: 1, rules: ['system/override'], reason: 'r' },
				{ file: 'src/B.jsx', line: 2, rules: ['system/override', 'tokens/hardcoded-value'], reason: 'r' },
			],
		};
		const out = formatAgent(silenced, config);
		assert(out.startsWith('loupe: clean.'), `the tally is not the first line:\n${out}`);
		assert(/\d+ file\(s\) scanned\./.test(out), `a clean verdict with no idea what it read:\n${out}`);
		// Two directives, three rules named between them: the count is directives,
		// the tallies are what they silence, and they are allowed to disagree.
		assert(/2 active suppression\(s\) in 2 file\(s\)/.test(out), `the directives went unmentioned:\n${out}`);
		assert(/system\/override \(2\)/.test(out), `the count did not say what it silences:\n${out}`);
		assert(
			!/active suppression/.test(formatAgent(silenced, config, { terse: true })),
			'the hook does not want a repo-wide inventory',
		);
	} finally {
		cleanup(root);
	}
});

// A registry note used to be concatenated into `message`, which the finalize
// pass caps — so `... it wanted Stack, not Grid.` was cut mid-word, in
// `--format json` as much as in the report, and nothing could recover it. The
// note is its own field now: the line below is the one format with a budget.
await check('a registry note keeps its last clause on screen and ships whole in json', () => {
	const note =
		'Planned for deprecation per its own Storybook status. Write the grid in CSS; ' +
		'if this is really a flex row or column it wanted Stack, not Grid.';
	const noted: AnalyzeResult = { ...result, findings: result.findings.map((f, i) => (i === 0 ? { ...f, note } : f)) };
	const out = formatAgent(noted, config);
	assert(/not Grid\.\)/.test(out), `the actionable end of the note was cut:\n${out}`);
	assert(
		/\(\d+(?: in \d+ files?)?(?:, \d+ distinct)?\) (blocking|advisory) \u2014/.test(out),
		`a rule group that only says its severity in a glyph:\n${out}`,
	);
	const shipped = reportPayload(noted, config).findings[0]?.note;
	assert(shipped === note, `json shipped a note the reader cannot act on: ${String(shipped)}`);
});

// The note was cut a character count from its end, so the line read
// "…t` names a typographic scale" — mid-word, inside a backticked name. It is
// cut between clauses now, or left to JSON when not even its last one fits,
// and the message it follows is never what gives way.
await check('a long registry note is cut between clauses or left off, never mid-word', () => {
	/** What the report printed after `message`, which it must print whole. */
	const after = (message: string, note: string): string => {
		const noted: AnalyzeResult = {
			...result,
			findings: result.findings.map((f, i) => (i === 0 ? { ...f, message, note } : f)),
		};
		const out = formatAgent(noted, config);
		const line = out.split('\n').find((l) => l.includes(message));
		assert(line, `the message was not printed whole:\n${out}`);
		return line.slice(line.indexOf(message) + message.length);
	};
	/** Nothing, or the note's last whole clauses in brackets, an ellipsis standing for the rest. */
	const wholeClauses = (shown: string, note: string): boolean => {
		if (shown === '') return true;
		const m = /^ \((…?)(.+)\)$/.exec(shown);
		if (!m?.[2] || !note.endsWith(m[2])) return false;
		const dropped = note.slice(0, note.length - m[2].length);
		if (!m[1]) return dropped === '';
		return /(?:\. |; | -- |: )$/.test(dropped) && (dropped.match(/`/g) ?? []).length % 2 === 0;
	};

	const text =
		"Not a specifier swap: @wordpress/ui's Text has only `variant` -- no size/weight/color/align/truncate -- " +
		"and its `variant` names a typographic scale (`body-md`, `heading-lg`) where the old one's only value was `muted`.";
	const shown = after('Text (@wordpress/components) → Text (@wordpress/ui)', text);
	assert(wholeClauses(shown, text), `the note was cut inside a clause: ${shown}`);

	const short = 'Use Stack, not Grid.';
	const whole = after('Grid (@wordpress/components) → Stack (@wordpress/ui)', short);
	assert(whole === ` (${short})`, `a note that fits was shortened: ${whole}`);

	// The note takes only what a long message leaves, and keeps its last clause in it.
	const long = `<div> → <Stack> (@wordpress/ui) — ${'x'.repeat(130)}`;
	const squeezed = after(long, 'Planned for deprecation. It wanted Stack, not Grid.');
	assert(squeezed === ' (…It wanted Stack, not Grid.)', `the last clause did not take what was left: ${squeezed}`);
	// A colon inside a backticked value is not a clause boundary.
	const quoted = after(long, 'Set `display: grid` on the parent instead of here');
	assert(quoted === '', `the note was cut inside a backtick span: ${quoted}`);
});

// A reading is not a parse, and the report says which is which at a glance —
// without nesting a colour, which would end the green at the component name.
await check('what --judge wrote is painted green, and nothing else on the line is', () => {
	const judged = { answer: 'body-sm', confidence: 0.84, spans: ['variant="body-sm"', '(judged 0.84)'] };
	const withJudge: AnalyzeResult = {
		...result,
		findings: result.findings.map((f, i) =>
			i === 0 ? { ...f, message: '<p> \u2192 <Text variant="body-sm"> (judged 0.84)', note: undefined, judged } : f,
		),
	};
	setColor(true);
	try {
		const out = formatAgent(withJudge, config);
		for (const span of judged.spans)
			assert(out.includes(`\u001B[32m${span}\u001B[0m`), `"${span}" was not painted on its own:\n${out}`);
		assert(
			out.includes('<p> \u2192 \u001B[36m<Text\u001B[0m '),
			`the component the variant belongs to lost its colour:\n${out}`,
		);
		assert((out.match(/\u001B\[32m/g) ?? []).length === 2, 'a parse-only finding was painted as judged');
	} finally {
		setColor(false);
	}
});

// `@wordpress/theme` moved its stylesheet out of `src/`, the preset kept
// pointing at the old path, and `tokens/unknown-token` — which fires only on a
// non-empty set, so a project declaring no sources is not told every token it
// writes is unknown — quietly switched off. An invented `--wpds-font-size-13`
// passed, and the report said `clean`.
await check('a prefix with no tokens behind it is said out loud, not failed open', async () => {
	const { result, config, root } = await run({
		'loupe.config.json': CONFIG,
		'src/A.jsx': 'export const A = () => <div />;',
	});
	try {
		const starved: AnalyzeResult = { ...result, diagnostics: { ...result.diagnostics, tokensKnown: 0 } };
		const out = formatAgent(starved, config);
		assert(/no .+ tokens were found/.test(out), `the rule went off without saying so:\n${out}`);
		assert(/designSystem\.tokenSources/.test(out), `named the symptom and not where to fix it:\n${out}`);
		const fed: AnalyzeResult = { ...result, diagnostics: { ...result.diagnostics, tokensKnown: 167 } };
		assert(!/tokens were found/.test(formatAgent(fed, config)), 'a healthy token set should say nothing');
		const summary = reportPayload(starved, config).summary;
		assert(summary.tokensKnown === 0, `json hid the empty set: ${summary.tokensKnown}`);
	} finally {
		cleanup(root);
	}
});

// ── grouping ────────────────────────────────────────────────────────────────
// The path used to ride on every finding line, so a rule firing forty times in
// one file printed that path forty times. Both orders are a nesting now: a
// heading, its counterpart as a sub-heading, and a bare line number under that.
// The axes swap and nothing else about the report does — which is the half that
// is easy to break, so it is the half asserted hardest.

/** The count, and how it concentrates once there is more than one. */
const RULE_HEAD = /^([✗•]) (\S+\/\S+) \((\d+)(?:(?: in \d+ files?)?, \d+ distinct)?\) (blocking|advisory) — /;
const FILE_HEAD = /^(\S+\.(?:css|jsx)) \((\d+)\)$/;
/** A finding line: six spaces, a right-aligned line number, the message. */
const NUMBERED = /^ {6} *\d+ {2}\S/;

// `DRIFTY` puts every finding in one stylesheet, which cannot tell a file
// grouping from a rule grouping — both would print one heading. Three files,
// so the axes are actually distinguishable and the budget has somewhere to
// spread.
const spread = await run({
	'loupe.config.json': CONFIG,
	'src/App.jsx': 'export const App = () => <div className="wf-card"><span className="wf-row">hi</span></div>;',
	'styles/a.css': '.wf-card { padding: 12px; margin-bottom: 16px; }',
	'styles/b.css': '.wf-row { font-size: 13px; color: #757575; }',
});

await check('both groupings nest, and neither repeats a path per finding', () => {
	const { result, config } = spread;
	const byRule = formatAgent(result, config, { group: 'rule' });
	const byFile = formatAgent(result, config, { group: 'file' });
	const lines = (out: string, re: RegExp, indent: string): string[] =>
		out.split('\n').filter((l) => re.test(l.startsWith(indent) ? l.slice(indent.length) : '\u0000'));

	for (const [mode, out] of [
		['rule', byRule],
		['file', byFile],
	] as const) {
		// The old shape, and the one thing both modes exist to stop printing.
		const perLine = out.split('\n').filter((l) => NUMBERED.test(l) && /\.(css|jsx):\d+/.test(l));
		assert(!perLine.length, `--group-by ${mode} still prints a path per finding:\n${perLine.join('\n')}`);
		// Every finding reached a line, under exactly one heading pair.
		const numbered = out.split('\n').filter((l) => NUMBERED.test(l));
		assert(
			numbered.length === result.findings.length,
			`--group-by ${mode} printed ${numbered.length} of ${result.findings.length} findings:\n${out}`,
		);
	}

	// Rule first: the rule and its remedy at the margin, the path indented under
	// it. Asserted on the indent as well as the text, since two headings at the
	// same indent read as two groups rather than one nesting.
	assert(lines(byRule, RULE_HEAD, '').length > 1, `--group-by rule did not head on rules:\n${byRule}`);
	assert(lines(byRule, FILE_HEAD, '  ').length > 0, `--group-by rule did not sub-head on paths:\n${byRule}`);
	assert(!lines(byRule, FILE_HEAD, '').length, `--group-by rule put a path at the margin:\n${byRule}`);
	// File first: the same two, swapped.
	assert(lines(byFile, FILE_HEAD, '').length > 1, `--group-by file did not head on paths:\n${byFile}`);
	assert(lines(byFile, RULE_HEAD, '  ').length > 0, `--group-by file did not sub-head on rules:\n${byFile}`);
	assert(!lines(byFile, RULE_HEAD, '').length, `--group-by file put a rule at the margin:\n${byFile}`);

	// Same findings either way — only what they are filed under changes.
	const numbered = (out: string): string =>
		out
			.split('\n')
			.filter((l) => NUMBERED.test(l))
			.map((l) => l.trim())
			.sort()
			.join('\n');
	assert(
		numbered(byRule) === numbered(byFile),
		`the two groupings disagree:\n${numbered(byRule)}\n--\n${numbered(byFile)}`,
	);
});

// The budget is spent round-robin across whatever the reader is being shown, so
// no one group can eat it. Grouped by file that has to be files: a rule-keyed
// quota would spend the whole cap inside the first file and leave the rest of
// the repo behind a count, which is the opposite of what this grouping is for.
await check('a capped report spreads its budget across the axis it groups on', () => {
	const capped = formatAgent(spread.result, spread.config, { group: 'file', maxFindings: 2 });
	const heads = capped.split('\n').filter((l) => FILE_HEAD.test(l));
	assert(heads.length > 1, `the cap was spent inside one file:\n${capped}`);
	assert(/… \d+ more/.test(capped), `nothing said what the cap hid:\n${capped}`);
	assert(/\d+ finding\(s\) not shown/.test(capped), `no way back to the full list:\n${capped}`);
});

// ── collapsing ──────────────────────────────────────────────────────────────
// The same declaration seven times in one file is the ordinary case, and listed
// one by one it spent seven of the hook's twelve lines on one decision. One line
// with a count now, and the heading says how concentrated the rule is.

const dupes = await run({
	'loupe.config.json': JSON.stringify({ extends: 'generic', rules: { 'layout/margin-on-child': 'warn' } }),
	'styles/step.css': [
		'.a { margin-bottom: 8px; }',
		'.b { margin-top: 2px; }',
		'.c { margin-bottom: 8px; }',
		'.d { margin-top: 12px; }',
		'.e { margin-bottom: 8px; }',
		'.f { margin-bottom: 8px; }',
		'.g { margin-bottom: 8px; }',
	].join('\n'),
	'styles/other.css': '.x { margin-bottom: 8px; }\n.y { margin-bottom: 8px; }',
});
const margins = dupes.result.findings.filter((f) => f.rule === 'layout/margin-on-child');

await check('identical findings print once, with a count and every line they stand for', () => {
	assert(margins.length === 9, `fixture produced ${margins.length} margin findings, not 9`);
	const out = formatAgent(dupes.result, dupes.config);
	assert(
		/layout\/margin-on-child \(9 in 2 files, 3 distinct\)/.test(out),
		`the heading did not say how the rule concentrates:\n${out}`,
	);
	assert(
		/ {6}1 {2}margin-bottom: 8px {2}×5 \(lines 1, 3, 5, 6, 7\)$/m.test(out),
		`five became one line badly:\n${out}`,
	);
	assert(
		/ {6}1 {2}margin-bottom: 8px {2}×2 \(lines 1, 2\)$/m.test(out),
		`the other file's pair did not collapse:\n${out}`,
	);
	// `code` is the property alone for a margin, so these share it — and are still
	// two declarations, which a line printing one under the other's count would hide.
	assert(/ {6}2 {2}margin-top: 2px$/m.test(out), `a singleton was folded into something:\n${out}`);
	assert(/ {6}4 {2}margin-top: 12px$/m.test(out), `a different value collapsed by its code:\n${out}`);
	const numbered = out.split('\n').filter((l) => NUMBERED.test(l));
	assert(numbered.length === 4, `expected 4 lines for 9 findings, got ${numbered.length}:\n${out}`);
	// Grouped by file the rule is the sub-heading, and its file is the heading.
	const byFile = formatAgent(dupes.result, dupes.config, { group: 'file' });
	assert(/^ {2}• layout\/margin-on-child \(7, 3 distinct\) advisory/m.test(byFile), `nested heading:\n${byFile}`);
});

// Collapsing makes the budget go further; it does not change what it is.
await check('the budget counts printed lines, so duplicates do not eat it', () => {
	const two = formatAgent(dupes.result, dupes.config, { maxFindings: 2 });
	// Two lines of budget, seven findings on them: the two singletons are what is left.
	assert(/×5/.test(two) && /×2/.test(two), `the budget did not reach both batches:\n${two}`);
	assert(/2 finding\(s\) not shown/.test(two), `two lines did not stand for seven findings:\n${two}`);
	// One line: the largest batch is the one that tells the reader the most.
	const single = formatAgent(dupes.result, dupes.config, { maxFindings: 1 });
	assert(/×5/.test(single), `the largest batch was not the one shown:\n${single}`);
	assert(single.split('\n').filter((l) => NUMBERED.test(l)).length === 1, `the cap of one printed more:\n${single}`);
	assert(/… 4 more/.test(single), `the count of what the cap hid is not in findings:\n${single}`);
	assert(/4 finding\(s\) not shown/.test(single), `the total hidden is not in findings:\n${single}`);
});

// The collapse keyed on the painted line, which the line bound caps: two
// findings with different codes and the same capped text merged into one
// "×2", counted as one distinct. And past ten lines the rest went unlisted with
// nothing to say how many.
await check('a collapsed line is the same finding, and says how many lines it did not list', () => {
	const { config } = dupes;
	const at = (line: number, code: string): Finding => ({
		rule: 'layout/margin-on-child',
		severity: 'warn',
		rank: 1,
		file: 'styles/x.css',
		line,
		code,
		message: 'margin-bottom: 8px (.acme-card-h\u2026',
	});
	const apart = formatAgent(
		{ ...dupes.result, findings: [at(4, '.acme-card-head'), at(6, '.acme-card-hint')] },
		config,
	);
	assert(!/×2/.test(apart), `two codes collapsed onto one line:\n${apart}`);
	assert(/\(2 distinct\)|, 2 distinct\)/.test(apart), `two codes counted as one distinct:\n${apart}`);
	const many = Array.from({ length: 13 }, (_, i) => at(i + 1, 'same'));
	const listed = formatAgent({ ...dupes.result, findings: many }, config);
	assert(
		/×13 \(lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, \u2026 \+3 more\)/.test(listed),
		`hidden lines uncounted:\n${listed}`,
	);
});

await check('json and sarif stay one entry per finding', () => {
	const { result, config } = dupes;
	assert(reportPayload(result, config).findings.length === result.findings.length, 'json collapsed findings');
	const sarif = JSON.parse(formatSarif(result, config)) as { runs: { results: unknown[] }[] };
	assert(sarif.runs[0]?.results.length === result.findings.length, 'sarif collapsed findings');
});
cleanup(dupes.root);

// ── concise ─────────────────────────────────────────────────────────────────
// Defined by subtraction: every finding line gone, every heading and the tally
// kept, on either axis.

await check('--concise prints the grouping axis and the tally, and no findings', () => {
	const { result, config } = spread;
	for (const [mode, head] of [
		['rule', RULE_HEAD],
		['file', FILE_HEAD],
	] as const) {
		const out = formatAgent(result, config, { group: mode, concise: true });
		assert(
			!out.split('\n').some((l) => NUMBERED.test(l)),
			`--concise --group-by ${mode} still prints findings:\n${out}`,
		);
		// Every group still named, at the margin, with its own count.
		const heads = out.split('\n').filter((l) => head.test(l));
		const groups = new Set(result.findings.map((f) => (mode === 'rule' ? f.rule : f.file)));
		assert(
			heads.length === groups.size,
			`--concise --group-by ${mode} named ${heads.length} of ${groups.size}:\n${out}`,
		);
		const counted = heads.reduce((n, l) => n + Number(head.exec(l)?.[mode === 'rule' ? 3 : 2] ?? 0), 0);
		assert(counted === result.findings.length, `the counts total ${counted}, not ${result.findings.length}:\n${out}`);
		// The summary survives; the next-step block does not.
		assert(/blocking|advisory/.test(out.split('\n')[0] ?? ''), `--concise dropped the tally:\n${out}`);
		assert(!/^Next: /m.test(out), `--concise kept the next-step block:\n${out}`);
	}
});
cleanup(spread.root);

// A run that skipped files says so at any verbosity.
await check('--concise still reports what could not be parsed', async () => {
	const { result, config, root } = await run({
		'loupe.config.json': CONFIG,
		'styles/a.css': '.wf-card { padding: 12px; }',
		'styles/broken.css': '.wf-row { color: #757575;',
	});
	try {
		const out = formatAgent(result, config, { concise: true });
		assert(/could not be parsed/.test(out), `--concise swallowed the parse errors:\n${out}`);
	} finally {
		cleanup(root);
	}
});

// `--severity error` dropped the live warnings and left the baselined ones, so
// SARIF still listed accepted warnings as suppressed results and counted them.
await check('--severity error filters the baselined findings too', () => {
	const dir = scratch('loupe-severity-baseline-');
	writeAll(dir, RULED);
	try {
		assert(cli(dir, 'baseline').status === 0, 'baseline failed');
		const out = cli(dir, 'check', '--all', '--severity', 'error', '--format', 'sarif');
		const run0 = (
			JSON.parse(out.stdout) as {
				runs: { results: { level: string; suppressions?: unknown[] }[]; properties?: { baselined: number } }[];
			}
		).runs[0];
		assert(run0, 'no sarif run');
		const suppressed = run0.results.filter((r) => r.suppressions);
		assert(suppressed.length === 3, `${suppressed.length} suppressed, expected the 3 margin errors`);
		assert(
			suppressed.every((r) => r.level === 'error'),
			`a baselined warning survived --severity error: ${JSON.stringify(suppressed)}`,
		);
		assert(run0.properties?.baselined === 3, `baselined ${run0.properties?.baselined}, expected 3`);
	} finally {
		cleanup(dir);
	}
});

// An entry of a rule the config has off matches nothing, because the rule
// reports nothing: that is not work done, and `fixed` counted it as such.
await check('a rule switched off does not count its baseline entries as fixed', () => {
	const dir = scratch('loupe-off-fixed-');
	writeAll(dir, RULED);
	try {
		assert(cli(dir, 'baseline').status === 0, 'baseline failed');
		writeAll(dir, {
			'loupe.config.json': JSON.stringify({ extends: 'generic', rules: { 'layout/margin-on-child': 'off' } }),
		});
		const fixed = (...argv: string[]): unknown =>
			(JSON.parse(cli(dir, 'check', '--all', '--format', 'json', ...argv).stdout) as { summary: { fixed?: number } })
				.summary.fixed;
		assert(fixed() === 0, `fixed ${fixed()} with the rule off`);
		assert(fixed('--rule', 'layout/margin-on-child') === 0, 'fixed counted under --rule for the rule that is off');
	} finally {
		cleanup(dir);
	}
});

// `patterns/judged-redirect` reports only under `--judge`, so naming it alone
// printed "clean" and exited 0 with nothing to say it could not have reported.
await check('--rule patterns/judged-redirect without --judge says it reports only under --judge', () => {
	const dir = scratch('loupe-rule-judged-');
	writeAll(dir, {
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'package.json': JSON.stringify({ dependencies: { '@wordpress/components': '*', '@wordpress/ui': '*' } }),
		'src/A.jsx': 'export const A = () => <p className="acme-x">x</p>;\n',
	});
	const profiles = ['--profiles', join(HERE, '..', '..', 'profiles'), '--profile', 'wpds'];
	try {
		const r = cli(dir, 'check', '--all', '--rule', 'patterns/judged-redirect', ...profiles);
		assert(/only under --judge/.test(r.stderr), `no note that the rule needs --judge:\n${r.stderr}${r.stdout}`);
		// Another rule says nothing of the kind.
		const other = cli(dir, 'check', '--all', '--rule', 'system/raw-element', ...profiles);
		assert(!/only under --judge/.test(other.stderr), `noted for a rule that needs no --judge:\n${other.stderr}`);
	} finally {
		cleanup(dir);
	}
});

// `readBaseline` took any `entries` array, so a `null` in it reached `ruleOf`
// and threw: `baseline --dry-run` and `check --rule` exited 2 on a file a plain
// `check` read without complaint.
await check('a baseline entry that is not a string is dropped, not thrown on', () => {
	const dir = scratch('loupe-baseline-null-');
	writeAll(dir, RULED);
	try {
		assert(cli(dir, 'baseline').status === 0, 'baseline failed');
		const path = join(dir, '.loupe/baseline.json');
		const file = JSON.parse(readFileSync(path, 'utf8')) as { entries: unknown[] };
		writeAll(dir, { '.loupe/baseline.json': JSON.stringify({ ...file, entries: [...file.entries, null, 3] }) });
		for (const argv of [
			['baseline', '--dry-run'],
			['check', '--all', '--rule', 'layout/margin-on-child'],
		]) {
			const r = cli(dir, ...argv);
			assert(r.status !== 2, `${argv.join(' ')} exited 2:\n${r.stderr}`);
		}
	} finally {
		cleanup(dir);
	}
});

// `--files` took a directory as a file name: nothing is keyed by it, so
// `--files styles` reported "clean. 1 file(s) scanned." on a tree whose
// stylesheets had findings in them.
await check('--files expands a directory to the source files under it', () => {
	const dir = scratch('loupe-files-dir-');
	writeAll(dir, { ...RULED, 'vendor/skip.css': '.v { margin-bottom: 8px; }' });
	writeAll(dir, {
		'loupe.config.json': JSON.stringify({
			extends: 'generic',
			rules: { 'layout/margin-on-child': 'error' },
			sources: { ignore: ['vendor/**'] },
		}),
	});
	try {
		const files = (...argv: string[]): string[] =>
			[
				...new Set(
					(
						JSON.parse(cli(dir, 'check', '--no-baseline', '--format', 'json', ...argv).stdout) as {
							findings: Finding[];
						}
					).findings.map((f) => f.file),
				),
			].sort();
		const all = files('--all');
		assert(all.join() === 'styles/a.css,styles/b.css', `fixture: ${all.join()}`);
		for (const given of ['styles', 'styles/', '.', join(dir, 'styles')])
			assert(files('--files', given).join() === all.join(), `--files ${given}: ${files('--files', given).join()}`);
		// A file beside a directory, and the ignore globs still apply under it.
		assert(files('--files', 'styles/b.css').join() === 'styles/b.css', 'a plain file is no longer taken as given');
	} finally {
		cleanup(dir);
	}
});

// ── the pane model ──────────────────────────────────────────────────────────

await check('the pane is derived from the json payload and agrees with it', () => {
	const payload = reportPayload(result, config);
	const pane = panePayload(result, config);
	assert(
		JSON.stringify(pane) === JSON.stringify(paneFromPayload(payload)),
		'panePayload is not paneFromPayload(reportPayload)',
	);
	assert(JSON.stringify(pane.summary) === JSON.stringify(payload.summary), 'the pane carries a different summary');
	const counted = pane.rules.reduce((n, r) => n + r.count, 0);
	assert(counted === payload.findings.length, `the rule bars count ${counted} of ${payload.findings.length} findings`);
	const inDirs = pane.dirs.reduce((n, d) => n + d.count, 0);
	assert(
		inDirs === payload.findings.length,
		`the directory bars count ${inDirs} of ${payload.findings.length} findings`,
	);
	assert(pane.blocking === payload.blocking, 'blocking disagrees');
});

await check('pane rules are in frequency order, rank breaking ties — the page’s order', () => {
	const payload = reportPayload(result, config);
	const pane = paneFromPayload(payload);
	const rank = new Map<string, number>(payload.rules.map((r) => [r.id, r.rank]));
	for (let i = 1; i < pane.rules.length; i++) {
		const a = pane.rules[i - 1];
		const b = pane.rules[i];
		assert(a && b, 'rows');
		assert(
			a.count > b.count || (a.count === b.count && (rank.get(a.id) ?? 0) >= (rank.get(b.id) ?? 0)),
			`${a.id} (${a.count}) is before ${b.id} (${b.count}) against frequency order`,
		);
	}
	for (const r of pane.rules) {
		assert(r.title.length > 0, `${r.id} has no title`);
		assert(r.files > 0, `${r.id} is in no file`);
	}
});

await check('the pane folds the directory tail into one row rather than dropping it', () => {
	const payload = reportPayload(result, config);
	const first = payload.findings[0];
	assert(first, 'fixture has a finding');
	// Spread one finding over more directories than the cap names.
	const spread = Array.from({ length: DIR_CAP + 3 }, (_, i) => ({ ...first, file: `dir-${i}/x.css` }));
	const pane = paneFromPayload({ ...payload, findings: [...payload.findings, ...spread] });
	const tail = pane.dirs[pane.dirs.length - 1];
	assert(tail?.isTail, 'no folded tail row');
	assert(pane.dirs.length === DIR_CAP + 1, `${pane.dirs.length} directory rows, want ${DIR_CAP + 1}`);
	assert(/^\d+ more directories$/.test(tail.label), `tail label: ${tail.label}`);
	const total = pane.dirs.reduce((n, d) => n + d.count, 0);
	assert(total === payload.findings.length + spread.length, 'the fold lost findings');
});

await check('pane tiles mirror the page: a baseline tile only when it hid something', () => {
	const payload = reportPayload(result, config);
	const keys = (p: typeof payload) => paneFromPayload(p).tiles.map((t) => t.key);
	assert(!keys(payload).includes('baselined'), 'a zero baseline tile is drawn');
	assert(
		keys({ ...payload, summary: { ...payload.summary, baselined: 2 } }).includes('baselined'),
		'the baseline tile is missing',
	);
	const lead = paneFromPayload(payload).tiles[0];
	assert(lead?.isLead && lead.value === payload.summary.total, 'the lead tile is not the total');
	const blockingTile = paneFromPayload(payload).tiles.find((t) => t.key.includes('blocking'));
	assert(
		blockingTile?.isError === (payload.summary.error > 0 ? true : undefined),
		'the blocking tile’s error paint disagrees with the count',
	);
});

await check('pane charts are self-contained SVG with a glyph beside every severity color', () => {
	const pane = panePayload(result, config);
	for (const svg of [pane.svg.rules, pane.svg.dirs]) {
		assert(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), 'not an SVG document');
		assert(svg.endsWith('</svg>'), 'SVG not closed');
		assert(!/https?:\/\//.test(svg.replace('http://www.w3.org/2000/svg', '')), 'the chart fetches something');
		assert(svg.includes('prefers-color-scheme: dark'), 'no dark palette');
	}
	for (const r of pane.rules) {
		const glyph = r.severity === 'error' ? '✗' : '•';
		assert(
			pane.svg.rules.includes(`>${glyph} ${r.id}<`) || pane.svg.rules.includes(`>${glyph} …`),
			`${r.id} is drawn without its glyph`,
		);
	}
	// One chart per severity, for a reader with a picker: each names only its own rules.
	for (const sev of ['error', 'warn'] as const) {
		const chart = pane.svg.rulesBySeverity[sev];
		for (const r of pane.rules) {
			const named = chart.includes(`× ${r.id}`);
			assert(named === (r.severity === sev), `${r.id} (${r.severity}) ${named ? 'is' : 'is not'} in the ${sev} chart`);
		}
	}
	// A finding's text reaches the chart's <title>; it must not reach its markup.
	const hostile = reportPayload(result, config);
	const doctored = {
		...hostile,
		rules: hostile.rules.map((r, i) => (i === 0 ? { ...r, title: '</svg><script>1</script>' } : r)),
	};
	const svg = paneFromPayload(doctored).svg.rules;
	assert(!svg.includes('<script>'), 'a rule title escaped into the SVG');
	assert((svg.match(/<\/svg>/g) ?? []).length === 1, 'a rule title closed the SVG early');
});

await check('a clean result still has a pane, with empty charts that say so', () => {
	const clean: AnalyzeResult = { ...result, findings: [], blocking: false };
	const pane = panePayload(clean, config);
	assert(pane.rules.length === 0 && pane.dirs.length === 0, 'rows for no findings');
	assert(pane.svg.rules.includes('No findings'), 'the empty chart is blank');
	assert(pane.tiles[0]?.value === 0, 'the lead tile is not 0');
});

await check('--format pane writes one JSON document to stdout', () => {
	const dir = scratch('loupe-pane-');
	// RULED: one rule at error, so the tree blocks and the exit code is 1.
	writeAll(dir, RULED);
	try {
		const r = spawnSync('node', [CLI, 'check', '--all', '--no-baseline', '--format', 'pane'], {
			cwd: dir,
			encoding: 'utf8',
			env: { ...process.env, CLAUDE_PLUGIN_DATA: PLUGIN_DATA },
		});
		assert(r.status === 1, `exit ${r.status} on a drifty tree (want 1):\n${r.stderr}`);
		const pane = JSON.parse(r.stdout) as { version: number; tool: string; rules: unknown[]; svg: { rules: string } };
		assert(pane.version === 1 && pane.tool === 'loupe', 'not a pane payload');
		assert(pane.rules.length > 0 && pane.svg.rules.startsWith('<svg'), 'an empty pane for a drifty tree');
	} finally {
		cleanup(dir);
	}
});

finish();
