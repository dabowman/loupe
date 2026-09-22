#!/usr/bin/env node
/**
 * `loupe ui` — the server that writes.
 *
 * Every other surface in this engine reads. This one rewrites source files,
 * records a baseline and writes suppressions, which moves the whole risk surface
 * from "reports the wrong thing" to "changes the wrong thing". So this suite is
 * mostly about the refusals:
 *
 *   - A writer reachable without the secret is a page on any origin rewriting
 *     this repository. The three guards are tested for what they refuse, and the
 *     refusals are tested for leaving the file alone — a 403 that had already
 *     written is not a refusal.
 *   - An index names a finding in the payload the page is holding. Once the tree
 *     moves, the same index names a different one, and a write against it would
 *     be plausible and wrong. The revision check is what makes that impossible
 *     rather than unlikely.
 *   - `fix` and `suppress` must write what `loupe fix` and the language server
 *     write. Not something equivalent — the same bytes, from the same functions.
 *
 * And one thing that is not about writing: the view is now shared with
 * `--format html`, so the artifact is checked here for still being an artifact.
 * A live affordance leaking into a file nobody can click is silent.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { analyze } from '../src/analyze.ts';
import { tokenFixes } from '../src/autofix.ts';
import { applyBaseline, readBaseline } from '../src/baseline.ts';
import { loadConfig } from '../src/config.ts';
import { formatHtml } from '../src/report-html.ts';
import { reportPayload } from '../src/report.ts';
import { ui } from '../src/ui.ts';
import type { UiState } from '../src/ui.ts';
import type { AnalyzeResult, Config } from '../src/types.ts';
import { assert, check, cleanup, finish, one, scratch, writeAll } from './harness.ts';

const TOKENS = `:root {
	--wpds-border-radius-md: 4px;
	--wpds-color-foreground-content-neutral: #1e1e1e;
	--wpds-dimension-space-md: 8px;
	--wpds-typography-font-size-sm: 12px;
}`;

const FILES = {
	'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['wf-'] } }),
	'styles/tokens.css': TOKENS,
	'src/App.jsx': `
import { Card, Text } from '@wordpress/components';
export default () => (
  <Card className="wf-card"><Text className="wf-label">hi</Text></Card>
);
`,
	// `.wf-label` is written open rather than on one line so its findings do not
	// sit on the line that opens the rule. A directive there covers the rule's
	// whole scope, which both `applyKeeps` and `POST /suppress` refuse — see the
	// refusal this suite checks below.
	'styles/app.css': `.wf-card { padding: 8px; border-radius: 4px; }
.wf-label {
	margin-top: 13px;
}
`,
};

const root = scratch('loupe-ui-');
writeAll(root, FILES);
const config: Config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });

const run = (): Promise<AnalyzeResult> => analyze(config, { scope: null });
// The CLI's own arrangement, because the split between these two is the thing
// the last check in this file exists to prove. A presenter that read the
// baseline once would pass every check here and still be wrong tomorrow.
const baselineTarget = join(root, '.loupe-baseline.json');
const handle = await ui({
	port: 0,
	config,
	root,
	analyze: run,
	present: (fresh) => applyBaseline(fresh, readBaseline(baselineTarget)),
	baselineTarget,
	baselineFound: () => existsSync(baselineTarget),
	editor: 'vscode://file{path}:{line}',
	log: () => {},
});
const U = handle.url;

const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const state = async (): Promise<UiState> => (await fetch(`${U}/state`)).json() as Promise<UiState>;

/** A page load, and the secret out of it — which is the only way to get one. */
async function pageToken(): Promise<string> {
	const html = await (await fetch(`${U}/`)).text();
	const m = /var TOKEN = '([a-f0-9]+)'/.exec(html);
	assert(m?.[1], 'the page carries no token — the substitution did not fire');
	return m[1];
}

