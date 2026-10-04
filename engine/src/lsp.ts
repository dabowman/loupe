/**
 * `loupe lsp` — the findings, in the editor.
 *
 * A language server over stdio, speaking JSON-RPC. What it holds:
 *
 *   diagnostics  published repo-wide, not per open file, and re-analyzed whole
 *                on save. A URI that had findings and no longer does gets an
 *                explicit empty publish, or the client keeps its last set.
 *   hover        the rule's guidance, which a diagnostic message has no room for
 *   code action  the token substitution `loupe fix` would write, from the same
 *                function; a suppression directive with the reason blank; and
 *                the deletion of a dead rule, which `loupe fix` will not do
 *
 * Open documents' text is tracked so a range is always valid against what the
 * editor holds. The findings behind those ranges come from the last save, so a
 * dirty buffer shows the previous verdict.
 *
 * stdout carries framed messages and nothing else — `cli.ts` runs this command
 * before any path that could print. Notices go to `log`, which is stderr.
 *
 * ponytail: whole re-analysis per save (~115ms on an ordinary project, ~2.4s on
 * Gutenberg). If that has to feel instant, split `analyze` into index and check
 * phases and keep the index warm — nothing here changes, `run` just gets faster.
 *
 * Design notes: docs/design/lsp.md
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { substituteOnLine, tokenFixes } from './autofix.ts';
import { renderTitle } from './rules.ts';
import { toPosix } from './discover.ts';
import { escapeRe, messageOf } from './text.ts';
import type { AnalyzeResult, BaselinedResult, Config, DeadRule, Finding, Severity } from './types.ts';

/** LSP severities. `off` never reaches a finding; it maps to Warning so none is ever dropped. */
const SEVERITY: Record<Severity, number> = { error: 1, warn: 2, off: 2 };

/** Protocol positions are zero-based; every line in the engine is one-based. */
interface Position {
	line: number;
	character: number;
}
interface Range {
	start: Position;
	end: Position;
}
interface TextEdit {
	range: Range;
	newText: string;
}

interface Diagnostic {
	range: Range;
	severity: number;
	code: string;
	source: string;
	message: string;
}

/** Only the members this server reads. The protocol has many more. */
interface Message {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
}

/** Walk into a decoded message, yielding `undefined` at any missing step. */
const field = (v: unknown, ...keys: readonly string[]): unknown =>
	keys.reduce<unknown>(
		(at, key) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined),
		v,
	);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * Split a stdio stream into JSON-RPC messages.
 *
 * `Content-Length` counts bytes, not characters, so the buffer is sliced before
 * it is decoded. See docs/design/lsp.md#framing.
 */
function createReader(onMessage: (msg: Message) => void): (chunk: Buffer) => void {
	let buf = Buffer.alloc(0);
	return (chunk: Buffer): void => {
		buf = Buffer.concat([buf, chunk]);
		for (;;) {
			const headEnd = buf.indexOf('\r\n\r\n');
			if (headEnd === -1) return;
			const header = buf.subarray(0, headEnd).toString('ascii');
			const match = /content-length:\s*(\d+)/i.exec(header);
			if (!match?.[1]) {
				// No length means no way to find where this message ends. Drop the
				// header and resynchronize rather than spin on it.
				buf = buf.subarray(headEnd + 4);
				continue;
			}
			const length = Number(match[1]);
			const start = headEnd + 4;
			if (buf.length < start + length) return;
			const body = buf.subarray(start, start + length).toString('utf8');
			buf = buf.subarray(start + length);
			try {
				onMessage(JSON.parse(body) as Message);
			} catch {
				// Nothing to reply to: the id was in the body that would not parse.
			}
		}
	};
}

/**
 * Where a finding's squiggle goes: the whole line, narrowed to the flagged
 * declaration where the finding carries one.
 *
 * The end is clamped to the line's length — a range past it is rejected by the
 * client, and a rejected range takes its diagnostic with it.
 */
function rangeFor(finding: Finding, lineText: string | undefined): Range {
	const line = Math.max(0, finding.line - 1);
	const text = lineText ?? '';
	const whole: Range = { start: { line, character: 0 }, end: { line, character: text.length } };
	if (!text) return whole;
	// The declaration reported *at* this line; a collapsed finding's others sit
	// on their own lines.
	const decl = (finding.suggest ?? []).find((s) => (s.line ?? finding.line) === finding.line) ?? finding.decl;
	if (!decl) return whole;
	const at = text.toLowerCase().indexOf(decl.prop.toLowerCase());
	if (at === -1) return whole;
	// Through the value, so the squiggle covers `padding: 13px`, not `padding`.
	const valueAt = text.toLowerCase().indexOf(decl.value.trim().toLowerCase(), at);
	const end = valueAt === -1 ? text.length : valueAt + decl.value.trim().length;
	return { start: { line, character: at }, end: { line, character: Math.min(end, text.length) } };
}

