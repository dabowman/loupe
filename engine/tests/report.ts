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

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { analyze } from '../src/analyze.ts';
import { loadConfig } from '../src/config.ts';
import { formatJson, formatSarif, reportPayload } from '../src/report.ts';
import { formatHtml } from '../src/report-html.ts';
import { CLI, assert, check, cleanup, execFailure, finish, one, scratch, writeAll } from './harness.ts';
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

finish();
