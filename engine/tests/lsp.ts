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
import { syntaxFor } from '../src/syntax.ts';
import type { AnalyzeResult, Config } from '../src/types.ts';
import { assert, check, cleanup, finish, first, scratch, writeAll } from './harness.ts';

const FILES = {
	'loupe.config.json': '{ "extends": "wpds", "namespaces": { "project": ["wf-"] } }',
	// The engine can only suggest a token it has seen defined, so the fixture
	// defines the one this suite substitutes. Where the preset reads the design
	// system's own: a project's sheet is not a set to call a token unknown against.
	'node_modules/@wordpress/theme/prebuilt/css/design-tokens.css':
		':root {\n\t--wpds-color-foreground-content-neutral: #1e1e1e;\n}',
	// `.wf-note` is on a plain element, deliberately. A class bound to a
	// design-system component reports `system/override` instead — one
	// attribute-level finding supersedes the per-declaration ones there — and
	// there is no token substitution to offer for it.
	// The inline style is the second channel a quick fix has to write: the
	// declaration it is reported as appears nowhere in this file, so the fix is
	// a splice at the literal rather than a match on the line.
	'src/App.jsx': `
export default () => (
	<div className="wf-note" style={{ color: '#1e1e1e' }}>hi</div>
);
`,
	// One declaration the engine can settle on its own — that is the one a quick
	// fix is offered for, and the one `loupe fix` would rewrite. `.wf-hint`
	// misspells the same token twice: one finding, and an action that has to
	// carry an edit for each line, because clearing one would leave the
	// diagnostic standing.
	'styles/app.css': `.wf-note {
  color: #1e1e1e;
}
.wf-hint {
  border-color: var(--wpds-color-foreground-content-neutra);
  outline-color: var(--wpds-color-foreground-content-neutra);
}
`,
	// The deletion the editor offers and `loupe fix` refuses. `.wf-gone` is the
	// case that can be deleted: its own rule, alone on its lines, with a comment
	// glued above it. `.wf-partly` shares a selector list with a class that is
	// live, and `.wf-alone` is the only thing inside its `@media` — deleting
	// either one would take something with it, so neither is offered.
	'styles/dead.css': `/* the panel nobody renders any more */
.wf-gone {
  color: red;
}

.wf-partly, .wf-shown {
  color: blue;
}

@media (min-width: 40em) {
  .wf-alone { color: teal; }
}
`,
	// A nested rule with a sibling: deleting it leaves its parent standing.
	'styles/dead.scss': `.wf-panel {
  color: red;
  .wf-inner { color: blue; }
}
`,
	// What keeps `.wf-shown` and `.wf-panel` out of the dead set.
	'src/Shown.jsx': 'export const Shown = () => <section className="wf-panel wf-shown" />;\n',
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
const deadCss = join(root, 'styles', 'dead.css');
const deadUri = `file://${deadCss}`;
const deadScss = join(root, 'styles', 'dead.scss');
const scssUri = `file://${deadScss}`;
const appJsx = join(root, 'src', 'App.jsx');
const jsxUri = `file://${appJsx}`;

/**
 * The line `loupe fix` would write, without leaving it written. Both files are
 * restored: one `applyTokenFixes` run settles every channel at once, and a file
 * left rewritten would take the rest of the session's findings with it.
 */
function viaCli(path: string, line: number): string {
	const before = [appCss, appJsx].map((p) => [p, readFileSync(p, 'utf8')] as const);
	applyTokenFixes(root, baseline.findings);
	const out = readFileSync(path, 'utf8').split('\n')[line] ?? '';
	for (const [p, text] of before) writeFileSync(p, text);
	return out;
}

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
	const cli = viaCli(appCss, 1);
	assert(
		edit.newText === cli,
		`the editor would write ${JSON.stringify(edit.newText)}, the CLI writes ${JSON.stringify(cli)}`,
	);
});

send({
	id: 6,
	method: 'textDocument/codeAction',
	params: {
		textDocument: { uri: cssUri },
		range: { start: { line: 4, character: 0 }, end: { line: 4, character: 60 } },
		context: { diagnostics: [] },
	},
});
const renameActions = await until((m) => m.id === 6, 'the rename code action reply');

await check('the rename quick fix carries every line, and writes what `loupe fix` writes', () => {
	const list = renameActions.result as { title: string; edit: { changes: Record<string, { newText: string }[]> } }[];
	const fix = first(
		list.filter((a) => a.title.startsWith('Rename')),
		'no rename action was offered',
	);
	const edits = fix.edit.changes[cssUri] ?? [];
	assert(edits.length === 2, `the action carried ${edits.length} edit(s), expected one per line`);
	for (const [i, edit] of edits.entries()) {
		const cli = viaCli(appCss, 4 + i);
		assert(
			edit.newText === cli,
			`the editor would write ${JSON.stringify(edit.newText)}, the CLI writes ${JSON.stringify(cli)}`,
		);
		assert(edit.newText.includes('var(--wpds-color-foreground-content-neutral)'), edit.newText);
	}
});

send({ method: 'textDocument/didOpen', params: { textDocument: { uri: jsxUri, text: readFileSync(appJsx, 'utf8') } } });
send({
	id: 5,
	method: 'textDocument/codeAction',
	params: {
		textDocument: { uri: jsxUri },
		range: { start: { line: 2, character: 0 }, end: { line: 2, character: 60 } },
		context: { diagnostics: [] },
	},
});
const jsxActions = await until((m) => m.id === 5, 'the JSX code action reply');

