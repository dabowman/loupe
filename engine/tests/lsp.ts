#!/usr/bin/env node
/**
 * The editor consumer: a real server, driven over a real pipe.
 *
 * Asserted against framed messages rather than the functions behind them. The
 * three failures covered here are silent from the inside and total from the
 * outside: a mis-framed message (split chunk, multi-byte body), a diagnostic
 * never cleared, and a quick fix that writes something other than `loupe fix`.
 *
 * Design notes: docs/design/lsp.md
 */

import { PassThrough } from 'node:stream';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../src/analyze.ts';
import { applyTokenFixes } from '../src/autofix.ts';
import { loadConfig } from '../src/config.ts';
import { lsp } from '../src/lsp.ts';
import type { AnalyzeResult, Config } from '../src/types.ts';
import { assert, check, cleanup, finish, first, scratch, writeAll } from './harness.ts';

const FILES = {
	'loupe.config.json': '{ "extends": "wpds", "namespaces": { "project": ["wf-"] } }',
	// The engine can only suggest a token it has seen defined, so the fixture
	// defines the one this suite substitutes.
	'styles/tokens.css': ':root {\n\t--wpds-color-foreground-content-neutral: #1e1e1e;\n}',
	// `.wf-note` is on a plain element, deliberately. A class bound to a
	// design-system component reports `system/override` instead — one
	// attribute-level finding supersedes the per-declaration ones there — and
	// there is no token substitution to offer for it.
	'src/App.jsx': `
export default () => <div className="wf-note">hi</div>;
`,
	// One declaration the engine can settle on its own — that is the one a quick
	// fix is offered for, and the one `loupe fix` would rewrite.
	'styles/app.css': `.wf-note {
  color: #1e1e1e;
}
`,
};

const root = scratch('loupe-lsp-');
writeAll(root, FILES);
const config: Config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
const run = (): Promise<AnalyzeResult> => analyze(config, { scope: null });

const baseline = await run();
assert(
	baseline.findings.some((f) => f.file === 'styles/app.css'),
	'the fixture produced no stylesheet findings to publish',
);

// ── a client ────────────────────────────────────────────────────────────────

interface Incoming {
	id?: number;
	method?: string;
	result?: unknown;
	params?: Record<string, unknown>;
}

const toServer = new PassThrough();
const fromServer = new PassThrough();
const received: Incoming[] = [];
const waiters: { match: (m: Incoming) => boolean; resolve: (m: Incoming) => void }[] = [];

let acc = Buffer.alloc(0);
fromServer.on('data', (chunk: Buffer) => {
	acc = Buffer.concat([acc, chunk]);
	for (;;) {
		const headEnd = acc.indexOf('\r\n\r\n');
		if (headEnd === -1) return;
		const length = Number(/content-length:\s*(\d+)/i.exec(acc.subarray(0, headEnd).toString('ascii'))?.[1]);
		const start = headEnd + 4;
		if (!Number.isFinite(length) || acc.length < start + length) return;
		const msg = JSON.parse(acc.subarray(start, start + length).toString('utf8')) as Incoming;
		acc = acc.subarray(start + length);
		received.push(msg);
		for (const w of [...waiters]) {
			if (!w.match(msg)) continue;
			waiters.splice(waiters.indexOf(w), 1);
			w.resolve(msg);
		}
	}
});

/** Wait for a message already received, or the next one that matches. */
function until(match: (m: Incoming) => boolean, what: string): Promise<Incoming> {
	const had = received.find(match);
	if (had) return Promise.resolve(had);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 15_000);
		waiters.push({
			match,
			resolve: (m) => {
				clearTimeout(timer);
				resolve(m);
			},
		});
	});
}

/** Frame and send, optionally in pieces, to exercise the reader's accumulator. */
function send(msg: Record<string, unknown>, { split = false }: { split?: boolean } = {}): void {
	const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
	const framed = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
	if (!split) {
		toServer.write(framed);
		return;
	}
	// Mid-body, and deliberately mid-character where the body has a multi-byte
	// one: a reader that decoded before counting loses exactly this message.
	const at = Math.floor(framed.length / 2);
	toServer.write(framed.subarray(0, at));
	setTimeout(() => toServer.write(framed.subarray(at)), 5);
}