/**
 * The edit that removes a dead rule, or `null` where the buffer no longer holds
 * what was reported there.
 *
 * A deletion cannot check itself the way a substitution's match does, so the
 * recorded lines have to still look like the rule they were recorded for:
 * braces that balance, a closing one last, and the class named somewhere
 * inside. One blank line goes with the rule — the one after it, or where the
 * rule ends the file, the one before — so what is left is the gap that was
 * already there and not two.
 */
function deleteRule(lines: readonly string[], dead: DeadRule, cls: string): TextEdit | null {
	let first = dead.startLine - 1;
	let last = dead.endLine - 1;
	if (first < 0 || last < first || last >= lines.length) return null;
	const slice = lines.slice(first, last + 1).join('\n');
	const opens = (slice.match(/{/g) ?? []).length;
	if (!opens || opens !== (slice.match(/}/g) ?? []).length) return null;
	if (!/}[^\S\n]*$/.test(slice)) return null;
	if (!new RegExp(`${escapeRe(cls)}(?![-\\w])`).test(slice)) return null;
	// Nothing but the file's own ending after it.
	const atEnd = last + 2 >= lines.length;
	if (!atEnd && (lines[last + 1] ?? '').trim() === '') last++;
	else if (atEnd && first > 0 && (lines[first - 1] ?? '').trim() === '') first--;
	if (last + 1 < lines.length)
		return { range: { start: { line: first, character: 0 }, end: { line: last + 1, character: 0 } }, newText: '' };
	// A file with no trailing newline: the line ending *before* the rule goes
	// instead, so the file does not end on the blank line this would leave.
	const prev = first > 0 ? (lines[first - 1] ?? '').length : 0;
	return {
		range: {
			start: { line: first > 0 ? first - 1 : 0, character: prev },
			end: { line: last, character: (lines[last] ?? '').length },
		},
		newText: '',
	};
}

/** The comment a suppression directive has to be written in, per file type. */
const commentFor = (file: string, body: string): string =>
	/\.(css|scss|sass|less|pcss|postcss)$/i.test(file) ? `/* ${body} */` : `// ${body}`;

export interface LspHandle {
	/** Resolves when the peer has asked to exit. */
	closed: Promise<void>;
}

/**
 * Run the server over a pair of streams.
 *
 * Streams are arguments rather than `process.stdin`/`process.stdout` so a test
 * can drive a real server over a real pipe.
 */