interface Sent {
	status: number;
	body: Record<string, unknown>;
}
async function post(
	path: string,
	payload: unknown,
	opts: { token?: string; rev?: number; origin?: string } = {},
): Promise<Sent> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (opts.token !== undefined) headers['x-loupe-token'] = opts.token;
	if (opts.rev !== undefined) headers['x-loupe-rev'] = String(opts.rev);
	if (opts.origin !== undefined) headers.origin = opts.origin;
	const res = await fetch(`${U}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const port = new URL(U).port;

/**
 * A GET with a `Host` of our choosing.
 *
 * `fetch` will not send one — `Host` is a forbidden header name — and the header
 * is the whole point here: it is what a rebound name arrives as.
 */
function asHost(host: string, path: string): Promise<{ status: number; body: string }> {
	return new Promise((done, bad) => {
		const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host } }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (c: string) => {
				body += c;
			});
			res.on('end', () => done({ status: res.statusCode ?? 0, body }));
		});
		req.on('error', bad);
		req.end();
	});
}

const token = await pageToken();

// ── the page ────────────────────────────────────────────────────────────────

await check('the page tells the view it is live, and where the project is', async () => {
	const html = await (await fetch(`${U}/`)).text();
	// The same hazard `serve` has: a substitution that stopped firing ships a
	// page that parses, loads, and is quietly the wrong thing.
	const m = /window\.__loupe = (\{.*?\});/.exec(html);
	assert(m?.[1], 'the page does not announce a live host');
	const host = JSON.parse(m[1]) as { live: boolean; root: string; editor: string };
	assert(host.live === true, 'the host object does not say it is live');
	assert(host.root.startsWith('/'), `root must be slash-led to substitute into a URI: ${host.root}`);
	assert(host.editor.includes('{path}'), 'the editor template lost its placeholder');
	assert(!html.includes('__TOKEN__'), 'the token placeholder is still in the page');
});

await check('the artifact stays an artifact: no live affordance reaches the file', async () => {
	const html = formatHtml(await run(), config);
	// The view is shared now, so its source text necessarily contains both
	// branches — the live one simply never runs. What must not appear is any of
	// it *emitted*, so the scripts come out before the markup is judged.
	const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
	assert(!markup.includes('data-act='), 'the report emits action buttons nobody can click');
	assert(!markup.includes('class="top"'), 'the report emits the live toolbar');
	assert(!markup.includes('id="said"'), 'the report emits the live status line');
	assert(!markup.includes('.act-btn'), 'the report carries live-only styling');
	// `__loupe` is the whole seam: without it LIVE is false and every branch
	// above resolves to the artifact's side.
	assert(!html.includes('window.__loupe ='), 'the report announces a live host');
	assert(html.includes('id="loupe-data"'), 'the report no longer embeds its payload');
	// The one that would be silent: a report that fetches renders empty from a file.
	assert(!/fetch\(\s*'\/state'/.test(html), 'the report tries to fetch');
	// And it still renders no time, which is what lets two runs be diffed.
	assert(!/\d{4}-\d{2}-\d{2}T/.test(markup), 'the report grew a timestamp');
});

// ── the read surface ────────────────────────────────────────────────────────

await check('/findings.json is the payload and nothing else', async () => {
	const mine = await (await fetch(`${U}/findings.json`)).text();
	// Through the same presenter the server uses, because the baseline is part of
	// what the reader is being shown; what is being checked is that the endpoint
	// hands over the formatter's output and does not decorate it.
	const theirs = JSON.stringify(reportPayload(applyBaseline(await run(), readBaseline(baselineTarget)), config));
	assert(mine === theirs, 'the endpoint and the formatter disagree about the payload');
	// The live envelope's own keys must not leak here: anything already pointed
	// at `loupe serve`'s endpoint has to keep working against this one.
	const keys = Object.keys(JSON.parse(mine) as Record<string, unknown>);
	for (const live of ['rev', 'fixable', 'watching', 'ranAt'])
		assert(!keys.includes(live), `${live} leaked into the payload`);
	assert(keys.includes('findings') && keys.includes('summary'), 'the payload lost its shape');
});

await check('fixable names the findings `loupe fix` would rewrite, and only those', async () => {
	const s = await state();
	const fresh = await run();
	const expected = fresh.findings.flatMap((f, i) => (tokenFixes([f]).length > 0 ? [i] : []));
	assert(
		JSON.stringify(s.fixable) === JSON.stringify(expected),
		`fixable ${JSON.stringify(s.fixable)} is not what tokenFixes settles ${JSON.stringify(expected)}`,
	);
	assert(s.fixable.length > 0, 'the fixture produced nothing fixable, so this proves nothing');
	// Index alignment is the coupling that makes the numbers mean anything.
	for (const i of s.fixable) {
		const f = s.payload.findings[i];
		assert(f !== undefined, `fixable names index ${i}, which the payload does not have`);
		assert(f.rule === fresh.findings[i]?.rule, `index ${i} names a different finding in the payload`);
	}
});

await check('a watch is reported as a number, or as absent — never implied', async () => {
	const s = await state();
	assert(s.watching === null || s.watching > 0, `watching is ${s.watching}`);
	assert(typeof s.ranAt === 'string' && !Number.isNaN(Date.parse(s.ranAt)), 'no run time');
});

await check('/source refuses a path this run did not report', async () => {
	const bad = await fetch(`${U}/source?file=../../../etc/passwd&line=1`);
	assert(bad.status === 404, `traversal answered ${bad.status}`);
	// Not a traversal, and still not this run's business: the allowlist is the
	// findings, not the project directory.
	const cfg = await fetch(`${U}/source?file=loupe.config.json&line=1`);
	assert(cfg.status === 404, `an unreported project file answered ${cfg.status}`);
	const ok = await fetch(`${U}/source?file=styles/app.css&line=1`);
	assert(ok.status === 200, `a reported file answered ${ok.status}`);
});

await check('a known path with the wrong method is 405, an unknown one 404', async () => {
	assert((await fetch(`${U}/fix`)).status === 405, 'GET on a write path is not 405');
	assert((await fetch(`${U}/nope`)).status === 404, 'an unknown path is not 404');
});

// ── the refusals ────────────────────────────────────────────────────────────

const before = read('styles/app.css');
const rev = (await state()).rev;

await check('a write without the secret is refused, and writes nothing', async () => {
	const res = await post('/fix', { findings: [0, 1, 2] }, { rev });
	assert(res.status === 403, `answered ${res.status}`);
	assert(read('styles/app.css') === before, 'the refusal had already written');
});

await check('a write with the wrong secret is refused, and writes nothing', async () => {
	const res = await post('/fix', { findings: [0, 1, 2] }, { token: 'f'.repeat(48), rev });
	assert(res.status === 403, `answered ${res.status}`);
	assert(read('styles/app.css') === before, 'the refusal had already written');
});

await check('a write from another origin is refused even with the secret', async () => {
	const res = await post('/fix', { findings: [0, 1, 2] }, { token, rev, origin: 'https://evil.example' });
	assert(res.status === 403, `answered ${res.status}`);
	assert(read('styles/app.css') === before, 'the refusal had already written');
});

await check('a write naming a stale revision is refused, and writes nothing', async () => {
	const res = await post('/fix', { findings: [0, 1, 2] }, { token, rev: rev - 1 });
	assert(res.status === 409, `answered ${res.status}`);
	assert(read('styles/app.css') === before, 'the refusal had already written');
});

await check('a request for some other host is refused, on every method', async () => {
	// Binding loopback stops packets from the network; it does not stop a name
	// that resolves to 127.0.0.1. A page on such a name is same-origin with this
	// server to the browser, and `GET /` carries the write token — so the host is
	// checked before the route, and on reads as well as writes.
	const rebound = await asHost('attacker.example', '/state');
	assert(rebound.status === 403, `a foreign Host answered ${rebound.status}`);
	const page = await asHost('attacker.example:1234', '/');
	assert(page.status === 403, `the page answered ${page.status} to a foreign Host`);
	assert(!page.body.includes('var TOKEN'), 'the refusal still handed over the secret');
	// The spellings that are this server still work.
	for (const h of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
		const good = await asHost(h, '/state');
		assert(good.status === 200, `Host ${h} answered ${good.status}`);
	}
});

await check('a suppression with no reason is refused — the silence has to be signed', async () => {
	const blank = await post('/suppress', { finding: 0, reason: '   ' }, { token, rev });
	assert(blank.status === 400, `blank reason answered ${blank.status}`);
	assert(read('styles/app.css') === before, 'the refusal had already written');
});

await check('an index outside the payload names nothing', async () => {
	const res = await post('/fix', { findings: [9999] }, { token, rev });
	assert(res.status === 400, `answered ${res.status}`);
});

await check('a suppression that would mute more than the row is refused', async () => {
	// A directive above a rule's opening line covers the rule's whole scope, so
	// muting one row would mute every row in it. `applyKeeps` refuses exactly this
	// and says why; a second implementation that wrote it anyway would answer 200
	// and silently retire findings nobody looked at.
	const s = await state();
	// Written here rather than relied on from the fixture, so the refusal is
	// tested against a line that certainly opens a rule.
	writeFileSync(join(root, 'styles/wide.css'), '.wf-card { margin-left: 11px; margin-right: 13px; }\n');
	const withIt = await settled(s.rev);
	const i = withIt.payload.findings.findIndex((f) => f.file === 'styles/wide.css');
	assert(i >= 0, 'the new file produced no finding');
	const before = read('styles/wide.css');
	const res = await post('/suppress', { finding: i, reason: 'legacy' }, { token, rev: withIt.rev });
	assert(res.status === 409, `answered ${res.status}: ${JSON.stringify(res.body)}`);
	assert(String(res.body.error).includes('mute the whole rule'), `unexpected refusal: ${String(res.body.error)}`);
	assert(read('styles/wide.css') === before, 'the refusal had already written');
	rmSync(join(root, 'styles/wide.css'));
	await settled(withIt.rev);
});

await check("a suppression keeps the file's own line ending", async () => {
	// `applyKeeps` carries the line's `\r` onto the directive it inserts. A writer
	// that split on `\n` and joined on `\n` leaves one LF-only line in a CRLF
	// file — the one write path that would change a file's line-ending convention
	// on the reader's behalf.
	const s = await state();
	writeFileSync(join(root, 'styles/crlf.css'), '.wf-card {\r\n\tmargin-left: 11px;\r\n}\r\n');
	const withIt = await settled(s.rev);
	const i = withIt.payload.findings.findIndex((f) => f.file === 'styles/crlf.css');
	assert(i >= 0, 'the CRLF file produced no finding');
	const res = await post('/suppress', { finding: i, reason: 'legacy' }, { token, rev: withIt.rev });
	assert(res.status === 200, `answered ${res.status}: ${JSON.stringify(res.body)}`);
	const text = read('styles/crlf.css');
	assert(!/(^|[^\r])\n/.test(text), `a line lost its carriage return:\n${JSON.stringify(text)}`);
	rmSync(join(root, 'styles/crlf.css'));
	await settled(withIt.rev);
});

// ── the writes ──────────────────────────────────────────────────────────────

/** Wait for the server to publish a run newer than `was`. */
async function settled(was: number): Promise<UiState> {
	for (let i = 0; i < 100; i++) {
		const s = await state();
		if (s.rev > was) return s;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`no re-analysis after rev ${was}`);
}

await check('fix writes exactly what `loupe fix` writes, and the page re-runs', async () => {
	const s = await state();
	const i = one(s.fixable, 'the fixture should offer exactly one fix');
	const target = s.payload.findings[i];
	assert(target !== undefined, 'no finding at the fixable index');
	// The bytes `loupe fix` would write, computed the same way, before the write.
	const fresh = await run();
	const mirror = fresh.findings[i];
	assert(mirror !== undefined, `the fresh run has no finding at index ${i}`);
	const expected = one(tokenFixes([mirror]), 'tokenFixes should settle exactly one declaration');

	const res = await post('/fix', { findings: [i] }, { token, rev: s.rev });
	assert(res.status === 200, `answered ${res.status}: ${JSON.stringify(res.body)}`);
	assert(res.body.applied === 1, `applied ${String(res.body.applied)}`);
	const after = read(target.file);
	assert(after.includes(expected.to), `${expected.to} is not in the file`);
	assert(!after.includes(`${expected.prop}: ${expected.value};`), 'the old declaration is still there');
	const next = await settled(s.rev);
	assert(next.payload.summary.total < s.payload.summary.total, 're-analysis did not drop the fixed finding');
});

await check("suppress writes a directive that actually mutes, in the file's own comment syntax", async () => {
	const s = await state();
	const margin = s.payload.findings.findIndex((f) => f.rule === 'layout/margin-on-child');
	assert(margin >= 0, 'the fixture lost its margin finding');
	const res = await post('/suppress', { finding: margin, reason: 'legacy, tracked in WF-412' }, { token, rev: s.rev });
	assert(res.status === 200, `answered ${res.status}: ${JSON.stringify(res.body)}`);
	const text = read('styles/app.css');
	assert(
		text.includes(`/* ${config.suppression.keyword} layout/margin-on-child -- legacy, tracked in WF-412 */`),
		`the directive is not in the file as written:\n${text}`,
	);
	// It has to mute, not merely be present. A directive the parser rejects
	// reports as `suppression/malformed`, which is louder, not quieter.
	const next = await settled(s.rev);
	assert(
		!next.payload.findings.some((f) => f.rule === 'layout/margin-on-child'),
		'the directive did not mute its finding',
	);
	assert(
		!next.payload.findings.some((f) => f.rule === 'suppression/malformed'),
		'the directive was written in a shape the parser rejects',
	);
	assert(next.payload.summary.suppressions > 0, 'the suppression is not counted');
});

await check('baseline records the whole backlog, not the part still on screen', async () => {
	const first = await state();
	assert(first.payload.summary.total > 0, 'nothing left to baseline');
	const res = await post('/baseline', {}, { token, rev: first.rev });
	assert(res.status === 200, `answered ${res.status}: ${JSON.stringify(res.body)}`);
	const quiet = await settled(first.rev);
	assert(quiet.payload.summary.total === 0, 'the baseline did not quiet the backlog');
	assert(quiet.baseline.found, 'the page does not know a baseline is in play');
	const accepted = (JSON.parse(read('.loupe-baseline.json')) as { entries: string[] }).entries.length;
	assert(accepted > 0, 'the baseline recorded nothing');

	// Now the case the presenter split exists for. With a baseline in play the
	// page shows only what it did not accept, and a second baseline taken from
	// *that* would record one entry and silently un-accept everything else — a
	// whole backlog turned live again, reported as a successful write.
	writeFileSync(join(root, 'styles/late.css'), '.wf-card { margin-top: 19px; }\n');
	const withNew = await settled(quiet.rev);
	assert(withNew.payload.summary.total > 0, 'the new file produced no finding to distinguish the two sets');
	// (There was a `total < accepted + total` guard here. It reduces to
	// `accepted > 0`, which is already asserted above, so it checked nothing. The
	// degeneracy it meant to rule out — the new findings collapsing into entries
	// the baseline already holds — is caught by the entry count at the end, which
	// is where it belongs.)

	const second = await post('/baseline', {}, { token, rev: withNew.rev });
	assert(second.status === 200, `second baseline answered ${second.status}`);
	const after = JSON.parse(read('.loupe-baseline.json')) as { entries: string[] };
	assert(
		after.entries.length > accepted,
		`the second baseline recorded ${after.entries.length} entries, not the ${accepted} already accepted plus the new one — it baselined the remainder`,
	);
	const end = await settled(withNew.rev);
	assert(end.payload.summary.total === 0, 'the second baseline left findings live');
});

await handle.close();
cleanup(root);
finish();