const appCss = join(root, 'styles', 'app.css');
const cssUri = `file://${appCss}`;

lsp({ config, run, input: toServer, output: fromServer });

// ── the session ─────────────────────────────────────────────────────────────

send({ id: 1, method: 'initialize', params: { rootUri: `file://${root}` } });
const init = await until((m) => m.id === 1, 'the initialize reply');

await check('initialize advertises what the client has to know to use any of it', () => {
	const caps = (init.result as { capabilities?: Record<string, unknown> } | undefined)?.capabilities;
	assert(caps, 'initialize replied without capabilities');
	assert(caps.hoverProvider === true, 'hover was not advertised');
	assert(caps.codeActionProvider !== undefined, 'code actions were not advertised');
	// Without this the client never sends didSave, and the server never runs
	// again after the first analysis — which looks exactly like a clean repo.
	const sync = caps.textDocumentSync as { save?: unknown } | undefined;
	assert(sync && typeof sync.save === 'object', 'didSave was not requested');
});

send({ method: 'initialized', params: {} });
const published = await until(
	(m) => m.method === 'textDocument/publishDiagnostics' && (m.params?.['uri'] as string) === cssUri,
	'the first publish for the stylesheet',
);

await check('a finding arrives as a diagnostic on its own line, with its rule as the code', () => {
	const diags = published.params?.['diagnostics'] as Record<string, unknown>[];
	assert(diags.length > 0, 'the stylesheet published an empty diagnostic list');
	const d = first(
		diags.filter((x) => x['code'] === 'tokens/hardcoded-value'),
		'no hardcoded-value diagnostic',
	);
	const range = d['range'] as { start: { line: number; character: number }; end: { line: number; character: number } };
	// `color: #1e1e1e` is on source line 2, which is 1 zero-based.
	assert(range.start.line === 1, `diagnostic landed on line ${range.start.line}, expected 1`);
	assert(d['source'] === 'loupe', `source was ${String(d['source'])}`);
	// Narrowed to the declaration rather than spanning the whole line: the line
	// is indented, so a whole-line range would start at character 0.
	assert(range.start.character > 0, 'the range was not narrowed to the declaration');
	assert(range.end.character > range.start.character, 'the range is empty');
});

await check('the range is valid against the line it points into', () => {
	const diags = published.params?.['diagnostics'] as Record<string, unknown>[];
	const lines = readFileSync(appCss, 'utf8').split('\n');
	for (const d of diags) {
		const r = d['range'] as { start: { line: number; character: number }; end: { line: number; character: number } };
		const text = lines[r.start.line] ?? '';
		// A range past the end of its line is rejected by the client, and a
		// rejected range takes its diagnostic with it — silently.
		assert(r.end.character <= text.length, `range ends at ${r.end.character}, line is ${text.length} long`);
	}
});

// ── code actions ────────────────────────────────────────────────────────────

send({ method: 'textDocument/didOpen', params: { textDocument: { uri: cssUri, text: readFileSync(appCss, 'utf8') } } });
send(
	{
		id: 2,
		method: 'textDocument/codeAction',
		params: {
			textDocument: { uri: cssUri },
			range: { start: { line: 1, character: 0 }, end: { line: 1, character: 20 } },
			context: { diagnostics: [] },
		},
	},
	{ split: true },
);
const actions = await until((m) => m.id === 2, 'the code action reply');

await check('a message split across chunks is still read', () => {
	// The request above was written in two writes. If the reader mis-framed it,
	// nothing would ever reply and `until` would have thrown by now.
	assert(Array.isArray(actions.result), 'the split request produced no reply');
});

await check('the quick fix writes exactly what `loupe fix` writes', () => {
	const list = actions.result as { title: string; edit: { changes: Record<string, { newText: string }[]> } }[];
	const fix = first(
		list.filter((a) => a.title.startsWith('Replace')),
		'no replace action was offered',
	);
	const edit = first(fix.edit.changes[cssUri] ?? [], 'the action carried no edit for this file');

	// The same declaration, put through the CLI's own path on a copy.
	const before = readFileSync(appCss, 'utf8');
	applyTokenFixes(root, baseline.findings);
	const viaCli = readFileSync(appCss, 'utf8').split('\n')[1];
	writeFileSync(appCss, before);

	assert(
		edit.newText === viaCli,
		`the editor would write ${JSON.stringify(edit.newText)}, the CLI writes ${JSON.stringify(viaCli)}`,
	);
});