export function lsp(opts: {
	config: Config;
	run: () => Promise<AnalyzeResult | BaselinedResult>;
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
	/** Where notices go. Never `output`: anything but a framed message there desynchronizes the peer. */
	log?: (line: string) => void;
}): LspHandle {
	const { config, run, input, output, log = (): void => {} } = opts;
	const root = config.root;

	/** Open buffers, by URI. Their text is what a range must be valid against. */
	const open = new Map<string, string>();
	/** The last analysis, by repo-relative path. Code actions and hovers read it. */
	let findings = new Map<string, Finding[]>();
	/** Every URI we have published a non-empty list to, so it can be cleared. */
	let published = new Set<string>();

	const uriOf = (rel: string): string => pathToFileURL(join(root, rel)).href;
	const relOf = (uri: string): string | null => {
		let abs: string;
		try {
			abs = fileURLToPath(uri);
		} catch {
			return null;
		}
		const rel = toPosix(abs.startsWith(root) ? abs.slice(root.length).replace(/^[/\\]/, '') : abs);
		return rel.startsWith('..') ? null : rel;
	};

	const send = (msg: Record<string, unknown>): void => {
		const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
		output.write(`Content-Length: ${body.length}\r\n\r\n`);
		output.write(body);
	};
	const reply = (id: number | string, result: unknown): void => send({ id, result });
	const notify = (method: string, params: unknown): void => send({ method, params });

	/**
	 * A file's text: the open buffer if there is one, else what is on disk.
	 *
	 * Per-run cache, because a publish asks for the same file once per finding
	 * and a stylesheet with forty findings would otherwise be read forty times.
	 */
	const makeLines = (): ((rel: string) => string[]) => {
		const cache = new Map<string, string[]>();
		return (rel: string): string[] => {
			const hit = cache.get(rel);
			if (hit) return hit;
			const buffer = open.get(uriOf(rel));
			let text = buffer;
			if (text === undefined) {
				try {
					text = readFileSync(join(root, rel), 'utf8');
				} catch {
					text = '';
				}
			}
			const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
			cache.set(rel, lines);
			return lines;
		};
	};

	async function publish(): Promise<void> {
		let result: AnalyzeResult | BaselinedResult;
		try {
			result = await run();
		} catch (err) {
			// The last good set stands: a cleared panel is indistinguishable from a
			// clean workspace, which is the one thing a failure must not look like.
			log(`analysis failed: ${messageOf(err)}`);
			return;
		}
		const next = new Map<string, Finding[]>();
		for (const f of result.findings) next.set(f.file, [...(next.get(f.file) ?? []), f]);
		findings = next;

		const lines = makeLines();
		const now = new Set<string>();
		for (const [rel, group] of next) {
			const uri = uriOf(rel);
			now.add(uri);
			const text = lines(rel);
			notify('textDocument/publishDiagnostics', {
				uri,
				diagnostics: group.map(
					(f): Diagnostic => ({
						range: rangeFor(f, text[f.line - 1]),
						severity: SEVERITY[f.severity],
						code: f.rule,
						source: 'loupe',
						// `note` is the registry's own words on why this is flagged.
						message: f.note ? `${f.message}\n\n${f.note}` : f.message,
					}),
				),
			});
		}
		// A file that no longer has findings needs an explicit empty list, or the
		// client keeps the last set it was sent.
		for (const uri of published) if (!now.has(uri)) notify('textDocument/publishDiagnostics', { uri, diagnostics: [] });
		published = now;
	}

	/**
	 * Coalesce saves into runs: the timer folds a burst into one analysis, and
	 * `queued` keeps a save that arrived mid-run from being dropped.
	 */
	let timer: NodeJS.Timeout | null = null;
	let running = false;
	let queued = false;
	const drain = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			while (queued) {
				queued = false;
				await publish();
			}
		} finally {
			running = false;
		}
	};
	const schedule = (delay = 120): void => {
		queued = true;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void drain();
		}, delay);
	};

	/** The findings on a line, for the two requests that ask about a position. */
	const at = (uri: string, line: number): Finding[] => {
		const rel = relOf(uri);
		return rel ? (findings.get(rel) ?? []).filter((f) => f.line - 1 === line) : [];
	};

	function codeActions(uri: string, range: Range): unknown[] {
		const rel = relOf(uri);
		if (!rel) return [];
		const lines = makeLines();
		const actions: unknown[] = [];
		const seen = new Set<string>();
		for (let line = range.start.line; line <= range.end.line; line++) {
			for (const finding of at(uri, line)) {
				const text = lines(rel)[line] ?? '';
				// The same list `loupe fix` acts on, through the same function.
				for (const fix of tokenFixes([finding])) {
					if (fix.prop === undefined || fix.line - 1 !== line) continue;
					const rewritten = substituteOnLine(text, fix);
					if (typeof rewritten !== 'string') continue;
					const key = `${line}\u0000${fix.prop}\u0000${fix.to}`;
					if (seen.has(key)) continue;
					seen.add(key);
					actions.push({
						title: `Replace ${fix.prop}: ${fix.value} with ${fix.to}`,
						kind: 'quickfix',
						isPreferred: true,
						edit: {
							changes: {
								[uri]: [
									{
										range: { start: { line, character: 0 }, end: { line, character: text.length } },
										newText: rewritten,
									} satisfies TextEdit,
								],
							},
						},
					});
				}
				// A misspelled token is one finding across every line the file names it
				// on, so its action carries every one of those edits. An editor fix
				// clearing only the occurrence under the cursor would leave the file
				// broken and the diagnostic standing — the same reason `loupe fix`
				// rewrites them all. Same bytes, same function.
				const rename = finding.rename;
				if (rename && !seen.has(`rename\u0000${rename.from}`)) {
					seen.add(`rename\u0000${rename.from}`);
					const edits: TextEdit[] = [];
					for (const fix of tokenFixes([finding])) {
						const on = lines(rel)[fix.line - 1];
						if (on === undefined) continue;
						const rewritten = substituteOnLine(on, fix);
						if (typeof rewritten !== 'string') continue;
						edits.push({
							range: { start: { line: fix.line - 1, character: 0 }, end: { line: fix.line - 1, character: on.length } },
							newText: rewritten,
						});
					}
					if (edits.length)
						actions.push({
							title: `Rename ${rename.from} to ${rename.to} (${edits.length} occurrence(s))`,
							kind: 'quickfix',
							isPreferred: true,
							edit: { changes: { [uri]: edits } },
						});
				}
				// Deleting a dead rule is offered here and never by `loupe fix`: a
				// deletion leaves nothing to compare against afterwards, so it is
				// offered only where a person is looking at the code and accepts it.
				// See docs/design/report.md#deleting-is-the-editors-alone.
				const dead = finding.dead;
				if (dead && !seen.has(`dead\u0000${line}`)) {
					const edit = deleteRule(lines(rel), dead, finding.code ?? finding.message);
					if (edit) {
						seen.add(`dead\u0000${line}`);
						actions.push({
							title: `Delete the dead rule ${finding.message}`,
							kind: 'quickfix',
							edit: { changes: { [uri]: [edit] } },
						});
					}
				}
				// The reason is left empty on purpose: a directive without one does not
				// mute, it reports as `suppression/malformed`. See
				// docs/design/lsp.md#why-the-suppress-quick-fix-leaves-the-reason-blank.
				const indent = /^[ \t]*/.exec(lines(rel)[line] ?? '')?.[0] ?? '';
				const key = `suppress\u0000${line}\u0000${finding.rule}`;
				if (seen.has(key)) continue;
				seen.add(key);
				actions.push({
					title: `Suppress ${finding.rule} here (you write the reason)`,
					kind: 'quickfix',
					edit: {
						changes: {
							[uri]: [
								{
									range: { start: { line, character: 0 }, end: { line, character: 0 } },
									newText: `${indent}${commentFor(rel, `${config.suppression.keyword} ${finding.rule} -- `)}\n`,
								} satisfies TextEdit,
							],
						},
					},
				});
			}
		}
		return actions;
	}

	let resolveClosed: () => void = () => {};
	const closed = new Promise<void>((res) => {
		resolveClosed = res;
	});

	const read = createReader((msg) => {
		const { id, method, params = {} } = msg;
		const uri = str(field(params, 'textDocument', 'uri'));

		switch (method) {
			case 'initialize':
				reply(id ?? 0, {
					capabilities: {
						// Full sync: keeps a range valid against a dirty buffer, so no
						// diagnostic is dropped for pointing past a shortened line.
						textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
						codeActionProvider: { codeActionKinds: ['quickfix'] },
						hoverProvider: true,
					},
					serverInfo: { name: 'loupe', version: '1' },
				});
				return;
			case 'initialized':
				schedule(0);
				return;
			case 'shutdown':
				reply(id ?? 0, null);
				return;
			case 'exit':
				resolveClosed();
				return;
			case 'textDocument/didOpen': {
				const text = field(params, 'textDocument', 'text');
				if (typeof text === 'string') open.set(uri, text);
				return;
			}
			case 'textDocument/didChange': {
				// Full sync, so the last change is the whole document.
				const changes = field(params, 'contentChanges');
				const last = Array.isArray(changes) ? field(changes[changes.length - 1], 'text') : undefined;
				if (typeof last === 'string') open.set(uri, last);
				return;
			}
			case 'textDocument/didClose':
				open.delete(uri);
				return;
			case 'textDocument/didSave':
				schedule();
				return;
			case 'textDocument/codeAction': {
				reply(
					id ?? 0,
					codeActions(uri, {
						start: {
							line: num(field(params, 'range', 'start', 'line')),
							character: num(field(params, 'range', 'start', 'character')),
						},
						end: {
							line: num(field(params, 'range', 'end', 'line')),
							character: num(field(params, 'range', 'end', 'character')),
						},
					}),
				);
				return;
			}
			case 'textDocument/hover': {
				const line = num(field(params, 'position', 'line'));
				const here = at(uri, line);
				if (here.length === 0) {
					reply(id ?? 0, null);
					return;
				}
				// The rule's guidance — printed once per group in the terminal report,
				// and with no room for it on a per-finding diagnostic.
				const value = [...new Set(here.map((f) => f.rule))]
					.map((rule) => `**${rule}**\n\n${renderTitle(rule, config.designSystem, config.suppression.keyword)}`)
					.join('\n\n---\n\n');
				reply(id ?? 0, { contents: { kind: 'markdown', value } });
				return;
			}
			default:
				// An unimplemented request still needs an answer or the client waits
				// forever; a notification (no id) needs none.
				if (id !== undefined) reply(id, null);
		}
	});

	input.on('data', (chunk: Buffer | string) => read(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
	input.on('end', () => resolveClosed());
	return { closed };
}
