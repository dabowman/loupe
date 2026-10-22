#!/usr/bin/env node
/**
 * The browser consumer: `selector` on findings, and the server that ships them.
 *
 * `selector` exists for exactly one reader — a script in a page, resolving a
 * stylesheet finding to the elements it styles. Two things have to hold or that
 * reader is quietly wrong rather than loudly broken:
 *
 *   - It must be the *whole* selector. `.card .title` and `.title` match
 *     different elements, and the analyzer already computes a key selector for
 *     its own correlation — picking that one up by mistake would still produce
 *     a plausible highlight, on the wrong nodes.
 *   - It must be absent where there is no CSS rule. A JSX finding that carried
 *     some nearby selector would send the reader to elements that have nothing
 *     to do with it.
 *
 * The server's own hazard is the client it serves: the overlay is a template
 * with two placeholders punched out of it, and a substitution that stopped
 * firing would ship a script that parses, loads, and silently talks to the
 * wrong origin.
 */

import { join } from 'node:path';
import { analyze } from '../src/analyze.ts';
import { loadConfig } from '../src/config.ts';
import { serve } from '../src/serve.ts';
import type { AnalyzeResult, Config } from '../src/types.ts';
import { assert, check, cleanup, finish, one, scratch, writeAll } from './harness.ts';

const FILES = {
	'loupe.config.json': '{ "extends": "wordpress-components", "namespaces": { "project": ["wf-"] } }',
	'src/App.jsx': `
import { Card, Stack, Text } from '@wordpress/components';
export default () => (
  <Card className="wf-card">
    <Stack className="wf-row"><Text className="wf-label" style={{ marginTop: 9 }}>hi</Text></Stack>
  </Card>
);
`,
	'styles/app.css': `
.wf-card .wf-title { font-size: 13px; }
.wf-row { display: flex; gap: 8px; }
.wf-label:hover { color: #757575; }
@media (max-width: 600px) {
  .wf-narrow { margin-bottom: 11px; }
  @media (orientation: portrait) {
    .wf-both { margin-bottom: 13px; }
  }
}
@media screen, print {
  .wf-listed { margin-bottom: 17px; }
}
`,
};

const root = scratch('loupe-serve-');
writeAll(root, FILES);
const config: Config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
const result: AnalyzeResult = await analyze(config, { scope: null });
assert(result.findings.length > 2, `fixture produced only ${result.findings.length} findings`);

const inCss = result.findings.filter((f) => f.file.endsWith('.css'));

await check('a stylesheet finding carries the rule it sits in', () => {
	assert(inCss.length > 0, 'the fixture produced no stylesheet findings to carry a selector');
	for (const f of inCss) assert(f.selector, `${f.rule} in ${f.file}:${f.line} has no selector`);
});

await check('the selector is the whole one, not the key selector', () => {
	// `.wf-card .wf-title` is the case that separates the two: the analyzer
	// already derives `.wf-title` for binding correlation, and that is the value
	// this field must NOT have — it matches `.wf-title` anywhere on the page,
	// including outside any `.wf-card`.
	const f = one(
		inCss.filter((x) => x.rule !== 'css/dead-class' && x.selector?.includes('wf-title')),
		'no declaration finding on the descendant rule',
	);
	assert(f.selector === '.wf-card .wf-title', `carried a truncated selector: ${f.selector}`);
});

await check('a dead class asks about the class, not the rule it was found in', () => {
	// The two rules want different questions of the page, and the difference is
	// the point. A declaration finding asks "which elements does this rule
	// style" — the whole selector. `css/dead-class` asks "is this class on
	// anything at all", which `.wf-card .wf-title` would answer wrongly: the
	// class could be live everywhere else and still miss that ancestor.
	const f = one(
		inCss.filter((x) => x.rule === 'css/dead-class' && x.message === '.wf-title'),
		'no dead-class finding for .wf-title',
	);
	assert(f.selector === '.wf-title', `a dead class asked the wrong question: ${f.selector}`);
});

const bySelector = (sel: string) =>
	one(
		inCss.filter((f) => f.selector === sel && f.rule !== 'css/dead-class'),
		`no declaration finding on ${sel}`,
	);