await check('the suppress action leaves the reason for a person to write', () => {
	const list = actions.result as { title: string; edit: { changes: Record<string, { newText: string }[]> } }[];
	const supp = first(
		list.filter((a) => a.title.startsWith('Suppress')),
		'no suppress action was offered',
	);
	const text = (supp.edit.changes[cssUri] ?? [])[0]?.newText ?? '';
	assert(text.includes(config.suppression.keyword), 'the directive did not use the active keyword');
	// The directive must end at the separator. A reason written for you is a
	// signed-off silence nobody signed off on — and without one the engine
	// reports `suppression/malformed` rather than going quiet, which is the
	// whole point of offering it this way.
	assert(/--\s*\*\/\s*$/.test(text.trim()), `the suppress action pre-filled a reason: ${JSON.stringify(text)}`);
});

// ── hover ───────────────────────────────────────────────────────────────────

send({
	id: 3,
	method: 'textDocument/hover',
	params: { textDocument: { uri: cssUri }, position: { line: 1, character: 5 } },
});
const hover = await until((m) => m.id === 3, 'the hover reply');

await check("hover carries the rule's guidance, which is what the diagnostic has no room for", () => {
	const value = (hover.result as { contents: { value: string } } | null)?.contents.value ?? '';
	assert(value.includes('tokens/hardcoded-value'), `hover named no rule: ${value}`);
	assert(value.length > 'tokens/hardcoded-value'.length + 10, 'hover carried the rule id and nothing else');
});

await check('hover on a line with no finding answers null rather than nothing', () => {
	// A request left unanswered is a client waiting forever, which in an editor
	// is a hover that never dismisses.
	send({
		id: 4,
		method: 'textDocument/hover',
		params: { textDocument: { uri: cssUri }, position: { line: 0, character: 0 } },
	});
});
const empty = await until((m) => m.id === 4, 'the empty hover reply');
await check('…and that answer is null', () => {
	assert(empty.result === null, `expected null, got ${JSON.stringify(empty.result)}`);
});

// ── clearing ────────────────────────────────────────────────────────────────

await check('a fixed file has its diagnostics cleared, not merely omitted', async () => {
	writeFileSync(appCss, '.wf-note {\n  color: var(--wpds-color-foreground-content-neutral);\n}\n');
	send({ method: 'textDocument/didSave', params: { textDocument: { uri: cssUri } } });
	const cleared = await until(
		(m) =>
			m.method === 'textDocument/publishDiagnostics' &&
			(m.params?.['uri'] as string) === cssUri &&
			((m.params?.['diagnostics'] as unknown[]) ?? []).every(
				(d) => (d as { code: string }).code !== 'tokens/hardcoded-value',
			),
		'the publish that clears the fixed finding',
	);
	const diags = (cleared.params?.['diagnostics'] as unknown[]) ?? [];
	assert(
		!diags.some((d) => (d as { code: string }).code === 'tokens/hardcoded-value'),
		'the fixed finding was still published',
	);
});

// ── framing ─────────────────────────────────────────────────────────────────

await check('a multi-byte character is framed by bytes, not characters', async () => {
	// The reason is a string whose UTF-8 length differs from its JS length. A
	// reader that counted characters would leave the tail of this message in the
	// buffer and read the *next* header out of the middle of it.
	writeFileSync(join(root, 'styles', 'app.css'), '.wf-café {\n  color: #1e1e1e;\n}\n');
	send({ method: 'textDocument/didSave', params: { textDocument: { uri: cssUri, note: 'héllo — wörld ✓' } } });
	send({
		id: 9,
		method: 'textDocument/hover',
		params: { textDocument: { uri: cssUri }, position: { line: 1, character: 5 } },
	});
	const after = await until((m) => m.id === 9, 'a reply after a multi-byte message');
	assert(after.id === 9, 'the message after a multi-byte body was mis-framed');
});

send({ id: 10, method: 'shutdown', params: {} });
await until((m) => m.id === 10, 'the shutdown reply');
send({ method: 'exit', params: {} });

cleanup(root);
finish('lsp');
