#!/usr/bin/env node
/**
 * Drives the panel and the sidebar against a real page.
 *
 * Not part of `npm test`: the engine's suite has no browser in it, and adding
 * Playwright to the gate for two surfaces would make every contributor install a
 * browser to change a rule. It is here because the alternative is that nobody
 * ever runs this, and the parts it covers — the resolving, the ordering, the
 * two panes' rendering — are exactly the parts that fail by showing something
 * plausible rather than by throwing. Run it when you change the matcher or
 * either pane.
 *
 *   node integrations/devtools/check.mjs
 *
 * What it does NOT cover, and nothing automated here can: `chrome.devtools`
 * itself — panel registration, the Elements pane, and the real `$0`. Those are
 * the handful of lines in devtools.js and two expressions. Everything below them
 * is exercised here by shimming `chrome.devtools` onto the page's own document,
 * which is what the panel is talking to anyway.
 *
 * Needs a `loupe serve` to read and a page to look at; it starts both.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CLI = join(REPO, 'engine', 'bin', 'loupe.mjs');

let failed = 0;
const ok = (name) => console.log(`ok   ${name}`);
const bad = (name, why) => {
	failed++;
	console.log(`FAIL ${name}\n     ${why}`);
};
function is(name, got, want) {
	const g = JSON.stringify(got);
	const w = JSON.stringify(want);
	g === w ? ok(name) : bad(name, `got ${g}, wanted ${w}`);
}
function assert(name, cond, why) {
	cond ? ok(name) : bad(name, why);
}

// ── the project under inspection, and the page that renders it ──────────────

const root = mkdtempSync(join(tmpdir(), 'loupe-devtools-'));
const write = (rel, body) => {
	mkdirSync(dirname(join(root, rel)), { recursive: true });
	writeFileSync(join(root, rel), body);
};
write('loupe.config.json', JSON.stringify({ extends: 'wpds', namespaces: { project: ['wf-'] } }));
write(
	'styles/tokens.css',
	':root {\n\t--wpds-dimension-space-md: 8px;\n\t--wpds-border-radius-md: 4px;\n\t--wpds-typography-font-size-sm: 12px;\n}\n',
);
write('src/App.jsx', "import { Card, Text } from '@wordpress/components';\nexport default () => (<Card className=\"wf-card\"><Text className=\"wf-label\">hi</Text></Card>);\n");
write(
	'styles/app.css',
	[
		'.wf-card { padding: 8px; border-radius: 4px; }',
		'.wf-label { margin-top: 13px; font-size: 12px; }',
		'.wf-ghost:hover { margin-bottom: 11px; }',
		'@media (max-width: 600px) {',
		'  .wf-narrow { margin-left: 7px; }',
		'}',
		'',
	].join('\n'),
);

/** The page the panel will be pointed at. Two cards, two labels, one narrow div. */
const APP = `<!doctype html><meta charset="utf-8"><title>app</title>
<style>body{margin:0;font:14px system-ui}.wf-card{padding:8px;border:1px solid #ccc;margin:10px}.wf-label{margin-top:13px}</style>
<div class="wf-card" id="c1">one<div class="wf-label" id="l1">label</div></div>
<div class="wf-card" id="c2">two<div class="wf-label" id="l2">label</div></div>
<div class="wf-narrow" id="n1">narrow</div>
<div class="wf-ghost" id="g1">ghost</div>`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

/** Serve the extension's own files plus the app, so the panel loads as a document. */
const files = createServer((req, res) => {
	const path = (req.url ?? '/').split('?')[0];
	if (path === '/' || path === '/app') {
		res.writeHead(200, { 'content-type': 'text/html' });
		return res.end(APP);
	}
	try {
		const body = readFileSync(join(HERE, path.replace(/^\/+/, '')));
		res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
		res.end(body);
	} catch {
		res.writeHead(404).end('not found');
	}
});
await new Promise((done) => files.listen(0, '127.0.0.1', done));
const FILES = `http://127.0.0.1:${files.address().port}`;