await check('a finding under @media carries the condition, and one outside carries none', () => {
	assert(bySelector('.wf-narrow').media === '(max-width: 600px)', 'the condition was dropped');
	// `.wf-card .wf-title` is unconditional. (`.wf-row` would not do: it is
	// bound to a `Stack`, so `layout/in-css` correctly reports nothing there.)
	assert(bySelector('.wf-card .wf-title').media === undefined, 'an unconditional rule invented a condition');
});

await check('nested @media conditions combine with and, in source order', () => {
	// Both have to hold for the declaration to apply, which is what ` and `
	// means — and the outer one first, so the string reads the way the file does.
	assert(
		bySelector('.wf-both').media === '(max-width: 600px) and (orientation: portrait)',
		`nested conditions combined wrongly: ${bySelector('.wf-both').media}`,
	);
});

await check('a comma in the condition yields nothing rather than something wrong', () => {
	// `screen, print` is two queries, and a comma binds looser than `and`. There
	// is no way to combine it without rewriting, so a single such condition is
	// carried as-is and only a *combination* involving one is refused. Here it
	// is alone, so it survives — the test is that it is not silently mangled.
	const f = bySelector('.wf-listed');
	assert(f.media === 'screen, print', `a lone comma condition was rewritten: ${f.media}`);
});

await check('a finding with no CSS rule carries no selector', () => {
	const jsx = result.findings.filter((f) => f.file.endsWith('.jsx'));
	assert(jsx.length > 0, 'the fixture produced no JSX findings');
	for (const f of jsx) assert(f.selector === undefined, `${f.rule} invented a selector: ${f.selector}`);
});

// `--port 0` lets the OS pick, which is the only way to run this without
// gambling on a port being free on whatever machine the suite runs on. It also
// exercises the read-back: the client is told where it actually landed.
const { url, close } = await serve({ port: 0, config, run: () => analyze(config, { scope: null }) });

