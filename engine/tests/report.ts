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
import { analyze } from '../src/analyze.ts';
import { setColor } from '../src/color.ts';
import { loadConfig } from '../src/config.ts';
import { formatAgent, formatJson, formatSarif, reportPayload } from '../src/report.ts';
import { formatHtml } from '../src/report-html.ts';
import { CLI, assert, check, cleanup, execFailure, finish, one, scratch, writeAll } from './harness.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
import type { AnalyzeResult, Config } from '../src/types.ts';

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
		JSON.stringify(page) === JSON.stringify(JSON.parse(formatJson(result, config))),
		'the page and the JSON describe different reports'
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

await check('summary.baselined is absent when no baseline step ran', () => {
	const bare = reportPayload(result, config);
	assert(!('baselined' in bare.summary), 'an un-baselined run reported a baselined count');
	const withBaseline = reportPayload({ ...result, baselined: 4, fixed: 0 }, config);
	assert(withBaseline.summary.baselined === 4, 'the baselined count did not survive');
});

await check('the rules roster resolves title placeholders', () => {
	const payload = reportPayload(result, config);
	assert(payload.rules.length > 0, 'no rules in the roster');
	assert(!payload.rules.some((r) => r.title.includes('{')), 'a rule title shipped an unresolved placeholder');
	// Richest first, the order every format prints in.
	const ranks = payload.rules.map((r) => r.rank);
	assert(
		ranks.every((r, i) => i === 0 || (ranks[i - 1] ?? 0) >= r),
		'the rules roster is not ordered by rank'
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
		formatSarif({ ...result, findings: result.findings.map((f) => ({ ...f, line: f.line + 40 })) }, config)
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
		assert(composites.every((f) => typeof f.group === 'string' && f.group.length > 0), 'a composite finding has no group');
		const files = new Set(composites.filter((f) => f.group === composites[0]?.group).map((f) => f.file));
		assert(files.size === 3, `the cluster spans ${files.size} files, expected 3`);
		// Every other rule leaves it unset: `group` means "one member of an N-way
		// relation", and a rule that sets it on a single-file finding says nothing.
		assert(
			r.findings.filter((f) => !f.rule.startsWith('patterns/')).every((f) => f.group === undefined),
			'a non-composite finding carries a cluster key'
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
		assert(e.stderr.includes('sarf') && e.stderr.includes('html'), `stderr did not name the valid formats: ${e.stderr}`);
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
		assert(out.includes('<!-- loupe:begin -->') && out.includes('<!-- loupe:end -->'), 'the fragment markers are missing');
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
			env: { ...process.env, ...extra },
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
		{ FORCE_COLOR: '1' },
		JSON.stringify({ session_id: 'colour', tool_input: { file_path: 'styles/app.css' } })
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
	assert(status.includes(`version:    loupe ${manifest.version}`), `status should carry the same line: ${status.split('\n')[0]}`);
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
	assert(!ESC.test(piped) && /^  --changed /m.test(piped), `piped help is not plain:\n${piped}`);
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
		assert(!ESC.test(readFileSync(join(dir, '.loupe-baseline.json'), 'utf8')), 'the baseline file carries ANSI');
		const after = spawnSync(process.execPath, [CLI, 'check', '--all'], { cwd: dir, encoding: 'utf8', env: colour });
		assert(
			/clean\./.test(after.stdout),
			`a baseline written in colour no longer matches its own findings:\n${after.stdout}`
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
	const { result, config, root } = await run({ 'loupe.config.json': CONFIG, 'src/A.jsx': 'export const A = () => <div />;' });
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
	const { result, config, root } = await run({ 'loupe.config.json': CONFIG, 'src/A.jsx': 'export const A = () => <div />;' });
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
		assert(!/active suppression/.test(formatAgent(silenced, config, { terse: true })), 'the hook does not want a repo-wide inventory');
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
	assert(/\(\d+\) (blocking|advisory) \u2014/.test(out), `a rule group that only says its severity in a glyph:\n${out}`);
	const shipped = (JSON.parse(formatJson(noted, config)) as { findings: { note?: string }[] }).findings[0]?.note;
	assert(shipped === note, `json shipped a note the reader cannot act on: ${String(shipped)}`);
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
		assert(out.includes('<p> \u2192 \u001B[36m<Text\u001B[0m '), `the component the variant belongs to lost its colour:\n${out}`);
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
		const summary = (JSON.parse(formatJson(starved, config)) as { summary: { tokensKnown: number } }).summary;
		assert(summary.tokensKnown === 0, `json hid the empty set: ${summary.tokensKnown}`);
	} finally {
		cleanup(root);
	}
});

finish();