const serve = spawn('node', [CLI, 'serve', '--root', root, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
const servePort = await new Promise((done, bad_) => {
	const timer = setTimeout(() => bad_(new Error('loupe serve did not start')), 20000);
	serve.stdout.on('data', (chunk) => {
		const m = /http:\/\/localhost:(\d+)/.exec(String(chunk));
		if (m) {
			clearTimeout(timer);
			done(Number(m[1]));
		}
	});
});

// ── the shim ────────────────────────────────────────────────────────────────

/**
 * `chrome.devtools`, backed by this same document.
 *
 * The panel's only channel to the page is `inspectedWindow.eval`, so routing
 * that to an `eval` in the document the panel is already in makes the page and
 * the inspected page one and the same. Everything the panel does — installing
 * the matcher, loading findings, snapshotting, highlighting — then happens for
 * real, against real elements, and can be read back.
 */
const SHIM = (port) => `
  // chrome first: an init script runs before <body> exists, and a throw here
  // would leave the panel with no chrome object at all — which reads as the
  // extension API being missing rather than as this shim being wrong.
  window.chrome = {
    devtools: {
      inspectedWindow: {
        eval: function (expr, cb) {
          try { cb((0, eval)(expr), undefined); }
          catch (e) { cb(undefined, { isException: true, value: String(e && e.message || e) }); }
        },
      },
      network: { onNavigated: { addListener: function () {} } },
      panels: { elements: { onSelectionChanged: { addListener: function (f) { window.__onSelect = f; } } } },
    },
    storage: { local: {
      get: function () { return Promise.resolve({ port: ${port} }); },
      set: function () { return Promise.resolve(); },
    } },
  };
  // The inspected page, in the same document, so \`eval\` reaches real elements.
  document.addEventListener('DOMContentLoaded', function () {
    var app = document.createElement('div');
    app.id = '__app';
    app.innerHTML = ${JSON.stringify(APP.replace(/<!doctype html>|<meta[^>]*>|<title>[\s\S]*?<\/title>/gi, ''))};
    document.body.appendChild(app);
  });
`;

// ── drive it ────────────────────────────────────────────────────────────────

// Playwright is not a dependency of this repo — nothing else here needs a
// browser — so it is resolved from wherever the runner has one and the failure
// says how to provide it rather than reading as a bug in the extension.
/** Everything started above this point, for the paths that fail before the `try` below. */
const abandon = (why) => {
	process.stderr.write(why);
	serve.kill();
	files.close();
	rmSync(root, { recursive: true, force: true });
	process.exit(2);
};

let chromium;
try {
	// LOUPE_PLAYWRIGHT names an install outside this tree — ESM resolution does
	// not read NODE_PATH, so a path is the only way to point at one.
	({ chromium } = await import(process.env.LOUPE_PLAYWRIGHT || 'playwright'));
} catch {
	abandon(
		'integrations/devtools/check.mjs needs Playwright, which this repo deliberately does not depend on.\n' +
			'  npm i -g playwright   (or run with NODE_PATH pointed at an install)\n' +
			'  Set LOUPE_CHROMIUM to a browser binary if Playwright cannot find one.\n',
	);
}
// Also guarded: Playwright resolving without a browser behind it is the ordinary
// first-run state, and an unhandled rejection here skips the `finally` below —
// leaving the spawned `loupe serve` reparented and still holding its port, and a
// temp project behind, once per attempt.
let browser;
try {
	browser = await chromium.launch(process.env.LOUPE_CHROMIUM ? { executablePath: process.env.LOUPE_CHROMIUM } : {});
} catch (err) {
	abandon(
		`integrations/devtools/check.mjs could not start a browser: ${err.message}\n` +
			'  npx playwright install chromium   (or set LOUPE_CHROMIUM to a binary)\n',
	);
}
const errors = [];

/**
 * `offline: true` is for the page pointed at a port nothing is on. A refused
 * connection there is the case under test, not a defect, and counting it would
 * make the last assertion permanently red.
 */
async function open(page, url, port, { offline = false } = {}) {
	await page.addInitScript(SHIM(port));
	page.on('pageerror', (e) => {
		if (process.env.LOUPE_DEBUG) console.log('PAGEERROR', url, e.message);
		errors.push(`${url}: ${e.message}`);
	});
	page.on('console', (m) => {
		if (process.env.LOUPE_DEBUG) console.log('CONSOLE', url, m.type(), m.text());
		if (m.type() === 'error' && !offline) errors.push(`${url}: ${m.text()}`);
	});
	await page.goto(`${FILES}/${url}`);
}

try {
	// ── the manifest ─────────────────────────────────────────────────────────
	// Packing is Chromium's own validation: it parses the manifest and resolves
	// every file it names. A typo in a script path is otherwise found by opening
	// DevTools and seeing an empty pane.
	{
		const exe = process.env.LOUPE_CHROMIUM || chromium.executablePath();
		const out = mkdtempSync(join(tmpdir(), 'loupe-pack-'));
		try {
			cpSync(HERE, join(out, 'ext'), { recursive: true });
			const packed = spawnSync(
				exe,
				['--headless', '--no-sandbox', `--user-data-dir=${join(out, 'profile')}`, `--pack-extension=${join(out, 'ext')}`],
				{ encoding: 'utf8' },
			);
			const complaint = `${packed.stdout ?? ''}${packed.stderr ?? ''}`
				.split('\n')
				.filter((l) => /extension|manifest/i.test(l))
				.join('; ');
			assert('the manifest is valid and names files that exist', existsSync(join(out, 'ext.crx')), complaint || 'chromium produced no .crx');
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	}

	// ── the panel ────────────────────────────────────────────────────────────
	const panel = await browser.newPage({ viewport: { width: 900, height: 800 } });
	await open(panel, 'panel.html', servePort);
	await panel.waitForFunction(() => document.querySelectorAll('#rows .row').length > 0, { timeout: 20000 });

	const rows = await panel.$$eval('#rows .row', (ns) =>
		ns.map((n) => ({
			i: n.dataset.i,
			kind: n.className.replace('row', '').trim(),
			rule: n.querySelector('.rule').textContent,
			hits: n.querySelector('.hits').textContent,
			cond: n.querySelector('.cond')?.textContent ?? null,
		})),
	);
	assert('the panel connects and lists findings', rows.length > 0, 'no rows rendered');
	assert(
		'the status line carries the tally',
		/\d+ error · \d+ warn · \d+ files/.test(await panel.textContent('#status')),
		`status was "${await panel.textContent('#status')}"`,
	);

	const card = rows.find((r) => r.hits === '2 on page');
	assert('a selector resolves to the elements it styles', Boolean(card), `no row hit 2 elements: ${JSON.stringify(rows)}`);

	const ghost = rows.find((r) => r.rule === 'layout/margin-on-child' && r.hits === '1 on page');
	assert('a state pseudo-class still resolves its element', Boolean(ghost), 'the :hover rule matched nothing');

	// Ordering: everything the page shows comes before everything it does not.
	const kinds = rows.map((r) => r.kind);
	const rank = { '': 0, offwidth: 1, dead: 2, nodom: 3 };
	is(
		'rows are ordered by what this page can show',
		kinds.map((k) => rank[k]),
		[...kinds.map((k) => rank[k])].sort((a, b) => a - b),
	);

	// Hover draws marks in the page, in the matcher's own shadow root.
	await panel.hover('#rows .row');
	await panel.waitForTimeout(150);
	const marked = await panel.evaluate(
		() => document.querySelector('[data-loupe-marks]')?.shadowRoot.querySelectorAll('.mark').length ?? -1,
	);
	assert('hovering a row outlines what it styles', marked > 0, `${marked} marks drawn`);

	await panel.click('#rows .row');
	await panel.waitForTimeout(150);
	assert('clicking pins the row', (await panel.$$('#rows .row.on')).length === 1, 'no pinned row');

	assert(
		'the note says how much of the report this page can account for',
		/are styling elements here/.test(await panel.textContent('#note')),
		'the note is missing',
	);

	// Filtering.
	await panel.fill('#q', 'margin-on-child');
	await panel.waitForTimeout(100);
	const filtered = await panel.$$eval('#rows .row .rule', (ns) => ns.map((n) => n.textContent));
	assert('the filter narrows to matching rules', filtered.length > 0 && filtered.every((r) => r === 'layout/margin-on-child'), JSON.stringify(filtered));

	// ── the sidebar ──────────────────────────────────────────────────────────
	const side = await browser.newPage({ viewport: { width: 420, height: 700 } });
	await open(side, 'sidebar.html', servePort);
	await side.waitForFunction(() => document.getElementById('rows').innerHTML.length > 0, { timeout: 20000 });

	// Select a card: `$0` is what DevTools would hand the expression.
	await side.evaluate(() => {
		window.$0 = document.querySelector('#__app .wf-card');
		window.__onSelect();
	});
	await side.waitForFunction(() => document.getElementById('sel').textContent.includes('wf-card'), { timeout: 8000 });
	const forCard = await side.$$eval('#rows .row .rule', (ns) => ns.map((n) => n.textContent));
	assert('the sidebar answers what is wrong with the selected element', forCard.length > 0, 'no findings for .wf-card');
	assert(
		'…and only the findings that style it',
		forCard.every((r) => r !== 'typography/in-css'),
		`a .wf-label finding leaked onto .wf-card: ${JSON.stringify(forCard)}`,
	);
	is('the pane names what is selected', await side.textContent('#sel'), 'div.wf-card');

	// A label: a different element, a different answer.
	await side.evaluate(() => {
		window.$0 = document.querySelector('#__app .wf-label');
		window.__onSelect();
	});
	await side.waitForFunction(() => document.getElementById('sel').textContent.includes('wf-label'), { timeout: 8000 });
	const forLabel = await side.$$eval('#rows .row .rule', (ns) => ns.map((n) => n.textContent));
	assert(
		'a different element gets a different answer',
		JSON.stringify(forLabel) !== JSON.stringify(forCard) && forLabel.length > 0,
		`card ${JSON.stringify(forCard)} vs label ${JSON.stringify(forLabel)}`,
	);

	// An element nothing styles says so, rather than going blank.
	await side.evaluate(() => {
		const el = document.createElement('div');
		el.className = 'wf-nothing-here';
		document.getElementById('__app').appendChild(el);
		window.$0 = el;
		window.__onSelect();
	});
	await side.waitForFunction(() => document.getElementById('sel').textContent.includes('wf-nothing-here'), { timeout: 8000 });
	assert(
		'an element with no findings says so rather than going blank',
		(await side.textContent('#rows')).includes('No finding styles this element'),
		`pane said: ${(await side.textContent('#rows')).slice(0, 120)}`,
	);

	// ── being offline is a first-class state ─────────────────────────────────
	// A port nothing is on. Taken from the OS and released, rather than picked:
	// a hardcoded one is either in use on somebody's machine or on Chrome's
	// blocked list, and both fail as something other than "nothing is listening".
	const idle = await new Promise((done) => {
		const probe = createServer();
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => done(port));
		});
	});
	const dead = await browser.newPage();
	await open(dead, 'panel.html', idle, { offline: true });
	await dead.waitForFunction(() => document.getElementById('rows').textContent.includes('No loupe server'), { timeout: 20000 });
	assert('a missing server is named, with how to start one', (await dead.textContent('#rows')).includes(`loupe serve --port ${idle}`), 'no instruction offered');
	is('…and the indicator says disconnected', await dead.getAttribute('#dot', 'class'), 'dot off');

	if (process.env.LOUPE_SHOTS) {
		await panel.fill('#q', '');
		await panel.waitForTimeout(200);
		await panel.screenshot({ path: process.env.LOUPE_SHOTS + '/dt-panel.png' });
		await side.evaluate(() => { window.$0 = document.querySelector('#__app .wf-card'); window.__onSelect(); });
		await side.waitForTimeout(400);
		await side.screenshot({ path: process.env.LOUPE_SHOTS + '/dt-sidebar.png' });
	}
	assert('no page errors anywhere', errors.length === 0, errors.join('\n     '));
} finally {
	await browser.close();
	serve.kill();
	files.close();
	rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