try {
	await check('the payload endpoint serves exactly what --format json would', async () => {
		const res = await fetch(`${url}/findings.json`);
		assert(res.ok, `findings.json answered ${res.status}`);
		assert(res.headers.get('access-control-allow-origin') === '*', 'no CORS header — the page cannot read it');
		const body = (await res.json()) as { findings: { rule: string; selector?: string }[] };
		assert(body.findings.length === result.findings.length, 'the endpoint lost findings');
		assert(
			body.findings.some((f) => typeof f.selector === 'string'),
			'selector did not survive the JSON payload',
		);
	});

	await check('the served client knows its own origin and carries its styles', async () => {
		const js = await (await fetch(`${url}/overlay.js`)).text();
		assert(!js.includes('__ORIGIN__'), 'the origin placeholder was never substituted');
		assert(!js.includes('__CSS__'), 'the stylesheet placeholder was never substituted');
		assert(js.includes(`'${url}'`), `the client was handed the wrong origin:\n${js.slice(0, 200)}`);
		// The bookmarklet evaluates this in a page it does not control; a syntax
		// error there surfaces as nothing happening at all.
		new Function(js);
	});

	await check('a state pseudo-class is stripped whole, never half', async () => {
		// Lifted out of the served client rather than reimplemented, so this
		// tests the code the browser runs.
		const js = await (await fetch(`${url}/overlay.js`)).text();
		const state = /var STATE = (\/.*?\/g);/s.exec(js);
		const body = /function domSelector\(sel\) \{([\s\S]*?)\n {2}\}/.exec(js);
		assert(state?.[1] && body?.[1], 'could not find domSelector in the served client');
		const domSelector = new Function('STATE', `return function (sel) {${body[1]}\n}`)(
			// biome-ignore lint/security/noGlobalEval: the pattern is this repo's own source, read back from its own server.
			eval(state[1]),
		) as (s: string) => string;

		// The hyphenated ones are the whole point. A word boundary sits between
		// `focus` and the `-` of `:focus-visible`, so a `\b`-terminated pattern
		// strips `:focus` and welds `-visible` onto the class before it —
		// yielding `.btn-visible`, a valid selector for an element that does not
		// exist. Nothing downstream can notice: it does not throw, it just
		// highlights nothing and reads as "not on this page".
		const cases: [string, string][] = [
			['.btn:focus-visible', '.btn'],
			['.btn:focus-within', '.btn'],
			['.btn:focus', '.btn'],
			['.btn:hover', '.btn'],
			['.a:hover .b', '.a .b'],
			['.in:read-only', '.in'],
			['.in:user-invalid', '.in'],
			['.a:focus, .b:focus-visible', '.a, .b'],
			// Not a state: it selects, so it must survive untouched.
			['.row:nth-child(2)', '.row:nth-child(2)'],
			['.card:not(.is-open)', '.card:not(.is-open)'],
			// A class that merely starts with a state name is not one.
			['.focus-ring', '.focus-ring'],
		];
		for (const [input, want] of cases) {
			const got = domSelector(input);
			assert(got === want, `${input} -> ${got}, wanted ${want}`);
		}
		// A pseudo-element has no node of its own; dropping it leaves the element
		// that carries it.
		assert(domSelector('.tip::before') === '.tip', 'a pseudo-element survived');
	});

	await check('the landing page hands over a bookmarklet pointed at this server', async () => {
		const html = await (await fetch(`${url}/`)).text();
		assert(html.includes(`${url}/overlay.js`), 'the bookmarklet points somewhere else');
	});

	await check('an unknown path is a 404, not a silent empty report', async () => {
		assert((await fetch(`${url}/nope`)).status === 404, 'an unknown path did not 404');
	});

	await check('the WordPress mu-plugin is served whole, so `curl -o` installs it', async () => {
		// The install instruction on the landing page is a `curl` at this route.
		// A 404 here, or a truncated body, produces a file that is present and
		// does nothing — which in WordPress looks exactly like "the overlay is
		// off", the same thing every other misconfiguration looks like.
		const res = await fetch(`${url}/loupe-overlay.php`);
		assert(res.status === 200, `the mu-plugin route answered ${res.status}`);
		const php = await res.text();
		assert(php.startsWith('<?php'), 'the mu-plugin did not arrive as PHP');
		assert(php.includes('LOUPE_OVERLAY_URL'), 'the constant the file gates on is missing');
		assert(php.includes("add_action( 'admin_enqueue_scripts'"), 'nothing would enqueue it in wp-admin');
	});

	await check('the landing page names this server in both halves of the WordPress setup', async () => {
		// The `curl` and the `LOUPE_OVERLAY_URL` value are both this origin, and
		// `--port` moves it. A hardcoded 7331 in either would send someone to a
		// server that is not running.
		const html = await (await fetch(`${url}/`)).text();
		assert(html.includes(`${url}/loupe-overlay.php`), 'the install command points elsewhere');
		assert(html.includes(`"LOUPE_OVERLAY_URL": "${url}"`), 'the constant would be set to the wrong origin');
	});
	// A refused analysis answers 500 with `{ error }`, and the client called
	// `.json()` and rendered it as a payload: the overlay said "Cannot read
	// properties of undefined (reading 'map')" instead of why.
	await check('the overlay shows a refused analysis as the refusal', async () => {
		const js = await (await fetch(`${url}/overlay.js`)).text();
		const body = /function load\(\) \{([\s\S]*?)\n {2}\}/.exec(js)?.[1];
		assert(body, 'could not find load in the served client');
		const refusal = 'tree too large to index: the walk stopped at 10 entries';
		const panel = { innerHTML: '' };
		let rendered = false;
		const load = new Function('fetch', 'ORIGIN', 'panel', 'esc', 'render', `return function () {${body}\n}`)(
			async () => ({ ok: false, status: 500, json: async () => ({ error: refusal }) }),
			url,
			panel,
			(s: string) => s,
			() => {
				rendered = true;
			},
		) as () => void;
		load();
		for (let i = 0; i < 50 && !panel.innerHTML; i++) await new Promise((r) => setTimeout(r, 10));
		assert(!rendered, 'the error body was rendered as findings');
		assert(panel.innerHTML.includes(refusal), `the refusal was not shown: ${panel.innerHTML}`);
	});
} finally {
	await close();
	cleanup(root);
}

finish();