await check('the quick fix splices a JSX style object exactly as `loupe fix` does', () => {
	const list = jsxActions.result as { title: string; edit: { changes: Record<string, { newText: string }[]> } }[];
	const fix = first(
		list.filter((a) => a.title.startsWith('Replace')),
		'no replace action was offered for the inline style',
	);
	const edit = first(fix.edit.changes[jsxUri] ?? [], 'the action carried no edit for this file');
	const cli = viaCli(appJsx, 2);
	assert(
		edit.newText === cli,
		`the editor would write ${JSON.stringify(edit.newText)}, the CLI writes ${JSON.stringify(cli)}`,
	);
	assert(edit.newText.includes("color: 'var(--wpds-color-foreground-content-neutral)'"), edit.newText);
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

// ── deleting a dead rule ────────────────────────────────────────────────────
// The one action the editor offers and `loupe fix` will not: a deletion has
// nothing to compare against afterwards, so it is offered only where a person
// is looking at the code. See docs/design/report.md#deleting-is-the-editors-alone.

interface Position {
	line: number;
	character: number;
}
interface Action {
	title: string;
	edit?: { changes: Record<string, { range: { start: Position; end: Position }; newText: string }[]> };
}

let nextId = 20;
async function actionsAt(uri: string, line: number): Promise<Action[]> {
	const id = nextId++;
	send({
		id,
		method: 'textDocument/codeAction',
		params: {
			textDocument: { uri },
			range: { start: { line, character: 0 }, end: { line, character: 0 } },
			context: { diagnostics: [] },
		},
	});
	return ((await until((m) => m.id === id, `the code actions on line ${line}`)).result ?? []) as Action[];
}

/** What the buffer holds once the client has applied one edit. */
function applyEdit(text: string, edit: { range: { start: Position; end: Position }; newText: string }): string {
	const lines = text.split('\n');
	const { start, end } = edit.range;
	const head = (lines[start.line] ?? '').slice(0, start.character);
	const tail = (lines[end.line] ?? '').slice(end.character);
	return [...lines.slice(0, start.line), head + edit.newText + tail, ...lines.slice(end.line + 1)].join('\n');
}

/** The one edit of the one delete action, having checked the range is usable. */
function deletion(
	list: Action[],
	text: string,
	what: string,
): { range: { start: Position; end: Position }; newText: string } {
	const action = first(
		list.filter((a) => a.title.startsWith('Delete')),
		`no delete action was offered for ${what}`,
	);
	const edits = Object.values(action.edit?.changes ?? {}).flat();
	assert(edits.length === 1, `the delete action carried ${edits.length} edits`);
	const edit = first(edits, 'the delete action carried no edit');
	// An invalid range is rejected by the client, and a rejected edit is a quick
	// fix that silently does nothing.
	const lines = text.split('\n');
	for (const p of [edit.range.start, edit.range.end]) {
		assert(p.line < lines.length, `the range names line ${p.line} of a ${lines.length}-line document`);
		assert(p.character <= (lines[p.line] ?? '').length, `the range ends past the end of line ${p.line}`);
	}
	return edit;
}

/** A finding is standing here, whatever action was or was not offered for it. */
function reported(list: Action[], where: string): void {
	assert(
		list.some((a) => a.title.startsWith('Suppress css/dead-class')),
		`no css/dead-class finding was reported ${where} — the case is not being covered`,
	);
}

const deadText = readFileSync(deadCss, 'utf8');
send({ method: 'textDocument/didOpen', params: { textDocument: { uri: deadUri, text: deadText } } });
send({
	method: 'textDocument/didOpen',
	params: { textDocument: { uri: scssUri, text: readFileSync(deadScss, 'utf8') } },
});

await check('a dead rule is deleted whole, with the comment above it and the blank line after', async () => {
	const list = await actionsAt(deadUri, 1);
	reported(list, 'for `.wf-gone`');
	const edit = deletion(list, deadText, '`.wf-gone`');
	const after = applyEdit(deadText, edit);
	assert(!after.includes('.wf-gone'), `the rule survived:\n${after}`);
	assert(!after.includes('nobody renders'), `the comment describing it was left dangling:\n${after}`);
	// The rule that followed it keeps the blank line it had, rather than two.
	assert(after.startsWith('.wf-partly'), `the deletion left a ragged hole:\n${JSON.stringify(after)}`);
	assert(after.includes('color: blue'), `the next rule was eaten:\n${after}`);
	// A stylesheet that parsed before parses after.
	const syntax = await syntaxFor('styles/dead.css');
	assert(syntax.parse, 'no parser for a .css file');
	syntax.parse(after, { from: deadCss });
});

await check('a selector list that also styles a live class is not deleted', async () => {
	const list = await actionsAt(deadUri, 5);
	reported(list, 'for `.wf-partly`');
	assert(
		!list.some((a) => a.title.startsWith('Delete')),
		'`.wf-partly, .wf-shown` was offered a deletion, which would take `.wf-shown` with it',
	);
});

await check("an at-rule's only child is not deleted, because the empty block would stay", async () => {
	const list = await actionsAt(deadUri, 10);
	reported(list, 'for `.wf-alone`');
	assert(!list.some((a) => a.title.startsWith('Delete')), 'the only rule inside an `@media` was offered a deletion');
});

await check('a nested rule is deleted without disturbing the rule it sits in', async () => {
	const text = readFileSync(deadScss, 'utf8');
	const list = await actionsAt(scssUri, 2);
	reported(list, 'for `.wf-inner`');
	const after = applyEdit(text, deletion(list, text, '`.wf-inner`'));
	assert(!after.includes('.wf-inner'), `the nested rule survived:\n${after}`);
	assert(after.includes('.wf-panel') && after.includes('color: red'), `the parent went with it:\n${after}`);
	const syntax = await syntaxFor('styles/dead.scss');
	assert(syntax.parse, 'postcss-scss is not installed, so this case went unchecked');
	syntax.parse(after, { from: deadScss });
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
